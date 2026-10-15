/** Data that is safe to send to the renderer. Credentials never cross IPC. */
export interface AccountSummary {
  id: string;
  label: string;
  email: string | null;
  active: boolean;
  status: "connected" | "needs_sign_in";
  planUsageEnabled: boolean;
  accessTokenExpiresAt: string | null;
}

export type AuthAccountEvent =
  | { type: "accounts_changed" }
  | { type: "terminal_refresh"; accountId: string };

export type AuthErrorCode =
  | "NOT_INITIALIZED"
  | "NOT_FOUND"
  | "NO_ACTIVE_ACCOUNT"
  | "NEEDS_SIGN_IN"
  | "PLAN_USAGE_DISABLED"
  | "AUTH_BUSY"
  | "AUTH_TIMEOUT"
  | "AUTH_CANCELLED"
  | "AUTH_FAILED"
  | "INVALID_LABEL"
  | "LABEL_TAKEN"
  | "IDENTITY_MISMATCH"
  | "TOKEN_RESPONSE_INVALID"
  | "REFRESH_TERMINAL"
  | "REFRESH_TEMPORARY"
  | "STORAGE_UNAVAILABLE"
  | "STORAGE_CORRUPT";
