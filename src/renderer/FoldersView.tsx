import { useCallback, useEffect, useState } from "react";
import { AppWindow, Check, CircleAlert, Folder, FolderPlus, LoaderCircle, PanelsTopLeft, ShieldAlert, SquareTerminal, Trash2 } from "lucide-react";
import type { AiswitchToolId, ProjectFolder, SwitchboardApi, TerminalInfo, TerminalPlacement } from "./api";

const PLACEMENT_KEY = "switchboard.terminalPlacement";

function readPlacement(): TerminalPlacement {
  try {
    return window.localStorage.getItem(PLACEMENT_KEY) === "outside" ? "outside" : "inside";
  } catch {
    return "inside";
  }
}

const TOOLS: Array<{ id: AiswitchToolId; label: string }> = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "agy", label: "Antigravity" },
];

function openedText(folder: ProjectFolder): string {
  if (!folder.lastOpenedAt) return "Not opened yet";
  const minutes = Math.round((Date.now() - folder.lastOpenedAt) / 60_000);
  if (minutes < 1) return "Opened just now";
  if (minutes < 60) return `Opened ${minutes} min ago`;
  if (minutes < 1440) return `Opened ${Math.round(minutes / 60)} hr ago`;
  return `Opened ${Math.round(minutes / 1440)} d ago`;
}

export type FoldersOpened = { folder: ProjectFolder; tools: AiswitchToolId[]; placement: TerminalPlacement; terminals: TerminalInfo[] };

export function FoldersView({ api, onOpened }: { api: SwitchboardApi; onOpened: (result: FoldersOpened) => void }) {
  const [folders, setFolders] = useState<ProjectFolder[] | null>(null);
  const [placement, setPlacement] = useState<TerminalPlacement>(readPlacement);
  const choosePlacement = (next: TerminalPlacement) => {
    setPlacement(next);
    try { window.localStorage.setItem(PLACEMENT_KEY, next); } catch { /* preference only */ }
  };
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setFolders(await api.listFolders());
    } catch (error) {
      setFolders([]);
      setNotice({ tone: "error", text: (error as Error)?.message || "Folders could not be read." });
    }
  }, [api]);

  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const run = useCallback(async (key: string, task: () => Promise<string | null>) => {
    setBusy(key);
    setNotice(null);
    try {
      const message = await task();
      if (message) setNotice({ tone: "success", text: message });
      await load();
    } catch (error) {
      setNotice({ tone: "error", text: (error as Error)?.message || "That didn't work. Try again." });
    } finally {
      setBusy(null);
    }
  }, [load]);

  const add = () => void run("add", async () => {
    const folder = await api.addFolder();
    return folder ? `Added ${folder.name}.` : null;
  });

  const open = (folder: ProjectFolder, tools?: AiswitchToolId[]) => void run(`open:${folder.id}:${tools?.join() ?? "all"}`, async () => {
    const chosen = tools ?? TOOLS.map((tool) => tool.id);
    const result = await api.openFolder(folder.id, chosen, placement);
    onOpened({ folder: result.folder, tools: chosen, placement, terminals: result.terminals });
    if (placement === "inside") return null;
    const names = chosen.map((id) => TOOLS.find((tool) => tool.id === id)!.label);
    return `Opened ${names.length === 1 ? names[0] : `${names.length} terminal windows (${names.join(", ")})`} in ${folder.name}.`;
  });

  const remove = (folder: ProjectFolder) => {
    if (!window.confirm(`Remove ${folder.name} from the list? The folder itself isn't touched.`)) return;
    void run(`remove:${folder.id}`, async () => { await api.removeFolder(folder.id); return null; });
  };

  return (
    <section className="cli-view folders-view" aria-labelledby="folders-title">
      <div className="cli-view-head">
        <div>
          <span className="overline">WORKSPACE</span>
          <h1 id="folders-title">Project folders</h1>
          <p>Add the folders you work in. Open one to start Claude Code, Codex and Antigravity there, each in its own terminal.</p>
        </div>
        <button className="primary-button" type="button" onClick={add} disabled={busy !== null}>
          {busy === "add" ? <LoaderCircle size={17} className="spin" /> : <FolderPlus size={17} />} Add folder
        </button>
      </div>

      <div className="folders-warning">
        <ShieldAlert size={18} aria-hidden="true" />
        <p>
          <strong>Full-permission mode.</strong> The terminals start with approval prompts turned off
          (<code>--dangerously-skip-permissions</code> for Claude and Antigravity, <code>--dangerously-bypass-approvals-and-sandbox</code> for Codex),
          so they edit files and run commands in the folder without asking. They run through aiswitch, so a usage limit switches accounts when auto-switch is on.
        </p>
      </div>

      <div className="folders-placement" role="radiogroup" aria-label="Where terminals open">
        <span>Open terminals</span>
        <button type="button" role="radio" aria-checked={placement === "inside"} onClick={() => choosePlacement("inside")}><PanelsTopLeft size={15} /> Inside the app</button>
        <button type="button" role="radio" aria-checked={placement === "outside"} onClick={() => choosePlacement("outside")}><AppWindow size={15} /> Separate windows</button>
      </div>

      {notice && (
        <div className={`notice notice-${notice.tone}`} role="status"><span className="notice-icon">{notice.tone === "success" ? <Check size={19} /> : <CircleAlert size={19} />}</span><div><p>{notice.text}</p></div></div>
      )}

      {folders === null ? (
        <div className="loading-view"><LoaderCircle size={28} className="spin" /><span>Loading folders…</span></div>
      ) : folders.length === 0 ? (
        <div className="folders-empty">
          <span className="cli-card-icon" aria-hidden="true"><Folder size={22} /></span>
          <h2>No folders yet</h2>
          <p>Folders you add stay here the next time you open Switchboard.</p>
          <button className="primary-button" type="button" onClick={add} disabled={busy !== null}><FolderPlus size={17} /> Add folder</button>
        </div>
      ) : (
        <ul className="folder-list">
          {folders.map((folder) => (
            <li key={folder.id} className={`folder-card ${folder.missing ? "missing" : ""}`}>
              <div className="folder-card-head">
                <span className="cli-card-icon" aria-hidden="true"><Folder size={20} /></span>
                <div className="folder-card-id">
                  <h2>{folder.name}</h2>
                  <code title={folder.path}>{folder.path}</code>
                </div>
                <button type="button" className="cli-profile-remove" aria-label={`Remove ${folder.name} from the list`} onClick={() => remove(folder)} disabled={busy !== null}><Trash2 size={14} /></button>
              </div>
              {folder.missing ? (
                <p className="folder-missing"><CircleAlert size={14} /> This folder was moved or deleted.</p>
              ) : (
                <small className="folder-opened">{openedText(folder)}</small>
              )}
              <div className="folder-actions">
                <button type="button" className="primary-button folder-open-all" onClick={() => open(folder)} disabled={folder.missing || busy !== null}>
                  {busy === `open:${folder.id}:all` ? <LoaderCircle size={17} className="spin" /> : <SquareTerminal size={17} />} Open all three
                </button>
                <div className="folder-single" role="group" aria-label={`Open one tool in ${folder.name}`}>
                  {TOOLS.map((tool) => (
                    <button key={tool.id} type="button" className="cli-profile-use" onClick={() => open(folder, [tool.id])} disabled={folder.missing || busy !== null}>
                      {busy === `open:${folder.id}:${tool.id}` ? <LoaderCircle size={14} className="spin" /> : null}{tool.label}
                    </button>
                  ))}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
