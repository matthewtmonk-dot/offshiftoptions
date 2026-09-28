import "server-only";
import type { AccountReportingSummary } from "@/domain/finance/reporting";
import type { CampaignExposureSummary } from "@/domain/finance/brokerPositions";
import type { WinLossSummary, ThisWeekSummary } from "@/domain/finance/performance";
import { getCurrentOpenCall, getCurrentOpenPut, summarizeCampaign, type CampaignCurrentStage, type CampaignStatusInput } from "@/domain/finance/campaigns";
import {
  accountValueDetail,
  accountValueUnavailableReason,
  confirmedTradingPLNote,
  wholeAccountGainDetail,
} from "@/lib/reporting-display";
import { money, percent } from "@/lib/format";
import { classifyReadiness, honestSetupLabel, honestSetupScore, isActionableReadiness, type CriterionResult, type ScanSummary } from "@/domain/scanner/scanner";
import { GATING_RULE_KEYS, SCANNER_RULE_DEFINITIONS } from "@/domain/scanner/profile";
import { contractReasonCodeFromSnapshot, optionEnrichmentFromSnapshot } from "@/domain/scanner/option-enrichment";

/**
 * Dashboard V2 Phase 1 - presentation-ready view model built ONLY from already-computed
 * domain/reporting values (reporting.ts, accountLedger.ts, performance.ts, brokerPositions.ts,
 * campaigns.ts, scanner.ts). This module never recomputes a financial formula itself - every
 * number here is a passthrough, a simple formatting choice, or a bounded presentation grouping
 * (e.g. counting campaigns into a lifecycle bucket). Keeps page.tsx from re-deriving these facts
 * inline as the page grows, per the same "one authoritative place" rationale as reporting.ts
 * itself (see that file's own top-of-file comment).
 */

const ruleKeyByName = new Map(SCANNER_RULE_DEFINITIONS.map((definition) => [definition.name, definition.key]));

// ---------------------------------------------------------------------------
// Summary cards
// ---------------------------------------------------------------------------

export type AccountValueCard = {
  value: string;
  detail: string | null;
  unavailableReason: string | null;
};

/** Card A: authoritative supported current account value only - never reconstructed. */
export function accountValueCard(report: AccountReportingSummary): AccountValueCard {
  return {
    value: report.currentAccountValue === null ? "Unavailable" : money(report.currentAccountValue),
    detail: accountValueDetail(report),
    unavailableReason: report.currentAccountValue === null ? accountValueUnavailableReason(report) : null,
  };
}

export type WholeAccountGainCard = {
  value: string;
  tone: number | undefined;
  returnLabel: string | null;
  detail: string | null;
  unavailableReason: string | null;
};

/** Card B: whole-account dollar gain + independently-available return% - never an improvised ratio. */
export function wholeAccountGainCard(report: AccountReportingSummary): WholeAccountGainCard {
  const ok = report.wholeAccountGainStatus === "OK";
  return {
    value: ok ? money(report.wholeAccountGain) : "Unavailable",
    tone: ok ? (report.wholeAccountGain ?? undefined) : undefined,
    returnLabel: ok && report.wholeAccountReturnPercent !== null ? percent(report.wholeAccountReturnPercent, 2) : null,
    detail: wholeAccountGainDetail(report),
    unavailableReason: ok ? null : report.wholeAccountGainUnavailableMessage,
  };
}

export type ConfirmedTradingPLCard = {
  value: string;
  tone: number;
  /** Fixed period framing - deliberately distinct from the separate "Closed This Week" panel, so
   * this ALL_TIME figure (report.confirmedTradingPLPeriod) is never mistaken for a this-week
   * number sitting right next to a genuinely weekly one. */
  periodLabel: string;
  winRateLabel: string;
  sampleLabel: string;
  excludedNote: string | null;
};

/** Card C: confirmed completed-campaign trading P/L only - open campaigns, rolls-as-wins, and
 * assignment-as-outcome are never counted (see summarizeWinLoss's own CONFIRMED-only gate). No
 * confirmed outcomes reads as "N/A", never a fabricated 0%. */
export function confirmedTradingPLCard(report: AccountReportingSummary, winLoss: WinLossSummary): ConfirmedTradingPLCard {
  const sampleParts = [`${winLoss.wins}W-${winLoss.losses}L`];
  if (winLoss.breakevens > 0) sampleParts.push(`${winLoss.breakevens} breakeven`);
  return {
    value: money(report.confirmedTradingPL),
    tone: report.confirmedTradingPL,
    periodLabel: "Since tracked campaign history",
    winRateLabel: winLoss.winRate === null ? "N/A" : `${winLoss.winRate}% win rate`,
    sampleLabel: `${sampleParts.join(", ")} (${winLoss.confirmedCount} confirmed)`,
    excludedNote: confirmedTradingPLNote(report),
  };
}

export type OpenCampaignsCard = {
  count: number;
  breakdownLabel: string;
};

/** Card D: bounded lifecycle-stage breakdown of the SAME open-campaign count - never a separate
 * broker-position count (see the existing dashboard's own awaitingExpirationCount precedent).
 * `openCampaigns` is expected to already be scoped to OPEN/ASSIGNED only (the caller's own query
 * filters this) - a CLOSED entry, if one ever slipped through, is defensively excluded from the
 * count entirely rather than miscategorized. */
export function openCampaignsCard(openCampaigns: { status: CampaignStatusInput; events: Parameters<typeof summarizeCampaign>[0]["events"] }[]): OpenCampaignsCard {
  let puts = 0;
  let coveredCalls = 0;
  let assignedNoCall = 0;
  let reviewNeeded = 0;
  let total = 0;
  for (const campaign of openCampaigns) {
    if (campaign.status === "OPEN") {
      total += 1;
      if (getCurrentOpenPut(campaign.events)) puts += 1;
      else reviewNeeded += 1;
    } else if (campaign.status === "ASSIGNED") {
      total += 1;
      if (getCurrentOpenCall(campaign.events)) coveredCalls += 1;
      else assignedNoCall += 1;
    }
  }
  const parts: string[] = [];
  if (puts > 0) parts.push(`${puts} put${puts === 1 ? "" : "s"}`);
  if (coveredCalls > 0) parts.push(`${coveredCalls} covered call${coveredCalls === 1 ? "" : "s"}`);
  if (assignedNoCall > 0) parts.push(`${assignedNoCall} assigned`);
  if (reviewNeeded > 0) parts.push(`${reviewNeeded} needs review`);
  return { count: total, breakdownLabel: parts.length > 0 ? parts.join(" · ") : "No open campaigns" };
}

// ---------------------------------------------------------------------------
// Positions to Review (safe fields only - no fabricated/current P/L, no recommendations)
// ---------------------------------------------------------------------------

export type PositionToReviewRow = {
  campaignId: string;
  ownerId: string;
  accountId: string;
  ticker: string;
  status: "OPEN" | "ASSIGNED";
  stage: CampaignCurrentStage;
  legType: "PUT" | "CALL" | null;
  strike: number | null;
  expiration: Date | null;
  /** Contracts for an option leg, shares held for an assigned-with-no-call row. */
  quantity: number | null;
  quantityUnit: "contracts" | "shares" | null;
};

/**
 * Deliberately excludes any money field: the architecture review found the prior dashboard's open
 * -row figure unsafe (`realizedPL ?? 0`, fabricating a confirmed-looking $0 for an OPEN campaign
 * that has no realized result at all). A trustworthy CONFIRMED-status current P/L would require
 * wiring in the same live option-mark-snapshot + linked-broker-record pipeline positions/page.tsx
 * uses (resolveCurrentCostToClose) - out of scope for this Phase 1 pass; see PROJECT_HANDOFF.md
 * for the follow-up. Only already-certain lifecycle facts are shown here. `campaigns` is expected
 * to already be scoped to OPEN/ASSIGNED only (the caller's own query filters this) - a CLOSED
 * entry, if one ever slipped through, is defensively excluded rather than misrendered.
 */
export function positionsToReviewRows(
  campaigns: { id: string; ownerId: string; accountId: string; ticker: string; status: CampaignStatusInput; events: Parameters<typeof summarizeCampaign>[0]["events"] }[],
): PositionToReviewRow[] {
  return campaigns.flatMap((campaign) => {
    if (campaign.status !== "OPEN" && campaign.status !== "ASSIGNED") return [];
    const summary = summarizeCampaign({ status: campaign.status, events: campaign.events });
    const openPut = campaign.status === "OPEN" ? getCurrentOpenPut(campaign.events) : null;
    const openCall = campaign.status === "ASSIGNED" ? getCurrentOpenCall(campaign.events) : null;
    const leg = openPut ?? openCall;
    return [{
      campaignId: campaign.id,
      ownerId: campaign.ownerId,
      accountId: campaign.accountId,
      ticker: campaign.ticker,
      status: campaign.status,
      stage: summary.currentStage,
      legType: openPut ? ("PUT" as const) : openCall ? ("CALL" as const) : null,
      strike: leg?.strike ?? null,
      expiration: leg?.expiration ?? null,
      quantity: leg ? leg.contracts : campaign.status === "ASSIGNED" ? summary.sharesHeld : null,
      quantityUnit: leg ? ("contracts" as const) : campaign.status === "ASSIGNED" ? ("shares" as const) : null,
    }];
  });
}

// ---------------------------------------------------------------------------
// Capital & Cash panel
// ---------------------------------------------------------------------------

export type CapitalPanelViewModel = {
  securedPutCollateral: { value: string; hasUnknown: boolean; detail: string | null };
  assignedShareCapital: { value: string; hasUnknown: boolean; detail: string | null };
  lstCapitalCommitted: { value: string; detail: string };
  /** Null unless the reporting contract says every input is complete - never an "estimated"
   * percentage. */
  utilizationLabel: string | null;
  ambiguousNotice: string | null;
};

/**
 * Phase 1 explicitly shows only these trustworthy tracked-exposure facts - never "Total account
 * deployed" (the reporting contract covers TRACKED campaign exposure, not necessarily every
 * dollar in the brokerage account), never a computed "available cash" (normalized cash may be
 * cashBalance, a cashAvailableForTrading fallback, or a zero fallback - see BrokerAccount's own
 * doc comments), and never account value minus collateral. No pie chart implying these are
 * mutually exclusive balance-sheet slices.
 */
export function capitalPanelViewModel(report: AccountReportingSummary, exposure: CampaignExposureSummary): CapitalPanelViewModel {
  const securedHasUnknown = exposure.openCampaignsWithUnknownCollateral > 0;
  const assignedHasUnknown = exposure.assignedCampaignCount > exposure.assignedCampaignsWithKnownBasis;
  return {
    securedPutCollateral: {
      value: money(exposure.securedPutCollateral),
      hasUnknown: securedHasUnknown,
      detail: securedHasUnknown ? `${exposure.openCampaignsWithUnknownCollateral} open campaign(s) with unknown collateral` : null,
    },
    assignedShareCapital: {
      value: money(exposure.assignedShareCapital),
      hasUnknown: assignedHasUnknown,
      detail: assignedHasUnknown
        ? `${exposure.assignedCampaignCount - exposure.assignedCampaignsWithKnownBasis} of ${exposure.assignedCampaignCount} assigned campaign(s) missing cost basis`
        : exposure.assignedCampaignsWithCoveredCall > 0
          ? `${exposure.assignedCampaignsWithCoveredCall} covered by an open call`
          : null,
    },
    lstCapitalCommitted: {
      value: report.currentCapitalCommitted === null ? "Unavailable" : money(report.currentCapitalCommitted),
      detail: "Put collateral + assigned shares at cost - tracked campaigns only",
    },
    utilizationLabel: report.capitalUtilizationStatus === "OK" ? percent(report.currentCapitalUtilizationPercent, 0) : null,
    ambiguousNotice:
      report.capitalUtilizationStatus === "UNKNOWN_EXPOSURE"
        ? (report.capitalUtilizationMessage ?? "Some current position exposure could not be verified.")
        : null,
  };
}

// ---------------------------------------------------------------------------
// Closed This Week panel
// ---------------------------------------------------------------------------

export type ClosedThisWeekViewModel = {
  hasClosures: boolean;
  countLabel: string;
  returnLabel: string | null;
  reasonMessage: string | null;
};

/** Uses the SAME Section-3 figures reporting.ts already computed (report.tradeReturn*) for the
 * percentage/status, and summarizeThisWeek only for the count/win-loss breakdown reporting.ts
 * doesn't itself expose - never a second, independently-derived percentage. "No closures" reads
 * as its own neutral state, never a fabricated 0%. */
export function closedThisWeekViewModel(report: AccountReportingSummary, thisWeek: ThisWeekSummary): ClosedThisWeekViewModel {
  if (thisWeek.completedCount === 0) {
    return { hasClosures: false, countLabel: "No campaigns closed this week", returnLabel: null, reasonMessage: null };
  }
  const sampleParts = [`${thisWeek.wins}W-${thisWeek.losses}L`];
  if (thisWeek.breakevens > 0) sampleParts.push(`${thisWeek.breakevens} breakeven`);
  const countLabel = `${thisWeek.completedCount} closed (${sampleParts.join(", ")}, ${thisWeek.confirmedCount} confirmed)`;
  return {
    hasClosures: true,
    countLabel,
    returnLabel: report.tradeReturnStatus === "OK" ? percent(report.tradeReturnPercent, 2) : null,
    reasonMessage: report.tradeReturnStatus === "OK" || report.tradeReturnStatus === "NO_CLOSED_CAMPAIGNS" ? null : report.tradeReturnMessage,
  };
}

// ---------------------------------------------------------------------------
// Scanner Insight panel
// ---------------------------------------------------------------------------

export type ScannerInsightItem = {
  id: string;
  ticker: string;
  readiness: "PASS" | "NEAR";
  label: string;
  explanation: string;
};

export type ScannerInsightViewModel = {
  hasRun: boolean;
  runAt: Date | null;
  isLiveSchwab: boolean;
  items: ScannerInsightItem[];
  totalScanned: number;
};

type ScannerResultLike = {
  id: string;
  ticker: string;
  passedCriteria: number;
  totalCriteria: number;
  summaryStatus: string;
  snapshotJson: unknown;
  criterionResults: { criterionName: string; actualValue: string | null; operator: string; desiredValue: string; status: string; explanation: string }[];
};

/**
 * Compact, up-to-3-item preview reusing the exact same honest classification the Scanner page's
 * own PASS/NEAR/NEEDS_DATA/FAIL logic is built from (classifyReadiness/isActionableReadiness) - a
 * NEEDS_DATA candidate is never promoted here just because its numeric score looks attractive.
 * Phase 2 follow-up (not attempted here): Scanner's own personal-exclusion display policy,
 * settings-revision check, and resultsPredateCurrentSettings distinction are not yet threaded
 * through this preview - sharing that exact selector safely needs a small domain-level export
 * from the Scanner page's own logic, which this Phase 1 ticket does not touch.
 */
export function scannerInsightViewModel(
  latestScanRun: { createdAt: Date; source: string; results: ScannerResultLike[] } | null,
): ScannerInsightViewModel {
  if (!latestScanRun) {
    return { hasRun: false, runAt: null, isLiveSchwab: false, items: [], totalScanned: 0 };
  }
  const scanned = latestScanRun.results.map((result) => {
    const summary = toDomainSummary(result);
    const optionEnrichment = optionEnrichmentFromSnapshot(result.snapshotJson);
    const contractReasonCode = contractReasonCodeFromSnapshot(result.snapshotJson);
    return {
      result,
      score: honestSetupScore(summary, GATING_RULE_KEYS),
      label: honestSetupLabel(summary, GATING_RULE_KEYS),
      readiness: classifyReadiness(summary, GATING_RULE_KEYS, optionEnrichment, contractReasonCode),
    };
  });
  const items = scanned
    .filter((setup) => isActionableReadiness(setup.readiness))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((setup) => ({
      id: setup.result.id,
      ticker: setup.result.ticker,
      readiness: setup.readiness as "PASS" | "NEAR",
      label: setup.label,
      explanation: `${setup.result.passedCriteria} / ${setup.result.totalCriteria} criteria`,
    }));
  return {
    hasRun: true,
    runAt: latestScanRun.createdAt,
    isLiveSchwab: latestScanRun.source === "LIVE:SCHWAB",
    items,
    totalScanned: scanned.length,
  };
}

function toDomainSummary(result: ScannerResultLike): ScanSummary {
  const results: CriterionResult[] = result.criterionResults.map((criterion) => ({
    key: ruleKeyByName.get(criterion.criterionName) ?? criterion.criterionName,
    name: criterion.criterionName,
    actualValue: criterion.actualValue,
    operator: criterion.operator as CriterionResult["operator"],
    desiredValue: safeParse(criterion.desiredValue),
    status: criterion.status as CriterionResult["status"],
    explanation: criterion.explanation,
  }));
  return { status: result.summaryStatus as ScanSummary["status"], passed: result.passedCriteria, total: result.totalCriteria, results };
}

function safeParse(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// Chat preview
// ---------------------------------------------------------------------------

export type ChatPreviewViewModel = {
  unreadCount: number;
  latestMessage: { senderName: string; body: string; createdAt: Date } | null;
} | null;

/** Collapses entirely (returns null) when there is nothing to show - never competes visually with
 * financial/action information. */
export function chatPreviewViewModel(
  unreadCount: number,
  recentMessages: { sender: { name: string }; body: string | null; createdAt: Date }[],
): ChatPreviewViewModel {
  const latest = recentMessages[0] ?? null;
  if (unreadCount === 0 && !latest) {
    return null;
  }
  return {
    unreadCount,
    latestMessage: latest ? { senderName: latest.sender.name, body: latest.body || "Shared an image", createdAt: latest.createdAt } : null,
  };
}
