import type { EquityMarketSessionEvidence, QuoteReviewEvidence } from "@/providers/market-data/types";
import type { CampaignCurrentStage } from "./campaigns";
import { round } from "./calculations";
import { daysToExpiration, expirationCalendarDate, isWithinRegularSession, regularSessionCloseInstant, regularSessionIntervalContaining } from "./marketSession";
import { evaluateQuoteEligibility, QUOTE_FRESHNESS_WINDOW_MS, type QuoteEligibilityFailureReason } from "./quoteEvidence";
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
  | { state: "MANUAL_POSITION" }
  /** Codex P1 (B5) - the short call's own CONTRACT matched a real broker position exactly, but the
   * owner+account+underlying's aggregate broker-held share count does not (or cannot be proven to)
   * cover every campaign currently claiming a covered call against it. An uncovered short call
   * must never receive "covered call" active guidance - the caller resolves this by aggregating
   * ALL competing campaigns for the same shares, never a first-campaign-wins allocation. */
  | { state: "INSUFFICIENT_SHARE_COVERAGE" }
  /** Codex P2 (B, round 3) - the short call's own contract matched, and share coverage math may
   * even appear to add up, but this app cannot PROVE the contract's actual deliverable is a
   * standard 100 shares (no trustworthy provider multiplier/deliverable evidence exists for any
   * contract contributing to this owner+account+underlying's obligation total). OCC symbol shape
   * alone never proves the deliverable - see BrokerPosition.sharesPerContract's own doc comment.
   * Covered-call active guidance fails closed rather than assuming the standard multiplier. */
  | { state: "UNSUPPORTED_CONTRACT_DELIVERABLE" };

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
  /**
   * Codex P1 (B3) - the exact instant a LIVE colored advisory (COMFORTABLE/WATCH/REVIEW_ROLL/
   * REVIEW_CALL) stops being presentable, computed here (server/domain side) rather than left for
   * a client to guess: the EARLIEST of (1) quoteTradeTime + 120s, (2) a SCHWAB_CONFIRMED position's
   * own read-receipt time + 5 minutes, and (3) the validated regular session's own close instant.
   * Null whenever there is no live advisory to expire at all (CANNOT_ASSESS, or no eligible quote).
   * A client re-checks against this deadline using its OWN clock only to measure elapsed time
   * against it - the deadline itself is always derived from real provider/broker evidence times,
   * never client clock time.
   */
  activeGuidanceDeadline: Date | null;
  /**
   * Codex P2 (A) - the exact server-side instant this whole evaluation was performed against
   * (`input.now`) - the trusted origin a client uses, together with `activeGuidanceDeadline`, to
   * compute how much validity remains WITHOUT ever comparing the deadline directly against its
   * own `Date.now()` (which a slow/manipulated client clock could use to extend guidance past
   * when the server actually authorized it). See useActiveGuidanceExpired's own doc comment for
   * the full client-side timing model built on these two fields.
   */
  evaluatedAt: Date;
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

/**
 * The authoritative current leg under review - never a historical/closed leg (see the ticket's
 * "rolled positions use current leg only" rule). `strike`/`expiration`/`contracts` may each be
 * null for a leg whose own terms are incomplete (e.g. a legacy row, or a manual entry missing a
 * field) - this is handled as CANNOT_ASSESS, never guessed. Codex P2 (C): `contracts` is a
 * REQUIRED field on this type (not merely optional) precisely so a caller constructing a leg
 * cannot forget to state whether quantity is known - a leg with a known strike/expiration but an
 * unstated quantity must never be silently treated as a complete, reviewable position.
 */
export type PositionReviewLeg =
  | { kind: "PUT"; strike: number | null; expiration: Date | null; contracts: number | null }
  | { kind: "CALL"; strike: number | null; expiration: Date | null; contracts: number | null }
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

  // Codex P2 (C) - EVERY required factual term (expiration, contracts, strike) is validated here,
  // together, BEFORE anything else runs - including before position evidence is even resolved, so
  // a MANUAL_POSITION bypass can never override an incomplete leg (the check does not depend on
  // `positionState` at all). A leg missing any one of these is never partially "complete enough"
  // to reach quote/moneyness evaluation. Codex P2 (round 3) - a contract count must be a genuine
  // INTEGER, not merely a positive finite number: a fractional value (0.5, 1.25) is not a real,
  // reviewable option-contract quantity and must fail the same way a missing one does.
  const contractsValid = leg.kind !== "NONE" && leg.contracts !== null && Number.isFinite(leg.contracts) && Number.isInteger(leg.contracts) && leg.contracts > 0;
  const strikeValid = leg.kind !== "NONE" && leg.strike !== null && Number.isFinite(leg.strike) && leg.strike > 0;
  const termsIncomplete = leg.kind !== "NONE" && (expiration === null || !contractsValid || !strikeValid);

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
    } else if (!contractsValid) {
      action = "CANNOT_ASSESS";
      reasonCodes.push("MISSING_CONTRACTS");
    } else if (!strikeValid) {
      action = "CANNOT_ASSESS";
      reasonCodes.push("INCOMPLETE_TERMS");
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
      // Unreachable in practice - `termsIncomplete` above already set `action` for this case
      // before quote evaluation even ran. Kept as a defensive fallback only, and for TypeScript's
      // own null-narrowing of `strike` below.
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
  const group = priorityGroupOf({ lifecycle, action: finalAction, dte, termsIncomplete, reasonCodes });
  const withinExpirationTodaySubgroup = group === 2 ? subgroupOf(finalAction) : null;
  const positionEvidenceAsOf = input.position.state === "SCHWAB_CONFIRMED" ? input.position.asOf : null;
  const activeGuidanceDeadline = computeActiveGuidanceDeadline({
    action: finalAction,
    quoteTradeTime,
    positionState,
    positionEvidenceAsOf,
    session: input.session,
    now,
  });

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
      positionEvidenceAsOf,
      activeGuidanceDeadline,
      evaluatedAt: now,
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
  termsIncomplete,
  reasonCodes,
}: {
  lifecycle: PositionReviewLifecycle;
  action: PositionReviewAction;
  dte: number | null;
  /** Codex P2 (C) - broadened from "expiration unknown" alone to ANY missing required leg term
   * (expiration, contracts, or strike) - every incomplete-term case gets the same high priority,
   * not just the expiration-specific one. */
  termsIncomplete: boolean;
  reasonCodes: string[];
}): PositionReviewPriorityGroup {
  if (lifecycle === "EXPIRATION_PENDING" || lifecycle === "EXPIRATION_SESSION_ENDED") {
    return 1;
  }
  // Codex P2 (round 3) - incomplete required terms are checked BEFORE "expires today": a position
  // expiring today with missing/invalid contracts (or any other required term) is an INCOMPLETE
  // row (group 3), never a genuine "complete terms, expires today" row (group 2) - the two groups
  // are mutually exclusive by definition, not merely by coincidence of which check ran first.
  if (termsIncomplete) {
    return 3;
  }
  if (dte === 0) {
    return 2;
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

const LIVE_ACTIONS: ReadonlySet<PositionReviewAction> = new Set(["COMFORTABLE", "WATCH", "REVIEW_ROLL", "REVIEW_CALL"]);

/** Codex P1 (B3) / Codex P2 (A) - see PositionReviewExplanation.activeGuidanceDeadline's own doc
 * comment for the exact contract. Every component is a real evidence/session time - never
 * `new Date()`, never the client's own clock. Codex P2 (A) fixed the session component: it
 * previously used the trading DAY's LAST regular-session interval end (wrong on a multi-interval
 * day, e.g. a mid-day halt/resumption), when the correct deadline is the end of the SAME
 * interval that actually authorized this review - the identical interval identity
 * evaluateQuoteEligibility itself already required `now` and `quoteTradeTime` to share. */
function computeActiveGuidanceDeadline({
  action,
  quoteTradeTime,
  positionState,
  positionEvidenceAsOf,
  session,
  now,
}: {
  action: PositionReviewAction;
  quoteTradeTime: Date | null;
  positionState: PositionEvidenceState;
  positionEvidenceAsOf: Date | null;
  session: EquityMarketSessionEvidence;
  now: Date;
}): Date | null {
  if (!LIVE_ACTIONS.has(action) || !quoteTradeTime) {
    return null;
  }

  const deadlines: number[] = [quoteTradeTime.getTime() + QUOTE_FRESHNESS_WINDOW_MS];

  if (positionState === "SCHWAB_CONFIRMED" && positionEvidenceAsOf) {
    deadlines.push(positionEvidenceAsOf.getTime() + BROKER_POSITION_FRESHNESS_MS);
  }

  // The CONTAINING interval, not the day's last one - a live advisory can only ever have been
  // authorized because `now` fell inside this exact interval (see evaluateQuoteEligibility's own
  // same-interval requirement), so its own end is the true session-driven deadline.
  const containingInterval = regularSessionIntervalContaining(session, now);
  if (containingInterval) {
    deadlines.push(containingInterval.end.getTime());
  }

  return new Date(Math.min(...deadlines));
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

export function validatedBufferPercent(rollBufferPercent: number): number {
  return Number.isFinite(rollBufferPercent) && rollBufferPercent >= 0.1 && rollBufferPercent <= 25
    ? rollBufferPercent
    : DEFAULT_ROLL_BUFFER_PERCENT;
}
