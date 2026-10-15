import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Clock3,
  ExternalLink,
  Key,
  KeyRound,
  LoaderCircle,
  LogOut,
  MessageSquareText,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  FolderOpen,
  TerminalSquare,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import { getApi, type AccountSummary, type AccountUsageSnapshot, type AiswitchToolId, type BridgeError, type ChatConversation, type ChatModel, type ProjectFolder, type TerminalInfo, type TerminalPlacement } from "./api";
import { CliStatusView } from "./CliStatusView";
import { FoldersView } from "./FoldersView";
import { TerminalsView, type OutsideSession } from "./TerminalsView";

const api = getApi();
const EMPTY_CONVERSATION: ChatConversation = {
  accountId: "",
  messages: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
};

type Provider = AccountSummary["provider"];
type ApiProvider = "claude_api" | "antigravity_api";
type SessionProvider = "chatgpt" | "claude_subscription";
type Notice = { tone: "info" | "success" | "warning" | "error"; title: string; detail?: string; usageAction?: boolean; retryAction?: boolean; provider?: Provider };

const PROVIDER_NAME: Record<Provider, string> = {
  chatgpt: "ChatGPT",
  claude_subscription: "Claude account",
  claude_api: "Claude API",
  antigravity_api: "Antigravity agent",
};
function accountMeta(account: AccountSummary): string {
  if (account.provider === "chatgpt") return account.email ?? "ChatGPT account";
  if (account.provider === "claude_subscription") return account.email ?? "Browser sign-in";
  return account.provider === "claude_api" ? "Claude Console key" : "Gemini API key";
}

function isUsable(account: AccountSummary): boolean {
  if (account.provider === "chatgpt") return account.status === "connected" && account.planUsageEnabled;
  if (account.provider === "claude_subscription") return account.status === "connected";
  return account.status === "ready";
}

function statusLabel(account: AccountSummary): string {
  if (account.connectionKind === "oauth") {
    if (account.status === "connected") return "Connected";
    if (account.status === "signing_in") return "Signing in";
    return "Sign in required";
  }
  return account.status === "ready" ? "API key saved" : "Update API key";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatPercent(value: number): string {
  if (value > 0 && value < 1) return "<1%";
  return `${Math.round(value)}%`;
}

function usageWindowName(value: string): string {
  const known: Record<string, string> = {
    five_hour: "5-hour window",
    seven_day: "7-day window",
    seven_day_opus: "7-day Opus",
    seven_day_sonnet: "7-day Sonnet",
    general: "Current window",
  };
  return known[value] ?? value.replaceAll("_", " ");
}

function usageLabel(account: AccountSummary, snapshot: AccountUsageSnapshot | undefined): string {
  if (!snapshot) return "Usage unavailable";
  if (snapshot.limitPaused) return "Provider limit reached";
  if (snapshot.allowance.kind === "claude_subscription_windows") {
    if (snapshot.allowance.windows.some((window) => window.status === "rejected")) return "Provider window rejected";
    const withPercent = snapshot.allowance.windows.filter((window) => window.remainingPercent !== null);
    const mostLimited = withPercent.sort((a, b) => a.remainingPercent! - b.remainingPercent!)[0];
    if (mostLimited) return `${formatPercent(mostLimited.remainingPercent!)} left · ${usageWindowName(mostLimited.name)}`;
  }
  if (snapshot.allowance.kind === "claude_api_rate_window" && snapshot.allowance.remainingTokens !== null) {
    return `~${formatNumber(snapshot.allowance.remainingTokens)} in API window`;
  }
  return account.provider === "antigravity_api" ? "API quota: view in AI Studio" : "Remaining: unknown";
}

function localUsageLabel(snapshot: AccountUsageSnapshot | undefined): string {
  if (!snapshot || snapshot.localUsage === null) return "App usage unavailable";
  return `${formatNumber(snapshot.localUsage.totalTokens)} tokens used here`;
}

function expiryText(value: string | null): string {
  if (!value) return "Sign in required";
  const minutes = Math.max(0, Math.round((new Date(value).getTime() - Date.now()) / 60_000));
  if (minutes < 2) return "Renewing soon";
  if (minutes < 60) return `Renews in about ${minutes} min`;
  return `Renews in about ${Math.round(minutes / 60)} hr`;
}

function accountInitial(account: AccountSummary): string {
  return (account.label.trim().charAt(0) || account.email?.charAt(0) || "A").toUpperCase();
}

function appErrorMessage(error: unknown, provider: Provider = "chatgpt"): Notice {
  const typed = error as BridgeError;
  if (provider === "claude_subscription" && (typed.code === "AUTH_FAILED" || typed.code === "AUTH_TIMEOUT" || typed.code === "AUTH_CANCELLED")) {
    return { tone: "warning", title: "Claude sign-in not completed", detail: typed.message || "Try signing in again.", provider };
  }
  if (typed.kind === "limit" || typed.code === "subscription_sharing_usage_limit_exceeded") {
    if (provider === "claude_api" || provider === "antigravity_api") return {
      tone: "warning",
      title: "API limit reached",
      detail: "Review your API rate or billing limit. Requests will not move to another account automatically.",
      usageAction: true,
      provider,
    };
    if (provider === "claude_subscription") return {
      tone: "warning",
      title: "Claude usage limit reached",
      detail: "Review your Claude plan usage. Requests will pause until the account is ready again.",
      usageAction: true,
      retryAction: true,
      provider,
    };
    return {
      tone: "warning",
      title: "Usage limit reached",
      detail: "Review your ChatGPT plan or this app’s limit in ChatGPT settings.",
      usageAction: true,
      retryAction: true,
      provider,
    };
  }
  if (typed.kind === "auth" || typed.code === "REFRESH_TERMINAL") {
    if (provider === "claude_api" || provider === "antigravity_api") return { tone: "warning", title: "Update this API key", detail: "The saved key was rejected. Add a replacement key to continue.", provider };
    if (provider === "claude_subscription") return { tone: "warning", title: "Sign in to Claude again", detail: "This account’s session could not be renewed. Reconnect it to continue.", provider };
    return { tone: "warning", title: "Sign in again", detail: "This account’s session could not be renewed. Reconnect it to keep using it here." };
  }
  return { tone: "error", title: "Something went wrong", detail: typed?.message || "Please try again." };
}

export default function App() {
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [conversation, setConversation] = useState<ChatConversation>(EMPTY_CONVERSATION);
  const [models, setModels] = useState<ChatModel[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [workingAction, setWorkingAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loading, setLoading] = useState(true);
  const [accountToRemove, setAccountToRemove] = useState<AccountSummary | null>(null);
  const [accountToRename, setAccountToRename] = useState<AccountSummary | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState("");
  const [showWelcome, setShowWelcome] = useState(false);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [addStep, setAddStep] = useState<"closed" | "choose" | "claude_subscription" | ApiProvider>("closed");
  const [claudeLabel, setClaudeLabel] = useState("");
  const [claudeFormError, setClaudeFormError] = useState("");
  const [apiLabel, setApiLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiWorkspace, setApiWorkspace] = useState("");
  const [apiFormError, setApiFormError] = useState("");
  const [keyToReplace, setKeyToReplace] = useState<AccountSummary | null>(null);
  const [replacementKey, setReplacementKey] = useState("");
  const [rateLimit, setRateLimit] = useState<{ remainingTokens: number | null; resetsAt: string | null } | null>(null);
  const [usageSnapshots, setUsageSnapshots] = useState<AccountUsageSnapshot[]>([]);
  const [usageLoadState, setUsageLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [usageOverviewOpen, setUsageOverviewOpen] = useState(false);
  const [view, setView] = useState<"status" | "folders" | "terminals" | "chat">(() => {
    const requested = new URLSearchParams(window.location.search).get("view");
    return requested === "chat" || requested === "folders" || requested === "terminals" ? requested : "status";
  });
  // In-app terminals live here so they keep running while other views are shown.
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [outsideSessions, setOutsideSessions] = useState<OutsideSession[]>([]);
  const [terminalBusy, setTerminalBusy] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(() => window.innerWidth > 1060);

  useEffect(() => {
    void api.listTerminals().then(setTerminals).catch(() => undefined);
    return api.onTerminalExit(({ id, code }) => {
      setTerminals((list) => list.map((item) => item.id === id ? { ...item, running: false, exitCode: code } : item));
    });
  }, []);

  const terminalTask = async (key: string, task: () => Promise<void>) => {
    setTerminalBusy(key);
    setTerminalError(null);
    try {
      await task();
    } catch (error) {
      setTerminalError((error as Error)?.message || "The terminal action didn't work.");
    } finally {
      setTerminalBusy(null);
    }
  };
  const outsideKey = (folderId: string, tool: string) => `${folderId}:${tool}`;
  const rememberOutside = (items: OutsideSession[]) => setOutsideSessions((list) => [...list.filter((item) => !items.some((next) => next.key === item.key)), ...items]);
  const onFoldersOpened = (result: { folder: ProjectFolder; tools: AiswitchToolId[]; placement: TerminalPlacement; terminals: TerminalInfo[] }) => {
    if (result.placement === "inside") {
      setTerminals((list) => [...list, ...result.terminals]);
      setOutsideSessions((list) => list.filter((item) => !result.terminals.some((info) => outsideKey(info.folderId, info.tool) === item.key)));
      setView("terminals");
    } else {
      const names = { claude: "Claude Code", codex: "Codex", agy: "Antigravity" } as const;
      rememberOutside(result.tools.map((tool) => ({ key: outsideKey(result.folder.id, tool), tool, folderId: result.folder.id, folderName: result.folder.name, title: `${names[tool]} · ${result.folder.name}` })));
    }
  };
  const closeTerminal = (info: TerminalInfo) => {
    if (info.running && !window.confirm(`Stop ${info.title}? Its conversation can be continued later.`)) return;
    void terminalTask(`close:${info.id}`, async () => {
      await api.closeTerminal(info.id);
      setTerminals((list) => list.filter((item) => item.id !== info.id));
    });
  };
  const popOutTerminal = (info: TerminalInfo) => void terminalTask(`pop:${info.id}`, async () => {
    await api.popOutTerminal(info.id);
    setTerminals((list) => list.filter((item) => item.id !== info.id));
    rememberOutside([{ key: outsideKey(info.folderId, info.tool), tool: info.tool, folderId: info.folderId, folderName: info.folderName, title: info.title }]);
  });
  const bringInside = (session: OutsideSession) => void terminalTask(`in:${session.key}`, async () => {
    const result = await api.openFolder(session.folderId, [session.tool], "inside", true);
    setTerminals((list) => [...list, ...result.terminals]);
    setOutsideSessions((list) => list.filter((item) => item.key !== session.key));
    setView("terminals");
  });
  const restartTerminal = (info: TerminalInfo) => void terminalTask(`restart:${info.id}`, async () => {
    const result = await api.openFolder(info.folderId, [info.tool], "inside", true);
    await api.closeTerminal(info.id).catch(() => undefined);
    setTerminals((list) => [...list.filter((item) => item.id !== info.id), ...result.terminals]);
  });
  const messageEnd = useRef<HTMLDivElement>(null);
  const activeAccount = useMemo(() => accounts.find((account) => account.active) ?? null, [accounts]);
  const activeId = activeAccount?.id ?? null;
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const usageById = useMemo(() => new Map(usageSnapshots.map((item) => [item.accountId, item])), [usageSnapshots]);
  const activeUsage = activeId ? usageById.get(activeId) : undefined;

  const refreshAccountUsage = useCallback(async () => {
    try {
      const next = await api.getAccountUsage();
      setUsageSnapshots(next);
      setUsageLoadState("ready");
    } catch {
      setUsageLoadState("error");
    }
  }, []);

  const refreshAccounts = useCallback(async () => {
    const next = await api.listAccounts();
    setAccounts(next);
    setLoading(false);
    void refreshAccountUsage();
    const isVisualPreview = import.meta.env.DEV && new URLSearchParams(window.location.search).has("preview");
    if (!isVisualPreview && next.some((account) => account.active && account.provider === "chatgpt" && account.planUsageEnabled && account.status === "connected") && !localStorage.getItem("switchboard-welcome-seen")) {
      setShowWelcome(true);
    }
  }, [refreshAccountUsage]);

  useEffect(() => {
    refreshAccounts().catch((error) => {
      setLoading(false);
      setNotice(appErrorMessage(error));
    });
    const unsubscribeAccounts = api.onAccountsChanged(() => { refreshAccounts().catch(setNoticeFromError); });
    const unsubscribeRecovery = api.onSessionRecovery((event) => {
      setNotice(event.toLabel
        ? { tone: "info", title: `Switched to ${event.toLabel}`, detail: `${event.fromLabel} needs to sign in again. Its expired session could not be renewed.` }
        : { tone: "warning", title: "No connected account available", detail: `${event.fromLabel} needs to sign in again. Reconnect an account to keep chatting.` });
    });
    const unsubscribeChat = api.onChatEvent((event) => {
      if (event.accountId !== activeIdRef.current) return;
      if (event.type === "delta") setStreaming((current) => current + event.delta);
      if (event.type === "completed") setStreaming("");
      if (event.type === "usage") {
        setConversation((current) => current.accountId === event.accountId
          ? { ...current, usage: event.totalUsage }
          : current);
      }
    });
    return () => { unsubscribeAccounts(); unsubscribeRecovery(); unsubscribeChat(); };
  }, [refreshAccounts]);

  useEffect(() => {
    if (!activeId) {
      setConversation(EMPTY_CONVERSATION);
      setModels([]);
      setRateLimit(null);
      return;
    }
    let cancelled = false;
    setStreaming("");
    setDraft("");
    setSelectedModel("");
    api.getConversation(activeId).then((result) => { if (!cancelled) setConversation(result); }).catch(setNoticeFromError);
    if (activeAccount && isUsable(activeAccount)) {
      api.listModels(activeId).then((result) => {
        if (cancelled) return;
        setModels(result);
        setSelectedModel((previous) => result.some((item) => item.slug === previous) ? previous : (result[0]?.slug ?? ""));
      }).catch((error) => { if (!cancelled) setNotice(appErrorMessage(error, activeAccount.provider)); });
    } else setModels([]);
    setRateLimit(null);
    if (activeAccount?.provider === "claude_api") {
      api.getRateLimit(activeId).then((result) => { if (!cancelled) setRateLimit(result); }).catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [activeId, activeAccount?.status, activeAccount?.planUsageEnabled, activeAccount?.provider]);

  useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    messageEnd.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "end" });
  }, [conversation.messages.length, streaming]);

  useEffect(() => {
    const onResize = () => setDetailsOpen(window.innerWidth > 1060);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function setNoticeFromError(error: unknown) { setNotice(appErrorMessage(error)); }

  async function runAction(key: string, task: () => Promise<unknown>, provider: Provider = activeAccount?.provider ?? "chatgpt") {
    setWorkingAction(key);
    setNotice(null);
    try {
      await task();
      await refreshAccounts();
    } catch (error) {
      setNotice(appErrorMessage(error, provider));
    } finally {
      setWorkingAction(null);
      setShowAccountMenu(false);
    }
  }

  async function sendMessage() {
    const content = draft.trim();
    if (!activeId || !selectedModel || !content || busy) return;
    setDraft("");
    setBusy(true);
    setStreaming("");
    setNotice(null);
    const optimistic = {
      id: `pending-${Date.now()}`,
      role: "user" as const,
      content,
      createdAt: new Date().toISOString(),
    };
    setConversation((current) => ({ ...current, messages: [...current.messages, optimistic] }));
    try {
      await api.sendMessage(activeId, selectedModel, content);
      const updated = await api.getConversation(activeId);
      if (activeIdRef.current === activeId) setConversation(updated);
      if (activeAccount?.provider === "claude_api") {
        const latest = await api.getRateLimit(activeId).catch(() => null);
        if (activeIdRef.current === activeId) setRateLimit(latest);
      }
    } catch (error) {
      if (activeIdRef.current === activeId) {
        setNotice(appErrorMessage(error, activeAccount?.provider));
        setDraft(content);
        const restored = await api.getConversation(activeId).catch(() => EMPTY_CONVERSATION);
        if (activeIdRef.current === activeId) setConversation(restored);
      }
    } finally {
      setBusy(false);
      setStreaming("");
      void refreshAccountUsage();
    }
  }

  async function confirmRemove() {
    if (!accountToRemove) return;
    const removedAccount = accountToRemove;
    const id = removedAccount.id;
    setAccountToRemove(null);
    await runAction(`remove-${id}`, async () => {
      const result = await api.removeAccount(id);
      if (removedAccount.provider === "chatgpt" && !result.revocationConfirmed) {
        setNotice({ tone: "warning", title: "Account removed locally", detail: "Remote sign-out could not be confirmed. You can disconnect Switchboard in ChatGPT settings.", usageAction: true });
      }
    });
  }

  function openRename(account: AccountSummary) {
    setAccountToRename(account);
    setRenameDraft(account.label);
    setRenameError("");
    setShowAccountMenu(false);
  }

  async function confirmRename() {
    if (!accountToRename || workingAction) return;
    setWorkingAction(`rename-${accountToRename.id}`);
    setRenameError("");
    try {
      await api.renameAccount(accountToRename.id, renameDraft);
      await refreshAccounts();
      setAccountToRename(null);
    } catch (error) {
      setRenameError((error as Error)?.message || "The account could not be renamed.");
    } finally {
      setWorkingAction(null);
    }
  }

  async function retryUsage() {
    if (!activeId) return;
    try {
      await api.retryAccount(activeId);
      void refreshAccountUsage();
      setNotice({ tone: "info", title: "Ready to try again", detail: activeAccount?.provider === "claude_subscription" ? "Send your message when you’re ready. Claude may still enforce the current usage limit." : "Send your message when you’re ready. OpenAI may still enforce the current usage limit." });
    } catch (error) {
      setNotice(appErrorMessage(error));
    }
  }

  async function signOut(accountId: string) {
    const result = await api.signOutAccount(accountId);
    if (!result.revocationConfirmed) {
      setNotice({ tone: "warning", title: "Signed out on this computer", detail: activeAccount?.provider === "claude_subscription" ? "Claude sign-out on other devices was not confirmed. Review your Claude account settings if needed." : "Remote sign-out could not be confirmed. You can disconnect Switchboard in ChatGPT settings.", usageAction: true, provider: activeAccount?.provider });
    }
  }

  function startApiAdd(provider: ApiProvider) {
    setAddStep(provider);
    setApiLabel("");
    setApiKey("");
    setApiWorkspace("");
    setApiFormError("");
  }

  async function confirmApiAdd() {
    if (addStep !== "claude_api" && addStep !== "antigravity_api") return;
    const provider = addStep;
    if (!apiLabel.trim() || !apiKey.trim()) {
      setApiFormError("Enter a name and an API key.");
      return;
    }
    setWorkingAction("add-api");
    setApiFormError("");
    try {
      await api.addApiAccount(provider, apiLabel.trim(), apiKey.trim(), provider === "claude_api" ? apiWorkspace.trim() || undefined : undefined);
      setAddStep("closed");
      setApiKey("");
      await refreshAccounts();
      setNotice({ tone: "success", title: "API key saved", detail: "The key is protected on this computer. It will be checked when models load or you send a message.", provider });
    } catch (error) {
      setApiFormError((error as Error)?.message || "The API key could not be saved.");
    } finally {
      setWorkingAction(null);
    }
  }

  function openReplaceKey(account: AccountSummary) {
    setKeyToReplace(account);
    setReplacementKey("");
    setApiFormError("");
    setShowAccountMenu(false);
  }

  async function confirmReplaceKey() {
    if (!keyToReplace) return;
    if (!replacementKey.trim()) { setApiFormError("Enter the replacement API key."); return; }
    setWorkingAction(`replace-${keyToReplace.id}`);
    setApiFormError("");
    try {
      await api.replaceApiKey(keyToReplace.id, replacementKey.trim());
      setKeyToReplace(null);
      setReplacementKey("");
      await refreshAccounts();
      setNotice({ tone: "success", title: "API key updated", detail: "The new key is saved on this computer." });
    } catch (error) {
      setApiFormError((error as Error)?.message || "The API key could not be updated.");
    } finally {
      setWorkingAction(null);
    }
  }

  async function addChatGpt() {
    setAddStep("closed");
    await runAction("add", () => api.addAccount());
  }

  async function confirmClaudeAdd() {
    const label = claudeLabel.trim();
    if (!label) { setClaudeFormError("Enter an account name."); return; }
    setClaudeFormError("");
    setAddStep("closed");
    setNotice({ tone: "info", title: "Waiting for Claude sign-in", detail: "Complete sign-in in your browser. Switchboard will keep this account separate from your other Claude accounts." });
    setWorkingAction("add-claude");
    try {
      await api.addClaudeAccount(label);
      await refreshAccounts();
      setNotice({ tone: "success", title: "Claude account connected", detail: "This browser sign-in is ready to use in Switchboard.", provider: "claude_subscription" });
    } catch (error) {
      setNotice(appErrorMessage(error, "claude_subscription"));
    } finally {
      setWorkingAction(null);
      setClaudeLabel("");
    }
  }

  const accountCount = accounts.length;
  const canChat = !!activeAccount && isUsable(activeAccount) && !!selectedModel && !workingAction;

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Account navigation">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <div><strong>Switchboard</strong><small>AI accounts</small></div>
        </div>

        <div className="sidebar-section-heading">
          <span>WORKSPACE</span>
        </div>
        <nav className="workspace-nav" aria-label="Workspace">
          <button type="button" className={view === "status" ? "nav-current" : "nav-item"} aria-current={view === "status" ? "page" : undefined} onClick={() => setView("status")}><SquareTerminal size={18} strokeWidth={1.8} /><span>CLI accounts</span></button>
          <button type="button" className={view === "folders" ? "nav-current" : "nav-item"} aria-current={view === "folders" ? "page" : undefined} onClick={() => setView("folders")}><FolderOpen size={18} strokeWidth={1.8} /><span>Folders</span></button>
          <button type="button" className={view === "terminals" ? "nav-current" : "nav-item"} aria-current={view === "terminals" ? "page" : undefined} onClick={() => setView("terminals")}><TerminalSquare size={18} strokeWidth={1.8} /><span>Terminals</span>{terminals.length > 0 && <span className="count-badge nav-count">{terminals.length}</span>}</button>
          <button type="button" className={view === "chat" ? "nav-current" : "nav-item"} aria-current={view === "chat" ? "page" : undefined} onClick={() => setView("chat")}><MessageSquareText size={18} strokeWidth={1.8} /><span>Chat</span></button>
        </nav>

        <div className="sidebar-bottom">
          <div className="local-note"><ShieldCheck size={18} /><span>Credentials stay protected on this computer</span></div>
          <div className="sidebar-foot"><span>Desktop app</span></div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><span className="breadcrumb-divider">/</span><strong>{view === "status" ? "CLI accounts" : view === "folders" ? "Project folders" : view === "terminals" ? "Terminals" : "Chat"}</strong></div>
          <div className="topbar-actions">
            <button className="text-button usage-top-link" type="button" onClick={() => setUsageOverviewOpen(true)} disabled={accountCount === 0}><Clock3 size={16} />All account usage</button>
            {activeAccount && <button className="topbar-account" type="button" onClick={() => setShowAccountMenu(!showAccountMenu)} aria-expanded={showAccountMenu}>
              <span className="tiny-avatar">{accountInitial(activeAccount)}</span><span>{activeAccount.label}</span><ChevronDown size={16} />
            </button>}
          </div>
          {showAccountMenu && activeAccount && (
            <div className="account-menu" role="group" aria-label="Account actions">
              <div className="menu-heading">{PROVIDER_NAME[activeAccount.provider]} · {activeAccount.email ?? activeAccount.label}</div>
              <button type="button" className="menu-add-account" onClick={() => { setShowAccountMenu(false); setAddStep("choose"); }}><Plus size={16} />Add account</button>
              <button type="button" onClick={() => openRename(activeAccount)}><Pencil size={16} />Rename account</button>
              {activeAccount.connectionKind === "oauth" ? <>
                <button type="button" onClick={() => runAction(`reconnect-${activeId}`, () => api.reconnectAccount(activeId!))}><RefreshCw size={16} />Reconnect account</button>
                <button type="button" onClick={() => runAction(`signout-${activeId}`, () => signOut(activeId!))}><LogOut size={16} />Sign out</button>
              </> : <button type="button" onClick={() => openReplaceKey(activeAccount)}><KeyRound size={16} />Replace API key</button>}
              <button className="menu-danger" type="button" onClick={() => { setAccountToRemove(activeAccount); setShowAccountMenu(false); }}><Trash2 size={16} />Remove account</button>
            </div>
          )}
        </header>

        {view === "terminals" ? null
          : view === "status" ? <CliStatusView api={api} />
          : view === "folders" ? <FoldersView api={api} onOpened={onFoldersOpened} />
          : loading ? <div className="loading-view"><LoaderCircle size={28} className="spin" /><span>Loading your workspace…</span></div>
          : !activeAccount ? (
            <section className="onboarding">
              {notice && <div className={`notice notice-${notice.tone}`} role="status"><span className="notice-icon">{notice.tone === "success" ? <CircleCheck size={19} /> : <CircleAlert size={19} />}</span><div><strong>{notice.title}</strong>{notice.detail && <p>{notice.detail}</p>}{notice.usageAction && <button className="inline-link" type="button" onClick={() => api.openUsage(notice.provider)} >Manage usage <ArrowUpRight size={15} /></button>}</div><button type="button" className="icon-button notice-close" aria-label="Dismiss message" onClick={() => setNotice(null)}><X size={16} /></button></div>}
              <div className="eyebrow"><span className="eyebrow-line" />A quieter way to switch</div>
              <h1>Your AI accounts,<br /><em>all in one place.</em></h1>
              <p>Add ChatGPT or Claude browser sign-ins, Claude Console keys, or Gemini API keys for an Antigravity remote agent. Choose any saved account from the sidebar.</p>
              <button className="primary-button" type="button" onClick={() => setAddStep("choose")} disabled={!!workingAction}>
                <Plus size={18} /> Add an account <ArrowRight size={18} />
              </button>
              <div className="onboarding-steps">
                <div><span>01</span><strong>Add</strong><p>Use the supported sign-in or API key for each provider.</p></div>
                <div><span>02</span><strong>Choose</strong><p>Pick a saved account when you want to switch.</p></div>
                <div><span>03</span><strong>Chat</strong><p>Conversations and local token counts stay separate.</p></div>
              </div>
            </section>
          ) : (
            <div className="chat-layout">
              <section className="chat-column" aria-label="Chat">
                <div className="chat-head">
                  <div><span className="overline">{PROVIDER_NAME[activeAccount.provider].toUpperCase()}</span><h1>{activeAccount.label}</h1><p>{accountMeta(activeAccount)}</p></div>
                  <div className={`connection-badge ${isUsable(activeAccount) ? "connected" : "disconnected"}`}>
                    {isUsable(activeAccount) ? <CircleCheck size={16} /> : <CircleAlert size={16} />}
                    {statusLabel(activeAccount)}
                  </div>
                </div>

                {notice && <div className={`notice notice-${notice.tone}`} role="status"><span className="notice-icon">{notice.tone === "success" ? <CircleCheck size={19} /> : <CircleAlert size={19} />}</span><div><strong>{notice.title}</strong>{notice.detail && <p>{notice.detail}</p>}{notice.usageAction && <button className="inline-link" type="button" onClick={() => api.openUsage(notice.provider ?? activeAccount.provider)}>{activeAccount.connectionKind === "oauth" ? "Manage usage" : "Open API usage"} <ArrowUpRight size={15} /></button>}{notice.retryAction && activeAccount.connectionKind === "oauth" && <button className="inline-link" type="button" onClick={() => void retryUsage()}>Try again <RefreshCw size={14} /></button>}</div><button type="button" className="icon-button notice-close" aria-label="Dismiss message" onClick={() => setNotice(null)}><X size={16} /></button></div>}

                {activeAccount.connectionKind === "api_key" && activeAccount.status !== "ready" ? (
                  <div className="state-card"><div className="state-icon"><KeyRound size={26} /></div><h2>Update this API key</h2><p>The saved key needs attention. Replace it to use {PROVIDER_NAME[activeAccount.provider]} here.</p><button className="primary-button" type="button" onClick={() => openReplaceKey(activeAccount)}>Replace API key <ArrowRight size={18} /></button></div>
                ) : activeAccount.connectionKind === "oauth" && activeAccount.status !== "connected" ? (
                  <div className="state-card"><div className="state-icon"><KeyRound size={26} /></div><h2>Reconnect this account</h2><p>The saved sign-in needs your attention. Your other accounts remain available.</p><button className="primary-button" type="button" onClick={() => runAction(`reconnect-${activeId}`, () => api.reconnectAccount(activeId!))}>Reconnect with {activeAccount.provider === "chatgpt" ? "ChatGPT" : "Claude"} <ArrowRight size={18} /></button></div>
                ) : activeAccount.provider === "chatgpt" && !activeAccount.planUsageEnabled ? (
                  <div className="state-card"><div className="state-icon"><CircleHelp size={26} /></div><h2>Enable ChatGPT plan usage</h2><p>This account is connected, but it has not granted permission to use its plan in Switchboard.</p><button className="primary-button" type="button" onClick={() => runAction(`reconnect-${activeId}`, () => api.reconnectAccount(activeId!))}>Review permission <ArrowRight size={18} /></button></div>
                ) : (
                  <>
                    <div className="message-scroll" aria-live="polite">
                      {conversation.messages.length === 0 && !streaming ? (
                        <div className="conversation-empty"><div className="empty-graphic" aria-hidden="true"><MessageSquareText size={28} strokeWidth={1.6} /></div><h2>What would you like to work on?</h2><p>This conversation belongs to {activeAccount.label}. Choose a model and start typing below.</p></div>
                      ) : (
                        <div className="message-stack">
                          {conversation.messages.map((message) => (
                            <article key={message.id} className={`message message-${message.role}`}>
                              <div className="message-identity"><span className={message.role === "user" ? "user-avatar" : "assistant-avatar"}>{message.role === "user" ? accountInitial(activeAccount) : <span className="assistant-spark">✦</span>}</span><strong>{message.role === "user" ? "You" : "Assistant"}</strong><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></div>
                              <p>{message.content}</p>
                            </article>
                          ))}
                          {busy && <article className="message message-assistant streaming-message"><div className="message-identity"><span className="assistant-avatar"><span className="assistant-spark">✦</span></span><strong>Assistant</strong><span className="generating-label">Generating</span></div><p>{streaming || <span className="typing-dots"><i /><i /><i /></span>}</p></article>}
                          <div ref={messageEnd} />
                        </div>
                      )}
                    </div>
                    <div className="composer-area">
                      <div className="composer">
                        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder="Message this account…" aria-label="Message this account" rows={3} disabled={busy || !!workingAction} />
                        <div className="composer-bottom"><div className="model-select-wrap"><select aria-label="Select model" value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} disabled={busy || !!workingAction || models.length === 0}>{models.length === 0 ? <option value="">Loading models…</option> : models.map((model) => <option key={model.slug} value={model.slug}>{model.displayName}</option>)}</select><ChevronDown size={15} /></div><button className="send-button" type="button" onClick={() => void sendMessage()} disabled={!canChat || busy || !draft.trim()} aria-label="Send message">{busy ? <LoaderCircle size={19} className="spin" /> : <Send size={19} />}</button></div>
                      </div>
                      <div className="composer-caption"><span><ShieldCheck size={14} />{activeAccount.provider === "chatgpt" ? "Using ChatGPT plan" : activeAccount.provider === "claude_subscription" ? "Using Claude account" : activeAccount.provider === "claude_api" ? "Using Claude Console API billing" : "Using Google AI Studio API billing"}</span><button type="button" onClick={() => api.openUsage(activeAccount.provider)}>{activeAccount.connectionKind === "oauth" ? "Manage usage" : "API usage"} <ArrowUpRight size={14} /></button></div>
                    </div>
                  </>
                )}
              </section>

              <aside className={`details-panel ${detailsOpen ? "details-open" : ""}`} aria-label="Account details">
                <button type="button" className="details-toggle" onClick={() => setDetailsOpen(!detailsOpen)} aria-expanded={detailsOpen}>Account details <ChevronDown size={17} /></button>
                <div className="details-content">
                  <div className="details-title-row"><span className="overline">ACCOUNT OVERVIEW</span><span className={`detail-live ${isUsable(activeAccount) ? "" : "off"}`}><span />{statusLabel(activeAccount)}</span></div>
                  <div className="detail-account"><div className="detail-avatar">{accountInitial(activeAccount)}</div><h2>{activeAccount.label}</h2><p>{PROVIDER_NAME[activeAccount.provider]} · {accountMeta(activeAccount)}</p></div>

                  <div className="detail-divider" />
                  <div className="section-label">{activeAccount.connectionKind === "oauth" ? "SESSION" : "CREDENTIAL"}</div>
                  {activeAccount.provider === "chatgpt" ? <>
                    <div className="session-row"><div className="session-icon"><RefreshCw size={17} /></div><div><strong>{activeAccount.status === "connected" ? "Automatic renewal" : "Action needed"}</strong><p>{expiryText(activeAccount.accessTokenExpiresAt)}</p></div></div>
                    <p className="detail-explain">Access expires periodically. Switchboard renews this session in the background.</p>
                  </> : activeAccount.provider === "claude_subscription" ? <>
                    <div className="session-row"><div className="session-icon"><RefreshCw size={17} /></div><div><strong>{activeAccount.status === "connected" ? "Claude sign-in active" : "Action needed"}</strong><p>{activeAccount.status === "connected" ? "Checked by Claude Code" : "Reconnect in your browser"}</p></div></div>
                    <p className="detail-explain">Claude Code keeps this account’s sign-in in a separate local profile. Switchboard checks its status and asks you to reconnect if needed.</p>
                  </> : <>
                    <div className="session-row"><div className="session-icon"><Key size={17} /></div><div><strong>{activeAccount.status === "ready" ? "API key saved" : "Key needs update"}</strong><p>{activeAccount.provider === "claude_api" ? "Claude Console" : "Google AI Studio"}</p></div></div>
                    <p className="detail-explain">The key is stored on this computer and used only for {PROVIDER_NAME[activeAccount.provider]} requests. API billing is separate from any personal subscription.</p>
                  </>}

                  <div className="detail-divider" />
                  <div className="section-label">USAGE IN THIS APP</div>
                  <div className="usage-total"><strong>{formatNumber(conversation.usage.totalTokens)}</strong><span>tokens used</span></div>
                  <div className="usage-breakdown"><div><ArrowDownLeft size={15} /><span>Input</span><strong>{formatNumber(conversation.usage.inputTokens)}</strong></div><div><ArrowUpRight size={15} /><span>Output</span><strong>{formatNumber(conversation.usage.outputTokens)}</strong></div></div>
                  <p className="detail-explain">Counts include this account’s conversations in Switchboard only.</p>

                  <div className="detail-divider" />
                  <div className="section-label">{activeAccount.provider === "chatgpt" ? "CHATGPT PLAN" : activeAccount.provider === "claude_subscription" ? "CLAUDE PLAN" : "API LIMITS"}</div>
                  {activeAccount.provider === "chatgpt" ? (
                    <div className="balance-card"><div><Clock3 size={19} /><strong>Remaining allowance</strong></div><span>View in ChatGPT</span><p>OpenAI does not provide an exact remaining balance to this app.</p><button type="button" onClick={() => api.openUsage("chatgpt")}>Manage usage <ExternalLink size={15} /></button></div>
                  ) : activeAccount.provider === "claude_subscription" ? (
                    <div className="balance-card"><div><Clock3 size={19} /><strong>Claude usage windows</strong></div><span>{usageLabel(activeAccount, activeUsage)}</span>{activeUsage?.allowance.kind === "claude_subscription_windows" && <><ul className="allowance-windows">{activeUsage.allowance.windows.map((window) => <li key={window.name}><span>{usageWindowName(window.name)}</span><strong>{window.remainingPercent === null ? window.status === "rejected" ? "Limit reached" : "Unknown" : `${formatPercent(window.remainingPercent)} left`}</strong></li>)}</ul><p>Last reported {new Date(activeUsage.allowance.observedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.</p></>}<p>These percentages come from Claude Code’s rate windows. They are not an exact token balance, and may be unavailable until a request completes.</p><button type="button" onClick={() => api.openUsage("claude_subscription")}>Manage usage <ExternalLink size={15} /></button></div>
                  ) : activeAccount.provider === "claude_api" ? (
                    <div className="balance-card"><div><Clock3 size={19} /><strong>Claude API headroom</strong></div><span>{rateLimit?.remainingTokens != null ? `About ${formatNumber(rateLimit.remainingTokens)} tokens` : "Available after a request"}</span><p>{rateLimit?.remainingTokens != null ? "Approximate tokens remaining in the current API rate window. This is not your subscription allowance or monthly credit balance." : "Claude reports approximate per-minute headroom with API responses. This is not your subscription allowance."}{rateLimit?.resetsAt ? ` Resets around ${new Date(rateLimit.resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : ""}</p><button type="button" onClick={() => api.openUsage("claude_api")}>Claude Console usage <ExternalLink size={15} /></button></div>
                  ) : (
                    <div className="balance-card"><div><Clock3 size={19} /><strong>Gemini API quota</strong></div><span>View in AI Studio</span><p>The remote Antigravity agent uses Gemini API billing and quota. Personal Antigravity IDE allowance is separate and is not available here.</p><button type="button" onClick={() => api.openUsage("antigravity_api")}>AI Studio usage <ExternalLink size={15} /></button><button type="button" className="balance-secondary-action" onClick={() => api.openProvider("antigravity_api")}>Open Antigravity <ExternalLink size={15} /></button></div>
                  )}
                  <div className="detail-divider" />
                  <button className="muted-action" type="button" onClick={() => openRename(activeAccount)}><Pencil size={16} />Rename account</button>
                  {activeAccount.connectionKind === "oauth" ? <>
                    <button className="muted-action" type="button" onClick={() => runAction(`reconnect-${activeId}`, () => api.reconnectAccount(activeId!))}><RefreshCw size={16} />Reconnect account</button>
                    <button className="muted-action" type="button" onClick={() => runAction(`signout-${activeId}`, () => signOut(activeId!))}><LogOut size={16} />Sign out</button>
                  </> : <button className="muted-action" type="button" onClick={() => openReplaceKey(activeAccount)}><KeyRound size={16} />Replace API key</button>}
                  <button className="muted-action dangerous" type="button" onClick={() => setAccountToRemove(activeAccount)}><Trash2 size={16} />Remove account</button>
                </div>
              </aside>
            </div>
          )}
        {view === "terminals" && terminalError && <div className="notice notice-error term-notice" role="alert"><span className="notice-icon"><CircleAlert size={19} /></span><div><p>{terminalError}</p></div></div>}
        <TerminalsView api={api} terminals={terminals} outside={outsideSessions} visible={view === "terminals"} busy={terminalBusy}
          onClose={closeTerminal} onPopOut={popOutTerminal} onBringInside={bringInside} onRestart={restartTerminal} onShowFolders={() => setView("folders")} />
      </main>

      {usageOverviewOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setUsageOverviewOpen(false); }} onKeyDown={(event) => { if (event.key === "Escape") setUsageOverviewOpen(false); }}><div className="modal usage-modal" role="dialog" aria-modal="true" aria-labelledby="all-usage-title"><button className="modal-close icon-button" type="button" aria-label="Close usage overview" autoFocus onClick={() => setUsageOverviewOpen(false)}><X size={18} /></button><h2 id="all-usage-title">All account usage</h2><p>Local token counts cover completed chats in Switchboard. Remaining allowance appears only when a provider reports it. Open provider usage with the matching browser account.</p><ul className="usage-overview-list">{accounts.map((account) => {
        const snapshot = usageById.get(account.id);
        return <li className="usage-overview-account" key={account.id}><div className="usage-overview-heading"><span className="account-avatar" aria-hidden="true">{accountInitial(account)}</span><div><strong>{account.label}</strong><small>{PROVIDER_NAME[account.provider]} · {statusLabel(account)}</small></div>{account.active && <span className="usage-active-badge">Current</span>}</div><div className="usage-overview-metrics"><div><span>Used in this app</span><strong>{snapshot?.localUsage ? `${formatNumber(snapshot.localUsage.totalTokens)} tokens` : snapshot?.localUsage === null ? "Unavailable" : usageLoadState === "loading" ? "Loading…" : "Unavailable"}</strong></div><div><span>Provider allowance</span><strong>{usageLoadState === "loading" ? "Loading…" : usageLabel(account, snapshot)}</strong></div></div>{snapshot?.allowance.kind === "claude_subscription_windows" && <><ul className="allowance-windows">{snapshot.allowance.windows.map((window) => <li key={window.name}><span>{usageWindowName(window.name)}</span><strong>{window.remainingPercent === null ? window.status === "rejected" ? "Limit reached" : "Unknown" : `${formatPercent(window.remainingPercent)} left`}</strong></li>)}</ul><small className="usage-observed">Last reported {new Date(snapshot.allowance.observedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</small></>}<div className="usage-overview-actions"><button type="button" onClick={() => { setUsageOverviewOpen(false); void runAction(`activate-${account.id}`, () => api.activateAccount(account.id)); }} disabled={account.active || !!workingAction || busy}>{account.active ? "Using now" : "Use account"}</button><button type="button" onClick={() => api.openUsage(account.provider)}>Provider usage <ExternalLink size={14} /></button></div></li>;
      })}</ul><p className="usage-overview-note">A provider limit does not trigger automatic account switching. Select another account when you want to use it.</p></div></div>}

      {addStep === "choose" && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAddStep("closed"); }} onKeyDown={(event) => { if (event.key === "Escape") setAddStep("closed"); }}><div className="modal provider-modal" role="dialog" aria-modal="true" aria-labelledby="add-title"><button className="modal-close icon-button" type="button" aria-label="Close" onClick={() => setAddStep("closed")}><X size={18} /></button><div className="modal-icon success"><Plus size={22} /></div><h2 id="add-title">Add an account</h2><p>Choose the service you want to use in Switchboard.</p><div className="provider-choices">
        <button type="button" onClick={() => void addChatGpt()} disabled={!!workingAction}><span className="provider-choice-icon"><MessageSquareText size={20} /></span><span><strong>ChatGPT</strong><small>Sign in with OpenAI in your browser. Eligible plan usage.</small></span><ArrowRight size={18} /></button>
        <button type="button" onClick={() => { setClaudeLabel(""); setClaudeFormError(""); setAddStep("claude_subscription"); }} disabled={!!workingAction}><span className="provider-choice-icon"><MessageSquareText size={20} /></span><span><strong>Claude account</strong><small>Sign in to Claude in your browser. Uses your Claude plan.</small></span><ArrowRight size={18} /></button>
        <button type="button" onClick={() => startApiAdd("claude_api")}><span className="provider-choice-icon"><KeyRound size={20} /></span><span><strong>Claude API</strong><small>Use a Claude Console API key. Billed separately from Claude plans.</small></span><ArrowRight size={18} /></button>
        <button type="button" onClick={() => startApiAdd("antigravity_api")}><span className="provider-choice-icon"><Key size={20} /></span><span><strong>Antigravity agent</strong><small>Use a Gemini API key for a remote agent. Personal IDE login stays in Antigravity.</small></span><ArrowRight size={18} /></button>
      </div></div></div>}

      {(addStep === "claude_api" || addStep === "antigravity_api") && <div className="modal-backdrop" role="presentation" onKeyDown={(event) => { if (event.key === "Escape") setAddStep("closed"); }}><form className="modal api-modal" role="dialog" aria-modal="true" aria-labelledby="api-add-title" onSubmit={(event) => { event.preventDefault(); void confirmApiAdd(); }}><button className="modal-close icon-button" type="button" aria-label="Close" onClick={() => setAddStep("closed")}><X size={18} /></button><button className="modal-back-button" type="button" onClick={() => setAddStep("choose")}>‹ All services</button><div className="modal-icon success"><KeyRound size={22} /></div><h2 id="api-add-title">Add {PROVIDER_NAME[addStep]}</h2><p>{addStep === "claude_api" ? "Use a Claude Console API key. Your Claude subscription does not include API access or billing." : "Connect a Gemini API key for the remote Antigravity agent. This is separate from the Antigravity IDE and its personal account limits."}</p><label className="modal-label" htmlFor="api-account-name">Account name</label><input id="api-account-name" className="modal-input" autoFocus maxLength={80} value={apiLabel} onChange={(event) => setApiLabel(event.target.value)} placeholder={addStep === "claude_api" ? "Claude projects" : "My agent"} required /><label className="modal-label" htmlFor="api-account-key">API key</label><input id="api-account-key" className="modal-input" type="password" autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Paste your API key" required />{addStep === "claude_api" && <><label className="modal-label" htmlFor="api-workspace">Workspace ID <span className="optional">optional</span></label><input id="api-workspace" className="modal-input" value={apiWorkspace} onChange={(event) => setApiWorkspace(event.target.value)} placeholder="wrkspc_…" /><p className="field-help">Only needed for a key with access to multiple workspaces.</p></>}<p className="field-help">Your key is encrypted on this computer. It is never shown again in the app.</p>{apiFormError && <p className="form-error" role="alert">{apiFormError}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setAddStep("closed")}>Cancel</button><button type="submit" className="primary-button" disabled={!!workingAction || !apiLabel.trim() || !apiKey.trim()}>{workingAction === "add-api" ? <LoaderCircle size={17} className="spin" /> : <KeyRound size={17} />} Save API key</button></div></form></div>}

      {keyToReplace && <div className="modal-backdrop" role="presentation" onKeyDown={(event) => { if (event.key === "Escape") setKeyToReplace(null); }}><form className="modal" role="dialog" aria-modal="true" aria-labelledby="replace-title" onSubmit={(event) => { event.preventDefault(); void confirmReplaceKey(); }}><button className="modal-close icon-button" type="button" aria-label="Close" onClick={() => setKeyToReplace(null)}><X size={18} /></button><div className="modal-icon success"><KeyRound size={22} /></div><h2 id="replace-title">Replace API key</h2><p>Save a new key for {keyToReplace.label}. This replaces the key stored on this computer.</p><label className="modal-label" htmlFor="replacement-key">New API key</label><input id="replacement-key" className="modal-input" type="password" autoComplete="off" autoFocus value={replacementKey} onChange={(event) => setReplacementKey(event.target.value)} placeholder="Paste your new API key" required />{apiFormError && <p className="form-error" role="alert">{apiFormError}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setKeyToReplace(null)}>Cancel</button><button type="submit" className="primary-button" disabled={!!workingAction || !replacementKey.trim()}>Save key</button></div></form></div>}

      {accountToRename && <div className="modal-backdrop" role="presentation" onKeyDown={(event) => { if (event.key === "Escape") setAccountToRename(null); }}><form className="modal" role="dialog" aria-modal="true" aria-labelledby="rename-title" onSubmit={(event) => { event.preventDefault(); void confirmRename(); }}><button className="modal-close icon-button" type="button" aria-label="Close" onClick={() => setAccountToRename(null)}><X size={18} /></button><div className="modal-icon success"><Pencil size={22} /></div><h2 id="rename-title">Rename account</h2><p>Give {accountToRename.email ?? "this account"} a name that is easy to recognize.</p><label className="modal-label" htmlFor="account-name">Account name</label><input id="account-name" className="modal-input" autoFocus maxLength={80} value={renameDraft} onChange={(event) => setRenameDraft(event.target.value)} aria-invalid={!!renameError} aria-describedby={renameError ? "rename-error" : undefined} />{renameError && <p className="form-error" id="rename-error" role="alert">{renameError}</p>}<div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setAccountToRename(null)}>Cancel</button><button type="submit" className="primary-button" disabled={!!workingAction || !renameDraft.trim()}>Save name</button></div></form></div>}

      {accountToRemove && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAccountToRemove(null); }} onKeyDown={(event) => { if (event.key === "Escape") setAccountToRemove(null); }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="remove-title"><button className="modal-close icon-button" type="button" aria-label="Close" onClick={() => setAccountToRemove(null)}><X size={18} /></button><div className="modal-icon warning"><Trash2 size={22} /></div><h2 id="remove-title">Remove {accountToRemove.label}?</h2><p>This removes its saved connection and conversations from this computer. You can add it again later.</p><div className="modal-actions"><button type="button" className="secondary-button" autoFocus onClick={() => setAccountToRemove(null)}>Cancel</button><button type="button" className="danger-button" onClick={() => void confirmRemove()}>Remove account</button></div></div></div>}

      {showWelcome && <div className="modal-backdrop"><div className="modal welcome-modal" role="dialog" aria-modal="true" aria-labelledby="welcome-title"><div className="modal-icon success"><Check size={24} /></div><h2 id="welcome-title">You’re using your ChatGPT plan</h2><p>Eligible requests in Switchboard use the connected account’s ChatGPT plan. You can review and manage usage in ChatGPT settings.</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => api.openUsage()}>Manage usage <ExternalLink size={15} /></button><button type="button" className="primary-button" onClick={() => { localStorage.setItem("switchboard-welcome-seen", "1"); setShowWelcome(false); }}>Got it <ArrowRight size={17} /></button></div></div></div>}
      {addStep === "claude_subscription" && <div className="modal-backdrop" role="presentation" onKeyDown={(event) => { if (event.key === "Escape") setAddStep("closed"); }}>
        <form className="modal api-modal" role="dialog" aria-modal="true" aria-labelledby="claude-add-title" onSubmit={(event) => { event.preventDefault(); void confirmClaudeAdd(); }}>
          <button className="modal-close icon-button" type="button" aria-label="Close" onClick={() => setAddStep("closed")}><X size={18} /></button>
          <button className="modal-back-button" type="button" onClick={() => setAddStep("choose")}>‹ All services</button>
          <div className="modal-icon success"><MessageSquareText size={22} /></div>
          <h2 id="claude-add-title">Add Claude account</h2>
          <p>Name this connection, then complete Claude sign-in in your browser. Each account has its own local sign-in profile.</p>
          <label className="modal-label" htmlFor="claude-account-name">Account name</label>
          <input id="claude-account-name" className="modal-input" autoFocus maxLength={80} value={claudeLabel} onChange={(event) => setClaudeLabel(event.target.value)} placeholder="Personal Claude" required />
          {claudeFormError && <p className="form-error" role="alert">{claudeFormError}</p>}
          <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setAddStep("closed")}>Cancel</button><button type="submit" className="primary-button" disabled={!claudeLabel.trim() || !!workingAction}>Continue to sign-in <ArrowRight size={17} /></button></div>
        </form>
      </div>}
    </div>
  );
}
