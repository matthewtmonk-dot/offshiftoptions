import { describe, expect, it } from "vitest";
import { buildScannerFunnel, describeScanIncomplete, describeScannerFunnel, funnelInputOf, isAwaitingOptionCheck, isBestAvailable, isEarningsOnlyGap, isStockQualified, isVerifyEarningsOnly, isWorthALook, summarizeOptionOutcomes, describeOptionOutcomes, type FunnelRowInput } from "./scannerFunnel";

const row = (overrides: Partial<FunnelRowInput> = {}): FunnelRowInput => ({
  readiness: "FAIL",
  optionEnrichment: "ENRICHED",
  stockScreen: "PASS",
  technicalIncomplete: false,
  gatingClear: true,
  contractSelected: true,
  earningsOnlyStockUnknown: false,
  earningsOnlyGap: false,
  ...overrides,
});

describe("isWorthALook (the default Scanner view)", () => {
  it("includes PASS and NEAR rows", () => {
    expect(isWorthALook(row({ readiness: "PASS" }))).toBe(true);
    expect(isWorthALook(row({ readiness: "NEAR" }))).toBe(true);
  });

  it("includes a stock-qualified name still waiting for its option check", () => {
    expect(isWorthALook(row({ readiness: "NEEDS_DATA", optionEnrichment: "NOT_ENRICHED_BUDGET" }))).toBe(true);
  });

  it("hides rows that failed the stock screen, had unavailable data, or were priced but don't qualify", () => {
    expect(isWorthALook(row({ readiness: "FAIL", optionEnrichment: "NOT_ENRICHED_STOCK_FILTER", stockScreen: "FAIL" }))).toBe(false);
    expect(isWorthALook(row({ readiness: "NEEDS_DATA", optionEnrichment: "NOT_ENRICHED_DATA_UNAVAILABLE", stockScreen: "UNKNOWN" }))).toBe(false);
    expect(isWorthALook(row({ readiness: "FAIL", optionEnrichment: "ENRICHED" }))).toBe(false); // priced, but e.g. ROR too low
    expect(isWorthALook(row({ readiness: "NEEDS_DATA", optionEnrichment: "ENRICHED" }))).toBe(false); // chain unavailable / no contract
  });

  it("never treats a name with incomplete RSI/Bollinger data as 'qualified' just because nothing failed", () => {
    const incomplete = row({ readiness: "NEEDS_DATA", optionEnrichment: "NOT_ENRICHED_BUDGET", stockScreen: "UNKNOWN", technicalIncomplete: true });
    expect(isStockQualified(incomplete)).toBe(false);
    expect(isAwaitingOptionCheck(incomplete)).toBe(false);
    expect(isWorthALook(incomplete)).toBe(false);
  });

  it("does not hide a row from an older run that can't be classified when it is still PASS/NEAR", () => {
    expect(isWorthALook(row({ readiness: "NEAR", optionEnrichment: null }))).toBe(true);
  });
});

describe("buildScannerFunnel", () => {
  const rows: FunnelRowInput[] = [
    row({ readiness: "PASS" }),
    row({ readiness: "NEAR" }),
    row({ readiness: "FAIL" }), // priced, failed an option rule
    ...Array.from({ length: 5 }, () => row({ readiness: "NEEDS_DATA", optionEnrichment: "NOT_ENRICHED_BUDGET" })),
    ...Array.from({ length: 4 }, () => row({ readiness: "FAIL", optionEnrichment: "NOT_ENRICHED_STOCK_FILTER", stockScreen: "FAIL" })),
    row({ readiness: "NEEDS_DATA", optionEnrichment: "NOT_ENRICHED_DATA_UNAVAILABLE", stockScreen: "UNKNOWN" }),
    row({ readiness: "NEEDS_DATA", optionEnrichment: "NOT_ENRICHED_BUDGET", stockScreen: "UNKNOWN", technicalIncomplete: true }),
    row({ readiness: "NEEDS_DATA", optionEnrichment: null, stockScreen: "UNKNOWN" }),
  ];

  it("counts every stage once, with the stages adding up to the total", () => {
    const funnel = buildScannerFunnel(rows);
    expect(funnel.total).toBe(rows.length);
    expect(funnel.stockQualified).toBe(8); // 3 priced + 5 waiting
    expect(funnel.optionChecked).toBe(3);
    expect(funnel.awaitingOptionCheck).toBe(5);
    expect(funnel.pass).toBe(1);
    expect(funnel.near).toBe(1);
    expect(funnel.stockScreenFailed).toBe(4);
    expect(funnel.incompleteEvidence).toBe(3);
    expect(funnel.legacy).toBe(1);
    expect(funnel.stockQualified + funnel.stockScreenFailed + funnel.incompleteEvidence).toBe(funnel.total);
  });

  it("describes the funnel in one honest sentence", () => {
    const text = describeScannerFunnel(buildScannerFunnel(rows));
    expect(text).toBe("8 passed the stock screen - 3 had options priced - 1 pass, 1 near - 5 still waiting for an option check");
    expect(describeScannerFunnel(buildScannerFunnel([]))).toBe("No scan results yet.");
  });

  it("marks counts as a floor when the saved list was truncated", () => {
    expect(describeScannerFunnel(buildScannerFunnel(rows), { truncated: true })).toContain("8+ passed the stock screen");
  });
});

describe("isBestAvailable (never overrides a hard-rule blocker)", () => {
  it("includes a priced row with a real contract that clears every hard rule, even if it misses a preference", () => {
    expect(isBestAvailable(row({ readiness: "FAIL" }))).toBe(true); // e.g. ROR just under target - a soft miss
    expect(isBestAvailable(row({ readiness: "PASS" }))).toBe(true);
    expect(isBestAvailable(row({ readiness: "NEAR" }))).toBe(true);
  });

  it("excludes any row with a hard-rule FAIL or UNKNOWN, no matter how good the rest looks", () => {
    expect(isBestAvailable(row({ gatingClear: false }))).toBe(false);
  });

  it("excludes rows that were never priced or have no selected contract", () => {
    expect(isBestAvailable(row({ optionEnrichment: "NOT_ENRICHED_BUDGET" }))).toBe(false);
    expect(isBestAvailable(row({ optionEnrichment: "NOT_ENRICHED_STOCK_FILTER" }))).toBe(false);
    expect(isBestAvailable(row({ contractSelected: false }))).toBe(false);
    expect(isBestAvailable(row({ optionEnrichment: null }))).toBe(false);
  });

  it("is counted in the funnel and mentioned only when nothing outright passes", () => {
    const thinWeek = [row({ readiness: "FAIL" }), row({ readiness: "FAIL" }), row({ readiness: "FAIL", gatingClear: false })];
    const funnel = buildScannerFunnel(thinWeek);
    expect(funnel.bestAvailable).toBe(2);
    expect(describeScannerFunnel(funnel)).toContain("2 clear every hard rule (see Best available)");
    const goodWeek = buildScannerFunnel([row({ readiness: "PASS" }), row({ readiness: "FAIL" })]);
    expect(describeScannerFunnel(goodWeek)).not.toContain("Best available");
  });
});

describe("summarizeOptionOutcomes (why priced names didn't pass)", () => {
  const priced = (overrides: Partial<Parameters<typeof summarizeOptionOutcomes>[0][number]> = {}) => ({
    readiness: "FAIL" as const, optionEnrichment: "ENRICHED", contractReasonCode: null, criteria: [], ...overrides,
  });

  it("counts the single main reason per priced row, biggest first", () => {
    const outcomes = summarizeOptionOutcomes([
      priced({ contractReasonCode: "NO_EXPIRATIONS_IN_CONFIGURED_RANGE" }),
      priced({ contractReasonCode: "NO_WEEKLY_EXPIRATION" }),
      priced({ contractReasonCode: "NO_EXPIRATIONS_IN_CONFIGURED_RANGE" }),
      priced({ criteria: [{ key: "ror", status: "FAIL" }] }),
      priced({ criteria: [{ key: "openInterest", status: "FAIL" }, { key: "ror", status: "FAIL" }] }), // the hard rule is the blocker
    ]);
    expect(outcomes).toEqual([
      { label: "no weekly option in your expiration window", count: 3 },
      { label: "open interest too low", count: 1 },
      { label: "return below your target", count: 1 },
    ]);
    expect(describeOptionOutcomes(outcomes)).toBe("3 no weekly option in your expiration window · 1 open interest too low · 1 return below your target");
  });

  it("ignores passes, unpriced rows and stock-screen rejects", () => {
    expect(
      summarizeOptionOutcomes([
        priced({ readiness: "PASS" }),
        priced({ optionEnrichment: "NOT_ENRICHED_BUDGET" }),
        priced({ optionEnrichment: "NOT_ENRICHED_STOCK_FILTER" }),
        priced({ optionEnrichment: null }),
      ]),
    ).toEqual([]);
  });

  it("labels a NEAR row with no failed rule, and unknown-only rows, honestly", () => {
    expect(summarizeOptionOutcomes([priced({ readiness: "NEAR" }), priced({ readiness: "NEEDS_DATA" })]).map((o) => o.label).sort()).toEqual(["just under one preference", "missing option data"]);
  });
});

describe("describeScanIncomplete", () => {
  it("is silent once every stock that passed the screen has been priced", () => {
    expect(describeScanIncomplete(buildScannerFunnel([row(), row({ readiness: "PASS" })]))).toBeNull();
    expect(describeScanIncomplete(buildScannerFunnel([]))).toBeNull();
  });

  it("says SCAN INCOMPLETE with the exact count while qualified stocks are unpriced", () => {
    const funnel = buildScannerFunnel([row(), row({ optionEnrichment: "NOT_ENRICHED_BUDGET" }), row({ optionEnrichment: "NOT_ENRICHED_BUDGET" })]);
    const notice = describeScanIncomplete(funnel)!;
    expect(notice.headline).toBe("SCAN INCOMPLETE");
    expect(notice.detail).toMatch(/^2 stocks that passed the stock screen have not had options priced yet/);
    expect(notice.detail).toMatch(/Press Check options/);
  });

  it("uses singular wording for one, and 'At least' when the saved list was capped", () => {
    const one = buildScannerFunnel([row({ optionEnrichment: "NOT_ENRICHED_BUDGET" })]);
    expect(describeScanIncomplete(one)!.detail).toMatch(/^1 stock that passed the stock screen has not had options priced/);
    expect(describeScanIncomplete(one, { truncated: true })!.detail).toMatch(/^At least 1 stock that passed the stock screen has not/);
  });

  it("does not count stocks that failed the screen or have no usable data", () => {
    const funnel = buildScannerFunnel([row({ stockScreen: "FAIL", optionEnrichment: "NOT_ENRICHED_BUDGET" }), row({ optionEnrichment: "NOT_ENRICHED_STOCK_FILTER" })]);
    expect(describeScanIncomplete(funnel)).toBeNull();
  });
});

describe("a stock whose only unknown is its earnings date (Nov 16 empty-scan regression)", () => {
  // Live: ~80 of 114 rows had no earnings date in the calendar. The page called them "not stock-qualified", counted 0
  // waiting, never started pricing and said "all qualifying options priced" - while the server would have priced them.
  const waiting = row({ readiness: "NEEDS_DATA", optionEnrichment: "NOT_ENRICHED_BUDGET", stockScreen: "UNKNOWN", earningsOnlyStockUnknown: true });

  it("counts as waiting for its option check, so the page starts pricing", () => {
    expect(isStockQualified(waiting)).toBe(true);
    expect(isAwaitingOptionCheck(waiting)).toBe(true);
    expect(isWorthALook(waiting)).toBe(true);
    const funnel = buildScannerFunnel([waiting, waiting, row({ readiness: "FAIL" })]);
    expect(funnel.awaitingOptionCheck).toBe(2);
    expect(funnel.incompleteEvidence).toBe(0);
    expect(describeScanIncomplete(funnel)?.headline).toBe("SCAN INCOMPLETE");
  });

  it("still does not count when another stock rule is unknown or RSI/Bollinger are missing", () => {
    expect(isAwaitingOptionCheck(row({ readiness: "NEEDS_DATA", optionEnrichment: "NOT_ENRICHED_BUDGET", stockScreen: "UNKNOWN" }))).toBe(false);
    expect(isAwaitingOptionCheck({ ...waiting, technicalIncomplete: true })).toBe(false);
    expect(isAwaitingOptionCheck({ ...waiting, optionEnrichment: "NOT_ENRICHED_STOCK_FILTER" })).toBe(false);
  });

  it("once priced with nothing failing, is shown for an earnings check - never as a PASS", () => {
    const priced = row({ readiness: "NEEDS_DATA", stockScreen: "UNKNOWN", earningsOnlyStockUnknown: true, earningsOnlyGap: true, gatingClear: false });
    expect(isVerifyEarningsOnly(priced)).toBe(true);
    expect(isWorthALook(priced)).toBe(true);
    expect(isBestAvailable(priced)).toBe(false); // an unknown hard rule is never "clear"
    const funnel = buildScannerFunnel([priced]);
    expect(funnel.verifyEarnings).toBe(1);
    expect(funnel.pass).toBe(0);
    expect(describeScannerFunnel(funnel)).toContain("1 pass everything except an unconfirmed earnings date");
  });

  it("is not shown when no contract was selected or the options were never priced", () => {
    expect(isVerifyEarningsOnly(row({ readiness: "NEEDS_DATA", earningsOnlyGap: true, contractSelected: false }))).toBe(false);
    expect(isVerifyEarningsOnly(row({ readiness: "NEEDS_DATA", earningsOnlyGap: true, optionEnrichment: "NOT_ENRICHED_BUDGET" }))).toBe(false);
  });

  it("isEarningsOnlyGap: nothing fails and every unknown is an earnings criterion", () => {
    const pass = { key: "ror", status: "PASS" };
    const earnings = ["earningsDistance", "earningsFreeDaysAfterExpiry", "earningsExitSessions"].map((key) => ({ key, status: "UNKNOWN" }));
    expect(isEarningsOnlyGap([pass, ...earnings])).toBe(true);
    expect(isEarningsOnlyGap([pass])).toBe(false); // nothing missing: that is a PASS, not a gap
    expect(isEarningsOnlyGap([{ key: "delta", status: "FAIL" }, ...earnings])).toBe(false);
    expect(isEarningsOnlyGap([{ key: "optionBid", status: "UNKNOWN" }, ...earnings])).toBe(false);
  });

  it("funnelInputOf derives the earnings gap from the row's own criteria", () => {
    const input = funnelInputOf({
      readiness: "NEEDS_DATA",
      stockScreen: "UNKNOWN",
      technicalReasonCode: null,
      gatingClear: false,
      earningsOnlyStockUnknown: true,
      summary: { results: [{ key: "ror", status: "PASS" }, { key: "earningsDistance", status: "UNKNOWN" }] },
      values: { optionEnrichment: "ENRICHED", rsi: 30, bbPercent: 5, strike: 32 },
      contractReasonCode: null,
    });
    expect(input.earningsOnlyGap).toBe(true);
    expect(isVerifyEarningsOnly(input)).toBe(true);
  });
});
