/** Persisted fetch/persistence evidence. Observed times are not market valuation times. */
export type FundingSyncEvidence = {
  id: string;
  accountId: string;
  externalAccountId: string;
  provider: string;
  coverageStart: Date;
  coverageEnd: Date;
  startedAt: Date;
  completedAt: Date | null;
  status: string;
  tradeStatus: string;
  receiveAndDeliverStatus: string;
  dividendOrInterestStatus: string;
  persistenceStatus: string;
  balanceSnapshotLedgerEntryId: string | null;
};

export type FundingCoverageInput = {
  accountId: string;
  externalAccountId: string | null;
  fundingSyncs: readonly FundingSyncEvidence[];
};

/** Union only successful, identity-matched intervals; require the ending snapshot's OWN
 * successful run. A newer run cannot retrospectively bless an unrelated balance snapshot. */
export function hasCompleteFundingCoverage(
  input: FundingCoverageInput,
  start: Date,
  end: Date,
  snapshotId: string | null | undefined,
): boolean {
  if (!input.accountId || !input.externalAccountId || !snapshotId ||
      !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) return false;
  const runs = input.fundingSyncs.filter((run) => {
    const times = [run.coverageStart, run.coverageEnd, run.startedAt, run.completedAt];
    return run.accountId === input.accountId && run.externalAccountId === input.externalAccountId &&
      run.provider === "SCHWAB" && run.status === "COMPLETE" &&
      [run.tradeStatus, run.receiveAndDeliverStatus, run.dividendOrInterestStatus, run.persistenceStatus]
        .every((status) => status === "COMPLETE") && !!run.balanceSnapshotLedgerEntryId &&
      times.every((time) => time instanceof Date && Number.isFinite(time.getTime())) &&
      run.coverageStart <= run.coverageEnd && run.coverageEnd <= run.startedAt &&
      run.startedAt <= run.completedAt!;
  });
  const anchor = runs.find((run) => run.balanceSnapshotLedgerEntryId === snapshotId &&
    run.coverageEnd.getTime() === end.getTime());
  if (!anchor) return false;
  // Evidence available at this endpoint's completed sync, never a later unrelated observation.
  const intervals = runs.filter((run) => run.completedAt! <= anchor.completedAt!)
    .sort((a, b) => a.coverageStart.getTime() - b.coverageStart.getTime());
  let coveredTo = start.getTime();
  for (const run of intervals) {
    if (run.coverageEnd.getTime() < coveredTo) continue;
    if (run.coverageStart.getTime() > coveredTo) return false;
    coveredTo = Math.max(coveredTo, run.coverageEnd.getTime());
    if (coveredTo >= end.getTime()) return true;
  }
  return false;
}
