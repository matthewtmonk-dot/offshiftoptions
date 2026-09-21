import { round } from "./calculations";
import {
  getCurrentOpenPut,
  getOpenPutEvidenceState,
  summarizeCampaign,
  type CampaignEventInput,
  type CampaignStatusInput,
  type OpenPutEvidenceState,
} from "./campaigns";

/**
 * Shared completeness model for any profit/performance figure this module produces - see
 * PROJECT_HANDOFF.md "Financial / Accounting Invariants" and the Ticket 4 handoff note for the
 * full rationale. A caller must never present a headline/subtotal as more certain than the
 * weakest CONFIRMED/PENDING/INCOMPLETE status among its contributing rows.
 *
 * - CONFIRMED: required inputs are sufficiently known; safe to include in a confirmed total.
 * - PENDING: a calculable amount exists, but something required (a fee, an expiration
 *   confirmation, a live mark) isn't final yet. The number shown is real (never a fabricated
 *   zero), but must be labeled provisional, not final.
 * - INCOMPLETE: required evidence is missing/unsupported (e.g. a legacy event missing
 *   strike/contracts/expiration, or an unresolved current-cash-flow unknown) - no trustworthy
 *   amount can be produced at all.
 * - NOT_APPLICABLE: the metric legitimately doesn't apply to this campaign/state (e.g. a
 *   CSP-only "projected OTM" figure for an ASSIGNED or CLOSED campaign).
 */
export type CompletenessStatus = "CONFIRMED" | "PENDING" | "INCOMPLETE" | "NOT_APPLICABLE";

export type CompletedCampaignResult = {
  campaignId: string;
  /** Explicitly false when campaign history lacks required cash-flow evidence. */
  cashFlowsFullyKnown?: boolean;
  closedAt: Date;
  finalResult: "GAIN" | "LOSS" | "BREAKEVEN" | "OPEN" | "UNKNOWN";
  /** Fee-inclusive realized P/L - unchanged meaning from before fee-knownness tracking existed. */
  pl: number | null;
  daysActive: number | null;
  collateralCommitted?: number | null;
  /** Fee-EXCLUSIVE P/L (gross premium/debits/stock only) - always exact whenever `pl` is known,
   * regardless of whether every fee was resolved, since it simply never subtracts fees at all. */
  grossPL?: number | null;
  /** False only when at least one Schwab-sourced transaction behind this campaign has an
   * unresolved fee (see getCampaignIdsWithUnknownFees) - defaults to true (matching all
   * existing manual-entry behavior, where a blank fee has always meant an assumed $0) when the
   * caller doesn't know/pass this. */
  feesFullyKnown?: boolean;
};

const KNOWN_FINAL_RESULTS = new Set(["GAIN", "LOSS", "BREAKEVEN"]);

/**
 * A single completed campaign's outcome completeness - CONFIRMED (safe to count as a final
 * win/loss/breakeven), PENDING (the classification/number exist but a fee isn't resolved yet,
 * see CompletedCampaignResult.feesFullyKnown), or INCOMPLETE (no usable finalResult/pl at all).
 * Never NOT_APPLICABLE - every completed campaign has SOME outcome, even if unknown.
 */
function completedCampaignCompleteness(c: CompletedCampaignResult): Exclude<CompletenessStatus, "NOT_APPLICABLE"> {
  if (c.cashFlowsFullyKnown === false || !KNOWN_FINAL_RESULTS.has(c.finalResult) || c.pl === null || !Number.isFinite(c.pl)) {
    return "INCOMPLETE";
  }
  return c.feesFullyKnown === false ? "PENDING" : "CONFIRMED";
}

export type WinLossSummary = {
  completedCount: number;
  /** Campaigns with a fully final outcome - a known GAIN/LOSS/BREAKEVEN AND fees resolved (or
   * not Schwab-sourced, where a blank fee has always meant an assumed $0). `wins`/`losses`/
   * `breakevens`/`winRate`/`averageWin`/`averageLoss` are computed over this set ONLY - a
   * provisional or incomplete campaign can never silently inflate a confirmed win rate. */
  confirmedCount: number;
  /** Known GAIN/LOSS/BREAKEVEN, but at least one linked Schwab fee is still unresolved - a real
   * number exists (never a fabricated zero) but isn't final. Excluded from `wins`/`losses`/
   * `winRate` on purpose; see `pendingRealizedTradingPL` for their best-known combined P/L. */
  pendingCount: number;
  /** No usable finalResult/pl at all (required evidence missing/unsupported) - see
   * `completedCampaignCompleteness`. */
  unknownResults: number;
  /** CONFIRMED-only win/loss/breakeven counts and rate - never includes a PENDING outcome. */
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  averageDurationDays: number | null;
  /** Sum of `pl` over CONFIRMED campaigns only - the number a "confirmed realized profit"
   * headline should show. */
  confirmedRealizedTradingPL: number;
  /** Sum of `pl` over CONFIRMED + PENDING campaigns (their best-known values, never a fabricated
   * zero for the pending ones) - kept for continuity with existing callers that already present
   * this alongside `realizedTradingPLExact`. Prefer `confirmedRealizedTradingPL` for a headline
   * that must never claim more certainty than its inputs. */
  realizedTradingPL: number;
  /** False when at least one campaign counted into `realizedTradingPL` has an unresolved
   * Schwab fee (see `CompletedCampaignResult.feesFullyKnown`) - callers must present
   * `realizedTradingPL` as "pending"/not-yet-exact rather than a final confirmed number in that
   * case, the same honesty rule `summarizeThisWeek`'s `netPLExact` already enforces. */
  realizedTradingPLExact: boolean;
};

/**
 * Only CLOSED campaigns with a known final result count toward win/loss, and only CONFIRMED ones
 * (see `completedCampaignCompleteness`) count toward the confirmed win/loss/rate figures - an
 * OPEN campaign's current net cash flow (e.g. +$57 after a roll) is never a "win" until it
 * actually closes, and a completed campaign with an unresolved Schwab fee is never presented as
 * a settled win/loss until that fee resolves. See src/domain/finance/campaigns.ts
 * summarizeCampaign for how a campaign's status/finalResult is derived event-by-event.
 */
export function summarizeWinLoss(completed: CompletedCampaignResult[]): WinLossSummary {
  const byCompleteness = new Map<Exclude<CompletenessStatus, "NOT_APPLICABLE">, CompletedCampaignResult[]>([
    ["CONFIRMED", []],
    ["PENDING", []],
    ["INCOMPLETE", []],
  ]);
  for (const c of completed) {
    byCompleteness.get(completedCampaignCompleteness(c))!.push(c);
  }
  const confirmed = byCompleteness.get("CONFIRMED")!;
  const pending = byCompleteness.get("PENDING")!;
  const confirmedAndPending = [...confirmed, ...pending];

  const wins = confirmed.filter((c) => c.finalResult === "GAIN");
  const losses = confirmed.filter((c) => c.finalResult === "LOSS");
  const breakevens = confirmed.filter((c) => c.finalResult === "BREAKEVEN");
  const durations = completed.map((c) => c.daysActive).filter((d): d is number => d !== null);

  return {
    completedCount: completed.length,
    confirmedCount: confirmed.length,
    pendingCount: pending.length,
    unknownResults: byCompleteness.get("INCOMPLETE")!.length,
    wins: wins.length,
    losses: losses.length,
    breakevens: breakevens.length,
    winRate: confirmed.length ? round((wins.length / confirmed.length) * 100, 1) : null,
    averageWin: wins.length ? round(wins.reduce((sum, c) => sum + (c.pl ?? 0), 0) / wins.length, 2) : null,
    averageLoss: losses.length ? round(losses.reduce((sum, c) => sum + (c.pl ?? 0), 0) / losses.length, 2) : null,
    averageDurationDays: durations.length ? round(durations.reduce((a, b) => a + b, 0) / durations.length, 1) : null,
    confirmedRealizedTradingPL: round(
      confirmed.reduce((sum, c) => sum + (c.pl ?? 0), 0),
      2,
    ),
    realizedTradingPL: round(
      confirmedAndPending.reduce((sum, c) => sum + (c.pl ?? 0), 0),
      2,
    ),
    realizedTradingPLExact: pending.length === 0 && byCompleteness.get("INCOMPLETE")!.length === 0,
  };
}

export type ThisWeekSummary = {
  completedCount: number;
  /** Campaigns closed this week with a fully final outcome (known result, fees resolved) - see
   * `completedCampaignCompleteness`. `wins`/`losses`/`breakevens` count CONFIRMED only. */
  confirmedCount: number;
  /** Known result, but at least one fee is still unresolved - contributes to `grossPL`/`netPL`
   * (never a fabricated zero) but not to `wins`/`losses`/`confirmedCount`. */
  pendingCount: number;
  wins: number;
  losses: number;
  breakevens: number;
  /** Fee-exclusive gross P/L - always exact whenever any campaign closed this week is known. */
  grossPL: number | null;
  /** Fee-inclusive net P/L - only meaningful to present as a final number when `netPLExact`. */
  netPL: number | null;
  /** False when at least one campaign closed this week has an unresolved Schwab fee - callers
   * must show `netPL` as "pending"/not-yet-exact rather than a confirmed number in that case,
   * per the product rule that an unknown fee must never silently become a fake $0. */
  netPLExact: boolean;
  /** Gross-basis return - always exact whenever gross P/L and secured capital are both known. */
  grossReturnOnSecuredCapitalPercent: number | null;
  /** Net-basis return - only non-null when `netPLExact` is true; never a rounded-off guess. */
  returnOnSecuredCapitalPercent: number | null;
};

/**
 * "How did I do this week?" - the compact Tracker/Performance answer, distinct from
 * summarizeWeeklyReturns' fixed-account-baseline trend line below: this buckets only
 * campaigns that CLOSED in the current ISO week and returns their P/L against the actual
 * capital those specific campaigns secured, not the whole account. Never invents a value, and
 * never lets an unresolved fee masquerade as a confirmed net figure - see `netPLExact`. A
 * PENDING campaign (known result, unresolved fee) contributes to `grossPL`/`netPL` but never to
 * `wins`/`losses`/`confirmedCount`, matching `summarizeWinLoss`'s stricter confirmed denominator.
 */
export function summarizeThisWeek(completed: CompletedCampaignResult[], asOf: Date = new Date()): ThisWeekSummary {
  const currentWeekKey = isoWeekKey(asOf);
  const thisWeek = completed.filter((c) => isoWeekKey(c.closedAt) === currentWeekKey);
  const known = thisWeek.filter((c) => completedCampaignCompleteness(c) !== "INCOMPLETE");
  const confirmed = known.filter((c) => c.feesFullyKnown !== false);
  const pending = known.filter((c) => c.feesFullyKnown === false);
  const wins = confirmed.filter((c) => c.finalResult === "GAIN").length;
  const losses = confirmed.filter((c) => c.finalResult === "LOSS").length;
  const breakevens = confirmed.filter((c) => c.finalResult === "BREAKEVEN").length;
  const netPLExact = pending.length === 0 && known.length === thisWeek.length;
  const grossPL = known.length ? round(known.reduce((sum, c) => sum + (c.grossPL ?? c.pl ?? 0), 0), 2) : null;
  const netPL = known.length ? round(known.reduce((sum, c) => sum + (c.pl ?? 0), 0), 2) : null;
  const securedCapitalTotal = known.reduce((sum, c) => sum + (c.collateralCommitted ?? 0), 0);

  return {
    completedCount: thisWeek.length,
    confirmedCount: confirmed.length,
    pendingCount: pending.length,
    wins,
    losses,
    breakevens,
    grossPL,
    netPL,
    netPLExact,
    grossReturnOnSecuredCapitalPercent: grossPL !== null && securedCapitalTotal > 0 ? round((grossPL / securedCapitalTotal) * 100, 2) : null,
    returnOnSecuredCapitalPercent:
      netPLExact && netPL !== null && securedCapitalTotal > 0 ? round((netPL / securedCapitalTotal) * 100, 2) : null,
  };
}

export type WeeklyReturnSummary = {
  status: "OK" | "INSUFFICIENT_HISTORY";
  completeness: CompletenessStatus;
  excludedCount: number;
  targetPercent: number;
  thisWeekPercent: number | null;
  trailing4WeekAveragePercent: number | null;
  weeksAtOrAboveTarget: number | null;
  totalWeeksTracked: number | null;
};

export type CampaignProgressSummary = {
  netPremiumCollected: number;
  netPremiumStatus: CompletenessStatus;
  realizedPL: number | null;
  realizedPLStatus: CompletenessStatus;
  currentPL: number | null;
  /** CLOSED uses realized completeness. ASSIGNED is INCOMPLETE until shares can be valued.
   * OPEN requires complete put/cash-flow evidence, known fees, and a usable close mark. */
  currentPLStatus: CompletenessStatus;
  currentCostToClose: number | null;
  projectedOtmPL: number | null;
  /** Completeness of `projectedOtmPL` specifically (the CSP-only "if OTM" projection) - see
   * `CompletenessStatus`. NOT_APPLICABLE for CLOSED/ASSIGNED campaigns and for an OPEN campaign
   * with no current put position; INCOMPLETE when a put is intended but its evidence is
   * incomplete (see getOpenPutEvidenceState) or campaign cash flow has an unresolved unknown. */
  projectedOtmStatus: CompletenessStatus;
  /** Structural eligibility only: a complete open put and no held shares. Cash-flow or fee
   * completeness still requires projectedOtmStatus; this boolean cannot replace it. */
  projectedOtmApplicable: boolean;
  rollCount: number;
  collateralCommitted: number | null;
  daysActive: number | null;
  currentReturnPercent: number | null;
  projectedReturnPercent: number | null;
  requiredReturnPercent: number | null;
};

export type ContributionAdjustedGoalSummary = {
  status: "OK" | "NO_STARTING_VALUE";
  targetWeeklyPercent: number;
  startingCapital: number | null;
  currentValue: number | null;
  netContributions: number;
  tradingPLNow: number | null;
  projectedOtmPL: number | null;
  targetProfit: number | null;
  actualWeeklyPacePercent: number | null;
  projectedWeeklyPacePercent: number | null;
  percentOfTarget: number | null;
  projectedPercentOfTarget: number | null;
  aheadBehindDollars: number | null;
};

export type GoalLedgerEntryInput = {
  type: "STARTING_VALUE" | "DEPOSIT" | "WITHDRAWAL" | "MANUAL_ADJUSTMENT" | "BROKER_SNAPSHOT" | "NOTE";
  occurredAt: Date | string;
  amount?: unknown;
};

type AccountGoalInput = {
  ledgerEntries: GoalLedgerEntryInput[];
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * projectedOtmStatus: completeness of the CSP-only "if OTM" projection specifically. NOT_APPLICABLE
 * for anything but an OPEN campaign with a real (or evidence-incomplete) put and zero held shares;
 * INCOMPLETE when a put is intended but its own evidence is incomplete (getOpenPutEvidenceState)
 * or campaign cash flow has an unresolved unknown; unresolved fees are PENDING. The projection
 * needs no external price mark.
 */
function campaignProjectedOtmStatus({
  status,
  openPutEvidenceState,
  sharesHeld,
  hasUnknownCashFlow,
  feesFullyKnown,
}: {
  status: CampaignStatusInput;
  openPutEvidenceState: OpenPutEvidenceState;
  sharesHeld: number;
  hasUnknownCashFlow: boolean;
  feesFullyKnown: boolean;
}): CompletenessStatus {
  if (status !== "OPEN" || openPutEvidenceState === "NONE") {
    return "NOT_APPLICABLE";
  }
  if (openPutEvidenceState === "INCOMPLETE") {
    return "INCOMPLETE";
  }
  if (sharesHeld !== 0) {
    return "NOT_APPLICABLE";
  }
  return hasUnknownCashFlow ? "INCOMPLETE" : feesFullyKnown ? "CONFIRMED" : "PENDING";
}

/**
 * currentPLStatus: completeness of currentPL (and, for CLOSED, realizedPL). ASSIGNED is
 * deliberately INCOMPLETE, not NOT_APPLICABLE - real economic exposure (held shares, possibly a
 * covered call) exists but no valuation engine values it yet (out of scope for this ticket), and
 * a completeness summary must disclose that coverage gap rather than imply there's nothing to
 * value. OPEN with a real put but no live cost-to-close mark is PENDING (the leg's own evidence
 * is complete; only an external mark is missing).
 */
function campaignCurrentPLStatus({
  status,
  openPutEvidenceState,
  sharesHeld,
  hasUnknownCashFlow,
  feesFullyKnown,
  hasCostToClose,
}: {
  status: CampaignStatusInput;
  openPutEvidenceState: OpenPutEvidenceState;
  sharesHeld: number;
  hasUnknownCashFlow: boolean;
  feesFullyKnown: boolean;
  hasCostToClose: boolean;
}): CompletenessStatus {
  if (status === "CLOSED") {
    if (hasUnknownCashFlow) return "INCOMPLETE";
    return feesFullyKnown ? "CONFIRMED" : "PENDING";
  }
  if (status === "ASSIGNED") {
    return "INCOMPLETE";
  }
  // status === "OPEN"
  if (openPutEvidenceState === "NONE") {
    return "NOT_APPLICABLE";
  }
  if (openPutEvidenceState === "INCOMPLETE") {
    return "INCOMPLETE";
  }
  if (sharesHeld !== 0) {
    return "NOT_APPLICABLE";
  }
  if (hasUnknownCashFlow) {
    return "INCOMPLETE";
  }
  return hasCostToClose && feesFullyKnown ? "CONFIRMED" : "PENDING";
}

/**
 * Campaign progress deliberately keeps the user's three concepts separate:
 * completed/realized P/L, current mark-to-market P/L, and the CSP-only "if the
 * remaining short put expires OTM" projection. Premium collected is useful, but
 * open premium is never labeled as realized profit here.
 */
export function summarizeCampaignProgress({
  status,
  events,
  currentCostToClose = null,
  targetWeeklyPercent = 1,
  feesFullyKnown = true,
  asOf = new Date(),
}: {
  status: CampaignStatusInput;
  events: CampaignEventInput[];
  currentCostToClose?: number | null;
  targetWeeklyPercent?: number;
  /** False when a linked Schwab transaction behind this campaign has an unresolved fee (see
   * getCampaignIdsWithUnknownFees) - defaults to true, matching the existing manual-entry
   * convention (a blank fee has always meant an assumed $0). Applies to every affected metric;
   * known numeric estimates are preserved as provisional, never confirmed. */
  feesFullyKnown?: boolean;
  asOf?: Date;
}): CampaignProgressSummary {
  const summary = summarizeCampaign({ status, events, asOf });
  const openShortPut = findOpenShortPut(status, events);
  const openPutEvidenceState: OpenPutEvidenceState = status === "OPEN" ? getOpenPutEvidenceState(events) : "NONE";
  const hasUnknownCashFlow = summary.unknowns.length > 0;
  const realizedPL = status === "CLOSED" && !hasUnknownCashFlow ? (summary.totalCampaignPL ?? summary.realizedPL) : null;
  const projectedOtmApplicable = status === "OPEN" && openShortPut !== null && summary.sharesHeld === 0;
  const projectedOtmPL = projectedOtmApplicable && !hasUnknownCashFlow ? summary.netOptionPremium : null;
  const normalizedCostToClose = currentCostToClose !== null && Number.isFinite(currentCostToClose) && currentCostToClose >= 0
    ? round(currentCostToClose, 2) : null;
  const currentPL =
    status === "CLOSED"
      ? realizedPL
      : projectedOtmApplicable && normalizedCostToClose !== null && !hasUnknownCashFlow
        ? round(summary.netOptionPremium - normalizedCostToClose, 2)
        : null;
  const collateralCommitted = summary.collateralCommitted;
  const currentReturnPercent = returnPercent(currentPL, collateralCommitted);
  const projectedReturnPercent = returnPercent(projectedOtmPL, collateralCommitted);
  const requiredReturnPercent =
    summary.daysActive === null ? null : round((Math.max(1, summary.daysActive) / 7) * targetWeeklyPercent, 2);

  return {
    netPremiumCollected: summary.netOptionPremium,
    netPremiumStatus: hasUnknownCashFlow ? "INCOMPLETE" : feesFullyKnown ? "CONFIRMED" : "PENDING",
    realizedPL,
    realizedPLStatus: status !== "CLOSED" ? "NOT_APPLICABLE" : hasUnknownCashFlow ? "INCOMPLETE" : feesFullyKnown ? "CONFIRMED" : "PENDING",
    currentPL,
    currentPLStatus: campaignCurrentPLStatus({
      status,
      openPutEvidenceState,
      sharesHeld: summary.sharesHeld,
      hasUnknownCashFlow,
      feesFullyKnown,
      hasCostToClose: normalizedCostToClose !== null,
    }),
    currentCostToClose: normalizedCostToClose,
    projectedOtmPL,
    projectedOtmStatus: campaignProjectedOtmStatus({ status, openPutEvidenceState, sharesHeld: summary.sharesHeld, hasUnknownCashFlow, feesFullyKnown }),
    projectedOtmApplicable,
    rollCount: countRolls(events),
    collateralCommitted,
    daysActive: summary.daysActive,
    currentReturnPercent,
    projectedReturnPercent,
    requiredReturnPercent,
  };
}

export type PerformanceMetric = { value: number | null; status: CompletenessStatus };

export function summarizePerformanceMetrics(rows: {
  status: CampaignStatusInput;
  progress: CampaignProgressSummary;
  freshness?: "CURRENT_SESSION" | "LAST_SESSION";
}[]) {
  const aggregate = (metrics: PerformanceMetric[]): PerformanceMetric => {
    const applicable = metrics.filter((m) => m.status !== "NOT_APPLICABLE");
    const known = applicable.filter((m) => m.value !== null && m.status !== "INCOMPLETE");
    const status: CompletenessStatus = !applicable.length ? "NOT_APPLICABLE"
      : applicable.some((m) => m.status === "INCOMPLETE") ? "INCOMPLETE"
      : applicable.some((m) => m.status === "PENDING" || m.value === null) ? "PENDING" : "CONFIRMED";
    return { value: known.length ? round(known.reduce((sum, m) => sum + m.value!, 0), 2) : null, status };
  };
  return {
    current: aggregate(rows.map(({ progress: p }) => ({ value: p.currentPL, status: p.currentPLStatus }))),
    projected: aggregate(rows.map(({ status, progress: p }) => status === "CLOSED"
      ? { value: p.realizedPL, status: p.realizedPLStatus }
      : { value: p.projectedOtmPL, status: p.projectedOtmStatus })),
    lastSessionCount: rows.filter((r) => r.progress.currentPL !== null && r.freshness === "LAST_SESSION").length,
  };
}

/** Shared normal-row presentation; incomplete evidence is never rendered as N/A. */
export function performanceMetricText(value: number | null, status: CompletenessStatus, format: (value: number) => string) {
  if (status === "NOT_APPLICABLE") return "N/A";
  if (value === null) return status === "PENDING" ? "Unavailable - pending" : "Unavailable - incomplete";
  return `${format(value)}${status === "PENDING" ? " - pending" : status === "INCOMPLETE" ? " - partial" : ""}`;
}

export function tradingProfitFromAccountValue({
  currentValue,
  startingCapital,
  netContributions,
}: {
  currentValue: number | null;
  startingCapital: number | null;
  netContributions: number;
}) {
  if (currentValue === null || startingCapital === null) {
    return null;
  }

  return round(currentValue - startingCapital - netContributions, 2);
}

/**
 * Contribution-adjusted 1% target path. For each dated cash-flow segment, apply the
 * weekly target to the capital actually in the account during that segment. Deposits
 * and withdrawals change the future target base, but never become trading return.
 */
export function summarizeContributionAdjustedGoal({
  accounts,
  currentValue,
  actualPL,
  projectedOtmPL,
  targetWeeklyPercent,
  asOf = new Date(),
}: {
  accounts: AccountGoalInput[];
  currentValue: number | null;
  actualPL?: number | null;
  projectedOtmPL: number | null;
  targetWeeklyPercent: number;
  asOf?: Date;
}): ContributionAdjustedGoalSummary {
  const ledgerSummary = summarizeGoalLedgers(accounts, asOf);
  const tradingPLNow =
    actualPL ??
    tradingProfitFromAccountValue({
      currentValue,
      startingCapital: ledgerSummary.startingCapital,
      netContributions: ledgerSummary.netContributions,
    });
  const targetProfit =
    ledgerSummary.startingCapital === null ? null : round(ledgerSummary.capitalWeekExposure * (targetWeeklyPercent / 100), 2);
  const actualWeeklyPacePercent =
    tradingPLNow === null || ledgerSummary.capitalWeekExposure <= 0
      ? null
      : round((tradingPLNow / ledgerSummary.capitalWeekExposure) * 100, 2);
  const projectedWeeklyPacePercent =
    projectedOtmPL === null || ledgerSummary.capitalWeekExposure <= 0
      ? null
      : round((projectedOtmPL / ledgerSummary.capitalWeekExposure) * 100, 2);

  return {
    status: ledgerSummary.startingCapital === null ? "NO_STARTING_VALUE" : "OK",
    targetWeeklyPercent,
    startingCapital: ledgerSummary.startingCapital,
    currentValue,
    netContributions: ledgerSummary.netContributions,
    tradingPLNow,
    projectedOtmPL,
    targetProfit,
    actualWeeklyPacePercent,
    projectedWeeklyPacePercent,
    percentOfTarget: percentOfTarget(tradingPLNow, targetProfit),
    projectedPercentOfTarget: percentOfTarget(projectedOtmPL, targetProfit),
    aheadBehindDollars: tradingPLNow === null || targetProfit === null ? null : round(tradingPLNow - targetProfit, 2),
  };
}

/**
 * METHODOLOGY (documented deliberately, see PROJECT_HANDOFF.md "Performance / 1% target"):
 * this buckets completed campaigns' realized P/L by the ISO week they closed in, and
 * divides each week's P/L by a single fixed `baseline` (the account's current
 * ledger-derived value). This is a simple realized-return-per-week metric, NOT a
 * time-weighted or money-weighted rate of return - it does not adjust for deposits or
 * withdrawals that happened mid-period, and using one fixed baseline for every week
 * understates return in early weeks (when the account was smaller) and overstates it in
 * later weeks after growth. It is intentionally the simplest mathematically defensible
 * choice for this slice rather than a fabricated precision the app cannot back up. A
 * proper time-weighted return is future work once enough dated history exists to make
 * one meaningful.
 */
export function summarizeWeeklyReturns(
  completed: { closedAt: Date; pl: number | null; feesFullyKnown?: boolean; cashFlowsFullyKnown?: boolean }[],
  baseline: number | null,
  targetPercent: number,
  asOf: Date = new Date(),
): WeeklyReturnSummary {
  const known = completed.filter((c): c is typeof c & { pl: number } =>
    c.pl !== null && Number.isFinite(c.pl) && c.feesFullyKnown !== false && c.cashFlowsFullyKnown !== false);
  const excludedCount = completed.length - known.length;
  const completeness: CompletenessStatus = completed.some((c) => c.pl === null || !Number.isFinite(c.pl) || c.cashFlowsFullyKnown === false)
    ? "INCOMPLETE" : excludedCount ? "PENDING" : "CONFIRMED";

  if (baseline === null || baseline <= 0 || known.length === 0) {
    return {
      status: "INSUFFICIENT_HISTORY",
      completeness, excludedCount,
      targetPercent,
      thisWeekPercent: null,
      trailing4WeekAveragePercent: null,
      weeksAtOrAboveTarget: null,
      totalWeeksTracked: null,
    };
  }

  const byWeek = new Map<string, number>();
  for (const entry of known) {
    const key = isoWeekKey(entry.closedAt);
    byWeek.set(key, (byWeek.get(key) ?? 0) + entry.pl);
  }

  const currentWeekKey = isoWeekKey(asOf);
  const weekEntries = [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const percentByWeek = weekEntries.map(([key, pl]) => [key, round((pl / baseline) * 100, 2)] as const);
  const thisWeekPercent = percentByWeek.find(([key]) => key === currentWeekKey)?.[1] ?? 0;
  const priorWeeks = percentByWeek.filter(([key]) => key !== currentWeekKey);
  const last4Prior = priorWeeks.slice(-4);

  return {
    status: "OK",
    completeness, excludedCount,
    targetPercent,
    thisWeekPercent,
    trailing4WeekAveragePercent: last4Prior.length
      ? round(last4Prior.reduce((sum, [, pct]) => sum + pct, 0) / last4Prior.length, 2)
      : null,
    weeksAtOrAboveTarget: percentByWeek.filter(([, pct]) => pct >= targetPercent).length,
    totalWeeksTracked: percentByWeek.length,
  };
}

function isoWeekKey(date: Date): string {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = (utc.getUTCDay() + 6) % 7; // Monday = 0
  utc.setUTCDate(utc.getUTCDate() - dayNumber + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(utc.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((utc.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * The campaign's currently-open short put, or null - delegates entirely to getCurrentOpenPut
 * (campaigns.ts), the single authoritative "what put is open right now" definition also used by
 * the Dashboard and Tracker. Performance previously carried its own private copy of this
 * ordering/validity logic (a local findOpenShortPut + compareEvents), which lacked
 * getCurrentOpenPut's deterministic createdAt/id tiebreak - so a roll's ROLL_PUT_CLOSE/
 * ROLL_PUT_OPEN pair tied on (occurredAt, sortOrder) could resolve to a different "current"
 * leg here than on the Dashboard/Tracker, purely depending on the caller's array order, even
 * though nothing about the actual trade history changed. See PROJECT_HANDOFF.md for the
 * reproduced example (Current P/L $42 / Projected P/L $72 in one ordering, unavailable in
 * another) this fixes. Performance must never fabricate a valid leg getCurrentOpenPut itself
 * would decline (e.g. a legacy event missing strike/contracts/expiration) - it has exactly one
 * opinion on that question now, not two.
 */
function findOpenShortPut(status: CampaignStatusInput, events: CampaignEventInput[]) {
  return status === "OPEN" ? getCurrentOpenPut(events) : null;
}

function countRolls(events: CampaignEventInput[]) {
  const grouped = new Set<string>();
  let ungroupedCloseCount = 0;
  for (const event of events) {
    if (event.type !== "ROLL_PUT_CLOSE" && event.type !== "ROLL_PUT_OPEN") {
      continue;
    }
    if (event.groupKey) {
      grouped.add(event.groupKey);
      continue;
    }
    if (event.type === "ROLL_PUT_CLOSE") {
      ungroupedCloseCount += 1;
    }
  }
  return grouped.size + ungroupedCloseCount;
}

function summarizeGoalLedgers(accounts: AccountGoalInput[], asOf: Date) {
  const events = accounts.flatMap((account) =>
    account.ledgerEntries
      .filter((entry) => entry.type === "STARTING_VALUE" || entry.type === "DEPOSIT" || entry.type === "WITHDRAWAL" || entry.type === "MANUAL_ADJUSTMENT")
      .map((entry) => ({
        type: entry.type,
        occurredAt: toDate(entry.occurredAt),
        amount: numeric(entry.amount),
      })),
  );
  const orderedEvents = events
    .filter((event) => event.amount !== null && event.occurredAt <= asOf)
    .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
  const starts = orderedEvents.filter((event) => event.type === "STARTING_VALUE" && event.amount !== null);
  if (starts.length === 0) {
    return { startingCapital: null, netContributions: 0, capitalWeekExposure: 0 };
  }

  const startingCapital = round(starts.reduce((sum, event) => sum + (event.amount ?? 0), 0), 2);
  const startDate = starts[0]!.occurredAt;

  let capitalBase = 0;
  let netContributions = 0;
  let cursor = startDate;
  let exposure = 0;

  for (const event of orderedEvents) {
    if (event.occurredAt < startDate || event.occurredAt > asOf) {
      continue;
    }
    exposure += capitalBase * weeksBetween(cursor, event.occurredAt);

    if (event.type === "STARTING_VALUE") {
      capitalBase += event.amount ?? 0;
    }
    if (event.type === "DEPOSIT" || event.type === "MANUAL_ADJUSTMENT") {
      capitalBase += event.amount ?? 0;
      netContributions += event.amount ?? 0;
    }
    if (event.type === "WITHDRAWAL") {
      capitalBase -= event.amount ?? 0;
      netContributions -= event.amount ?? 0;
    }

    cursor = event.occurredAt;
  }

  if (asOf > cursor) {
    exposure += capitalBase * weeksBetween(cursor, asOf);
  }

  return {
    startingCapital,
    netContributions: round(netContributions, 2),
    capitalWeekExposure: round(Math.max(0, exposure), 2),
  };
}

function percentOfTarget(value: number | null, target: number | null) {
  if (value === null || target === null || target <= 0) {
    return null;
  }

  return round((value / target) * 100, 1);
}

function returnPercent(value: number | null, basis: number | null) {
  if (value === null || basis === null || basis <= 0) {
    return null;
  }

  return round((value / basis) * 100, 2);
}

function weeksBetween(start: Date, end: Date) {
  return Math.max(0, (end.getTime() - start.getTime()) / MS_PER_DAY / 7);
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const candidate = value as { toNumber?: () => number; toString?: () => string };
  if (typeof candidate.toNumber === "function") {
    const parsed = candidate.toNumber();
    return Number.isFinite(parsed) ? parsed : null;
  }

  const parsed = Number(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function toDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}
