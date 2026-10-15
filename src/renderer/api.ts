import type { AiswitchReadMode, AiswitchStatus, AiswitchToolId } from "../shared/aiswitch";
import type { ProjectFolder } from "../shared/folders";
import type { TerminalInfo, TerminalPlacement } from "../shared/terminals";

export type { ProjectFolder } from "../shared/folders";
export type { TerminalInfo, TerminalPlacement } from "../shared/terminals";

export type { AiswitchAccount, AiswitchEvent, AiswitchLimitRow, AiswitchReadMode, AiswitchStatus, AiswitchTokens, AiswitchToolId, AiswitchToolStatus } from "../shared/aiswitch";

export type AccountSummary = {
  id: string;
  label: string;
  email: string | null;
  active: boolean;
  provider: "chatgpt" | "claude_subscription" | "claude_api" | "antigravity_api";
  connectionKind: "oauth" | "api_key";
  status: "connected" | "needs_sign_in" | "signing_in" | "ready" | "invalid";
  planUsageEnabled: boolean;
  accessTokenExpiresAt: string | null;
};

export type ChatModel = { slug: string; displayName: string };
export type ChatUsage = { inputTokens: number; outputTokens: number; totalTokens: number };
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  model?: string;
  usage?: ChatUsage;
};
export type ChatConversation = { accountId: string; messages: ChatMessage[]; usage: ChatUsage };
export type AccountUsageSnapshot = {
  accountId: string;
  /** Tokens from completed requests made in Switchboard, not provider plan balance. */
  localUsage: ChatUsage | null;
  /** A provider limit was observed for this account and it is locally paused. */
  limitPaused: boolean;
  allowance:
    | { kind: "unknown" }
    | {
      kind: "claude_subscription_windows";
      observedAt: string;
      windows: Array<{
        name: string;
        status: "allowed" | "allowed_warning" | "rejected";
        usedPercent: number | null;
        remainingPercent: number | null;
        /** Raw SDK timestamp; callers should not assume a unit. */
        resetsAt: number | null;
      }>;
    }
    | { kind: "claude_api_rate_window"; remainingTokens: number | null; resetsAt: string | null };
};
export type ChatEvent =
  | { type: "delta"; accountId: string; delta: string }
  | { type: "completed"; accountId: string; message: ChatMessage }
  | { type: "usage"; accountId: string; usage: ChatUsage; totalUsage: ChatUsage };

export type BridgeError = Error & { code?: string; kind?: string; status?: number };

export type SwitchboardApi = {
  listAccounts: () => Promise<AccountSummary[]>;
  addAccount: () => Promise<AccountSummary>;
  addClaudeAccount: (label: string) => Promise<AccountSummary>;
  addApiAccount: (provider: "claude_api" | "antigravity_api", label: string, apiKey: string, workspaceId?: string) => Promise<AccountSummary>;
  replaceApiKey: (id: string, apiKey: string) => Promise<AccountSummary>;
  activateAccount: (id: string) => Promise<AccountSummary>;
  renameAccount: (id: string, label: string) => Promise<AccountSummary>;
  reconnectAccount: (id: string) => Promise<AccountSummary>;
  signOutAccount: (id: string) => Promise<{ revocationConfirmed: boolean }>;
  removeAccount: (id: string) => Promise<{ revocationConfirmed: boolean }>;
  getConversation: (id: string) => Promise<ChatConversation>;
  clearConversation: (id: string) => Promise<void>;
  listModels: (id: string) => Promise<ChatModel[]>;
  sendMessage: (id: string, model: string, content: string) => Promise<ChatMessage>;
  retryAccount: (id: string) => Promise<void>;
  getRateLimit: (id: string) => Promise<{ remainingTokens: number | null; resetsAt: string | null } | null>;
  getAccountUsage: () => Promise<AccountUsageSnapshot[]>;
  openUsage: (provider?: AccountSummary["provider"]) => Promise<void>;
  openProvider: (provider: AccountSummary["provider"]) => Promise<void>;
  getAiswitchStatus: (mode: AiswitchReadMode) => Promise<AiswitchStatus>;
  useAiswitchAccount: (tool: AiswitchToolId, name: string) => Promise<{ warning: string | null }>;
  /** Opens a terminal where the user signs in; the new account appears after that finishes. */
  addAiswitchAccount: (tool: AiswitchToolId, name: string) => Promise<void>;
  removeAiswitchAccount: (tool: AiswitchToolId, name: string) => Promise<void>;
  resetAiswitchLimit: (tool: AiswitchToolId, name?: string) => Promise<void>;
  setAutoSwitch: (on: boolean) => Promise<void>;
  openCliUsage: (tool: AiswitchToolId) => Promise<void>;
  listFolders: () => Promise<ProjectFolder[]>;
  /** Shows the system folder picker; null when the user cancels. */
  addFolder: () => Promise<ProjectFolder | null>;
  removeFolder: (id: string) => Promise<void>;
  /** Opens a terminal per CLI (all three when `tools` is omitted) in the folder, inside the app or outside. */
  openFolder: (id: string, tools: AiswitchToolId[] | undefined, placement: TerminalPlacement, resume?: boolean, size?: { cols: number; rows: number }) =>
    Promise<{ folder: ProjectFolder; terminals: TerminalInfo[] }>;
  listTerminals: () => Promise<TerminalInfo[]>;
  terminalBuffer: (id: string) => Promise<{ data: string; seq: number }>;
  writeTerminal: (id: string, data: string) => Promise<void>;
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<void>;
  closeTerminal: (id: string) => Promise<void>;
  /** Stops the in-app terminal and continues its conversation in a terminal window. */
  popOutTerminal: (id: string) => Promise<TerminalInfo>;
  onTerminalData: (listener: (event: { id: string; seq: number; data: string }) => void) => () => void;
  onTerminalExit: (listener: (event: { id: string; code: number | null }) => void) => () => void;
  onAccountsChanged: (listener: () => void) => () => void;
  onSessionRecovery: (listener: (event: { fromLabel: string; toLabel: string | null }) => void) => () => void;
  onChatEvent: (listener: (event: ChatEvent) => void) => () => void;
};

declare global {
  interface Window {
    switchboard?: SwitchboardApi;
  }
}

const previewAccounts: AccountSummary[] = [
  {
    id: "preview-primary",
    label: "Primary account",
    email: "alex@example.com",
    active: true,
    provider: "chatgpt",
    connectionKind: "oauth",
    status: "connected",
    planUsageEnabled: true,
    accessTokenExpiresAt: new Date(Date.now() + 44 * 60_000).toISOString(),
  },
  {
    id: "preview-research",
    label: "Research account",
    email: "research@example.com",
    active: false,
    provider: "chatgpt",
    connectionKind: "oauth",
    status: "connected",
    planUsageEnabled: true,
    accessTokenExpiresAt: new Date(Date.now() + 52 * 60_000).toISOString(),
  },
  {
    id: "preview-travel",
    label: "Travel account",
    email: "travel@example.com",
    active: false,
    provider: "chatgpt",
    connectionKind: "oauth",
    status: "needs_sign_in",
    planUsageEnabled: false,
    accessTokenExpiresAt: null,
  },
  {
    id: "preview-claude-personal",
    label: "Claude personal",
    email: null,
    active: false,
    provider: "claude_subscription",
    connectionKind: "oauth",
    status: "connected",
    planUsageEnabled: true,
    accessTokenExpiresAt: new Date(Date.now() + 43 * 60_000).toISOString(),
  },
  {
    id: "preview-claude",
    label: "Claude projects",
    email: null,
    active: false,
    provider: "claude_api",
    connectionKind: "api_key",
    status: "ready",
    planUsageEnabled: false,
    accessTokenExpiresAt: null,
  },
  {
    id: "preview-antigravity",
    label: "Antigravity agent",
    email: null,
    active: false,
    provider: "antigravity_api",
    connectionKind: "api_key",
    status: "ready",
    planUsageEnabled: false,
    accessTokenExpiresAt: null,
  },
];

const previewConversation: ChatConversation = {
  accountId: previewAccounts[0].id,
  usage: { inputTokens: 4831, outputTokens: 1620, totalTokens: 6451 },
  messages: [
    {
      id: "preview-1",
      role: "user",
      content: "Help me outline a thoughtful launch plan for a small desktop app.",
      createdAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    },
    {
      id: "preview-2",
      role: "assistant",
      content: "Start with a focused private beta. Invite people who already manage several workspaces, watch where account switching slows them down, and make the first-run experience clear before widening access.",
      createdAt: new Date(Date.now() - 11 * 60_000).toISOString(),
    },
  ],
};

function makePreviewAiswitch(): AiswitchStatus {
  const now = Date.now() / 1000;
  const tokens = (scale: number) => ({ in: 1_240_000 * scale, out: 86_000 * scale, cache: 41_000_000 * scale, think: 12_000 * scale });
  return {
    version: 1,
    platform: "darwin",
    days: 7,
    generatedAt: now,
    autoSwitch: { supported: true, enabled: false, files: ["~/.zshrc"], reason: null },
    tools: [
      {
        tool: "claude", title: "Claude Code", command: "claude", active: "work",
        accounts: [
          { name: "work", email: "you@company.com", active: true, cooldownUntil: null,
            limits: { plan: "team", observedAt: now - 60, rows: [{ kind: "5h", group: null, left: 12, reset: now + 2 * 3600 }, { kind: "week", group: null, left: 58, reset: now + 3 * 86_400 }] },
            tokens: { "claude-opus-5-5": tokens(1), "claude-sonnet-5-5": tokens(0.2) } },
          { name: "personal", email: "you@example.com", active: false, cooldownUntil: now + 3 * 3600,
            limits: { plan: "pro", observedAt: now - 3 * 3600, rows: [{ kind: "5h", group: null, left: 0, reset: now + 3 * 3600 }, { kind: "week", group: null, left: 31, reset: now + 4 * 86_400 }] },
            tokens: { "claude-opus-5-5": tokens(0.4) } },
          { name: "side", email: "side@example.com", active: false, cooldownUntil: null, limits: null, tokens: {} },
        ],
        otherTokens: { "claude-opus-5-5": tokens(2) }, notes: ["claude_tokens_before_tracking"],
        events: [
          { at: now - 50 * 60, from: "personal", to: "work", reason: "limit", until: now + 3 * 3600 },
          { at: now - 26 * 3600, from: "work", to: "personal", reason: "manual", until: null },
        ],
      },
      {
        tool: "codex", title: "Codex", command: "codex", active: "main",
        accounts: [
          { name: "main", email: "you@example.com", active: true, cooldownUntil: null,
            limits: { plan: "plus", observedAt: now - 40 * 60, rows: [{ kind: "5h", group: null, left: 100, reset: null }, { kind: "week", group: null, left: 84, reset: now + 5 * 86_400 }] },
            tokens: { "gpt-6-astra": tokens(1.5), "gpt-6.1-sol": tokens(0.05) } },
          { name: "spare", email: "spare@example.com", active: false, cooldownUntil: null, limits: null, tokens: {} },
        ],
        otherTokens: null, notes: [], events: [],
      },
      {
        tool: "agy", title: "Antigravity (agy)", command: "agy", active: "main",
        accounts: [
          { name: "main", email: "you@gmail.com", active: true, cooldownUntil: null,
            limits: { plan: null, observedAt: now - 120, rows: [{ kind: "week", group: "Gemini", left: 34, reset: now + 3 * 86_400 }, { kind: "week", group: "Claude and GPT", left: 100, reset: now + 6 * 86_400 }] },
            tokens: null },
          { name: "backup", email: "backup@gmail.com", active: false, cooldownUntil: null,
            limits: { plan: null, observedAt: now - 120, rows: [{ kind: "week", group: "Gemini", left: 89, reset: now + 5 * 3600 }, { kind: "5h", group: "Gemini", left: 100, reset: now + 4 * 3600 }, { kind: "week", group: "Claude and GPT", left: 50, reset: now + 6 * 3600 }] },
            tokens: null },
        ],
        otherTokens: null, notes: ["agy_no_token_log", "agy_app_open"], events: [],
      },
    ],
  };
}

let previewAiswitch = makePreviewAiswitch();

const previewTerminals = new Map<string, { info: TerminalInfo; buffer: string }>();
const previewDataListeners = new Set<(event: { id: string; seq: number; data: string }) => void>();

function previewEmit(id: string, data: string) {
  const item = previewTerminals.get(id);
  if (!item) return;
  item.info.seq += 1;
  item.buffer += data;
  previewDataListeners.forEach((listener) => listener({ id, seq: item.info.seq, data }));
}

function previewStartTerminal(tool: AiswitchToolId, folder: ProjectFolder): TerminalInfo {
  const names = { claude: "Claude Code", codex: "Codex", agy: "Antigravity" } as const;
  const info: TerminalInfo = { id: `t-${tool}-${Date.now()}`, tool, folderId: folder.id, folderName: folder.name, cwd: folder.path, title: `${names[tool]} · ${folder.name}`, startedAt: Date.now(), running: true, exitCode: null, seq: 0 };
  previewTerminals.set(info.id, { info, buffer: "" });
  setTimeout(() => previewEmit(info.id, `\x1b[1;36m${names[tool]}\x1b[0m in ${folder.path}\r\n\x1b[2m(full-permission mode, via aiswitch)\x1b[0m\r\n\r\n> `), 50);
  return info;
}

let previewFolders: ProjectFolder[] = [
  { id: "f1", path: "/Users/you/code/storefront", name: "storefront", addedAt: Date.now() - 6 * 86_400_000, lastOpenedAt: Date.now() - 40 * 60_000, missing: false },
  { id: "f2", path: "/Users/you/code/payments-api", name: "payments-api", addedAt: Date.now() - 3 * 86_400_000, lastOpenedAt: null, missing: false },
  { id: "f3", path: "/Users/you/old/prototype", name: "prototype", addedAt: Date.now() - 30 * 86_400_000, lastOpenedAt: Date.now() - 20 * 86_400_000, missing: true },
];

function previewTool(tool: AiswitchToolId) {
  return previewAiswitch.tools.find((item) => item.tool === tool)!;
}

const previewApi: SwitchboardApi = {
  listAccounts: async () => {
    const mode = new URLSearchParams(window.location.search).get("preview");
    if (mode === "empty" || mode === "claude-error") return [];
    const activeId = mode === "claude-account" ? "preview-claude-personal" : mode === "claude" ? "preview-claude" : mode === "antigravity" ? "preview-antigravity" : "preview-primary";
    previewAccounts.forEach((account) => { account.active = account.id === activeId; });
    return [...previewAccounts];
  },
  addAccount: async () => previewAccounts[0],
  addClaudeAccount: async (label) => {
    if (new URLSearchParams(window.location.search).get("preview") === "claude-error") throw Object.assign(new Error("Claude sign-in was not completed. Try again."), { code: "AUTH_FAILED" });
    return { id: `preview-claude-${Date.now()}`, label, email: null, active: true, provider: "claude_subscription", connectionKind: "oauth", status: "connected", planUsageEnabled: true, accessTokenExpiresAt: null };
  },
  addApiAccount: async (provider, label) => ({ id: `preview-${provider}-${Date.now()}`, label, email: null, active: true, provider, connectionKind: "api_key", status: "ready", planUsageEnabled: false, accessTokenExpiresAt: null }),
  replaceApiKey: async (id) => previewAccounts.find((account) => account.id === id)!,
  activateAccount: async (id) => {
    previewAccounts.forEach((account) => { account.active = account.id === id; });
    return previewAccounts.find((account) => account.id === id)!;
  },
  renameAccount: async (id, label) => {
    const account = previewAccounts.find((item) => item.id === id)!;
    account.label = label.trim();
    return account;
  },
  reconnectAccount: async (id) => previewAccounts.find((account) => account.id === id)!,
  signOutAccount: async () => ({ revocationConfirmed: true }),
  removeAccount: async () => ({ revocationConfirmed: true }),
  getConversation: async (id) => id === previewAccounts[0].id
    ? previewConversation
    : { accountId: id, messages: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
  clearConversation: async () => undefined,
  listModels: async (id) => id.includes("claude")
    ? [{ slug: "claude-sonnet-5", displayName: "Claude Sonnet" }]
    : id.includes("antigravity")
      ? [{ slug: "antigravity-preview-09-2026", displayName: "Antigravity agent (Gemini API)" }]
      : [{ slug: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" }],
  sendMessage: async (_id, model, content) => ({ id: "preview-new", role: "assistant", content: `Preview reply to: ${content}`, createdAt: new Date().toISOString(), model }),
  retryAccount: async () => undefined,
  getRateLimit: async (id) => id.includes("claude") ? { remainingTokens: 28000, resetsAt: new Date(Date.now() + 60_000).toISOString() } : null,
  getAccountUsage: async () => previewAccounts.map((account): AccountUsageSnapshot => ({
    accountId: account.id,
    localUsage: account.id === "preview-primary"
      ? { ...previewConversation.usage }
      : { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    limitPaused: false,
    allowance: account.provider === "claude_subscription"
      ? {
        kind: "claude_subscription_windows",
        observedAt: new Date().toISOString(),
        windows: [{ name: "five_hour", status: "allowed_warning", usedPercent: 74, remainingPercent: 26, resetsAt: Math.floor(Date.now() / 1000) + 3600 }],
      }
      : account.provider === "claude_api"
        ? { kind: "claude_api_rate_window", remainingTokens: 28000, resetsAt: new Date(Date.now() + 60_000).toISOString() }
        : { kind: "unknown" },
  })),
  openUsage: async () => undefined,
  openProvider: async () => undefined,
  getAiswitchStatus: async (mode) => {
    const scenario = new URLSearchParams(window.location.search).get("cli");
    if (scenario === "nopython") throw Object.assign(new Error("Python 3 is needed for account switching. Install it from python.org, then reopen Switchboard."), { code: "PYTHON_MISSING" });
    if (mode !== "background") await new Promise((resolve) => setTimeout(resolve, 400));
    if (scenario === "empty") return { ...previewAiswitch, tools: previewAiswitch.tools.map((tool) => ({ ...tool, active: null, accounts: [], otherTokens: null, notes: [], events: [] })) };
    if (scenario === "windows") return { ...previewAiswitch, platform: "win32", autoSwitch: { supported: false, enabled: false, files: [], reason: "On Windows, aiswitch can't watch the terminal for limit messages yet." } };
    return structuredClone(previewAiswitch);
  },
  useAiswitchAccount: async (tool, name) => {
    previewTool(tool).accounts.forEach((account) => { account.active = account.name === name; });
    previewTool(tool).active = name;
    return { warning: tool === "agy" ? "The Antigravity app is open and keeps its own copy of the login; it can switch agy back to its account. Quit and reopen Antigravity so both use the new account." : null };
  },
  addAiswitchAccount: async () => undefined,
  removeAiswitchAccount: async (tool, name) => {
    const entry = previewTool(tool);
    entry.accounts = entry.accounts.filter((account) => account.name !== name);
    if (entry.active === name) entry.active = null;
  },
  resetAiswitchLimit: async (tool, name) => {
    previewTool(tool).accounts.forEach((account) => { if (!name || account.name === name) account.cooldownUntil = null; });
  },
  setAutoSwitch: async (on) => { previewAiswitch.autoSwitch.enabled = on; },
  openCliUsage: async () => undefined,
  listFolders: async () => new URLSearchParams(window.location.search).get("folders") === "empty" ? [] : [...previewFolders],
  addFolder: async () => {
    const folder = { id: `f${Date.now()}`, path: "/Users/you/code/new-project", name: "new-project", addedAt: Date.now(), lastOpenedAt: null, missing: false };
    previewFolders = [...previewFolders, folder];
    return folder;
  },
  removeFolder: async (id) => { previewFolders = previewFolders.filter((folder) => folder.id !== id); },
  openFolder: async (id, tools, placement) => {
    const folder = previewFolders.find((item) => item.id === id)!;
    folder.lastOpenedAt = Date.now();
    const opened = placement === "inside" ? (tools ?? ["agy", "codex", "claude"]).map((tool) => previewStartTerminal(tool, folder)) : [];
    return { folder, terminals: opened };
  },
  listTerminals: async () => [...previewTerminals.values()].map((item) => ({ ...item.info })),
  terminalBuffer: async (id) => ({ data: previewTerminals.get(id)?.buffer ?? "", seq: previewTerminals.get(id)?.info.seq ?? 0 }),
  writeTerminal: async (id, data) => { previewEmit(id, data === "\r" ? "\r\n> " : data); },
  resizeTerminal: async () => undefined,
  closeTerminal: async (id) => { previewTerminals.delete(id); },
  popOutTerminal: async (id) => { const info = previewTerminals.get(id)!.info; previewTerminals.delete(id); return info; },
  onTerminalData: (listener) => { previewDataListeners.add(listener); return () => previewDataListeners.delete(listener); },
  onTerminalExit: () => () => undefined,
  onAccountsChanged: () => () => undefined,
  onSessionRecovery: () => () => undefined,
  onChatEvent: () => () => undefined,
};

export function getApi(): SwitchboardApi {
  if (typeof window !== "undefined" && window.switchboard) return window.switchboard;
  return previewApi;
}
