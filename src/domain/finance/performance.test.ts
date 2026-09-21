import { describe, expect, it } from "vitest";
import type { CampaignEventInput } from "./campaigns";
import {
  summarizeCampaignProgress,
  summarizePerformanceMetrics,
  performanceMetricText,
  summarizeContributionAdjustedGoal,
  summarizeThisWeek,
  summarizeWeeklyReturns,
  summarizeWinLoss,
  tradingProfitFromAccountValue,
  type CompletedCampaignResult,
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

  it("realizedTradingPLExact is true when every completed campaign's fee is known, and false if even one is not - the number itself is never hidden or changed, only its exactness is flagged", () => {
    const allKnown = summarizeWinLoss([
      { campaignId: "c1", closedAt: new Date("2026-02-01"), finalResult: "GAIN", pl: 27.34, daysActive: 4, feesFullyKnown: true },
    ]);
    expect(allKnown.realizedTradingPLExact).toBe(true);
    expect(allKnown.realizedTradingPL).toBe(27.34);

    const oneUnknown = summarizeWinLoss([
      { campaignId: "c1", closedAt: new Date("2026-02-01"), finalResult: "GAIN", pl: 27.34, daysActive: 4, feesFullyKnown: true },
      { campaignId: "c2", closedAt: new Date("2026-02-02"), finalResult: "GAIN", pl: 27.34, daysActive: 4, feesFullyKnown: false },
    ]);
    // The combined dollar figure is still computed over confirmed+pending (established rule:
    // never hide/change the number) - only the exactness flag tells the caller to present it as
    // pending, not confirmed. The fee-pending campaign is also excluded from the CONFIRMED win
    // count/denominator (Ticket 4) - it must not silently inflate a confirmed win rate.
    expect(oneUnknown.realizedTradingPLExact).toBe(false);
    expect(oneUnknown.realizedTradingPL).toBe(54.68);
    expect(oneUnknown.confirmedRealizedTradingPL).toBe(27.34);
    expect(oneUnknown.wins).toBe(1);
    expect(oneUnknown.confirmedCount).toBe(1);
    expect(oneUnknown.pendingCount).toBe(1);
    expect(oneUnknown.winRate).toBe(100); // 1 confirmed win / 1 confirmed campaign - the pending one isn't in the denominator
  });

  it("defaults realizedTradingPLExact to true when feesFullyKnown is omitted, matching existing manual-entry behavior", () => {
    const summary = summarizeWinLoss([{ campaignId: "c1", closedAt: new Date("2026-02-01"), finalResult: "GAIN", pl: 46, daysActive: 14 }]);
    expect(summary.realizedTradingPLExact).toBe(true);
  });
});

describe("this week's summary", () => {
  const asOf = new Date("2026-09-05T13:00:00Z"); // Saturday, in the week of 2026-08-31 (Mon) - 2026-09-06 (Sun)

  it("matches the three-CSP Sep 4 expiration week example - 3 completed, 3 wins, net premium, return on secured capital", () => {
    const summary = summarizeThisWeek(
      [
        { campaignId: "APLD", closedAt: new Date("2026-09-04T21:00:00Z"), finalResult: "GAIN", pl: 28, daysActive: 7, collateralCommitted: 2350 },
        { campaignId: "CORZ", closedAt: new Date("2026-09-04T21:00:00Z"), finalResult: "GAIN", pl: 68, daysActive: 7, collateralCommitted: 1650 },
        { campaignId: "RIOT", closedAt: new Date("2026-09-04T21:00:00Z"), finalResult: "GAIN", pl: 28, daysActive: 7, collateralCommitted: 1750 },
      ],
      asOf,
    );

    expect(summary.completedCount).toBe(3);
    expect(summary.wins).toBe(3);
    expect(summary.losses).toBe(0);
    expect(summary.netPL).toBe(124);
    expect(summary.netPLExact).toBe(true); // zero-fee fixture - fees are known ($0), not merely assumed
    expect(summary.grossPL).toBe(124); // gross equals net here since there are no fees at all
    expect(summary.returnOnSecuredCapitalPercent).toBeCloseTo(2.16, 1); // 124 / 5750
    expect(summary.grossReturnOnSecuredCapitalPercent).toBeCloseTo(2.16, 1);
  });

  it("shows gross P/L as exact but withholds a confirmed net figure when a completed campaign has an unresolved fee", () => {
    const summary = summarizeThisWeek(
      [
        { campaignId: "APLD", closedAt: new Date("2026-09-04T21:00:00Z"), finalResult: "GAIN", pl: 28, grossPL: 28, daysActive: 7, collateralCommitted: 2350, feesFullyKnown: true },
        {
          campaignId: "CORZ",
          closedAt: new Date("2026-09-04T21:00:00Z"),
          finalResult: "GAIN",
          pl: 68, // computed treating the unresolved fee as $0 - not presented as a confirmed net number
          grossPL: 68,
          daysActive: 7,
          collateralCommitted: 1650,
          feesFullyKnown: false,
        },
      ],
      asOf,
    );

    expect(summary.completedCount).toBe(2);
    expect(summary.netPLExact).toBe(false);
    expect(summary.grossPL).toBe(96); // 28 + 68 - always exact, doesn't depend on fee resolution
    expect(summary.grossReturnOnSecuredCapitalPercent).not.toBeNull();
    // The net figures are still computed (so a caller COULD inspect them) but netPLExact tells
    // the UI not to present them as a confirmed "Net P/L."
    expect(summary.returnOnSecuredCapitalPercent).toBeNull();
  });

  it("excludes a campaign closed in a prior week", () => {
    const summary = summarizeThisWeek(
      [{ campaignId: "old", closedAt: new Date("2026-08-20T14:00:00Z"), finalResult: "GAIN", pl: 50, daysActive: 7, collateralCommitted: 1000 }],
      asOf,
    );
    expect(summary.completedCount).toBe(0);
    expect(summary.netPL).toBeNull();
  });

  it("returns null return-on-secured-capital when no closed campaign this week reports a known secured amount", () => {
    const summary = summarizeThisWeek(
      [{ campaignId: "unknown-collateral", closedAt: new Date("2026-09-01T14:00:00Z"), finalResult: "GAIN", pl: 20, daysActive: 5 }],
      asOf,
    );
    expect(summary.netPL).toBe(20);
    expect(summary.returnOnSecuredCapitalPercent).toBeNull();
  });

  it("counts a loss this week without dressing it up", () => {
    const summary = summarizeThisWeek(
      [{ campaignId: "loser", closedAt: new Date("2026-09-02T14:00:00Z"), finalResult: "LOSS", pl: -40, daysActive: 3, collateralCommitted: 2000 }],
      asOf,
    );
    expect(summary.wins).toBe(0);
    expect(summary.losses).toBe(1);
    expect(summary.netPL).toBe(-40);
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
      events: [{ type: "SELL_PUT", optionType: "PUT", occurredAt: "2026-08-01", strike: 20, contracts: 1, premium: 0.5, expiration: "2026-08-14" }],
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
        { type: "SELL_PUT", optionType: "PUT", occurredAt: "2026-08-01", strike: 30, contracts: 1, premium: 0.5, expiration: "2026-08-08" },
        { type: "ROLL_PUT_CLOSE", optionType: "PUT", occurredAt: "2026-08-08", groupKey: "roll-1", strike: 30, contracts: 1, premium: 0.8, expiration: "2026-08-08" },
        { type: "ROLL_PUT_OPEN", optionType: "PUT", occurredAt: "2026-08-08", groupKey: "roll-1", strike: 29, contracts: 1, premium: 1.2, expiration: "2026-08-22" },
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
        { type: "SELL_PUT", optionType: "PUT", occurredAt: "2026-08-01", strike: 30, contracts: 1, premium: 0.5, expiration: "2026-08-08" },
        { type: "ROLL_PUT_CLOSE", optionType: "PUT", occurredAt: "2026-08-08", groupKey: "roll-1", strike: 30, contracts: 1, premium: 0.8, expiration: "2026-08-08" },
        { type: "ROLL_PUT_OPEN", optionType: "PUT", occurredAt: "2026-08-08", groupKey: "roll-1", strike: 29, contracts: 1, premium: 1.2, expiration: "2026-08-22" },
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

describe("profit/performance completeness (Ticket 4: confirmed vs. pending vs. incomplete vs. not-applicable)", () => {
  // Root cause this fixes: higher-level totals derived "is this partial?" from
  // `projectedOtmApplicable`, which conflates "genuinely not applicable" (e.g. an ASSIGNED
  // campaign, or an OPEN one with no put) with "should have a value but evidence is incomplete"
  // (e.g. a SELL_PUT missing expiration - see getOpenPutEvidenceState, Ticket 1). Both cases made
  // `projectedOtmApplicable` false, so an incomplete row silently contributed nothing to a sum
  // AND never tripped a "partial" flag that was only checking `projectedOtmApplicable`. The new
  // `currentPLStatus`/`projectedOtmStatus` fields (and `WinLossSummary`/`ThisWeekSummary`'s
  // confirmed/pending split) let a caller tell these apart explicitly.

  describe("win/loss confirmed vs. pending vs. incomplete", () => {
    it("test 1: all completed campaigns fully confirmed - confirmedCount equals completedCount, no pending", () => {
      const summary = summarizeWinLoss([
        { campaignId: "c1", closedAt: new Date("2026-01-05"), finalResult: "GAIN", pl: 40, daysActive: 10, feesFullyKnown: true },
        { campaignId: "c2", closedAt: new Date("2026-01-12"), finalResult: "LOSS", pl: -10, daysActive: 20, feesFullyKnown: true },
      ]);
      expect(summary.completedCount).toBe(2);
      expect(summary.confirmedCount).toBe(2);
      expect(summary.pendingCount).toBe(0);
      expect(summary.unknownResults).toBe(0);
      expect(summary.wins).toBe(1);
      expect(summary.losses).toBe(1);
      expect(summary.realizedTradingPLExact).toBe(true);
      expect(summary.confirmedRealizedTradingPL).toBe(summary.realizedTradingPL);
    });

    it("test 2: one completed campaign with unresolved fees is pending, not confirmed, but its real number is never treated as zero", () => {
      const summary = summarizeWinLoss([
        { campaignId: "c1", closedAt: new Date("2026-01-05"), finalResult: "GAIN", pl: 40, daysActive: 10, feesFullyKnown: false },
      ]);
      expect(summary.completedCount).toBe(1);
      expect(summary.confirmedCount).toBe(0);
      expect(summary.pendingCount).toBe(1);
      expect(summary.wins).toBe(0); // not a CONFIRMED win yet
      expect(summary.winRate).toBeNull(); // confirmed denominator is empty
      expect(summary.confirmedRealizedTradingPL).toBe(0);
      expect(summary.realizedTradingPL).toBe(40); // real best-known number, never fabricated as 0
      expect(summary.realizedTradingPLExact).toBe(false);
    });

    it("test 3: multiple confirmed campaigns plus one pending result - exactly the ticket's worked example (3 confirmed wins/1 confirmed loss, 1 pending)", () => {
      const summary = summarizeWinLoss([
        { campaignId: "c1", closedAt: new Date("2026-01-05"), finalResult: "GAIN", pl: 40, daysActive: 10, feesFullyKnown: true },
        { campaignId: "c2", closedAt: new Date("2026-01-06"), finalResult: "GAIN", pl: 60, daysActive: 10, feesFullyKnown: true },
        { campaignId: "c3", closedAt: new Date("2026-01-07"), finalResult: "GAIN", pl: 20, daysActive: 10, feesFullyKnown: true },
        { campaignId: "c4", closedAt: new Date("2026-01-08"), finalResult: "LOSS", pl: -15, daysActive: 10, feesFullyKnown: true },
        { campaignId: "c5", closedAt: new Date("2026-01-09"), finalResult: "GAIN", pl: 25, daysActive: 10, feesFullyKnown: false },
      ]);
      expect(summary.completedCount).toBe(5);
      expect(summary.confirmedCount).toBe(4);
      expect(summary.pendingCount).toBe(1);
      expect(summary.wins).toBe(3);
      expect(summary.losses).toBe(1);
      expect(summary.winRate).toBe(75); // 3 of 4 CONFIRMED, the pending campaign is excluded from both numerator and denominator
      expect(summary.confirmedRealizedTradingPL).toBe(105); // 40+60+20-15, excludes the pending +25
      expect(summary.realizedTradingPL).toBe(130); // best-known total including the pending +25
      expect(summary.realizedTradingPLExact).toBe(false);
    });

    it("test 4: no completed campaigns - confirmed/pending/unknown all zero, no fabricated rate", () => {
      const summary = summarizeWinLoss([]);
      expect(summary.completedCount).toBe(0);
      expect(summary.confirmedCount).toBe(0);
      expect(summary.pendingCount).toBe(0);
      expect(summary.winRate).toBeNull();
      expect(summary.confirmedRealizedTradingPL).toBe(0);
    });

    it("test 5: a provisional near-zero result must not silently become a confirmed win/loss/breakeven", () => {
      const summary = summarizeWinLoss([
        { campaignId: "c1", closedAt: new Date("2026-01-05"), finalResult: "BREAKEVEN", pl: 0.01, daysActive: 10, feesFullyKnown: false },
      ]);
      expect(summary.confirmedCount).toBe(0);
      expect(summary.pendingCount).toBe(1);
      expect(summary.wins).toBe(0);
      expect(summary.losses).toBe(0);
      expect(summary.breakevens).toBe(0); // not counted as a confirmed breakeven either
      expect(summary.winRate).toBeNull();
    });

    it("test 10 (this-week variant): mixed confirmed and pending coverage agrees with the overall win/loss split", () => {
      const asOf = new Date("2026-09-05T13:00:00Z");
      const rows: CompletedCampaignResult[] = [
        { campaignId: "c1", closedAt: new Date("2026-09-01"), finalResult: "GAIN", pl: 30, daysActive: 5, feesFullyKnown: true },
        { campaignId: "c2", closedAt: new Date("2026-09-02"), finalResult: "GAIN", pl: 45, daysActive: 5, feesFullyKnown: false },
      ];
      const winLoss = summarizeWinLoss(rows);
      const thisWeek = summarizeThisWeek(rows, asOf);
      expect(winLoss.confirmedCount).toBe(1);
      expect(winLoss.pendingCount).toBe(1);
      expect(thisWeek.confirmedCount).toBe(1);
      expect(thisWeek.pendingCount).toBe(1);
      expect(thisWeek.wins).toBe(1); // confirmed-only, matches winLoss.wins
      expect(thisWeek.wins).toBe(winLoss.wins);
      expect(thisWeek.netPLExact).toBe(false);
      expect(thisWeek.grossPL).toBe(75); // both real numbers, never a fabricated zero for the pending one
    });
  });

  describe("current/projected P/L completeness per campaign", () => {
    it("test 6: an OPEN campaign with a valid current-leg and a live cost-to-close mark is CONFIRMED", () => {
      const progress = summarizeCampaignProgress({
        status: "OPEN",
        currentCostToClose: 20,
        events: [{ type: "SELL_PUT", optionType: "PUT", occurredAt: "2026-08-01", strike: 20, contracts: 1, premium: 0.5, expiration: "2026-08-14" }],
        asOf: new Date("2026-08-08"),
      });
      expect(progress.currentPLStatus).toBe("CONFIRMED");
      expect(progress.projectedOtmStatus).toBe("CONFIRMED");
      expect(progress.currentPL).not.toBeNull();
      expect(progress.projectedOtmPL).not.toBeNull();
    });

    it("test 7/8: an OPEN campaign missing required current-leg evidence (no expiration) is INCOMPLETE, not silently excluded as not-applicable", () => {
      const progress = summarizeCampaignProgress({
        status: "OPEN",
        currentCostToClose: 20,
        events: [{ type: "SELL_PUT", optionType: "PUT", occurredAt: "2026-08-01", strike: 20, contracts: 1, premium: 0.5 }], // no expiration
        asOf: new Date("2026-08-08"),
      });
      expect(progress.currentPLStatus).toBe("INCOMPLETE");
      expect(progress.projectedOtmStatus).toBe("INCOMPLETE");
      expect(progress.currentPL).toBeNull();
      expect(progress.projectedOtmPL).toBeNull();
      // The old bug: projectedOtmApplicable alone can't tell this apart from "not applicable."
      expect(progress.projectedOtmApplicable).toBe(false);
    });

    it("test 7b: a genuinely-not-applicable OPEN campaign (put already closed) is NOT_APPLICABLE, distinct from INCOMPLETE", () => {
      const progress = summarizeCampaignProgress({
        status: "OPEN",
        events: [
          { type: "SELL_PUT", optionType: "PUT", occurredAt: "2026-08-01", strike: 30, contracts: 1, premium: 0.5, expiration: "2026-08-08" },
          { type: "CLOSE_PUT", optionType: "PUT", occurredAt: "2026-08-08", strike: 30, contracts: 1, premium: 0.1 },
        ],
      });
      expect(progress.currentPLStatus).toBe("NOT_APPLICABLE");
      expect(progress.projectedOtmStatus).toBe("NOT_APPLICABLE");
    });

    it("test 9: an ASSIGNED campaign's current valuation is INCOMPLETE (real exposure, no valuation engine yet) - never NOT_APPLICABLE, never silently zero", () => {
      const progress = summarizeCampaignProgress({
        status: "ASSIGNED",
        events: [
          { type: "SELL_PUT", optionType: "PUT", occurredAt: "2026-08-01", strike: 30, contracts: 1, premium: 0.5, expiration: "2026-08-08" },
          { type: "ASSIGNMENT", optionType: "PUT", occurredAt: "2026-08-08", strike: 30, contracts: 1 },
        ],
      });
      expect(progress.currentPLStatus).toBe("INCOMPLETE");
      // The OTM projection is a CSP-only concept and genuinely doesn't apply once assigned -
      // this is the one legitimately NOT_APPLICABLE case for an ASSIGNED campaign.
      expect(progress.projectedOtmStatus).toBe("NOT_APPLICABLE");
      expect(progress.currentPL).toBeNull();
    });

    it("a CLOSED campaign with unresolved fees is PENDING, not CONFIRMED, even though realizedPL is a real number", () => {
      const progress = summarizeCampaignProgress({
        status: "CLOSED",
        feesFullyKnown: false,
        events: [
          { type: "SELL_PUT", optionType: "PUT", occurredAt: "2026-08-01", strike: 30, contracts: 1, premium: 0.5 },
          { type: "CLOSE_PUT", optionType: "PUT", occurredAt: "2026-08-08", strike: 30, contracts: 1, premium: 0.04 },
        ],
      });
      expect(progress.currentPLStatus).toBe("PENDING");
      expect(progress.realizedPL).toBe(46); // the real number is still shown, never hidden
      expect(progress.currentPL).toBe(46);
    });

    it("a CLOSED campaign with confirmed fees is CONFIRMED", () => {
      const progress = summarizeCampaignProgress({
        status: "CLOSED",
        feesFullyKnown: true,
        events: [
          { type: "SELL_PUT", optionType: "PUT", occurredAt: "2026-08-01", strike: 30, contracts: 1, premium: 0.5 },
          { type: "CLOSE_PUT", optionType: "PUT", occurredAt: "2026-08-08", strike: 30, contracts: 1, premium: 0.04 },
        ],
      });
      expect(progress.currentPLStatus).toBe("CONFIRMED");
    });

    it("an OPEN campaign with complete put evidence but no live cost-to-close mark is PENDING for currentPL while projectedOtm stays CONFIRMED (it needs no external mark)", () => {
      const progress = summarizeCampaignProgress({
        status: "OPEN",
        currentCostToClose: null,
        events: [{ type: "SELL_PUT", optionType: "PUT", occurredAt: "2026-08-01", strike: 20, contracts: 1, premium: 0.5, expiration: "2026-08-14" }],
        asOf: new Date("2026-08-08"),
      });
      expect(progress.currentPLStatus).toBe("PENDING");
      expect(progress.currentPL).toBeNull();
      expect(progress.projectedOtmStatus).toBe("CONFIRMED");
      expect(progress.projectedOtmPL).not.toBeNull();
    });
  });

  describe("test 10: mixed confirmed and incomplete coverage across an aggregate - the exact bug this ticket fixes", () => {
    // Reproduces the Astra-flagged aggregation bug directly: an aggregate that only checks
    // `projectedOtmApplicable` before deciding "partial" would silently show a complete-looking
    // total here, because the missing-expiration row's `projectedOtmApplicable` is false for the
    // SAME reason a genuinely-not-applicable row's is. The fix is for callers to check
    // `currentPLStatus`/`projectedOtmStatus === "INCOMPLETE"` (or "PENDING") instead.
    const confirmedOpen = summarizeCampaignProgress({
      status: "OPEN",
      currentCostToClose: 20,
      events: [{ type: "SELL_PUT", optionType: "PUT", occurredAt: "2026-08-01", strike: 20, contracts: 1, premium: 0.5, expiration: "2026-08-14" }],
      asOf: new Date("2026-08-08"),
    });
    const incompleteOpen = summarizeCampaignProgress({
      status: "OPEN",
      currentCostToClose: 5,
      events: [{ type: "SELL_PUT", optionType: "PUT", occurredAt: "2026-08-01", strike: 15, contracts: 1, premium: 0.3 }], // no expiration
      asOf: new Date("2026-08-08"),
    });
    const rows = [confirmedOpen, incompleteOpen];

    it("the old buggy check would miss the incomplete row entirely", () => {
      const buggyPartial = rows.some((row) => row.projectedOtmApplicable && row.currentPL === null);
      expect(buggyPartial).toBe(false); // this is the bug: silently looks complete
    });

    it("the fixed check correctly flags the aggregate as incomplete", () => {
      const fixedPartial = rows.some((row) => row.currentPLStatus === "INCOMPLETE" || row.currentPLStatus === "PENDING");
      expect(fixedPartial).toBe(true);
      // The confirmed row's own number is still usable on its own.
      expect(confirmedOpen.currentPLStatus).toBe("CONFIRMED");
      expect(incompleteOpen.currentPLStatus).toBe("INCOMPLETE");
    });
  });
});

describe("current-leg parity between campaign state and Performance (order-independence)", () => {
  // Root cause of the reproduced bug: performance.ts carried its OWN private copy of the
  // "what's the current open put" event-ordering logic (a private findOpenShortPut +
  // compareEvents, independent of campaigns.ts's getCurrentOpenPut). A roll's
  // ROLL_PUT_CLOSE/ROLL_PUT_OPEN pair sharing the same occurredAt AND sortOrder is a full tie
  // under that comparator; JS's stable sort then just preserves whatever order the CALLER's
  // array happened to be in, and reverse()-then-find() picks a different "last trade event"
  // depending on that incidental order - even though nothing about the actual trade history
  // changed. This produced the audited symptom: one ordering reported Current P/L $42 /
  // Projected P/L $72, another ordering of the IDENTICAL events reported both as unavailable
  // (null). campaigns.ts's own getCurrentOpenPut already carries a deterministic
  // createdAt/id tiebreak (see the Dashboard post-roll staleness fix) - the bug was that
  // Performance never used it.
  const sellOld: CampaignEventInput = {
    id: "evt-1",
    createdAt: "2026-08-01T14:00:00.000Z",
    type: "SELL_PUT",
    optionType: "PUT",
    occurredAt: "2026-08-01",
    strike: 30,
    contracts: 1,
    premium: 0.3,
    expiration: "2026-08-08",
  };
  const rollClose: CampaignEventInput = {
    id: "evt-2",
    createdAt: "2026-08-08T14:00:05.000Z",
    type: "ROLL_PUT_CLOSE",
    optionType: "PUT",
    occurredAt: "2026-08-08",
    sortOrder: 1,
    groupKey: "roll-1",
    strike: 30,
    contracts: 1,
    premium: 0.5,
    expiration: "2026-08-08",
  };
  const rollOpen: CampaignEventInput = {
    id: "evt-3",
    createdAt: "2026-08-08T14:00:06.000Z",
    type: "ROLL_PUT_OPEN",
    optionType: "PUT",
    occurredAt: "2026-08-08", // tied occurredAt with rollClose
    sortOrder: 1, // AND tied sortOrder with rollClose - a full tie under the old comparator
    groupKey: "roll-1",
    strike: 29,
    contracts: 1,
    premium: 0.92,
    expiration: "2026-08-22",
  };
  // netOptionPremium = (30 + 92) - 50 = 72; currentCostToClose 30 => currentPL = 42. Matches
  // the audited example's approximate $42 current / $72 projected exactly.
  const orderings: [string, CampaignEventInput[]][] = [
    ["SELL, CLOSE, OPEN", [sellOld, rollClose, rollOpen]],
    ["SELL, OPEN, CLOSE", [sellOld, rollOpen, rollClose]],
    ["CLOSE, OPEN, SELL", [rollClose, rollOpen, sellOld]],
    ["OPEN, CLOSE, SELL", [rollOpen, rollClose, sellOld]],
    ["OPEN, SELL, CLOSE", [rollOpen, sellOld, rollClose]],
    ["CLOSE, SELL, OPEN", [rollClose, sellOld, rollOpen]],
  ];

  it.each(orderings)(
    "test 1/2/7: reports the same Current/Projected P/L regardless of input array order (%s) - a tied roll close/open pair",
    (_label, events) => {
      const progress = summarizeCampaignProgress({
        status: "OPEN",
        currentCostToClose: 30,
        events,
        asOf: new Date("2026-08-15"),
      });

      expect(progress.projectedOtmApplicable).toBe(true);
      expect(progress.projectedOtmPL).toBe(72);
      expect(progress.currentPL).toBe(42);
    },
  );

  it("test 3: an OPEN (non-rolled) campaign's current leg is also order-independent", () => {
    const a: CampaignEventInput = { type: "SELL_PUT", optionType: "PUT", occurredAt: "2026-08-01", strike: 20, contracts: 1, premium: 0.5, expiration: "2026-08-14" };
    const b: CampaignEventInput = { type: "NOTE", occurredAt: "2026-08-03", notes: "watching earnings" };
    const first = summarizeCampaignProgress({ status: "OPEN", currentCostToClose: 20, events: [a, b], asOf: new Date("2026-08-08") });
    const second = summarizeCampaignProgress({ status: "OPEN", currentCostToClose: 20, events: [b, a], asOf: new Date("2026-08-08") });
    expect(second).toEqual(first);
    expect(first.currentPL).toBe(30);
  });

  it("test 4: a CLOSED campaign's realized P/L is order-independent and never derives a phantom open leg", () => {
    const sell: CampaignEventInput = { type: "SELL_PUT", optionType: "PUT", occurredAt: "2026-08-01", strike: 30, contracts: 1, premium: 0.5, expiration: "2026-08-08" };
    const close: CampaignEventInput = { type: "CLOSE_PUT", optionType: "PUT", occurredAt: "2026-08-08", strike: 30, contracts: 1, premium: 0.04 };
    const first = summarizeCampaignProgress({ status: "CLOSED", events: [sell, close] });
    const second = summarizeCampaignProgress({ status: "CLOSED", events: [close, sell] });
    expect(second).toEqual(first);
    expect(first.realizedPL).toBe(46);
    expect(first.projectedOtmApplicable).toBe(false);
    expect(first.projectedOtmPL).toBeNull();
  });

  it("test 5: an ASSIGNED campaign never reports an open put or OTM projection, order-independent", () => {
    const sell: CampaignEventInput = { type: "SELL_PUT", optionType: "PUT", occurredAt: "2026-08-01", strike: 30, contracts: 1, premium: 0.5, expiration: "2026-08-08" };
    const assignment: CampaignEventInput = { type: "ASSIGNMENT", optionType: "PUT", occurredAt: "2026-08-08", strike: 30, contracts: 1 };
    const first = summarizeCampaignProgress({ status: "ASSIGNED", events: [sell, assignment] });
    const second = summarizeCampaignProgress({ status: "ASSIGNED", events: [assignment, sell] });
    expect(second).toEqual(first);
    expect(first.currentPL).toBeNull();
    expect(first.projectedOtmApplicable).toBe(false);
    expect(first.projectedOtmPL).toBeNull();
  });

  it("test 6: an incomplete legacy SELL_PUT (missing expiration) never fabricates a valid current leg, in either order", () => {
    const incompleteSell: CampaignEventInput = { type: "SELL_PUT", optionType: "PUT", occurredAt: "2026-08-01", strike: 30, contracts: 1, premium: 0.5 }; // no expiration
    const note: CampaignEventInput = { type: "NOTE", occurredAt: "2026-08-03", notes: "legacy row, imported without an expiration" };
    for (const events of [[incompleteSell, note], [note, incompleteSell]]) {
      const progress = summarizeCampaignProgress({ status: "OPEN", currentCostToClose: 10, events, asOf: new Date("2026-08-08") });
      expect(progress.projectedOtmApplicable).toBe(false);
      expect(progress.projectedOtmPL).toBeNull();
      expect(progress.currentPL).toBeNull();
    }
  });

  it("test 6b: an incomplete legacy ROLL_PUT_OPEN (missing strike) never fabricates a valid current leg, regardless of tie order with its close leg", () => {
    const close: CampaignEventInput = { type: "ROLL_PUT_CLOSE", optionType: "PUT", occurredAt: "2026-08-08", sortOrder: 1, groupKey: "roll-1", strike: 30, contracts: 1, premium: 0.8 };
    const incompleteOpen: CampaignEventInput = { type: "ROLL_PUT_OPEN", optionType: "PUT", occurredAt: "2026-08-08", sortOrder: 1, groupKey: "roll-1", contracts: 1, premium: 1.2, expiration: "2026-08-22" }; // no strike
    const sell: CampaignEventInput = { type: "SELL_PUT", optionType: "PUT", occurredAt: "2026-08-01", strike: 30, contracts: 1, premium: 0.5, expiration: "2026-08-08" };
    for (const events of [[sell, close, incompleteOpen], [sell, incompleteOpen, close]]) {
      const progress = summarizeCampaignProgress({ status: "OPEN", currentCostToClose: 10, events, asOf: new Date("2026-08-15") });
      expect(progress.projectedOtmApplicable).toBe(false);
      expect(progress.projectedOtmPL).toBeNull();
      expect(progress.currentPL).toBeNull();
    }
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

  it("can use broker-derived cash-flow events and explicit trading P/L for the current pace", () => {
    const goal = summarizeContributionAdjustedGoal({
      accounts: [
        {
          ledgerEntries: [
            { type: "STARTING_VALUE", occurredAt: "2026-07-20", amount: 10_000 },
          ],
        },
      ],
      currentValue: 10_123.77,
      actualPL: 123.7,
      projectedOtmPL: null,
      targetWeeklyPercent: 1,
      asOf: new Date("2026-07-27"),
    });

    expect(goal.status).toBe("OK");
    expect(goal.startingCapital).toBe(10_000);
    expect(goal.tradingPLNow).toBe(123.7);
    expect(goal.actualWeeklyPacePercent).toBe(1.24);
  });
});

describe("Ticket 4/5 metric completeness regressions", () => {
  const sell: CampaignEventInput = { type: "SELL_PUT", occurredAt: "2026-09-01", strike: 20, contracts: 1, premium: 1, expiration: "2026-09-18" };
  it("unresolved fees keep OPEN current and projected amounts provisional", () => {
    const progress = summarizeCampaignProgress({ status: "OPEN", events: [sell], feesFullyKnown: false, currentCostToClose: 20 });
    expect(progress.netPremiumStatus).toBe("PENDING");
    expect(progress.currentPL).toBe(80);
    expect(progress.currentPLStatus).toBe("PENDING");
    expect(progress.projectedOtmPL).toBe(100);
    expect(progress.projectedOtmStatus).toBe("PENDING");
  });
  it("unknown CLOSED cash flow produces no confirmed zero or final P/L", () => {
    const progress = summarizeCampaignProgress({ status: "CLOSED", events: [{ ...sell, premium: null }, { type: "PUT_EXPIRED", occurredAt: "2026-09-18" }] });
    expect(progress.currentPLStatus).toBe("INCOMPLETE");
    expect(progress.realizedPLStatus).toBe("INCOMPLETE");
    expect(progress.realizedPL).toBeNull();
    expect(progress.currentPL).toBeNull();
  });
  it("a pending CLOSED result makes the combined projected aggregate pending", () => {
    const closed = summarizeCampaignProgress({ status: "CLOSED", feesFullyKnown: false, events: [sell, { type: "PUT_EXPIRED", occurredAt: "2026-09-18" }] });
    const open = summarizeCampaignProgress({ status: "OPEN", events: [sell], currentCostToClose: 20 });
    const totals = summarizePerformanceMetrics([{ status: "CLOSED", progress: closed }, { status: "OPEN", progress: open }]);
    expect(totals.projected).toEqual({ value: 200, status: "PENDING" });
    expect(totals.current).toEqual({ value: 180, status: "PENDING" });
  });
  it("missing expiration stays incomplete in normal-row presentation", () => {
    const progress = summarizeCampaignProgress({ status: "OPEN", events: [{ ...sell, expiration: null }] });
    expect(performanceMetricText(progress.projectedOtmPL, progress.projectedOtmStatus, String)).toBe("Unavailable - incomplete");
  });
  it.each([-1, NaN, Infinity])("invalid cost to close %s never becomes a zero-cost mark", (currentCostToClose) => {
    const p = summarizeCampaignProgress({ status: "OPEN", events: [sell], currentCostToClose });
    expect(p.currentCostToClose).toBeNull();
    expect(p.currentPL).toBeNull();
    expect(p.currentPLStatus).toBe("PENDING");
  });
  it("weekly confirmed performance excludes provisional and incomplete results and discloses exclusions", () => {
    const rows = [
      { closedAt: new Date("2026-09-14"), pl: 40, feesFullyKnown: true },
      { closedAt: new Date("2026-09-15"), pl: 500, feesFullyKnown: false },
      { closedAt: new Date("2026-09-16"), pl: 200, cashFlowsFullyKnown: false },
    ];
    const weekly = summarizeWeeklyReturns(rows, 10000, 1, new Date("2026-09-18"));
    expect(weekly.thisWeekPercent).toBe(0.4);
    expect(weekly.excludedCount).toBe(2);
    expect(weekly.completeness).toBe("INCOMPLETE");
  });
});
