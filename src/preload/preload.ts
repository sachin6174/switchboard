import { contextBridge, ipcRenderer } from "electron";
import type { ChatEvent } from "../main/chat";

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: { message: string; code?: string; kind?: string; status?: number } };

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(channel, ...args) as IpcResult<T>;
  if (result.ok) return result.data;
  const error = Object.assign(new Error(result.error.message), {
    code: result.error.code,
    kind: result.error.kind,
    status: result.error.status,
  });
  throw error;
}

contextBridge.exposeInMainWorld("switchboard", {
  listAccounts: () => invoke("accounts:list"),
  addAccount: () => invoke("accounts:add"),
  addClaudeAccount: (label: string) => invoke("accounts:add-claude", label),
  addApiAccount: (provider: "claude_api" | "antigravity_api", label: string, apiKey: string, workspaceId?: string) => invoke("accounts:add-api", provider, label, apiKey, workspaceId),
  activateAccount: (id: string) => invoke("accounts:activate", id),
  renameAccount: (id: string, label: string) => invoke("accounts:rename", id, label),
  reconnectAccount: (id: string) => invoke("accounts:reconnect", id),
  replaceApiKey: (id: string, apiKey: string) => invoke("accounts:replace-key", id, apiKey),
  signOutAccount: (id: string) => invoke("accounts:sign-out", id),
  removeAccount: (id: string) => invoke("accounts:remove", id),
  getConversation: (id: string) => invoke("chat:conversation", id),
  clearConversation: (id: string) => invoke("chat:clear", id),
  listModels: (id: string) => invoke("chat:models", id),
  sendMessage: (id: string, model: string, content: string) => invoke("chat:send", id, model, content),
  retryAccount: (id: string) => invoke("chat:retry", id),
  getRateLimit: (id: string) => invoke("chat:rate-limit", id),
  getAccountUsage: () => invoke("usage:all"),
  openUsage: (provider?: string) => invoke("usage:open", provider),
  openProvider: (provider: string) => invoke("provider:open", provider),
  getAiswitchStatus: (mode: "initial" | "background" | "refresh") => invoke("aiswitch:status", mode),
  useAiswitchAccount: (tool: string, name: string) => invoke("aiswitch:use", tool, name),
  addAiswitchAccount: (tool: string, name: string) => invoke("aiswitch:add", tool, name),
  removeAiswitchAccount: (tool: string, name: string) => invoke("aiswitch:remove", tool, name),
  resetAiswitchLimit: (tool: string, name?: string) => invoke("aiswitch:reset-limit", tool, name),
  setAutoSwitch: (on: boolean) => invoke("aiswitch:auto-switch", on),
  openCliUsage: (tool: string) => invoke("aiswitch:open-usage", tool),
  listFolders: () => invoke("folders:list"),
  addFolder: () => invoke("folders:add"),
  removeFolder: (id: string) => invoke("folders:remove", id),
  openFolder: (id: string, tools: string[] | undefined, placement: "inside" | "outside", resume?: boolean, size?: { cols: number; rows: number }) =>
    invoke("folders:open", id, tools, placement, resume === true, size),
  listTerminals: () => invoke("term:list"),
  terminalBuffer: (id: string) => invoke("term:buffer", id),
  writeTerminal: (id: string, data: string) => invoke("term:write", id, data),
  resizeTerminal: (id: string, cols: number, rows: number) => invoke("term:resize", id, cols, rows),
  closeTerminal: (id: string) => invoke("term:close", id),
  popOutTerminal: (id: string) => invoke("term:pop-out", id),
  onTerminalData: (listener: (event: { id: string; seq: number; data: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string; seq: number; data: string }) => listener(data);
    ipcRenderer.on("term:data", handler);
    return () => ipcRenderer.removeListener("term:data", handler);
  },
  onTerminalExit: (listener: (event: { id: string; code: number | null }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string; code: number | null }) => listener(data);
    ipcRenderer.on("term:exit", handler);
    return () => ipcRenderer.removeListener("term:exit", handler);
  },
  onAccountsChanged: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on("accounts:changed", handler);
    return () => ipcRenderer.removeListener("accounts:changed", handler);
  },
  onSessionRecovery: (listener: (event: { fromLabel: string; toLabel: string | null }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { fromLabel: string; toLabel: string | null }) => listener(data);
    ipcRenderer.on("session:recovery", handler);
    return () => ipcRenderer.removeListener("session:recovery", handler);
  },
  onChatEvent: (listener: (event: ChatEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: ChatEvent) => listener(data);
    ipcRenderer.on("chat:event", handler);
    return () => ipcRenderer.removeListener("chat:event", handler);
  },
});
