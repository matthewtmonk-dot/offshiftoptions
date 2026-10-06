import type { EquityMarketSessionEvidence } from "@/providers/market-data/types";
import { isNyseMarketDay, marketDate, previousNyseMarketDay } from "./marketCalendar";
import { expirationCalendarDate, nyCalendarDateOf, regularSessionIntervalContaining } from "./marketSession";
import { evaluatePositionReview, validatedBufferPercent, type PositionReviewInput, type PositionEvidenceState, type PositionReviewAction, type PositionReviewLifecycle, type PositionReviewResult } from "./positionReview";
import { evaluateQuoteEligibility } from "./quoteEvidence";

export const POSITION_REVIEW_POLICY_VERSION = 1;

/**
 * LST "Last Valid Position Assessment" - Phase 1 durable domain foundation. Pure/no I/O: this
 * module never touches Prisma, never calls a provider, and never re-derives "what leg is
 * currently open" itself (see campaigns.ts's getCurrentOpenPut/getCurrentOpenCall, the one
 * authoritative source). It defines the identity/fingerprint, the write-eligibility predicate, and
 * the historical-match/read-eligibility predicate that the Phase 1 persistence service (in
 * src/lib) composes with real DB reads/writes. A stored assessment produced here is HISTORICAL
 * DISPLAY FALLBACK ONLY - it must never be fed back into evaluatePositionReview, and never
 * satisfies current quote freshness, current session eligibility, strict broker confirmation, or
 * current position-review eligibility.
 */

/**
 * Durable scoped identity for one position-review leg: ownerId+accountId+campaignId+
 * openingEventId. openingEventId is the originating OPENING CampaignEvent.id exposed by
 * getCurrentOpenPut/getCurrentOpenCall (see position-review-scope.ts's own
 * openingEventIdByCampaignId map) - a reopened identical contract gets a new opening event id and
 * is therefore a distinct scoped position, never conflated with the position it replaced.
 */
export type PositionReviewAssessmentScope = {
  ownerId: string;
  accountId: string;
  campaignId: string;
  openingEventId: string;
};

/**
 * Every input the deterministic context fingerprint is built from. Includes not just the leg's own
 * terms but the account/brokerage mapping and the CURRENT policy inputs (roll buffer, evaluation
 * policy version) that would make an old assessment materially misleading if they changed since it
 * was stored - a roll-buffer change alone must invalidate a stored fallback even though the
 * position itself never moved.
 */
export type PositionReviewContextFingerprintInput = {
  scope: PositionReviewAssessmentScope;
  ticker: string;
  optionType: "PUT" | "CALL";
  strike: number;
  expiration: Date;
  contracts: number;
  campaignStatus: string;
  campaignLifecycleStage: string;
  accountSource: "MANUAL" | "SCHWAB";
  /** The account's brokerage mapping identity (e.g. externalAccountId) - null for a manual account
   * with no brokerage mapping at all. A mapping CHANGE (not merely "still null") must invalidate a
   * stored fallback. */
  brokerageMappingIdentity: string | null;
  appliedRollBufferPercent: number;
  evaluationPolicyVersion: number;
};

function sameScope(a: PositionReviewAssessmentScope, b: PositionReviewAssessmentScope): boolean {
  return a.ownerId === b.ownerId && a.accountId === b.accountId && a.campaignId === b.campaignId && a.openingEventId === b.openingEventId;
}

/**
 * Deterministic canonical-data fingerprint (JSON.stringify of a fixed-shape, fixed-key-order
 * object) - never a hash of rendered prose. Two calls with identical inputs always produce an
 * identical string; any materially-invalidating input change produces a different one. Matches
 * this codebase's own existing "evidence fingerprint" convention (see
 * domain/trade-prep/optionEvidence.ts's contractEvidenceFingerprint).
 */
export function computePositionReviewContextFingerprint(input: PositionReviewContextFingerprintInput): string {
  return JSON.stringify({
    ownerId: input.scope.ownerId,
    accountId: input.scope.accountId,
    campaignId: input.scope.campaignId,
    openingEventId: input.scope.openingEventId,
    ticker: input.ticker.toUpperCase(),
    optionType: input.optionType,
    strike: input.strike,
    expirationCalendarDate: expirationCalendarDate(input.expiration),
    contracts: input.contracts,
    campaignStatus: input.campaignStatus,
    campaignLifecycleStage: input.campaignLifecycleStage,
    accountSource: input.accountSource,
    brokerageMappingIdentity: input.brokerageMappingIdentity,
    appliedRollBufferPercent: input.appliedRollBufferPercent,
    evaluationPolicyVersion: input.evaluationPolicyVersion,
  });
}

/**
 * The four meaningful, persistable current actions - deliberately excludes CANNOT_ASSESS (see the
 * additive Prisma enum PositionReviewPersistedAction, which structurally enforces the same rule at
 * the database schema level).
 */
export type PositionReviewPersistedAction = "COMFORTABLE" | "WATCH" | "REVIEW_ROLL" | "REVIEW_CALL";

export function isPersistablePositionReviewAction(action: PositionReviewAction): action is PositionReviewPersistedAction {
  return action === "COMFORTABLE" || action === "WATCH" || action === "REVIEW_ROLL" || action === "REVIEW_CALL";
}

/** Additive CURRENT/LAST_VALID/UNAVAILABLE display discriminant for Phase 2 composition - defined
 * now, per the ticket, but NOT integrated into any UI/orchestration in this Phase 1. */
export type PositionAssessmentDisplayState = "CURRENT" | "LAST_VALID" | "UNAVAILABLE";

/**
 * The write-time bundle: identity/context plus the REAL evaluatePositionReview result for this
 * exact leg. Deliberately wraps the evaluator's own PositionReviewResult rather than re-deriving
 * action/evidence/distances independently - "existing position-review requirements satisfied" is
 * satisfied by construction, since this result comes from the one shared evaluator, never a second
 * parallel implementation.
 */
export type CurrentPositionAssessmentCandidate = {
  scope: PositionReviewAssessmentScope;
  context: PositionReviewContextFingerprintInput;
  result: PositionReviewResult;
  /** Original evaluator inputs; replayed, never reconstructed from rounded output. */
  evaluationInput: PositionReviewInput;
  /** Scope captured with the original evaluation, independently of the write target. */
  evaluationScope: PositionReviewAssessmentScope;
  /** The same regular-session evidence the evaluator itself validated this result's quote/session
   * against - carried alongside `result` (never re-fetched independently) purely so the
   * persistence layer can store the regular-session interval/NY session date without re-deriving
   * session lookup from a second, possibly-inconsistent evidence read. */
  sessionEvidence: EquityMarketSessionEvidence;
};

export type PositionReviewWriteIneligibleReason =
  | "INVALID_CLOCK"
  | "INVALID_SESSION_EVIDENCE"
  | "RESULT_CONTEXT_MISMATCH"
  | "NOT_MEANINGFUL_ACTION"
  | "POSITION_EVIDENCE_NOT_TRUSTED"
  | "QUOTE_NOT_ELIGIBLE"
  | "SESSION_NOT_OPEN"
  | "GUIDANCE_DEADLINE_MISSING"
  | "GUIDANCE_DEADLINE_EXPIRED"
  | "INCOMPLETE_DISTANCE_EVIDENCE";

export type PositionReviewWriteEligibility = { eligible: true } | { eligible: false; reasonCode: PositionReviewWriteIneligibleReason };

/**
 * Pure predicate: may this current evaluation be persisted as the latest-valid assessment for its
 * scoped leg? Every rejection path here corresponds 1:1 to a condition the ticket requires NEVER
 * write/overwrite from (Cannot assess, stale/after-hours/unavailable quote evidence, closed
 * session, ambiguous/unsupported position evidence, expired guidance). Manual positions are
 * accepted on exactly the same terms as Schwab-confirmed ones - this mirrors
 * evaluatePositionReview's own existing SCHWAB_CONFIRMED/MANUAL_POSITION equivalence (see its
 * `positionState !== "SCHWAB_CONFIRMED" && positionState !== "MANUAL_POSITION"` check) rather than
 * inventing a new manual-account rule.
 */
export function evaluatePositionReviewWriteEligibility(candidate: CurrentPositionAssessmentCandidate, now: Date): PositionReviewWriteEligibility {
  const { result } = candidate;

  if (!isPersistablePositionReviewAction(result.action)) {
    return { eligible: false, reasonCode: "NOT_MEANINGFUL_ACTION" };
  }
  if (result.evidence.position !== "SCHWAB_CONFIRMED" && result.evidence.position !== "MANUAL_POSITION") {
    return { eligible: false, reasonCode: "POSITION_EVIDENCE_NOT_TRUSTED" };
  }
  if (result.evidence.quote !== "ELIGIBLE") {
    return { eligible: false, reasonCode: "QUOTE_NOT_ELIGIBLE" };
  }
  if (result.evidence.session !== "OPEN") {
    return { eligible: false, reasonCode: "SESSION_NOT_OPEN" };
  }
  if (result.explanation.activeGuidanceDeadline === null) {
    return { eligible: false, reasonCode: "GUIDANCE_DEADLINE_MISSING" };
  }
  const validDate = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime());
  const e = result.explanation;
  if (!validDate(now) || !validDate(e.evaluatedAt) || !validDate(e.activeGuidanceDeadline) || now < e.evaluatedAt) {
    return { eligible: false, reasonCode: "INVALID_CLOCK" };
  }
  const session = candidate.sessionEvidence;
  if (session.status !== "AVAILABLE" || session.marketType !== "EQUITY" || session.product !== "EQ" || !session.isOpen ||
      session.requestedDate !== nyCalendarDateOf(e.evaluatedAt) || session.returnedDate !== session.requestedDate ||
      session.regularMarketIntervals.length === 0 || session.regularMarketIntervals.some(({ start, end }, index, intervals) =>
        !validDate(start) || !validDate(end) || start >= end || nyCalendarDateOf(start) !== session.returnedDate ||
        nyCalendarDateOf(end) !== session.returnedDate || (index > 0 && start < intervals[index - 1].end))) {
    return { eligible: false, reasonCode: "INVALID_SESSION_EVIDENCE" };
  }
  const interval = regularSessionIntervalContaining(session, e.evaluatedAt);
  const writeInterval = regularSessionIntervalContaining(session, now);
  if (!interval || !writeInterval || interval.start.getTime() !== writeInterval.start.getTime() || interval.end.getTime() !== writeInterval.end.getTime()) {
    return { eligible: false, reasonCode: "INVALID_SESSION_EVIDENCE" };
  }
  if (result.explanation.activeGuidanceDeadline.getTime() <= now.getTime()) {
    return { eligible: false, reasonCode: "GUIDANCE_DEADLINE_EXPIRED" };
  }
  if (
    result.explanation.stockPrice === null ||
    result.explanation.quoteTradeTime === null ||
    result.explanation.dollarDistance === null ||
    result.explanation.percentageDistance === null ||
    result.explanation.strike === null ||
    result.explanation.bufferPercent === null
  ) {
    return { eligible: false, reasonCode: "INCOMPLETE_DISTANCE_EVIDENCE" };
  }

  const { context: c, scope, evaluationInput: input } = candidate;
  const leg = input.leg;
  const quote = input.quote;
  if (!validDate(c.expiration) || !validDate(e.expiration) || !validDate(input.now) ||
      !sameScope(scope, c.scope) || !sameScope(scope, candidate.evaluationScope) ||
      input.now.getTime() !== e.evaluatedAt.getTime() ||
      input.campaignId !== scope.campaignId || input.accountId !== scope.accountId ||
      input.ticker !== c.ticker.toUpperCase() || input.lifecycleStage !== c.campaignLifecycleStage ||
      validatedBufferPercent(input.rollBufferPercent) !== c.appliedRollBufferPercent ||
      c.evaluationPolicyVersion !== POSITION_REVIEW_POLICY_VERSION ||
      leg.kind === "NONE" || leg.kind !== c.optionType || leg.strike !== c.strike || leg.contracts !== c.contracts ||
      !validDate(leg.expiration) || expirationCalendarDate(leg.expiration) !== expirationCalendarDate(c.expiration) ||
      JSON.stringify(input.session) !== JSON.stringify(session) ||
      (c.accountSource === "MANUAL" ? input.position.state !== "MANUAL_POSITION" : input.position.state !== "SCHWAB_CONFIRMED") ||
      quote.status !== "AVAILABLE" || quote.requestedSymbol !== c.ticker.toUpperCase() ||
      !validDate(quote.requestStartedAt) || !validDate(quote.responseReceivedAt) ||
      quote.requestStartedAt > quote.responseReceivedAt || quote.responseReceivedAt > e.evaluatedAt ||
      !evaluateQuoteEligibility(quote, session, now).eligible ||
      JSON.stringify(evaluatePositionReview(input)) !== JSON.stringify(result) ||
      !isPersistablePositionReviewAction(evaluatePositionReview({ ...input, now }).action)) {
    return { eligible: false, reasonCode: "RESULT_CONTEXT_MISMATCH" };
  }
  return { eligible: true };
}

/**
 * The typed, historical readback shape - deliberately its OWN type, never the live
 * PositionReviewResult/PositionReviewExplanation reused as if historical evidence were current.
 * Only ever produced by reading back a persisted PositionReviewAssessment row.
 */
export type StoredLastValidAssessment = {
  scope: PositionReviewAssessmentScope;
  contextFingerprint: string;
  action: PositionReviewPersistedAction;
  reasonCodes: string[];
  evaluatedAt: Date;
  nySessionDate: string;
  regularSessionStart: Date;
  regularSessionEnd: Date;
  underlyingPrice: number;
  underlyingTradeTime: Date;
  ticker: string;
  optionType: "PUT" | "CALL";
  strike: number;
  expiration: Date;
  contracts: number;
  moneyness: NonNullable<PositionReviewResult["explanation"]["moneyness"]>;
  dollarDistance: number;
  percentageDistance: number;
  appliedRollBufferPercent: number;
  positionEvidenceSource: PositionEvidenceState;
  brokerReceiptAt: Date | null;
  evaluationPolicyVersion: number;
};

/** The CURRENT resolved leg's own identity/context/lifecycle, as of the moment a stored assessment
 * is being considered for display - `null` when there is no current leg at all for this scope
 * (closed, rolled away, assigned-and-removed). Deliberately carries `positionEvidenceState` and
 * `lifecycle` as their OWN fields rather than folding them into the fingerprint: coverage
 * ambiguity and expiration/session-ended lifecycle must invalidate a stored fallback even when
 * every fingerprint input happens to still match. */
export type CurrentLegMatchContext = {
  scope: PositionReviewAssessmentScope;
  contextFingerprint: string;
  positionEvidenceState: PositionEvidenceState;
  lifecycle: PositionReviewLifecycle;
  /** Actual evaluator failure reasons. Unknown/new reasons deny fallback. */
  reasonCodes: readonly string[];
};

export type StoredAssessmentMatchInput = {
  stored: { scope: PositionReviewAssessmentScope; contextFingerprint: string };
  current: CurrentLegMatchContext | null;
};

export type HistoricalAssessmentIneligibleReason =
  | "FALLBACK_REASON_NOT_ALLOWED"
  | "NO_CURRENT_LEG"
  | "OWNER_MISMATCH"
  | "ACCOUNT_MISMATCH"
  | "CAMPAIGN_MISMATCH"
  | "OPENING_EVENT_CHANGED"
  | "CONTEXT_FINGERPRINT_CHANGED"
  | "EXPIRATION_LIFECYCLE_PRIMARY"
  | "COVERAGE_AMBIGUOUS_OR_UNSUPPORTED";

export type HistoricalAssessmentEligibility = { eligible: true } | { eligible: false; reasonCode: HistoricalAssessmentIneligibleReason };

/** Codex/ticket item 11 - once the current lifecycle reaches past-expiration or
 * expiration-session-ended, current expiration/assignment/confirmation state remains primary and a
 * historical Comfortable/Watch/Review assessment is never eligible to override it, even if its
 * fingerprint still matches (the position's own terms often do not change until the resolving
 * event - assignment/expiration - is actually recorded). */
const LIFECYCLE_STAGES_BLOCKING_FALLBACK: readonly PositionReviewLifecycle[] = ["EXPIRATION_PENDING", "EXPIRATION_SESSION_ENDED"];

/** NOT_ASSESSED also represents absent/wrong-contract/nonexact-quantity positions in
 * resolvePositionEvidence. No existing reason separates those from missing receipts: deny all.
 * Unknown states/reasons also deny. These codes are emitted by the existing evaluator. */
const ALLOWED_POSITION_STATES: readonly PositionEvidenceState[] = ["SCHWAB_CONFIRMED", "MANUAL_POSITION", "BROKER_UNAVAILABLE", "AWAITING_CONFIRMATION"];
const ALLOWED_FALLBACK_REASONS = new Set([
  "POSITION_BROKER_UNAVAILABLE", "POSITION_AWAITING_CONFIRMATION",
  "MARKET_CLOSED", "QUOTE_EVIDENCE_UNAVAILABLE", "QUOTE_STALE_TIMESTAMP", "QUOTE_SESSION_EVIDENCE_UNAVAILABLE",
]);

/**
 * Pure predicate: is a stored assessment still eligible to be shown as a LAST_VALID fallback for
 * the CURRENT resolved leg? Owner/account/campaign/openingEventId/context fingerprint must all
 * match exactly, the current leg must still exist, its lifecycle must not have reached
 * expiration-primacy, and its position evidence must not indicate a structural identity/coverage
 * problem. Old DB rows are never deleted merely because a roll/close occurred - they simply become
 * ineligible here and the persistence/read service returns null for them.
 */
export function evaluateHistoricalAssessmentEligibility(input: StoredAssessmentMatchInput): HistoricalAssessmentEligibility {
  const { stored, current } = input;

  if (!current) {
    return { eligible: false, reasonCode: "NO_CURRENT_LEG" };
  }
  if (stored.scope.ownerId !== current.scope.ownerId) {
    return { eligible: false, reasonCode: "OWNER_MISMATCH" };
  }
  if (stored.scope.accountId !== current.scope.accountId) {
    return { eligible: false, reasonCode: "ACCOUNT_MISMATCH" };
  }
  if (stored.scope.campaignId !== current.scope.campaignId) {
    return { eligible: false, reasonCode: "CAMPAIGN_MISMATCH" };
  }
  if (stored.scope.openingEventId !== current.scope.openingEventId) {
    return { eligible: false, reasonCode: "OPENING_EVENT_CHANGED" };
  }
  if (stored.contextFingerprint !== current.contextFingerprint) {
    return { eligible: false, reasonCode: "CONTEXT_FINGERPRINT_CHANGED" };
  }
  if (LIFECYCLE_STAGES_BLOCKING_FALLBACK.includes(current.lifecycle)) {
    return { eligible: false, reasonCode: "EXPIRATION_LIFECYCLE_PRIMARY" };
  }
  if (["POSITION_MISMATCH_AMBIGUOUS", "INSUFFICIENT_SHARE_COVERAGE", "UNSUPPORTED_CONTRACT_DELIVERABLE"].includes(current.positionEvidenceState)) {
    return { eligible: false, reasonCode: "COVERAGE_AMBIGUOUS_OR_UNSUPPORTED" };
  }

  if (!["CURRENT_PUT", "ROLLED_PUT", "COVERED_CALL"].includes(current.lifecycle) ||
      !ALLOWED_POSITION_STATES.includes(current.positionEvidenceState) ||
      current.reasonCodes.some((reason) => !ALLOWED_FALLBACK_REASONS.has(reason))) {
    return { eligible: false, reasonCode: "FALLBACK_REASON_NOT_ALLOWED" };
  }
  return { eligible: true };
}

/**
 * LST "Last Valid Position Assessment" - Phase 2A display composition. A current valid assessment
 * always wins; historical data is DISPLAY FALLBACK ONLY and is composed here from an ALREADY
 * fetched/verified `StoredLastValidAssessment` - this function never queries anything itself and
 * never re-derives eligibility (that remains evaluatePositionReviewWriteEligibility/
 * evaluateHistoricalAssessmentEligibility's own job, enforced by the orchestration service in
 * src/lib before it ever calls this composer).
 */
export type PositionAssessmentDisplay =
  | {
      state: "CURRENT";
      /** The real, live evaluatePositionReview result - never reconstructed. */
      current: PositionReviewResult;
      /** Present ONLY when a durable row was verified (freshly read back) as still valid during
       * THIS orchestration call - either because this exact evaluation was just persisted, or
       * because persisting it revealed a newer durable row already occupies the same scoped leg.
       * Null whenever persistence was not verified this call - a client must never be told a
       * fallback exists when it wasn't actually confirmed durable just now. */
      lastValid: StoredLastValidAssessment | null;
    }
  | {
      state: "LAST_VALID";
      /** The real CANNOT_ASSESS (or otherwise non-meaningful) current result explaining WHY
       * current guidance is unavailable - never reinterpreted, never discarded just because a
       * fallback exists. */
      currentUnavailable: PositionReviewResult;
      lastValid: StoredLastValidAssessment;
    }
  | {
      state: "UNAVAILABLE";
      currentUnavailable: PositionReviewResult;
    };

/**
 * Pure 3-way composition: CURRENT always wins when the live result is persistable/meaningful,
 * regardless of whether a fallback exists; otherwise LAST_VALID only when the caller already
 * verified (via evaluateHistoricalAssessmentEligibility, through getLastValidPositionAssessment)
 * that an exact-leg historical row is eligible; otherwise UNAVAILABLE. This is the ONE place the
 * three display states are decided - callers never branch on `current.action` themselves.
 */
export function composePositionAssessmentDisplay(args: {
  current: PositionReviewResult;
  verifiedFallback: StoredLastValidAssessment | null;
}): PositionAssessmentDisplay {
  if (isPersistablePositionReviewAction(args.current.action)) {
    return { state: "CURRENT", current: args.current, lastValid: args.verifiedFallback };
  }
  if (args.verifiedFallback) {
    return { state: "LAST_VALID", currentUnavailable: args.current, lastValid: args.verifiedFallback };
  }
  return { state: "UNAVAILABLE", currentUnavailable: args.current };
}

/**
 * Pure presentation-METADATA classification only (never rendered text) for how to later label a
 * stored assessment's `evaluatedAt` relative to `now`: the exact same TODAY/PREVIOUS_SESSION
 * tiering `classifyMarkFreshness` (marketCalendar.ts) already uses for CURRENT_SESSION/
 * LAST_SESSION - weekends and NYSE holidays correctly resolve Friday's close as the previous
 * session on a Saturday/Sunday "now", since `previousNyseMarketDay` already skips them. Never
 * claims PREVIOUS_SESSION unless the evaluated day actually IS the last completed NYSE market day
 * before `now`'s own calendar day - anything else (including a future or unparseable instant)
 * falls back to the honest, undated-claim-free OLDER tier. Phase 2B maps this to copy ("Last valid
 * today" / "Previous session" / "Last valid <date>") - this module never produces that text itself.
 */
export type LastValidTimingTier = "TODAY" | "PREVIOUS_SESSION" | "OLDER";

export function classifyLastValidTiming(evaluatedAt: Date, now: Date): LastValidTimingTier {
  if (!Number.isFinite(evaluatedAt.getTime()) || !Number.isFinite(now.getTime()) || evaluatedAt.getTime() > now.getTime()) {
    return "OLDER";
  }
  const today = marketDate(now);
  const evaluatedDay = marketDate(evaluatedAt);
  if (isNyseMarketDay(today) && evaluatedDay.getTime() === today.getTime()) {
    return "TODAY";
  }
  return evaluatedDay.getTime() === previousNyseMarketDay(today).getTime() ? "PREVIOUS_SESSION" : "OLDER";
}

/**
 * Phase 2B - the one place that picks "the live evaluator result to read factual/priority fields
 * from" regardless of which display state composePositionAssessmentDisplay produced.
 * daysToExpiration/priority/explanation all live on a real PositionReviewResult in EVERY state -
 * LAST_VALID/UNAVAILABLE's `currentUnavailable` is still a genuine live evaluation (action
 * CANNOT_ASSESS), never a reconstruction - so callers that only need those factual fields (sorting,
 * DTE display) never need to branch on `state` themselves.
 */
export function underlyingPositionReviewResult(display: PositionAssessmentDisplay): PositionReviewResult {
  return display.state === "CURRENT" ? display.current : display.currentUnavailable;
}
