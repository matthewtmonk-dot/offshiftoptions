import { describe, expect, it } from "vitest";
import type { AccountReportingSummary } from "@/domain/finance/reporting";
import { buildPerformanceScorecard } from "./performance-scorecard";

const asOf = new Date("2026-10-17T16:00:00Z");

function report(overrides: Partial<AccountReportingSummary> = {}): AccountReportingSummary {
  return {
    currentAccountValue: 151377.97,
    currentAccountValueAsOf: new Date("2026-09-24T16:03:00Z"),
    currentCapitalCommitted: 65050,
    currentCapitalUtilizationPercent: 43,
    capitalUtilizationStatus: "OK",
    wholeAccountReturnPercent: null,
    ...overrides,
  } as AccountReportingSummary;
}

const input = (extra: Partial<Parameters<typeof buildPerformanceScorecard>[0]> = {}) => ({
  report: report(),
  campaigns: [],
  thisWeek: { wins: 0, losses: 0, breakevens: 0, completedCount: 0, weekStartUtc: new Date("2026-10-12T00:00:00Z") },
  winLoss: { wins: 0, losses: 0, breakevens: 0, winRate: null },
  asOf,
  ...extra,
});

describe("buildPerformanceScorecard - honesty about stale / unconfirmed numbers", () => {
  it("dates the account value and says when it is old", () => {
    const card = buildPerformanceScorecard(input());
    expect(card.accountValue.detail).toContain("As of Sep 24, 2026");
    expect(card.accountValue.detail).toContain("23 days old");
    expect(card.accountValue.detail).toContain("Brokerage Sync");
  });

  it("does not nag about a fresh account value", () => {
    const card = buildPerformanceScorecard(input({ report: report({ currentAccountValueAsOf: new Date("2026-10-17T14:00:00Z") }) }));
    expect(card.accountValue.detail).toMatch(/^As of Oct 17, 2026/);
    expect(card.accountValue.detail).not.toContain("days old");
  });

  it("tells the user how much of the money put to work is expired-but-unconfirmed puts", () => {
    const card = buildPerformanceScorecard(input({ awaitingSettlement: { amount: 61850, count: 26 } }));
    expect(card.moneyInUse.value).toBe("$65,050.00");
    expect(card.moneyInUse.detail).toContain("$61,850.00");
    expect(card.moneyInUse.detail).toContain("26 puts");
    expect(card.moneyInUse.detail).toContain("assigned as shares");
  });

  it("is silent about settlement when nothing is waiting", () => {
    expect(buildPerformanceScorecard(input()).moneyInUse.detail).not.toContain("confirmed yet");
    expect(buildPerformanceScorecard(input({ awaitingSettlement: { amount: 0, count: 0 } })).moneyInUse.detail).not.toContain("confirmed yet");
  });

  it("uses singular wording for one put", () => {
    const detail = buildPerformanceScorecard(input({ awaitingSettlement: { amount: 2150, count: 1 } })).moneyInUse.detail;
    expect(detail).toContain("1 put that");
    expect(detail).toContain("isn't confirmed");
  });
});

describe("buildPerformanceScorecard - 'the rest of the account' is not called idle cash", () => {
  it("describes the uncommitted remainder as cash or holdings outside tracked campaigns", () => {
    const detail = buildPerformanceScorecard(input({ report: report({ currentAccountValue: 144342.57, currentCapitalCommitted: 71800, currentCapitalUtilizationPercent: 50 }) })).moneyInUse.detail;
    expect(detail).toContain("$72,542.57 is cash or holdings outside these tracked campaigns");
    expect(detail).not.toContain("idle");
  });
});
