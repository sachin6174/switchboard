export type SelectableAccount = {
  id: string;
  provider: string;
  status: string;
  planUsageEnabled: boolean;
};

/**
 * Search from the connection after the failed or removed one. A removed
 * connection has no index in the current list, so search every remaining row.
 */
export function nextEligibleAccount<T extends SelectableAccount>(
  accounts: T[],
  provider: string,
  afterId: string,
): T | null {
  const matching = accounts.filter((account) => account.provider === provider);
  const startingIndex = matching.findIndex((account) => account.id === afterId);
  const candidateCount = startingIndex === -1 ? matching.length : matching.length - 1;
  for (let offset = 1; offset <= candidateCount; offset += 1) {
    const candidate = matching[(startingIndex + offset + matching.length) % matching.length];
    if (candidate.status === "ready" || (candidate.status === "connected" && candidate.planUsageEnabled)) {
      return candidate;
    }
  }
  return null;
}
