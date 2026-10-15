import assert from "node:assert/strict";
import test from "node:test";
import { nextEligibleAccount, type SelectableAccount } from "../src/main/account-selection";

const accounts: SelectableAccount[] = [
  { id: "gpt-1", provider: "chatgpt", status: "needs_sign_in", planUsageEnabled: false },
  { id: "gpt-2", provider: "chatgpt", status: "connected", planUsageEnabled: true },
  { id: "gpt-3", provider: "chatgpt", status: "connected", planUsageEnabled: true },
  { id: "claude-1", provider: "claude_api", status: "invalid", planUsageEnabled: false },
  { id: "claude-2", provider: "claude_api", status: "ready", planUsageEnabled: false },
  { id: "gemini-1", provider: "antigravity_api", status: "ready", planUsageEnabled: false },
];

test("selects the next eligible connection after a session fails", () => {
  assert.equal(nextEligibleAccount(accounts, "chatgpt", "gpt-1")?.id, "gpt-2");
  assert.equal(nextEligibleAccount(accounts, "chatgpt", "gpt-3")?.id, "gpt-2");
});

test("checks every same-provider connection after removing the active row", () => {
  assert.equal(nextEligibleAccount(accounts.filter((item) => item.id !== "claude-1"), "claude_api", "claude-1")?.id, "claude-2");
  assert.equal(nextEligibleAccount(accounts.filter((item) => item.id !== "gpt-2"), "chatgpt", "gpt-2")?.id, "gpt-3");
  assert.equal(nextEligibleAccount(accounts, "antigravity_api", "removed-id")?.id, "gemini-1");
});

test("keeps failover within the provider and skips ineligible connections", () => {
  assert.equal(nextEligibleAccount(accounts, "antigravity_api", "gemini-1"), null);
  assert.equal(nextEligibleAccount(accounts.filter((item) => item.id !== "claude-2"), "claude_api", "claude-1"), null);
  assert.equal(nextEligibleAccount([], "chatgpt", "removed-id"), null);
});
