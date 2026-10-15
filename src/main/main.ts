import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { nextEligibleAccount } from "./account-selection";
import { VaultError } from "./account-store";
import { ApiAccountStore, ApiAccountStoreError, type ApiProvider } from "./api-account-store";
import { ApiChatService } from "./api-chat";
import { AuthError, AuthManager } from "./auth";
import { ChatService, ChatServiceError, type ChatEvent } from "./chat";
import { ClaudeSubscriptionError, ClaudeSubscriptionManager } from "./claude-login";
import { ClaudeSubscriptionChatService } from "./claude-subscription-chat";
import { AiswitchClient, AiswitchError, findOnPath, findScript, FULL_PERMISSION_ARGS, LINUX_TERMINALS, requireAccountName, requireTool, RESUME_ARGS, terminalLaunch } from "./aiswitch";
import { FolderError, FolderStore } from "./folders";
import { TerminalError, TerminalManager } from "./terminals";
import type { AiswitchToolId } from "../shared/aiswitch";
import type { AiswitchReadMode } from "../shared/aiswitch";
import type { AccountSummary } from "../shared/contracts";

const APP_NAME = "Switchboard";
const USAGE_URLS = {
  chatgpt: "https://chatgpt.com/settings/usage",
  claude_subscription: "https://claude.ai/settings/usage",
  claude_api: "https://platform.claude.com/usage",
  antigravity_api: "https://aistudio.google.com/rate-limit",
} as const;
const PRODUCT_URLS = {
  chatgpt: "https://chatgpt.com/",
  claude_subscription: "https://claude.ai/",
  claude_api: "https://claude.ai/",
  antigravity_api: "https://antigravity.google/",
} as const;
const CLI_USAGE_URLS = {
  claude: "https://claude.ai/settings/usage",
  codex: "https://chatgpt.com/codex/settings/usage",
  agy: "https://antigravity.google/",
} as const;
type ProviderName = keyof typeof USAGE_URLS;

function requireProvider(value: unknown): ProviderName {
  if (value === "chatgpt" || value === "claude_subscription" || value === "claude_api" || value === "antigravity_api") return value;
  throw new ChatServiceError("validation", "Unknown account provider.");
}

function requireApiProvider(value: unknown): ApiProvider {
  if (value === "claude_api" || value === "antigravity_api") return value;
  throw new ChatServiceError("validation", "Choose a supported API provider.");
}

app.setName(APP_NAME);
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();

let mainWindow: BrowserWindow | null = null;

type SafeError = { message: string; code?: string; kind?: string; status?: number };
type IpcResult<T> = { ok: true; data: T } | { ok: false; error: SafeError };
type UnifiedAccountSummary = {
  id: string;
  label: string;
  email: string | null;
  provider: ProviderName;
  connectionKind: "oauth" | "api_key";
  active: boolean;
  status: AccountSummary["status"] | "signing_in" | "ready" | "invalid";
  planUsageEnabled: boolean;
  accessTokenExpiresAt: string | null;
  workspaceId?: string | null;
};

function toSafeError(error: unknown): SafeError {
  if (error instanceof AuthError) {
    return { message: error.message.slice(0, 500), code: error.code, status: error.details.status };
  }
  if (error instanceof ClaudeSubscriptionError) {
    return { message: error.message.slice(0, 500), code: error.code };
  }
  if (error instanceof ApiAccountStoreError) {
    return { message: error.message.slice(0, 500), code: error.code };
  }
  if (error instanceof VaultError) {
    return { message: error.message.slice(0, 500), code: error.code };
  }
  if (error instanceof ChatServiceError) {
    return { message: error.message.slice(0, 500), kind: error.kind, code: error.code, status: error.status };
  }
  if (error instanceof AiswitchError || error instanceof FolderError || error instanceof TerminalError) {
    return { message: error.message.slice(0, 500), code: error.code };
  }
  return { message: "The action could not be completed. Please try again." };
}

function requireText(value: unknown, name: string, maximum = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new ChatServiceError("validation", `${name} is invalid.`);
  }
  return value;
}

function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#090d16",
    title: APP_NAME,
    show: true,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  window.show();
  window.focus();
  window.on("closed", () => { if (mainWindow === window) mainWindow = null; });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  return window.loadFile(path.join(__dirname, "..", "renderer", "index.html")).catch((err) => {
    console.error("Failed to load renderer index.html:", err);
  });
}

function registerHandler<T>(channel: string, task: (...args: unknown[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<T>> => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      return { ok: false, error: { message: "This window is not allowed to use the account service." } };
    }
    try {
      return { ok: true, data: await task(...args) };
    } catch (error) {
      return { ok: false, error: toSafeError(error) };
    }
  });
}

// Opens a visible terminal running a command, e.g. `aiswitch add codex work` for a new sign-in.
// The terminal is detached so it keeps running after Switchboard.
function openTerminal(command: string, args: string[], cwd?: string, title?: string): void {
  const linuxTerminal = process.platform === "linux" ? findOnPath(LINUX_TERMINALS, process.env.PATH) : null;
  const launch = terminalLaunch(process.platform, command, args, linuxTerminal, cwd, title);
  const child = spawn(launch.command, launch.args, launch.options);
  child.on("error", (error) => console.warn("Could not open a terminal:", error));
  child.unref();
}

const CLI_TITLES = { claude: "Claude Code", codex: "Codex", agy: "Antigravity" } as const;

// The CLI-account and folder handlers don't use the credential vaults, so they are registered
// before the vaults open (which can wait on a macOS Keychain prompt).
function registerWorkspaceHandlers(userDataPath: string): void {
  // Account switching for the coding CLIs is done by tools/aiswitch/aiswitch.py; created on first use.
  let aiswitchClient: AiswitchClient | null = null;
  const aiswitch = (): AiswitchClient => {
    aiswitchClient ??= new AiswitchClient({ script: findScript(__dirname, process.resourcesPath) });
    return aiswitchClient;
  };
  registerHandler("aiswitch:status", (mode) => {
    const read: AiswitchReadMode = mode === "background" || mode === "refresh" ? mode : "initial";
    return aiswitch().status(read);
  });
  registerHandler("aiswitch:use", async (tool, name) => ({ warning: (await aiswitch().use(requireTool(tool), requireAccountName(name))).warning ?? null }));
  registerHandler("aiswitch:remove", async (tool, name) => { await aiswitch().remove(requireTool(tool), requireAccountName(name)); });
  registerHandler("aiswitch:reset-limit", async (tool, name) => {
    await aiswitch().resetLimit(requireTool(tool), name === undefined ? undefined : requireAccountName(name));
  });
  registerHandler("aiswitch:auto-switch", async (on) => { await aiswitch().setAutoSwitch(on === true); });
  registerHandler("aiswitch:add", async (tool, name) => {
    const login = await aiswitch().addAccountCommand(requireTool(tool), requireAccountName(name));
    openTerminal(login.command, login.args);
  });
  registerHandler("aiswitch:open-usage", async (tool) => { await shell.openExternal(CLI_USAGE_URLS[requireTool(tool)]); });

  const folders = new FolderStore(userDataPath);
  registerHandler("folders:list", () => folders.list());
  registerHandler("folders:add", async () => {
    const picked = await dialog.showOpenDialog(mainWindow!, { title: "Add a project folder", properties: ["openDirectory", "createDirectory"] });
    return picked.canceled || picked.filePaths.length === 0 ? null : folders.add(picked.filePaths[0]);
  });
  registerHandler("folders:remove", (id) => { folders.remove(requireText(id, "Folder ID", 100)); });
  // Terminals shown inside the app; output streams to the window as it arrives.
  const terminals = new TerminalManager({
    data: (id, seq, data) => mainWindow?.webContents.send("term:data", { id, seq, data }),
    exit: (id, code) => mainWindow?.webContents.send("term:exit", { id, code }),
  });
  app.on("before-quit", () => terminals.closeAll());

  // Each CLI runs through aiswitch in full-permission mode; `resume` continues its last conversation.
  const cliCommand = (tool: AiswitchToolId, resume: boolean) =>
    aiswitch().runCommand(tool, [...(resume ? RESUME_ARGS[tool] : []), ...FULL_PERMISSION_ARGS[tool]]);
  const openOutside = async (tool: AiswitchToolId, folder: { path: string; name: string }, resume: boolean) => {
    const run = await cliCommand(tool, resume);
    openTerminal(run.command, run.args, folder.path, `${CLI_TITLES[tool]} · ${folder.name}`);
  };
  const openInside = async (tool: AiswitchToolId, folder: { id: string; path: string; name: string }, resume: boolean, size?: unknown) => {
    const run = await cliCommand(tool, resume);
    const dims = size as { cols?: number; rows?: number } | undefined;
    return terminals.start(run, { tool, folderId: folder.id, folderName: folder.name, cwd: folder.path, title: `${CLI_TITLES[tool]} · ${folder.name}` },
      { cols: Number(dims?.cols) || 100, rows: Number(dims?.rows) || 30 });
  };
  const requireTools = (tools: unknown): AiswitchToolId[] =>
    Array.isArray(tools) && tools.length > 0 ? tools.map(requireTool) : ["agy", "codex", "claude"];

  registerHandler("folders:open", async (id, tools, placement, resume, size) => {
    const folder = folders.open(requireText(id, "Folder ID", 100));
    const opened = [];
    for (const tool of requireTools(tools)) {
      if (placement === "inside") opened.push(await openInside(tool, folder, resume === true, size));
      else await openOutside(tool, folder, resume === true);
    }
    return { folder, terminals: opened };
  });
  registerHandler("term:list", () => terminals.list());
  registerHandler("term:buffer", (id) => terminals.buffer(requireText(id, "Terminal ID", 100)));
  registerHandler("term:write", (id, data) => { terminals.write(requireText(id, "Terminal ID", 100), typeof data === "string" ? data : ""); });
  registerHandler("term:resize", (id, cols, rows) => { terminals.resize(requireText(id, "Terminal ID", 100), Number(cols), Number(rows)); });
  registerHandler("term:close", (id) => { terminals.close(requireText(id, "Terminal ID", 100)); });
  // Moves a conversation out of the app: stop it here, continue it in a terminal window.
  registerHandler("term:pop-out", async (id) => {
    const closed = terminals.close(requireText(id, "Terminal ID", 100));
    if (!closed) throw new TerminalError("CLOSED", "That terminal is closed.");
    await openOutside(closed.tool, { path: closed.cwd, name: closed.folderName }, true);
    return closed;
  });
}

async function start(): Promise<void> {
  await app.whenReady();
  const loaded = createWindow();
  const userDataPath = app.getPath("userData");
  registerWorkspaceHandlers(userDataPath);
  // Let the page paint before the vaults open: on macOS that can wait on a Keychain prompt,
  // which blocks this process and would otherwise leave the window blank.
  await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 5000))]);
  const openExternal = async (url: string) => { await shell.openExternal(url); };
  let auth!: AuthManager;
  let apiAccounts!: ApiAccountStore;
  let claudeAccounts!: ClaudeSubscriptionManager;
  const constructStores = () => {
    auth = new AuthManager({ userDataPath, appName: APP_NAME, openExternal });
    apiAccounts = new ApiAccountStore({ userDataPath });
    claudeAccounts = new ClaudeSubscriptionManager({ userDataPath });
  };
  const initializeStores = () => Promise.all([auth.initialize(), apiAccounts.initialize(), claudeAccounts.initialize()]);

  // Corrupt saved-account files (for example, credential vaults synced from another
  // Windows machine) are moved aside once so Switchboard can start with a fresh list.
  function corruptStoreFile(error: unknown): string | null {
    if (error instanceof VaultError && error.code === "STORAGE_CORRUPT") return path.join(userDataPath, "chatgpt-accounts.v1.bin");
    if (error instanceof ApiAccountStoreError && error.code === "STORAGE_CORRUPT") return path.join(userDataPath, "provider-accounts.v1.bin");
    if (error instanceof ClaudeSubscriptionError && error.code === "STORAGE_CORRUPT") return path.join(userDataPath, "claude-subscriptions.v1.json");
    return null;
  }

  const recoveredBackups: string[] = [];
  let storesReady = false;
  constructStores();
  for (let attempt = 0; attempt < 3 && !storesReady; attempt += 1) {
    try {
      await initializeStores();
      storesReady = true;
    } catch (error) {
      const corruptFile = corruptStoreFile(error);
      if (!corruptFile || !fs.existsSync(corruptFile)) {
        dialog.showErrorBox("Switchboard could not open", toSafeError(error).message);
        app.quit();
        return;
      }
      const backupPath = `${corruptFile}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(corruptFile, backupPath);
        recoveredBackups.push(backupPath);
      } catch {
        dialog.showErrorBox("Switchboard could not open", toSafeError(error).message);
        app.quit();
        return;
      }
      constructStores();
    }
  }
  if (!storesReady) {
    dialog.showErrorBox("Switchboard could not open", "Saved account files could not be read.");
    app.quit();
    return;
  }
  if (recoveredBackups.length > 0) {
    const recoveryMessage = {
      type: "warning" as const,
      title: "Saved accounts were reset",
      message: "Some saved accounts could not be read and were removed from Switchboard.",
      detail: `The unreadable files were backed up:\n${recoveredBackups.join("\n")}\n\nSign in again to reconnect those accounts.`,
    };
    if (mainWindow) void dialog.showMessageBox(mainWindow, recoveryMessage);
    else void dialog.showMessageBox(recoveryMessage);
  }

  const chat = new ChatService({ dataDir: userDataPath });
  const apiChat = new ApiChatService({ dataDir: userDataPath });
  const claudeChat = new ClaudeSubscriptionChatService({ dataDir: userDataPath });
  const closingAccounts = new Set<string>();
  type ActiveRequest = { controller: AbortController; settled: Promise<void> };
  const inFlightChats = new Map<string, ActiveRequest>();
  const inFlightModels = new Map<string, Set<ActiveRequest>>();
  async function stopAccountRequests(accountId: string): Promise<void> {
    const requests = [
      ...(inFlightChats.get(accountId) ? [inFlightChats.get(accountId)!] : []),
      ...(inFlightModels.get(accountId) ?? []),
    ];
    requests.forEach((request) => request.controller.abort());
    await Promise.all(requests.map((request) => request.settled));
  }

  function listAccounts(): UnifiedAccountSummary[] {
    const selectedId = apiAccounts.getSelectedAccountId();
    const chatGptAccounts: UnifiedAccountSummary[] = auth.listAccounts().map((account) => ({
      ...account,
      provider: "chatgpt",
      connectionKind: "oauth",
      active: selectedId === account.id,
    }));
    const apiKeyAccounts: UnifiedAccountSummary[] = apiAccounts.listAccounts().map((account) => ({
      ...account,
      connectionKind: "api_key",
      active: selectedId === account.id,
      planUsageEnabled: false,
      accessTokenExpiresAt: null,
    }));
    const claudeSubscriptionAccounts: UnifiedAccountSummary[] = claudeAccounts.listAccounts().map((account) => ({
      ...account,
      provider: "claude_subscription",
      connectionKind: "oauth",
      active: selectedId === account.id,
      planUsageEnabled: account.status === "connected",
      accessTokenExpiresAt: null,
    }));
    return [...chatGptAccounts, ...claudeSubscriptionAccounts, ...apiKeyAccounts];
  }

  function requireAccount(id: string): UnifiedAccountSummary {
    const account = listAccounts().find((item) => item.id === id);
    if (!account) throw new AuthError("NOT_FOUND", "Saved account was not found.");
    return account;
  }

  async function selectAccount(id: string): Promise<UnifiedAccountSummary> {
    const account = requireAccount(id);
    if (account.provider === "chatgpt") await auth.activateAccount(id);
    await apiAccounts.setSelectedAccountId(id);
    mainWindow?.webContents.send("accounts:changed");
    return { ...account, active: true };
  }

  async function selectNextWithinProvider(provider: ProviderName, afterId: string, force = false): Promise<UnifiedAccountSummary | null> {
    if (!force && apiAccounts.getSelectedAccountId() !== afterId) return listAccounts().find((account) => account.active) ?? null;
    const candidate = nextEligibleAccount(listAccounts(), provider, afterId);
    if (candidate) return selectAccount(candidate.id);
    if (!force && listAccounts().some((account) => account.id === afterId)) {
      mainWindow?.webContents.send("accounts:changed");
      return null;
    }
    await apiAccounts.setSelectedAccountId(null);
    mainWindow?.webContents.send("accounts:changed");
    return null;
  }

  async function handleCredentialFailure(account: UnifiedAccountSummary, error: unknown): Promise<void> {
    if (!(error instanceof ChatServiceError) || error.kind !== "auth") return;
    if (account.provider === "chatgpt" || closingAccounts.has(account.id)) return;
    if (account.provider === "claude_subscription") {
      if (!claudeAccounts.listAccounts().some((item) => item.id === account.id)) return;
      await claudeAccounts.markNeedsSignIn(account.id);
      mainWindow?.webContents.send("accounts:changed");
      if (apiAccounts.getSelectedAccountId() === account.id) {
        const next = await selectNextWithinProvider("claude_subscription", account.id);
        mainWindow?.webContents.send("session:recovery", { fromLabel: account.label, toLabel: next?.label ?? null });
      }
      return;
    }
    if (!apiAccounts.listAccounts().some((item) => item.id === account.id)) return;
    const wasActive = apiAccounts.getSelectedAccountId() === account.id;
    await apiAccounts.markInvalid(account.id);
    mainWindow?.webContents.send("accounts:changed");
    if (wasActive) {
      const next = await selectNextWithinProvider(account.provider, account.id);
      mainWindow?.webContents.send("session:recovery", { fromLabel: account.label, toLabel: next?.label ?? null });
    }
  }

  const savedSelection = apiAccounts.getSelectedAccountId();
  if (!savedSelection || !listAccounts().some((account) => account.id === savedSelection)) {
    const initialId = auth.getActiveAccount()?.id ?? listAccounts()[0]?.id ?? null;
    if (initialId) await apiAccounts.setSelectedAccountId(initialId);
  }

  registerHandler("accounts:list", () => listAccounts());
  registerHandler("accounts:add", async () => {
    const selectedBeforeSignIn = apiAccounts.getSelectedAccountId();
    const added = await auth.addAccount();
    const selectedNow = apiAccounts.getSelectedAccountId();
    if (selectedNow !== selectedBeforeSignIn || (selectedNow && inFlightChats.has(selectedNow))) {
      mainWindow?.webContents.send("accounts:changed");
      return requireAccount(added.id);
    }
    return selectAccount(added.id);
  });
  registerHandler("accounts:add-claude", async (label) => {
    const selectedBeforeSignIn = apiAccounts.getSelectedAccountId();
    const added = await claudeAccounts.addAccount(requireText(label, "Account name", 80));
    mainWindow?.webContents.send("accounts:changed");
    const selectedNow = apiAccounts.getSelectedAccountId();
    if (selectedNow !== selectedBeforeSignIn || (selectedNow && inFlightChats.has(selectedNow))) return requireAccount(added.id);
    return selectAccount(added.id);
  });
  registerHandler("accounts:add-api", async (provider, label, apiKey, workspaceId) => {
    const added = await apiAccounts.addAccount({
      provider: requireApiProvider(provider),
      label: requireText(label, "Account name", 80),
      apiKey: requireText(apiKey, "API key", 4096),
      ...(workspaceId === undefined || workspaceId === null || workspaceId === "" ? {} : { workspaceId: requireText(workspaceId, "Workspace ID", 200) }),
    });
    const selected = await selectAccount(added.id);
    return selected;
  });
  registerHandler("accounts:activate", (id) => {
    const accountId = requireText(id, "Account ID");
    const activeId = apiAccounts.getSelectedAccountId();
    if (activeId && activeId !== accountId && inFlightChats.has(activeId)) {
      throw new ChatServiceError("validation", "Wait for the current response before switching accounts.");
    }
    if (closingAccounts.has(accountId)) throw new ChatServiceError("validation", "This account is disconnecting.");
    return selectAccount(accountId);
  });
  registerHandler("accounts:rename", async (id, label) => {
    const account = requireAccount(requireText(id, "Account ID"));
    const name = requireText(label, "Account name", 80);
    if (account.provider === "chatgpt") await auth.renameAccount(account.id, name);
    else if (account.provider === "claude_subscription") await claudeAccounts.renameAccount(account.id, name);
    else await apiAccounts.renameAccount(account.id, name);
    mainWindow?.webContents.send("accounts:changed");
    return requireAccount(account.id);
  });
  registerHandler("accounts:reconnect", async (id) => {
    const account = requireAccount(requireText(id, "Account ID"));
    if (account.connectionKind !== "oauth") throw new ChatServiceError("validation", "Use Replace API key for this account.");
    if (closingAccounts.has(account.id)) throw new ChatServiceError("validation", "This account is already changing.");
    closingAccounts.add(account.id);
    try {
      await stopAccountRequests(account.id);
      if (account.provider === "chatgpt" ? chat.isBusy(account.id) : claudeChat.isBusy(account.id)) {
        throw new ChatServiceError("validation", "Wait for the current account action to finish.");
      }
      if (account.provider === "chatgpt") await auth.reconnectAccount(account.id);
      else await claudeAccounts.reconnectAccount(account.id);
      return selectAccount(account.id);
    } finally {
      closingAccounts.delete(account.id);
    }
  });
  registerHandler("accounts:replace-key", async (id, apiKey) => {
    const account = requireAccount(requireText(id, "Account ID"));
    if (account.connectionKind === "oauth") throw new ChatServiceError("validation", "This account uses browser sign-in.");
    const replacement = requireText(apiKey, "API key", 4096);
    if (closingAccounts.has(account.id)) throw new ChatServiceError("validation", "This connection is already changing.");
    closingAccounts.add(account.id);
    try {
      await stopAccountRequests(account.id);
      if (apiChat.isBusy(account.id)) throw new ChatServiceError("validation", "Wait for the current account action to finish.");
      await apiAccounts.replaceKey(account.id, replacement);
      apiChat.resumeAccount(account.id);
      mainWindow?.webContents.send("accounts:changed");
      return requireAccount(account.id);
    } finally {
      closingAccounts.delete(account.id);
    }
  });
  registerHandler("accounts:sign-out", async (id) => {
    const accountId = requireText(id, "Account ID");
    const account = requireAccount(accountId);
    if (account.connectionKind !== "oauth") throw new ChatServiceError("validation", "Remove this API key account to disconnect it.");
    if (closingAccounts.has(accountId)) throw new ChatServiceError("validation", "This account is already disconnecting.");
    closingAccounts.add(accountId);
    try {
      await stopAccountRequests(accountId);
      if (account.provider === "chatgpt" ? chat.isBusy(accountId) : claudeChat.isBusy(accountId)) throw new ChatServiceError("validation", "Wait for the current account action to finish.");
      const result = account.provider === "chatgpt" ? await auth.signOutAccount(accountId) : await claudeAccounts.signOutAccount(accountId);
      await selectNextWithinProvider(account.provider, accountId);
      return result;
    } finally {
      closingAccounts.delete(accountId);
    }
  });
  registerHandler("accounts:remove", async (id) => {
    const accountId = requireText(id, "Account ID");
    const account = requireAccount(accountId);
    const wasActive = apiAccounts.getSelectedAccountId() === accountId;
    if (closingAccounts.has(accountId)) throw new ChatServiceError("validation", "This account is already disconnecting.");
    closingAccounts.add(accountId);
    try {
      await stopAccountRequests(accountId);
      if (account.provider === "chatgpt") {
        await chat.deleteAccountData(accountId);
        const result = await auth.removeAccount(accountId);
        if (wasActive) await selectNextWithinProvider("chatgpt", accountId, true);
        return result;
      }
      if (account.provider === "claude_subscription") {
        await claudeChat.deleteAccountData(accountId);
        const result = await claudeAccounts.removeAccount(accountId);
        if (wasActive) await selectNextWithinProvider("claude_subscription", accountId, true);
        mainWindow?.webContents.send("accounts:changed");
        return result;
      }
      await apiChat.deleteAccountData(accountId);
      await apiAccounts.removeAccount(accountId);
      mainWindow?.webContents.send("accounts:changed");
      if (wasActive) await selectNextWithinProvider(account.provider, accountId, true);
      return { revocationConfirmed: true };
    } finally {
      closingAccounts.delete(accountId);
    }
  });
  registerHandler("chat:conversation", (id) => {
    const accountId = requireText(id, "Account ID");
    const account = requireAccount(accountId);
    return account.provider === "chatgpt" ? chat.getConversation(accountId) : account.provider === "claude_subscription" ? claudeChat.getConversation(accountId) : apiChat.getConversation(accountId);
  });
  registerHandler("chat:clear", (id) => {
    const accountId = requireText(id, "Account ID");
    if (closingAccounts.has(accountId)) throw new ChatServiceError("validation", "This account is disconnecting.");
    const account = requireAccount(accountId);
    return account.provider === "chatgpt" ? chat.clearConversation(accountId) : account.provider === "claude_subscription" ? claudeChat.clearConversation(accountId) : apiChat.clearConversation(accountId);
  });
  registerHandler("chat:models", async (id) => {
    const accountId = requireText(id, "Account ID");
    const account = requireAccount(accountId);
    if (closingAccounts.has(accountId)) throw new ChatServiceError("validation", "This account is disconnecting.");
    const controller = new AbortController();
    const work = (async () => {
      if (account.provider === "chatgpt") {
        const accessToken = await auth.getAccessToken(accountId);
        if (controller.signal.aborted || closingAccounts.has(accountId)) throw new ChatServiceError("interrupted", "This account is disconnecting.");
        return chat.listModels(accessToken, controller.signal);
      }
      if (account.provider === "claude_subscription") {
        return claudeChat.listModels();
      }
      const credential = apiAccounts.getCredential(accountId);
      const models = await apiChat.listModels({ ...credential, signal: controller.signal });
      if (controller.signal.aborted || closingAccounts.has(accountId)) throw new ChatServiceError("interrupted", "This account is disconnecting.");
      if (account.status === "invalid") {
        await apiAccounts.markReady(accountId);
        mainWindow?.webContents.send("accounts:changed");
      }
      return models;
    })();
    const request = { controller, settled: work.then(() => undefined, () => undefined) };
    const requests = inFlightModels.get(accountId) ?? new Set<ActiveRequest>();
    requests.add(request);
    inFlightModels.set(accountId, requests);
    try {
      return await work;
    } catch (error) {
      await handleCredentialFailure(account, error);
      throw error;
    } finally {
      requests.delete(request);
      if (requests.size === 0) inFlightModels.delete(accountId);
    }
  });
  registerHandler("chat:send", async (id, model, content) => {
    const accountId = requireText(id, "Account ID");
    const account = requireAccount(accountId);
    const selectedModel = requireText(model, "Model", 200);
    const message = requireText(content, "Message", 100_000);
    if (closingAccounts.has(accountId)) throw new ChatServiceError("validation", "This account is disconnecting.");
    if (inFlightChats.has(accountId)) throw new ChatServiceError("validation", "A response is already in progress for this account.");
    if (apiAccounts.getSelectedAccountId() !== accountId) throw new AuthError("NO_ACTIVE_ACCOUNT", "Select this account before sending a message.");
    const controller = new AbortController();
    const work = (async () => {
      if (account.provider === "chatgpt") {
        const accessToken = await auth.getAccessToken(accountId);
        if (controller.signal.aborted || closingAccounts.has(accountId)) throw new ChatServiceError("interrupted", "The response was cancelled.");
        if (apiAccounts.getSelectedAccountId() !== accountId) throw new AuthError("NO_ACTIVE_ACCOUNT", "The active account changed. Try the message again.");
        return chat.sendMessage({ accountId, accessToken, model: selectedModel, content: message, signal: controller.signal }, (chatEvent: ChatEvent) => {
          mainWindow?.webContents.send("chat:event", chatEvent);
        });
      }
      if (account.provider === "claude_subscription") {
        if (controller.signal.aborted || closingAccounts.has(accountId)) throw new ChatServiceError("interrupted", "The response was cancelled.");
        return claudeChat.sendMessage({ accountId, configDir: claudeAccounts.getConfigDir(accountId), model: selectedModel, content: message, signal: controller.signal }, (chatEvent: ChatEvent) => {
          mainWindow?.webContents.send("chat:event", chatEvent);
        });
      }
      const credential = apiAccounts.getCredential(accountId);
      if (controller.signal.aborted || closingAccounts.has(accountId)) throw new ChatServiceError("interrupted", "The response was cancelled.");
      return apiChat.sendMessage({ accountId, ...credential, model: selectedModel, content: message, signal: controller.signal }, (chatEvent: ChatEvent) => {
        mainWindow?.webContents.send("chat:event", chatEvent);
      });
    })();
    const settled = work.then(() => undefined, () => undefined);
    inFlightChats.set(accountId, { controller, settled });
    try {
      return await work;
    } catch (error) {
      await handleCredentialFailure(account, error);
      throw error;
    } finally {
      if (inFlightChats.get(accountId)?.controller === controller) inFlightChats.delete(accountId);
    }
  });
  registerHandler("chat:retry", (id) => {
    const accountId = requireText(id, "Account ID");
    const account = requireAccount(accountId);
    if (account.provider === "chatgpt") chat.resumeAccount(accountId);
    else if (account.provider === "claude_subscription") claudeChat.resumeAccount(accountId);
    else apiChat.resumeAccount(accountId);
  });
  registerHandler("chat:rate-limit", (id) => {
    const account = requireAccount(requireText(id, "Account ID"));
    return account.provider === "claude_api" ? apiChat.getRateLimit(account.id) : null;
  });
  registerHandler("usage:all", async () => Promise.all(listAccounts().map(async (account) => {
    let localUsage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
    try {
      const conversation = account.provider === "chatgpt"
        ? await chat.getConversation(account.id)
        : account.provider === "claude_subscription"
          ? await claudeChat.getConversation(account.id)
          : await apiChat.getConversation(account.id);
      localUsage = conversation.usage;
    } catch {
      // One unreadable history must not hide the other accounts' usage.
      localUsage = null;
    }

    const limitPaused = account.provider === "chatgpt"
      ? chat.isPaused(account.id)
      : account.provider === "claude_subscription"
        ? claudeChat.isPaused(account.id)
        : apiChat.isPaused(account.id);

    if (account.provider === "claude_subscription") {
      const observed = claudeChat.getUsageSnapshot(account.id);
      if (observed) {
        return {
          accountId: account.id,
          localUsage,
          limitPaused,
          allowance: {
            kind: "claude_subscription_windows" as const,
            observedAt: observed.observedAt,
            windows: Object.entries(observed.windows).flatMap(([name, window]) => {
              if (!window) return [];
              const usedPercent = window.utilization !== null && Number.isFinite(window.utilization)
                && window.utilization >= 0 && window.utilization <= 100 ? window.utilization : null;
              return [{
                name,
                status: window.status,
                usedPercent,
                remainingPercent: usedPercent === null ? null : 100 - usedPercent,
                resetsAt: window.resetsAt,
              }];
            }),
          },
        };
      }
    }

    if (account.provider === "claude_api") {
      const observed = apiChat.getRateLimit(account.id);
      if (observed) {
        return {
          accountId: account.id,
          localUsage,
          limitPaused,
          allowance: { kind: "claude_api_rate_window" as const, ...observed },
        };
      }
    }

    return { accountId: account.id, localUsage, limitPaused, allowance: { kind: "unknown" as const } };
  })));
  registerHandler("usage:open", async (provider) => { await shell.openExternal(USAGE_URLS[provider === undefined ? "chatgpt" : requireProvider(provider)]); });
  registerHandler("provider:open", async (provider) => { await shell.openExternal(PRODUCT_URLS[requireProvider(provider)]); });

  auth.onAccountEvent((event) => {
    mainWindow?.webContents.send("accounts:changed");
    if (event.type === "terminal_refresh") {
      const expired = listAccounts().find((account) => account.id === event.accountId);
      if (apiAccounts.getSelectedAccountId() !== event.accountId) return;
      void stopAccountRequests(event.accountId).then(() => selectNextWithinProvider("chatgpt", event.accountId)).then((next) => {
        mainWindow?.webContents.send("session:recovery", {
          fromLabel: expired?.label ?? "An account",
          toLabel: next?.label ?? null,
        });
      }).catch(() => undefined);
    }
  });
  let checkingClaudeSessions = false;
  async function checkClaudeSessions(): Promise<void> {
    if (checkingClaudeSessions) return;
    checkingClaudeSessions = true;
    try {
      const before = new Map(claudeAccounts.listAccounts().map((account) => [account.id, account.status]));
      await claudeAccounts.refreshAllStatuses();
      const changed = claudeAccounts.listAccounts().some((account) => before.get(account.id) !== account.status);
      if (changed) mainWindow?.webContents.send("accounts:changed");
      const selectedId = apiAccounts.getSelectedAccountId();
      const selected = selectedId ? claudeAccounts.listAccounts().find((account) => account.id === selectedId) : undefined;
      if (!selected || selected.status === "connected") return;
      if (!changed && !nextEligibleAccount(listAccounts(), "claude_subscription", selected.id)) return;
      await stopAccountRequests(selected.id);
      const next = await selectNextWithinProvider("claude_subscription", selected.id);
      mainWindow?.webContents.send("session:recovery", { fromLabel: selected.label, toLabel: next?.label ?? null });
    } finally {
      checkingClaudeSessions = false;
    }
  }
  void checkClaudeSessions().catch(() => undefined);
  const claudeStatusTimer = setInterval(() => { void checkClaudeSessions().catch(() => undefined); }, 5 * 60_000);
  claudeStatusTimer.unref();
  auth.startBackgroundRefresh();
  app.on("before-quit", () => {
    clearInterval(claudeStatusTimer);
    for (const request of inFlightChats.values()) request.controller.abort();
    for (const requests of inFlightModels.values()) for (const request of requests) request.controller.abort();
    claudeAccounts.dispose();
    auth.stopBackgroundRefresh();
  });
}

if (hasInstanceLock) {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  start().catch((error) => {
    dialog.showErrorBox("Switchboard could not start", toSafeError(error).message);
    app.quit();
  });
}

app.on("window-all-closed", () => app.quit());
