import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { afterEach, test } from "node:test";
import { claudeProcessEnv } from "../src/main/claude-binary";
import {
  ClaudeSubscriptionManager,
  type ClaudeCommandRequest,
  type ClaudeCommandResult,
} from "../src/main/claude-login";

const temporaryDirectories: string[] = [];

async function fixture(
  status: "connected" | "needs_sign_in",
  runner: (request: ClaudeCommandRequest) => Promise<ClaudeCommandResult>,
): Promise<{ manager: ClaudeSubscriptionManager; id: string; dataDir: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), "switchboard-claude-login-test-"));
  temporaryDirectories.push(dataDir);
  const id = randomUUID();
  await writeFile(join(dataDir, "claude-subscriptions.v1.json"), JSON.stringify({
    version: 1,
    accounts: [{ id, label: "Claude One", status, createdAt: new Date().toISOString() }],
  }));
  const manager = new ClaudeSubscriptionManager({ userDataPath: dataDir, commandRunner: runner });
  await manager.initialize();
  return { manager, id, dataDir };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function cliStatus(loggedIn: boolean): ClaudeCommandResult {
  return {
    exitCode: loggedIn ? 0 : 1,
    stdout: JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none" }),
    timedOut: false,
  };
}

const commandSuccess: ClaudeCommandResult = { exitCode: 0, stdout: "", timedOut: false };

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    const target = resolve(directory);
    const inside = relative(resolve(tmpdir()), target);
    assert.ok(inside && !inside.startsWith("..") && !inside.includes("..\\"));
    assert.ok(basename(target).startsWith("switchboard-claude-login-test-"));
    await rm(target, { recursive: true, force: true });
  }
});

test("a status check started before an auth failure cannot restore the account", async () => {
  const statusStarted = deferred<void>();
  const statusResult = deferred<ClaudeCommandResult>();
  const { manager, id } = await fixture("connected", async (request) => {
    assert.deepEqual(request.args, ["auth", "status", "--json"]);
    statusStarted.resolve();
    return statusResult.promise;
  });

  const pending = manager.refreshAccountStatus(id);
  await statusStarted.promise;
  await manager.markNeedsSignIn(id);
  statusResult.resolve(cliStatus(true));
  await pending;
  assert.equal(manager.listAccounts()[0].status, "needs_sign_in");

  await manager.refreshAccountStatus(id);
  assert.equal(manager.listAccounts()[0].status, "needs_sign_in", "CLI metadata alone must not undo a chat authentication failure");
});

test("a stale background logout result cannot overwrite a completed reconnect", async () => {
  const firstStatusStarted = deferred<void>();
  const firstStatusResult = deferred<ClaudeCommandResult>();
  let statusCalls = 0;
  const { manager, id } = await fixture("connected", async (request) => {
    if (request.args[1] === "login") return commandSuccess;
    if (request.args[1] === "status") {
      statusCalls += 1;
      if (statusCalls === 1) {
        firstStatusStarted.resolve();
        return firstStatusResult.promise;
      }
      return cliStatus(true);
    }
    throw new Error(`Unexpected command: ${request.args.join(" ")}`);
  });

  const oldRefresh = manager.refreshAllStatuses();
  await firstStatusStarted.promise;
  await manager.reconnectAccount(id);
  firstStatusResult.resolve(cliStatus(false));
  assert.deepEqual(await oldRefresh, [], "the stale refresh must not report a status change");
  assert.equal(manager.listAccounts()[0].status, "connected");
});

test("a background status result cannot race with sign-out", async () => {
  const statusStarted = deferred<void>();
  const statusResult = deferred<ClaudeCommandResult>();
  const { manager, id, dataDir } = await fixture("connected", async (request) => {
    if (request.args[1] === "logout") return commandSuccess;
    statusStarted.resolve();
    return statusResult.promise;
  });

  const oldRefresh = manager.refreshAllStatuses();
  await statusStarted.promise;
  const signOut = manager.signOutAccount(id);
  statusResult.resolve(cliStatus(false));
  await signOut;
  assert.deepEqual(await oldRefresh, []);
  assert.equal(manager.listAccounts()[0].status, "needs_sign_in");
  const saved = JSON.parse(await readFile(join(dataDir, "claude-subscriptions.v1.json"), "utf8"));
  assert.equal(saved.accounts[0].status, "needs_sign_in");
});

test("removal waits for an in-flight status process before deleting its profile", async () => {
  const statusStarted = deferred<void>();
  const statusResult = deferred<ClaudeCommandResult>();
  const { manager, id } = await fixture("connected", async (request) => {
    if (request.args[1] === "status") {
      statusStarted.resolve();
      return statusResult.promise;
    }
    if (request.args[1] === "logout") return commandSuccess;
    throw new Error(`Unexpected command: ${request.args.join(" ")}`);
  });
  const profileDir = manager.getConfigDir(id);
  const oldRefresh = manager.refreshAllStatuses();
  await statusStarted.promise;
  const removal = manager.removeAccount(id);
  statusResult.resolve(cliStatus(true));
  await removal;
  assert.deepEqual(await oldRefresh, []);
  assert.deepEqual(manager.listAccounts(), []);
  await assert.rejects(access(profileDir), { code: "ENOENT" });
});

for (const operation of ["signOutAccount", "removeAccount"] as const) {
  test(`a reconnect that completes after ${operation} cannot restore the account`, async () => {
    const loginStarted = deferred<void>();
    const loginResult = deferred<ClaudeCommandResult>();
    const { manager, id } = await fixture("needs_sign_in", async (request) => {
      if (request.args[1] === "login") {
        loginStarted.resolve();
        return loginResult.promise;
      }
      if (request.args[1] === "status") return cliStatus(true);
      if (request.args[1] === "logout") return commandSuccess;
      throw new Error(`Unexpected command: ${request.args.join(" ")}`);
    });

    const reconnect = manager.reconnectAccount(id);
    await loginStarted.promise;
    const disconnect = manager[operation](id);
    loginResult.resolve(commandSuccess);
    await assert.rejects(reconnect, { code: "AUTH_CANCELLED" });
    await disconnect;
    if (operation === "removeAccount") assert.deepEqual(manager.listAccounts(), []);
    else assert.equal(manager.listAccounts()[0].status, "needs_sign_in");
  });
}

test("Claude child environment removes inherited OAuth refresh credentials regardless of casing", () => {
  const names = [
    "claude_code_oauth_token",
    "claude_code_oauth_refresh_token",
    "claude_code_oauth_scopes",
    "anthropic_api_key",
    "claude_config_dir",
  ];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = "inherited-secret";
    const environment = claudeProcessEnv("C:\\Switchboard\\isolated-account");
    for (const name of names.slice(0, -1)) {
      assert.equal(Object.keys(environment).some((key) => key.toLowerCase() === name), false, `${name} was inherited`);
    }
    assert.equal(environment.CLAUDE_CONFIG_DIR, "C:\\Switchboard\\isolated-account");
    assert.deepEqual(Object.keys(environment).filter((key) => key.toLowerCase() === "claude_config_dir"), ["CLAUDE_CONFIG_DIR"]);
  } finally {
    for (const name of names) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
