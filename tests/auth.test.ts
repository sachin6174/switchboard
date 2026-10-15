import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { AccountStore, VaultError, type AccountRecord, type CredentialProtector } from "../src/main/account-store";
import { AuthError, AuthManager } from "../src/main/auth";
import type { AuthAccountEvent } from "../src/shared/contracts";

// Deliberately simple stand-in: production always uses Electron safeStorage / DPAPI.
const testProtector: CredentialProtector = {
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(`test-protected:${Buffer.from(value).toString("base64")}`),
  decrypt: (value) => {
    const text = value.toString();
    if (!text.startsWith("test-protected:")) throw new Error("Cannot decrypt");
    return Buffer.from(text.slice("test-protected:".length), "base64").toString();
  },
};

function account(id: string, clientId: string, expiresAt = new Date(Date.now() + 60 * 60_000).toISOString()): AccountRecord {
  return {
    id,
    label: `same@example.com (${id})`,
    email: "same@example.com",
    issuer: "https://auth.openai.com",
    subject: `subject-${id}`,
    clientId,
    createdAt: new Date().toISOString(),
    credentials: {
      accessToken: `access-secret-${id}`,
      refreshToken: `refresh-secret-${id}`,
      idToken: `id-secret-${id}`,
      tokenType: "Bearer",
      scopes: ["openid", "offline_access", "chatgpt.tokens.use.direct"],
      savedAt: new Date().toISOString(),
      expiresAt,
      earliestRefreshAt: null,
    },
  };
}

test("vault encrypts credentials, survives reload, and preserves one host ID", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "switchboard-auth-"));
  try {
    const store = new AccountStore(directory, testProtector);
    const first = await store.load();
    assert.match(first.hostId, /^urn:uuid:/);
    first.accounts.push(account("one", "oaiapp_one"));
    first.activeAccountId = "one";
    await store.save(first);
    const raw = await readFile(path.join(directory, "chatgpt-accounts.v1.bin"), "utf8");
    assert.equal(raw.includes("refresh-secret-one"), false);
    const second = await new AccountStore(directory, testProtector).load();
    assert.equal(second.hostId, first.hostId);
    assert.equal(second.accounts[0].credentials?.refreshToken, "refresh-secret-one");
    assert.equal(second.activeAccountId, "one");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupt or undecryptable vault fails closed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "switchboard-auth-"));
  try {
    const store = new AccountStore(directory, testProtector);
    await store.load();
    const unavailable = new AccountStore(directory, { ...testProtector, isAvailable: () => false });
    await assert.rejects(unavailable.load(), (error: unknown) => error instanceof VaultError && error.code === "STORAGE_UNAVAILABLE");
    const wrongKey = new AccountStore(directory, { ...testProtector, decrypt: () => { throw new Error("Wrong key"); } });
    await assert.rejects(wrongKey.load(), (error: unknown) => error instanceof VaultError && error.code === "STORAGE_CORRUPT");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accounts remain separate when email matches; sign out and remove target only", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "switchboard-auth-"));
  try {
    const store = new AccountStore(directory, testProtector);
    const vault = await store.load();
    vault.accounts.push(account("one", "oaiapp_one"), account("two", "oaiapp_two"));
    vault.activeAccountId = "one";
    await store.save(vault);
    const revocations: string[] = [];
    const manager = new AuthManager({
      userDataPath: directory,
      appName: "Switchboard",
      store,
      openExternal: async () => { throw new Error("Unexpected browser"); },
      fetchImpl: async (_url, init) => {
        const body = init?.body as URLSearchParams;
        revocations.push(body.get("client_id") ?? "");
        return new Response(null, { status: 200 });
      },
    });
    await manager.initialize();
    assert.equal(manager.listAccounts().length, 2);
    assert.equal(manager.listAccounts()[0].email, manager.listAccounts()[1].email);
    assert.notEqual(manager.listAccounts()[0].label, manager.listAccounts()[1].label);
    assert.equal(JSON.stringify(manager.listAccounts()).includes("access-secret"), false);
    assert.equal((await manager.renameAccount("one", "  Personal  ")).label, "Personal");
    await assert.rejects(manager.renameAccount("two", " personal "), (error: unknown) => error instanceof AuthError && error.code === "LABEL_TAKEN");
    await assert.rejects(manager.renameAccount("two", "   "), (error: unknown) => error instanceof AuthError && error.code === "INVALID_LABEL");
    await assert.rejects(manager.renameAccount("two", "x".repeat(81)), (error: unknown) => error instanceof AuthError && error.code === "INVALID_LABEL");
    assert.equal((await new AccountStore(directory, testProtector).load()).accounts[0].label, "Personal");
    assert.equal(await manager.getAccessToken(), "access-secret-one");
    const signedOut = await manager.signOutAccount("one");
    assert.equal(signedOut.revocationConfirmed, true);
    assert.deepEqual(revocations, ["oaiapp_one"]);
    assert.equal(manager.getActiveAccount(), null);
    assert.equal(manager.listAccounts()[0].status, "needs_sign_in");
    assert.equal(manager.listAccounts()[1].status, "connected");
    await manager.activateAccount("one");
    assert.equal(manager.getActiveAccount()?.status, "needs_sign_in");
    await assert.rejects(manager.getAccessToken(), (error: unknown) => error instanceof AuthError && error.code === "NEEDS_SIGN_IN");
    await manager.activateAccount("two");
    assert.equal(await manager.getAccessToken(), "access-secret-two");
    await manager.removeAccount("one");
    assert.equal(manager.listAccounts().length, 1);
    assert.equal(manager.getActiveAccount()?.id, "two");
    assert.deepEqual(revocations, ["oaiapp_one"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("temporary refresh failure retains the saved session", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "switchboard-auth-"));
  try {
    const store = new AccountStore(directory, testProtector);
    const vault = await store.load();
    vault.accounts.push(account("one", "oaiapp_one", new Date(Date.now() - 1000).toISOString()));
    vault.activeAccountId = "one";
    await store.save(vault);
    const manager = new AuthManager({
      userDataPath: directory,
      appName: "Switchboard",
      store,
      openExternal: async () => { throw new Error("Unexpected browser"); },
      fetchImpl: async () => new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 503 }),
    });
    await manager.initialize();
    await assert.rejects(manager.getAccessToken(), (error: unknown) => error instanceof AuthError && error.code === "REFRESH_TEMPORARY");
    assert.equal(manager.getActiveAccount()?.id, "one");
    assert.equal(manager.listAccounts()[0].status, "connected");
    assert.equal((await new AccountStore(directory, testProtector).load()).accounts[0].credentials?.refreshToken, "refresh-secret-one");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rotated refresh token is durable while ID-token verification is unavailable", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "switchboard-auth-"));
  try {
    const store = new AccountStore(directory, testProtector);
    const vault = await store.load();
    vault.accounts.push(account("one", "oaiapp_one", new Date(Date.now() - 1000).toISOString()));
    vault.activeAccountId = "one";
    await store.save(vault);
    let calls = 0;
    const manager = new AuthManager({
      userDataPath: directory,
      appName: "Switchboard",
      store,
      openExternal: async () => { throw new Error("Unexpected browser"); },
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          access_token: "new-access-secret",
          refresh_token: "new-refresh-secret",
          id_token: "unverifiable-id-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "openid offline_access chatgpt.tokens.use.direct",
        }), { status: 200 });
      },
    });
    await manager.initialize();
    await assert.rejects(manager.getAccessToken(), (error: unknown) => error instanceof AuthError && error.code === "REFRESH_TEMPORARY");
    const saved = await new AccountStore(directory, testProtector).load();
    assert.equal(saved.accounts[0].pendingCredentials?.refreshToken, "new-refresh-secret");
    assert.equal(saved.accounts[0].credentials?.refreshToken, "refresh-secret-one");
    await assert.rejects(manager.getAccessToken(), (error: unknown) => error instanceof AuthError && error.code === "REFRESH_TEMPORARY");
    assert.equal(calls, 1, "pending rotated token should be verified before another refresh request");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OAuth binds callback state, PKCE, issued client, nonce, and the saved subject", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "switchboard-auth-"));
  try {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "test-key";
    publicJwk.alg = "RS256";
    const store = new AccountStore(directory, testProtector);
    let authUrl: URL | null = null;
    let browserVisits = 0;
    let tokenExchanges = 0;
    const revoked: string[] = [];
    const manager = new AuthManager({
      userDataPath: directory,
      appName: "Switchboard",
      store,
      verificationKey: createLocalJWKSet({ keys: [publicJwk] }),
      openExternal: async (url) => {
        browserVisits += 1;
        authUrl = new URL(url);
        assert.equal(authUrl.origin, "https://auth.openai.com");
        assert.equal(authUrl.searchParams.get("resource"), "https://api.openai.com/v1");
        assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
        assert.equal(authUrl.searchParams.get("ext_agent_host_id"), manager.getHostId());
        if (browserVisits === 1 || browserVisits === 4) {
          assert.equal(authUrl.searchParams.get("client_id"), "dynamic_agent_client");
          assert.equal(authUrl.searchParams.get("agent_name_hint"), "Switchboard");
          assert.equal(authUrl.searchParams.has("prompt"), false);
          if (browserVisits === 1) {
            const forged = new URL(authUrl.searchParams.get("redirect_uri")!);
            forged.searchParams.set("state", "forged-state");
            forged.searchParams.set("code", "forged-code");
            assert.equal((await fetch(forged)).status, 400);
            assert.equal(tokenExchanges, 0);
          }
        } else {
          assert.equal(authUrl.searchParams.get("client_id"), "oaiapp_issued");
          assert.equal(authUrl.searchParams.has("agent_name_hint"), false);
          assert.equal(authUrl.searchParams.get("login_hint"), "same@example.com");
          assert.ok(authUrl.searchParams.get("id_token_hint"));
          assert.equal(authUrl.searchParams.get("prompt"), browserVisits === 2 ? "consent" : null);
        }
        const callback = new URL(authUrl.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", authUrl.searchParams.get("state")!);
        callback.searchParams.set("code", `code-${browserVisits}`);
        if (browserVisits === 1 || browserVisits === 4) {
          callback.searchParams.set("client_id", browserVisits === 4 ? "oaiapp_issued_two" : "oaiapp_issued");
        }
        assert.equal((await fetch(callback)).status, 200);
      },
      fetchImpl: async (url, init) => {
        if (url === "https://auth.openai.com/api/accounts/oauth/revoke") {
          revoked.push((init?.body as URLSearchParams).get("token") ?? "");
          return new Response(null, { status: 200 });
        }
        tokenExchanges += 1;
        assert.equal(url, "https://auth.openai.com/api/accounts/oauth/token");
        const body = init?.body as URLSearchParams;
        const issuedClientId = browserVisits === 4 ? "oaiapp_issued_two" : "oaiapp_issued";
        assert.equal(body.get("client_id"), issuedClientId);
        assert.equal(body.get("redirect_uri"), authUrl!.searchParams.get("redirect_uri"));
        const verifier = body.get("code_verifier")!;
        assert.equal(createHash("sha256").update(verifier).digest("base64url"), authUrl!.searchParams.get("code_challenge"));
        const subject = browserVisits === 3 ? "different-subject" : browserVisits === 4 ? "subject-two" : "subject-one";
        const idToken = await new SignJWT({ email: "same@example.com", nonce: authUrl!.searchParams.get("nonce") })
          .setProtectedHeader({ alg: "RS256", kid: "test-key" })
          .setIssuer("https://auth.openai.com")
          .setAudience(issuedClientId)
          .setSubject(subject)
          .setIssuedAt()
          .setExpirationTime("1h")
          .sign(privateKey);
        return new Response(JSON.stringify({
          access_token: `access-${browserVisits}`,
          refresh_token: `refresh-${browserVisits}`,
          id_token: idToken,
          token_type: "Bearer",
          expires_in: 3600,
          scope: browserVisits === 1
            ? "openid profile email offline_access resource.invoke"
            : "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
        }), { status: 200 });
      },
    });
    await manager.initialize();
    const initial = await manager.addAccount();
    assert.equal(initial.status, "connected");
    assert.equal(initial.label, "same@example.com");
    assert.equal(initial.planUsageEnabled, false);
    assert.equal(manager.getHostId(), (await new AccountStore(directory, testProtector).load()).hostId);
    await assert.rejects(manager.getAccessToken(), (error: unknown) => error instanceof AuthError && error.code === "PLAN_USAGE_DISABLED");
    const connected = await manager.reconnectAccount(initial.id);
    assert.equal(connected.id, initial.id);
    assert.equal(await manager.getAccessToken(), "access-2");
    await assert.rejects(manager.reconnectAccount(initial.id), (error: unknown) =>
      error instanceof AuthError && error.code === "IDENTITY_MISMATCH");
    assert.equal(await manager.getAccessToken(), "access-2");
    assert.deepEqual(revoked, ["refresh-3"]);
    const second = await manager.addAccount();
    assert.equal(second.label, "same@example.com (2)");
    assert.notEqual(second.id, initial.id);
    assert.equal(manager.listAccounts().length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("terminal refresh clears only unusable credentials and emits failover event", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "switchboard-auth-"));
  try {
    const store = new AccountStore(directory, testProtector);
    const vault = await store.load();
    vault.accounts.push(account("one", "oaiapp_one", new Date(Date.now() - 1000).toISOString()), account("two", "oaiapp_two"));
    vault.activeAccountId = "one";
    await store.save(vault);
    const manager = new AuthManager({
      userDataPath: directory,
      appName: "Switchboard",
      store,
      openExternal: async () => { throw new Error("Unexpected browser"); },
      fetchImpl: async (_url, init) => {
        const body = init?.body as URLSearchParams;
        assert.equal(body.get("client_id"), "oaiapp_one");
        assert.equal(body.get("refresh_token"), "refresh-secret-one");
        assert.equal(body.get("scope"), null);
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } });
      },
    });
    await manager.initialize();
    const events: AuthAccountEvent[] = [];
    manager.onAccountEvent((event) => events.push(event));
    await assert.rejects(manager.getAccessToken(), (error: unknown) =>
      error instanceof AuthError && error.code === "REFRESH_TERMINAL" && error.details.oauthCode === "invalid_grant");
    assert.equal(manager.getActiveAccount(), null);
    assert.equal(manager.listAccounts()[0].status, "needs_sign_in");
    assert.equal(manager.listAccounts()[1].status, "connected");
    assert.deepEqual(events.at(-1), { type: "terminal_refresh", accountId: "one" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const action of ["sign out", "remove"] as const) {
  test(`late reconnect cannot undo ${action} and revokes its newly minted session`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "switchboard-auth-"));
    try {
      const { publicKey, privateKey } = await generateKeyPair("RS256");
      const publicJwk = await exportJWK(publicKey);
      publicJwk.kid = "race-key";
      publicJwk.alg = "RS256";
      const store = new AccountStore(directory, testProtector);
      const vault = await store.load();
      vault.accounts.push(account("one", "oaiapp_one"));
      vault.activeAccountId = "one";
      await store.save(vault);
      let releaseBrowser!: () => void;
      let markBrowserReady!: () => void;
      const browserReady = new Promise<void>((resolve) => { markBrowserReady = resolve; });
      const browserRelease = new Promise<void>((resolve) => { releaseBrowser = resolve; });
      let authorizeUrl: URL | null = null;
      const revoked: string[] = [];
      const manager = new AuthManager({
        userDataPath: directory,
        appName: "Switchboard",
        store,
        verificationKey: createLocalJWKSet({ keys: [publicJwk] }),
        openExternal: async (url) => {
          authorizeUrl = new URL(url);
          markBrowserReady();
          await browserRelease;
          const callback = new URL(authorizeUrl.searchParams.get("redirect_uri")!);
          callback.searchParams.set("state", authorizeUrl.searchParams.get("state")!);
          callback.searchParams.set("code", "late-code");
          assert.equal((await fetch(callback)).status, 200);
        },
        fetchImpl: async (url, init) => {
          const body = init?.body as URLSearchParams;
          if (url === "https://auth.openai.com/api/accounts/oauth/revoke") {
            revoked.push(body.get("token") ?? "");
            return new Response(null, { status: 200 });
          }
          assert.equal(url, "https://auth.openai.com/api/accounts/oauth/token");
          const idToken = await new SignJWT({ email: "same@example.com", nonce: authorizeUrl!.searchParams.get("nonce") })
            .setProtectedHeader({ alg: "RS256", kid: "race-key" })
            .setIssuer("https://auth.openai.com")
            .setAudience("oaiapp_one")
            .setSubject("subject-one")
            .setIssuedAt()
            .setExpirationTime("1h")
            .sign(privateKey);
          return new Response(JSON.stringify({
            access_token: "late-access",
            refresh_token: "late-refresh",
            id_token: idToken,
            token_type: "Bearer",
            expires_in: 3600,
            scope: "openid offline_access chatgpt.tokens.use.direct",
          }), { status: 200 });
        },
      });
      await manager.initialize();
      const reconnect = manager.reconnectAccount("one");
      await browserReady;
      if (action === "sign out") await manager.signOutAccount("one");
      else await manager.removeAccount("one");
      releaseBrowser();
      await assert.rejects(reconnect, (error: unknown) => error instanceof AuthError && error.code === "AUTH_CANCELLED");
      assert.deepEqual(revoked, ["refresh-secret-one", "late-refresh"]);
      if (action === "sign out") {
        assert.equal(manager.listAccounts()[0].status, "needs_sign_in");
        assert.equal(manager.getActiveAccount(), null);
      } else {
        assert.equal(manager.listAccounts().length, 0);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("getAccessToken rejects a refreshed grant that loses direct-use permission", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "switchboard-auth-"));
  try {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "scope-key";
    publicJwk.alg = "RS256";
    const store = new AccountStore(directory, testProtector);
    const vault = await store.load();
    vault.accounts.push(account("one", "oaiapp_one", new Date(Date.now() - 1000).toISOString()));
    vault.activeAccountId = "one";
    await store.save(vault);
    const idToken = await new SignJWT({ email: "same@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "scope-key" })
      .setIssuer("https://auth.openai.com")
      .setAudience("oaiapp_one")
      .setSubject("subject-one")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    const manager = new AuthManager({
      userDataPath: directory,
      appName: "Switchboard",
      store,
      verificationKey: createLocalJWKSet({ keys: [publicJwk] }),
      openExternal: async () => { throw new Error("Unexpected browser"); },
      fetchImpl: async () => new Response(JSON.stringify({
        access_token: "no-direct-access",
        refresh_token: "new-refresh",
        id_token: idToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid offline_access",
      }), { status: 200 }),
    });
    await manager.initialize();
    await assert.rejects(manager.getAccessToken(), (error: unknown) => error instanceof AuthError && error.code === "PLAN_USAGE_DISABLED");
    assert.equal(manager.listAccounts()[0].planUsageEnabled, false);
    assert.equal((await new AccountStore(directory, testProtector).load()).accounts[0].credentials?.refreshToken, "new-refresh");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
