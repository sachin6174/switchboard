import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { safeStorage } from "electron";

/** The caller must keep these records in the Electron main process. */
export interface CredentialRecord {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  tokenType: "Bearer";
  scopes: string[];
  savedAt: string;
  expiresAt: string;
  earliestRefreshAt: string | null;
}

export interface AccountRecord {
  id: string;
  label: string;
  email: string | null;
  issuer: string;
  subject: string;
  clientId: string;
  createdAt: string;
  credentials: CredentialRecord | null;
  /** Rotated refresh credentials awaiting ID-token verification after a JWKS outage. */
  pendingCredentials?: CredentialRecord | null;
}

export interface AccountVault {
  version: 1;
  hostId: string;
  activeAccountId: string | null;
  accounts: AccountRecord[];
}

/** Electron safeStorage uses Windows DPAPI when encryption is available. */
export interface CredentialProtector {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export const electronCredentialProtector: CredentialProtector = {
  isAvailable: () => Boolean(safeStorage?.isEncryptionAvailable()),
  encrypt: (value) => safeStorage.encryptString(value),
  decrypt: (value) => safeStorage.decryptString(value),
};

export class VaultError extends Error {
  constructor(public readonly code: "STORAGE_UNAVAILABLE" | "STORAGE_CORRUPT", message: string) {
    super(message);
    this.name = "VaultError";
  }
}

function newVault(): AccountVault {
  return {
    version: 1,
    hostId: `urn:uuid:${randomUUID()}`,
    activeAccountId: null,
    accounts: [],
  };
}

function isCredential(value: unknown): value is CredentialRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CredentialRecord>;
  return typeof record.accessToken === "string" &&
    typeof record.refreshToken === "string" &&
    typeof record.idToken === "string" &&
    record.tokenType === "Bearer" &&
    Array.isArray(record.scopes) &&
    record.scopes.every((scope) => typeof scope === "string") &&
    typeof record.savedAt === "string" &&
    typeof record.expiresAt === "string" &&
    (record.earliestRefreshAt === null || typeof record.earliestRefreshAt === "string");
}

function isVault(value: unknown): value is AccountVault {
  if (!value || typeof value !== "object") return false;
  const vault = value as Partial<AccountVault>;
  return vault.version === 1 &&
    typeof vault.hostId === "string" &&
    vault.hostId.startsWith("urn:uuid:") &&
    (vault.activeAccountId === null || typeof vault.activeAccountId === "string") &&
    Array.isArray(vault.accounts) &&
    vault.accounts.every((value: unknown) => {
      if (!value || typeof value !== "object") return false;
      const account = value as Partial<AccountRecord>;
      return typeof account.id === "string" &&
        typeof account.label === "string" &&
        (account.email === null || typeof account.email === "string") &&
        typeof account.issuer === "string" &&
        typeof account.subject === "string" &&
        typeof account.clientId === "string" &&
        typeof account.createdAt === "string" &&
        (account.credentials === null || isCredential(account.credentials)) &&
        (account.pendingCredentials === undefined || account.pendingCredentials === null || isCredential(account.pendingCredentials));
    });
}

/** One encrypted, atomically replaced vault keeps host identity and accounts together. */
export class AccountStore {
  private readonly filePath: string;
  private saveTail: Promise<void> = Promise.resolve();

  constructor(
    userDataPath: string,
    private readonly protector: CredentialProtector = electronCredentialProtector,
  ) {
    this.filePath = path.join(userDataPath, "chatgpt-accounts.v1.bin");
  }

  async load(): Promise<AccountVault> {
    if (!this.protector.isAvailable()) {
      throw new VaultError("STORAGE_UNAVAILABLE", "Windows credential encryption is unavailable.");
    }
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const initial = newVault();
      await this.save(initial);
      return initial;
    }
    try {
      const parsed: unknown = JSON.parse(this.protector.decrypt(encrypted));
      if (!isVault(parsed)) throw new Error("Unexpected vault format");
      return parsed;
    } catch {
      throw new VaultError("STORAGE_CORRUPT", "Saved ChatGPT accounts cannot be decrypted or read.");
    }
  }

  save(vault: AccountVault): Promise<void> {
    if (!this.protector.isAvailable()) {
      return Promise.reject(new VaultError("STORAGE_UNAVAILABLE", "Windows credential encryption is unavailable."));
    }
    // Snapshot before enqueueing; callers can safely keep mutating their in-memory copy.
    const snapshot = JSON.stringify(vault);
    const operation = this.saveTail.then(() => this.writeAtomically(snapshot));
    this.saveTail = operation.catch(() => undefined);
    return operation;
  }

  private async writeAtomically(value: string): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const encrypted = this.protector.encrypt(value);
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(encrypted);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.filePath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
