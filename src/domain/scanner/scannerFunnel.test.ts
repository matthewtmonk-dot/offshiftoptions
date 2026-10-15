import { describe, expect, it } from "vitest";
import { buildScannerFunnel, describeScannerFunnel, isAwaitingOptionCheck, isBestAvailable, isStockQualified, isWorthALook, type FunnelRowInput } from "./scannerFunnel";

const row = (overrides: Partial<FunnelRowInput> = {}): FunnelRowInput => ({
  readiness: "FAIL",
  optionEnrichment: "ENRICHED",
  stockScreen: "PASS",
  technicalIncomplete: false,
  gatingClear: true,
  contractSelected: true,
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
