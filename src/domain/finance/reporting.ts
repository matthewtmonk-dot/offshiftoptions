import { round } from "./calculations";
import {
  summarizeAccountPerformance,
  summarizeAccountsPerformance,
  type AccountPerformanceInput,
  type AccountPerformanceSummary,
  type FundingCoverageStatus,
} from "./accountLedger";
import { summarizeThisWeek, summarizeWinLoss, type CompletedCampaignResult, type ThisWeekSummary } from "./performance";
import { summarizeCampaignExposure, type CampaignExposureInput } from "./brokerPositions";

/**
 * Reporting Phase, Ticket 1 (plus an Astra corrective patch): the ONE authoritative
 * reporting-domain summary Dashboard/Tracker/Account UI should consume, so financial formulas and
 * evidence-status interpretation live in exactly one place instead of being reinvented per page
 * (see PROJECT_HANDOFF.md's read-only design pass for the full product rationale). This module
 * never fetches data and never scopes by owner itself - like every other finance-domain function,
 * it trusts the caller to have already scoped `accounts`/`completedCampaigns`/`openExposure` to
 * one viewer's own data (never mixing two users' records into a single call) before this function
 * is invoked.
 *
 * It deliberately keeps four concepts separate and never blends them into one percentage:
 * 1. Account Value (Section 1) - what the account is worth right now, independent of whether gain
 *    can be computed.
 * 2. Confirmed Trading P/L + Trade Return (Sections 2-3) - how the trades themselves performed on
 *    the capital they actually required, excluding idle cash.
 * 3. Current Capital Utilization (Section 4) - how much of the account is actively committed
 *    right now, as of this instant only (no average/historical utilization - explicitly deferred).
 * 4. Whole-Account Gain/Return (Sections 5-6) - how much the entire account grew, gated by the
 *    already-approved baseline/funding evidence rules this module never reimplements.
 *
 * This ticket does NOT implement: benchmark/opportunity-cost, TWR/XIRR, average/historical capital
 * utilization, a capital-time-exposure engine, or a new 1% weekly trade-return goal - see the
 * design-pass report for why each is deferred and what it depends on.
 */

/** Astra corrective patch's FundingCoverageStatus, narrowed to only the values that can ever
 * explain a null wholeAccountGain (COMPLETE never does, by construction - see
 * wholeAccountGainReasonFor below). */
export type WholeAccountGainUnavailableReason =
  | "NO_BASELINE"
  | "NO_CURRENT_VALUE"
  | "INCOMPLETE_MIXED_SOURCES"
  | "INCOMPLETE_INFERRED_BASELINE"
  | "INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY";

/**
 * Astra corrective patch (Issues 1 & 2): distinguishes every genuinely different reason "Return on
 * campaigns closed this week" can be unavailable, so none of them is ever mislabeled as another.
 * - NO_CLOSED_CAMPAIGNS: nothing closed in the current week at all.
 * - INCOMPLETE_RESULT_EVIDENCE: at least one campaign closed this week has no usable result at all
 *   (see `completedCampaignCompleteness`'s INCOMPLETE case) - a fundamentally different problem
 *   from an unresolved fee, and must never be described as a fee issue (Issue 2's exact finding).
 * - INCOMPLETE_CAPITAL_EVIDENCE: every closed-this-week campaign has a known result, but at least
 *   one is missing `collateralCommitted` - the denominator itself can't be trusted (Issue 1).
 * - NO_SECURED_CAPITAL: every contributing campaign's collateral is genuinely known, but it sums
 *   to zero (or less) - there is nothing to divide by, distinct from "unknown."
 * - PENDING_FEE_EVIDENCE: results and collateral are both fully known; only a fee is still
 *   unresolved - the one case that IS genuinely about fees.
 */
export type TradeReturnStatus =
  | "OK"
  | "NO_CLOSED_CAMPAIGNS"
  | "INCOMPLETE_RESULT_EVIDENCE"
  | "INCOMPLETE_CAPITAL_EVIDENCE"
  | "PENDING_FEE_EVIDENCE"
  | "NO_SECURED_CAPITAL";

/**
 * Astra corrective patch (Issue 3): UNKNOWN_EXPOSURE is distinct from a legitimate, fully-known 0%
 * - summarizeCampaignExposure can report `openCampaignsWithUnknownCollateral > 0` or an ASSIGNED
 * campaign with an unknown cost basis, in which case the committed-capital NUMERATOR is a floor,
 * not an exact total, and the percentage must never be presented as if it were complete.
 */
export type CapitalUtilizationStatus = "OK" | "NO_ACCOUNT_VALUE" | "UNKNOWN_EXPOSURE";

/**
 * Astra corrective patch (second pass): the three-state honesty model for a period boundary
 * (baseline start or ending valuation) that may be aggregated across multiple accounts.
 * - COMMON: every contributing account genuinely shares the same instant - safe to show as one
 *   date (e.g. "Since Aug 1").
 * - MIXED: contributing accounts have genuinely different instants - a single date must never be
 *   shown; a future UI should say something like "Accounts have different performance start
 *   dates" or use the exposed oldest/newest range ("Performance periods begin between Aug 1 and
 *   Sep 1").
 * - UNAVAILABLE: no contributing account has this instant at all (e.g. no baseline has ever been
 *   set), independent of whether it would otherwise be common or mixed.
 * This status is never itself UI copy - see friendlyReportingReason's pattern; a future ticket can
 * add MIXED/UNAVAILABLE entries there if page-specific prose is needed beyond the examples above.
 */
export type PeriodBoundStatus = "COMMON" | "MIXED" | "UNAVAILABLE";

/** Every internal status/reason code this module (or the accounting layer it wraps) can produce -
 * the only codes `friendlyReportingReason` accepts, so a typo or an unmapped future code is caught
 * at compile time rather than silently falling through to a generic message at runtime. */
export type ReportingReasonCode =
  | WholeAccountGainUnavailableReason
  | AccountPerformanceSummary["totalReturnStatus"]
  | TradeReturnStatus
  | CapitalUtilizationStatus;

/**
 * Section 7: the ONE centralized translation from internal financial status codes to concise,
 * non-technical, user-facing sentences - so five pages never independently invent (or
 * inconsistently phrase) copy for the same underlying evidence gap. Callers should always go
 * through `friendlyReportingReason` (or the pre-translated `*Message` fields this module already
 * computes) rather than switching on a raw code themselves. Astra corrective patch: a
 * fee-specific message is used ONLY for the genuinely fee-specific status - an incomplete result
 * or missing collateral each get their own truthful wording instead of being folded into it.
 */
const REPORTING_REASON_MESSAGES: Record<ReportingReasonCode, string> = {
  OK: "",
  NO_BASELINE: "Set a starting account value to measure account performance.",
  NO_CURRENT_VALUE: "An ending account value is not available for this period.",
  INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY: "Schwab funding history has not been fully verified for this period.",
  INCOMPLETE_MIXED_SOURCES: "Funding history needs review before account performance can be calculated.",
  INCOMPLETE_INFERRED_BASELINE:
    "A starting value hasn't been explicitly confirmed for this account, so this figure is an estimate and can't be shown as confirmed yet.",
  INCOMPLETE_FUNDING_EVIDENCE: "Funding history needs review before this figure can be confirmed.",
  CONTRIBUTIONS_NEED_ADVANCED_RETURN:
    "Percentage return is not available yet because money moved into or out of the account during this period.",
  NO_CLOSED_CAMPAIGNS: "No campaigns have closed yet this week.",
  INCOMPLETE_RESULT_EVIDENCE: "Some campaigns closed this week don't have a confirmed result yet.",
  INCOMPLETE_CAPITAL_EVIDENCE: "Some closed campaigns are missing the capital/collateral evidence needed to calculate a return.",
  NO_SECURED_CAPITAL: "No secured capital is recorded for the campaigns closed this week.",
  PENDING_FEE_EVIDENCE: "This week's trade return is pending until all fees are confirmed.",
  NO_ACCOUNT_VALUE: "An account value is needed to calculate capital utilization.",
  UNKNOWN_EXPOSURE: "Some current position exposure could not be verified.",
};

/**
 * Translates one internal status/reason code into its user-facing sentence, or `null` for "OK"
 * (nothing to explain) or a missing code. Never returns a raw enum name - see Section 7. This is
 * the only function future UI should call for evidence-gap copy; it must never reimplement this
 * mapping locally.
 */
export function friendlyReportingReason(code: ReportingReasonCode | null | undefined): string | null {
  if (!code || code === "OK") {
    return null;
  }
  return REPORTING_REASON_MESSAGES[code] || null;
}

export type AccountReportingInput = {
  /** One entry per account in scope - a single account for a per-account summary, or every
   * account owned by the viewer for a whole-portfolio summary. Passed straight through to
   * summarizeAccountPerformance/summarizeAccountsPerformance (accountLedger.ts), which this module
   * never reimplements. */
  accounts: AccountPerformanceInput[];
  /** Every campaign CLOSED within scope - not pre-filtered to a short window, since Confirmed
   * Trading P/L (Section 2) is deliberately an ALL_TIME figure; Trade Return (Section 3) narrows
   * to the current week internally. */
  completedCampaigns?: CompletedCampaignResult[];
  /** Every currently OPEN or ASSIGNED campaign's exposure facts in scope - passed straight through
   * to summarizeCampaignExposure (brokerPositions.ts). */
  openExposure?: CampaignExposureInput[];
  asOf?: Date;
};

export type AccountReportingSummary = {
  // ---- Section 1: Account Value ("What is my account worth right now?") ----
  /** The already-approved supported current-valuation path (accountLedger.ts) - a valid Schwab
   * BROKER_SNAPSHOT dated at/after the effective baseline. Never reconstructed from option
   * premium, campaign P/L, or funding events - see accountLedger.ts's own doc comments (the
   * baseline/funding corrective patches removed every such reconstruction fallback; there is no
   * "no trading activity" exception left). May be available even when wholeAccountGain is not
   * (e.g. an inferred baseline still yields a real current value, just not a confirmed gain). */
  currentAccountValue: number | null;
  /** Astra corrective patch (Issue 5): the single instant currentAccountValue reflects - ONLY when
   * every contributing account's snapshot genuinely shares that same instant. This is always true
   * for a single account. For a multi-account aggregate, it is null unless every account happened
   * to be snapshotted at the exact same instant - see currentAccountValueOldestSnapshotAsOf/
   * currentAccountValueNewestSnapshotAsOf for the honest range instead of a false common instant. */
  currentAccountValueAsOf: Date | null;
  /** The OLDEST contributing snapshot's `asOf` - for a single account this equals
   * currentAccountValueNewestSnapshotAsOf (and currentAccountValueAsOf). For a multi-account
   * aggregate whose accounts were snapshotted at different times, this is the earlier end of the
   * range - the point before which the combined total should NOT be trusted as of. */
  currentAccountValueOldestSnapshotAsOf: Date | null;
  /** The NEWEST contributing snapshot's `asOf` - see currentAccountValueOldestSnapshotAsOf. A
   * caller can present "values updated between X and Y" from this pair when they differ. */
  currentAccountValueNewestSnapshotAsOf: Date | null;
  currentAccountValueSource: AccountPerformanceSummary["currentValueSource"];

  // ---- Section 2: Confirmed Trading P/L ("How much confirmed trading profit/loss?") ----
  /** summarizeWinLoss's CONFIRMED-only realized P/L (confirmedRealizedTradingPL) - the one
   * authoritative "confirmed trading P/L" figure. Deliberately NOT accountLedger.ts's `tradingPL`
   * (a broader cash-flow figure that includes STILL-OPEN positions' option premium - useful for a
   * different question, "Trading Cash Flow," but not "confirmed profit"), NOT
   * summarizeWinLoss.realizedTradingPL (which blends in PENDING campaigns), and NOT any
   * open-position current/projected mark. Fee-inclusive, after known costs. Never null - a real
   * $0 when nothing has confirmed yet, matching summarizeWinLoss's own convention. */
  confirmedTradingPL: number;
  /** This figure has no artificial window - it is ALL_TIME confirmed realized P/L over whatever
   * completed campaigns were supplied, since summarizeWinLoss itself supports that broader total.
   * Astra corrective patch (Issue 4): see confirmedTradingPLBasis for wording explicit enough that
   * a future UI cannot mistake this for a "this week" figure. */
  confirmedTradingPLPeriod: "ALL_TIME";
  /** Fixed, human-readable description of exactly what ALL_TIME means here - every completed
   * campaign present in the supplied input, not bounded to any calendar period. */
  confirmedTradingPLBasis: string;
  /** False when at least one closed campaign in scope is PENDING (a known result with an
   * unresolved fee) or INCOMPLETE (no usable result at all) - confirmedTradingPL itself never
   * includes those, but callers should disclose that more evidence is still outstanding. */
  confirmedTradingPLComplete: boolean;
  confirmedTradingPLPendingCount: number;
  confirmedTradingPLIncompleteCount: number;

  // ---- Section 3: Trade Return ("How well did the trades perform on capital committed?") ----
  /**
   * "Return on campaigns closed this week" - summarizeThisWeek's fee-exact, capital-evidence-exact
   * return on secured capital (net basis). Astra corrective patch (label/semantics): this is the
   * LIFETIME realized result of every campaign that CLOSED during the current week, divided by
   * the capital those same campaigns secured - it does NOT mean "profit earned only during this
   * calendar week." A campaign open for a month that happens to close this week contributes its
   * FULL lifetime P/L, never a pro-rated slice. Null whenever fees aren't fully resolved (see
   * tradeReturnGrossPercent for the fee-pending fallback) OR whenever any contributing campaign's
   * committed capital is unknown (see tradeReturnStatus - Issue 1's fix) - an unknown-collateral
   * campaign is never silently treated as requiring $0 capital.
   */
  tradeReturnPercent: number | null;
  /** Gross-basis version of the same ratio - available even before every fee is confirmed, but
   * STILL withheld whenever capital evidence is incomplete (Issue 1) - a missing collateral value
   * corrupts both the gross and net ratio equally, since they share the same denominator. */
  tradeReturnGrossPercent: number | null;
  /** Reporting v1 exposes ONLY the one period the existing math is already proven safe for - see
   * the ticket's explicit instruction not to generalize to 4 weeks/all time yet. */
  tradeReturnPeriod: "THIS_WEEK";
  /** Astra corrective patch (Issue 4): the exact ISO 8601 calendar-week boundary (Monday 00:00:00
   * UTC through Sunday 23:59:59.999 UTC) summarizeThisWeek used to decide "this week" - the SAME
   * convention isoWeekKey has always used, exposed rather than left for a caller to guess or
   * re-derive. Deliberately UTC calendar days, NOT America/New_York - unrelated to the
   * baseline/funding module's own end-of-day convention (accountLedger.ts). */
  tradeReturnPeriodStartUtc: Date;
  tradeReturnPeriodEndUtc: Date;
  /** The exact instant evaluated (may be mid-week) - the same `asOf` passed to/defaulted by this
   * summary as a whole. */
  tradeReturnAsOf: Date;
  /** Fixed, human-readable description of the ratio - confirmed realized P/L for campaigns closed
   * this week, divided by the capital those campaigns secured, never idle cash. */
  tradeReturnBasis: string;
  tradeReturnStatus: TradeReturnStatus;
  tradeReturnMessage: string | null;

  // ---- Section 4: Current Capital Utilization ("How much of my account is at work right now?") ----
  /**
   * "LST capital committed" - cash secured by genuinely OPEN puts
   * (summarizeCampaignExposure's securedPutCollateral) plus assigned-but-unsold shares' cost basis
   * (assignedShareCapital) - both are real capital that is NOT idle cash, and
   * summarizeCampaignExposure already keeps them correctly distinct (an ASSIGNED campaign's stock
   * position is never misrepresented as an active CSP). Still populated (a KNOWN floor, never
   * fabricated) even when capitalUtilizationStatus is "UNKNOWN_EXPOSURE" - only null when there is
   * no valid account value to relate it to at all (capitalUtilizationStatus === "NO_ACCOUNT_VALUE").
   */
  currentCapitalCommitted: number | null;
  /** Breakdown of currentCapitalCommitted's two components, for a caller that wants to show them
   * separately rather than one collapsed figure. Always populated (never gated on account value),
   * since these are just summarizeCampaignExposure's own totals. */
  currentCapitalCommittedSecuredPut: number;
  currentCapitalCommittedAssignedShares: number;
  /**
   * User-facing label: "LST capital committed (% of account)". Astra corrective patch (Issue 3):
   * withheld entirely (null) whenever ANY current exposure is unknown - a known $0/partial
   * numerator must never imply a complete, trustworthy 0%. See capitalUtilizationStatus.
   */
  currentCapitalUtilizationPercent: number | null;
  capitalUtilizationStatus: CapitalUtilizationStatus;
  /** True when at least one open campaign's collateral or assigned campaign's cost basis is
   * unknown (see summarizeCampaignExposure's openCampaignsWithUnknownCollateral /
   * assignedCampaignsWithKnownBasis) - currentCapitalCommitted is then a FLOOR, not an exact
   * total, and capitalUtilizationStatus is "UNKNOWN_EXPOSURE" (never "OK") as a result. */
  capitalUtilizationHasUnknownExposure: boolean;
  capitalUtilizationMessage: string | null;

  // ---- Section 5: Whole-Account Gain ("How much has the whole account gained since baseline?") ----
  /** Passthrough of accountLedger.ts's totalGain - never reimplemented here. Available only when
   * the underlying accounting summary says funding coverage is COMPLETE and a supported ending
   * valuation exists; see wholeAccountGainUnavailableReason for why when null. */
  wholeAccountGain: number | null;
  wholeAccountGainStatus: "OK" | "UNAVAILABLE";
  wholeAccountGainUnavailableReason: WholeAccountGainUnavailableReason | null;
  wholeAccountGainUnavailableMessage: string | null;
  /** Astra corrective patch (Issue 4): whole-account gain has exactly one supported period - since
   * the account's effective baseline was set (or last corrected) through the ending valuation
   * actually used. This is not a rolling window and this ticket does not add one. */
  wholeAccountGainPeriod: "SINCE_BASELINE";
  /**
   * Astra corrective patch (second pass): the effective baseline's own `occurredAt` - but ONLY
   * when every contributing account genuinely shares that same instant. For a single account this
   * is always that account's own baseline date. For a multi-account aggregate whose accounts have
   * DIFFERENT baseline dates, this is null - it must never arbitrarily report one account's
   * baseline just because that account happened to be first in the input array (the exact defect
   * found: `[A, B]` reported A's Aug 1 baseline, `[B, A]` reported B's Sep 1 baseline, for the
   * identical $200 combined gain - the reported metadata must never depend on array order). See
   * wholeAccountGainPeriodStartStatus/wholeAccountGainOldestPeriodStart/NewestPeriodStart for the
   * honest picture when this is null.
   */
  wholeAccountGainPeriodStart: Date | null;
  /** "COMMON" when every contributing account's baseline start is the same instant (including the
   * trivial single-account case) - wholeAccountGainPeriodStart is populated. "MIXED" when
   * contributing accounts have genuinely different baseline starts - wholeAccountGainPeriodStart
   * is null; see the oldest/newest fields for the range. "UNAVAILABLE" when no contributing
   * account has any baseline at all. */
  wholeAccountGainPeriodStartStatus: PeriodBoundStatus;
  /** The EARLIEST baseline start among contributing accounts - null only when none has one at
   * all. Equals wholeAccountGainPeriodStart when the status is "COMMON". */
  wholeAccountGainOldestPeriodStart: Date | null;
  /** The LATEST baseline start among contributing accounts - see wholeAccountGainOldestPeriodStart. */
  wholeAccountGainNewestPeriodStart: Date | null;
  /** The ending valuation instant actually used for this measurement, when available - the same
   * value as currentAccountValueAsOf (null on a genuine multi-account timestamp spread; see that
   * field's own doc comment and currentAccountValueOldestSnapshotAsOf/NewestSnapshotAsOf - this
   * module does not reopen or duplicate that already-approved range, only points to it). */
  wholeAccountGainPeriodEnd: Date | null;
  /** Same three-state honesty as wholeAccountGainPeriodStartStatus, but for the ending valuation
   * instant - "MIXED" (not merely "UNAVAILABLE") when contributing accounts were snapshotted at
   * different times, so a caller can tell "we don't know" apart from "these disagree." The range
   * itself lives on currentAccountValueOldestSnapshotAsOf/NewestSnapshotAsOf (Section 1) - not
   * duplicated here. */
  wholeAccountGainPeriodEndStatus: PeriodBoundStatus;

  // ---- Section 6: Whole-Account Return % ----
  /** Passthrough of accountLedger.ts's totalReturnPercent/totalReturnStatus - no new return math.
   * Available only under the existing simple-return conditions (complete evidence, zero
   * contributions in the interval); a cash-flow-aware return remains explicitly future work. */
  wholeAccountReturnPercent: number | null;
  wholeAccountReturnStatus: AccountPerformanceSummary["totalReturnStatus"];
  wholeAccountReturnMessage: string | null;

  /** How many accounts contributed to this summary (1 for a per-account call, N for a portfolio
   * aggregate) - lets a caller distinguish "this is one account's figures" from "this is a
   * portfolio total" without re-deriving it from the input it already had. */
  accountCount: number;
  /** The underlying funding-coverage evidence code, preserved for an audit/detail view (e.g. the
   * Account page) that wants the specific reason, not just the friendly sentence. Never render
   * this directly as UI copy - see Section 7. */
  fundingCoverageStatus: FundingCoverageStatus | null;
};

/**
 * The one authoritative reporting-domain summary future Dashboard/Tracker/Account UI should
 * consume - see this module's top-of-file doc comment for the product rationale and what stays
 * deliberately out of scope for this ticket.
 */
export function summarizeAccountReporting(input: AccountReportingInput): AccountReportingSummary {
  const asOf = input.asOf ?? new Date();
  const completedCampaigns = input.completedCampaigns ?? [];
  const openExposure = input.openExposure ?? [];

  const accounting = input.accounts.length === 1 ? summarizeAccountPerformance(input.accounts[0]!) : summarizeAccountsPerformance(input.accounts);

  // Section 1
  const currentAccountValue = accounting.currentValue;
  const currentAccountValueSource = accounting.currentValueSource;
  const { oldest: currentAccountValueOldestSnapshotAsOf, newest: currentAccountValueNewestSnapshotAsOf } = accountValueSnapshotRange(
    input.accounts,
    accounting,
  );
  const currentAccountValueAsOf =
    currentAccountValueOldestSnapshotAsOf !== null &&
    currentAccountValueNewestSnapshotAsOf !== null &&
    currentAccountValueOldestSnapshotAsOf.getTime() === currentAccountValueNewestSnapshotAsOf.getTime()
      ? currentAccountValueOldestSnapshotAsOf
      : null;

  // Section 2
  const winLoss = summarizeWinLoss(completedCampaigns);
  const confirmedTradingPLComplete = winLoss.pendingCount === 0 && winLoss.unknownResults === 0;

  // Section 3
  const thisWeek = summarizeThisWeek(completedCampaigns, asOf);
  const tradeReturnStatus = tradeReturnStatusFor(thisWeek);

  // Section 4
  const exposure = summarizeCampaignExposure(openExposure);
  const currentCapitalCommittedTotal = round(exposure.securedPutCollateral + exposure.assignedShareCapital, 2);
  const capitalUtilizationHasUnknownExposure =
    exposure.openCampaignsWithUnknownCollateral > 0 || exposure.assignedCampaignCount > exposure.assignedCampaignsWithKnownBasis;
  const hasValidAccountValueForUtilization = currentAccountValue !== null && currentAccountValue > 0;
  const capitalUtilizationStatus: CapitalUtilizationStatus = !hasValidAccountValueForUtilization
    ? "NO_ACCOUNT_VALUE"
    : capitalUtilizationHasUnknownExposure
      ? "UNKNOWN_EXPOSURE"
      : "OK";
  const currentCapitalCommitted = hasValidAccountValueForUtilization ? currentCapitalCommittedTotal : null;
  const currentCapitalUtilizationPercent =
    capitalUtilizationStatus === "OK" ? round((currentCapitalCommittedTotal / currentAccountValue!) * 100, 2) : null;

  // Sections 5 & 6 - pure passthrough of the already-approved accounting summary.
  const wholeAccountGain = accounting.totalGain;
  const wholeAccountGainUnavailableReason = wholeAccountGain === null ? wholeAccountGainReasonFor(accounting) : null;

  // Astra corrective patch (second pass): the aggregate's own `startingCapitalAt` arbitrarily
  // picks the FIRST account's baseline date, which made the reported period start depend on input
  // array order for no financial reason - recompute the honest range ourselves instead of reusing
  // that field for a multi-account summary.
  const { oldest: wholeAccountGainOldestPeriodStart, newest: wholeAccountGainNewestPeriodStart } = wholeAccountGainPeriodStartRange(
    input.accounts,
    accounting,
  );
  const wholeAccountGainPeriodStart =
    wholeAccountGainOldestPeriodStart !== null &&
    wholeAccountGainNewestPeriodStart !== null &&
    wholeAccountGainOldestPeriodStart.getTime() === wholeAccountGainNewestPeriodStart.getTime()
      ? wholeAccountGainOldestPeriodStart
      : null;
  const wholeAccountGainPeriodStartStatus: PeriodBoundStatus =
    wholeAccountGainOldestPeriodStart === null && wholeAccountGainNewestPeriodStart === null
      ? "UNAVAILABLE"
      : wholeAccountGainPeriodStart !== null
        ? "COMMON"
        : "MIXED";
  // The ending side already has an honest range (Section 1's currentAccountValue*SnapshotAsOf) -
  // this only adds the missing three-state status so "null" can be told apart from "mixed."
  const wholeAccountGainPeriodEndStatus: PeriodBoundStatus =
    currentAccountValueOldestSnapshotAsOf === null && currentAccountValueNewestSnapshotAsOf === null
      ? "UNAVAILABLE"
      : currentAccountValueAsOf !== null
        ? "COMMON"
        : "MIXED";

  return {
    currentAccountValue,
    currentAccountValueAsOf,
    currentAccountValueOldestSnapshotAsOf,
    currentAccountValueNewestSnapshotAsOf,
    currentAccountValueSource,

    confirmedTradingPL: winLoss.confirmedRealizedTradingPL,
    confirmedTradingPLPeriod: "ALL_TIME",
    confirmedTradingPLBasis: "Confirmed realized P/L across every completed campaign supplied to this summary - not limited to any calendar period.",
    confirmedTradingPLComplete,
    confirmedTradingPLPendingCount: winLoss.pendingCount,
    confirmedTradingPLIncompleteCount: winLoss.unknownResults,

    tradeReturnPercent: thisWeek.returnOnSecuredCapitalPercent,
    tradeReturnGrossPercent: thisWeek.grossReturnOnSecuredCapitalPercent,
    tradeReturnPeriod: "THIS_WEEK",
    tradeReturnPeriodStartUtc: thisWeek.weekStartUtc,
    tradeReturnPeriodEndUtc: thisWeek.weekEndUtc,
    tradeReturnAsOf: asOf,
    tradeReturnBasis:
      "Lifetime realized P/L of campaigns closed this week, divided by the capital those campaigns secured - never idle cash, and never a partial-week slice.",
    tradeReturnStatus,
    tradeReturnMessage: friendlyReportingReason(tradeReturnStatus),

    currentCapitalCommitted,
    currentCapitalCommittedSecuredPut: exposure.securedPutCollateral,
    currentCapitalCommittedAssignedShares: exposure.assignedShareCapital,
    currentCapitalUtilizationPercent,
    capitalUtilizationStatus,
    capitalUtilizationHasUnknownExposure,
    capitalUtilizationMessage: friendlyReportingReason(capitalUtilizationStatus),

    wholeAccountGain,
    wholeAccountGainStatus: wholeAccountGain === null ? "UNAVAILABLE" : "OK",
    wholeAccountGainUnavailableReason,
    wholeAccountGainUnavailableMessage: friendlyReportingReason(wholeAccountGainUnavailableReason),
    wholeAccountGainPeriod: "SINCE_BASELINE",
    wholeAccountGainPeriodStart,
    wholeAccountGainPeriodStartStatus,
    wholeAccountGainOldestPeriodStart,
    wholeAccountGainNewestPeriodStart,
    wholeAccountGainPeriodEnd: currentAccountValueAsOf,
    wholeAccountGainPeriodEndStatus,

    wholeAccountReturnPercent: accounting.totalReturnPercent,
    wholeAccountReturnStatus: accounting.totalReturnStatus,
    wholeAccountReturnMessage: friendlyReportingReason(accounting.totalReturnStatus),

    accountCount: input.accounts.length,
    fundingCoverageStatus: accounting.fundingCoverageStatus,
  };
}

/**
 * Astra corrective patch (Issue 5): the range of instants currentAccountValue's contributing
 * snapshot(s) were actually taken at - never a single, possibly-false "as of" for a multi-account
 * aggregate whose accounts were snapshotted at different times. For a single account, `oldest`
 * and `newest` are always equal (that account's own snapshot time). For a multi-account
 * aggregate, summarizeAccountsPerformance's own synthesized ledger always reports
 * `latestBrokerSnapshot: null` (it has no single revision to point to - see accountLedger.ts), so
 * this re-derives the honest per-account times itself. Recomputing summarizeAccountPerformance per
 * account here is cheap (a pure function, no I/O) and reads already-produced results rather than
 * re-deriving any accounting math.
 */
function accountValueSnapshotRange(
  accounts: AccountPerformanceInput[],
  aggregate: AccountPerformanceSummary,
): { oldest: Date | null; newest: Date | null } {
  if (aggregate.currentValue === null) {
    return { oldest: null, newest: null };
  }
  if (accounts.length === 1) {
    const asOf = aggregate.ledger.latestBrokerSnapshot?.asOf ?? null;
    return { oldest: asOf, newest: asOf };
  }
  const asOfTimes = accounts
    .map((account) => summarizeAccountPerformance(account).ledger.latestBrokerSnapshot?.asOf ?? null)
    .filter((date): date is Date => date !== null);
  if (asOfTimes.length !== accounts.length) {
    // Defensive only - aggregate.currentValue being non-null already implies every account
    // contributed a valid SCHWAB-sourced value, so this should not be reachable in practice.
    return { oldest: null, newest: null };
  }
  const times = asOfTimes.map((date) => date.getTime());
  return { oldest: new Date(Math.min(...times)), newest: new Date(Math.max(...times)) };
}

/**
 * Astra corrective patch (second pass): the range of effective-baseline start instants across
 * whichever contributing accounts have one at all - computed per account, never taken from the
 * aggregate's own `startingCapitalAt` (accountLedger.ts), which arbitrarily reflects only the
 * FIRST account found in summarizeAccountsPerformance's input array - the exact defect Astra
 * reproduced (`[A, B]` reported A's baseline, `[B, A]` reported B's, for the identical combined
 * gain). For a single account this is just that account's own baseline date (oldest === newest).
 * An account with no baseline at all simply doesn't contribute to the range - its absence already
 * surfaces separately via wholeAccountGainUnavailableReason === "NO_BASELINE" when it affects the
 * aggregate gain; this function only answers "among accounts that DO have a baseline, do they
 * agree on when it starts."
 */
function wholeAccountGainPeriodStartRange(
  accounts: AccountPerformanceInput[],
  aggregate: AccountPerformanceSummary,
): { oldest: Date | null; newest: Date | null } {
  if (accounts.length === 1) {
    const start = aggregate.startingCapitalAt;
    return { oldest: start, newest: start };
  }
  const starts = accounts
    .map((account) => summarizeAccountPerformance(account).startingCapitalAt)
    .filter((date): date is Date => date !== null);
  if (starts.length === 0) {
    return { oldest: null, newest: null };
  }
  const times = starts.map((date) => date.getTime());
  return { oldest: new Date(Math.min(...times)), newest: new Date(Math.max(...times)) };
}

/**
 * Resolves WHY wholeAccountGain is null into the most specific reason available. Only ever called
 * when accounting.totalGain === null, at which point accounting.totalReturnStatus can only be
 * "NO_BASELINE", "NO_CURRENT_VALUE", or "INCOMPLETE_FUNDING_EVIDENCE" - "OK" and
 * "CONTRIBUTIONS_NEED_ADVANCED_RETURN" both require totalGain to already be non-null by
 * construction (see accountLedger.ts's totalGain/totalReturnStatusFor gating, which share the same
 * prerequisites). For the funding-evidence case, resolves to the SPECIFIC FundingCoverageStatus
 * reason (mixed sources / inferred baseline / unverified Schwab history) rather than the coarser
 * status, since that is what Section 7's friendly-message table is keyed on.
 */
function wholeAccountGainReasonFor(accounting: AccountPerformanceSummary): WholeAccountGainUnavailableReason {
  if (accounting.totalReturnStatus === "NO_BASELINE") {
    return "NO_BASELINE";
  }
  if (accounting.totalReturnStatus === "NO_CURRENT_VALUE") {
    return "NO_CURRENT_VALUE";
  }
  switch (accounting.fundingCoverageStatus) {
    case "INCOMPLETE_MIXED_SOURCES":
      return "INCOMPLETE_MIXED_SOURCES";
    case "INCOMPLETE_INFERRED_BASELINE":
      return "INCOMPLETE_INFERRED_BASELINE";
    case "INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY":
      return "INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY";
    default:
      // Unreachable given the invariant above, but never throw over a reporting/display concern.
      return "NO_CURRENT_VALUE";
  }
}

/**
 * Astra corrective patch (Issues 1 & 2): priority-ordered so the MOST fundamental problem is
 * always reported first, and so an incomplete result is never mislabeled as a fee problem.
 * `thisWeek.confirmedCount + thisWeek.pendingCount` is exactly `known.length` inside
 * summarizeThisWeek (confirmed and pending partition the known set) - if `completedCount` exceeds
 * that sum, at least one campaign closed this week has no usable result at all.
 */
function tradeReturnStatusFor(thisWeek: ThisWeekSummary): TradeReturnStatus {
  if (thisWeek.completedCount === 0) {
    return "NO_CLOSED_CAMPAIGNS";
  }
  const hasIncompleteResult = thisWeek.completedCount > thisWeek.confirmedCount + thisWeek.pendingCount;
  if (hasIncompleteResult) {
    return "INCOMPLETE_RESULT_EVIDENCE";
  }
  if (!thisWeek.securedCapitalFullyKnown) {
    return "INCOMPLETE_CAPITAL_EVIDENCE";
  }
  if (thisWeek.grossReturnOnSecuredCapitalPercent === null) {
    // Every known campaign's result AND collateral are accounted for, yet gross is still null -
    // the only remaining cause is that the (fully-known) secured-capital total is zero or less.
    return "NO_SECURED_CAPITAL";
  }
  if (thisWeek.returnOnSecuredCapitalPercent === null) {
    return "PENDING_FEE_EVIDENCE";
  }
  return "OK";
}
