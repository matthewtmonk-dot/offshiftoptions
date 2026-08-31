import { describe, expect, it } from "vitest";
import { summarizeWeeklyReturns, summarizeWinLoss } from "./performance";

describe("win/loss accounting", () => {
  it("counts only completed campaigns, never an open one mid-roll", () => {
    // sell +28, roll close -53, roll open +82 => open net +57, but still OPEN.
    const openOnly = summarizeWinLoss([]);
    expect(openOnly.completedCount).toBe(0);
    expect(openOnly.winRate).toBeNull();
    expect(openOnly.realizedTradingPL).toBe(0);
  });

  it("promotes a campaign to a completed WIN only once it actually closes", () => {
    // Continuing the example: net +57 while open, then a final close of -11 => +46 total, a WIN.
    const summary = summarizeWinLoss([
      { campaignId: "c1", closedAt: new Date("2026-02-01"), finalResult: "GAIN", pl: 46, daysActive: 14 },
    ]);

    expect(summary.completedCount).toBe(1);
    expect(summary.wins).toBe(1);
    expect(summary.losses).toBe(0);
    expect(summary.winRate).toBe(100);
    expect(summary.realizedTradingPL).toBe(46);
    expect(summary.averageWin).toBe(46);
  });

  it("computes win rate and averages across mixed results without double counting", () => {
    const summary = summarizeWinLoss([
      { campaignId: "c1", closedAt: new Date("2026-01-05"), finalResult: "GAIN", pl: 40, daysActive: 10 },
      { campaignId: "c2", closedAt: new Date("2026-01-12"), finalResult: "GAIN", pl: 60, daysActive: 20 },
      { campaignId: "c3", closedAt: new Date("2026-01-20"), finalResult: "LOSS", pl: -30, daysActive: 5 },
    ]);

    expect(summary.completedCount).toBe(3);
    expect(summary.wins).toBe(2);
    expect(summary.losses).toBe(1);
    expect(summary.winRate).toBe(66.7);
    expect(summary.averageWin).toBe(50);
    expect(summary.averageLoss).toBe(-30);
    expect(summary.realizedTradingPL).toBe(70);
    expect(summary.averageDurationDays).toBeCloseTo(11.67, 1);
  });

  it("excludes an unresolved final result from win/loss math", () => {
    const summary = summarizeWinLoss([
      { campaignId: "c1", closedAt: new Date("2026-01-05"), finalResult: "UNKNOWN", pl: null, daysActive: 10 },
    ]);

    expect(summary.completedCount).toBe(1);
    expect(summary.unknownResults).toBe(1);
    expect(summary.winRate).toBeNull();
    expect(summary.realizedTradingPL).toBe(0);
  });
});

describe("weekly return vs target", () => {
  it("reports insufficient history with no completed campaigns", () => {
    const result = summarizeWeeklyReturns([], 10_000, 1);
    expect(result.status).toBe("INSUFFICIENT_HISTORY");
    expect(result.thisWeekPercent).toBeNull();
  });

  it("reports insufficient history without a valid baseline", () => {
    const result = summarizeWeeklyReturns([{ closedAt: new Date("2026-01-05"), pl: 100 }], null, 1);
    expect(result.status).toBe("INSUFFICIENT_HISTORY");
  });

  it("never counts deposits as part of the weekly return baseline or P/L", () => {
    // Baseline is the account's ledger-derived value; deposits change it but are not
    // themselves a "return" figure fed into this function - only completed campaign P/L is.
    // closedAt === asOf guarantees they fall in the same ISO week regardless of what day
    // of the week this happens to land on.
    const today = new Date("2026-08-31");
    const result = summarizeWeeklyReturns([{ closedAt: today, pl: 62 }], 10_000, 1, today);

    expect(result.status).toBe("OK");
    expect(result.totalWeeksTracked).toBe(1);
    // The single tracked week is the current week in this fixture, so "this week" reflects it
    // and there is not yet a full prior week for a trailing average.
    expect(result.thisWeekPercent).toBe(0.62);
    expect(result.trailing4WeekAveragePercent).toBeNull();
  });

  it("computes a trailing average and target-hit count across multiple prior weeks", () => {
    const result = summarizeWeeklyReturns(
      [
        { closedAt: new Date("2026-08-03"), pl: 120 }, // 1.2%
        { closedAt: new Date("2026-08-10"), pl: 40 }, // 0.4%
        { closedAt: new Date("2026-08-17"), pl: 100 }, // 1.0%
        { closedAt: new Date("2026-08-24"), pl: 80 }, // 0.8%
      ],
      10_000,
      1,
      new Date("2026-08-31"),
    );

    expect(result.status).toBe("OK");
    expect(result.totalWeeksTracked).toBe(4);
    expect(result.trailing4WeekAveragePercent).toBe(0.85);
    expect(result.weeksAtOrAboveTarget).toBe(2);
  });
});
