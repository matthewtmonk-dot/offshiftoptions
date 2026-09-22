import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Reporting Phase, Ticket 3 ("Tracker / Positions Performance Cleanup"): Tracker must read
// Confirmed Trading P/L, Trade Return, and Capital Committed from the same authoritative
// reporting.ts contract Dashboard uses (Ticket 2), rather than recomputing account-level
// aggregates or a second copy of campaign return math locally. There is no component-render
// harness in this repo, so this asserts against the page source itself - the same precedent
// already accepted for retired-one-percent-displays.test.ts and reporting-display.test.ts.
function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const text = source("./page.tsx");

describe("Section 1 & 2: no account-level Dashboard duplication, authoritative top summary", () => {
  it("1. uses summarizeAccountReporting for Confirmed Trading P/L, not a page-local sum", () => {
    expect(text).toContain("summarizeAccountReporting(");
    expect(text).toContain("ownReport.confirmedTradingPL");
  });

  it("2. does not recreate account-level Whole-Account Gain / total-return aggregation", () => {
    expect(text).not.toContain("summarizeAccountsPerformance");
    expect(text).not.toContain("ownAccounting");
    expect(text).not.toContain("ownGoal");
    expect(text).not.toContain("summarizeContributionAdjustedGoal");
  });

  it("17. does not duplicate Dashboard's five reporting cards wholesale", () => {
    expect(text).not.toContain("Whole-Account Gain");
    expect(text).not.toContain('label="Account Value"');
    expect(text).not.toContain("How am I doing?");
  });

  it("Confirmed Trading P/L in the top summary is labeled as the viewer's own figure, not scope-blended", () => {
    expect(text).toContain("Confirmed Trading P/L (mine)");
  });
});

describe("Section 3 & 4: realized vs current/open vs projected stay visually distinct, no inline return math", () => {
  it("4 & 7. a closed campaign's primary result is its confirmed realized P/L, not a current-mark figure", () => {
    expect(text).toContain('const plValue = campaign.status === "CLOSED" ? progress.realizedPL : null');
    expect(text).toContain('const primaryValue = isClosed ? progress.realizedPL : progress.currentPL');
    expect(text).toContain('"Confirmed P/L"');
    expect(text).toContain('"Current / Open P&L"');
  });

  it("5. projected outcomes are labeled as projected, never blended with confirmed/current results", () => {
    expect(text).toContain("Projected (if OTM)");
    expect(text).toContain("Projected OTM P/L");
    expect(text).toContain("Projected return");
  });

  it("8. campaign return-on-committed-capital comes from the authoritative domain function, not inline division", () => {
    expect(text).toContain('const returnOnSecuredCapital = campaign.status === "CLOSED" ? progress.currentReturnPercent : null');
    // The old page-local formula must be gone, not just superseded.
    expect(text).not.toMatch(/plValue\s*\/\s*summary\.collateralCommitted/);
    expect(text).not.toMatch(/plValue\s*\/\s*summary\.collateralCommitted\)\s*\*\s*100/);
  });

  it("13. incomplete or fee-pending results never masquerade as confirmed", () => {
    expect(text).toContain("performanceMetricText(progress.realizedPL, progress.realizedPLStatus, signedMoney)");
  });
});

describe("Section 6, 7 & 12: rolls, assignment, and covered calls stay campaign continuity - audited, unchanged", () => {
  it("current-leg display still uses the one authoritative current-leg selector", () => {
    expect(text).toContain("getCurrentOpenPut(");
    expect(text).toContain("getCurrentOpenCall(");
  });

  it("a roll's close+open pair is grouped as one lifecycle entry, never two unrelated trades", () => {
    expect(text).toContain('event.groupKey && event.type.startsWith("ROLL_PUT")');
  });

  it("assignment shows a distinct Assigned Stock card, not a continued CSP display", () => {
    expect(text).toContain('data-testid="assigned-stock-card"');
    expect(text).toContain("Assigned Stock");
  });

  it("a covered call renders within the same Assigned Stock card, not as separate new capital", () => {
    expect(text).toContain("strikeVsBasis");
    expect(text).not.toContain("assignedShareCapital");
  });
});

describe("Section 9 & 13: compact rows, expandable detail, no fixed-width mobile overflow", () => {
  it("14 & 15. the Performance tab's campaign rows are collapsible details, not one giant table row", () => {
    expect(text).toContain("function CampaignPerformanceRow");
    expect(text).toMatch(/<details className="group rounded-lg border border-zinc-800 bg-zinc-900\/40" data-testid=\{`performance-campaign-\$\{campaign\.ticker\}`\}>/);
    expect(text).toContain("Accounting Split");
    expect(text).toContain("Current Mark Source");
  });

  it("18. the old fixed min-width table wrapper is gone", () => {
    expect(text).not.toContain("min-w-[980px]");
    expect(text).not.toMatch(/grid-cols-\[1\.05fr_0\.75fr_0\.85fr_0\.9fr_0\.9fr_0\.9fr_0\.85fr_0\.7fr_0\.7fr\]/);
  });

  it("14. the collapsed campaign-performance row does not render every field - net premium and rolls moved to detail", () => {
    const rowFnStart = text.indexOf("function CampaignPerformanceRow");
    const summaryStart = text.indexOf("<summary", rowFnStart);
    const summaryEnd = text.indexOf("</summary>", summaryStart);
    const collapsedSummary = text.slice(summaryStart, summaryEnd);
    expect(collapsedSummary).not.toContain("Net premium");
    expect(collapsedSummary).not.toContain("Peak put collateral");
    expect(collapsedSummary).not.toContain("Rolls");
  });
});
