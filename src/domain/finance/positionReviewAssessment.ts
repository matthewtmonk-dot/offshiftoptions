import type { EquityMarketSessionEvidence } from "@/providers/market-data/types";
import { expirationCalendarDate } from "./marketSession";
import type { PositionEvidenceState, PositionReviewAction, PositionReviewLifecycle, PositionReviewResult } from "./positionReview";

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
  /** The same regular-session evidence the evaluator itself validated this result's quote/session
   * against - carried alongside `result` (never re-fetched independently) purely so the
   * persistence layer can store the regular-session interval/NY session date without re-deriving
   * session lookup from a second, possibly-inconsistent evidence read. */
  sessionEvidence: EquityMarketSessionEvidence;
};

export type PositionReviewWriteIneligibleReason =
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
};

export type StoredAssessmentMatchInput = {
  stored: { scope: PositionReviewAssessmentScope; contextFingerprint: string };
  current: CurrentLegMatchContext | null;
};

export type HistoricalAssessmentIneligibleReason =
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

/** Ticket item 10 - a structural position-interpretation problem (ambiguous match, insufficient or
 * unprovable covered-call coverage) invalidates a stored fallback regardless of fingerprint match.
 * Deliberately excludes BROKER_UNAVAILABLE/AWAITING_CONFIRMATION/NOT_ASSESSED - those are exactly
 * the transient evidence gaps this whole feature exists to fall back through, not a changed
 * position. */
const POSITION_STATES_BLOCKING_FALLBACK: readonly PositionEvidenceState[] = ["POSITION_MISMATCH_AMBIGUOUS", "INSUFFICIENT_SHARE_COVERAGE", "UNSUPPORTED_CONTRACT_DELIVERABLE"];

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
  if (POSITION_STATES_BLOCKING_FALLBACK.includes(current.positionEvidenceState)) {
    return { eligible: false, reasonCode: "COVERAGE_AMBIGUOUS_OR_UNSUPPORTED" };
  }

  return { eligible: true };
}
