import { useEffect, useState } from "react";
import { Columns3, ExternalLink, FolderOpen, LoaderCircle, LogIn, RotateCcw, SquareTerminal, X } from "lucide-react";
import { TerminalPane } from "./TerminalPane";
import type { AiswitchToolId, SwitchboardApi, TerminalInfo } from "./api";

export type OutsideSession = { key: string; tool: AiswitchToolId; folderId: string; folderName: string; title: string };

const LAYOUT_KEY = "switchboard.terminalLayout";

function readLayout(): "tabs" | "split" {
  try {
    return window.localStorage.getItem(LAYOUT_KEY) === "split" ? "split" : "tabs";
  } catch {
    return "tabs";
  }
}

export function TerminalsView({ api, terminals, outside, visible, busy, onClose, onPopOut, onBringInside, onRestart, onShowFolders }: {
  api: SwitchboardApi;
  terminals: TerminalInfo[];
  outside: OutsideSession[];
  visible: boolean;
  busy: string | null;
  onClose: (info: TerminalInfo) => void;
  onPopOut: (info: TerminalInfo) => void;
  onBringInside: (session: OutsideSession) => void;
  onRestart: (info: TerminalInfo) => void;
  onShowFolders: () => void;
}) {
  const [layout, setLayout] = useState<"tabs" | "split">(readLayout);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (!terminals.some((item) => item.id === activeId)) setActiveId(terminals.at(-1)?.id ?? null);
  }, [terminals, activeId]);

  const chooseLayout = (next: "tabs" | "split") => {
    setLayout(next);
    try { window.localStorage.setItem(LAYOUT_KEY, next); } catch { /* preference only */ }
  };

  const actions = (info: TerminalInfo) => (
    <span className="term-actions">
      {!info.running && (
        <button type="button" className="term-action" onClick={() => onRestart(info)} disabled={busy !== null} title="Start it again and continue the last conversation">
          <RotateCcw size={14} /> Restart
        </button>
      )}
      <button type="button" className="term-action" onClick={() => onPopOut(info)} disabled={busy !== null} title="Continue this conversation in its own terminal window">
        {busy === `pop:${info.id}` ? <LoaderCircle size={14} className="spin" /> : <ExternalLink size={14} />} Open outside
      </button>
      <button type="button" className="term-action icon" onClick={() => onClose(info)} aria-label={`Close ${info.title}`} disabled={busy !== null}><X size={15} /></button>
    </span>
  );

  return (
    <section className="term-view" hidden={!visible} aria-labelledby="term-title">
      <div className="term-toolbar">
        <h1 id="term-title"><SquareTerminal size={18} /> Terminals</h1>
        {terminals.length > 0 && (
          <div className="term-layout" role="group" aria-label="Layout">
            <button type="button" aria-pressed={layout === "tabs"} onClick={() => chooseLayout("tabs")}>Tabs</button>
            <button type="button" aria-pressed={layout === "split"} onClick={() => chooseLayout("split")}><Columns3 size={14} /> Side by side</button>
          </div>
        )}
      </div>

      {outside.length > 0 && (
        <div className="term-outside" role="status">
          <span>Running in their own windows:</span>
          {outside.map((session) => (
            <button key={session.key} type="button" className="term-chip" onClick={() => onBringInside(session)} disabled={busy !== null} title="Continue the conversation here; then close its window">
              {busy === `in:${session.key}` ? <LoaderCircle size={13} className="spin" /> : <LogIn size={13} />} {session.title} · Bring inside
            </button>
          ))}
        </div>
      )}

      {terminals.length === 0 ? (
        <div className="term-empty">
          <span className="cli-card-icon" aria-hidden="true"><SquareTerminal size={22} /></span>
          <h2>No terminals open</h2>
          <p>Open a project folder to start Claude Code, Codex and Antigravity here.</p>
          <button className="primary-button" type="button" onClick={onShowFolders}><FolderOpen size={17} /> Go to folders</button>
        </div>
      ) : (
        <>
          {layout === "tabs" && (
            <div className="term-tabs" role="tablist" aria-label="Open terminals">
              {terminals.map((info) => (
                <button key={info.id} type="button" role="tab" aria-selected={info.id === activeId} className={`term-tab ${info.id === activeId ? "active" : ""}`} onClick={() => setActiveId(info.id)}>
                  <span className={`term-dot ${info.running ? "on" : ""}`} aria-hidden="true" />{info.title}
                </button>
              ))}
            </div>
          )}
          <div className={`term-panes ${layout}`} style={layout === "split" ? { gridTemplateColumns: `repeat(${Math.min(terminals.length, 3)}, minmax(0, 1fr))` } : undefined}>
            {terminals.map((info) => {
              const shown = visible && (layout === "split" || info.id === activeId);
              return (
                <div key={info.id} className="term-pane" hidden={!(layout === "split" || info.id === activeId)} role={layout === "tabs" ? "tabpanel" : undefined}>
                  <div className="term-pane-head">
                    <span className="term-pane-title"><span className={`term-dot ${info.running ? "on" : ""}`} aria-hidden="true" />{info.title}</span>
                    {!info.running && <span className="term-ended">Ended{info.exitCode !== null ? ` (code ${info.exitCode})` : ""}</span>}
                    {actions(info)}
                  </div>
                  <TerminalPane api={api} info={info} visible={shown} />
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
