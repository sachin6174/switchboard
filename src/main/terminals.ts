import { randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IPty } from "node-pty";
import type { AiswitchToolId } from "../shared/aiswitch";
import type { TerminalInfo } from "../shared/terminals";

/**
 * Terminals shown inside the app. Each runs a command on a pseudo-terminal (node-pty: ConPTY on
 * Windows, a Unix pty elsewhere); output goes to the renderer, which draws it with xterm.js.
 * Recent output is kept so a reloaded view can redraw it.
 */

export type TerminalCommand = { command: string; args: string[] };
export type TerminalMeta = { tool: AiswitchToolId; folderId: string; folderName: string; cwd: string; title: string };
export type TerminalEvents = {
  data: (id: string, seq: number, data: string) => void;
  exit: (id: string, code: number | null) => void;
};
type PtyModule = Pick<typeof import("node-pty"), "spawn">;

export class TerminalError extends Error {
  constructor(public code: "CLOSED" | "PTY_UNAVAILABLE" | "NOT_FOUND" | "START_FAILED", message: string) {
    super(message);
    this.name = "TerminalError";
  }
}

const SCROLLBACK_CHARS = 400_000;
const FLUSH_MS = 16;

function posixQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The full path of a Windows program given by bare name (`py`, `python`), found the way cmd.exe
 * finds it: each PATH folder in order, trying .exe then .com. node-pty's own lookup doesn't add an
 * extension (and skips the last PATH folder), so it never finds `py`.
 */
export function windowsExecutable(command: string, env: NodeJS.ProcessEnv, exists: (file: string) => boolean = existsSync): string {
  if (/[\\/]/.test(command)) return command;
  // Windows environment names are case-insensitive; Node's copy of the environment is not.
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const extensions = path.win32.extname(command) ? [""] : [".exe", ".com"];
  for (const dir of pathValue.split(";").map((entry) => entry.replace(/"/g, "").trim()).filter(Boolean)) {
    for (const extension of extensions) {
      const file = path.win32.join(dir, command + extension);
      if (exists(file)) return file;
    }
  }
  throw new TerminalError("NOT_FOUND", `${command} wasn't found on PATH. Reinstall Python 3 with "Add to PATH" checked, then reopen Switchboard.`);
}

/**
 * How to start `command` on the pty. On macOS and Linux it runs inside the user's login shell, so
 * PATH and other settings from their shell profile apply (an app opened from the Dock or a launcher
 * gets only a minimal PATH, and wouldn't find codex/claude/agy). On Windows the program starts
 * directly, by its full path.
 */
export function ptySpawnSpec(
  platform: NodeJS.Platform,
  run: TerminalCommand,
  shell: string | undefined,
  env: NodeJS.ProcessEnv = {},
  exists?: (file: string) => boolean,
): { file: string; args: string[] } {
  if (platform === "win32") return { file: windowsExecutable(run.command, env, exists), args: run.args };
  const line = [run.command, ...run.args].map(posixQuote).join(" ");
  return { file: shell || (platform === "darwin" ? "/bin/zsh" : "/bin/bash"), args: ["-l", "-i", "-c", `exec ${line}`] };
}

/**
 * node-pty starts programs on macOS/Linux through a small `spawn-helper` binary that must be
 * executable. Its install script sets that, but installs without scripts or copies that drop the
 * mode bit leave it unusable ("posix_spawnp failed"), so the bit is restored here when needed.
 */
function ensureSpawnHelper(): void {
  if (process.platform === "win32") return;
  try {
    const root = path.dirname(require.resolve("node-pty/package.json")).replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
    for (const dir of [path.join(root, "prebuilds", `${process.platform}-${process.arch}`), path.join(root, "build", "Release")]) {
      const helper = path.join(dir, "spawn-helper");
      if (!existsSync(helper)) continue;
      try { accessSync(helper, constants.X_OK); } catch { chmodSync(helper, 0o755); }
    }
  } catch {
    // Best effort: if this fails, starting a terminal reports the problem.
  }
}

/** The build number in a Windows release string such as "10.0.22631". */
export function windowsBuildNumber(release: string): number | undefined {
  return Number(release.split(".")[2]) || undefined;
}

type Session = {
  info: TerminalInfo;
  pty: IPty;
  scrollback: string;
  pending: string;
  timer: NodeJS.Timeout | null;
};

export class TerminalManager {
  private readonly sessions = new Map<string, Session>();
  private ptyModule: Promise<PtyModule> | null = null;

  constructor(
    private readonly events: TerminalEvents,
    private readonly options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; loadPty?: () => Promise<PtyModule> } = {},
  ) {}

  private loadPty(): Promise<PtyModule> {
    this.ptyModule ??= (this.options.loadPty ?? (() => { ensureSpawnHelper(); return import("node-pty"); }))().catch(() => {
      this.ptyModule = null;
      throw new TerminalError("PTY_UNAVAILABLE", "In-app terminals aren't available in this build. Use separate windows instead.");
    });
    return this.ptyModule;
  }

  async start(run: TerminalCommand, meta: TerminalMeta, size = { cols: 100, rows: 30 }): Promise<TerminalInfo> {
    const platform = this.options.platform ?? process.platform;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.options.env ?? process.env)) {
      if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
    }
    env.TERM = "xterm-256color";
    env.COLORTERM = "truecolor";
    const spec = ptySpawnSpec(platform, run, env.SHELL, env);
    const ptyModule = await this.loadPty();
    let pty: IPty;
    try {
      pty = ptyModule.spawn(spec.file, spec.args, {
        name: "xterm-256color",
        cols: Math.max(20, size.cols),
        rows: Math.max(5, size.rows),
        cwd: meta.cwd,
        env,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new TerminalError("START_FAILED", `The terminal couldn't start ${path.basename(spec.file)}: ${detail}`);
    }
    const info: TerminalInfo = { id: randomUUID(), ...meta, startedAt: Date.now(), running: true, exitCode: null, seq: 0 };
    if (platform === "win32") info.windowsBuild = windowsBuildNumber(os.release());
    const session: Session = { info, pty, scrollback: "", pending: "", timer: null };
    this.sessions.set(info.id, session);
    pty.onData((data) => {
      session.pending += data;
      session.timer ??= setTimeout(() => this.flush(session), FLUSH_MS);
    });
    pty.onExit(({ exitCode }) => {
      this.flush(session);
      session.info.running = false;
      session.info.exitCode = exitCode ?? null;
      this.events.exit(info.id, session.info.exitCode);
    });
    return { ...info };
  }

  private flush(session: Session): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    if (!session.pending) return;
    const data = session.pending;
    session.pending = "";
    session.scrollback = (session.scrollback + data).slice(-SCROLLBACK_CHARS);
    session.info.seq += 1;
    this.events.data(session.info.id, session.info.seq, data);
  }

  list(): TerminalInfo[] {
    return [...this.sessions.values()].map((session) => ({ ...session.info }));
  }

  /** Output so far, and the sequence number of the last chunk it includes. */
  buffer(id: string): { data: string; seq: number } {
    const session = this.require(id);
    this.flush(session);
    return { data: session.scrollback, seq: session.info.seq };
  }

  write(id: string, data: string): void {
    const session = this.require(id);
    if (session.info.running) session.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.require(id);
    if (session.info.running && cols > 0 && rows > 0) session.pty.resize(Math.floor(cols), Math.floor(rows));
  }

  /** Stops the program (if running) and forgets the terminal. */
  close(id: string): TerminalInfo | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.info.running) {
      try { session.pty.kill(); } catch { /* already gone */ }
    }
    if (session.timer) clearTimeout(session.timer);
    this.sessions.delete(id);
    return { ...session.info };
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  private require(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new TerminalError("CLOSED", "That terminal is closed.");
    return session;
  }
}
