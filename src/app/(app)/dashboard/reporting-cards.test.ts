import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  accountValueDetail,
  accountValueUnavailableReason,
  capitalCommittedDetail,
  capitalCommittedValue,
  confirmedTradingPLNote,
  dashboardHasEvidenceGap,
  tradeReturnReason,
  tradeReturnValue,
  wholeAccountGainDetail,
} from "./reporting-cards";
import type { AccountReportingSummary } from "@/domain/finance/reporting";
import { shortDate, shortDateTime } from "@/lib/format";

// Reporting Phase, Ticket 2 ("How am I doing?"): these helpers are the ONLY thing dashboard/page.tsx
// does with AccountReportingSummary - format already-decided fields into card text, never
// recompute P/L/return/capital/gain. Testing them directly (rather than the page's JSX) is the
// practical substitute for a component-render harness, which this repo does not have.

// These are genuine instants (a snapshot capture time, a baseline-set time) - shortDate/
// shortDateTime render them in the runner's local timezone by design (see format.ts's own
// shortCalendarDate doc comment on why that's the WRONG choice only for date-only stored values,
// not for real timestamps like these). Tests build expected strings through the same formatters
// rather than hardcoding a UTC-assuming string, so they pass under any timezone.
const commonInstant = new Date("2026-09-20T20:00:00.000Z");
const baselineStart = new Date("2026-08-01T00:00:00.000Z");
const oldestStart = new Date("2026-08-01T00:00:00.000Z");
const newestStart = new Date("2026-09-01T00:00:00.000Z");
const oldestSnapshot = new Date("2026-09-18T14:00:00.000Z");
const newestSnapshot = new Date("2026-09-20T20:00:00.000Z");

function baseReport(overrides: Partial<AccountReportingSummary> = {}): AccountReportingSummary {
  return {
    currentAccountValue: 10000,
    currentAccountValueAsOf: commonInstant,
    currentAccountValueOldestSnapshotAsOf: commonInstant,
    currentAccountValueNewestSnapshotAsOf: commonInstant,
    currentAccountValueSource: "SCHWAB",

    confirmedTradingPL: 500,
    confirmedTradingPLPeriod: "ALL_TIME",
    confirmedTradingPLBasis: "Confirmed realized P/L across every completed campaign supplied to this summary.",
    confirmedTradingPLComplete: true,
    confirmedTradingPLPendingCount: 0,
    confirmedTradingPLIncompleteCount: 0,

    tradeReturnPercent: 2.5,
    tradeReturnGrossPercent: 2.8,
    tradeReturnPeriod: "THIS_WEEK",
    tradeReturnPeriodStartUtc: baselineStart,
    tradeReturnPeriodEndUtc: commonInstant,
    tradeReturnAsOf: commonInstant,
    tradeReturnBasis: "Lifetime realized P/L of campaigns closed this week, divided by secured capital.",
    tradeReturnStatus: "OK",
    tradeReturnMessage: null,

    currentCapitalCommitted: 6400,
    currentCapitalCommittedSecuredPut: 6400,
    currentCapitalCommittedAssignedShares: 0,
    currentCapitalUtilizationPercent: 64,
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

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("Card 1: Account Value", () => {
  it("1. shows a single common snapshot as a concise 'As of' timestamp", () => {
    const report = baseReport();
    expect(accountValueDetail(report)).toBe(`As of ${shortDateTime(commonInstant)}`);
  });

  it("2. mixed-account snapshot timestamps do not render a false common 'As of' - shows the range instead", () => {
    const report = baseReport({
      currentAccountValueAsOf: null,
      currentAccountValueOldestSnapshotAsOf: oldestSnapshot,
      currentAccountValueNewestSnapshotAsOf: newestSnapshot,
    });
    const detail = accountValueDetail(report);
    expect(detail).toContain("updated between");
    expect(detail).toContain(shortDateTime(oldestSnapshot));
    expect(detail).toContain(shortDateTime(newestSnapshot));
    expect(detail).not.toMatch(/^As of/);
  });

  it("3. unavailable (no baseline) shows the friendly NO_BASELINE reason, not a raw code", () => {
    const report = baseReport({
      currentAccountValue: null,
      currentAccountValueAsOf: null,
      currentAccountValueOldestSnapshotAsOf: null,
      currentAccountValueNewestSnapshotAsOf: null,
      wholeAccountGainStatus: "UNAVAILABLE",
      wholeAccountGainUnavailableReason: "NO_BASELINE",
      wholeAccountGainUnavailableMessage: "Set a starting account value to measure account performance.",
    });
    expect(accountValueUnavailableReason(report)).toBe("Set a starting account value to measure account performance.");
    expect(accountValueUnavailableReason(report)).not.toContain("NO_BASELINE");
  });

  it("4. unavailable (no current value) shows the friendly NO_CURRENT_VALUE reason", () => {
    const report = baseReport({
      currentAccountValue: null,
      wholeAccountGainStatus: "UNAVAILABLE",
      wholeAccountGainUnavailableReason: "NO_CURRENT_VALUE",
      wholeAccountGainUnavailableMessage: "An ending account value is not available for this period.",
    });
    expect(accountValueUnavailableReason(report)).toBe("An ending account value is not available for this period.");
  });
});

describe("Card 2: Confirmed Trading P/L", () => {
  it("5. complete history shows no incomplete-evidence note", () => {
    expect(confirmedTradingPLNote(baseReport())).toBeNull();
  });

  it("6. pending and incomplete counts surface as a small note rather than implying completeness", () => {
    const note = confirmedTradingPLNote(
      baseReport({ confirmedTradingPLComplete: false, confirmedTradingPLPendingCount: 2, confirmedTradingPLIncompleteCount: 1 }),
    );
    expect(note).toContain("2 pending");
    expect(note).toContain("1 incomplete");
  });

  it("7. dashboard page labels this card 'Confirmed Trading P/L' and never as a this-week figure", () => {
    const text = source("./page.tsx");
    expect(text).toContain('label="Confirmed Trading P/L"');
    expect(text).toContain("Since tracked campaign history");
    expect(text).not.toMatch(/Confirmed Trading P\/L[\s\S]{0,120}This Week/);
  });
});

describe("Card 3: Return on campaigns closed this week", () => {
  it("8. available shows the net percentage", () => {
    expect(tradeReturnValue(baseReport())).toBe("2.50%");
    expect(tradeReturnReason(baseReport())).toBeNull();
  });

  it("9. no campaigns closed this week renders a neutral message, not 'Unavailable'", () => {
    const report = baseReport({ tradeReturnStatus: "NO_CLOSED_CAMPAIGNS", tradeReturnPercent: null, tradeReturnMessage: "No campaigns have closed yet this week." });
    expect(tradeReturnValue(report)).toBe("No campaigns closed");
    expect(tradeReturnValue(report)).not.toBe("Unavailable");
  });

  it("10. missing capital evidence renders 'Unavailable' with the capital-specific friendly reason", () => {
    const report = baseReport({
      tradeReturnStatus: "INCOMPLETE_CAPITAL_EVIDENCE",
      tradeReturnPercent: null,
      tradeReturnMessage: "Some closed campaigns are missing the capital/collateral evidence needed to calculate a return.",
    });
    expect(tradeReturnValue(report)).toBe("Unavailable");
    expect(tradeReturnReason(report)).toContain("capital/collateral evidence");
  });

  it("11. incomplete result evidence is distinct wording from pending fee evidence", () => {
    const incompleteResult = baseReport({
      tradeReturnStatus: "INCOMPLETE_RESULT_EVIDENCE",
      tradeReturnPercent: null,
      tradeReturnMessage: "Some campaigns closed this week don't have a confirmed result yet.",
    });
    const pendingFee = baseReport({
      tradeReturnStatus: "PENDING_FEE_EVIDENCE",
      tradeReturnPercent: null,
      tradeReturnGrossPercent: 3.1,
      tradeReturnMessage: "This week's trade return is pending until all fees are confirmed.",
    });
    expect(tradeReturnReason(incompleteResult)).not.toEqual(tradeReturnReason(pendingFee));
    expect(tradeReturnReason(incompleteResult)).toContain("confirmed result");
    expect(tradeReturnReason(pendingFee)).toContain("fees are confirmed");
  });

  it("12. pending fee evidence keeps the gross return visible as a secondary note, net stays hidden", () => {
    const report = baseReport({
      tradeReturnStatus: "PENDING_FEE_EVIDENCE",
      tradeReturnPercent: null,
      tradeReturnGrossPercent: 3.1,
      tradeReturnMessage: "This week's trade return is pending until all fees are confirmed.",
    });
    expect(tradeReturnValue(report)).toBe("Unavailable");
    expect(tradeReturnReason(report)).toContain("gross 3.10%");
  });

  it("13. zero secured capital renders a distinct neutral/unavailable state, not the capital-missing wording", () => {
    const report = baseReport({
      tradeReturnStatus: "NO_SECURED_CAPITAL",
      tradeReturnPercent: null,
      tradeReturnGrossPercent: null,
      tradeReturnMessage: "No secured capital is recorded for the campaigns closed this week.",
    });
    expect(tradeReturnValue(report)).toBe("Unavailable");
    expect(tradeReturnReason(report)).toContain("No secured capital");
  });

  it("14. dashboard page does not revive the retired 1% weekly target on this card", () => {
    const text = source("./page.tsx");
    expect(text).not.toContain("1%");
    expect(text).not.toContain("WEEKLY_TARGET_PERCENT");
  });
});

describe("Card 4: LST Capital Committed", () => {
  it("15. available shows percent of account as the primary value and the dollar figure as detail", () => {
    const report = baseReport();
    expect(capitalCommittedValue(report)).toBe("64% of account");
    expect(capitalCommittedDetail(report)).toContain("$6,400.00");
  });

  it("16. genuinely zero committed capital renders 0%, not 'Unavailable'", () => {
    const report = baseReport({ currentCapitalCommitted: 0, currentCapitalCommittedSecuredPut: 0, currentCapitalUtilizationPercent: 0 });
    expect(capitalCommittedValue(report)).toBe("0% of account");
  });

  it("17. unknown exposure never displays 0% - shows the known partial dollars instead", () => {
    const report = baseReport({
      capitalUtilizationStatus: "UNKNOWN_EXPOSURE",
      currentCapitalUtilizationPercent: null,
      currentCapitalCommitted: 3000,
      capitalUtilizationHasUnknownExposure: true,
      capitalUtilizationMessage: "Some current position exposure could not be verified.",
    });
    const value = capitalCommittedValue(report);
    expect(value).not.toContain("0%");
    expect(value).not.toContain("%");
    expect(value).toContain("$3,000.00");
  });

  it("18. unknown exposure with no known floor at all shows 'Unavailable' with the friendly reason", () => {
    const report = baseReport({
      capitalUtilizationStatus: "UNKNOWN_EXPOSURE",
      currentCapitalUtilizationPercent: null,
      currentCapitalCommitted: null,
      capitalUtilizationMessage: "Some current position exposure could not be verified.",
    });
    expect(capitalCommittedValue(report)).toBe("Unavailable");
  });
});

describe("Card 5: Whole-Account Gain", () => {
  it("19. common baseline start renders 'Since <date>' wording", () => {
    expect(wholeAccountGainDetail(baseReport())).toContain(`Since ${shortDate(baselineStart)}`);
  });

  it("20. mixed baseline start dates never render one arbitrary 'Since' date - shows the range", () => {
    const report = baseReport({
      wholeAccountGainPeriodStart: null,
      wholeAccountGainPeriodStartStatus: "MIXED",
      wholeAccountGainOldestPeriodStart: oldestStart,
      wholeAccountGainNewestPeriodStart: newestStart,
    });
    const detail = wholeAccountGainDetail(report);
    expect(detail).toContain("Start dates range");
    expect(detail).not.toMatch(/^Since /);
  });

  it("21. a contribution-related unavailable return % does not hide or error out an otherwise-valid dollar gain", () => {
    const report = baseReport({ wholeAccountReturnPercent: null, wholeAccountReturnStatus: "CONTRIBUTIONS_NEED_ADVANCED_RETURN" });
    expect(report.wholeAccountGainStatus).toBe("OK");
    const detail = wholeAccountGainDetail(report);
    expect(detail).not.toBeNull();
    expect(detail).not.toContain("Unavailable");
    expect(detail).not.toContain("%");
  });

  it("22. gain unavailable shows 'Unavailable' with its own friendly reason, distinct from account value's", () => {
    const report = baseReport({
      wholeAccountGain: null,
      wholeAccountGainStatus: "UNAVAILABLE",
      wholeAccountGainUnavailableReason: "INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY",
      wholeAccountGainUnavailableMessage: "Schwab funding history has not been fully verified for this period.",
    });
    expect(wholeAccountGainDetail(report)).toBeNull();
    expect(report.wholeAccountGainUnavailableMessage).toContain("Schwab funding history");
  });
});

describe("Data-warning banner", () => {
  it("23. no banner when every major metric is available", () => {
    expect(dashboardHasEvidenceGap(baseReport())).toBe(false);
  });

  it("24. a quiet week with no closed campaigns is neutral, not an evidence gap", () => {
    const report = baseReport({ tradeReturnStatus: "NO_CLOSED_CAMPAIGNS", tradeReturnPercent: null });
    expect(dashboardHasEvidenceGap(report)).toBe(false);
  });

  it("25. an unavailable account value triggers the banner", () => {
    expect(dashboardHasEvidenceGap(baseReport({ currentAccountValue: null, wholeAccountGainStatus: "UNAVAILABLE" }))).toBe(true);
  });

  it("26. unknown capital exposure triggers the banner", () => {
    expect(dashboardHasEvidenceGap(baseReport({ capitalUtilizationStatus: "UNKNOWN_EXPOSURE" }))).toBe(true);
  });
});

describe("Dashboard page structure (source-level - no component-render harness in this repo)", () => {
  const text = source("./page.tsx");

  it("27. uses the authoritative reporting contract instead of the retired per-page account aggregate", () => {
    expect(text).toContain("summarizeAccountReporting(");
    expect(text).not.toContain("summarizeAccountsPerformance");
  });

  it("28. open/current trading cash flow is no longer merged into or adjacent to Confirmed Trading P/L as its own primary stat", () => {
    expect(text).not.toContain("Trading Cash Flow");
    expect(text).not.toContain("accountPerformance.tradingPL");
  });

  it("29. the five performance cards render in a responsive grid with no fixed-width overflow", () => {
    expect(text).toContain('data-testid="dashboard-performance-cards"');
    expect(text).toMatch(/dashboard-performance-cards"[\s\S]{0,400}/);
    const gridSection = text.slice(text.indexOf('<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5"'), text.indexOf('data-testid="dashboard-performance-cards"') + 40);
    expect(gridSection).not.toMatch(/w-\[\d/);
  });

  it("30. the win/loss record is a secondary line beneath the cards, not one of the five primary cards", () => {
    const cardsSection = text.slice(text.indexOf("How am I doing?"), text.indexOf("W-L {winLoss.wins}"));
    expect((cardsSection.match(/<Stat\s/g) ?? []).length).toBe(5);
  });
});
