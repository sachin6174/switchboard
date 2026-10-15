import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { electronCredentialProtector, type CredentialProtector } from "./account-store";

export type ApiProvider = "claude_api" | "antigravity_api";
export type ApiAccountStatus = "ready" | "invalid";

export interface ApiAccountSummary {
  id: string;
  provider: ApiProvider;
  label: string;
  email: null;
  status: ApiAccountStatus;
  workspaceId: string | null;
  createdAt: string;
}

export interface ApiAccountCredential {
  provider: ApiProvider;
  apiKey: string;
  workspaceId?: string;
}

export interface AddApiAccountInput {
  provider: ApiProvider;
  label: string;
  apiKey: string;
  workspaceId?: string;
}

export interface ApiAccountStoreOptions {
  userDataPath: string;
  protector?: CredentialProtector;
}

type ApiAccountRecord = ApiAccountSummary & { apiKey: string };
interface ApiAccountVault {
  version: 1;
  selectedAccountId: string | null;
  accounts: ApiAccountRecord[];
}

export type ApiAccountStoreErrorCode =
  | "NOT_INITIALIZED"
  | "NOT_FOUND"
  | "INVALID_PROVIDER"
  | "INVALID_LABEL"
  | "LABEL_TAKEN"
  | "INVALID_KEY"
  | "INVALID_WORKSPACE"
  | "STORAGE_UNAVAILABLE"
  | "STORAGE_CORRUPT";

export class ApiAccountStoreError extends Error {
  constructor(public readonly code: ApiAccountStoreErrorCode, message: string) {
    super(message);
    this.name = "ApiAccountStoreError";
  }
}

function isProvider(value: unknown): value is ApiProvider {
  return value === "claude_api" || value === "antigravity_api";
}

function normalizedLabel(label: string): string {
  return label.normalize("NFKC").toLocaleLowerCase("en");
}

function validateLabel(value: unknown): string {
  if (typeof value !== "string") throw new ApiAccountStoreError("INVALID_LABEL", "Enter an account name.");
  const label = value.normalize("NFKC").trim();
  if (!label || Array.from(label).length > 80 || /[\p{Cc}\p{Cf}]/u.test(label)) {
    throw new ApiAccountStoreError("INVALID_LABEL", "Account names must contain 1 to 80 visible characters.");
  }
  return label;
}

function validateApiKey(value: unknown): string {
  if (typeof value !== "string") throw new ApiAccountStoreError("INVALID_KEY", "Enter an API key.");
  const apiKey = value.trim();
  if (!apiKey || apiKey.length > 4096 || /\s|[\p{Cc}\p{Cf}]/u.test(apiKey)) {
    throw new ApiAccountStoreError("INVALID_KEY", "Enter an API key without spaces or line breaks.");
  }
  return apiKey;
}

function validateWorkspaceId(provider: ApiProvider, value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (provider !== "claude_api" || typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) {
    throw new ApiAccountStoreError("INVALID_WORKSPACE", "The workspace ID is invalid for this provider.");
  }
  return value;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isVault(value: unknown): value is ApiAccountVault {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const vault = value as Partial<ApiAccountVault>;
  if (vault.version !== 1 || !(vault.selectedAccountId === null || isSelectedId(vault.selectedAccountId)) || !Array.isArray(vault.accounts)) return false;
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const row of vault.accounts) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    const account = row as Partial<ApiAccountRecord>;
    if (typeof account.id !== "string" || !/^[0-9a-f-]{36}$/i.test(account.id) || ids.has(account.id)
      || !isProvider(account.provider) || typeof account.label !== "string" || account.email !== null
      || (account.status !== "ready" && account.status !== "invalid")
      || !isIsoDate(account.createdAt) || typeof account.apiKey !== "string") return false;
    try {
      if (validateLabel(account.label) !== account.label || validateApiKey(account.apiKey) !== account.apiKey) return false;
      if (validateWorkspaceId(account.provider, account.workspaceId) !== account.workspaceId) return false;
    } catch {
      return false;
    }
    const labelKey = `${account.provider}\u0000${normalizedLabel(account.label)}`;
    if (labels.has(labelKey)) return false;
    ids.add(account.id);
    labels.add(labelKey);
  }
  return true;
}

function isSelectedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function summary(account: ApiAccountRecord): ApiAccountSummary {
  const { id, provider, label, status, workspaceId, createdAt } = account;
  return { id, provider, label, email: null, status, workspaceId, createdAt };
}

/** Separate encrypted vault for user-supplied API credentials; never stores OAuth sessions. */
export class ApiAccountStore {
  private readonly filePath: string;
  private readonly protector: CredentialProtector;
  private vault: ApiAccountVault | null = null;
  private initialization: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: ApiAccountStoreOptions) {
    if (!options.userDataPath) throw new ApiAccountStoreError("STORAGE_UNAVAILABLE", "An app data directory is required.");
    this.filePath = path.join(options.userDataPath, "provider-accounts.v1.bin");
    this.protector = options.protector ?? electronCredentialProtector;
  }

  initialize(): Promise<void> {
    if (this.vault) return Promise.resolve();
    if (this.initialization) return this.initialization;
    this.initialization = this.load().finally(() => { this.initialization = null; });
    return this.initialization;
  }

  listAccounts(): ApiAccountSummary[] {
    return this.requireVault().accounts.map(summary);
  }

  getSelectedAccountId(): string | null {
    return this.requireVault().selectedAccountId;
  }

  getCredential(id: string): ApiAccountCredential {
    const account = this.requireAccount(id);
    return {
      provider: account.provider,
      apiKey: account.apiKey,
      ...(account.workspaceId ? { workspaceId: account.workspaceId } : {}),
    };
  }

  async addAccount(input: AddApiAccountInput): Promise<ApiAccountSummary> {
    if (!isProvider(input?.provider)) throw new ApiAccountStoreError("INVALID_PROVIDER", "Choose a supported provider.");
    const provider = input.provider;
    const label = validateLabel(input.label);
    const apiKey = validateApiKey(input.apiKey);
    const workspaceId = validateWorkspaceId(provider, input.workspaceId);
    return this.mutate((draft) => {
      this.requireUniqueLabel(draft, provider, label);
      const account: ApiAccountRecord = {
        id: randomUUID(), provider, label, email: null, status: "ready", workspaceId,
        createdAt: new Date().toISOString(), apiKey,
      };
      draft.accounts.push(account);
      if (draft.selectedAccountId === null) draft.selectedAccountId = account.id;
      return summary(account);
    });
  }

  async renameAccount(id: string, value: string): Promise<ApiAccountSummary> {
    const label = validateLabel(value);
    return this.mutate((draft) => {
      const account = this.requireAccountIn(draft, id);
      this.requireUniqueLabel(draft, account.provider, label, id);
      account.label = label;
      return summary(account);
    });
  }

  async replaceKey(id: string, value: string): Promise<ApiAccountSummary> {
    const apiKey = validateApiKey(value);
    return this.mutate((draft) => {
      const account = this.requireAccountIn(draft, id);
      account.apiKey = apiKey;
      account.status = "ready";
      return summary(account);
    });
  }

  removeAccount(id: string): Promise<void> {
    return this.mutate((draft) => {
      const index = draft.accounts.findIndex((account) => account.id === id);
      if (index < 0) throw new ApiAccountStoreError("NOT_FOUND", "Saved account was not found.");
      draft.accounts.splice(index, 1);
      if (draft.selectedAccountId === id) draft.selectedAccountId = null;
    });
  }

  markInvalid(id: string): Promise<ApiAccountSummary> {
    return this.setStatus(id, "invalid");
  }

  markReady(id: string): Promise<ApiAccountSummary> {
    return this.setStatus(id, "ready");
  }

  async setSelectedAccountId(id: string | null): Promise<void> {
    if (id !== null && !isSelectedId(id)) throw new ApiAccountStoreError("NOT_FOUND", "The selected account ID is invalid.");
    return this.mutate((draft) => {
      draft.selectedAccountId = id;
    });
  }

  private setStatus(id: string, status: ApiAccountStatus): Promise<ApiAccountSummary> {
    return this.mutate((draft) => {
      const account = this.requireAccountIn(draft, id);
      account.status = status;
      return summary(account);
    });
  }

  private requireVault(): ApiAccountVault {
    if (!this.vault) throw new ApiAccountStoreError("NOT_INITIALIZED", "Account storage is not ready.");
    return this.vault;
  }

  private requireAccount(id: string): ApiAccountRecord {
    return this.requireAccountIn(this.requireVault(), id);
  }

  private requireAccountIn(vault: ApiAccountVault, id: string): ApiAccountRecord {
    const account = vault.accounts.find((item) => item.id === id);
    if (!account) throw new ApiAccountStoreError("NOT_FOUND", "Saved account was not found.");
    return account;
  }

  private requireUniqueLabel(vault: ApiAccountVault, provider: ApiProvider, label: string, exceptId?: string): void {
    if (vault.accounts.some((item) => item.provider === provider && item.id !== exceptId && normalizedLabel(item.label) === normalizedLabel(label))) {
      throw new ApiAccountStoreError("LABEL_TAKEN", "This provider already has an account with that name.");
    }
  }

  private async load(): Promise<void> {
    if (!this.protector.isAvailable()) throw new ApiAccountStoreError("STORAGE_UNAVAILABLE", "Windows credential encryption is unavailable.");
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ApiAccountStoreError("STORAGE_UNAVAILABLE", "Could not read saved provider accounts.");
      const initial: ApiAccountVault = { version: 1, selectedAccountId: null, accounts: [] };
      await this.writeAtomically(initial);
      this.vault = initial;
      return;
    }
    try {
      const parsed: unknown = JSON.parse(this.protector.decrypt(encrypted));
      if (!isVault(parsed)) throw new Error("Unexpected vault format");
      this.vault = parsed;
    } catch {
      throw new ApiAccountStoreError("STORAGE_CORRUPT", "Saved provider accounts cannot be decrypted or read.");
    }
  }

  private mutate<T>(change: (draft: ApiAccountVault) => T): Promise<T> {
    const operation = this.mutationTail.then(async () => {
      const draft = structuredClone(this.requireVault());
      const result = change(draft);
      await this.writeAtomically(draft);
      this.vault = draft;
      return result;
    });
    this.mutationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async writeAtomically(vault: ApiAccountVault): Promise<void> {
    if (!this.protector.isAvailable()) throw new ApiAccountStoreError("STORAGE_UNAVAILABLE", "Windows credential encryption is unavailable.");
    let encrypted: Buffer;
    try {
      encrypted = this.protector.encrypt(JSON.stringify(vault));
    } catch {
      throw new ApiAccountStoreError("STORAGE_UNAVAILABLE", "Could not encrypt provider accounts.");
    }
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(encrypted);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.filePath);
    } catch {
      throw new ApiAccountStoreError("STORAGE_UNAVAILABLE", "Could not save provider accounts.");
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
