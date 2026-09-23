import type { AccountPerformanceInput } from "../../src/domain/finance/accountLedger";

/** Existing accounting/reporting fixtures previously asserted COMPLETE. Supply an actual
 * successful 90-day sync + exact snapshot identity instead. Deliberately does not manufacture
 * historical coverage before that request window; longer-history regressions use explicit runs. */
export function withFundingSyncFixture(input: AccountPerformanceInput): AccountPerformanceInput {
  const entries = input.ledgerEntries.map((entry, index) => ({ ...entry, id: entry.id ?? `fixture-entry-${index}` }));
  const snapshots = entries.filter((entry) => entry.type === "BROKER_SNAPSHOT")
    .sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());
  const snapshot = snapshots.at(-1);
  if (!snapshot) return { ...input, ledgerEntries: entries };
  const end = new Date(snapshot.occurredAt);
  const accountId = `fixture-account-${end.toISOString()}`;
  return { ...input, ledgerEntries: entries, fundingCoverage: {
    accountId, externalAccountId: accountId,
    fundingSyncs: [{ id: "fixture-run", accountId, externalAccountId: accountId, provider: "SCHWAB",
      coverageStart: new Date(end.getTime() - 90 * 86400000), coverageEnd: end,
      startedAt: end, completedAt: end, balanceSnapshotLedgerEntryId: snapshot.id,
      status: "COMPLETE", persistenceStatus: "COMPLETE", tradeStatus: "COMPLETE",
      receiveAndDeliverStatus: "COMPLETE", dividendOrInterestStatus: "COMPLETE",
    }],
  } };
}
