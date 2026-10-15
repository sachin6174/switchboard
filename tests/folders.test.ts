import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FULL_PERMISSION_ARGS, terminalLaunch } from "../src/main/aiswitch";
import { FolderError, FolderStore } from "../src/main/folders";

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folders-")));
  const data = join(root, "userData");
  const project = join(root, "my project");
  mkdirSync(project);
  return { root, data, project };
}

test("added folders are remembered across restarts and not duplicated", () => {
  const { root, data, project } = setup();
  try {
    const first = new FolderStore(data).add(project);
    assert.equal(first.name, "my project");
    assert.equal(first.missing, false);
    assert.equal(first.lastOpenedAt, null);
    // A new store (as after reopening the app) sees the same folder; adding it again is a no-op.
    const reopened = new FolderStore(data);
    assert.equal(reopened.add(join(project, ".")).id, first.id);
    assert.deepEqual(reopened.list().map((folder) => folder.path), [project]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("only existing folders can be added; moved folders show as missing and can't be opened", () => {
  const { root, data, project } = setup();
  try {
    const store = new FolderStore(data);
    assert.throws(() => store.add(join(root, "nope")), FolderError);
    assert.throws(() => store.add("relative/path"), FolderError);
    const folder = store.add(project);
    assert.ok(store.open(folder.id).lastOpenedAt);
    rmSync(project, { recursive: true });
    assert.equal(store.list()[0].missing, true);
    assert.throws(() => store.open(folder.id), /doesn't exist any more/);
    store.remove(folder.id);
    assert.deepEqual(store.list(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("folder terminals start in the folder on each platform", () => {
  const mac = terminalLaunch("darwin", "/usr/bin/python3", ["/a/aiswitch.py", "run", "codex"], null, "/Users/me/my project", "Codex · my project");
  assert.match(mac.args[1], /do script "cd '\/Users\/me\/my project' && \/usr\/bin\/python3 \/a\/aiswitch.py run codex"/);

  const win = terminalLaunch("win32", "py", ["-3", "C:\\a\\aiswitch.py", "run", "claude"], null, "C:\\code\\my project", "Claude Code · my project");
  assert.deepEqual(win.args.slice(0, 5), ["/c", "start", '"Claude Code · my project"', "/D", '"C:\\code\\my project"']);
  assert.equal(win.options.cwd, "C:\\code\\my project");

  const linux = terminalLaunch("linux", "python3", ["a.py", "run", "agy"], "/usr/bin/konsole", "/home/me/p");
  assert.match(linux.args.at(-1)!, /^cd \/home\/me\/p && python3 a.py run agy;/);
  assert.equal(linux.options.cwd, "/home/me/p");
});

test("each CLI gets its own full-permission flag", () => {
  assert.deepEqual(FULL_PERMISSION_ARGS, {
    claude: ["--dangerously-skip-permissions"],
    codex: ["--dangerously-bypass-approvals-and-sandbox"],
    agy: ["--dangerously-skip-permissions"],
  });
});
