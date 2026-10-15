import assert from "node:assert/strict";
import { test } from "node:test";
import { ptySpawnSpec, TerminalError, TerminalManager, type TerminalMeta } from "../src/main/terminals";

const META: TerminalMeta = { tool: "codex", folderId: "f1", folderName: "shop", cwd: process.cwd(), title: "Codex · shop" };

function fakePty() {
  const calls: { spawn?: { file: string; args: string[]; options: any }; writes: string[]; resizes: Array<[number, number]>; killed: boolean } = { writes: [], resizes: [], killed: false };
  let onData: (data: string) => void = () => undefined;
  let onExit: (event: { exitCode: number }) => void = () => undefined;
  const module = {
    spawn: (file: string, args: string[], options: any) => {
      calls.spawn = { file, args, options };
      return {
        onData: (cb: typeof onData) => { onData = cb; return { dispose() {} }; },
        onExit: (cb: typeof onExit) => { onExit = cb; return { dispose() {} }; },
        write: (data: string) => calls.writes.push(data),
        resize: (cols: number, rows: number) => calls.resizes.push([cols, rows]),
        kill: () => { calls.killed = true; },
      } as any;
    },
  };
  return { module, calls, emit: (data: string) => onData(data), exit: (code: number) => onExit({ exitCode: code }) };
}

test("on macOS and Linux the CLI runs inside the user's login shell, so their PATH applies", () => {
  const mac = ptySpawnSpec("darwin", { command: "/usr/bin/python3", args: ["/My App/aiswitch.py", "run", "claude", "--dangerously-skip-permissions"] }, "/bin/zsh");
  assert.deepEqual(mac, { file: "/bin/zsh", args: ["-l", "-i", "-c", "exec /usr/bin/python3 '/My App/aiswitch.py' run claude --dangerously-skip-permissions"] });
  assert.equal(ptySpawnSpec("linux", { command: "python3", args: [] }, undefined).file, "/bin/bash");
  assert.deepEqual(ptySpawnSpec("win32", { command: "py", args: ["-3", "a.py"] }, undefined), { file: "py", args: ["-3", "a.py"] });
});

test("output is batched into numbered chunks, kept for redraw, and input reaches the program", async () => {
  const pty = fakePty();
  const events: Array<{ id: string; seq: number; data: string }> = [];
  const exits: Array<{ id: string; code: number | null }> = [];
  const manager = new TerminalManager(
    { data: (id, seq, data) => events.push({ id, seq, data }), exit: (id, code) => exits.push({ id, code }) },
    { platform: "darwin", env: { SHELL: "/bin/zsh", ELECTRON_RUN_AS_NODE: "1", PATH: "/usr/bin" }, loadPty: async () => pty.module },
  );
  const info = await manager.start({ command: "codex", args: [] }, META, { cols: 120, rows: 40 });
  assert.equal(pty.calls.spawn!.options.cwd, META.cwd);
  assert.equal(pty.calls.spawn!.options.cols, 120);
  assert.equal(pty.calls.spawn!.options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(pty.calls.spawn!.options.env.TERM, "xterm-256color");

  pty.emit("hel");
  pty.emit("lo");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(events, [{ id: info.id, seq: 1, data: "hello" }]);
  pty.emit(" world");
  assert.deepEqual(manager.buffer(info.id), { data: "hello world", seq: 2 });

  manager.write(info.id, "ls\r");
  manager.resize(info.id, 90.7, 20.2);
  assert.deepEqual(pty.calls.writes, ["ls\r"]);
  assert.deepEqual(pty.calls.resizes, [[90, 20]]);

  pty.exit(3);
  assert.deepEqual(exits, [{ id: info.id, code: 3 }]);
  assert.equal(manager.list()[0].running, false);
  manager.write(info.id, "ignored");
  assert.deepEqual(pty.calls.writes, ["ls\r"]);

  assert.equal(manager.close(info.id)?.id, info.id);
  assert.throws(() => manager.write(info.id, "x"), TerminalError);
  assert.deepEqual(manager.list(), []);
});

test("closing a running terminal stops its program", async () => {
  const pty = fakePty();
  const manager = new TerminalManager({ data: () => undefined, exit: () => undefined }, { platform: "linux", env: {}, loadPty: async () => pty.module });
  const info = await manager.start({ command: "agy", args: [] }, { ...META, tool: "agy" });
  manager.closeAll();
  assert.equal(pty.calls.killed, true);
  assert.equal(manager.close(info.id), null);
});

test("a missing pty module is reported as unavailable", async () => {
  const manager = new TerminalManager({ data: () => undefined, exit: () => undefined }, { loadPty: async () => { throw new Error("no binary"); } });
  await assert.rejects(manager.start({ command: "x", args: [] }, META), (error: TerminalError) => error.code === "PTY_UNAVAILABLE");
});

test("a real pseudo-terminal runs a command in the login shell", { skip: process.platform === "win32" && "POSIX shell test" }, async () => {
  let output = "";
  let exited: number | null | undefined;
  const manager = new TerminalManager({ data: (_id, _seq, data) => { output += data; }, exit: (_id, code) => { exited = code; } });
  await manager.start({ command: "/bin/echo", args: ["hello from pty"] }, META);
  for (let i = 0; i < 100 && exited === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(output, /hello from pty/);
  assert.equal(exited, 0);
});
