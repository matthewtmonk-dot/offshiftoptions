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
 * Reporting Phase, Ticket 1: the ONE authoritative reporting-domain summary Dashboard/Tracker/
 * Account UI should consume, so financial formulas and evidence-status interpretation live in
 * exactly one place instead of being reinvented per page (see PROJECT_HANDOFF.md's read-only
 * design pass for the full product rationale). This module never fetches data and never scopes by
 * owner itself - like every other finance-domain function, it trusts the caller to have already
 * scoped `accounts`/`completedCampaigns`/`openExposure` to one viewer's own data (never mixing two
 * users' records into a single call) before this function is invoked.
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

export type TradeReturnStatus = "OK" | "NO_CLOSED_CAMPAIGNS" | "PENDING_FEE_EVIDENCE" | "INCOMPLETE_EVIDENCE";

export type CapitalUtilizationStatus = "OK" | "NO_ACCOUNT_VALUE";

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
 * computes) rather than switching on a raw code themselves.
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
  NO_CLOSED_CAMPAIGNS: "No campaigns have closed yet in this period.",
  PENDING_FEE_EVIDENCE: "This period's trade return is pending until all fees are confirmed.",
  INCOMPLETE_EVIDENCE: "This period's closed campaigns don't have enough confirmed evidence yet to calculate a return.",
  NO_ACCOUNT_VALUE: "An account value is needed to calculate capital utilization.",
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
   * BROKER_SNAPSHOT at/after the effective baseline, or (only when no trading activity occurred at
   * all) starting capital plus contributions. Never reconstructed from option premium, campaign
   * P/L, or funding events alone when trading occurred - see accountLedger.ts's own doc comments.
   * May be available even when wholeAccountGain is not (e.g. an inferred baseline still yields a
   * real current value, just not a confirmed gain). */
  currentAccountValue: number | null;
  /** The instant currentAccountValue reflects - the underlying BROKER_SNAPSHOT's own `asOf` for a
   * single account; for a multi-account aggregate, the OLDEST contributing snapshot's `asOf` (the
   * point at which the whole total can be trusted as of), or null if no snapshot ever fed it. */
  currentAccountValueAsOf: Date | null;
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
   * completed campaigns were supplied, since summarizeWinLoss itself supports that broader total. */
  confirmedTradingPLPeriod: "ALL_TIME";
  /** False when at least one closed campaign in scope is PENDING (a known result with an
   * unresolved fee) or INCOMPLETE (no usable result at all) - confirmedTradingPL itself never
   * includes those, but callers should disclose that more evidence is still outstanding. */
  confirmedTradingPLComplete: boolean;
  confirmedTradingPLPendingCount: number;
  confirmedTradingPLIncompleteCount: number;

  // ---- Section 3: Trade Return ("How well did the trades perform on capital committed?") ----
  /** summarizeThisWeek's fee-exact return on secured capital (net-basis) - null whenever fees for
   * this week's closed campaigns aren't fully resolved yet (see tradeReturnGrossPercent for the
   * fee-pending fallback already used elsewhere in the UI). */
  tradeReturnPercent: number | null;
  /** summarizeThisWeek's gross-basis return on secured capital - available even before every fee
   * is confirmed, so a caller can still show a provisional figure rather than nothing. */
  tradeReturnGrossPercent: number | null;
  /** Reporting v1 exposes ONLY the one period the existing math is already proven safe for - see
   * the ticket's explicit instruction not to generalize to 4 weeks/all time yet. */
  tradeReturnPeriod: "THIS_WEEK";
  /** Fixed, human-readable description of the ratio - "confirmed realized P/L ÷ capital
   * committed," never idle cash, never a whole-account denominator. */
  tradeReturnBasis: string;
  tradeReturnStatus: TradeReturnStatus;
  tradeReturnMessage: string | null;

  // ---- Section 4: Current Capital Utilization ("How much of my account is at work right now?") ----
  /** Cash secured by genuinely OPEN puts (summarizeCampaignExposure's securedPutCollateral) plus
   * assigned-but-unsold shares' cost basis (assignedShareCapital) - both are real capital that is
   * NOT idle cash, and summarizeCampaignExposure already keeps them correctly distinct (an
   * ASSIGNED campaign's stock position is never misrepresented as an active CSP). Null only when
   * there is no valid denominator to divide it by (capitalUtilizationStatus !== "OK"). */
  currentCapitalCommitted: number | null;
  /** Breakdown of currentCapitalCommitted's two components, for a caller that wants to show them
   * separately rather than one collapsed figure. */
  currentCapitalCommittedSecuredPut: number;
  currentCapitalCommittedAssignedShares: number;
  currentCapitalUtilizationPercent: number | null;
  capitalUtilizationStatus: CapitalUtilizationStatus;
  /** True when at least one open campaign's collateral or assigned campaign's cost basis is
   * unknown (see summarizeCampaignExposure's openCampaignsWithUnknownCollateral /
   * assignedCampaignsWithKnownBasis) - currentCapitalCommitted is then a FLOOR, not an exact total,
   * even though capitalUtilizationStatus can still be "OK". */
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
  const currentAccountValueAsOf = accountValueAsOf(input.accounts, accounting);

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
  const capitalUtilizationStatus: CapitalUtilizationStatus = currentAccountValue !== null && currentAccountValue > 0 ? "OK" : "NO_ACCOUNT_VALUE";
  const currentCapitalCommitted = capitalUtilizationStatus === "OK" ? currentCapitalCommittedTotal : null;
  const currentCapitalUtilizationPercent =
    capitalUtilizationStatus === "OK" ? round((currentCapitalCommittedTotal / currentAccountValue!) * 100, 2) : null;

  // Sections 5 & 6 - pure passthrough of the already-approved accounting summary.
  const wholeAccountGain = accounting.totalGain;
  const wholeAccountGainUnavailableReason = wholeAccountGain === null ? wholeAccountGainReasonFor(accounting) : null;

  return {
    currentAccountValue,
    currentAccountValueAsOf,
    currentAccountValueSource,

    confirmedTradingPL: winLoss.confirmedRealizedTradingPL,
    confirmedTradingPLPeriod: "ALL_TIME",
    confirmedTradingPLComplete,
    confirmedTradingPLPendingCount: winLoss.pendingCount,
    confirmedTradingPLIncompleteCount: winLoss.unknownResults,

    tradeReturnPercent: thisWeek.returnOnSecuredCapitalPercent,
    tradeReturnGrossPercent: thisWeek.grossReturnOnSecuredCapitalPercent,
    tradeReturnPeriod: "THIS_WEEK",
    tradeReturnBasis: "Confirmed realized P/L for campaigns closed this week, divided by the capital those campaigns secured - never idle cash.",
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

    wholeAccountReturnPercent: accounting.totalReturnPercent,
    wholeAccountReturnStatus: accounting.totalReturnStatus,
    wholeAccountReturnMessage: friendlyReportingReason(accounting.totalReturnStatus),

    accountCount: input.accounts.length,
    fundingCoverageStatus: accounting.fundingCoverageStatus,
  };
}

/**
 * The instant currentAccountValue reflects. For a single account this is just that account's own
 * latest valid snapshot time (already computed by summarizeAccountPerformance - never
 * re-validated here). For a multi-account aggregate, summarizeAccountsPerformance's own
 * synthesized ledger always reports `latestBrokerSnapshot: null` (it has no single revision to
 * point to - see accountLedger.ts), so this re-derives the honest aggregate answer: the OLDEST of
 * the individually-valid contributing snapshots, since that is the point at which the WHOLE total
 * can be trusted as of. Recomputing summarizeAccountPerformance per account here is cheap (a pure
 * function, no I/O) and reads already-produced results rather than re-deriving any accounting math.
 */
function accountValueAsOf(accounts: AccountPerformanceInput[], aggregate: AccountPerformanceSummary): Date | null {
  if (aggregate.currentValue === null) {
    return null;
  }
  if (accounts.length === 1) {
    return aggregate.ledger.latestBrokerSnapshot?.asOf ?? null;
  }
  const asOfTimes = accounts
    .map((account) => summarizeAccountPerformance(account).ledger.latestBrokerSnapshot?.asOf ?? null)
    .filter((date): date is Date => date !== null);
  if (asOfTimes.length !== accounts.length) {
    // Defensive only - aggregate.currentValue being non-null already implies every account
    // contributed a valid SCHWAB-sourced value, so this should not be reachable in practice.
    return null;
  }
  return new Date(Math.min(...asOfTimes.map((date) => date.getTime())));
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

function tradeReturnStatusFor(thisWeek: ThisWeekSummary): TradeReturnStatus {
  if (thisWeek.completedCount === 0) {
    return "NO_CLOSED_CAMPAIGNS";
  }
  if (thisWeek.grossReturnOnSecuredCapitalPercent === null) {
    return "INCOMPLETE_EVIDENCE";
  }
  if (thisWeek.returnOnSecuredCapitalPercent === null) {
    return "PENDING_FEE_EVIDENCE";
  }
  return "OK";
}
