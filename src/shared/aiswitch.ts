/**
 * Account and usage data reported by tools/aiswitch/aiswitch.py (`aiswitch json status`).
 * The script owns switching and sign-in storage; this data never includes credentials.
 */
export type AiswitchToolId = "claude" | "codex" | "agy";

/** One limit window. `left` is the percent remaining; `reset` is Unix epoch seconds. */
export type AiswitchLimitRow = {
  /** "5h", "week", "week_opus", "week_sonnet", "day", or "<n> min". */
  kind: string;
  /** Model group the window applies to (agy: "Gemini", "Claude and GPT"); null when it covers everything. */
  group: string | null;
  left: number;
  reset: number | null;
};

export type AiswitchLimits = {
  plan: string | null;
  /** When the limits were read, as epoch seconds. */
  observedAt: number;
  rows: AiswitchLimitRow[];
};

export type AiswitchTokens = { in: number; out: number; cache: number; think: number };

export type AiswitchAccount = {
  name: string;
  email: string | null;
  active: boolean;
  /** Set while aiswitch rests this account after it hit a limit (epoch seconds). */
  cooldownUntil: number | null;
  limits: AiswitchLimits | null;
  /** Tokens per model over the report window; null when tokens were not counted for this read. */
  tokens: Record<string, AiswitchTokens> | null;
};

/** A recorded account change: by auto-switch at a limit, or by the user. */
export type AiswitchEvent = {
  at: number;
  from: string | null;
  to: string;
  reason: "limit" | "manual" | string;
  /** For limit switches: when the spent account frees up (epoch seconds), if known. */
  until: number | null;
};

export type AiswitchToolStatus = {
  tool: AiswitchToolId;
  title: string;
  command: string;
  active: string | null;
  accounts: AiswitchAccount[];
  /** Tokens that can't be credited to a saved account (older logs, other accounts). */
  otherTokens: Record<string, AiswitchTokens> | null;
  /** "claude_tokens_before_tracking", "agy_session_open", "agy_no_token_log". */
  notes: string[];
  /** Newest first, at most 5. */
  events: AiswitchEvent[];
};

export type AiswitchAutoSwitch = { supported: boolean; enabled: boolean; files: string[]; reason: string | null };

export type AiswitchStatus = {
  version: 1;
  platform: string;
  days: number;
  generatedAt: number;
  autoSwitch: AiswitchAutoSwitch;
  tools: AiswitchToolStatus[];
};

/**
 * initial: probe agy if its cached quota is older than 5 minutes, count tokens.
 * background: cached agy quota only, no token count (cheap, for periodic refresh).
 * refresh: probe every agy account now and count tokens.
 */
export type AiswitchReadMode = "initial" | "background" | "refresh";
