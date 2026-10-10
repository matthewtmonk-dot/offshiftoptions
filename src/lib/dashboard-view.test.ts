import { describe, expect, it } from "vitest";
import type { AccountReportingSummary } from "@/domain/finance/reporting";
import type { CampaignExposureSummary } from "@/domain/finance/brokerPositions";
import type { WinLossSummary, ThisWeekSummary } from "@/domain/finance/performance";
import {
  accountValueCard,
  activeSettlementBreakdown,
  capitalPanelViewModel,
  chatPreviewViewModel,
  closedThisWeekViewModel,
  confirmedTradingPLCard,
  openCampaignsCard,
  positionsToReviewRows,
  scannerInsightViewModel,
  wholeAccountGainCard,
} from "./dashboard-view";

// Astra review (Dashboard V2 Phase 1): these were the missing behavioral coverage gaps flagged
// after the d1c938c..c12dabb diff - entirely/partially/genuinely-zero exposure, excluded PASS
// candidates, dollar-gain-without-percentage, empty vs. breakeven confirmed results, and
// unsupported-matching vs. unavailable-brokerage-data. Mirrors reporting-display.test.ts's own
// precedent of testing the view-model functions directly rather than page JSX (no component-
// render harness in this repo).

const commonInstant = new Date("2026-09-20T20:00:00.000Z");
const baselineStart = new Date("2026-08-01T00:00:00.000Z");

function baseReport(overrides: Partial<AccountReportingSummary> = {}): AccountReportingSummary {
  return {
    currentAccountValue: 10000,
    currentAccountValueAsOf: commonInstant,
    currentAccountValueOldestSnapshotAsOf: commonInstant,
    currentAccountValueNewestSnapshotAsOf: commonInstant,
    currentAccountValueSource: "SCHWAB",
    currentAccountValueUnavailableReason: null,
    currentAccountValueUnavailableMessage: null,

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

function baseExposure(overrides: Partial<CampaignExposureSummary> = {}): CampaignExposureSummary {
  return {
    securedPutCollateral: 5000,
    openCampaignsWithKnownCollateral: 2,
    openCampaignsWithUnknownCollateral: 0,
    assignedCampaignCount: 1,
    assignedShareCapital: 1400,
    assignedCampaignsWithKnownBasis: 1,
    assignedCampaignsWithCoveredCall: 0,
    ...overrides,
  };
}

function baseWinLoss(overrides: Partial<WinLossSummary> = {}): WinLossSummary {
  return {
    completedCount: 5,
    confirmedCount: 4,
    pendingCount: 1,
    unknownResults: 0,
    wins: 3,
    losses: 1,
    breakevens: 0,
    winRate: 75,
    averageWin: 100,
    averageLoss: -50,
    averageDurationDays: 14,
    confirmedRealizedTradingPL: 500,
    realizedTradingPL: 550,
    realizedTradingPLExact: false,
    ...overrides,
  };
}

function baseThisWeek(overrides: Partial<ThisWeekSummary> = {}): ThisWeekSummary {
  return {
    completedCount: 2,
    confirmedCount: 2,
    pendingCount: 0,
    wins: 2,
    losses: 0,
    breakevens: 0,
    grossPL: 200,
    netPL: 180,
    netPLExact: true,
    securedCapitalFullyKnown: true,
    grossReturnOnSecuredCapitalPercent: 2.8,
    returnOnSecuredCapitalPercent: 2.5,
    weekStartUtc: baselineStart,
    weekEndUtc: commonInstant,
    ...overrides,
  };
}

describe("accountValueCard", () => {
  it("shows the value and detail when available", () => {
    const card = accountValueCard(baseReport());
    expect(card.value).toBe("$10,000.00");
    expect(card.unavailableReason).toBeNull();
  });
  it("never fabricates a value when unavailable", () => {
    const card = accountValueCard(baseReport({ currentAccountValue: null, currentAccountValueUnavailableMessage: "No baseline." }));
    expect(card.value).toBe("Unavailable");
    expect(card.unavailableReason).toBe("No baseline.");
  });
});

describe("wholeAccountGainCard", () => {
  it("shows dollar gain and its detail (percentage folded in once, not duplicated)", () => {
    const card = wholeAccountGainCard(baseReport());
    expect(card.value).toBe("$800.00");
    expect(card.detail).toContain("8.00%");
    // The percentage must appear exactly once across value+detail, never twice.
    const occurrences = (card.detail ?? "").split("8.00%").length - 1;
    expect(occurrences).toBe(1);
    expect(card.returnUnavailableReason).toBeNull();
  });

  // Astra review gap: dollar gain available while percentage return specifically is unavailable
  // (e.g. contributions during the period prevent a supported simple return) must not be silently
  // dropped just because wholeAccountGainDetail has nothing to say about it.
  it("surfaces a distinct reason when the dollar gain is OK but the percentage is withheld", () => {
    const card = wholeAccountGainCard(
      baseReport({ wholeAccountReturnPercent: null, wholeAccountReturnStatus: "CONTRIBUTIONS_NEED_ADVANCED_RETURN" }),
    );
    expect(card.value).toBe("$800.00");
    expect(card.returnUnavailableReason).toContain("money moved into or out of the account");
  });

  it("never shows a return-unavailable reason when gain itself is unavailable (uses the gain reason instead)", () => {
    const card = wholeAccountGainCard(baseReport({ wholeAccountGainStatus: "UNAVAILABLE", wholeAccountGainUnavailableMessage: "No current value." }));
    expect(card.value).toBe("Unavailable");
    expect(card.unavailableReason).toBe("No current value.");
    expect(card.returnUnavailableReason).toBeNull();
  });
});

describe("confirmedTradingPLCard", () => {
  it("shows win rate and a wins/losses/breakevens sample with a fixed ALL_TIME period label", () => {
    const card = confirmedTradingPLCard(baseReport(), baseWinLoss());
    expect(card.periodLabel).toBe("Since tracked campaign history");
    expect(card.winRateLabel).toBe("75% win rate");
    expect(card.sampleLabel).toBe("3W-1L (4 confirmed)");
  });

  // Astra review (final pass): zero confirmed results must not de-emphasize a $0.00 as the
  // PRIMARY display - the primary value itself becomes the empty-state text, with a neutral
  // (uncolored) tone, and the sample label (which used to carry this same text) is left empty so
  // it isn't duplicated.
  it("shows the empty-state text as the PRIMARY value (never a de-emphasized $0.00) when nothing has confirmed yet", () => {
    const card = confirmedTradingPLCard(
      baseReport({ confirmedTradingPL: 0 }),
      baseWinLoss({ confirmedCount: 0, wins: 0, losses: 0, breakevens: 0, winRate: null }),
    );
    expect(card.value).toBe("No confirmed results yet");
    expect(card.value).not.toBe("$0.00");
    expect(card.tone).toBeUndefined();
    expect(card.winRateLabel).toBe("N/A");
    expect(card.sampleLabel).toBe("");
  });

  // A genuine confirmed $0.00 (e.g. an all-breakeven confirmed set) is real evidence, not an
  // empty state, and must keep showing the actual dollar figure with its normal tone.
  it("keeps a genuine confirmed $0.00 as the primary value, distinct from the no-confirmed-results empty state", () => {
    const card = confirmedTradingPLCard(
      baseReport({ confirmedTradingPL: 0 }),
      baseWinLoss({ confirmedCount: 1, wins: 0, losses: 0, breakevens: 1, winRate: 0 }),
    );
    expect(card.value).toBe("$0.00");
    expect(card.tone).toBe(0);
    expect(card.sampleLabel).toBe("0W-0L, 1 breakeven (1 confirmed)");
  });
});

describe("openCampaignsCard", () => {
  it("counts OPEN/ASSIGNED only and buckets by lifecycle", () => {
    const card = openCampaignsCard([
      { status: "OPEN", events: [{ type: "SELL_PUT", occurredAt: new Date(), strike: 10, contracts: 1, expiration: new Date("2026-12-01") }] },
      { status: "ASSIGNED", events: [] },
      { status: "CLOSED", events: [] },
    ] as never);
    expect(card.count).toBe(2);
    expect(card.breakdownLabel).toContain("1 put");
    expect(card.breakdownLabel).toContain("1 assigned");
  });
  it("reads as a neutral 'no open campaigns' state when empty", () => {
    expect(openCampaignsCard([]).breakdownLabel).toBe("No open campaigns");
  });
});

// Weekend / Settlement Clarity - ticket requirement 5: "Dashboard summary: 1 active + 4 settling
// yields correct display counts," reproduced against the ticket's own exact Saturday Oct 10
// production scenario (BBWI/CELH/SOFI/PATH expired Oct 9, UPST still active to Oct 23).
describe("activeSettlementBreakdown - Weekend / Settlement Clarity", () => {
  const asOf = new Date("2026-10-10T12:00:00Z");
  function sellPutEvents(expiration: Date) {
    return [{ type: "SELL_PUT", occurredAt: new Date("2026-09-01"), strike: 10, contracts: 1, expiration }];
  }
  function assignedWithCallEvents(callExpiration: Date) {
    return [
      { type: "SELL_PUT", occurredAt: new Date("2026-08-01"), strike: 10, contracts: 1, expiration: new Date("2026-08-15") },
      { type: "ASSIGNMENT", occurredAt: new Date("2026-08-15"), shares: 100, strike: 10 },
      { type: "SELL_COVERED_CALL", occurredAt: new Date("2026-08-16"), strike: 12, contracts: 1, expiration: callExpiration },
    ];
  }

  it("1 active put + 3 expired puts + 1 expired covered call => '1 active · 4 settling'", () => {
    const breakdown = activeSettlementBreakdown(
      [
        { status: "OPEN", events: sellPutEvents(new Date("2026-10-23")) }, // UPST - active
        { status: "OPEN", events: sellPutEvents(new Date("2026-10-09")) }, // BBWI - settling
        { status: "OPEN", events: sellPutEvents(new Date("2026-10-09")) }, // CELH - settling
        { status: "OPEN", events: sellPutEvents(new Date("2026-10-09")) }, // SOFI - settling
        { status: "ASSIGNED", events: assignedWithCallEvents(new Date("2026-10-09")) }, // PATH - settling
      ] as never,
      asOf,
    );
    expect(breakdown.activeCount).toBe(1);
    expect(breakdown.awaitingSettlementCount).toBe(4);
    expect(breakdown.label).toBe("1 active · 4 settling");
  });

  it("never alters the underlying open-campaign total - openCampaignsCard's own count is independent and unaffected", () => {
    const campaigns = [
      { status: "OPEN", events: sellPutEvents(new Date("2026-10-23")) },
      { status: "OPEN", events: sellPutEvents(new Date("2026-10-09")) },
    ] as never;
    expect(openCampaignsCard(campaigns).count).toBe(2);
    const breakdown = activeSettlementBreakdown(campaigns, asOf);
    expect(breakdown.activeCount + breakdown.awaitingSettlementCount).toBe(openCampaignsCard(campaigns).count);
  });

  it("omits a zero-count side entirely rather than showing '0 settling'", () => {
    expect(activeSettlementBreakdown([{ status: "OPEN", events: sellPutEvents(new Date("2026-10-23")) }] as never, asOf).label).toBe("1 active");
  });

  it("reads as a neutral 'no open campaigns' state when empty, matching openCampaignsCard's own empty wording", () => {
    expect(activeSettlementBreakdown([], asOf).label).toBe("No open campaigns");
  });
});

describe("capitalPanelViewModel - unknown/partial/zero exposure (Astra review, P2 blocking)", () => {
  it("shows a plain amount when every contributing campaign's exposure is known", () => {
    const panel = capitalPanelViewModel(baseReport(), baseExposure());
    expect(panel.securedPutCollateral.value).toBe("$5,000.00");
    expect(panel.securedPutCollateral.hasUnknown).toBe(false);
    expect(panel.assignedShareCapital.value).toBe("$1,400.00");
  });

  it("shows Unavailable (never a bare $0.00) when ALL contributing exposure is unknown", () => {
    const panel = capitalPanelViewModel(
      baseReport(),
      baseExposure({ securedPutCollateral: 0, openCampaignsWithKnownCollateral: 0, openCampaignsWithUnknownCollateral: 2 }),
    );
    expect(panel.securedPutCollateral.value).toBe("Unavailable");
    expect(panel.securedPutCollateral.hasUnknown).toBe(true);
  });

  it("labels a mixed known/unknown total as a known subtotal, never presented as complete", () => {
    const panel = capitalPanelViewModel(
      baseReport(),
      baseExposure({ securedPutCollateral: 3000, openCampaignsWithKnownCollateral: 1, openCampaignsWithUnknownCollateral: 1 }),
    );
    expect(panel.securedPutCollateral.value).toBe("$3,000.00 known subtotal - partial");
    expect(panel.securedPutCollateral.hasUnknown).toBe(true);
  });

  it("preserves a genuine zero when exposure is fully known (no assigned campaigns at all)", () => {
    const panel = capitalPanelViewModel(
      baseReport(),
      baseExposure({ assignedShareCapital: 0, assignedCampaignCount: 0, assignedCampaignsWithKnownBasis: 0 }),
    );
    expect(panel.assignedShareCapital.value).toBe("$0.00");
    expect(panel.assignedShareCapital.hasUnknown).toBe(false);
  });

  it("suppresses the utilization percentage whenever exposure is unknown", () => {
    const panel = capitalPanelViewModel(
      baseReport({ capitalUtilizationStatus: "UNKNOWN_EXPOSURE", currentCapitalUtilizationPercent: null }),
      baseExposure({ openCampaignsWithUnknownCollateral: 1 }),
    );
    expect(panel.utilizationLabel).toBeNull();
  });

  // Astra review (final pass): the aggregate must use the SAME known/unknown contributor
  // evidence as the two components, not just report.capitalUtilizationStatus's boolean - a
  // fully-unknown aggregate is "Unavailable," never a bare/qualified $0.00.
  describe("aggregate tracked LST capital committed", () => {
    it("mixed aggregate: unknown put collateral only (assigned side fully known) reads as a known subtotal", () => {
      const panel = capitalPanelViewModel(
        baseReport({ capitalUtilizationStatus: "UNKNOWN_EXPOSURE", currentCapitalCommitted: 1400, currentCapitalUtilizationPercent: null }),
        baseExposure({ securedPutCollateral: 0, openCampaignsWithKnownCollateral: 0, openCampaignsWithUnknownCollateral: 1 }),
      );
      expect(panel.lstCapitalCommitted.value).toBe("$1,400.00 known subtotal - partial");
    });

    it("mixed aggregate: unknown assigned-share basis only (put side fully known) reads as a known subtotal", () => {
      const panel = capitalPanelViewModel(
        baseReport({ capitalUtilizationStatus: "UNKNOWN_EXPOSURE", currentCapitalCommitted: 5000, currentCapitalUtilizationPercent: null }),
        baseExposure({ assignedShareCapital: 0, assignedCampaignsWithKnownBasis: 0, assignedCampaignCount: 1 }),
      );
      expect(panel.lstCapitalCommitted.value).toBe("$5,000.00 known subtotal - partial");
    });

    it("entirely unknown aggregate (every applicable contributor unknown) reads Unavailable, never a bare or qualified $0.00", () => {
      const panel = capitalPanelViewModel(
        baseReport({ capitalUtilizationStatus: "UNKNOWN_EXPOSURE", currentCapitalCommitted: 0, currentCapitalUtilizationPercent: null }),
        baseExposure({
          securedPutCollateral: 0, openCampaignsWithKnownCollateral: 0, openCampaignsWithUnknownCollateral: 1,
          assignedShareCapital: 0, assignedCampaignsWithKnownBasis: 0, assignedCampaignCount: 1,
        }),
      );
      expect(panel.lstCapitalCommitted.value).toBe("Unavailable");
    });

    it("mixed aggregate: some contributors known and some unknown across BOTH put and assigned sides reads as a known subtotal", () => {
      const panel = capitalPanelViewModel(
        baseReport({ capitalUtilizationStatus: "UNKNOWN_EXPOSURE", currentCapitalCommitted: 5000, currentCapitalUtilizationPercent: null }),
        baseExposure({
          securedPutCollateral: 5000, openCampaignsWithKnownCollateral: 1, openCampaignsWithUnknownCollateral: 1,
          assignedShareCapital: 0, assignedCampaignsWithKnownBasis: 0, assignedCampaignCount: 1,
        }),
      );
      expect(panel.lstCapitalCommitted.value).toBe("$5,000.00 known subtotal - partial");
    });

    it("fully known genuine zero (no open or assigned campaigns at all) reads as a plain $0.00, not Unavailable", () => {
      const panel = capitalPanelViewModel(
        baseReport({ currentCapitalCommitted: 0 }),
        baseExposure({
          securedPutCollateral: 0, openCampaignsWithKnownCollateral: 0, openCampaignsWithUnknownCollateral: 0,
          assignedShareCapital: 0, assignedCampaignsWithKnownBasis: 0, assignedCampaignCount: 0,
        }),
      );
      expect(panel.lstCapitalCommitted.value).toBe("$0.00");
    });

    it("fully known genuine zero with real (non-zero-count) but zero-value contributors still reads as a plain $0.00", () => {
      // All contributors are KNOWN (none unknown) even though their combined value happens to be
      // zero - a legitimate, fully-evidenced zero, never "Unavailable" or tagged "partial".
      const panel = capitalPanelViewModel(
        baseReport({ currentCapitalCommitted: 0 }),
        baseExposure({
          securedPutCollateral: 0, openCampaignsWithKnownCollateral: 2, openCampaignsWithUnknownCollateral: 0,
          assignedShareCapital: 0, assignedCampaignsWithKnownBasis: 0, assignedCampaignCount: 0,
        }),
      );
      expect(panel.lstCapitalCommitted.value).toBe("$0.00");
    });

    it("Unavailable when there is no valid account value to relate exposure to, regardless of exposure evidence", () => {
      const panel = capitalPanelViewModel(baseReport({ currentCapitalCommitted: null, capitalUtilizationStatus: "NO_ACCOUNT_VALUE" }), baseExposure());
      expect(panel.lstCapitalCommitted.value).toBe("Unavailable");
    });
  });
});

describe("closedThisWeekViewModel", () => {
  it("shows a neutral empty state, never a fabricated 0%, when nothing closed", () => {
    const view = closedThisWeekViewModel(baseReport(), baseThisWeek({ completedCount: 0 }));
    expect(view.hasClosures).toBe(false);
    expect(view.returnLabel).toBeNull();
  });
  it("shows the return using the reporting contract's own trade-return fields, with counts from summarizeThisWeek", () => {
    const view = closedThisWeekViewModel(baseReport(), baseThisWeek());
    expect(view.hasClosures).toBe(true);
    expect(view.returnLabel).toBe("2.50%");
    expect(view.countLabel).toContain("2 closed");
  });
});

describe("scannerInsightViewModel - personal exclusion (Astra review, P2 blocking)", () => {
  function scanRun(results: { id: string; ticker: string; passedCriteria: number; totalCriteria: number; summaryStatus: string; failGating?: boolean }[]) {
    return {
      createdAt: commonInstant,
      source: "LIVE:SCHWAB",
      results: results.map((r) => ({
        ...r,
        snapshotJson: null,
        // A real gating-rule failure (not merely an empty criterion list, which classifyReadiness
        // treats as vacuously PASS) - "Stock price" maps to GATING_RULE_KEYS's "price".
        criterionResults: r.failGating
          ? [{ criterionName: "Stock price", actualValue: "5", operator: "BETWEEN", desiredValue: "[10,50]", status: "FAIL", explanation: "Below range" }]
          : [],
      })),
    };
  }

  it("excludes a PASS candidate the owner has marked NEVER_TRADE, even though it would otherwise be promoted", () => {
    const run = scanRun([
      { id: "1", ticker: "AAA", passedCriteria: 5, totalCriteria: 5, summaryStatus: "PASS" },
      { id: "2", ticker: "BBB", passedCriteria: 5, totalCriteria: 5, summaryStatus: "PASS" },
    ]);
    const withoutExclusion = scannerInsightViewModel(run);
    expect(withoutExclusion.items.map((i) => i.ticker)).toEqual(["AAA", "BBB"]);

    const withExclusion = scannerInsightViewModel(run, new Set(["AAA"]));
    expect(withExclusion.items.map((i) => i.ticker)).toEqual(["BBB"]);
  });

  it("never promotes a known gating FAIL regardless of exclusions", () => {
    const run = scanRun([{ id: "1", ticker: "CCC", passedCriteria: 4, totalCriteria: 5, summaryStatus: "FAIL", failGating: true }]);
    expect(scannerInsightViewModel(run, new Set()).items).toEqual([]);
  });
});

describe("positionsToReviewRows", () => {
  it("never invents a money field, and reports lifecycle facts only", () => {
    const rows = positionsToReviewRows([
      {
        id: "c1", ownerId: "u1", accountId: "a1", ticker: "XYZ", status: "OPEN",
        events: [{ type: "SELL_PUT", occurredAt: new Date("2026-09-01"), strike: 50, contracts: 2, expiration: new Date("2026-10-01") }],
      },
    ] as never);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.legType).toBe("PUT");
    expect(rows[0]!.strike).toBe(50);
    expect(rows[0]!.quantity).toBe(2);
    expect(rows[0]!.quantityUnit).toBe("contracts");
    expect(Object.keys(rows[0]!)).not.toContain("pl");
    expect(Object.keys(rows[0]!)).not.toContain("realizedPL");
  });

  it("excludes a CLOSED entry defensively rather than misrendering it", () => {
    expect(positionsToReviewRows([{ id: "c1", ownerId: "u1", accountId: "a1", ticker: "XYZ", status: "CLOSED", events: [] }] as never)).toEqual([]);
  });
});

describe("chatPreviewViewModel", () => {
  it("collapses entirely (null) when there is nothing to show", () => {
    expect(chatPreviewViewModel(0, [])).toBeNull();
  });
  it("shows unread count and the latest message when present", () => {
    const preview = chatPreviewViewModel(2, [{ sender: { name: "Eric" }, body: "hi", createdAt: commonInstant }]);
    expect(preview?.unreadCount).toBe(2);
    expect(preview?.latestMessage?.senderName).toBe("Eric");
  });
});
