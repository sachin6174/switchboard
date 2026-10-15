import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { claudeCodeBinary, claudeProcessEnv } from "./claude-binary";

const STATUS_TIMEOUT_MS = 20_000;
const LOGOUT_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_STATUS_BYTES = 64 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ClaudeSubscriptionStatus = "connected" | "needs_sign_in" | "signing_in";

export interface ClaudeSubscriptionAccountSummary {
  id: string;
  provider: "claude_subscription";
  label: string;
  email: null;
  status: ClaudeSubscriptionStatus;
  createdAt: string;
}

interface ClaudeAccountRecord {
  id: string;
  label: string;
  status: "connected" | "needs_sign_in";
  createdAt: string;
}

interface ClaudeAccountIndex {
  version: 1;
  accounts: ClaudeAccountRecord[];
}

interface ClaudeCliStatus {
  loggedIn?: unknown;
  authMethod?: unknown;
  subscriptionType?: unknown;
  apiProvider?: unknown;
}

export interface ClaudeCommandResult {
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
}

export interface ClaudeCommandRequest {
  accountId: string;
  configDir: string;
  args: string[];
  timeoutMs: number;
  capture: boolean;
}

export type ClaudeSubscriptionErrorCode =
  | "NOT_INITIALIZED"
  | "NOT_FOUND"
  | "INVALID_LABEL"
  | "LABEL_TAKEN"
  | "AUTH_BUSY"
  | "AUTH_CANCELLED"
  | "AUTH_TIMEOUT"
  | "AUTH_FAILED"
  | "NEEDS_SIGN_IN"
  | "STORAGE_UNAVAILABLE"
  | "STORAGE_CORRUPT";

export class ClaudeSubscriptionError extends Error {
  constructor(public readonly code: ClaudeSubscriptionErrorCode, message: string) {
    super(message);
    this.name = "ClaudeSubscriptionError";
  }
}

export interface ClaudeSubscriptionManagerOptions {
  userDataPath: string;
  /** A fixed test binary may be supplied. Production uses the bundled Claude Code binary. */
  binaryPath?: string;
  /** Test seam for controlling CLI completion order without launching a browser. */
  commandRunner?: (request: ClaudeCommandRequest) => Promise<ClaudeCommandResult>;
}

function validateLabel(value: unknown): string {
  if (typeof value !== "string") throw new ClaudeSubscriptionError("INVALID_LABEL", "Enter an account name.");
  const label = value.normalize("NFKC").trim();
  if (!label || Array.from(label).length > 80 || /[\p{Cc}\p{Cf}]/u.test(label)) {
    throw new ClaudeSubscriptionError("INVALID_LABEL", "Account names must contain 1 to 80 visible characters.");
  }
  return label;
}

function normalizedLabel(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en");
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isIndex(value: unknown): value is ClaudeAccountIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const index = value as Partial<ClaudeAccountIndex>;
  if (index.version !== 1 || !Array.isArray(index.accounts)) return false;
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const value of index.accounts) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const account = value as Partial<ClaudeAccountRecord>;
    if (typeof account.id !== "string" || !UUID_PATTERN.test(account.id) || ids.has(account.id)
      || typeof account.label !== "string" || !isIsoDate(account.createdAt)
      || (account.status !== "connected" && account.status !== "needs_sign_in")) return false;
    try {
      if (validateLabel(account.label) !== account.label) return false;
    } catch {
      return false;
    }
    const labelKey = normalizedLabel(account.label);
    if (labels.has(labelKey)) return false;
    ids.add(account.id);
    labels.add(labelKey);
  }
  return true;
}

function isSubscriptionStatus(value: ClaudeCliStatus): boolean {
  if (value.loggedIn !== true || typeof value.authMethod !== "string") return false;
  const method = value.authMethod.toLocaleLowerCase("en");
  if (method === "claude.ai" || method === "claudeai") return true;
  // Some CLI versions report a generic OAuth method together with the subscription tier.
  return method.includes("oauth") && typeof value.subscriptionType === "string" && value.subscriptionType.length > 0;
}

/** Keeps only account metadata. Claude Code owns credentials under each isolated config directory. */
export class ClaudeSubscriptionManager {
  private readonly accountsFile: string;
  private readonly profilesDir: string;
  private index: ClaudeAccountIndex | null = null;
  private initialization: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly signingIn = new Set<string>();
  private readonly disconnecting = new Set<string>();
  private readonly loginProcesses = new Map<string, ChildProcess>();
  private readonly signInTasks = new Map<string, Promise<void>>();
  private readonly statusChecks = new Map<string, Set<Promise<boolean>>>();
  private readonly accountEpoch = new Map<string, number>();
  private signInPending = false;

  constructor(private readonly options: ClaudeSubscriptionManagerOptions) {
    if (!options.userDataPath) throw new ClaudeSubscriptionError("STORAGE_UNAVAILABLE", "An app data directory is required.");
    this.accountsFile = path.join(options.userDataPath, "claude-subscriptions.v1.json");
    this.profilesDir = path.join(options.userDataPath, "claude-subscriptions");
  }

  initialize(): Promise<void> {
    if (this.index) return Promise.resolve();
    if (this.initialization) return this.initialization;
    this.initialization = this.load().finally(() => { this.initialization = null; });
    return this.initialization;
  }

  listAccounts(): ClaudeSubscriptionAccountSummary[] {
    return this.requireIndex().accounts.map((account) => this.summary(account));
  }

  getConfigDir(id: string): string {
    this.requireAccount(id);
    return this.profilePath(id);
  }

  dispose(): void {
    for (const child of this.loginProcesses.values()) child.kill();
  }

  async addAccount(value: string): Promise<ClaudeSubscriptionAccountSummary> {
    const label = validateLabel(value);
    if (this.signInPending) throw new ClaudeSubscriptionError("AUTH_BUSY", "Finish the current Claude sign-in first.");
    this.signInPending = true;
    let accountId: string | null = null;
    let loginEpoch: number | null = null;
    try {
      const account = await this.mutate((draft) => {
        this.assertUniqueLabel(draft, label);
        const account: ClaudeAccountRecord = {
          id: randomUUID(), label, status: "needs_sign_in", createdAt: new Date().toISOString(),
        };
        draft.accounts.push(account);
        return account;
      });
      accountId = account.id;
      loginEpoch = this.advanceEpoch(account.id);
      await this.signIn(account.id, loginEpoch);
      return (await this.setStatusIfCurrent(account.id, "connected", loginEpoch, true)).summary;
    } catch (error) {
      if (accountId && loginEpoch !== null && this.currentEpoch(accountId) === loginEpoch) {
        await this.mutate((draft) => {
          draft.accounts = draft.accounts.filter((account) => account.id !== accountId);
        }).catch(() => undefined);
        await rm(this.profilePath(accountId), { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    } finally {
      this.signInPending = false;
    }
  }

  async reconnectAccount(id: string): Promise<ClaudeSubscriptionAccountSummary> {
    this.requireAccount(id);
    if (this.signInPending) throw new ClaudeSubscriptionError("AUTH_BUSY", "Finish the current Claude sign-in first.");
    if (this.disconnecting.has(id)) throw new ClaudeSubscriptionError("AUTH_BUSY", "This Claude account is disconnecting.");
    this.signInPending = true;
    const epoch = this.advanceEpoch(id);
    try {
      await this.signIn(id, epoch);
      return (await this.setStatusIfCurrent(id, "connected", epoch, true)).summary;
    } catch (error) {
      if (!(error instanceof ClaudeSubscriptionError && error.code === "AUTH_CANCELLED")) {
        await this.refreshAccountStatus(id).catch(() => undefined);
      }
      throw error;
    } finally {
      this.signInPending = false;
    }
  }

  async renameAccount(id: string, value: string): Promise<ClaudeSubscriptionAccountSummary> {
    const label = validateLabel(value);
    return this.mutate((draft) => {
      const account = this.requireAccountIn(draft, id);
      this.assertUniqueLabel(draft, label, id);
      account.label = label;
      return this.summary(account);
    });
  }

  markNeedsSignIn(id: string): Promise<ClaudeSubscriptionAccountSummary> {
    this.requireAccount(id);
    if (this.disconnecting.has(id) || this.signingIn.has(id)) return Promise.resolve(this.summary(this.requireAccount(id)));
    const epoch = this.advanceEpoch(id);
    return this.setStatusIfCurrent(id, "needs_sign_in", epoch, false).then((result) => result.summary);
  }

  async refreshAccountStatus(id: string): Promise<ClaudeSubscriptionAccountSummary> {
    return (await this.refreshStatusWithChange(id)).summary;
  }

  private async refreshStatusWithChange(id: string): Promise<{ summary: ClaudeSubscriptionAccountSummary; changed: boolean }> {
    this.requireAccount(id);
    if (this.signingIn.has(id) || this.disconnecting.has(id)) {
      return { summary: this.summary(this.requireAccount(id)), changed: false };
    }
    const epoch = this.currentEpoch(id);
    const connected = await this.checkStatus(id);
    // Auth failure can leave Claude Code's local status looking signed in. A check may
    // downgrade a session; only a completed browser sign-in may reconnect it.
    if (connected) return { summary: this.summary(this.requireAccount(id)), changed: false };
    return this.setStatusIfCurrent(id, "needs_sign_in", epoch, false);
  }

  /** Safe to start without awaiting from the main process; returns accounts whose state changed. */
  async refreshAllStatuses(): Promise<string[]> {
    const ids = this.listAccounts().map((account) => account.id);
    const changed = await Promise.all(ids.map(async (id) => {
      try {
        if (this.signingIn.has(id)) return null;
        const result = await this.refreshStatusWithChange(id);
        return result.changed ? id : null;
      } catch {
        // A transient CLI failure must not erase a previously valid session.
        return null;
      }
    }));
    return changed.filter((id): id is string => id !== null);
  }

  async signOutAccount(id: string): Promise<{ revocationConfirmed: boolean }> {
    this.requireAccount(id);
    if (this.disconnecting.has(id)) throw new ClaudeSubscriptionError("AUTH_BUSY", "This Claude account is already disconnecting.");
    this.disconnecting.add(id);
    const epoch = this.advanceEpoch(id);
    try {
      await this.cancelLogin(id);
      await this.waitForStatusChecks(id);
      const directory = this.profilePath(id);
      try {
        await this.runCommand(id, ["auth", "logout"], LOGOUT_TIMEOUT_MS, false);
      } catch {
        // Erasing the isolated local profile below still disconnects this account.
      }
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await this.setStatusIfCurrent(id, "needs_sign_in", epoch, true);
      return { revocationConfirmed: false };
    } finally {
      this.disconnecting.delete(id);
    }
  }

  async removeAccount(id: string): Promise<{ revocationConfirmed: boolean }> {
    this.requireAccount(id);
    if (this.disconnecting.has(id)) throw new ClaudeSubscriptionError("AUTH_BUSY", "This Claude account is already disconnecting.");
    this.disconnecting.add(id);
    const epoch = this.advanceEpoch(id);
    try {
      await this.cancelLogin(id);
      await this.waitForStatusChecks(id);
      try {
        await this.runCommand(id, ["auth", "logout"], LOGOUT_TIMEOUT_MS, false);
      } catch {
        // Local credential removal still completes below.
      }
      await rm(this.profilePath(id), { recursive: true, force: true });
      await this.mutate((draft) => {
        if (this.currentEpoch(id) !== epoch) throw new ClaudeSubscriptionError("AUTH_CANCELLED", "This Claude account changed during removal.");
        const before = draft.accounts.length;
        draft.accounts = draft.accounts.filter((account) => account.id !== id);
        if (before === draft.accounts.length) throw new ClaudeSubscriptionError("NOT_FOUND", "Saved Claude account was not found.");
      });
      this.accountEpoch.delete(id);
      return { revocationConfirmed: false };
    } finally {
      this.disconnecting.delete(id);
    }
  }

  private async signIn(id: string, epoch: number): Promise<void> {
    this.requireAccount(id);
    this.signingIn.add(id);
    const task = this.performSignIn(id);
    this.signInTasks.set(id, task);
    try {
      try {
        await task;
      } catch (error) {
        if (this.currentEpoch(id) !== epoch) {
          throw new ClaudeSubscriptionError("AUTH_CANCELLED", "Claude sign-in was cancelled.");
        }
        throw error;
      }
      if (this.currentEpoch(id) !== epoch) {
        throw new ClaudeSubscriptionError("AUTH_CANCELLED", "Claude sign-in was cancelled.");
      }
    } finally {
      if (this.signInTasks.get(id) === task) this.signInTasks.delete(id);
      this.signingIn.delete(id);
    }
  }

  private async performSignIn(id: string): Promise<void> {
    try {
      const result = await this.runCommand(id, ["auth", "login", "--claudeai"], LOGIN_TIMEOUT_MS, false, true);
      if (result.timedOut) throw new ClaudeSubscriptionError("AUTH_TIMEOUT", "Claude sign-in timed out. Try again.");
      if (result.exitCode !== 0) throw new ClaudeSubscriptionError("AUTH_FAILED", "Claude sign-in was not completed. Try again.");
      if (!(await this.checkStatus(id))) {
        throw new ClaudeSubscriptionError("AUTH_FAILED", "Claude did not confirm a subscription sign-in. Try again.");
      }
    } catch (error) {
      if (error instanceof ClaudeSubscriptionError) throw error;
      throw new ClaudeSubscriptionError("AUTH_FAILED", "Claude sign-in could not be completed. Try again.");
    }
  }

  private async checkStatus(id: string): Promise<boolean> {
    const task = this.readStatus(id);
    const checks = this.statusChecks.get(id) ?? new Set<Promise<boolean>>();
    checks.add(task);
    this.statusChecks.set(id, checks);
    try {
      return await task;
    } finally {
      checks.delete(task);
      if (checks.size === 0) this.statusChecks.delete(id);
    }
  }

  private async readStatus(id: string): Promise<boolean> {
    const result = await this.runCommand(id, ["auth", "status", "--json"], STATUS_TIMEOUT_MS, true);
    if (result.timedOut) throw new ClaudeSubscriptionError("AUTH_TIMEOUT", "Claude account status check timed out.");
    let parsed: ClaudeCliStatus;
    try {
      parsed = JSON.parse(result.stdout) as ClaudeCliStatus;
    } catch {
      throw new ClaudeSubscriptionError("AUTH_FAILED", "Claude account status could not be checked.");
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed.loggedIn !== "boolean") {
      throw new ClaudeSubscriptionError("AUTH_FAILED", "Claude account status could not be checked.");
    }
    // The CLI exits 1 for logged-out profiles while still returning valid JSON.
    return isSubscriptionStatus(parsed);
  }

  private async waitForStatusChecks(id: string): Promise<void> {
    await Promise.allSettled([...(this.statusChecks.get(id) ?? [])]);
  }

  private async runCommand(id: string, args: string[], timeoutMs: number, capture: boolean, login = false): Promise<ClaudeCommandResult> {
    const directory = this.profilePath(id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (this.options.commandRunner) {
      return this.options.commandRunner({ accountId: id, configDir: directory, args, timeoutMs, capture });
    }
    const executable = this.options.binaryPath ?? claudeCodeBinary();
    return new Promise<ClaudeCommandResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(executable, args, {
          cwd: directory,
          env: claudeProcessEnv(directory),
          shell: false,
          windowsHide: true,
          stdio: ["ignore", capture ? "pipe" : "ignore", "ignore"],
        });
      } catch {
        reject(new ClaudeSubscriptionError("AUTH_FAILED", "Could not start Claude sign-in. Reinstall Switchboard and try again."));
        return;
      }
      if (login) this.loginProcesses.set(id, child);
      let stdout = "";
      let overLimit = false;
      let timedOut = false;
      let settled = false;
      const finish = (error?: Error, exitCode: number | null = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (login && this.loginProcesses.get(id) === child) this.loginProcesses.delete(id);
        if (error) reject(error);
        else if (overLimit) reject(new ClaudeSubscriptionError("AUTH_FAILED", "Claude account status could not be checked."));
        else resolve({ exitCode, stdout, timedOut });
      };
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout, "utf8") > MAX_STATUS_BYTES) {
          overLimit = true;
          child.kill();
        }
      });
      child.once("error", () => finish(new ClaudeSubscriptionError("AUTH_FAILED", "Could not start Claude. Reinstall Switchboard and try again.")));
      child.once("close", (code) => finish(undefined, code));
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
      timer.unref();
    });
  }

  private async cancelLogin(id: string): Promise<void> {
    this.loginProcesses.get(id)?.kill();
    await this.signInTasks.get(id)?.catch(() => undefined);
  }

  private profilePath(id: string): string {
    if (!UUID_PATTERN.test(id)) throw new ClaudeSubscriptionError("NOT_FOUND", "Saved Claude account was not found.");
    const resolved = path.resolve(this.profilesDir, id);
    if (!resolved.startsWith(path.resolve(this.profilesDir) + path.sep)) {
      throw new ClaudeSubscriptionError("NOT_FOUND", "Saved Claude account was not found.");
    }
    return resolved;
  }

  private summary(account: ClaudeAccountRecord): ClaudeSubscriptionAccountSummary {
    return {
      id: account.id, provider: "claude_subscription", label: account.label, email: null,
      status: this.signingIn.has(account.id) ? "signing_in" : account.status,
      createdAt: account.createdAt,
    };
  }

  private requireIndex(): ClaudeAccountIndex {
    if (!this.index) throw new ClaudeSubscriptionError("NOT_INITIALIZED", "Claude account storage is not ready.");
    return this.index;
  }

  private requireAccount(id: string): ClaudeAccountRecord {
    return this.requireAccountIn(this.requireIndex(), id);
  }

  private requireAccountIn(index: ClaudeAccountIndex, id: string): ClaudeAccountRecord {
    const account = index.accounts.find((item) => item.id === id);
    if (!account) throw new ClaudeSubscriptionError("NOT_FOUND", "Saved Claude account was not found.");
    return account;
  }

  private assertUniqueLabel(index: ClaudeAccountIndex, label: string, exceptId?: string): void {
    if (index.accounts.some((account) => account.id !== exceptId && normalizedLabel(account.label) === normalizedLabel(label))) {
      throw new ClaudeSubscriptionError("LABEL_TAKEN", "Another Claude account already uses this name.");
    }
  }

  private currentEpoch(id: string): number {
    return this.accountEpoch.get(id) ?? 0;
  }

  private advanceEpoch(id: string): number {
    const epoch = this.currentEpoch(id) + 1;
    this.accountEpoch.set(id, epoch);
    return epoch;
  }

  private setStatusIfCurrent(
    id: string,
    status: ClaudeAccountRecord["status"],
    epoch: number,
    throwOnStale: boolean,
  ): Promise<{ summary: ClaudeSubscriptionAccountSummary; changed: boolean }> {
    return this.mutate((draft) => {
      const account = this.requireAccountIn(draft, id);
      if (this.currentEpoch(id) !== epoch || (!throwOnStale && (this.signingIn.has(id) || this.disconnecting.has(id)))) {
        if (throwOnStale) throw new ClaudeSubscriptionError("AUTH_CANCELLED", "This Claude account changed while the action was in progress.");
        return { summary: this.summary(account), changed: false };
      }
      const changed = account.status !== status;
      account.status = status;
      return { summary: this.summary(account), changed };
    });
  }

  private async load(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.accountsFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ClaudeSubscriptionError("STORAGE_UNAVAILABLE", "Could not read saved Claude accounts.");
      }
      const initial: ClaudeAccountIndex = { version: 1, accounts: [] };
      await this.writeAtomically(initial);
      this.index = initial;
      return;
    }
    try {
      const parsed: unknown = JSON.parse(content);
      if (!isIndex(parsed)) throw new Error("Unexpected account format");
      this.index = parsed;
    } catch {
      throw new ClaudeSubscriptionError("STORAGE_CORRUPT", "Saved Claude accounts cannot be read.");
    }
  }

  private mutate<T>(change: (draft: ClaudeAccountIndex) => T): Promise<T> {
    const operation = this.mutationTail.then(async () => {
      const draft = structuredClone(this.requireIndex());
      const result = change(draft);
      await this.writeAtomically(draft);
      this.index = draft;
      return result;
    });
    this.mutationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async writeAtomically(index: ClaudeAccountIndex): Promise<void> {
    const temporary = `${this.accountsFile}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(this.accountsFile), { recursive: true, mode: 0o700 });
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(index));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.accountsFile);
    } catch {
      throw new ClaudeSubscriptionError("STORAGE_UNAVAILABLE", "Could not save Claude accounts.");
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
