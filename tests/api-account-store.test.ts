import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ApiAccountStore, ApiAccountStoreError } from "../src/main/api-account-store";
import type { CredentialProtector } from "../src/main/account-store";

const protector: CredentialProtector = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(`protected:${Buffer.from(value).toString("base64")}`),
  decrypt: (value) => {
    const encoded = value.toString();
    if (!encoded.startsWith("protected:")) throw new Error("Wrong key");
    return Buffer.from(encoded.slice("protected:".length), "base64").toString();
  },
};

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "switchboard-api-store-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("stores provider keys in a separate encrypted vault and never exposes them in summaries", async () => {
  await withDirectory(async (directory) => {
    const store = new ApiAccountStore({ userDataPath: directory, protector });
    await store.initialize();
    const claude = await store.addAccount({
      provider: "claude_api", label: "Work Claude", apiKey: "sk-ant-api-work-secret", workspaceId: "wrkspc_123",
    });
    const antigravity = await store.addAccount({
      provider: "antigravity_api", label: "Personal", apiKey: "AIza-personal-secret",
    });
    assert.equal(claude.email, null);
    assert.equal(claude.workspaceId, "wrkspc_123");
    assert.equal(antigravity.workspaceId, null);
    assert.equal("apiKey" in claude, false);
    assert.equal(JSON.stringify(store.listAccounts()).includes("secret"), false);
    assert.deepEqual(store.getCredential(claude.id), {
      provider: "claude_api", apiKey: "sk-ant-api-work-secret", workspaceId: "wrkspc_123",
    });
    assert.deepEqual(store.getCredential(antigravity.id), {
      provider: "antigravity_api", apiKey: "AIza-personal-secret",
    });
    const raw = await readFile(path.join(directory, "provider-accounts.v1.bin"), "utf8");
    assert.equal(raw.includes("sk-ant-api-work-secret"), false);
    assert.equal(raw.includes("AIza-personal-secret"), false);
    assert.equal(raw.includes("Work Claude"), false);
    await store.setSelectedAccountId("chatgpt-account-from-separate-vault");

    const reloaded = new ApiAccountStore({ userDataPath: directory, protector });
    await reloaded.initialize();
    assert.equal(reloaded.getSelectedAccountId(), "chatgpt-account-from-separate-vault");
    assert.deepEqual(reloaded.listAccounts(), store.listAccounts());
    assert.equal(reloaded.getCredential(claude.id).apiKey, "sk-ant-api-work-secret");
  });
});

test("validates providers, labels, credentials, and keeps labels unique within each provider", async () => {
  await withDirectory(async (directory) => {
    const store = new ApiAccountStore({ userDataPath: directory, protector });
    await store.initialize();
    const first = await store.addAccount({ provider: "claude_api", label: "Work", apiKey: "key-one" });
    await assert.rejects(store.addAccount({ provider: "claude_api", label: "  ｗＯＲＫ  ", apiKey: "key-two" }),
      (error: unknown) => error instanceof ApiAccountStoreError && error.code === "LABEL_TAKEN");
    const otherProvider = await store.addAccount({ provider: "antigravity_api", label: "Work", apiKey: "key-three" });
    assert.notEqual(first.id, otherProvider.id);
    await assert.rejects(store.addAccount({ provider: "other" as never, label: "Bad", apiKey: "key" }),
      (error: unknown) => error instanceof ApiAccountStoreError && error.code === "INVALID_PROVIDER");
    await assert.rejects(store.addAccount({ provider: "claude_api", label: "\n", apiKey: "key" }),
      (error: unknown) => error instanceof ApiAccountStoreError && error.code === "INVALID_LABEL");
    await assert.rejects(store.addAccount({ provider: "claude_api", label: "Another", apiKey: "with space" }),
      (error: unknown) => error instanceof ApiAccountStoreError && error.code === "INVALID_KEY");
    await assert.rejects(store.addAccount({ provider: "antigravity_api", label: "Another", apiKey: "key", workspaceId: "wrkspc_1" }),
      (error: unknown) => error instanceof ApiAccountStoreError && error.code === "INVALID_WORKSPACE");
    assert.equal((await store.renameAccount(first.id, "Research")).label, "Research");
    assert.equal(store.listAccounts().length, 2);
  });
});

test("serializes concurrent changes, replaces an invalid key, and removes only the selected account", async () => {
  await withDirectory(async (directory) => {
    const store = new ApiAccountStore({ userDataPath: directory, protector });
    await store.initialize();
    const [first, second] = await Promise.all([
      store.addAccount({ provider: "claude_api", label: "First", apiKey: "key-first" }),
      store.addAccount({ provider: "claude_api", label: "Second", apiKey: "key-second" }),
    ]);
    assert.equal(store.listAccounts().length, 2);
    await store.markInvalid(first.id);
    assert.equal(store.listAccounts().find((row) => row.id === first.id)?.status, "invalid");
    const replaced = await store.replaceKey(first.id, "key-replaced");
    assert.equal(replaced.status, "ready");
    assert.equal("apiKey" in replaced, false);
    assert.equal(store.getCredential(first.id).apiKey, "key-replaced");
    await store.setSelectedAccountId(second.id);
    await store.removeAccount(second.id);
    assert.equal(store.getSelectedAccountId(), null);
    assert.deepEqual(store.listAccounts().map((row) => row.id), [first.id]);
    assert.equal(store.getCredential(first.id).apiKey, "key-replaced");

    const reloaded = new ApiAccountStore({ userDataPath: directory, protector });
    await reloaded.initialize();
    assert.deepEqual(reloaded.listAccounts(), store.listAccounts());
  });
});

test("fails closed on unavailable encryption or corrupt saved data", async () => {
  await withDirectory(async (directory) => {
    const unavailable = new ApiAccountStore({ userDataPath: directory, protector: { ...protector, isAvailable: () => false } });
    await assert.rejects(unavailable.initialize(),
      (error: unknown) => error instanceof ApiAccountStoreError && error.code === "STORAGE_UNAVAILABLE");
    const store = new ApiAccountStore({ userDataPath: directory, protector });
    await store.initialize();
    const file = path.join(directory, "provider-accounts.v1.bin");
    await writeFile(file, Buffer.from("not encrypted data"));
    const corrupt = new ApiAccountStore({ userDataPath: directory, protector });
    await assert.rejects(corrupt.initialize(),
      (error: unknown) => error instanceof ApiAccountStoreError && error.code === "STORAGE_CORRUPT");
    assert.equal((await readFile(file, "utf8")), "not encrypted data");
  });
});
