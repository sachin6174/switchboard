import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { AccountStore, type AccountRecord, type AccountVault, type CredentialRecord } from "./account-store";
import type { AccountSummary, AuthAccountEvent, AuthErrorCode } from "../shared/contracts";

const ISSUER = "https://auth.openai.com";
const AUTHORIZE_ENDPOINT = `${ISSUER}/api/accounts/authorize`;
const TOKEN_ENDPOINT = `${ISSUER}/api/accounts/oauth/token`;
const REVOCATION_ENDPOINT = `${ISSUER}/api/accounts/oauth/revoke`;
const RESOURCE = "https://api.openai.com/v1";
const CALLBACK_PATH = "/auth/callback";
const REQUESTED_SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const REFRESH_MARGIN_MS = 2 * 60 * 1000;
const AUTH_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ACCOUNT_LABEL_LENGTH = 80;
const TERMINAL_REFRESH_CODES = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
  "invalid_client",
]);
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  id_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  earliest_refresh_at?: number | string;
}

interface VerifiedIdentity {
  issuer: string;
  subject: string;
  email: string | null;
}

interface AuthorizationResult {
  clientId: string;
  credentials: CredentialRecord;
  identity: VerifiedIdentity;
}

interface CallbackListener {
  redirectUri: string;
  callback: Promise<URL>;
  close(): Promise<void>;
}

export interface AuthManagerOptions {
  userDataPath: string;
  appName: string;
  openExternal(url: string): Promise<void>;
  fetchImpl?: typeof fetch;
  /** Optional protected store, primarily for controlled local tests. */
  store?: AccountStore;
  /** Optional JWT key source for local protocol tests. Production uses OpenAI's JWKS. */
  verificationKey?: JWTVerifyGetKey;
}

/** Safe, typed errors for the shell. Raw token endpoint bodies never escape here. */
export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
    public readonly details: { status?: number; requestId?: string; oauthCode?: string } = {},
  ) {
    super(message);
    this.name = "AuthError";
  }
}

function randomUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function safeEqual(left: string | null, right: string): boolean {
  if (left === null) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeLabel(label: string): string {
  return label.normalize("NFKC").toLocaleLowerCase("en");
}

function nextDefaultLabel(accounts: AccountRecord[], email: string | null): string {
  const base = Array.from(email?.trim() || "ChatGPT account").slice(0, MAX_ACCOUNT_LABEL_LENGTH).join("");
  const used = new Set(accounts.map((account) => normalizeLabel(account.label)));
  if (!used.has(normalizeLabel(base))) return base;
  for (let suffix = 2; ; suffix += 1) {
    const ending = ` (${suffix})`;
    const candidate = `${Array.from(base).slice(0, MAX_ACCOUNT_LABEL_LENGTH - ending.length).join("")}${ending}`;
    if (!used.has(normalizeLabel(candidate))) return candidate;
  }
}

function sendCallbackPage(response: ServerResponse, success: boolean): void {
  response.writeHead(success ? 200 : 400, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "x-content-type-options": "nosniff",
  });
  response.end(`<html><head><title>ChatGPT sign in</title></head><body style="font-family:system-ui;padding:2rem"><h1>${success ? "Sign in received" : "Sign in could not be verified"}</h1><p>${success ? "Return to the app to continue." : "Return to the app and try again."}</p></body></html>`);
}

async function listenForCallback(expectedState: string): Promise<CallbackListener> {
  let settle!: (value: URL) => void;
  let fail!: (error: Error) => void;
  let finished = false;
  const callback = new Promise<URL>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // A browser-launch failure can close the listener before authorize() awaits callback.
  void callback.catch(() => undefined);
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET", "cache-control": "no-store" });
      response.end();
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "", "http://127.0.0.1");
    } catch {
      sendCallbackPage(response, false);
      return;
    }
    if (url.pathname !== CALLBACK_PATH) {
      response.writeHead(404, { "cache-control": "no-store" });
      response.end();
      return;
    }
    if (finished) {
      response.writeHead(410, { "cache-control": "no-store" });
      response.end();
      return;
    }
    if (!safeEqual(url.searchParams.get("state"), expectedState)) {
      sendCallbackPage(response, false);
      return;
    }
    finished = true;
    sendCallbackPage(response, true);
    settle(url);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch {
    throw new AuthError("AUTH_FAILED", "Could not open the local sign-in callback.");
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new AuthError("AUTH_FAILED", "Could not open the local sign-in callback.");
  }
  const timer = setTimeout(() => {
    if (finished) return;
    finished = true;
    fail(new AuthError("AUTH_TIMEOUT", "ChatGPT sign in timed out."));
  }, AUTH_TIMEOUT_MS);
  timer.unref();
  return {
    redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
    callback,
    close: async () => {
      clearTimeout(timer);
      if (!finished) {
        finished = true;
        // This promise has a consumer in authorize(), so cancellation is safe.
        fail(new AuthError("AUTH_CANCELLED", "ChatGPT sign in was cancelled."));
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function parseEarliestRefresh(value: number | string | undefined): string | null {
  if (value === undefined) return null;
  const numeric = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const milliseconds = numeric < 1e12 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
  }
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}

function parseTokenResponse(value: unknown): TokenResponse {
  if (!value || typeof value !== "object") {
    throw new AuthError("TOKEN_RESPONSE_INVALID", "The sign-in server returned an invalid token response.");
  }
  const response = value as Partial<TokenResponse>;
  if (typeof response.access_token !== "string" || !response.access_token ||
      typeof response.refresh_token !== "string" || !response.refresh_token ||
      typeof response.id_token !== "string" || !response.id_token ||
      typeof response.token_type !== "string" || response.token_type.toLowerCase() !== "bearer" ||
      typeof response.expires_in !== "number" || !Number.isFinite(response.expires_in) || response.expires_in <= 0 ||
      typeof response.scope !== "string") {
    throw new AuthError("TOKEN_RESPONSE_INVALID", "The sign-in server returned incomplete credentials.");
  }
  return response as TokenResponse;
}

function toCredentials(response: TokenResponse): CredentialRecord {
  const savedAt = Date.now();
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    idToken: response.id_token,
    tokenType: "Bearer",
    scopes: response.scope.split(/\s+/).filter(Boolean),
    savedAt: new Date(savedAt).toISOString(),
    expiresAt: new Date(savedAt + response.expires_in * 1000).toISOString(),
    earliestRefreshAt: parseEarliestRefresh(response.earliest_refresh_at),
  };
}

function oauthErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const body = value as Record<string, unknown>;
  if (typeof body.error === "string") return body.error;
  if (body.error && typeof body.error === "object") {
    const nested = body.error as Record<string, unknown>;
    if (typeof nested.code === "string") return nested.code;
  }
  if (typeof body.code === "string") return body.code;
  return undefined;
}

export class AuthManager {
  private readonly store: AccountStore;
  private readonly fetchImpl: typeof fetch;
  private readonly verificationKey: JWTVerifyGetKey;
  private vault: AccountVault | null = null;
  private initialization: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly accountLocks = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(event: AuthAccountEvent) => void>();
  private readonly disconnecting = new Set<string>();
  private readonly disconnectGeneration = new Map<string, number>();
  private signInPending = false;
  private refreshTimer: NodeJS.Timeout | null = null;
  private backgroundTickRunning = false;

  constructor(private readonly options: AuthManagerOptions) {
    if (!options.appName.trim()) throw new Error("appName is required");
    this.store = options.store ?? new AccountStore(options.userDataPath);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.verificationKey = options.verificationKey ?? jwks;
  }

  initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.store.load().then((vault) => { this.vault = vault; });
    }
    return this.initialization;
  }

  getHostId(): string {
    return this.requireVault().hostId;
  }

  listAccounts(): AccountSummary[] {
    const vault = this.requireVault();
    return vault.accounts.map((account) => this.toSummary(account, vault.activeAccountId));
  }

  getActiveAccount(): AccountSummary | null {
    const vault = this.requireVault();
    const account = vault.accounts.find((item) => item.id === vault.activeAccountId);
    return account ? this.toSummary(account, vault.activeAccountId) : null;
  }

  onAccountEvent(listener: (event: AuthAccountEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async addAccount(): Promise<AccountSummary> {
    const priorRegistrations = new Map(this.requireVault().accounts.map((account) => [
      account.clientId,
      { id: account.id, generation: this.disconnectGeneration.get(account.id) ?? 0 },
    ]));
    const result = await this.authorize(null);
    const priorRegistration = priorRegistrations.get(result.clientId);
    const commit = () => this.mutate((draft) => {
      if (priorRegistration) this.assertReconnectCurrent(priorRegistration.id, priorRegistration.generation);
      const existing = draft.accounts.find((account) => account.clientId === result.clientId);
      if (priorRegistration && (!existing || existing.id !== priorRegistration.id)) {
        throw new AuthError("AUTH_CANCELLED", "This saved account was removed during sign in.");
      }
      if (existing) {
        if (existing.issuer !== result.identity.issuer || existing.subject !== result.identity.subject) {
          throw new AuthError("IDENTITY_MISMATCH", "This registration belongs to a different ChatGPT account.");
        }
        existing.email = result.identity.email;
        existing.credentials = result.credentials;
        existing.pendingCredentials = null;
        draft.activeAccountId = existing.id;
        return this.toSummary(existing, existing.id);
      }
      const id = randomUUID();
      const account: AccountRecord = {
        id,
        label: nextDefaultLabel(draft.accounts, result.identity.email),
        email: result.identity.email,
        issuer: result.identity.issuer,
        subject: result.identity.subject,
        clientId: result.clientId,
        createdAt: new Date().toISOString(),
        credentials: result.credentials,
        pendingCredentials: null,
      };
      draft.accounts.push(account);
      draft.activeAccountId = id;
      return this.toSummary(account, id);
    });
    const existing = this.requireVault().accounts.find((account) => account.clientId === result.clientId);
    try {
      const lockId = priorRegistration?.id ?? existing?.id;
      return await (lockId ? this.withAccountLock(lockId, commit) : commit());
    } catch (error) {
      await this.revokeMintedSession(result, error);
      throw error;
    }
  }

  async reconnectAccount(accountId: string): Promise<AccountSummary> {
    if (this.disconnecting.has(accountId)) throw new AuthError("AUTH_BUSY", "This ChatGPT account is disconnecting.");
    const selected = this.requireAccount(accountId);
    const generation = this.disconnectGeneration.get(accountId) ?? 0;
    const result = await this.authorize(selected);
    try {
      return await this.withAccountLock(accountId, () => {
        this.assertReconnectCurrent(accountId, generation);
        return this.mutate((draft) => {
          this.assertReconnectCurrent(accountId, generation);
          const account = draft.accounts.find((item) => item.id === accountId);
          if (!account) throw new AuthError("AUTH_CANCELLED", "This saved account was removed during sign in.");
          if (account.clientId !== result.clientId || account.issuer !== result.identity.issuer || account.subject !== result.identity.subject) {
            throw new AuthError("IDENTITY_MISMATCH", "The selected ChatGPT account did not match its saved registration.");
          }
          account.email = result.identity.email;
          account.credentials = result.credentials;
          account.pendingCredentials = null;
          draft.activeAccountId = accountId;
          return this.toSummary(account, accountId);
        });
      });
    } catch (error) {
      await this.revokeMintedSession(result, error);
      throw error;
    }
  }

  async activateAccount(accountId: string): Promise<AccountSummary> {
    return this.mutate((draft) => {
      const account = draft.accounts.find((item) => item.id === accountId);
      if (!account) throw new AuthError("NOT_FOUND", "Saved ChatGPT account was not found.");
      draft.activeAccountId = accountId;
      return this.toSummary(account, accountId);
    });
  }

  async renameAccount(accountId: string, label: string): Promise<AccountSummary> {
    if (typeof label !== "string") {
      throw new AuthError("INVALID_LABEL", "Enter a name for this account.");
    }
    const trimmed = label.trim();
    if (!trimmed || Array.from(trimmed).length > MAX_ACCOUNT_LABEL_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) {
      throw new AuthError("INVALID_LABEL", "Account names must be 1–80 characters without line breaks or controls.");
    }
    return this.mutate((draft) => {
      const account = draft.accounts.find((item) => item.id === accountId);
      if (!account) throw new AuthError("NOT_FOUND", "Saved ChatGPT account was not found.");
      if (draft.accounts.some((item) => item.id !== accountId && normalizeLabel(item.label) === normalizeLabel(trimmed))) {
        throw new AuthError("LABEL_TAKEN", "Another saved account already uses this name.");
      }
      account.label = trimmed;
      return this.toSummary(account, draft.activeAccountId);
    });
  }

  async signOutAccount(accountId: string): Promise<{ revocationConfirmed: boolean }> {
    this.beginDisconnect(accountId);
    try {
      return await this.withAccountLock(accountId, async () => {
        const account = this.requireAccount(accountId);
        const refreshToken = account.pendingCredentials?.refreshToken ?? account.credentials?.refreshToken;
        const revocationConfirmed = refreshToken
          ? await this.revokeWithRetry(refreshToken, account.clientId)
          : true;
        await this.mutate((draft) => {
          const item = draft.accounts.find((candidate) => candidate.id === accountId);
          if (!item) throw new AuthError("NOT_FOUND", "Saved ChatGPT account was not found.");
          item.credentials = null;
          item.pendingCredentials = null;
          if (draft.activeAccountId === accountId) draft.activeAccountId = null;
        });
        return { revocationConfirmed };
      });
    } finally {
      this.disconnecting.delete(accountId);
    }
  }

  async removeAccount(accountId: string): Promise<{ revocationConfirmed: boolean }> {
    this.beginDisconnect(accountId);
    try {
      return await this.withAccountLock(accountId, async () => {
        const account = this.requireAccount(accountId);
        const refreshToken = account.pendingCredentials?.refreshToken ?? account.credentials?.refreshToken;
        const revocationConfirmed = refreshToken
          ? await this.revokeWithRetry(refreshToken, account.clientId)
          : true;
        await this.mutate((draft) => {
          const index = draft.accounts.findIndex((item) => item.id === accountId);
          if (index < 0) throw new AuthError("NOT_FOUND", "Saved ChatGPT account was not found.");
          draft.accounts.splice(index, 1);
          if (draft.activeAccountId === accountId) draft.activeAccountId = null;
        });
        return { revocationConfirmed };
      });
    } finally {
      this.disconnecting.delete(accountId);
    }
  }

  /** Main-process only. Do not expose this method through IPC or logs. */
  async getAccessToken(accountId?: string): Promise<string> {
    const vault = this.requireVault();
    const selectedId = accountId ?? vault.activeAccountId;
    if (!selectedId) throw new AuthError("NO_ACTIVE_ACCOUNT", "Select a ChatGPT account first.");
    if (this.disconnecting.has(selectedId)) throw new AuthError("NEEDS_SIGN_IN", "This ChatGPT account is signing out.");
    let account = this.requireAccount(selectedId);
    if (!account.credentials) throw new AuthError("NEEDS_SIGN_IN", "Sign in to this ChatGPT account again.");
    if (!account.credentials.scopes.includes("chatgpt.tokens.use.direct")) {
      throw new AuthError("PLAN_USAGE_DISABLED", "ChatGPT plan usage is not enabled for this account.");
    }
    if (Date.parse(account.credentials.expiresAt) - Date.now() <= REFRESH_MARGIN_MS) {
      try {
        await this.refreshAccount(selectedId);
      } catch (error) {
        account = this.requireAccount(selectedId);
        if (!(error instanceof AuthError && error.code === "REFRESH_TEMPORARY" &&
              account.credentials && Date.parse(account.credentials.expiresAt) > Date.now() + 30_000)) {
          throw error;
        }
      }
    }
    account = this.requireAccount(selectedId);
    if (!account.credentials) throw new AuthError("NEEDS_SIGN_IN", "Sign in to this ChatGPT account again.");
    if (!account.credentials.scopes.includes("chatgpt.tokens.use.direct")) {
      throw new AuthError("PLAN_USAGE_DISABLED", "ChatGPT plan usage is not enabled for this account.");
    }
    if (this.disconnecting.has(selectedId)) throw new AuthError("NEEDS_SIGN_IN", "This ChatGPT account is signing out.");
    if (!accountId && this.requireVault().activeAccountId !== selectedId) {
      throw new AuthError("NO_ACTIVE_ACCOUNT", "The active ChatGPT account changed. Retry the request.");
    }
    return account.credentials.accessToken;
  }

  startBackgroundRefresh(): void {
    this.requireVault();
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => { void this.backgroundRefreshTick(); }, 60_000);
    this.refreshTimer.unref();
    void this.backgroundRefreshTick();
  }

  stopBackgroundRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  private async backgroundRefreshTick(): Promise<void> {
    if (this.backgroundTickRunning) return;
    this.backgroundTickRunning = true;
    try {
      const ids = this.requireVault().accounts
        .filter((account) => account.credentials && Date.parse(account.credentials.expiresAt) - Date.now() <= REFRESH_MARGIN_MS)
        .map((account) => account.id);
      for (const id of ids) {
        try { await this.refreshAccount(id); } catch { /* Keep credentials on temporary errors; terminal errors emit an event. */ }
      }
    } finally {
      this.backgroundTickRunning = false;
    }
  }

  private async authorize(selected: AccountRecord | null): Promise<AuthorizationResult> {
    if (this.signInPending) throw new AuthError("AUTH_BUSY", "Another ChatGPT sign in is already in progress.");
    this.signInPending = true;
    try {
      let clientId = selected?.clientId ?? "dynamic_agent_client";
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const state = randomUrlSafe();
        const nonce = randomUrlSafe();
        const verifier = randomUrlSafe(64);
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        const listener = await listenForCallback(state);
        try {
          const authorizeUrl = new URL(AUTHORIZE_ENDPOINT);
          authorizeUrl.search = new URLSearchParams({
            client_id: clientId,
            ext_agent_host_id: this.getHostId(),
            response_type: "code",
            redirect_uri: listener.redirectUri,
            scope: REQUESTED_SCOPES,
            resource: RESOURCE,
            state,
            nonce,
            code_challenge_method: "S256",
            code_challenge: challenge,
          }).toString();
          if (clientId === "dynamic_agent_client") authorizeUrl.searchParams.set("agent_name_hint", this.options.appName);
          if (selected?.credentials?.idToken) authorizeUrl.searchParams.set("id_token_hint", selected.credentials.idToken);
          if (selected?.email) authorizeUrl.searchParams.set("login_hint", selected.email);
          if (selected?.credentials && !selected.credentials.scopes.includes("chatgpt.tokens.use.direct")) {
            authorizeUrl.searchParams.set("prompt", "consent");
          }
          try {
            await this.options.openExternal(authorizeUrl.toString());
          } catch {
            throw new AuthError("AUTH_FAILED", "Could not open the system browser for ChatGPT sign in.");
          }
          const callback = await listener.callback;
          const returnedError = callback.searchParams.get("error");
          if (returnedError) {
            throw new AuthError(returnedError === "access_denied" ? "AUTH_CANCELLED" : "AUTH_FAILED",
              returnedError === "access_denied" ? "ChatGPT sign in was declined." : "ChatGPT sign in failed.",
              { oauthCode: returnedError });
          }
          const code = callback.searchParams.get("code");
          if (!code) throw new AuthError("AUTH_FAILED", "The ChatGPT callback had no authorization code.");
          const returnedClientId = callback.searchParams.get("client_id");
          if (clientId === "dynamic_agent_client") {
            if (!returnedClientId || returnedClientId === "dynamic_agent_client") {
              throw new AuthError("AUTH_FAILED", "ChatGPT registration did not return an issued client ID.");
            }
            clientId = returnedClientId;
          } else if (returnedClientId && returnedClientId !== clientId) {
            throw new AuthError("IDENTITY_MISMATCH", "ChatGPT returned a different client registration.");
          }
          let tokenResponse: TokenResponse;
          try {
            tokenResponse = await this.requestTokens(new URLSearchParams({
              grant_type: "authorization_code",
              client_id: clientId,
              code,
              code_verifier: verifier,
              redirect_uri: listener.redirectUri,
              resource: RESOURCE,
            }), "AUTH_FAILED");
          } catch (error) {
            if (error instanceof AuthError && error.details.oauthCode === "invalid_grant" && attempt === 0) continue;
            throw error;
          }
          const credentials = toCredentials(tokenResponse);
          try {
            const identity = await this.verifyIdentity(tokenResponse.id_token, clientId, nonce);
            if (selected && (selected.clientId !== clientId || selected.issuer !== identity.issuer || selected.subject !== identity.subject)) {
              throw new AuthError("IDENTITY_MISMATCH", "The selected ChatGPT account did not match its saved registration.");
            }
            return { clientId, credentials, identity };
          } catch (error) {
            await this.revokeMintedSession({ clientId, credentials }, error);
            throw error;
          }
        } finally {
          await listener.close();
        }
      }
      throw new AuthError("AUTH_FAILED", "ChatGPT sign in could not complete. Try again.");
    } finally {
      this.signInPending = false;
    }
  }

  private async verifyIdentity(idToken: string, clientId: string, nonce?: string): Promise<VerifiedIdentity> {
    try {
      const { payload } = await jwtVerify(idToken, this.verificationKey, {
        issuer: ISSUER,
        audience: clientId,
        algorithms: ["RS256"],
        requiredClaims: ["sub", "exp", "iat"],
        clockTolerance: 5,
      });
      if (!payload.sub || (nonce !== undefined && payload.nonce !== nonce)) {
        throw new Error("ID token claims did not match");
      }
      return {
        issuer: ISSUER,
        subject: payload.sub,
        email: typeof payload.email === "string" ? payload.email : null,
      };
    } catch {
      throw new AuthError("IDENTITY_MISMATCH", "ChatGPT identity verification failed.");
    }
  }

  private async requestTokens(body: URLSearchParams, failureCode: "AUTH_FAILED" | "REFRESH_TEMPORARY"): Promise<TokenResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new AuthError(failureCode, "Could not reach the ChatGPT sign-in server.");
    }
    let parsed: unknown;
    try {
      const text = await response.text();
      parsed = JSON.parse(text.slice(0, 64_000));
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const code = oauthErrorCode(parsed);
      const terminal = failureCode === "REFRESH_TEMPORARY" && code !== undefined && TERMINAL_REFRESH_CODES.has(code);
      throw new AuthError(terminal ? "REFRESH_TERMINAL" : failureCode,
        terminal ? "This ChatGPT account needs to sign in again." :
          failureCode === "AUTH_FAILED" ? "ChatGPT sign in could not exchange its authorization code." : "ChatGPT token renewal failed.",
        { status: response.status, requestId: response.headers.get("openai-request-id") ?? response.headers.get("x-request-id") ?? undefined, oauthCode: code });
    }
    try {
      return parseTokenResponse(parsed);
    } catch (error) {
      if (failureCode === "REFRESH_TEMPORARY") {
        throw new AuthError("REFRESH_TEMPORARY", "ChatGPT returned an incomplete renewal response.");
      }
      throw error;
    }
  }

  private async refreshAccount(accountId: string): Promise<void> {
    return this.withAccountLock(accountId, async () => {
      const account = this.requireAccount(accountId);
      const prior = account.credentials;
      if (!prior) throw new AuthError("NEEDS_SIGN_IN", "Sign in to this ChatGPT account again.");
      let pending = account.pendingCredentials;
      if (!pending && Date.parse(prior.expiresAt) - Date.now() > REFRESH_MARGIN_MS) return;
      if (!pending && prior.earliestRefreshAt && Date.parse(prior.earliestRefreshAt) > Date.now()) {
        throw new AuthError("REFRESH_TEMPORARY", "ChatGPT has not yet allowed this session to refresh.");
      }
      if (!pending) {
        let response: TokenResponse;
        try {
          response = await this.requestTokens(new URLSearchParams({
            grant_type: "refresh_token",
            client_id: account.clientId,
            refresh_token: prior.refreshToken,
            resource: RESOURCE,
          }), "REFRESH_TEMPORARY");
        } catch (error) {
          if (error instanceof AuthError && error.code === "REFRESH_TERMINAL") {
            await this.clearTerminalCredential(accountId);
          }
          throw error;
        }
        pending = toCredentials(response);
        const rotated = pending;
        // Rotation may have invalidated the previous refresh token. Persist the
        // replacement before a possibly unavailable JWKS lookup.
        await this.mutate((draft) => {
          const current = draft.accounts.find((item) => item.id === accountId);
          if (!current || !current.credentials || current.credentials.refreshToken !== prior.refreshToken) {
            throw new AuthError("NEEDS_SIGN_IN", "This ChatGPT session changed during renewal.");
          }
          current.pendingCredentials = rotated;
        });
      }
      let identity: VerifiedIdentity;
      try {
        identity = await this.verifyIdentity(pending.idToken, account.clientId);
      } catch {
        // A JWKS fetch or verification outage must not erase a saved session.
        throw new AuthError("REFRESH_TEMPORARY", "The refreshed ChatGPT identity could not be verified yet.");
      }
      if (identity.issuer !== account.issuer || identity.subject !== account.subject) {
        await this.clearTerminalCredential(accountId);
        throw new AuthError("REFRESH_TERMINAL", "The refreshed ChatGPT identity did not match this account.");
      }
      await this.mutate((draft) => {
        const current = draft.accounts.find((item) => item.id === accountId);
        if (!current || !current.credentials || current.credentials.refreshToken !== prior.refreshToken ||
            current.pendingCredentials?.refreshToken !== pending.refreshToken) {
          throw new AuthError("NEEDS_SIGN_IN", "This ChatGPT session changed during renewal.");
        }
        current.email = identity.email;
        current.credentials = pending;
        current.pendingCredentials = null;
      });
    });
  }

  private async clearTerminalCredential(accountId: string): Promise<void> {
    await this.mutate((draft) => {
      const account = draft.accounts.find((item) => item.id === accountId);
      if (account) {
        account.credentials = null;
        account.pendingCredentials = null;
      }
      if (draft.activeAccountId === accountId) draft.activeAccountId = null;
    });
    this.emit({ type: "terminal_refresh", accountId });
  }

  private async revokeWithRetry(refreshToken: string, clientId: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.fetchImpl(REVOCATION_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: refreshToken, token_type_hint: "refresh_token", client_id: clientId }),
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status === 200) return true;
        if (response.status < 500) return false;
      } catch { /* Retry transient network errors before removing local credentials. */ }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
    }
    return false;
  }

  private async mutate<T>(change: (draft: AccountVault) => T | Promise<T>): Promise<T> {
    const operation = this.mutationTail.then(async () => {
      const draft = structuredClone(this.requireVault());
      const result = await change(draft);
      await this.store.save(draft);
      this.vault = draft;
      this.emit({ type: "accounts_changed" });
      return result;
    });
    this.mutationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async withAccountLock<T>(accountId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.accountLocks.get(accountId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.accountLocks.set(accountId, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.accountLocks.get(accountId) === current) this.accountLocks.delete(accountId);
    }
  }

  private toSummary(account: AccountRecord, activeAccountId: string | null): AccountSummary {
    return {
      id: account.id,
      label: account.label,
      email: account.email,
      active: account.id === activeAccountId,
      status: account.credentials ? "connected" : "needs_sign_in",
      planUsageEnabled: Boolean(account.credentials?.scopes.includes("chatgpt.tokens.use.direct")),
      accessTokenExpiresAt: account.credentials?.expiresAt ?? null,
    };
  }

  private requireVault(): AccountVault {
    if (!this.vault) throw new AuthError("NOT_INITIALIZED", "Account storage has not been initialized.");
    return this.vault;
  }

  private requireAccount(accountId: string): AccountRecord {
    const account = this.requireVault().accounts.find((item) => item.id === accountId);
    if (!account) throw new AuthError("NOT_FOUND", "Saved ChatGPT account was not found.");
    return account;
  }

  private beginDisconnect(accountId: string): void {
    this.requireAccount(accountId);
    if (this.disconnecting.has(accountId)) {
      throw new AuthError("AUTH_BUSY", "This ChatGPT account is already disconnecting.");
    }
    this.disconnecting.add(accountId);
    this.disconnectGeneration.set(accountId, (this.disconnectGeneration.get(accountId) ?? 0) + 1);
  }

  private assertReconnectCurrent(accountId: string, generation: number): void {
    if (this.disconnecting.has(accountId) || (this.disconnectGeneration.get(accountId) ?? 0) !== generation) {
      throw new AuthError("AUTH_CANCELLED", "This account was signed out or removed during sign in.");
    }
  }

  private async revokeMintedSession(
    result: Pick<AuthorizationResult, "clientId" | "credentials">,
    originalError: unknown,
  ): Promise<void> {
    const confirmed = await this.revokeWithRetry(result.credentials.refreshToken, result.clientId);
    if (!confirmed && originalError instanceof AuthError) {
      originalError.message = `${originalError.message} Remote session revocation could not be confirmed; disconnect this app in ChatGPT Settings.`;
    }
  }

  private emit(event: AuthAccountEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* Observers cannot interrupt credential updates. */ }
    }
  }
}
