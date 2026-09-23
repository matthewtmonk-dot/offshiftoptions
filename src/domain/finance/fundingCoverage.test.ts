import { describe, expect, it } from "vitest";
import { hasCompleteFundingCoverage, type FundingSyncEvidence } from "./fundingCoverage";
import { summarizeAccountPerformance } from "./accountLedger";

const date = (value: string) => new Date(value);
const start = date("2026-01-01");
const end = date("2026-06-01");
function run(from = "2026-01-01", to = "2026-06-01", overrides: Partial<FundingSyncEvidence> = {}): FundingSyncEvidence {
  return { id: to, accountId: "matt-account", externalAccountId: "matt-hash", provider: "SCHWAB",
    coverageStart: date(from), coverageEnd: date(to), startedAt: date(to), completedAt: date(to),
    balanceSnapshotLedgerEntryId: "snapshot", status: "COMPLETE", tradeStatus: "COMPLETE",
    receiveAndDeliverStatus: "COMPLETE", dividendOrInterestStatus: "COMPLETE", persistenceStatus: "COMPLETE", ...overrides };
}
function coverage(fundingSyncs: FundingSyncEvidence[]) {
  return { accountId: "matt-account", externalAccountId: "matt-hash", fundingSyncs };
}
function verified(runs: FundingSyncEvidence[], snapshotId = "snapshot") {
  return hasCompleteFundingCoverage(coverage(runs), start, end, snapshotId);
}

describe("persisted funding coverage", () => {
  it("accepts full coverage and rejects no evidence", () => {
    expect(verified([run()])).toBe(true); expect(verified([])).toBe(false);
  });
  it("rejects a partial interval", () => expect(verified([run("2026-02-01")])).toBe(false));
  it.each(["FAILED", "PARTIAL", "IN_PROGRESS"])("ignores %s runs without erasing success", (status) => {
    expect(verified([run(undefined, undefined, { status })])).toBe(false);
    expect(verified([run(), run(undefined, undefined, { status })])).toBe(true);
  });
  it.each(["tradeStatus", "receiveAndDeliverStatus", "dividendOrInterestStatus", "persistenceStatus"] as const)("requires %s", (field) => {
    expect(verified([run(undefined, undefined, { [field]: "FAILED" })])).toBe(false);
  });
  it.each([
    { accountId: "eric-account" }, { externalAccountId: "eric-hash" }, { provider: "OTHER" },
    { completedAt: null }, { balanceSnapshotLedgerEntryId: null }, { coverageStart: new Date(NaN) },
    { completedAt: date("2025-01-01") },
  ])("rejects inconsistent identity or lifecycle: %j", (override) => {
    expect(verified([run(undefined, undefined, override)])).toBe(false);
  });
  it("requires the exact snapshot, not a matching timestamp", () => expect(verified([run()], "unrelated")).toBe(false));
  it("requires anchor interval to end at the selected snapshot", () => {
    expect(verified([run(undefined, "2026-06-02")])).toBe(false);
  });
  it("does not borrow later evidence for an older snapshot", () => {
    expect(verified([run("2026-03-01"), run("2026-01-01", "2026-03-01", {
      balanceSnapshotLedgerEntryId: "other", completedAt: date("2026-06-02"),
    })])).toBe(false);
  });
  it("retains gaps", () => expect(verified([
    run("2026-01-01", "2026-03-01", { balanceSnapshotLedgerEntryId: "earlier" }),
    run("2026-03-02"),
  ])).toBe(false));
  it.each(["2026-03-01", "2026-03-15"])("unions touching/overlapping <=90-day windows, independent of ordering (%s)", (firstEnd) => {
    const runs = [run("2026-01-01", firstEnd, { balanceSnapshotLedgerEntryId: "earlier" }),
      run("2026-03-01", "2026-05-01", { balanceSnapshotLedgerEntryId: "middle" }),
      run("2026-05-01")];
    expect(verified(runs)).toBe(true); expect(verified([...runs].reverse())).toBe(true);
    expect(verified([runs[1], runs[2], runs[0]])).toBe(true);
  });
  it("a later successful run fills a gap for its own new endpoint", () => {
    const runs = [run("2026-01-01", "2026-03-15", { balanceSnapshotLedgerEntryId: "earlier" }),
      run("2026-04-01", "2026-05-01", { balanceSnapshotLedgerEntryId: "middle" })];
    expect(verified(runs)).toBe(false);
    expect(verified([...runs, run("2026-03-15")])).toBe(true);
  });
});

describe("account performance consumes real interval evidence", () => {
  const ledgerEntries = [
    { id: "baseline", type: "STARTING_VALUE" as const, occurredAt: start, amount: 10000 },
    { id: "snapshot", type: "BROKER_SNAPSHOT" as const, occurredAt: end, accountValue: 10200 },
  ];
  it("unlocks >90-day gain only with accumulated complete evidence", () => {
    const input = { ledgerEntries, fundingCoverage: coverage([
      run("2026-01-01", "2026-03-15", { balanceSnapshotLedgerEntryId: "earlier" }), run("2026-03-15"),
    ]) };
    expect(summarizeAccountPerformance(input)).toMatchObject({ totalGain: 200, fundingCoverageStatus: "COMPLETE" });
    expect(summarizeAccountPerformance({ ledgerEntries })).toMatchObject({ totalGain: null });
    expect(summarizeAccountPerformance({ ledgerEntries, brokerTransactionCoverageStatus: "COMPLETE" })).toMatchObject({ totalGain: null });
  });
  it("unrelated snapshot cannot borrow coverage", () => {
    expect(summarizeAccountPerformance({ ledgerEntries: [...ledgerEntries,
      { id: "unrelated", type: "BROKER_SNAPSHOT", occurredAt: date("2026-06-02"), accountValue: 10400 }],
      fundingCoverage: coverage([run()]),
    }).totalGain).toBeNull();
  });
  it.each(["CONFLICT", "NEEDS_REVIEW"])("persisted %s transfers are not silently treated as zero funding", (status) => {
    expect(summarizeAccountPerformance({ ledgerEntries, fundingCoverage: coverage([run()]), brokerRecords: [
      { kind: "TRANSACTION", status, action: "Funds Received", occurredAt: "2026-03-01", amount: 200 },
    ] }).totalGain).toBeNull();
  });
  it("unknown activity cannot prove there were no external transfers", () => {
    expect(summarizeAccountPerformance({ ledgerEntries, fundingCoverage: coverage([run()]), brokerRecords: [
      { kind: "TRANSACTION", status: "NEEDS_REVIEW", action: "Unknown", occurredAt: "2026-03-01", amount: 200 },
    ] }).totalGain).toBeNull();
  });
  it("missing baseline or ending valuation stays unavailable even with runs", () => {
    for (const entries of [ledgerEntries.slice(0, 1), ledgerEntries.slice(1)]) {
      expect(summarizeAccountPerformance({ ledgerEntries: entries, fundingCoverage: coverage([run()]) }).totalGain).toBeNull();
    }
  });
});
