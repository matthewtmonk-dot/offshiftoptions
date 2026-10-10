import { describe, expect, it } from "vitest";
import type { AccountReportingSummary } from "@/domain/finance/reporting";
import type { CampaignExposureSummary } from "@/domain/finance/brokerPositions";
import type { WinLossSummary, ThisWeekSummary } from "@/domain/finance/performance";
import type { PositionReviewResult } from "@/domain/finance/positionReview";
import type { PositionAssessmentDisplay } from "@/domain/finance/positionReviewAssessment";
import {
  accountValueCard,
  attachPositionAssessmentDisplays,
  attentionNowRows,
  capitalPanelViewModel,
  chatPreviewViewModel,
  closedThisWeekViewModel,
  confirmedTradingPLCard,
  excludeAttentionRows,
  openCampaignsCard,
  positionsToReviewRows,
  scannerInsightViewModel,
  sortPositionToReviewDisplayRows,
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

describe("Phase 2B - attachPositionAssessmentDisplays / sortPositionToReviewDisplayRows", () => {
  function reviewFixture(overrides: Partial<PositionReviewResult> = {}): PositionReviewResult {
    return {
      action: "COMFORTABLE",
      lifecycle: "CURRENT_PUT",
      evidence: { position: "SCHWAB_CONFIRMED", quote: "ELIGIBLE", quoteIneligibleReason: null, session: "OPEN" },
      explanation: {
        reasonCodes: [], optionType: "PUT", strike: 25, stockPrice: 30, dollarDistance: 5, percentageDistance: 20,
        moneyness: "OTM", bufferPercent: 3, expiration: new Date("2026-10-02"), daysToExpiration: 10,
        quoteTradeTime: new Date("2026-06-15T16:00:00Z"), quoteAgeMs: 0, positionEvidenceAsOf: new Date("2026-06-15T16:00:00Z"),
        activeGuidanceDeadline: new Date("2026-06-15T16:02:00Z"), evaluatedAt: new Date("2026-06-15T16:00:00Z"),
      },
      priority: { group: 8, withinExpirationTodaySubgroup: null, expirationSortKey: "2026-10-02", ticker: "XYZ", accountId: "a1", campaignId: "c1" },
      ...overrides,
    };
  }

  function displayFixture(overrides: Partial<PositionReviewResult> = {}): PositionAssessmentDisplay {
    return { state: "CURRENT", current: reviewFixture(overrides), lastValid: null };
  }

  function row(campaignId: string) {
    return { campaignId, ownerId: "u1", accountId: "a1", ticker: "XYZ", status: "OPEN" as const, stage: "Cash-secured put" as const, legType: "PUT" as const, strike: 25, expiration: new Date("2026-10-02"), quantity: 1, quantityUnit: "contracts" as const };
  }

  it("attaches a matching display by campaign id, and null when none exists", () => {
    const displays = new Map([["c1", displayFixture()]]);
    const [attached1, attached2] = attachPositionAssessmentDisplays([row("c1"), row("c2")], displays);
    expect(attached1.display).toEqual(displayFixture());
    expect(attached2.display).toBeNull();
  });

  it("sorts by the shared evaluator's own priority order, never by input order", () => {
    const reviewRoll = displayFixture({ action: "REVIEW_ROLL", priority: { group: 4, withinExpirationTodaySubgroup: null, expirationSortKey: "2026-10-02", ticker: "AAA", accountId: "a1", campaignId: "c1" } });
    const comfortable = displayFixture({ priority: { group: 8, withinExpirationTodaySubgroup: null, expirationSortKey: "2026-10-02", ticker: "ZZZ", accountId: "a1", campaignId: "c2" } });
    const attached = attachPositionAssessmentDisplays([row("c2"), row("c1")], new Map([["c1", reviewRoll], ["c2", comfortable]]));
    expect(sortPositionToReviewDisplayRows(attached).map((r) => r.campaignId)).toEqual(["c1", "c2"]);
  });

  it("sorts a row with no evaluable display after every row that has one, rather than guessing a priority", () => {
    const attached = attachPositionAssessmentDisplays([row("c1"), row("c2")], new Map([["c1", displayFixture()]]));
    expect(sortPositionToReviewDisplayRows(attached).map((r) => r.campaignId)).toEqual(["c1", "c2"]);
  });

  // Attention-First Freshness Phase 1 - "Attention Now" never promotes a row that doesn't
  // genuinely need review right now: COMFORTABLE (current, no action) and historical (LAST_VALID)
  // actions are both excluded, even though a LAST_VALID row can carry a WATCH/REVIEW_ROLL action
  // of its own - that action is only confirmed-stale context, never a live attention item.
  describe("attentionNowRows", () => {
    function unavailableDisplay(reasonCodes: string[]): PositionAssessmentDisplay {
      return { state: "UNAVAILABLE", currentUnavailable: reviewFixture({ action: "CANNOT_ASSESS", explanation: { ...reviewFixture().explanation, reasonCodes } }) };
    }
    function lastValidDisplay(action: PositionReviewResult["action"]): PositionAssessmentDisplay {
      return {
        state: "LAST_VALID",
        currentUnavailable: reviewFixture({ action: "CANNOT_ASSESS", explanation: { ...reviewFixture().explanation, reasonCodes: ["MARKET_CLOSED"] } }),
        lastValid: {
          scope: { ownerId: "u1", accountId: "a1", campaignId: "c1", openingEventId: "e1" }, contextFingerprint: "fp",
          action: action === "CANNOT_ASSESS" ? "COMFORTABLE" : action, reasonCodes: [], evaluatedAt: new Date("2026-06-15T16:00:00Z"),
          nySessionDate: "2026-06-15", regularSessionStart: new Date("2026-06-15T13:30:00Z"), regularSessionEnd: new Date("2026-06-15T20:00:00Z"),
          underlyingPrice: 30, underlyingTradeTime: new Date("2026-06-15T16:00:00Z"), ticker: "XYZ", optionType: "PUT", strike: 25,
          expiration: new Date("2026-10-02"), contracts: 1, moneyness: "OTM", dollarDistance: 5, percentageDistance: 20,
          appliedRollBufferPercent: 3, positionEvidenceSource: "MANUAL_POSITION", brokerReceiptAt: null, evaluationPolicyVersion: 1,
        },
      };
    }

    it("excludes a CURRENT Comfortable row - current, no action needed is not an attention item", () => {
      const attached = attachPositionAssessmentDisplays([row("c1")], new Map([["c1", displayFixture({ action: "COMFORTABLE" })]]));
      expect(attentionNowRows(attached)).toHaveLength(0);
    });

    it("includes a CURRENT Watch/Review roll/Review call row", () => {
      for (const action of ["WATCH", "REVIEW_ROLL", "REVIEW_CALL"] as const) {
        const attached = attachPositionAssessmentDisplays([row("c1")], new Map([["c1", displayFixture({ action })]]));
        expect(attentionNowRows(attached).map((r) => r.campaignId)).toEqual(["c1"]);
      }
    });

    it("excludes a row with no display at all", () => {
      const attached = attachPositionAssessmentDisplays([row("c1")], new Map());
      expect(attentionNowRows(attached)).toHaveLength(0);
    });

    it("excludes a LAST_VALID row even when its own stored action is Watch/Review - historical action is context, never a live attention item", () => {
      const attached = [{ ...row("c1"), display: lastValidDisplay("WATCH") }];
      expect(attentionNowRows(attached)).toHaveLength(0);
    });

    it("excludes an UNAVAILABLE row carrying only a known transient/benign reason (market closed, quote momentarily unavailable)", () => {
      const attached = [{ ...row("c1"), display: unavailableDisplay(["MARKET_CLOSED"]) }];
      expect(attentionNowRows(attached)).toHaveLength(0);
    });

    it("includes an UNAVAILABLE row carrying a genuine contradiction reason (e.g. past-expiration unresolved)", () => {
      const attached = [{ ...row("c1"), display: unavailableDisplay(["PAST_EXPIRATION_UNRESOLVED"]) }];
      expect(attentionNowRows(attached).map((r) => r.campaignId)).toEqual(["c1"]);
    });

    it("returns an empty list (never a guessed/placeholder item) when nothing needs attention - supports the Dashboard's own 'No new attention items' empty state", () => {
      const attached = attachPositionAssessmentDisplays([row("c1"), row("c2")], new Map([
        ["c1", displayFixture({ action: "COMFORTABLE" })],
        ["c2", lastValidDisplay("REVIEW_ROLL")],
      ]));
      expect(attentionNowRows(attached)).toEqual([]);
    });
  });

  // Compact position UX - Dashboard's "Open Positions" must never repeat a row Attention Now
  // already surfaced (the AAP/F/IONQ/WBD duplicate-rows bug the ticket calls out). Display
  // filtering/dedup only - never changes which rows attentionNowRows itself selects.
  describe("excludeAttentionRows (Compact position UX)", () => {
    it("A: an attention-qualifying row (e.g. WATCH) is excluded from the remainder, so it is never shown twice", () => {
      const attached = attachPositionAssessmentDisplays([row("c1")], new Map([["c1", displayFixture({ action: "WATCH" })]]));
      const attention = attentionNowRows(attached);
      expect(attention.map((r) => r.campaignId)).toEqual(["c1"]);
      expect(excludeAttentionRows(attached, attention)).toEqual([]);
    });

    it("B: an open row that does NOT qualify for attention (e.g. COMFORTABLE) still appears in the remainder", () => {
      const attached = attachPositionAssessmentDisplays([row("c1")], new Map([["c1", displayFixture({ action: "COMFORTABLE" })]]));
      const attention = attentionNowRows(attached);
      expect(attention).toEqual([]);
      expect(excludeAttentionRows(attached, attention).map((r) => r.campaignId)).toEqual(["c1"]);
    });

    it("mixed set: only the non-attention row remains, in its original relative order", () => {
      const attached = attachPositionAssessmentDisplays(
        [row("c1"), row("c2")],
        new Map([
          ["c1", displayFixture({ action: "REVIEW_ROLL" })],
          ["c2", displayFixture({ action: "COMFORTABLE" })],
        ]),
      );
      const attention = attentionNowRows(attached);
      expect(attention.map((r) => r.campaignId)).toEqual(["c1"]);
      expect(excludeAttentionRows(attached, attention).map((r) => r.campaignId)).toEqual(["c2"]);
    });

    it("when every row qualifies for attention, the remainder is empty - supports Dashboard's own Open Positions empty state", () => {
      const attached = attachPositionAssessmentDisplays([row("c1")], new Map([["c1", displayFixture({ action: "WATCH" })]]));
      const attention = attentionNowRows(attached);
      expect(excludeAttentionRows(attached, attention)).toEqual([]);
    });
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
