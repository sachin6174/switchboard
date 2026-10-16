#!/usr/bin/env python3
"""aiswitch - multiple accounts for codex / claude / agy CLIs, with auto-rotation on usage limits.

  aiswitch                         open the menu (add/login accounts, switch, turn auto-switch on)
  aiswitch add  <tool> <name>      clear current login, launch tool to log in, save it as <name>
  aiswitch save <tool> <name>      save the currently logged-in account as <name>
  aiswitch use  <tool> <name>      switch to <name>
  aiswitch next <tool>             switch to the next account that is not cooling down
  aiswitch list [tool]             show accounts, active one, and cooldowns
  aiswitch reset <tool> [name]     clear the "limit hit" mark (all accounts if no name)
  aiswitch remove <tool> <name>    delete a saved account
  aiswitch usage [tool] [--days N] [--fresh]
                                   usage of every account: limits left + tokens per model
  aiswitch json <command>          machine interface used by the Switchboard app
  aiswitch run  <tool> [args...]   run the tool; on a usage-limit message, switch account and resume

Tools: codex, claude, agy. Data lives in ~/.aiswitch (override with AISWITCH_HOME).
Per-tool overrides (patterns, cooldown_hours, resume_args, ...) go in ~/.aiswitch/config.json.
"""
import copy
import json
import os
import re
import select
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

IS_WINDOWS = os.name == "nt"
if not IS_WINDOWS:
    import fcntl
    import pty
    import termios
    import tty

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")  # Windows consoles default to cp1252
    except (AttributeError, ValueError):
        pass

HOME = Path(os.environ.get("AISWITCH_HOME", Path.home() / ".aiswitch"))
PROFILES = HOME / "profiles"
STATE_FILE = HOME / "state.json"
CONFIG_FILE = HOME / "config.json"
HISTORY_FILE = HOME / "history.json"   # when each account became active - used to attribute token usage
USAGE_CACHE = HOME / "usage_cache.v2.json"
EVENTS_FILE = HOME / "events.json"     # recent switches (time, from, to, reason) shown in the app

DEFAULT_TOOLS = {
    "codex": {
        "title": "Codex",
        "binary": "codex",
        "login_args": ["login"],
        "login_hint": "Browser खुलेगा → ChatGPT account चुनो → login होते ही ये अपने आप लौट आएगा.",
        "files": ["~/.codex/auth.json"],
        "resume_args": ["resume", "--last"],
        "login_warning": "Codex desktop app बंद कर दो - वो भी ~/.codex/auth.json इस्तेमाल करता है.",
        "value_flags": ["-m", "--model", "-c", "--config", "-s", "--sandbox", "-a",
                        "--ask-for-approval", "-p", "--profile", "-C", "--cd", "--add-dir"],
        "oneshot_markers": ["exec", "e"],
        "cooldown_hours": 5,
        "patterns": [
            # strings taken from the codex 0.162 binary
            "You've hit your usage limit",
            "You've reached your usage limit",
            "You're out of credits",
        ],
    },
    "claude": {
        "title": "Claude Code",
        "binary": "claude",
        "login_args": ["auth", "login"],
        "login_hint": "Browser खुलेगा → Claude account से Authorize करो → ये अपने आप लौट आएगा.",
        "login_warning": "Claude के बाकी चल रहे sessions (VS Code वाला भी) बंद कर दो - Keychain सब share करते हैं.",
        # macOS keeps the token in the Keychain; Linux uses the credentials file.
        "files": ["~/.claude/.credentials.json"],
        "keychain_service": "Claude Code-credentials",
        "secret_platforms": ["darwin"],  # Windows and Linux keep the token in .credentials.json
        "json_keys": [{"file": "~/.claude.json", "key": "oauthAccount"}],
        "resume_args": ["--continue"],
        "value_flags": ["--model", "--effort", "--permission-mode", "--add-dir", "--agent",
                        "--settings", "--mcp-config", "--append-system-prompt",
                        "--allowedTools", "--disallowedTools", "--fallback-model"],
        "oneshot_markers": ["-p", "--print"],
        "cooldown_hours": 5,
        "patterns": [
            # strings taken from the claude 2.1.296 binary
            "usage limit reached",
            "reached your weekly usage limit",
            "You've hit your limit",
        ],
    },
    "agy": {
        "title": "Antigravity (agy)",
        "binary": "agy",
        "binary_fallbacks": ["%LOCALAPPDATA%/agy/bin/agy.exe", "~/.gemini/bin/agy"],
        "login_args": [],
        "login_hint": "agy खुलेगा → Browser में Google से sign in करो → login होते ही /exit या Ctrl+C दबाकर बाहर आओ.",
        "login_warning": "Antigravity (agy) के बाकी चल रहे terminal sessions बंद कर दो - Keychain सब share करते हैं.",
        "files": [],  # agy 1.3+ keeps its login only in the credential store
        "keychain_service": "gemini",
        "keychain_account": "antigravity",
        "resume_args": ["--continue"],
        "value_flags": ["--model", "--effort", "--mode", "--agent", "--add-dir", "--project"],
        "oneshot_markers": ["-p", "--print", "--prompt"],
        "cooldown_hours": 5,
        "patterns": [
            # "Out of credits" is in the agy binary; the rest are guesses
            "AI: Out of credits",
            "RESOURCE_EXHAUSTED",
            "You have exhausted your quota",
            "quota exceeded",
        ],
    },
}

# How long to keep showing output after a limit message before killing the tool.
GRACE_SECONDS = 2.0


# ---------------------------------------------------------------- config/state

def load_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_private(path, data):
    """Atomically write bytes/str with 0600 permissions."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".aiswitch-tmp")
    # O_BINARY: on Windows os.open defaults to text mode, which would turn every \n into \r\n.
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0), 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data.encode() if isinstance(data, str) else data)
    move(tmp, path)


def move(src, dst):
    """os.replace, retried on Windows, where a file or folder can't be replaced or renamed while
    another program (antivirus, the search indexer, a running CLI) briefly has it open."""
    for attempt in range(10 if IS_WINDOWS else 1):
        try:
            return os.replace(src, dst)
        except PermissionError:
            if attempt == 9 or not IS_WINDOWS:
                raise
            time.sleep(0.2)


def save_state(state):
    write_private(STATE_FILE, json.dumps(state, indent=2))
    record_history(state)


def record_history(state):
    """Notes when each tool's active account changed, so token usage can be credited to it."""
    history = load_json(HISTORY_FILE, {})
    changed = False
    for tool, ts in state.items():
        h = history.setdefault(tool, [])
        if not h or h[-1][1] != ts.get("active"):
            h.append([time.time(), ts.get("active")])
            changed = True
    if changed:
        write_private(HISTORY_FILE, json.dumps(history))


def tools():
    merged = copy.deepcopy(DEFAULT_TOOLS)
    for name, override in load_json(CONFIG_FILE, {}).items():
        merged.setdefault(name, {}).update(override)
    return merged


def tool_cfg(name):
    t = tools()
    if name not in t:
        die("unknown tool '%s' (known: %s)" % (name, ", ".join(t)))
    return t[name]


def tool_state(state, tool):
    return state.setdefault(tool, {"active": None, "exhausted": {}})


def profile_dir(tool, name):
    return PROFILES / tool / name


def profile_names(tool):
    d = PROFILES / tool
    return sorted(p.name for p in d.iterdir() if p.is_dir() and not p.name.startswith(".")) if d.exists() else []


class Failure(Exception):
    pass


def die(msg):
    raise Failure(msg)


def say(msg):
    # \r\n because the terminal may still be in raw mode when this is printed.
    sys.stderr.write("\r\n\033[1;33m[aiswitch]\033[0m %s\r\n" % msg)
    sys.stderr.flush()


# ---------------------------------------------------------------- credential store
# Tools that keep their login in the OS credential store (Claude Code on macOS, agy everywhere via
# go-keyring) are switched by swapping that entry. go-keyring uses the macOS Keychain, the Windows
# Credential Manager (target "service:account") and the Linux Secret Service.

def _security(*args):
    return subprocess.run(["security"] + list(args), capture_output=True, text=True)


if IS_WINDOWS:
    import ctypes
    from ctypes import wintypes

    class _FILETIME(ctypes.Structure):
        _fields_ = [("lo", wintypes.DWORD), ("hi", wintypes.DWORD)]

    class _CREDENTIAL(ctypes.Structure):
        _fields_ = [("Flags", wintypes.DWORD), ("Type", wintypes.DWORD), ("TargetName", wintypes.LPWSTR),
                    ("Comment", wintypes.LPWSTR), ("LastWritten", _FILETIME),
                    ("CredentialBlobSize", wintypes.DWORD), ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
                    ("Persist", wintypes.DWORD), ("AttributeCount", wintypes.DWORD), ("Attributes", ctypes.c_void_p),
                    ("TargetAlias", wintypes.LPWSTR), ("UserName", wintypes.LPWSTR)]

    _advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    _CRED_TYPE_GENERIC, _CRED_PERSIST_LOCAL_MACHINE = 1, 2


def secret_backend():
    if sys.platform == "darwin":
        return "keychain" if shutil.which("security") else None
    if IS_WINDOWS:
        return "wincred"
    return "secret-tool" if shutil.which("secret-tool") else None


def secret_account(service):
    """The account an existing entry is stored under (macOS lets us discover it)."""
    if sys.platform == "darwin":
        m = re.search(r'"acct"<blob>="([^"]*)"', _security("find-generic-password", "-s", service).stdout)
        return m.group(1) if m else None
    return None


def secret_read(service, account=None):
    backend = secret_backend()
    if backend == "keychain":
        args = ["find-generic-password", "-s", service] + (["-a", account] if account else []) + ["-w"]
        r = _security(*args)
        return r.stdout.rstrip("\n") if r.returncode == 0 else None
    if backend == "wincred":
        ptr = ctypes.POINTER(_CREDENTIAL)()
        if not _advapi.CredReadW("%s:%s" % (service, account or ""), _CRED_TYPE_GENERIC, 0, ctypes.byref(ptr)):
            return None
        try:
            c = ptr.contents
            return bytes(c.CredentialBlob[:c.CredentialBlobSize]).decode("utf-8", "replace")
        finally:
            _advapi.CredFree(ptr)
    if backend == "secret-tool":
        r = subprocess.run(["secret-tool", "lookup", "service", service, "username", account or ""],
                           capture_output=True, text=True)
        return r.stdout if r.returncode == 0 and r.stdout else None
    return None


def secret_write(service, account, secret):
    backend = secret_backend()
    if backend == "keychain":
        r = _security("add-generic-password", "-U", "-s", service, "-a", account, "-w", secret)
        if r.returncode != 0:
            die("could not write the Keychain entry %s: %s" % (service, r.stderr.strip()))
    elif backend == "wincred":
        blob = secret.encode("utf-8")
        buf = (ctypes.c_ubyte * len(blob)).from_buffer_copy(blob)
        cred = _CREDENTIAL(Type=_CRED_TYPE_GENERIC, TargetName="%s:%s" % (service, account),
                           CredentialBlobSize=len(blob), CredentialBlob=buf,
                           Persist=_CRED_PERSIST_LOCAL_MACHINE, UserName=account)
        if not _advapi.CredWriteW(ctypes.byref(cred), 0):
            die("could not write the Windows credential %s:%s" % (service, account))
    elif backend == "secret-tool":
        r = subprocess.run(["secret-tool", "store", "--label=Password for '%s' on '%s'" % (account, service),
                            "service", service, "username", account], input=secret, capture_output=True, text=True)
        if r.returncode != 0:
            die("could not write the secret %s: %s" % (service, r.stderr.strip()))
    else:
        die("no credential store available on this system")


def secret_delete(service, account=None):
    backend = secret_backend()
    if backend == "keychain":
        _security(*(["delete-generic-password", "-s", service] + (["-a", account] if account else [])))
    elif backend == "wincred":
        _advapi.CredDeleteW("%s:%s" % (service, account or ""), _CRED_TYPE_GENERIC, 0)
    elif backend == "secret-tool":
        subprocess.run(["secret-tool", "clear", "service", service, "username", account or ""], capture_output=True)


def uses_secret_store(cfg):
    platforms = cfg.get("secret_platforms")
    return bool(cfg.get("keychain_service")) and (not platforms or sys.platform in platforms) and bool(secret_backend())


def command_name(cfg):
    """What the user types for this tool (the alias name), e.g. `codex`."""
    name = os.path.basename(cfg["binary"])
    return name[:-4] if name.lower().endswith(".exe") else name


def resolve_binary(cfg):
    """The tool's executable: PATH first, then known install locations."""
    found = shutil.which(cfg["binary"])
    if found:
        return found
    for candidate in cfg.get("binary_fallbacks", []):
        path = Path(os.path.expandvars(candidate)).expanduser()
        if path.exists():
            return str(path)
    return cfg["binary"]


# ---------------------------------------------------------------- snapshot/restore

def snapshot(tool, dest):
    """Copy the tool's live login into profile directory `dest`. Returns True if anything was found."""
    cfg = tool_cfg(tool)
    dest.mkdir(parents=True, exist_ok=True)
    os.chmod(dest, 0o700)
    found = False
    manifest = {"files": {}, "keychain": None, "json_keys": {}}

    for i, f in enumerate(cfg.get("files", [])):
        src = Path(f).expanduser()
        if src.exists():
            name = "file%d" % i
            write_private(dest / name, src.read_bytes())
            manifest["files"][f] = name
            found = True

    svc = cfg.get("keychain_service")
    if uses_secret_store(cfg):
        acct = cfg.get("keychain_account") or secret_account(svc) or os.environ.get("USER", "")
        secret = secret_read(svc, acct)
        if secret:
            write_private(dest / "keychain", secret)
            manifest["keychain"] = {"service": svc, "account": acct}
            found = True

    for jk in cfg.get("json_keys", []):
        data = load_json(Path(jk["file"]).expanduser(), {})
        if jk["key"] in data:
            manifest["json_keys"].setdefault(jk["file"], {})[jk["key"]] = data[jk["key"]]

    write_private(dest / "manifest.json", json.dumps(manifest, indent=2))
    return found


def restore(tool, src):
    cfg = tool_cfg(tool)
    manifest = load_json(src / "manifest.json", None)
    if manifest is None:
        die("profile %s is missing its manifest" % src)

    for f in cfg.get("files", []):
        live = Path(f).expanduser()
        if f in manifest["files"]:
            write_private(live, (src / manifest["files"][f]).read_bytes())
        elif live.exists():
            live.unlink()  # this account had no such file; don't leak the previous one's

    kc = manifest.get("keychain")
    if kc and (src / "keychain").exists() and uses_secret_store(cfg):
        secret_write(kc["service"], kc["account"], (src / "keychain").read_text(encoding="utf-8"))
    elif uses_secret_store(cfg):
        secret_delete(cfg["keychain_service"], cfg.get("keychain_account"))

    for jk in cfg.get("json_keys", []):
        path = Path(jk["file"]).expanduser()
        data = load_json(path, {})
        saved = manifest["json_keys"].get(jk["file"], {})
        if jk["key"] in saved:
            data[jk["key"]] = saved[jk["key"]]
        else:
            data.pop(jk["key"], None)
        write_private(path, json.dumps(data, indent=2))


def clear_live(tool):
    cfg = tool_cfg(tool)
    for f in cfg.get("files", []):
        p = Path(f).expanduser()
        if p.exists():
            p.unlink()
    if uses_secret_store(cfg):
        secret_delete(cfg["keychain_service"], cfg.get("keychain_account"))
    for jk in cfg.get("json_keys", []):
        path = Path(jk["file"]).expanduser()
        data = load_json(path, None)
        if data and jk["key"] in data:
            data.pop(jk["key"])
            write_private(path, json.dumps(data, indent=2))


def sync_active(tool, state):
    """Tokens get refreshed while a tool runs; copy them back into the active profile
    before switching away, otherwise the saved copy goes stale and stops working.

    Only when the live login is the same account: something else (another app sharing the
    credential store, a login done outside aiswitch) may have changed it, and writing it over the
    active profile would lose that account. In that case the live login is adopted instead."""
    active = tool_state(state, tool)["active"]
    if not active or not profile_dir(tool, active).exists():
        return
    fresh = PROFILES / tool / ".sync"
    shutil.rmtree(fresh, ignore_errors=True)
    if not snapshot(tool, fresh):
        shutil.rmtree(fresh, ignore_errors=True)
        return
    live, saved = label_of(fresh), account_label(tool, active)
    if live and saved and live != saved:
        shutil.rmtree(fresh, ignore_errors=True)
        log_event("%s: live login is %s, not '%s' (%s); keeping '%s' as saved" % (tool, live, active, saved, active))
        tool_state(state, tool)["active"] = None
        save_state(state)
        adopt_live_login(tool, interactive=False)
        tool_state(state, tool)["active"] = load_json(STATE_FILE, {}).get(tool, {}).get("active")
        return
    old = PROFILES / tool / ".old"
    shutil.rmtree(old, ignore_errors=True)
    move(profile_dir(tool, active), old)
    move(fresh, profile_dir(tool, active))
    shutil.rmtree(old, ignore_errors=True)


def add_event(tool, frm, to, reason, until=None):
    events = load_json(EVENTS_FILE, [])
    events.append({"at": time.time(), "tool": tool, "from": frm, "to": to, "reason": reason, "until": until})
    write_private(EVENTS_FILE, json.dumps(events[-200:]))


def switch_to(tool, name, state, reason="manual", until=None):
    if not profile_dir(tool, name).exists():
        die("no saved account '%s' for %s (see: aiswitch list %s)" % (name, tool, tool))
    previous = tool_state(state, tool)["active"]
    sync_active(tool, state)
    restore(tool, profile_dir(tool, name))
    tool_state(state, tool)["active"] = name
    save_state(state)
    if previous != name:
        add_event(tool, previous, name, reason, until)


def available(tool, state):
    """Accounts that aren't resting, in rotation order starting after the active one."""
    ts = tool_state(state, tool)
    names = profile_names(tool)
    if ts["active"] in names:
        i = names.index(ts["active"])
        names = names[i + 1:] + names[:i + 1]
    return [n for n in names if cooldown_left(tool, state, n) <= 0 and not known_empty_until(tool, n)]


def known_empty_until(tool, name):
    """When the last usage read showed an empty limit window for this account, the time it resets.
    Keeps rotation from picking an account that is already out (e.g. a spent weekly limit)."""
    entry = cache_get(tool, name)
    if not entry or time.time() - entry["at"] > 7 * 86400:
        return None
    resets = [r["reset"] for r in entry["data"].get("rows", [])
              if r.get("left", 100) <= 2 and r.get("reset") and r["reset"] > time.time()]
    return max(resets) if resets else None


def mark_exhausted(tool, state, until=None):
    """Rests the active account until `until` (its real reset time when known), else cooldown_hours."""
    ts = tool_state(state, tool)
    if ts["active"]:
        hours = float(tool_cfg(tool).get("cooldown_hours", 5))
        ts["exhausted"][ts["active"]] = time.time()
        ts.setdefault("rest", {})[ts["active"]] = until if until and until > time.time() else time.time() + hours * 3600
        save_state(state)


def clear_rest(state, tool, name=None):
    ts = tool_state(state, tool)
    for key in ("exhausted", "rest"):
        bucket = ts.setdefault(key, {})
        if name:
            bucket.pop(name, None)
        else:
            bucket.clear()


def next_account(tool, state, reason="manual", until=None):
    """Switch to the next usable account. Returns its name, or None if all are resting."""
    ts = tool_state(state, tool)
    for name in available(tool, state):
        if name != ts["active"]:
            switch_to(tool, name, state, reason, until)
            return name
    return None


# ---------------------------------------------------------------- pty runner

ANSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")


def normalize(b):
    # TUIs place words with cursor moves rather than spaces, so compare with all whitespace removed.
    # Curly quotes (You’ve) are folded to ASCII so patterns can be written with a plain '.
    b = b.replace("\u2019".encode(), b"'").replace("\u2018".encode(), b"'")
    return re.sub(rb"\s+", b"", ANSI.sub(b"", b)).lower()


def run_once(argv, patterns, verify=None, send_after_idle=None):
    """Run argv on a pty, mirroring the terminal.

    Returns ('limit', (verdict, until)) when a limit pattern showed up and wasn't ruled out, else
    ('exit', code). `verify()` runs in the background on the first match and returns
    (verdict, until); a 'denied' verdict (the provider says quota is left) keeps the session going,
    so text that merely mentions a limit doesn't switch accounts. A second match always switches.
    `send_after_idle` is typed once the program has drawn its screen and gone quiet, unless the
    user starts typing first."""
    import threading
    needles = [normalize(p.encode()) for p in patterns]
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.execvp(argv[0], argv)
        except OSError as e:
            sys.stderr.write("aiswitch: cannot run %s: %s\n" % (argv[0], e))
            os._exit(127)

    stdin_fd = sys.stdin.fileno()
    is_tty = os.isatty(stdin_fd)

    def sync_size(*_):
        if is_tty:
            size = fcntl.ioctl(stdin_fd, termios.TIOCGWINSZ, b"\0" * 8)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, size)

    sync_size()
    old_winch = signal.signal(signal.SIGWINCH, sync_size)
    old_attrs = termios.tcgetattr(stdin_fd) if is_tty else None
    if is_tty:
        tty.setraw(stdin_fd)

    tail = b""
    hit_at = None
    hits = 0
    check = None
    verdict = ("unknown", None)
    started = last_output = time.time()
    inputs = [fd, stdin_fd]
    try:
        while True:
            now = time.time()
            if hit_at:
                checking = check is not None and check["thread"].is_alive()
                if not checking and now - hit_at > GRACE_SECONDS:
                    verdict = check["result"] if check else ("unknown", None)
                    if verdict[0] == "denied" and hits == 1:
                        log_event("%s: limit text seen but the provider reports quota left - not switching" % argv[0])
                        hit_at, check, tail = None, None, b""
                        continue
                    break
            if send_after_idle and now - started > 3 and now - last_output > 1.5:
                os.write(fd, send_after_idle.encode())
                time.sleep(0.2)
                os.write(fd, b"\r")
                send_after_idle = None
            elif send_after_idle and now - started > 45:
                send_after_idle = None  # never went quiet; leave it to the user
            try:
                ready, _, _ = select.select(inputs, [], [], 0.25)
            except InterruptedError:
                continue
            if fd in ready:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    data = b""
                if not data:
                    break
                os.write(sys.stdout.fileno(), data)
                last_output = time.time()
                if not hit_at:
                    tail = (tail + normalize(data))[-8192:]
                    if any(n in tail for n in needles):
                        hit_at = time.time()
                        hits += 1
                        if verify and hits == 1:
                            check = {"result": ("unknown", None)}

                            def run_check(box=check):
                                try:
                                    box["result"] = verify()
                                except Exception:
                                    box["result"] = ("unknown", None)
                            check["thread"] = threading.Thread(target=run_check, daemon=True)
                            check["thread"].start()
            if stdin_fd in ready:
                data = os.read(stdin_fd, 65536)
                if data:
                    send_after_idle = None  # the user is typing; don't type over them
                    os.write(fd, data)
                else:
                    inputs.remove(stdin_fd)
    finally:
        if old_attrs is not None:
            termios.tcsetattr(stdin_fd, termios.TCSAFLUSH, old_attrs)
        signal.signal(signal.SIGWINCH, old_winch)

    if hit_at:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                break
            for _ in range(20):
                if os.waitpid(pid, os.WNOHANG)[0]:
                    break
                time.sleep(0.1)
            else:
                continue
            break
        os.close(fd)
        return "limit", verdict

    os.close(fd)
    _, status = os.waitpid(pid, 0)
    return "exit", os.waitstatus_to_exitcode(status)


def log_event(msg):
    try:
        with open(HOME / "aiswitch.log", "a", encoding="utf-8") as f:
            f.write("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except OSError:
        pass


def limit_check(tool, name):
    """Asks the provider whether `name` is really out of quota.
    Returns (verdict, until): 'confirmed' / 'denied' / 'unknown', and when the empty window resets."""
    rows, reached = None, False
    try:
        if tool == "claude":
            sync_active("claude", load_json(STATE_FILE, {}))  # the token Claude Code is using right now
            live = claude_limits(name)
            if live:
                cache_put("claude", name, live)
                rows = live["rows"]
        elif tool == "codex":
            _, limits = codex_scan(1, want_tokens=False)
            hits = [limits[i] for i in codex_ids(name) if i in limits]
            if hits:
                latest = max(hits, key=lambda h: h["at"])
                if time.time() - latest["at"] < 600:  # only trust what codex logged just now
                    rows = codex_limit_rows(latest["rl"])
                    reached = bool(latest["rl"].get("rate_limit_reached_type"))
        elif tool == "agy":
            data = agy_quota()
            if data:
                cache_put("agy", name, data)
                rows = data["rows"]
    except Exception:
        return "unknown", None
    if not rows:
        return "unknown", None
    empty = [r for r in rows if r["left"] <= 2] or (rows if reached else [])
    if empty:
        resets = [r["reset"] for r in empty if r.get("reset") and r["reset"] > time.time()]
        return "confirmed", (max(resets) if resets else None)
    # agy also stops on "Out of credits", which the quota rows don't show, so it is never ruled out.
    if tool != "agy" and all(r["left"] > 5 for r in rows):
        return "denied", None
    return "unknown", None


def run_plain(argv):
    try:
        if IS_WINDOWS:
            return subprocess.call(argv)
        os.execvp(argv[0], argv)
    except OSError as e:
        die("cannot run %s: %s" % (argv[0], e))


def cmd_run(tool, args):
    cfg = tool_cfg(tool)
    state = load_json(STATE_FILE, {})
    ts = tool_state(state, tool)
    if not profile_names(tool):
        # Nothing set up for this tool yet: behave exactly like the plain command.
        return run_plain([resolve_binary(cfg)] + args)
    if ts["active"] not in profile_names(tool):
        adopt_live_login(tool, interactive=False)
        state = load_json(STATE_FILE, {})
        ts = tool_state(state, tool)
    if ts["active"] not in profile_names(tool) or ts["active"] not in available(tool, state):
        if not next_account(tool, state):
            die("all %s accounts are cooling down (see: aiswitch list %s)" % (tool, tool))
        say("%s: using account '%s'" % (tool, ts["active"]))

    binary = resolve_binary(cfg)
    if IS_WINDOWS:
        # No stdlib pseudo-terminal on Windows, so the limit message can't be watched: run as-is.
        say("%s: using '%s' (limit auto-switch needs macOS/Linux; switch from the app or `aiswitch next`)" % (tool, ts["active"]))
        return run_plain([binary] + args)
    argv = [binary] + args
    oneshot = any(a in cfg.get("oneshot_markers", []) for a in args)
    send = None
    while True:
        current = ts["active"]
        outcome, result = run_once(argv, cfg["patterns"], verify=lambda: limit_check(tool, current), send_after_idle=send)
        if outcome == "exit":
            return result
        verdict, until = result
        # Another terminal may have rotated already (same account, same limit) - follow it.
        state = load_json(STATE_FILE, {})
        ts = tool_state(state, tool)
        if ts["active"] != current:
            name = ts["active"]
        else:
            mark_exhausted(tool, state, until)
            name = next_account(tool, state, reason="limit", until=until)
        free = fmt_reset(until) if until else "~%gh" % float(cfg.get("cooldown_hours", 5))
        log_event("%s: '%s' hit its limit (%s, %s) -> %s" % (tool, current, verdict, free, name or "no account ready"))
        if not name:
            say("%s: '%s' hit its limit and every other account is resting. "
                "`aiswitch list %s` shows when they free up." % (tool, current, tool))
            return 1
        say("%s: '%s' hit its usage limit (%s) -> switched to '%s', resuming..." % (tool, current, free, name))
        argv = [binary] + resume_args(cfg, args)
        if cfg.get("auto_continue", True) and not oneshot:
            send = cfg.get("continue_message", "continue")


def resume_args(cfg, args):
    """Args for the relaunch. One-shot runs (codex exec, claude -p) are simply repeated;
    interactive ones resume the last session and keep only the flags, so the prompt isn't resent."""
    if any(a in cfg.get("oneshot_markers", []) for a in args):
        return list(args)
    value_flags = set(cfg.get("value_flags", []))
    kept, i = [], 0
    while i < len(args):
        a = args[i]
        if a in value_flags and i + 1 < len(args):
            kept += [a, args[i + 1]]
            i += 2
            continue
        if a.startswith("-") and a not in cfg.get("resume_args", []):
            kept.append(a)  # (a flag the resume args already carry, like --last, isn't repeated)
        i += 1
    return list(cfg.get("resume_args", [])) + kept


# ---------------------------------------------------------------- accounts

def fmt_left(seconds):
    h, m = divmod(int(seconds) // 60, 60)
    return "%dh%02dm" % (h, m)


def cooldown_left(tool, state, name):
    """Seconds until a resting account may be used again (<= 0 when it's ready)."""
    ts = tool_state(state, tool)
    if name in ts.get("rest", {}):
        return ts["rest"][name] - time.time()
    cooldown = float(tool_cfg(tool).get("cooldown_hours", 5)) * 3600  # state written before rest-until existed
    return cooldown - (time.time() - ts["exhausted"].get(name, 0))


def label_of(d):
    """Best-effort email of the login saved in profile dir `d`, without printing any secret."""
    m = load_json(d / "manifest.json", {})
    for keys in m.get("json_keys", {}).values():
        acct = keys.get("oauthAccount") or {}
        if isinstance(acct, dict) and acct.get("emailAddress"):
            return acct["emailAddress"]
    for fname in m.get("files", {}).values():
        try:
            text = (d / fname).read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        found = re.search(r'"email"\s*:\s*"([^"]+)"', text)
        if found:
            return found.group(1)
        # codex keeps the email inside the id_token JWT payload
        import base64
        for jwt in re.findall(r"eyJ[\w-]+\.(eyJ[\w-]+)\.", text):
            try:
                payload = json.loads(base64.urlsafe_b64decode(jwt + "=" * (-len(jwt) % 4)))
            except ValueError:
                continue
            if payload.get("email"):
                return payload["email"]
    kc_file = d / "keychain"
    if kc_file.exists():
        try:
            kc_text = kc_file.read_text(encoding="utf-8")
            if kc_text.startswith("go-keyring-base64:"):
                import base64
                kc_text = base64.b64decode(kc_text.split(":", 1)[1]).decode("utf-8", "ignore")
            found = re.search(r'"email"\s*:\s*"([^"]+)"', kc_text)
            if found:
                return found.group(1)
            import base64
            for jwt in re.findall(r"eyJ[\w-]+\.(eyJ[\w-]+)\.", kc_text):
                try:
                    payload = json.loads(base64.urlsafe_b64decode(jwt + "=" * (-len(jwt) % 4)))
                except ValueError:
                    continue
                if payload.get("email"):
                    return payload["email"]
        except (UnicodeDecodeError, OSError):
            pass
    return ""


def account_label(tool, name):
    return label_of(profile_dir(tool, name))


def valid_name(name):
    return bool(re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,30}$", name))


def save_current(tool, name):
    """Save whatever is logged in right now as `name`. Returns (ok, message)."""
    state = load_json(STATE_FILE, {})
    if not snapshot(tool, profile_dir(tool, name)):
        shutil.rmtree(profile_dir(tool, name), ignore_errors=True)
        return False, "%s में अभी कोई login नहीं मिला - save करने को कुछ नहीं है" % tool
    tool_state(state, tool)["active"] = name
    save_state(state)
    return True, "%s: '%s' save हो गया %s" % (tool, name, account_label(tool, name))


def adopt_live_login(tool, interactive=True):
    """Make sure whatever is logged in right now is tracked. If its email matches a saved account,
    that account becomes active (with the fresher tokens); if it's a new email, it is saved under a
    new name. Returns the active name, or None if nothing is logged in."""
    state = load_json(STATE_FILE, {})
    ts = tool_state(state, tool)
    pending = PROFILES / tool / ".pending"
    shutil.rmtree(pending, ignore_errors=True)
    try:
        if not snapshot(tool, pending):
            return None
        email = label_of(pending)
        match = [n for n in profile_names(tool) if email and account_label(tool, n) == email]
        if match:
            name = match[0]
            old = PROFILES / tool / ".old"
            shutil.rmtree(old, ignore_errors=True)
            move(profile_dir(tool, name), old)
            move(pending, profile_dir(tool, name))
            shutil.rmtree(old, ignore_errors=True)
        else:
            title = tool_cfg(tool).get("title", tool)
            if interactive:
                print("\n  %s में ये account login है पर save नहीं है: %s"
                      % (title, paint(email or "email पता नहीं चला", "b")))
                name = ask_new_name(tool, "इसे किस नाम से save करें")
            else:
                name = default_name(tool)
            move(pending, profile_dir(tool, name))
            if interactive:
                print(paint("  ✔ '%s' save हो गया" % name, "g"))
            else:
                say("%s: unsaved login %s kept as '%s'" % (tool, email, name))
        ts["active"] = name
        save_state(state)
        return name
    finally:
        shutil.rmtree(pending, ignore_errors=True)


def run_login(cfg):
    # The parent ignores Ctrl+C so it can be used to quit agy after logging in; the child gets it as usual.
    old = signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        kwargs = {} if IS_WINDOWS else {"preexec_fn": lambda: signal.signal(signal.SIGINT, signal.SIG_DFL)}
        subprocess.run([resolve_binary(cfg)] + list(cfg.get("login_args", [])), **kwargs)
    except OSError as e:
        print("cannot run %s: %s" % (cfg["binary"], e))
    finally:
        signal.signal(signal.SIGINT, old)


def add_account(tool, name):
    """Log out locally (without revoking anything), let the user log in fresh, save that as `name`.
    On failure the previous login is put back. Returns (ok, message)."""
    cfg = tool_cfg(tool)
    state = load_json(STATE_FILE, {})
    ts = tool_state(state, tool)
    if profile_dir(tool, name).exists():
        return False, "'%s' नाम पहले से है" % name
    previous = ts["active"] if ts["active"] in profile_names(tool) else None
    # Never lose the login that's there now: refresh its profile, or keep it under a backup name.
    if previous:
        sync_active(tool, state)
    else:
        backup = "backup-%d" % time.time()
        if snapshot(tool, profile_dir(tool, backup)):
            previous = backup
            print("अभी वाला login '%s' नाम से रख लिया" % backup)
        else:
            shutil.rmtree(profile_dir(tool, backup), ignore_errors=True)

    def put_back():
        state2 = load_json(STATE_FILE, {})
        if previous:
            restore(tool, profile_dir(tool, previous))
        tool_state(state2, tool)["active"] = previous
        save_state(state2)

    clear_live(tool)
    ts["active"] = None
    save_state(state)
    run_login(cfg)

    dest = profile_dir(tool, name)
    if not snapshot(tool, dest):
        shutil.rmtree(dest, ignore_errors=True)
        put_back()
        return False, "login पूरा नहीं हुआ" + (" - पुराना account '%s' वापस लगा दिया" % previous if previous else "")
    email = label_of(dest)
    same = [n for n in profile_names(tool) if n != name and email and account_label(tool, n) == email]
    if same:
        shutil.rmtree(dest, ignore_errors=True)
        put_back()
        return False, ("ये वही email (%s) है जो '%s' में पहले से है - browser ने पुराना account उठा लिया. "
                       "Browser में उस site से logout करो (या login link Incognito window में खोलो) और फिर कोशिश करो."
                       % (email, same[0]))
    state = load_json(STATE_FILE, {})
    tool_state(state, tool)["active"] = name
    save_state(state)
    return True, "%s: '%s' जुड़ गया %s" % (tool, name, email)


def remove_account(tool, name):
    state = load_json(STATE_FILE, {})
    ts = tool_state(state, tool)
    shutil.rmtree(profile_dir(tool, name), ignore_errors=True)
    clear_rest(state, tool, name)
    if ts["active"] == name:
        ts["active"] = None  # the login stays in place; it's just no longer tracked
    save_state(state)


def cmd_list(only=None):
    state = load_json(STATE_FILE, {})
    for tool in tools():
        if only and tool != only:
            continue
        ts = tool_state(state, tool)
        names = profile_names(tool)
        print("%s:" % tool + ("" if names else "  (no accounts saved)"))
        for n in names:
            left = cooldown_left(tool, state, n)
            status = "limit hit, free in " + fmt_left(left) if left > 0 else "ready"
            print("  %s %-12s %-32s %s" % ("*" if n == ts["active"] else " ", n, account_label(tool, n), status))



# ---------------------------------------------------------------- usage

def jwt_claims(token):
    import base64
    try:
        part = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    except (IndexError, ValueError):
        return {}


def parse_time(value):
    """ISO string or epoch seconds/ms -> epoch seconds (None if missing)."""
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return value / 1000 if value > 1e12 else value
    from datetime import datetime
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def fmt_reset(epoch):
    if not epoch:
        return ""
    left = epoch - time.time()
    if left <= 0:
        return "reset हो चुका"
    when = time.strftime("%a %H:%M", time.localtime(epoch))
    d, rem = divmod(int(left), 86400)
    return "reset %s (%s)" % (when, ("%dd %dh" % (d, rem // 3600)) if d else fmt_left(left))


def fmt_ago(epoch):
    mins = int((time.time() - epoch) // 60)
    if mins < 2:
        return "अभी"
    if mins < 120:
        return "%d min पहले" % mins
    if mins < 2880:
        return "%d घंटे पहले" % (mins // 60)
    return "%d दिन पहले" % (mins // 1440)


def bar(left_pct, width=10):
    left_pct = max(0.0, min(100.0, left_pct))
    full = int(round(left_pct / 100 * width))
    color = "g" if left_pct > 50 else "y" if left_pct > 15 else "r"
    return paint("█" * full, color) + paint("░" * (width - full), "d") + " %3d%% बचा" % round(left_pct)


def fmt_tokens(n):
    for unit, size in (("B", 1e9), ("M", 1e6), ("K", 1e3)):
        if n >= size:
            return "%.1f%s" % (n / size, unit)
    return str(int(n))


def cache_put(tool, name, data):
    cache = load_json(USAGE_CACHE, {})
    cache.setdefault(tool, {})[name] = {"at": time.time(), "data": data}
    write_private(USAGE_CACHE, json.dumps(cache))


def cache_get(tool, name):
    return load_json(USAGE_CACHE, {}).get(tool, {}).get(name)


def account_at(tool, when, history):
    """Which saved account was active for `tool` at time `when` (None if before tracking began)."""
    current = None
    for ts, name in history.get(tool, []):
        if ts > when:
            break
        current = name
    return current


def recent_files(root, pattern, days):
    cutoff = time.time() - days * 86400
    for f in Path(root).expanduser().glob(pattern):
        try:
            if f.stat().st_mtime >= cutoff:
                yield f
        except OSError:
            pass


# -- Claude: limits from the account's OAuth token, tokens from ~/.claude/projects transcripts

# Limit rows are language-neutral: {"kind", "group", "left" (percent remaining), "reset" (epoch)}.
# The terminal shows them in Hindi, the Switchboard app in English.
KIND_TEXT = {"5h": "5 घंटे", "week": "हफ्ता", "week_opus": "हफ्ता Opus", "week_sonnet": "हफ्ता Sonnet", "day": "दिन"}


def row_text(row):
    kind = KIND_TEXT.get(row.get("kind"), row.get("kind") or "?")
    return (row["group"] + " · " if row.get("group") else "") + kind


def claude_limits(name):
    """Live limits for a saved Claude account, or None if its access token has expired."""
    import urllib.request
    try:
        oauth = json.loads((profile_dir("claude", name) / "keychain").read_text(encoding="utf-8"))["claudeAiOauth"]
    except (OSError, ValueError, KeyError):
        # Windows/Linux keep the token in .credentials.json instead of the Keychain
        oauth = None
        m = load_json(profile_dir("claude", name) / "manifest.json", {})
        for fname in m.get("files", {}).values():
            oauth = load_json(profile_dir("claude", name) / fname, {}).get("claudeAiOauth") or oauth
        if not oauth:
            return None
    expires = parse_time(oauth.get("expiresAt"))
    if not oauth.get("accessToken") or (expires and expires < time.time() + 60):
        return None
    req = urllib.request.Request("https://api.anthropic.com/api/oauth/usage", headers={
        "Authorization": "Bearer " + oauth["accessToken"],
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
        "User-Agent": "aiswitch",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            body = json.loads(r.read())
    except Exception:
        return None
    rows = []
    for key, kind in (("five_hour", "5h"), ("seven_day", "week"), ("seven_day_opus", "week_opus"), ("seven_day_sonnet", "week_sonnet")):
        b = body.get(key)
        if isinstance(b, dict) and b.get("utilization") is not None:
            rows.append({"kind": kind, "group": None, "left": 100 - float(b["utilization"]), "reset": parse_time(b.get("resets_at"))})
    return {"plan": oauth.get("subscriptionType") or "", "rows": rows}


def claude_tokens(days, history):
    totals, seen = {}, set()
    cutoff = time.time() - days * 86400
    for f in recent_files("~/.claude/projects", "**/*.jsonl", days):
        try:
            fh = open(f, encoding="utf-8", errors="ignore")
        except OSError:
            continue
        with fh:
            for line in fh:
                if '"usage"' not in line or '"assistant"' not in line:
                    continue
                try:
                    d = json.loads(line)
                    msg = d["message"]
                    u = msg["usage"]
                except (ValueError, KeyError, TypeError):
                    continue
                key = (msg.get("id"), d.get("requestId"))
                when = parse_time(d.get("timestamp")) or 0
                model = msg.get("model") or "?"
                if key in seen or when < cutoff or model.startswith("<"):
                    continue
                seen.add(key)
                acct = account_at("claude", when, history)
                t = totals.setdefault(acct, {}).setdefault(model, new_tokens())
                t["in"] += u.get("input_tokens") or 0
                t["out"] += u.get("output_tokens") or 0
                t["cache"] += (u.get("cache_read_input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0)
                t["think"] += (u.get("output_tokens_details") or {}).get("thinking_tokens") or 0
    return totals


def new_tokens():
    return {"in": 0, "out": 0, "cache": 0, "think": 0}


def add_tokens(into, models):
    for model, t in (models or {}).items():
        m = into.setdefault(model, new_tokens())
        for k in m:
            m[k] += t.get(k, 0)
    return into


# -- Codex: everything comes from ~/.codex/sessions, which records the account of each session

def codex_ids(name):
    """Account/user ids a saved Codex login can appear under in session logs."""
    ids = set()
    m = load_json(profile_dir("codex", name) / "manifest.json", {})
    for fname in m.get("files", {}).values():
        auth = load_json(profile_dir("codex", name) / fname, {})
        tokens = auth.get("tokens") or {}
        if tokens.get("account_id"):
            ids.add(tokens["account_id"])
        for tok in (tokens.get("id_token"), tokens.get("access_token")):
            claims = jwt_claims(tok) if isinstance(tok, str) else {}
            info = claims.get("https://api.openai.com/auth") or {}
            for k in ("chatgpt_account_id", "chatgpt_user_id", "user_id"):
                if info.get(k):
                    ids.add(info[k])
    return ids


def codex_scan(days, want_tokens=True):
    """Returns ({account_id: {model: tokens}}, {account_id: latest rate_limits event})."""
    totals, limits = {}, {}
    cutoff = time.time() - days * 86400
    # Limits come from the newest event per account, so look a little further back than the token window.
    for f in recent_files("~/.codex/sessions", "**/*.jsonl", max(days, 14)):
        acct, model, prev = None, "?", None
        try:
            fh = open(f, encoding="utf-8", errors="ignore")
        except OSError:
            continue
        with fh:
            for line in fh:
                if '"session_meta"' not in line and '"turn_context"' not in line and '"token_count"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                p = d.get("payload") or {}
                kind = d.get("type") if d.get("type") != "event_msg" else p.get("type")
                if kind == "session_meta":
                    acct = p.get("creator_account_id") or p.get("creator_user_id")
                elif kind == "turn_context":
                    model = p.get("model") or model
                elif kind == "token_count":
                    when = parse_time(d.get("timestamp")) or 0
                    rl = p.get("rate_limits") or {}
                    if acct and (rl.get("primary") or rl.get("secondary")) and when >= limits.get(acct, {}).get("at", 0):
                        limits[acct] = {"at": when, "rl": rl}
                    total = ((p.get("info") or {}).get("total_token_usage")) or None
                    if not total or not want_tokens:
                        continue
                    base = prev or {}
                    prev = total
                    if when < cutoff:
                        continue
                    t = totals.setdefault(acct, {}).setdefault(model, new_tokens())
                    delta = lambda k: max(0, (total.get(k) or 0) - (base.get(k) or 0))
                    t["cache"] += delta("cached_input_tokens")
                    t["in"] += max(0, delta("input_tokens") - delta("cached_input_tokens"))
                    t["out"] += delta("output_tokens")
                    t["think"] += delta("reasoning_output_tokens")
    return totals, limits


def codex_limit_rows(rl):
    rows = []
    for key in ("primary", "secondary"):
        w = rl.get(key)
        if not w or w.get("used_percent") is None:
            continue
        mins = w.get("window_minutes") or 0
        kind = "5h" if mins and mins <= 360 else "week" if mins and mins <= 10080 else "%d min" % mins
        rows.append({"kind": kind, "group": None, "left": 100 - float(w["used_percent"]),
                     "reset": parse_time(w.get("resets_at"))})
    return rows


# -- agy: `agy -p /usage --output-format json` reports the logged-in account's quota per model group

def agy_processes():
    """Command lines of running agy processes (interactive sessions and the Antigravity app's `agy --hub`)."""
    if IS_WINDOWS:
        cmd = ["powershell", "-NoProfile", "-Command",
               "Get-CimInstance Win32_Process -Filter \"name='agy.exe'\" | ForEach-Object { $_.CommandLine }"]
    else:
        cmd = ["pgrep", "-fl", "(^|/)agy( |$)"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return []
    return [line for line in r.stdout.splitlines() if line.strip()]


def agy_hub_running():
    return any("--hub" in line for line in agy_processes())


def agy_quota():
    try:
        r = subprocess.run([resolve_binary(tool_cfg("agy")), "-p", "/usage", "--output-format", "json"],
                           capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
        groups = json.loads(r.stdout)["command"]["data"]["groups"]
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
        return None
    rows = []
    for g in groups:
        for b in g.get("buckets", []):
            if b.get("remaining_fraction") is None:
                continue
            kind = {"weekly": "week", "daily": "day", "five_hour": "5h"}.get(b.get("window"), b.get("window") or "?")
            rows.append({"kind": kind, "group": g.get("name", "?").replace(" Models", "").replace(" models", ""),
                         "left": float(b["remaining_fraction"]) * 100, "reset": parse_time(b.get("reset_time"))})
    return {"rows": rows}


def collect_agy(max_age=300):
    """Quota for every saved agy account. Each other account's login is put in place just long
    enough to ask, then the original is restored. Nothing is written back into the profiles, so a
    token refreshed by someone else meanwhile can never end up under the wrong account.
    Never done while any agy process runs: the Antigravity app's background `agy --hub` reads the
    login from the same credential-store entry and writes its copy back later, which would leave
    the wrong account signed in. Returns a note code when other accounts were skipped.
    max_age=None never probes (cache only)."""
    if max_age is None:
        return None
    state = load_json(STATE_FILE, {})
    if tool_state(state, "agy")["active"] not in profile_names("agy"):
        adopt_live_login("agy", interactive=False)
        state = load_json(STATE_FILE, {})
    original = tool_state(state, "agy")["active"]
    names = profile_names("agy")
    if original in names:
        sync_active("agy", state)
    running = agy_processes()
    busy = ("agy_app_open" if any("--hub" in line for line in running) else "agy_session_open") if running else None
    swapped = False
    try:
        for n in [original] + [x for x in names if x != original]:
            if n not in names:
                continue
            cached = cache_get("agy", n)
            if cached and time.time() - cached["at"] < max_age:
                continue  # checked a few minutes ago; agy takes ~10s per account
            if n != original:
                if busy:
                    continue
                restore("agy", profile_dir("agy", n))
                swapped = True
            data = agy_quota()
            if data:
                cache_put("agy", n, data)
    finally:
        if swapped and original in names:
            restore("agy", profile_dir("agy", original))
    return busy


# -- one data model for the terminal and for the Switchboard app

def limits_view(entry, plan=None):
    """Cached/live limits -> display data. Windows whose reset time has passed count as full again."""
    if not entry:
        return None
    rows = []
    for row in entry["data"].get("rows", []):
        reset = row.get("reset")
        passed = bool(reset and reset < time.time())
        rows.append({"kind": row.get("kind"), "group": row.get("group"),
                     "left": 100.0 if passed else max(0.0, min(100.0, row.get("left", 0))),
                     "reset": None if passed else reset})
    return {"plan": plan if plan is not None else entry["data"].get("plan") or None,
            "observedAt": entry["at"], "rows": rows}


AGY_PROBE = {"cache": None, "auto": 300, "fresh": 0}


def usage_data(only=None, days=7, agy="auto", tokens=True):
    """Everything the usage screens show, per tool and account. Never contains credentials."""
    record_history(load_json(STATE_FILE, {}))  # tracking starts no later than the first look
    history = load_json(HISTORY_FILE, {}) if tokens else {}
    out = []
    for tool, cfg in tools().items():
        if only and tool != only:
            continue
        names = profile_names(tool)
        entry = {"tool": tool, "title": cfg.get("title", tool), "command": command_name(cfg),
                 "accounts": [], "otherTokens": None, "notes": [],
                 "events": [e for e in load_json(EVENTS_FILE, []) if e.get("tool") == tool][-5:][::-1]}
        out.append(entry)
        if not names:
            entry["active"] = None
            continue
        per_account = {n: {"limits": None, "tokens": None} for n in names}

        if tool == "claude":
            sync_active("claude", load_json(STATE_FILE, {}))  # pick up the token Claude Code refreshed
            claude_tok = claude_tokens(days, history) if tokens else {}
            for n in names:
                live = claude_limits(n)
                if live:
                    cache_put("claude", n, live)
                per_account[n]["limits"] = limits_view(cache_get("claude", n))
                per_account[n]["tokens"] = claude_tok.get(n) if tokens else None
            if claude_tok.get(None):
                entry["otherTokens"] = claude_tok[None]
                entry["notes"].append("claude_tokens_before_tracking")

        elif tool == "codex":
            totals, limits = codex_scan(days, want_tokens=tokens)
            claimed = set()
            for n in names:
                ids = codex_ids(n)
                claimed |= ids
                hits = [limits[i] for i in ids if i in limits]
                if hits:
                    latest = max(hits, key=lambda h: h["at"])
                    per_account[n]["limits"] = limits_view(
                        {"at": latest["at"], "data": {"rows": codex_limit_rows(latest["rl"])}},
                        plan=latest["rl"].get("plan_type"))
                if tokens:
                    merged = {}
                    for i in ids:
                        add_tokens(merged, totals.get(i))
                    per_account[n]["tokens"] = merged
            other = {}
            for acct, models in totals.items():
                if acct not in claimed:
                    add_tokens(other, models)
            entry["otherTokens"] = other or None

        elif tool == "agy":
            skipped = collect_agy(AGY_PROBE.get(agy, 300))
            if skipped:
                entry["notes"].append(skipped)
            entry["notes"].append("agy_no_token_log")
            for n in names:
                per_account[n]["limits"] = limits_view(cache_get("agy", n))

        state = load_json(STATE_FILE, {})
        ts = tool_state(state, tool)
        entry["active"] = ts["active"] if ts["active"] in names else None
        for n in names:
            cool = cooldown_left(tool, state, n)
            entry["accounts"].append({
                "name": n, "email": account_label(tool, n) or None, "active": n == ts["active"],
                "cooldownUntil": time.time() + cool if cool > 0 else None,
                "limits": per_account[n]["limits"], "tokens": per_account[n]["tokens"]})
    return out


def print_limits(view, indent="      "):
    if not view or not view["rows"]:
        print(indent + paint("limit का data नहीं मिला", "d"))
        return
    for row in view["rows"]:
        print("%s%-22s %s  %s" % (indent, row_text(row), bar(row["left"]), paint(fmt_reset(row.get("reset")), "d")))
    if time.time() - view["observedAt"] > 600:
        print(indent + paint("(आखिरी बार देखा: %s)" % fmt_ago(view["observedAt"]), "d"))


def print_tokens(models, indent="      "):
    if not models:
        print(indent + paint("इस दौरान कोई token इस्तेमाल नहीं हुआ", "d"))
        return
    for model, t in sorted(models.items(), key=lambda kv: -(kv[1]["in"] + kv[1]["out"] + kv[1]["cache"])):
        parts = ["in %s" % fmt_tokens(t["in"]), "out %s" % fmt_tokens(t["out"]), "cache %s" % fmt_tokens(t["cache"])]
        if t["think"]:
            parts.append("thinking %s" % fmt_tokens(t["think"]))
        print("%s%-22s %s" % (indent, model, paint(" · ".join(parts), "c")))


NOTE_TEXT = {
    "claude_tokens_before_tracking": None,  # shown as its own block below
    "agy_session_open": "agy की कोई session खुली है, इसलिए बाकी accounts का पुराना data दिखाया",
    "agy_app_open": "Antigravity app खुली है, इसलिए बाकी accounts का पुराना data दिखाया (app बंद करके फिर देखो)",
    "agy_no_token_log": "(agy tokens का local हिसाब नहीं रखता, सिर्फ quota दिखता है)",
}


def cmd_usage(only=None, days=7, fresh=False):
    print(paint("\n  Usage", "b", "c") + paint("  ·  limits अभी के, tokens पिछले %d दिन के" % days, "d"))
    if sys.stdout.isatty():
        print(paint("  data आ रहा है...", "d"), end="\r")
        sys.stdout.flush()
    data = usage_data(only, days, agy="fresh" if fresh else "auto")
    if sys.stdout.isatty():
        print("\033[K", end="")
    for entry in data:
        if not entry["accounts"]:
            continue
        print("\n  " + paint(entry["title"], "b"))
        for a in entry["accounts"]:
            dot = paint("●", "g") if a["active"] else " "
            extra = ""
            if a["cooldownUntil"]:
                extra = paint("  (aiswitch: limit · %s में free)" % fmt_left(a["cooldownUntil"] - time.time()), "y")
            print("   %s %s %s%s" % (dot, paint(a["email"] or a["name"], "b"), paint("[%s]" % a["name"], "d"), extra))
            if a["limits"] and a["limits"].get("plan"):
                print("      " + paint("plan: " + a["limits"]["plan"], "d"))
            print_limits(a["limits"])
            if entry["tool"] != "agy":
                print_tokens(a["tokens"])
        if entry["otherTokens"]:
            label = "account पता नहीं (aiswitch से पहले का)" if entry["tool"] == "claude" else "दूसरे / पुराने accounts"
            print("   " + paint(label, "d"))
            print_tokens(entry["otherTokens"])
        for note in entry["notes"]:
            if NOTE_TEXT.get(note):
                print("   " + paint(NOTE_TEXT[note], "d"))
    print()


# ---------------------------------------------------------------- auto-switch (shell aliases)

ALIAS_START, ALIAS_END = "# >>> aiswitch >>>", "# <<< aiswitch <<<"


def alias_files():
    """Shell startup files that get the aliases. Windows has no pseudo-terminal in the stdlib, so the
    limit message can't be watched there and auto-switch isn't offered."""
    if IS_WINDOWS:
        return []
    home = Path.home()
    files = [f for f in (home / ".zshrc", home / ".bashrc") if f.exists()]
    if not files:
        shell = os.path.basename(os.environ.get("SHELL", ""))
        files = [home / (".bashrc" if shell == "bash" else ".zshrc")]
    return files


def self_command():
    """How a shell should start this script: plain `aiswitch` if that's on PATH and points here."""
    import shlex
    here = os.path.realpath(__file__)
    on_path = shutil.which("aiswitch")
    if on_path and os.path.realpath(on_path) == here:
        return "aiswitch"
    return "%s %s" % (shlex.quote(sys.executable), shlex.quote(here))


def alias_block():
    import shlex
    lines = [ALIAS_START]
    for tool, cfg in tools().items():
        extra = "".join(" " + shlex.quote(a) for a in cfg.get("alias_args", []))
        lines.append("alias %s=%s" % (command_name(cfg), shlex.quote("%s run %s%s" % (self_command(), tool, extra))))
    lines.append(ALIAS_END)
    return "\n".join(lines)


def aliases_installed():
    for f in alias_files():
        try:
            if ALIAS_START in f.read_text(encoding="utf-8"):
                return True
        except OSError:
            pass
    return False


def set_aliases(on):
    """Adds (or removes) the alias block in every shell startup file. Returns the files touched."""
    if IS_WINDOWS:
        die("auto-switch needs macOS or Linux (Windows has no stdlib pseudo-terminal)")
    touched = []
    for f in alias_files():
        try:
            text = f.read_text(encoding="utf-8")
        except OSError:
            text = ""
        if ALIAS_START in text and ALIAS_END in text:
            a, b = text.index(ALIAS_START), text.index(ALIAS_END) + len(ALIAS_END)
            text = text[:a].rstrip("\n") + ("\n" if text[:a].strip() else "") + text[b:].lstrip("\n")
        if on:
            text = text.rstrip("\n") + ("\n\n" if text.strip() else "") + alias_block() + "\n"
        f.write_text(text, encoding="utf-8")
        touched.append(str(f))
    return touched


def autoswitch_info():
    return {"supported": not IS_WINDOWS, "enabled": aliases_installed(),
            "files": [str(f) for f in alias_files()],
            "reason": "On Windows, aiswitch can't watch the terminal for limit messages yet." if IS_WINDOWS else None}


# ---------------------------------------------------------------- interactive menu

COLORS = {"b": "1", "d": "2", "g": "32", "y": "33", "r": "31", "c": "36"}


def paint(text, *styles):
    if not sys.stdout.isatty():
        return text
    return "\033[%sm%s\033[0m" % (";".join(COLORS[x] for x in styles), text)


def ask(prompt, default=""):
    hint = paint(" [%s]" % default, "d") if default else ""
    try:
        answer = input("  %s%s: " % (prompt, hint)).strip()
    except EOFError:
        raise KeyboardInterrupt
    return answer or default


def confirm(prompt):
    return ask(prompt + " (y/n)", "y").lower() in ("y", "yes", "h", "ha", "haan")


def pause():
    ask(paint("Enter दबाओ", "d"))


def pick_tool():
    names = list(tools())
    print()
    for i, t in enumerate(names, 1):
        print("   %d. %s" % (i, tools()[t].get("title", t)))
    choice = ask("कौन सा tool? (नंबर)")
    if choice.isdigit() and 1 <= int(choice) <= len(names):
        return names[int(choice) - 1]
    return choice if choice in names else None


def pick_account(tool):
    names = profile_names(tool)
    if not names:
        print(paint("  %s में कोई account नहीं है" % tool, "y"))
        return None
    print()
    for i, n in enumerate(names, 1):
        print("   %d. %-12s %s" % (i, n, account_label(tool, n)))
    choice = ask("कौन सा account? (नंबर)")
    if choice.isdigit() and 1 <= int(choice) <= len(names):
        return names[int(choice) - 1]
    return choice if choice in names else None


def default_name(tool):
    n = 1
    while "acc%d" % n in profile_names(tool):
        n += 1
    return "acc%d" % n


def ask_new_name(tool, prompt):
    existing = profile_names(tool)
    while True:
        name = ask(prompt, default_name(tool))
        if not valid_name(name):
            print(paint("  नाम में सिर्फ a-z, 0-9, - _ . चलेंगे", "r"))
        elif name in existing:
            print(paint("  '%s' पहले से है" % name, "r"))
        else:
            return name


def dashboard():
    state = load_json(STATE_FILE, {})
    if sys.stdout.isatty():
        sys.stdout.write("\033[2J\033[H")
    print(paint("\n  aiswitch", "b", "c") + paint("  ·  AI accounts", "d"))
    for tool, cfg in tools().items():
        ts = tool_state(state, tool)
        names = profile_names(tool)
        print("\n  " + paint(cfg.get("title", tool), "b") + paint("  %d account" % len(names), "d"))
        if not names:
            print(paint("     अभी कोई account नहीं - [a] से जोड़ो", "d"))
        for n in names:
            left = cooldown_left(tool, state, n)
            dot = paint("●", "g") if n == ts["active"] else " "
            status = paint("limit · %s में free" % fmt_left(left), "y") if left > 0 else paint("ready", "g")
            print("   %s %-10s %-34s %s" % (dot, n, account_label(tool, n) or "-", status))
    setup = paint("✔ on", "g") if aliases_installed() else paint("✘ off - [s] दबाओ", "y")
    print("\n  auto-switch (terminal aliases): " + setup)
    print(paint("  ─────────────────────────────────────────────", "d"))
    print("  [a] नया account जोड़ो (login)    [u] account बदलो")
    print("  [r] limit mark हटाओ             [d] account हटाओ")
    print("  [s] auto-switch on करो           [g] usage देखो")
    print("  [q] बाहर")


def ui_add():
    tool = pick_tool()
    if not tool:
        return
    cfg = tool_cfg(tool)
    state = load_json(STATE_FILE, {})

    # Whatever is logged in now must be saved before we clear it for the new login.
    if tool_state(state, tool)["active"] not in profile_names(tool):
        adopt_live_login(tool)

    while True:
        print()
        name = ask_new_name(tool, "नए account का नाम")
        if cfg.get("login_warning"):
            print(paint("\n  ⚠ " + cfg["login_warning"], "y"))
        print("  • " + cfg.get("login_hint", "login करो, फिर tool से बाहर आओ."))
        print("  • Browser में पुराना account दिखे तो उस site से logout करो, या link Incognito window में खोलो.")
        if not confirm("\n  Login शुरू करें?"):
            return
        print()
        ok, msg = add_account(tool, name)
        print("\n  " + paint(("✔ " if ok else "✘ ") + msg, "g" if ok else "r"))
        if not confirm("एक और %s account जोड़ें?" % cfg.get("title", tool)):
            return


def ui_use():
    tool = pick_tool()
    name = tool and pick_account(tool)
    if name:
        switch_to(tool, name, load_json(STATE_FILE, {}))
        print(paint("  ✔ %s अब '%s' पर है %s" % (tool, name, account_label(tool, name)), "g"))
        if switch_warning(tool):
            print(paint("  ⚠ Antigravity app खुली है - वो अपना login वापस लगा सकती है. App बंद करके फिर खोलो.", "y"))
        pause()


def ui_reset():
    tool = pick_tool()
    if tool:
        state = load_json(STATE_FILE, {})
        clear_rest(state, tool)
        save_state(state)
        print(paint("  ✔ %s के सारे accounts फिर से ready" % tool, "g"))
        pause()


def ui_remove():
    tool = pick_tool()
    name = tool and pick_account(tool)
    if name and confirm("'%s' (%s) हटाना पक्का?" % (name, account_label(tool, name))):
        remove_account(tool, name)
        print(paint("  ✔ हटा दिया", "g"))
        pause()


def ui_setup_shell():
    if IS_WINDOWS:
        print(paint("\n  Windows पर auto-switch अभी नहीं चलता (limit का message पढ़ने के लिए pseudo-terminal चाहिए).", "y"))
        print("  Switch करने के लिए Switchboard app या `aiswitch next <tool>` इस्तेमाल करो.")
        pause()
        return
    files = ", ".join(str(f) for f in alias_files())
    if aliases_installed():
        if confirm("\n  Auto-switch on है (%s). बंद करें?" % files):
            set_aliases(False)
            print(paint("  ✔ बंद कर दिया. नया terminal खोलो.", "g"))
            pause()
        return
    print("\n  %s में ये जुड़ेगा:\n" % files)
    print(paint(alias_block(), "c"))
    if confirm("\n  जोड़ दें?"):
        set_aliases(True)
        print(paint("  ✔ हो गया. नया terminal खोलो, फिर codex/claude/agy नॉर्मल चलाओ.", "g"))
        pause()


def ui_usage():
    cmd_usage(fresh=True)
    pause()


def menu():
    actions = {"a": ui_add, "u": ui_use, "r": ui_reset, "d": ui_remove, "s": ui_setup_shell, "g": ui_usage}
    try:
        state = load_json(STATE_FILE, {})
        for tool in tools():
            if profile_names(tool) and tool_state(state, tool)["active"] not in profile_names(tool):
                adopt_live_login(tool)
        cmd_usage()
        pause()
        while True:
            dashboard()
            key = ask("\n  चुनो").lower()
            if key in ("q", "quit", "exit"):
                return 0
            if key in actions:
                try:
                    actions[key]()
                except Failure as e:
                    print(paint("  ✘ " + str(e), "r"))
                    pause()
    except KeyboardInterrupt:
        print()
        return 0


# ---------------------------------------------------------------- entry point

def switch_warning(tool):
    if tool == "agy" and agy_hub_running():
        return ("The Antigravity app is open and keeps its own copy of the login; it can switch agy back "
                "to its account. Quit and reopen Antigravity so both use the new account.")
    return None


def json_main(args):
    """Machine interface for the Switchboard app: one JSON object on stdout, ASCII only."""
    def reply(ok, payload):
        print(json.dumps({"ok": ok, "data" if ok else "error": payload}, ensure_ascii=True))
        return 0 if ok else 1

    try:
        cmd, rest = (args[0], args[1:]) if args else ("", [])
        if cmd == "status":
            days = int(rest[rest.index("--days") + 1]) if "--days" in rest else 7
            agy = rest[rest.index("--agy") + 1] if "--agy" in rest else "auto"
            if agy not in AGY_PROBE:
                die("--agy must be cache, auto or fresh")
            data = usage_data(None, days, agy=agy, tokens="--no-tokens" not in rest)
            return reply(True, {"version": 1, "platform": sys.platform, "days": days, "generatedAt": time.time(),
                                "autoSwitch": autoswitch_info(), "tools": data})
        if cmd in ("use", "remove") and len(rest) == 2:
            tool, name = rest
            tool_cfg(tool)
            if name not in profile_names(tool):
                die("no saved account '%s' for %s" % (name, tool))
            warning = None
            if cmd == "use":
                switch_to(tool, name, load_json(STATE_FILE, {}))
                warning = switch_warning(tool)
            else:
                remove_account(tool, name)
            return reply(True, {"tool": tool, "name": name, "warning": warning})
        if cmd == "next" and len(rest) == 1:
            tool_cfg(rest[0])
            name = next_account(rest[0], load_json(STATE_FILE, {}))
            if not name:
                die("no other %s account is ready" % rest[0])
            return reply(True, {"tool": rest[0], "name": name})
        if cmd == "reset" and rest:
            tool_cfg(rest[0])
            state = load_json(STATE_FILE, {})
            clear_rest(state, rest[0], rest[1] if len(rest) > 1 else None)
            save_state(state)
            return reply(True, {"tool": rest[0]})
        if cmd == "autoswitch" and rest and rest[0] in ("on", "off"):
            set_aliases(rest[0] == "on")
            return reply(True, autoswitch_info())
        die("unknown json command: %s" % " ".join(args))
    except Failure as e:
        return reply(False, str(e))
    except Exception as e:
        # Always answer with a JSON line, so the app shows what went wrong instead of "did not answer".
        return reply(False, "%s: %s" % (type(e).__name__, e))


def main():
    try:
        return dispatch(sys.argv[1:])
    except Failure as e:
        print("aiswitch: %s" % e, file=sys.stderr)
        return 1


def dispatch(a):
    if not a or a[0] == "ui":
        return menu()
    if a[0] == "json":
        return json_main(a[1:])
    if a[0] in ("-h", "--help", "help"):
        print(__doc__.strip())
        return 0
    cmd, rest = a[0], a[1:]
    if cmd == "run" and rest:
        return cmd_run(rest[0], rest[1:])
    if cmd == "list":
        cmd_list(rest[0] if rest else None)
        return 0
    if cmd == "usage":
        days = 7
        if "--days" in rest:
            i = rest.index("--days")
            days = int(rest[i + 1]) if i + 1 < len(rest) and rest[i + 1].isdigit() else 7
            rest = rest[:i] + rest[i + 2:]
        fresh = "--fresh" in rest
        rest = [r for r in rest if r != "--fresh"]
        if rest:
            tool_cfg(rest[0])
        cmd_usage(rest[0] if rest else None, days, fresh)
        return 0
    if cmd in ("save", "add", "use", "remove") and len(rest) == 2:
        tool, name = rest
        tool_cfg(tool)
        if cmd in ("save", "add"):
            if not valid_name(name):
                die("name may only contain a-z, 0-9, - _ .")
            ok, msg = (save_current if cmd == "save" else add_account)(tool, name)
            if not ok:
                die(msg)
            print(msg)
        elif cmd == "use":
            switch_to(tool, name, load_json(STATE_FILE, {}))
            print("%s -> %s %s" % (tool, name, account_label(tool, name)))
            if switch_warning(tool):
                print("warning: " + switch_warning(tool), file=sys.stderr)
        else:
            remove_account(tool, name)
        return 0
    if cmd == "next" and len(rest) == 1:
        state = load_json(STATE_FILE, {})
        name = next_account(rest[0], state)
        if not name:
            die("no other %s account is ready" % rest[0])
        print("%s -> %s %s" % (rest[0], name, account_label(rest[0], name)))
        return 0
    if cmd == "reset" and rest:
        state = load_json(STATE_FILE, {})
        clear_rest(state, rest[0], rest[1] if len(rest) > 1 else None)
        save_state(state)
        return 0
    print(__doc__.strip(), file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
