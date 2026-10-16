import assert from "node:assert/strict";
import { spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  AiswitchClient,
  AiswitchError,
  findOnPath,
  pythonCandidates,
  requireAccountName,
  requireTool,
  scriptCandidates,
  terminalLaunch,
} from "../src/main/aiswitch";
import type { AiswitchStatus } from "../src/shared/aiswitch";

const SCRIPT = resolve(__dirname, "..", "tools", "aiswitch", "aiswitch.py");

type Call = { command: string; args: string[] };

/** A spawn stand-in: `reply` decides each process's stdout/stderr/exit code. */
function fakeSpawn(reply: (call: Call) => { stdout?: string; stderr?: string; code?: number; delayMs?: number }) {
  const calls: Call[] = [];
  const spawn = (command: string, args: string[]) => {
    const call = { command, args };
    calls.push(call);
    const child = new EventEmitter() as ChildProcess;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.assign(child, { stdout, stderr, kill: () => true });
    const result = reply(call);
    setTimeout(() => {
      stdout.end(result.stdout ?? "");
      stderr.end(result.stderr ?? "");
      setImmediate(() => child.emit("close", result.code ?? 0));
    }, result.delayMs ?? 0);
    return child;
  };
  return { spawn, calls };
}

const python3Only = (call: Call) => call.command === "python3" && call.args[0] === "--version"
  ? { stdout: "Python 3.11.4\n" }
  : call.args.includes("--version") ? { code: 1 } : null;

test("tool and account names are validated like aiswitch.py does", () => {
  assert.equal(requireTool("codex"), "codex");
  assert.throws(() => requireTool("claude_code"), AiswitchError);
  assert.equal(requireAccountName(" work.2 "), "work.2");
  for (const bad of ["", "-x", "a b", "x".repeat(32), "../etc", 7]) assert.throws(() => requireAccountName(bad), AiswitchError);
});

test("the script is looked up outside the asar archive when packaged", () => {
  const candidates = scriptCandidates("/Apps/Switchboard/resources/app.asar/dist/main", "/Apps/Switchboard/resources");
  assert.equal(candidates[0], resolve("/Apps/Switchboard/resources/app.asar.unpacked/tools/aiswitch/aiswitch.py"));
  assert.ok(candidates.includes(join("/Apps/Switchboard/resources", "app.asar.unpacked", "tools", "aiswitch", "aiswitch.py")));
  assert.equal(scriptCandidates("/repo/dist/main")[0], resolve("/repo/tools/aiswitch/aiswitch.py"));
});

test("python launchers follow the platform, with AISWITCH_PYTHON first", () => {
  assert.deepEqual(pythonCandidates("win32", {}).map((c) => [c.command, ...c.args].join(" ")), ["py -3", "python", "python3"]);
  assert.deepEqual(pythonCandidates("darwin", {}).map((c) => c.command), ["python3", "python"]);
  assert.equal(pythonCandidates("linux", { AISWITCH_PYTHON: "/opt/py/bin/python3" })[0].command, "/opt/py/bin/python3");
});

test("sign-in terminals are opened the native way on each platform", () => {
  const win = terminalLaunch("win32", "C:\\Program Files\\Python\\python.exe", ["C:\\app\\aiswitch.py", "add", "codex", "work"]);
  assert.equal(win.command, "cmd.exe");
  // cmd /s strips only the outer pair of quotes, so a line starting with a quoted path survives.
  assert.deepEqual(win.args.slice(-4), ["/d", "/s", "/k", '""C:\\Program Files\\Python\\python.exe" C:\\app\\aiswitch.py add codex work"']);
  assert.equal(win.options.windowsVerbatimArguments, true);

  const mac = terminalLaunch("darwin", "/usr/bin/python3", ["/Apps/My App/aiswitch.py", "add", "claude", "work"]);
  assert.equal(mac.command, "osascript");
  assert.match(mac.args[1], /do script "\/usr\/bin\/python3 '\/Apps\/My App\/aiswitch.py' add claude work"/);

  assert.deepEqual(terminalLaunch("linux", "python3", ["a.py"], "/usr/bin/gnome-terminal").args.slice(0, 3), ["--", "sh", "-c"]);
  assert.equal(terminalLaunch("linux", "python3", ["a.py"], "/usr/bin/xfce4-terminal").args[0], "-x");
  assert.equal(terminalLaunch("linux", "python3", ["a.py"], "/usr/bin/xterm").args[0], "-e");
  assert.throws(() => terminalLaunch("linux", "python3", ["a.py"], null), /No terminal app was found/);
});

test("findOnPath returns the first match in PATH order", () => {
  const present = new Set([join("/b", "xterm"), join("/a", "konsole")]);
  assert.equal(findOnPath(["gnome-terminal", "konsole", "xterm"], ["/a", "/b"].join(delimiter), (f) => present.has(f)), join("/a", "konsole"));
  assert.equal(findOnPath(["kitty"], "/a", () => false), null);
});

test("the client finds python, calls the JSON interface, and returns its data", async () => {
  const { spawn, calls } = fakeSpawn((call) => python3Only(call) ?? { stdout: 'some log line\n{"ok": true, "data": {"tool": "codex", "name": "work"}}\n' });
  const client = new AiswitchClient({ script: "/x/aiswitch.py", platform: "linux", env: {}, spawn });
  assert.deepEqual(await client.use("codex", "work"), { tool: "codex", name: "work" });
  assert.deepEqual(calls.at(-1), { command: "python3", args: ["/x/aiswitch.py", "json", "use", "codex", "work"] });
  await client.status("background");
  assert.deepEqual(calls.at(-1)!.args.slice(1), ["json", "status", "--days", "7", "--agy", "cache", "--no-tokens"]);
  // python was resolved once and reused
  assert.equal(calls.filter((call) => call.args.includes("--version")).length, 1);
});

test("script errors, bad output and missing python become AiswitchErrors", async () => {
  const failing = fakeSpawn((call) => python3Only(call) ?? { stdout: '{"ok": false, "error": "no saved account \'x\' for codex"}', code: 1 });
  await assert.rejects(new AiswitchClient({ script: "s", platform: "darwin", env: {}, spawn: failing.spawn }).use("codex", "x"),
    (error: AiswitchError) => error.code === "FAILED" && /no saved account/.test(error.message));

  const garbage = fakeSpawn((call) => python3Only(call) ?? { stdout: "Traceback ...", stderr: "SyntaxError: boom" });
  await assert.rejects(new AiswitchClient({ script: "s", platform: "darwin", env: {}, spawn: garbage.spawn }).status("initial"),
    (error: AiswitchError) => error.code === "BAD_OUTPUT" && /SyntaxError: boom/.test(error.message));

  const none = fakeSpawn(() => ({ code: 127 }));
  await assert.rejects(new AiswitchClient({ script: "s", platform: "win32", env: {}, spawn: none.spawn }).status("initial"),
    (error: AiswitchError) => error.code === "PYTHON_MISSING");
  assert.deepEqual(none.calls.map((c) => c.command), ["py", "python", "python3"]);
});

test("calls never overlap, so two live-login swaps can't interleave", async () => {
  let running = 0;
  let maxRunning = 0;
  const { spawn } = fakeSpawn((call) => {
    if (call.args.includes("--version")) return { stdout: "Python 3.12.0" };
    running++;
    maxRunning = Math.max(maxRunning, running);
    setTimeout(() => { running--; }, 20);
    return { stdout: '{"ok": true, "data": null}', delayMs: 25 };
  });
  const client = new AiswitchClient({ script: "s", platform: "darwin", env: {}, spawn });
  await Promise.all([client.status("refresh"), client.use("agy", "a"), client.resetLimit("agy"), client.setAutoSwitch(true)]);
  assert.equal(maxRunning, 1);
});

const python = ["python3", "python"].find((cmd) => spawnSync(cmd, ["--version"]).status === 0);

test("aiswitch.py answers the JSON interface (real script, empty temporary home)", { skip: !python && "python 3 not installed" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "aiswitch-home-"));
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, AISWITCH_HOME: join(home, ".aiswitch"), SHELL: "/bin/zsh", PATH: process.env.PATH };
    const client = new AiswitchClient({ script: SCRIPT, env });
    const status = await client.status("background") as AiswitchStatus;
    assert.equal(status.version, 1);
    assert.deepEqual(status.tools.map((tool) => tool.tool), ["codex", "claude", "agy"]);
    assert.ok(status.tools.every((tool) => tool.accounts.length === 0 && tool.active === null));
    await assert.rejects(client.use("codex", "nobody"), /no saved account 'nobody'/);

    if (process.platform !== "win32") {
      await client.setAutoSwitch(true);
      const rc = await readFile(join(home, ".zshrc"), "utf8");
      assert.match(rc, /# >>> aiswitch >>>[\s\S]*alias codex=[\s\S]*run codex[\s\S]*# <<< aiswitch <<</);
      assert.equal((await client.status("background")).autoSwitch.enabled, true);
      await client.setAutoSwitch(false);
      assert.doesNotMatch(await readFile(join(home, ".zshrc"), "utf8"), /aiswitch/);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
