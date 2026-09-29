import type { EquityMarketSessionEvidence, QuoteReviewEvidence } from "@/providers/market-data/types";
import type { CampaignCurrentStage } from "./campaigns";
import { round } from "./calculations";
import { daysToExpiration, expirationCalendarDate, isWithinRegularSession, regularSessionCloseInstant } from "./marketSession";
import { evaluateQuoteEligibility, type QuoteEligibilityFailureReason } from "./quoteEvidence";
import { DEFAULT_ROLL_BUFFER_PERCENT } from "./rollStatus";

/**
 * Dashboard V2 Phase 2 - the single shared position-review evaluator Dashboard and Tracker both
 * consume, so the two pages can never disagree about a position's status. Pure: no database
 * writes, no AI, no P/L formula, no assignment probability. Every input this function needs
 * (the current leg's own terms, the campaign's existing lifecycle-stage label, position/quote/
 * session evidence) is handed in already resolved - this module never re-derives "what leg is
 * currently open" itself (see src/domain/finance/campaigns.ts's getCurrentOpenPut/
 * getCurrentOpenCall/currentStage, which remain the one authoritative source for that), and never
 * falls back to a legacy normalized quote `asOf`.
 */

export type PositionReviewAction = "COMFORTABLE" | "WATCH" | "REVIEW_ROLL" | "REVIEW_CALL" | "CANNOT_ASSESS";

export type PositionReviewLifecycle =
  | "CURRENT_PUT"
  | "ROLLED_PUT"
  | "COVERED_CALL"
  | "ASSIGNED_SHARES"
  | "EXPIRATION_PENDING"
  | "EXPIRATION_SESSION_ENDED";

/** Position-matching confirmation, kept deliberately separate from quote/action evidence -
 * "Schwab confirmed" proves position matching, never quote freshness. Callers resolve this via
 * trackerPositionMatch.ts (puts) and its call-matching extension (calls) - this module never
 * re-derives matching itself. */
export type PositionReviewPositionInput =
  | { state: "SCHWAB_CONFIRMED"; asOf: Date }
  | { state: "AWAITING_CONFIRMATION" }
  | { state: "NOT_ASSESSED" }
  | { state: "BROKER_UNAVAILABLE" }
  | { state: "POSITION_MISMATCH_AMBIGUOUS" }
  /** An owner-classified manual (non-Schwab-linked) campaign with complete manual terms - never
   * inferred silently for an unmatched Schwab campaign. */
  | { state: "MANUAL_POSITION" };

export type PositionEvidenceState = PositionReviewPositionInput["state"];

export type SessionEvidenceState = "OPEN" | "CLOSED" | "UNAVAILABLE";

export type QuoteEvidenceState = "ELIGIBLE" | "MARKET_CLOSED" | "UNAVAILABLE" | "NOT_APPLICABLE";

export type PositionReviewEvidence = {
  position: PositionEvidenceState;
  quote: QuoteEvidenceState;
  /** Populated only when quote is MARKET_CLOSED or UNAVAILABLE - the exact eligibility rule that
   * failed (see quoteEvidence.ts), for diagnostics/tooltips. */
  quoteIneligibleReason: QuoteEligibilityFailureReason | null;
  session: SessionEvidenceState;
};

export type PositionReviewExplanation = {
  /** Deterministic reason code(s) - stable identifiers a caller can map to copy, never free text
   * generated here. */
  reasonCodes: string[];
  optionType: "PUT" | "CALL" | null;
  strike: number | null;
  /** The approved review price (quote.lastPrice), only when quote evidence was ELIGIBLE. */
  stockPrice: number | null;
  /** Absolute dollar distance between stockPrice and strike - always non-negative. Null unless
   * both strike and an eligible stockPrice are known. */
  dollarDistance: number | null;
  /** Absolute percentage distance between stockPrice and strike - always non-negative. */
  percentageDistance: number | null;
  moneyness: "ITM" | "ATM" | "OTM" | null;
  /** The buffer percent actually used (the owner's configured value, or the default when the
   * configured value was outside the validated 0.1%-25% range) - null when there is no leg to
   * evaluate (assigned shares with no call). */
  bufferPercent: number | null;
  expiration: Date | null;
  daysToExpiration: number | null;
  quoteTradeTime: Date | null;
  quoteAgeMs: number | null;
  /** The broker position read's own observation time - never the render/re-check time. */
  positionEvidenceAsOf: Date | null;
};

export type PositionReviewPriorityGroup = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type PositionReviewPriority = {
  group: PositionReviewPriorityGroup;
  /** Only meaningful within group 2 (expires today): 0 = review-red, 1 = evidence-failure/
   * cannot-assess, 2 = watch - per the ticket's own within-group ordering. */
  withinExpirationTodaySubgroup: 0 | 1 | 2 | null;
  /** "YYYY-MM-DD" (read via UTC components, see marketSession.ts's expirationCalendarDate) or
   * null when there is no known expiration - null sorts last within its group. */
  expirationSortKey: string | null;
  ticker: string;
  accountId: string;
  campaignId: string;
};

export type PositionReviewResult = {
  action: PositionReviewAction;
  lifecycle: PositionReviewLifecycle;
  evidence: PositionReviewEvidence;
  explanation: PositionReviewExplanation;
  priority: PositionReviewPriority;
};

/** The authoritative current leg under review - never a historical/closed leg (see the ticket's
 * "rolled positions use current leg only" rule). `strike`/`expiration` may be null for a leg whose
 * own terms are incomplete (e.g. a legacy row) - this is handled as CANNOT_ASSESS, never guessed. */
export type PositionReviewLeg =
  | { kind: "PUT"; strike: number | null; expiration: Date | null }
  | { kind: "CALL"; strike: number | null; expiration: Date | null }
  /** Assigned shares with no currently open covered call. */
  | { kind: "NONE" };

export type PositionReviewInput = {
  campaignId: string;
  accountId: string;
  ticker: string;
  leg: PositionReviewLeg;
  /** From campaigns.ts's own currentStage() - used only to label CURRENT_PUT vs ROLLED_PUT vs
   * COVERED_CALL; this module's own expiration-state logic (below) supersedes currentStage's
   * "Expiration processing" for ACTION/LIFECYCLE purposes without altering currentStage itself. */
  lifecycleStage: CampaignCurrentStage;
  /** The owner's configured UserSettings.rollBufferPercent - validated/clamped to the default
   * here if outside the 0.1%-25% range, never trusted blindly. */
  rollBufferPercent: number;
  position: PositionReviewPositionInput;
  quote: QuoteReviewEvidence;
  session: EquityMarketSessionEvidence;
  now?: Date;
};

const BROKER_POSITION_FRESHNESS_MS = 5 * 60_000;

export function evaluatePositionReview(input: PositionReviewInput): PositionReviewResult {
  const now = input.now ?? new Date();
  const leg = input.leg;
  const buffer = validatedBufferPercent(input.rollBufferPercent);
  const expiration = leg.kind !== "NONE" ? leg.expiration : null;
  const dte = expiration ? daysToExpiration(expiration, now) : null;
  const sessionCloseInstant = regularSessionCloseInstant(input.session);
  const sessionEndedToday = dte === 0 && sessionCloseInstant !== null && now.getTime() >= sessionCloseInstant.getTime();
  const sessionState = sessionStateOf(input.session, now);

  const reasonCodes: string[] = [];
  let action: PositionReviewAction | null = null;
  let lifecycle: PositionReviewLifecycle;

  if (leg.kind === "NONE") {
    lifecycle = "ASSIGNED_SHARES";
    action = "CANNOT_ASSESS";
    reasonCodes.push("ASSIGNED_SHARES_NO_CALL");
  } else if (dte !== null && dte < 0) {
    lifecycle = "EXPIRATION_PENDING";
    action = "CANNOT_ASSESS";
    reasonCodes.push("PAST_EXPIRATION_UNRESOLVED");
  } else if (sessionEndedToday) {
    lifecycle = "EXPIRATION_SESSION_ENDED";
    action = "CANNOT_ASSESS";
    reasonCodes.push("EXPIRATION_SESSION_ENDED");
  } else {
    lifecycle = baseLifecycleFromStage(input.lifecycleStage, leg.kind);
    if (expiration === null) {
      action = "CANNOT_ASSESS";
      reasonCodes.push("EXPIRATION_UNKNOWN");
    }
  }

  const positionState = evaluatePositionState(input.position, now);
  if (action === null && positionState !== "SCHWAB_CONFIRMED" && positionState !== "MANUAL_POSITION") {
    action = "CANNOT_ASSESS";
    reasonCodes.push(`POSITION_${positionState}`);
  }

  let quoteState: QuoteEvidenceState = "NOT_APPLICABLE";
  let quoteIneligibleReason: QuoteEligibilityFailureReason | null = null;
  let stockPrice: number | null = null;
  let quoteTradeTime: Date | null = null;
  let quoteAgeMs: number | null = null;

  if (leg.kind !== "NONE") {
    const eligibility = evaluateQuoteEligibility(input.quote, input.session, now);
    if (eligibility.eligible) {
      quoteState = "ELIGIBLE";
      stockPrice = eligibility.evidence.price;
      quoteTradeTime = eligibility.evidence.tradeTime;
      quoteAgeMs = eligibility.ageMs;
    } else {
      quoteIneligibleReason = eligibility.reason;
      quoteState = isMarketClosedReason(eligibility.reason) ? "MARKET_CLOSED" : "UNAVAILABLE";
      if (action === null) {
        action = "CANNOT_ASSESS";
        reasonCodes.push(quoteState === "MARKET_CLOSED" ? "MARKET_CLOSED" : `QUOTE_${eligibility.reason}`);
      }
    }
  }

  const strike = leg.kind !== "NONE" ? leg.strike : null;
  let moneyness: "ITM" | "ATM" | "OTM" | null = null;
  let dollarDistance: number | null = null;
  let percentageDistance: number | null = null;

  if (action === null) {
    if (strike === null || !Number.isFinite(strike) || strike <= 0) {
      action = "CANNOT_ASSESS";
      reasonCodes.push("INCOMPLETE_TERMS");
    } else if (stockPrice === null) {
      // Defensive - quoteState would already have set `action` above in every real path.
      action = "CANNOT_ASSESS";
      reasonCodes.push("QUOTE_UNAVAILABLE");
    } else {
      const isPut = leg.kind === "PUT";
      const signedDiff = stockPrice - strike;
      dollarDistance = round(Math.abs(signedDiff), 2);
      percentageDistance = round((Math.abs(signedDiff) / strike) * 100, 4);
      // Classified from the exact unrounded signedDiff, before any display rounding.
      moneyness = signedDiff === 0 ? "ATM" : isPut ? (signedDiff > 0 ? "OTM" : "ITM") : signedDiff < 0 ? "OTM" : "ITM";

      const favorableDistancePct = isPut ? ((stockPrice - strike) / strike) * 100 : ((strike - stockPrice) / strike) * 100;
      const stillTradingToday = dte === 0 && !sessionEndedToday;

      if (favorableDistancePct <= 0) {
        action = isPut ? "REVIEW_ROLL" : "REVIEW_CALL";
        reasonCodes.push(isPut ? "PUT_AT_OR_ITM" : "CALL_AT_OR_ITM");
      } else if (favorableDistancePct <= buffer) {
        action = "WATCH";
        reasonCodes.push("WITHIN_ROLL_BUFFER");
      } else if (stillTradingToday) {
        action = "WATCH";
        reasonCodes.push("EXPIRES_TODAY");
      } else {
        action = "COMFORTABLE";
      }
    }
  }

  const finalAction: PositionReviewAction = action ?? "CANNOT_ASSESS";
  const expirationUnknown = leg.kind !== "NONE" && expiration === null;
  const group = priorityGroupOf({ lifecycle, action: finalAction, dte, expirationUnknown, reasonCodes });
  const withinExpirationTodaySubgroup = group === 2 ? subgroupOf(finalAction) : null;

  return {
    action: finalAction,
    lifecycle,
    evidence: { position: positionState, quote: quoteState, quoteIneligibleReason, session: sessionState },
    explanation: {
      reasonCodes,
      optionType: leg.kind === "NONE" ? null : leg.kind,
      strike,
      stockPrice,
      dollarDistance,
      percentageDistance,
      moneyness,
      bufferPercent: leg.kind === "NONE" ? null : buffer,
      expiration,
      daysToExpiration: dte,
      quoteTradeTime,
      quoteAgeMs,
      positionEvidenceAsOf: input.position.state === "SCHWAB_CONFIRMED" ? input.position.asOf : null,
    },
    priority: {
      group,
      withinExpirationTodaySubgroup,
      expirationSortKey: expiration ? expirationCalendarDate(expiration) : null,
      ticker: input.ticker,
      accountId: input.accountId,
      campaignId: input.campaignId,
    },
  };
}

/**
 * Deterministic Positions-to-Review ordering, matching the ticket's exact 8-group priority list
 * plus its within-group tiebreaks. Never sorts by P/L, premium, or any score.
 */
export function comparePositionReviewPriority(a: PositionReviewResult, b: PositionReviewResult): number {
  const pa = a.priority;
  const pb = b.priority;
  if (pa.group !== pb.group) {
    return pa.group - pb.group;
  }
  if (pa.group === 2) {
    const subDelta = (pa.withinExpirationTodaySubgroup ?? 9) - (pb.withinExpirationTodaySubgroup ?? 9);
    if (subDelta !== 0) {
      return subDelta;
    }
  }
  const expirationDelta = compareExpirationSortKey(pa.expirationSortKey, pb.expirationSortKey);
  if (expirationDelta !== 0) {
    return expirationDelta;
  }
  if (pa.ticker !== pb.ticker) {
    return pa.ticker < pb.ticker ? -1 : 1;
  }
  if (pa.accountId !== pb.accountId) {
    return pa.accountId < pb.accountId ? -1 : 1;
  }
  if (pa.campaignId !== pb.campaignId) {
    return pa.campaignId < pb.campaignId ? -1 : 1;
  }
  return 0;
}

/** Sorts a full set of already-evaluated results - callers must evaluate ALL relevant owner-scoped
 * campaigns before truncating for display (see the ticket's own "evaluate all, then truncate" rule). */
export function sortPositionReviews(results: PositionReviewResult[]): PositionReviewResult[] {
  return [...results].sort(comparePositionReviewPriority);
}

function compareExpirationSortKey(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

function priorityGroupOf({
  lifecycle,
  action,
  dte,
  expirationUnknown,
  reasonCodes,
}: {
  lifecycle: PositionReviewLifecycle;
  action: PositionReviewAction;
  dte: number | null;
  expirationUnknown: boolean;
  reasonCodes: string[];
}): PositionReviewPriorityGroup {
  if (lifecycle === "EXPIRATION_PENDING" || lifecycle === "EXPIRATION_SESSION_ENDED") {
    return 1;
  }
  if (dte === 0) {
    return 2;
  }
  if (expirationUnknown) {
    return 3;
  }
  if (action === "REVIEW_ROLL" || action === "REVIEW_CALL") {
    return 4;
  }
  if (lifecycle === "ASSIGNED_SHARES") {
    return 7;
  }
  if (action === "CANNOT_ASSESS" && reasonCodes.includes("MARKET_CLOSED")) {
    return 7;
  }
  if (action === "CANNOT_ASSESS") {
    return 5;
  }
  if (action === "WATCH") {
    return 6;
  }
  return 8;
}

function subgroupOf(action: PositionReviewAction): 0 | 1 | 2 {
  if (action === "REVIEW_ROLL" || action === "REVIEW_CALL") return 0;
  if (action === "WATCH") return 2;
  return 1;
}

function isMarketClosedReason(reason: QuoteEligibilityFailureReason): boolean {
  return reason === "MARKET_NOT_IN_REGULAR_SESSION";
}

function sessionStateOf(session: EquityMarketSessionEvidence, now: Date): SessionEvidenceState {
  if (session.status !== "AVAILABLE") {
    return "UNAVAILABLE";
  }
  return isWithinRegularSession(session, now) ? "OPEN" : "CLOSED";
}

function evaluatePositionState(position: PositionReviewPositionInput, now: Date): PositionEvidenceState {
  if (position.state !== "SCHWAB_CONFIRMED") {
    return position.state;
  }
  // Codex P1 (B1) - an invalid (NaN) receipt timestamp must fail closed, never pass the
  // `ageMs < 0 || ageMs > window` comparisons vacuously (NaN fails both, which previously let a
  // corrupted timestamp read as "fresh").
  if (!Number.isFinite(position.asOf.getTime())) {
    return "AWAITING_CONFIRMATION";
  }
  const ageMs = now.getTime() - position.asOf.getTime();
  if (ageMs < 0 || ageMs > BROKER_POSITION_FRESHNESS_MS) {
    return "AWAITING_CONFIRMATION";
  }
  return "SCHWAB_CONFIRMED";
}

function baseLifecycleFromStage(stage: CampaignCurrentStage, legKind: "PUT" | "CALL"): PositionReviewLifecycle {
  if (stage === "Rolled put") return "ROLLED_PUT";
  if (stage === "Cash-secured put") return "CURRENT_PUT";
  if (stage === "Covered call") return "COVERED_CALL";
  // "Assigned shares" (with an open call - the caller passes leg.kind NONE for the no-call case),
  // "Expiration processing", "Review needed", "Closed", or any future stage value: fall back to
  // the leg's own option type rather than guessing a stage-specific label.
  return legKind === "PUT" ? "CURRENT_PUT" : "COVERED_CALL";
}

function validatedBufferPercent(rollBufferPercent: number): number {
  return Number.isFinite(rollBufferPercent) && rollBufferPercent >= 0.1 && rollBufferPercent <= 25
    ? rollBufferPercent
    : DEFAULT_ROLL_BUFFER_PERCENT;
}
