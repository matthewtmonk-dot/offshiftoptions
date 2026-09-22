import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  baselineExplanation,
  fundingCoverageBadge,
  fundingCoverageMessage,
  ledgerEntryLabel,
  ledgerEntrySourceLabel,
  parseBaselineNote,
  signedLedgerAmount,
  wholeAccountGainStatusBadge,
} from "./account-evidence-display";
import { summarizeAccountPerformance } from "@/domain/finance/accountLedger";
import type { AccountReportingSummary } from "@/domain/finance/reporting";

// Reporting Phase, Ticket 4 ("Account - Performance Evidence & Auditability"): these helpers are
// the ONLY thing account/page.tsx does with summarizeAccountPerformance/AccountReportingSummary -
// choose wording/tone for already-decided fields, never recompute a baseline, funding coverage,
// or whole-account gain/return. Testing them directly is the practical substitute for a
// component-render harness, which this repo does not have (see reporting-display.test.ts, the
// same established pattern for Dashboard/Tracker).

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function performanceFor(ledgerEntries: Parameters<typeof summarizeAccountPerformance>[0]["ledgerEntries"]) {
  return summarizeAccountPerformance({ ledgerEntries });
}

function baseReport(overrides: Partial<AccountReportingSummary> = {}): AccountReportingSummary {
  const commonInstant = new Date("2026-09-20T20:00:00.000Z");
  const baselineStart = new Date("2026-08-01T00:00:00.000Z");
  return {
    currentAccountValue: 10000,
    currentAccountValueAsOf: commonInstant,
    currentAccountValueOldestSnapshotAsOf: commonInstant,
    currentAccountValueNewestSnapshotAsOf: commonInstant,
    currentAccountValueSource: "SCHWAB",
    currentAccountValueUnavailableReason: null,
    currentAccountValueUnavailableMessage: null,

    confirmedTradingPL: 0,
    confirmedTradingPLPeriod: "ALL_TIME",
    confirmedTradingPLBasis: "n/a",
    confirmedTradingPLComplete: true,
    confirmedTradingPLPendingCount: 0,
    confirmedTradingPLIncompleteCount: 0,

    tradeReturnPercent: null,
    tradeReturnGrossPercent: null,
    tradeReturnPeriod: "THIS_WEEK",
    tradeReturnPeriodStartUtc: baselineStart,
    tradeReturnPeriodEndUtc: commonInstant,
    tradeReturnAsOf: commonInstant,
    tradeReturnBasis: "n/a",
    tradeReturnStatus: "NO_CLOSED_CAMPAIGNS",
    tradeReturnMessage: null,

    currentCapitalCommitted: 0,
    currentCapitalCommittedSecuredPut: 0,
    currentCapitalCommittedAssignedShares: 0,
    currentCapitalUtilizationPercent: 0,
    capitalUtilizationStatus: "OK",
    capitalUtilizationHasUnknownExposure: false,
    capitalUtilizationMessage: null,

    wholeAccountGain: 800,
    wholeAccountGainStatus: "OK",
    wholeAccountGainUnavailableReason: null,
    wholeAccountGainUnavailableMessage: null,
    wholeAccountGainPeriod: "SINCE_BASELINE",
    wholeAccountGainPeriodStart: baselineStart,
    wholeAccountGainPeriodStartStatus: "COMMON",
    wholeAccountGainOldestPeriodStart: baselineStart,
    wholeAccountGainNewestPeriodStart: baselineStart,
    wholeAccountGainPeriodEnd: commonInstant,
    wholeAccountGainPeriodEndStatus: "COMMON",

    wholeAccountReturnPercent: 8,
    wholeAccountReturnStatus: "OK",
    wholeAccountReturnMessage: null,

    accountCount: 1,
    fundingCoverageStatus: "COMPLETE",

    ...overrides,
  };
}

describe("Section 3: baseline presentation", () => {
  it("3. an explicit baseline shows its value/date with the preferred 'starting value' wording, not 'original funding'", () => {
    const performance = performanceFor([
      { type: "STARTING_VALUE", occurredAt: "2026-08-01T03:59:59.999Z", createdAt: "2026-08-01T04:00:00Z", amount: 10000 },
    ]);
    const explanation = baselineExplanation(performance);
    expect(explanation).not.toBeNull();
    expect(explanation!.label).toContain("$10,000.00");
    expect(explanation!.detail).toContain("Starting account value for performance measurement");
    expect(explanation!.detail).not.toContain("original funding");
  });

  it("4. an inferred/provisional baseline (no explicit STARTING_VALUE, a broker-transfer-derived starting capital) is clearly labeled provisional, never described as verified", () => {
    // baselineExplanation only reads ledger.effectiveBaseline and startingCapital - constructing
    // the minimal shape directly is more direct than reproducing the full broker-transfer-inference
    // heuristic (already exhaustively covered by accountLedger.test.ts) just to reach this branch.
    const inferredPerformance = {
      ledger: { effectiveBaseline: null },
      startingCapital: 8500,
    } as unknown as ReturnType<typeof summarizeAccountPerformance>;
    const explanation = baselineExplanation(inferredPerformance);
    expect(explanation).not.toBeNull();
    expect(explanation!.label).toContain("provisional");
    expect(explanation!.detail).toContain("Provisional starting value inferred from broker history");
    expect(explanation!.detail).not.toMatch(/\bverified\b/i);
  });

  it("no baseline and no inferred starting capital at all returns null (caller shows its own 'no baseline set' copy)", () => {
    const noBaselinePerformance = { ledger: { effectiveBaseline: null }, startingCapital: null } as unknown as ReturnType<
      typeof summarizeAccountPerformance
    >;
    expect(baselineExplanation(noBaselinePerformance)).toBeNull();
  });
});

describe("Section 5: baseline correction notes", () => {
  it("6. a correction's replacement note strips the internal id, keeping only the human reason", () => {
    expect(parseBaselineNote("Replaces STARTING_VALUE cmxyz123abc - Found an older Schwab statement")).toBe(
      "Found an older Schwab statement",
    );
  });

  it("the very first baseline's note (no prior revision) passes through unchanged", () => {
    expect(parseBaselineNote("Opening balance from Schwab welcome statement")).toBe("Opening balance from Schwab welcome statement");
  });

  it("a null note stays null", () => {
    expect(parseBaselineNote(null)).toBeNull();
  });
});

describe("Section 7: funding coverage - user-safe language, never a raw enum", () => {
  it("12. incomplete Schwab funding verification shows the centralized friendly sentence, not the raw code", () => {
    const message = fundingCoverageMessage("INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY");
    expect(message).toBe("Schwab funding history has not been fully verified for this period.");
    expect(message).not.toContain("INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY");
  });

  it("11. mixed-source funding shows its own distinct friendly sentence", () => {
    const message = fundingCoverageMessage("INCOMPLETE_MIXED_SOURCES");
    expect(message).toBe("Funding history needs review before account performance can be calculated.");
  });

  it("17. COMPLETE and null coverage never render a reason sentence (nothing to explain)", () => {
    expect(fundingCoverageMessage("COMPLETE")).toBeNull();
    expect(fundingCoverageMessage(null)).toBeNull();
  });

  it("never claims 'Verified' for Schwab funding history the domain doesn't actually provide", () => {
    const badge = fundingCoverageBadge("INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY");
    expect(badge.label).not.toMatch(/verified/i);
    expect(badge.tone).toBe("warn");
  });

  it("a genuinely complete funding history is labeled complete, not merely 'not incomplete'", () => {
    const badge = fundingCoverageBadge("COMPLETE");
    expect(badge.label).toBe("Funding history complete");
    expect(badge.tone).toBe("good");
  });
});

describe("Section 15: whole-account gain status badge", () => {
  it("15. gain available renders a distinct 'available' badge", () => {
    expect(wholeAccountGainStatusBadge(baseReport()).label).toBe("Whole-account gain available");
  });

  it("a missing baseline is distinguished from a missing ending value", () => {
    const noBaseline = wholeAccountGainStatusBadge(
      baseReport({ wholeAccountGainStatus: "UNAVAILABLE", wholeAccountGainUnavailableReason: "NO_BASELINE" }),
    );
    const noEndingValue = wholeAccountGainStatusBadge(
      baseReport({ wholeAccountGainStatus: "UNAVAILABLE", wholeAccountGainUnavailableReason: "NO_CURRENT_VALUE" }),
    );
    expect(noBaseline.label).not.toEqual(noEndingValue.label);
    expect(noBaseline.tone).toBe("neutral");
    expect(noEndingValue.tone).toBe("warn");
  });
});

describe("Section 6 & 9: ledger entry presentation", () => {
  it("18. every ledger entry type gets a friendly label, never a raw enum string", () => {
    expect(ledgerEntryLabel("DEPOSIT")).toBe("Deposit");
    expect(ledgerEntryLabel("WITHDRAWAL")).toBe("Withdrawal");
    expect(ledgerEntryLabel("MANUAL_ADJUSTMENT")).toBe("Adjustment");
    expect(ledgerEntryLabel("BROKER_SNAPSHOT")).toBe("Broker snapshot");
    expect(ledgerEntryLabel("NOTE")).toBe("Note");
  });

  it("source is shown as Schwab or Manual, matching the persisted AccountLedgerEntry.source column", () => {
    expect(ledgerEntrySourceLabel("SCHWAB")).toBe("Schwab");
    expect(ledgerEntrySourceLabel("MANUAL")).toBe("Manual");
  });

  it("a withdrawal's positive stored magnitude displays as negative, a deposit stays positive", () => {
    expect(signedLedgerAmount("WITHDRAWAL", 500)).toBe(-500);
    expect(signedLedgerAmount("DEPOSIT", 500)).toBe(500);
  });

  it("a manual adjustment's already-signed amount passes through unchanged in either direction", () => {
    expect(signedLedgerAmount("MANUAL_ADJUSTMENT", -75)).toBe(-75);
    expect(signedLedgerAmount("MANUAL_ADJUSTMENT", 75)).toBe(75);
  });
});

describe("Account page structure (source-level - no component-render harness in this repo)", () => {
  const text = source("../app/(app)/account/page.tsx");

  it("1 & 2. reads current account value and its unavailable reason from the authoritative reporting contract", () => {
    expect(text).toContain("summarizeAccountReporting(");
    expect(text).toContain("accountValueUnavailableReason(report)");
    expect(text).toContain("accountValueDetail(report)");
  });

  it("24. no page-local whole-account gain formula remains - only the authoritative summary's own fields are read", () => {
    expect(text).not.toMatch(/currentValue\s*-\s*startingCapital/);
    expect(text).not.toMatch(/ending\w*\s*-\s*beginning/i);
    expect(text).toContain("report.wholeAccountGain");
    expect(text).toContain("report.wholeAccountReturnPercent");
  });

  it("17. never renders a raw FundingCoverageStatus/WholeAccountGainUnavailableReason enum literal as UI text", () => {
    expect(text).not.toContain('"INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY"');
    expect(text).not.toContain('"INCOMPLETE_MIXED_SOURCES"');
    expect(text).not.toContain('"INCOMPLETE_INFERRED_BASELINE"');
  });

  it("7 & 8. the baseline set/correct workflow keeps expectedRevisionId and the correction-reason requirement", () => {
    expect(text).toContain("setAccountBaselineAction");
    expect(text).toContain('name="expectedRevisionId"');
    expect(text).toContain("required={Boolean(currentBaselineId)}");
  });

  it("20. no destructive baseline edit/delete controls were introduced", () => {
    expect(text).not.toMatch(/deleteAccountBaseline|removeBaseline|editBaseline/i);
  });

  it("9 & 10. Schwab accounts never render the manual Deposit/Withdrawal/Adjustment form; Manual accounts do", () => {
    expect(text).toContain('account.source === "MANUAL" ?');
    expect(text).toContain("addAccountLedgerEntryAction");
    expect(text).toMatch(/manual deposits, withdrawals, and[\s\S]{0,40}adjustments aren&apos;t available here/);
  });

  it("19. baseline history distinguishes current from superseded revisions", () => {
    expect(text).toContain('isCurrent ? "Current" : "Superseded"');
  });

  it("18. funding and ledger history remains visible via an expandable audit trail", () => {
    expect(text).toContain("Funding &amp; ledger history");
    expect(text).toContain("ledgerHistory.map(");
  });

  it("23. mobile structure has no fixed-width overflow container", () => {
    expect(text).not.toMatch(/min-w-\[\d+px\]/);
    expect(text).not.toContain("overflow-x-auto");
  });

  it("21. each account computes its own report independently - no cross-account combined ledger", () => {
    expect(text).toMatch(/accounts:\s*\[\{\s*ledgerEntries: account\.ledgerEntries/);
  });
});
