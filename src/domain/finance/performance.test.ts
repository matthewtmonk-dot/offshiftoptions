import { describe, expect, it } from "vitest";
import {
  summarizeCampaignProgress,
  summarizeContributionAdjustedGoal,
  summarizeWeeklyReturns,
  summarizeWinLoss,
  tradingProfitFromAccountValue,
} from "./performance";

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

describe("campaign progress accounting", () => {
  it("shows an open simple CSP as premium, current P/L, and projected OTM - not realized", () => {
    const progress = summarizeCampaignProgress({
      status: "OPEN",
      currentCostToClose: 20,
      events: [{ type: "SELL_PUT", optionType: "PUT", occurredAt: "2026-08-01", strike: 20, contracts: 1, premium: 0.5 }],
      asOf: new Date("2026-08-08"),
    });

    expect(progress.netPremiumCollected).toBe(50);
    expect(progress.currentPL).toBe(30);
    expect(progress.projectedOtmPL).toBe(50);
    expect(progress.realizedPL).toBeNull();
  });

  it("handles a rolled CSP where current P/L and projected OTM are different", () => {
    const progress = summarizeCampaignProgress({
      status: "OPEN",
      currentCostToClose: 55,
      events: [
        { type: "SELL_PUT", optionType: "PUT", occurredAt: "2026-08-01", strike: 30, contracts: 1, premium: 0.5 },
        { type: "ROLL_PUT_CLOSE", optionType: "PUT", occurredAt: "2026-08-08", groupKey: "roll-1", strike: 30, contracts: 1, premium: 0.8 },
        { type: "ROLL_PUT_OPEN", optionType: "PUT", occurredAt: "2026-08-08", groupKey: "roll-1", strike: 29, contracts: 1, premium: 1.2 },
      ],
      asOf: new Date("2026-08-15"),
    });

    expect(progress.netPremiumCollected).toBe(90);
    expect(progress.currentCostToClose).toBe(55);
    expect(progress.currentPL).toBe(35);
    expect(progress.projectedOtmPL).toBe(90);
    expect(progress.rollCount).toBe(1);
  });

  it("allows a rolled campaign to be losing now while projected OTM stays positive", () => {
    const progress = summarizeCampaignProgress({
      status: "OPEN",
      currentCostToClose: 120,
      events: [
        { type: "SELL_PUT", optionType: "PUT", occurredAt: "2026-08-01", strike: 30, contracts: 1, premium: 0.5 },
        { type: "ROLL_PUT_CLOSE", optionType: "PUT", occurredAt: "2026-08-08", groupKey: "roll-1", strike: 30, contracts: 1, premium: 0.8 },
        { type: "ROLL_PUT_OPEN", optionType: "PUT", occurredAt: "2026-08-08", groupKey: "roll-1", strike: 29, contracts: 1, premium: 1.2 },
      ],
    });

    expect(progress.currentPL).toBe(-30);
    expect(progress.projectedOtmPL).toBe(90);
  });

  it("reports closed wins and losses as realized, with no OTM projection", () => {
    const win = summarizeCampaignProgress({
      status: "CLOSED",
      events: [
        { type: "SELL_PUT", optionType: "PUT", occurredAt: "2026-08-01", strike: 30, contracts: 1, premium: 0.5 },
        { type: "CLOSE_PUT", optionType: "PUT", occurredAt: "2026-08-08", strike: 30, contracts: 1, premium: 0.04 },
      ],
    });
    const loss = summarizeCampaignProgress({
      status: "CLOSED",
      events: [
        { type: "SELL_PUT", optionType: "PUT", occurredAt: "2026-08-01", strike: 30, contracts: 1, premium: 0.5 },
        { type: "CLOSE_PUT", optionType: "PUT", occurredAt: "2026-08-08", strike: 30, contracts: 1, premium: 0.9 },
      ],
    });

    expect(win.realizedPL).toBe(46);
    expect(win.currentPL).toBe(46);
    expect(win.projectedOtmPL).toBeNull();
    expect(loss.realizedPL).toBe(-40);
  });

  it("does not call assignment an OTM success", () => {
    const progress = summarizeCampaignProgress({
      status: "ASSIGNED",
      events: [
        { type: "SELL_PUT", optionType: "PUT", occurredAt: "2026-08-01", strike: 30, contracts: 1, premium: 0.5 },
        { type: "ASSIGNMENT", optionType: "PUT", occurredAt: "2026-08-08", strike: 30, contracts: 1 },
      ],
    });

    expect(progress.realizedPL).toBeNull();
    expect(progress.currentPL).toBeNull();
    expect(progress.projectedOtmApplicable).toBe(false);
    expect(progress.projectedOtmPL).toBeNull();
  });
});

describe("contribution-adjusted 1% goal", () => {
  it("keeps deposits out of trading P/L", () => {
    expect(tradingProfitFromAccountValue({ startingCapital: 10_000, netContributions: 2_000, currentValue: 12_100 })).toBe(100);
  });

  it("adds deposits to the future target base without counting them as return", () => {
    const goal = summarizeContributionAdjustedGoal({
      accounts: [
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-01-01", amount: 10_000 },
            { type: "DEPOSIT", occurredAt: "2026-01-08", amount: 2_000 },
          ],
        },
      ],
      currentValue: 12_100,
      projectedOtmPL: 220,
      targetWeeklyPercent: 1,
      asOf: new Date("2026-01-15"),
    });

    expect(goal.tradingPLNow).toBe(100);
    expect(goal.targetProfit).toBe(220);
    expect(goal.actualWeeklyPacePercent).toBe(0.45);
    expect(goal.projectedWeeklyPacePercent).toBe(1);
    expect(goal.percentOfTarget).toBe(45.5);
    expect(goal.projectedPercentOfTarget).toBe(100);
  });

  it("ignores future ledger entries when calculating today's goal", () => {
    const goal = summarizeContributionAdjustedGoal({
      accounts: [
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-01-01", amount: 10_000 },
            { type: "DEPOSIT", occurredAt: "2026-02-01", amount: 2_000 },
            { type: "STARTING_VALUE", occurredAt: "2026-02-01", amount: 5_000 },
          ],
        },
      ],
      currentValue: 10_020,
      projectedOtmPL: null,
      targetWeeklyPercent: 1,
      asOf: new Date("2026-01-08"),
    });

    expect(goal.startingCapital).toBe(10_000);
    expect(goal.netContributions).toBe(0);
    expect(goal.tradingPLNow).toBe(20);
    expect(goal.targetProfit).toBe(100);
  });
});
