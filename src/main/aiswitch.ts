import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AiswitchReadMode, AiswitchStatus, AiswitchToolId } from "../shared/aiswitch";

/**
 * Bridge to tools/aiswitch/aiswitch.py. The Python script is the single switching mechanism:
 * it keeps each account's saved login, swaps it in on demand, rotates accounts when a CLI hits
 * its usage limit, and reports usage. Switchboard only calls its JSON interface and shows the result.
 */

export type AiswitchErrorCode = "PYTHON_MISSING" | "SCRIPT_MISSING" | "INVALID_INPUT" | "FAILED" | "TIMEOUT" | "BAD_OUTPUT";

export class AiswitchError extends Error {
  constructor(public code: AiswitchErrorCode, message: string) {
    super(message);
    this.name = "AiswitchError";
  }
}

export type PythonCommand = { command: string; args: string[] };
type Spawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

const TOOLS: readonly AiswitchToolId[] = ["claude", "codex", "agy"];
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,30}$/;

export function requireTool(value: unknown): AiswitchToolId {
  if (typeof value === "string" && (TOOLS as readonly string[]).includes(value)) return value as AiswitchToolId;
  throw new AiswitchError("INVALID_INPUT", "Choose Claude Code, Codex, or Antigravity.");
}

/** Same rule as aiswitch.py's valid_name, so a name the app accepts is one the script accepts. */
export function requireAccountName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!NAME_PATTERN.test(name)) throw new AiswitchError("INVALID_INPUT", "Use 1–31 letters, numbers, dots, dashes or underscores, starting with a letter or number.");
  return name;
}

/** Where the script can be: next to the build output in development, unpacked from the asar archive when packaged. */
export function scriptCandidates(mainDir: string, resourcesPath?: string): string[] {
  const fromBuild = path.resolve(mainDir, "..", "..", "tools", "aiswitch", "aiswitch.py");
  const candidates = [fromBuild.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2"), fromBuild];
  if (resourcesPath) candidates.push(path.join(resourcesPath, "app.asar.unpacked", "tools", "aiswitch", "aiswitch.py"));
  return [...new Set(candidates)];
}

export function findScript(mainDir: string, resourcesPath?: string, exists: (file: string) => boolean = existsSync): string {
  const found = scriptCandidates(mainDir, resourcesPath).find((file) => exists(file));
  if (!found) throw new AiswitchError("SCRIPT_MISSING", "The account switcher (aiswitch.py) is missing from this install. Reinstall Switchboard.");
  return found;
}

/** Python launchers to try, in order. AISWITCH_PYTHON wins when set. */
export function pythonCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): PythonCommand[] {
  const list: PythonCommand[] = [];
  if (env.AISWITCH_PYTHON) list.push({ command: env.AISWITCH_PYTHON, args: [] });
  if (platform === "win32") list.push({ command: "py", args: ["-3"] }, { command: "python", args: [] }, { command: "python3", args: [] });
  else list.push({ command: "python3", args: [] }, { command: "python", args: [] });
  return list;
}

function collect(spawn: Spawn, command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

const READ_ARGS: Record<AiswitchReadMode, string[]> = {
  initial: ["--agy", "auto"],
  background: ["--agy", "cache", "--no-tokens"],
  refresh: ["--agy", "fresh"],
};
/** A fresh agy read signs in to each account in turn (~10 s each), so it gets a long limit. */
const READ_TIMEOUT_MS: Record<AiswitchReadMode, number> = { initial: 240_000, background: 60_000, refresh: 300_000 };
const ACTION_TIMEOUT_MS = 60_000;

export type AiswitchClientOptions = {
  script: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawn?: Spawn;
};

export class AiswitchClient {
  readonly script: string;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawn: Spawn;
  private python: Promise<PythonCommand> | null = null;
  // aiswitch swaps live logins (agy quota checks, switches), so calls never overlap.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: AiswitchClientOptions) {
    this.script = options.script;
    this.platform = options.platform ?? process.platform;
    this.env = { ...(options.env ?? process.env), PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
    this.spawn = options.spawn ?? nodeSpawn;
  }

  /** The first Python 3 launcher that runs. Cached; a failed lookup is retried next time. */
  resolvePython(): Promise<PythonCommand> {
    if (!this.python) {
      this.python = (async () => {
        for (const candidate of pythonCandidates(this.platform, this.env)) {
          try {
            const result = await collect(this.spawn, candidate.command, [...candidate.args, "--version"], this.env, 15_000);
            if (result.code === 0 && /Python 3\./.test(result.stdout + result.stderr)) return candidate;
          } catch {
            // Not installed under this name; try the next one.
          }
        }
        throw new AiswitchError("PYTHON_MISSING", "Python 3 is needed for account switching. Install it from python.org, then reopen Switchboard.");
      })();
      this.python.catch(() => { this.python = null; });
    }
    return this.python;
  }

  status(mode: AiswitchReadMode, days = 7): Promise<AiswitchStatus> {
    return this.call<AiswitchStatus>(["status", "--days", String(days), ...READ_ARGS[mode]], READ_TIMEOUT_MS[mode]);
  }

  /** Resolves with a warning when the switch may not stick (agy while the Antigravity app runs). */
  use(tool: AiswitchToolId, name: string): Promise<{ warning?: string | null }> {
    return this.call(["use", tool, name], ACTION_TIMEOUT_MS);
  }

  remove(tool: AiswitchToolId, name: string): Promise<unknown> {
    return this.call(["remove", tool, name], ACTION_TIMEOUT_MS);
  }

  resetLimit(tool: AiswitchToolId, name?: string): Promise<unknown> {
    return this.call(name ? ["reset", tool, name] : ["reset", tool], ACTION_TIMEOUT_MS);
  }

  setAutoSwitch(on: boolean): Promise<unknown> {
    return this.call(["autoswitch", on ? "on" : "off"], ACTION_TIMEOUT_MS);
  }

  /**
   * The command a terminal runs to start a CLI through aiswitch (`aiswitch run <tool> ...`), so a
   * usage limit switches accounts and resumes. With no saved accounts it simply runs the CLI.
   */
  async runCommand(tool: AiswitchToolId, args: string[]): Promise<PythonCommand> {
    const python = await this.resolvePython();
    return { command: python.command, args: [...python.args, this.script, "run", tool, ...args] };
  }

  /** The command a terminal runs to sign in a new account (`aiswitch add <tool> <name>`). */
  async addAccountCommand(tool: AiswitchToolId, name: string): Promise<PythonCommand> {
    const python = await this.resolvePython();
    return { command: python.command, args: [...python.args, this.script, "add", tool, name] };
  }

  private call<T>(args: string[], timeoutMs: number): Promise<T> {
    const run = this.queue.then(() => this.execute<T>(args, timeoutMs), () => this.execute<T>(args, timeoutMs));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async execute<T>(args: string[], timeoutMs: number): Promise<T> {
    const python = await this.resolvePython();
    let result;
    try {
      result = await collect(this.spawn, python.command, [...python.args, this.script, "json", ...args], this.env, timeoutMs);
    } catch {
      this.python = null;
      throw new AiswitchError("PYTHON_MISSING", "Python could not be started for account switching.");
    }
    if (result.timedOut) throw new AiswitchError("TIMEOUT", "The account switcher took too long to answer. Try again.");
    const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
    let reply: { ok: boolean; data?: T; error?: string };
    try {
      reply = JSON.parse(line);
    } catch {
      const detail = result.stderr.trim().split(/\r?\n/).pop() ?? "";
      throw new AiswitchError("BAD_OUTPUT", `The account switcher did not answer as expected.${detail ? ` ${detail}` : ""}`.slice(0, 400));
    }
    if (!reply.ok) throw new AiswitchError("FAILED", String(reply.error ?? "The account switcher reported an error.").slice(0, 400));
    return reply.data as T;
  }
}

function posixQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function cmdQuote(value: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(value) ? value : `"${value.replace(/"/g, '""')}"`;
}

export type TerminalLaunch = { command: string; args: string[]; options: SpawnOptions };

/** Arguments that continue the CLI's most recent conversation in the current folder. */
export const RESUME_ARGS: Record<AiswitchToolId, string[]> = {
  claude: ["--continue"],
  codex: ["resume", "--last"],
  agy: ["--continue"],
};

/** Flags that start each CLI without approval prompts ("full-permission mode"). */
export const FULL_PERMISSION_ARGS: Record<AiswitchToolId, string[]> = {
  claude: ["--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  agy: ["--dangerously-skip-permissions"],
};

/**
 * How to open a visible terminal running `command args` on this platform. Sign-in needs a real
 * terminal: Codex and Claude open the browser from it, and agy signs in inside its own screen.
 * `linuxTerminal` is the first terminal emulator found on PATH (Linux only).
 */
export function terminalLaunch(platform: NodeJS.Platform, command: string, args: string[], linuxTerminal?: string | null, cwd?: string, title = "Switchboard"): TerminalLaunch {
  const detached: SpawnOptions = { detached: true, stdio: "ignore", ...(cwd ? { cwd } : {}) };
  if (platform === "win32") {
    const line = [command, ...args].map(cmdQuote).join(" ");
    const where = cwd ? ["/D", `"${cwd.replace(/"/g, "")}"`] : [];
    // /s with the whole line in one more pair of quotes: cmd strips exactly that pair, so a line
    // that itself starts with a quoted path ("C:\Program Files\...\python.exe" ...) survives.
    return { command: "cmd.exe", args: ["/c", "start", `"${title.replace(/"/g, "")}"`, ...where, "cmd.exe", "/d", "/s", "/k", `"${line}"`], options: { ...detached, windowsVerbatimArguments: true } };
  }
  const run = [command, ...args].map(posixQuote).join(" ");
  const line = cwd ? `cd ${posixQuote(cwd)} && ${run}` : run;
  if (platform === "darwin") {
    const script = line.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return { command: "osascript", args: ["-e", `tell application "Terminal" to do script "${script}"`, "-e", 'tell application "Terminal" to activate'], options: detached };
  }
  if (!linuxTerminal) throw new AiswitchError("FAILED", `No terminal app was found. Run this in a terminal: ${line}`);
  const shell = ["sh", "-c", `${line}; echo; printf 'Press Enter to close'; read _`];
  const name = path.basename(linuxTerminal);
  const lead = /^(gnome-terminal|kgx|ptyxis)$/.test(name) ? ["--"] : name === "xfce4-terminal" ? ["-x"] : name === "kitty" ? [] : ["-e"];
  return { command: linuxTerminal, args: [...lead, ...shell], options: detached };
}

export const LINUX_TERMINALS = ["x-terminal-emulator", "gnome-terminal", "ptyxis", "kgx", "konsole", "xfce4-terminal", "alacritty", "kitty", "xterm"];

/** First of `names` found as an executable on PATH. */
export function findOnPath(names: string[], envPath: string | undefined, exists: (file: string) => boolean = existsSync): string | null {
  const dirs = (envPath ?? "").split(path.delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      const file = path.join(dir, name);
      if (exists(file)) return file;
    }
  }
  return null;
}
