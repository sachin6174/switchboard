import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeftRight, ArrowRight, Check, CircleAlert, ExternalLink, Hourglass, LoaderCircle, LogIn, RefreshCw, Repeat, SquareTerminal, Trash2 } from "lucide-react";
import type { AiswitchAccount, AiswitchEvent, AiswitchLimitRow, AiswitchStatus, AiswitchTokens, AiswitchToolId, AiswitchToolStatus, SwitchboardApi } from "./api";

const BACKGROUND_MS = 60_000;
const WARN_LEFT = 10;
const CAUTION_LEFT = 30;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,30}$/;

const KIND_LABEL: Record<string, string> = {
  "5h": "5-hour",
  week: "Weekly",
  week_opus: "Weekly · Opus",
  week_sonnet: "Weekly · Sonnet",
  day: "Daily",
};

const PLAN_LABEL: Record<string, string> = { plus: "Plus", pro: "Pro", team: "Team", max: "Max", business: "Business", enterprise: "Enterprise" };

function rowLabel(row: AiswitchLimitRow): string {
  const kind = KIND_LABEL[row.kind] ?? row.kind;
  return row.group ? `${row.group.replace(" and ", " & ")} · ${kind}` : kind;
}

function level(left: number): "ok" | "caution" | "warn" {
  if (left <= WARN_LEFT) return "warn";
  if (left <= CAUTION_LEFT) return "caution";
  return "ok";
}

function duration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hr${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
  const hours = Math.floor((minutes % 1440) / 60);
  return `${Math.floor(minutes / 1440)} d${hours ? ` ${hours} hr` : ""}`;
}

function resetText(reset: number | null, nowSeconds: number): string {
  if (!reset) return "";
  return reset <= nowSeconds ? "Reset" : `Resets in ${duration(reset - nowSeconds)}`;
}

function agoText(observedAt: number, nowSeconds: number): string {
  const seconds = nowSeconds - observedAt;
  return seconds < 90 ? "Checked just now" : `Checked ${duration(seconds)} ago`;
}

function formatTokens(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
}

function lowestLeft(account: AiswitchAccount | undefined): number | null {
  const rows = account?.limits?.rows ?? [];
  return rows.length ? Math.min(...rows.map((row) => row.left)) : null;
}

/** Background reads skip token counting; keep the last counted tokens instead of blanking them. */
function mergeTokens(next: AiswitchStatus, previous: AiswitchStatus | null): AiswitchStatus {
  if (!previous) return next;
  return {
    ...next,
    tools: next.tools.map((tool) => {
      const before = previous.tools.find((item) => item.tool === tool.tool);
      return {
        ...tool,
        otherTokens: tool.otherTokens ?? before?.otherTokens ?? null,
        accounts: tool.accounts.map((account) => account.tokens !== null ? account : {
          ...account,
          tokens: before?.accounts.find((item) => item.name === account.name)?.tokens ?? null,
        }),
      };
    }),
  };
}

function LimitMeter({ row, nowSeconds }: { row: AiswitchLimitRow; nowSeconds: number }) {
  const left = Math.max(0, Math.min(100, Math.round(row.left)));
  const label = rowLabel(row);
  return (
    <div className="cli-meter">
      <div className="cli-meter-row"><span>{label}</span><strong>{left}% left</strong></div>
      <div className={`cli-meter-track cli-meter-${level(left)}`} role="meter" aria-label={`${label} remaining`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={left}>
        <span style={{ width: `${left}%` }} />
      </div>
      <small>{resetText(row.reset, nowSeconds)}</small>
    </div>
  );
}

function TokenTable({ tokens, caption }: { tokens: Record<string, AiswitchTokens>; caption: string }) {
  const models = Object.entries(tokens).sort(([, a], [, b]) => (b.in + b.out + b.cache) - (a.in + a.out + a.cache));
  return (
    <table className="cli-tokens">
      <caption>{caption}</caption>
      <thead><tr><th scope="col">Model</th><th scope="col">Input</th><th scope="col">Output</th><th scope="col">Cache</th><th scope="col">Thinking</th></tr></thead>
      <tbody>
        {models.map(([model, t]) => (
          <tr key={model}><th scope="row">{model}</th><td>{formatTokens(t.in)}</td><td>{formatTokens(t.out)}</td><td>{formatTokens(t.cache)}</td><td>{t.think ? formatTokens(t.think) : "—"}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

function AccountRow({ tool, account, days, nowSeconds, busy, onUse, onReset, onRemove }: {
  tool: AiswitchToolStatus;
  account: AiswitchAccount;
  days: number;
  nowSeconds: number;
  busy: string | null;
  onUse: () => void;
  onReset: () => void;
  onRemove: () => void;
}) {
  const resting = account.cooldownUntil !== null && account.cooldownUntil > nowSeconds;
  const plan = account.limits?.plan ? PLAN_LABEL[account.limits.plan] ?? account.limits.plan : null;
  const stale = account.limits ? nowSeconds - account.limits.observedAt > 600 : false;
  const key = `${tool.tool}:${account.name}`;
  return (
    <li className={`cli-acct ${account.active ? "active" : ""}`}>
      <div className="cli-acct-top">
        <div className="cli-acct-id">
          <strong>{account.email ?? account.name}</strong>
          <span className="cli-acct-tags">
            <code>{account.name}</code>
            {plan && <span className="cli-plan">{plan}</span>}
            {account.active && <span className="cli-active-badge">Active</span>}
            {resting && <span className="cli-rest-badge"><Hourglass size={12} />Resting {duration(account.cooldownUntil! - nowSeconds)}</span>}
          </span>
        </div>
        <div className="cli-acct-actions">
          {resting && <button type="button" className="cli-profile-use" onClick={onReset} disabled={busy !== null} title="Let auto-switch use this account again before its rest ends">Clear rest</button>}
          <button type="button" className="cli-profile-switch" onClick={onUse} disabled={account.active || busy !== null}>
            {busy === `use:${key}` ? <LoaderCircle size={14} className="spin" /> : account.active ? <Check size={14} /> : <ArrowLeftRight size={14} />}
            {account.active ? "In use" : "Switch"}
          </button>
          <button type="button" className="cli-profile-remove" aria-label={`Remove ${account.email ?? account.name}`} onClick={onRemove} disabled={busy !== null}><Trash2 size={14} /></button>
        </div>
      </div>

      {account.limits && account.limits.rows.length > 0 ? (
        <div className="cli-acct-meters">
          {account.limits.rows.map((row) => <LimitMeter key={`${row.group}-${row.kind}`} row={row} nowSeconds={nowSeconds} />)}
        </div>
      ) : (
        <p className="cli-acct-note">{tool.tool === "codex" ? "Limits appear after this account runs codex once." : tool.tool === "claude" ? "Limits appear the next time this account's sign-in is fresh (use it once)." : "Limits appear after the next agy check (Refresh)."}</p>
      )}
      {account.limits && stale && <small className="cli-acct-ago">{agoText(account.limits.observedAt, nowSeconds)}</small>}

      {account.tokens && Object.keys(account.tokens).length > 0 && <TokenTable tokens={account.tokens} caption={`Tokens used · last ${days} days`} />}
      {account.tokens && Object.keys(account.tokens).length === 0 && tool.tool !== "agy" && <p className="cli-acct-note">No tokens used in the last {days} days.</p>}
    </li>
  );
}

function eventTime(at: number, nowSeconds: number): string {
  const date = new Date(at * 1000);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (nowSeconds - at < 86_400 && new Date(nowSeconds * 1000).getDate() === date.getDate()) return `Today ${time}`;
  return `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

function RecentSwitches({ tool, events, nowSeconds }: { tool: AiswitchToolStatus; events: AiswitchEvent[]; nowSeconds: number }) {
  const label = (name: string | null) => {
    const account = tool.accounts.find((item) => item.name === name);
    return account?.email ?? name ?? "unsaved login";
  };
  return (
    <div className="cli-events">
      <h3>Recent switches</h3>
      <ol>
        {events.map((event) => (
          <li key={`${event.at}-${event.to}`}>
            <span className="cli-event-time">{eventTime(event.at, nowSeconds)}</span>
            <span className="cli-event-move">{label(event.from)} <ArrowRight size={12} aria-label="to" /> {label(event.to)}</span>
            <span className={`cli-event-why ${event.reason === "limit" ? "limit" : ""}`}>
              {event.reason === "limit" ? `Limit reached${event.until && event.until > nowSeconds ? ` · free in ${duration(event.until - nowSeconds)}` : ""}` : "Switched by you"}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function AddAccount({ tool, busy, onAdd }: { tool: AiswitchToolStatus; busy: boolean; onAdd: (name: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const valid = NAME_PATTERN.test(name.trim());
  const submit = async () => {
    if (!valid) return;
    if (await onAdd(name.trim())) { setName(""); setOpen(false); }
  };
  if (!open) return <button type="button" className="cli-profile-add-button" onClick={() => setOpen(true)}><LogIn size={14} /> Sign in another account</button>;
  return (
    <form className="cli-add" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label htmlFor={`add-${tool.tool}`}>Short name for the account</label>
      <div className="cli-profile-add">
        <input id={`add-${tool.tool}`} autoFocus maxLength={31} value={name} placeholder="e.g. work" onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setOpen(false); setName(""); } }} aria-describedby={`add-${tool.tool}-hint`} />
        <button type="submit" className="cli-profile-save" disabled={!valid || busy}>{busy ? <LoaderCircle size={14} className="spin" /> : "Open sign-in"}</button>
      </div>
      <small id={`add-${tool.tool}-hint`}>
        A terminal opens and signs out of {tool.title} on this computer (your current account is saved first), then starts the {tool.tool === "agy" ? "agy sign-in — press Ctrl+C after you're signed in" : "browser sign-in"}. If the browser picks your current account, sign out on the website or use a private window.
      </small>
    </form>
  );
}

export function CliStatusView({ api }: { api: SwitchboardApi }) {
  const [status, setStatus] = useState<AiswitchStatus | null>(null);
  const [loadError, setLoadError] = useState<{ message: string; code?: string } | null>(null);
  const [refreshing, setRefreshing] = useState<"initial" | "refresh" | null>("initial");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [selected, setSelected] = useState<AiswitchToolId>("claude");
  const [nowSeconds, setNowSeconds] = useState(() => Date.now() / 1000);
  const statusRef = useRef<AiswitchStatus | null>(null);

  const load = useCallback(async (mode: "initial" | "background" | "refresh") => {
    if (mode !== "background") setRefreshing(mode);
    try {
      const next = mergeTokens(await api.getAiswitchStatus(mode), statusRef.current);
      statusRef.current = next;
      setStatus(next);
      setLoadError(null);
    } catch (error) {
      const err = error as Error & { code?: string };
      if (!statusRef.current || mode !== "background") setLoadError({ message: err?.message || "Accounts could not be read.", code: err?.code });
    } finally {
      setNowSeconds(Date.now() / 1000);
      if (mode !== "background") setRefreshing(null);
    }
  }, [api]);

  useEffect(() => {
    void load("initial");
    const timer = window.setInterval(() => void load("background"), BACKGROUND_MS);
    // Coming back from a sign-in terminal shows the new account.
    const onFocus = () => void load("background");
    window.addEventListener("focus", onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [load]);

  const act = useCallback(async (key: string, task: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    setNotice(null);
    try {
      const result = await task() as { warning?: string | null } | undefined;
      if (result?.warning) setNotice({ tone: "error", text: `${success ? `${success} ` : ""}${result.warning}` });
      else if (success) setNotice({ tone: "success", text: success });
      await load("background");
    } catch (error) {
      setNotice({ tone: "error", text: (error as Error)?.message || "That didn't work. Try again." });
    } finally {
      setBusy(null);
    }
  }, [load]);

  const tool = status?.tools.find((item) => item.tool === selected) ?? status?.tools[0];
  const auto = status?.autoSwitch;

  return (
    <section className="cli-view" aria-labelledby="cli-title">
      <div className="cli-view-head">
        <div>
          <span className="overline">CODING TOOLS</span>
          <h1 id="cli-title">CLI accounts</h1>
          <p>Every account saved for Claude Code, Codex and Antigravity, with what each has left.</p>
        </div>
        <button className="secondary-button" type="button" onClick={() => void load("refresh")} disabled={refreshing !== null || busy !== null}>
          {refreshing ? <LoaderCircle size={17} className="spin" /> : <RefreshCw size={17} />} Refresh
        </button>
      </div>

      {auto && (
        <div className={`cli-autoswitch ${auto.enabled ? "on" : ""}`}>
          <span className="cli-autoswitch-icon" aria-hidden="true"><Repeat size={20} /></span>
          <div>
            <strong>Switch accounts automatically at the limit</strong>
            <p>{auto.supported
              ? "When codex, claude or agy shows its usage-limit message in your terminal, the next ready account is signed in and the session resumes. Applies to terminal windows opened after you turn it on."
              : `Not available on this system. ${auto.reason ?? ""} Use Switch below instead.`}</p>
          </div>
          {auto.supported && (
            <button type="button" role="switch" aria-checked={auto.enabled} aria-label="Switch accounts automatically at the limit" className="cli-toggle" disabled={busy !== null}
              onClick={() => void act("auto", () => api.setAutoSwitch(!auto.enabled), auto.enabled ? "Auto-switch is off for new terminal windows." : "Auto-switch is on. Open a new terminal window to use it.")}>
              <span />
            </button>
          )}
        </div>
      )}

      {notice && (
        <div className={`notice notice-${notice.tone}`} role="status"><span className="notice-icon">{notice.tone === "success" ? <Check size={19} /> : <CircleAlert size={19} />}</span><div><p>{notice.text}</p></div></div>
      )}

      {!status && refreshing ? (
        <div className="loading-view"><LoaderCircle size={28} className="spin" /><span>Reading accounts… checking agy can take up to a minute.</span></div>
      ) : !status && loadError ? (
        <div className="notice notice-error" role="alert"><span className="notice-icon"><CircleAlert size={19} /></span><div><strong>{loadError.code === "PYTHON_MISSING" ? "Python 3 is needed" : "Accounts could not be read"}</strong><p>{loadError.message}</p></div></div>
      ) : status && tool ? (
        <div className="cli-layout">
          <nav className="cli-rail" aria-label="AI tools">
            {status.tools.map((item) => {
              const left = lowestLeft(item.accounts.find((account) => account.active));
              return (
                <button key={item.tool} type="button" className={`cli-rail-item ${tool.tool === item.tool ? "selected" : ""}`} aria-current={tool.tool === item.tool ? "true" : undefined} onClick={() => setSelected(item.tool)}>
                  <span className="cli-rail-icon"><SquareTerminal size={18} /></span>
                  <span className="cli-rail-text">
                    <strong>{item.title}</strong>
                    <small>{item.accounts.length === 0 ? "No accounts yet" : `${item.accounts.length} account${item.accounts.length === 1 ? "" : "s"}`}</small>
                  </span>
                  {left !== null && <span className={`cli-rail-dot ${left <= WARN_LEFT ? "near" : ""}`} aria-hidden="true" />}
                </button>
              );
            })}
          </nav>

          <div className="cli-detail">
            <article className="cli-card" aria-labelledby={`cli-${tool.tool}`}>
              <div className="cli-card-head">
                <span className="cli-card-icon" aria-hidden="true"><SquareTerminal size={20} /></span>
                <div>
                  <h2 id={`cli-${tool.tool}`}>{tool.title}</h2>
                  <code>{tool.command}</code>
                </div>
                {refreshing === "refresh" && <span className="cli-checking"><LoaderCircle size={14} className="spin" />{tool.tool === "agy" ? "Checking each account…" : "Refreshing…"}</span>}
              </div>

              {tool.accounts.length === 0 ? (
                <p className="cli-note">No {tool.title} accounts saved yet. Sign in below; the account you're signed in to now is kept as the first one.</p>
              ) : (
                <ul className="cli-acct-list">
                  {tool.accounts.map((account) => (
                    <AccountRow
                      key={account.name}
                      tool={tool}
                      account={account}
                      days={status.days}
                      nowSeconds={nowSeconds}
                      busy={busy}
                      onUse={() => void act(`use:${tool.tool}:${account.name}`, () => api.useAiswitchAccount(tool.tool, account.name), `${tool.title} now uses ${account.email ?? account.name}.`)}
                      onReset={() => void act(`reset:${tool.tool}:${account.name}`, () => api.resetAiswitchLimit(tool.tool, account.name))}
                      onRemove={() => {
                        if (!window.confirm(`Remove ${account.email ?? account.name} from ${tool.title}? Its saved sign-in on this computer is deleted.${account.active ? " You stay signed in to it until you switch." : ""}`)) return;
                        void act(`remove:${tool.tool}:${account.name}`, () => api.removeAiswitchAccount(tool.tool, account.name));
                      }}
                    />
                  ))}
                </ul>
              )}

              {tool.events.length > 0 && <RecentSwitches tool={tool} events={tool.events} nowSeconds={nowSeconds} />}

              {tool.notes.includes("agy_session_open") && <p className="cli-note">An agy session is open, so other accounts show their last known quota.</p>}
              {tool.notes.includes("agy_app_open") && <p className="cli-note">The Antigravity app is open, so other accounts show their last known quota. It shares agy's sign-in, so checking them now could leave it on the wrong account. Quit Antigravity and press Refresh to check them.</p>}

              <AddAccount tool={tool} busy={busy === `add:${tool.tool}`} onAdd={async (name) => {
                if (tool.accounts.some((account) => account.name === name)) {
                  setNotice({ tone: "error", text: `"${name}" is already used for ${tool.title}. Pick another name.` });
                  return false;
                }
                let opened = false;
                await act(`add:${tool.tool}`, async () => { await api.addAiswitchAccount(tool.tool, name); opened = true; },
                  `A terminal opened for the ${tool.title} sign-in. Finish there; "${name}" appears here when you come back.`);
                return opened;
              }} />

              {tool.otherTokens && Object.keys(tool.otherTokens).length > 0 && (
                <div className="cli-other">
                  <TokenTable tokens={tool.otherTokens} caption={tool.tool === "claude" ? `Tokens before account tracking started · last ${status.days} days` : `Tokens from accounts not saved here · last ${status.days} days`} />
                </div>
              )}

              <div className="cli-card-foot">
                <span>{tool.tool === "agy" ? "agy keeps no token log, so only its quota is shown." : `Tokens counted from ${tool.title}'s local logs.`}</span>
                <button type="button" onClick={() => void api.openCliUsage(tool.tool)}>{tool.tool === "agy" ? "Open Antigravity" : "Manage usage"} <ExternalLink size={14} /></button>
              </div>
            </article>
            <p className="cli-footnote">Switching and sign-ins are handled by aiswitch on this computer. Limits are what each provider reports; no provider shares a remaining token balance.</p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
