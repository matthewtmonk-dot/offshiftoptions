import "server-only";

import {
  computePositionReviewContextFingerprint,
  evaluateHistoricalAssessmentEligibility,
  evaluatePositionReviewWriteEligibility,
  type CurrentLegMatchContext,
  type CurrentPositionAssessmentCandidate,
  type PositionReviewAssessmentScope,
  type PositionReviewContextFingerprintInput,
  type PositionReviewWriteIneligibleReason,
  type StoredLastValidAssessment,
} from "@/domain/finance/positionReviewAssessment";
import type { PositionEvidenceState } from "@/domain/finance/positionReview";
import { nyCalendarDateOf, regularSessionIntervalContaining } from "@/domain/finance/marketSession";
import { toNumber } from "./format";
import { prisma } from "./prisma";

/**
 * LST "Last Valid Position Assessment" - Phase 1 durable persistence/read service. This is the
 * ONLY place that reads or writes PositionReviewAssessment rows. Every responsibility here is
 * thin I/O composed around the pure predicates in domain/finance/positionReviewAssessment.ts - no
 * eligibility/matching LOGIC lives in this file, and no presentation text is ever produced here.
 * Deliberately imports nothing from workflows.ts (and workflows.ts never needs to import this file
 * either) so a future Phase 2 shared evaluation service can sit between the two without creating a
 * cycle - see position-review-scope.ts's own doc comment for the same layering concern.
 */

export type SavePositionReviewAssessmentResult =
  /** Written - this is now the latest-valid row for its scoped leg. */
  | { status: "SAVED" }
  /** The pure write-eligibility predicate rejected this evaluation before any DB access occurred. */
  | { status: "INELIGIBLE"; reasonCode: PositionReviewWriteIneligibleReason }
  /** The caller-supplied fresh recheck found the leg/context had changed since the evaluation was
   * computed (a roll, a close, a policy change) - never written. */
  | { status: "CONTEXT_CHANGED" }
  /** A newer evaluation (by evaluatedAt) already occupies this scoped leg's row - the DB-level
   * "only if newer" condition rejected this write. The ticket's own example: snapshot A evaluated
   * 10:05, B evaluated 10:06, B writes first, A arrives late - A lands here, never overwriting B. */
  | { status: "SUPERSEDED_BY_NEWER" };

/**
 * Saves `candidate` as the latest-valid assessment for its scoped leg, but ONLY when every one of
 * the following holds:
 *   1. The pure write-eligibility predicate accepts it (meaningful action, eligible quote, open
 *      session, valid unexpired guidance deadline, complete distance evidence - see
 *      evaluatePositionReviewWriteEligibility's own doc comment for the full list).
 *   2. `verifyFreshContext` - supplied by the caller, which alone knows how to re-resolve the
 *      CURRENT campaign/account/policy state (this phase does not wire that orchestration; a
 *      Phase 2 caller re-runs resolveRelevantCampaignLegs + its own account/policy lookups) -
 *      returns a context whose fingerprint still matches `candidate.context`'s. This is the
 *      "recheck current leg/context before committing" the ticket requires - a real, fresh
 *      re-verification against current state, never a bare AbortSignal check.
 *   3. The DB-level newer-only upsert actually applies - `evaluatedAt` on any existing row for this
 *      exact scoped leg must be strictly older than `candidate.result.explanation.evaluatedAt`, or
 *      there must be no existing row at all. This is enforced by Postgres itself via
 *      `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE <existing is older>`, never by
 *      read-then-write application logic that a second concurrent writer could race.
 */
export async function savePositionReviewAssessmentIfEligible(
  candidate: CurrentPositionAssessmentCandidate,
  now: Date,
  options: { verifyFreshContext: () => Promise<PositionReviewContextFingerprintInput | null> },
): Promise<SavePositionReviewAssessmentResult> {
  const eligibility = evaluatePositionReviewWriteEligibility(candidate, now);
  if (!eligibility.eligible) {
    return { status: "INELIGIBLE", reasonCode: eligibility.reasonCode };
  }

  const expectedFingerprint = computePositionReviewContextFingerprint(candidate.context);
  const freshContext = await options.verifyFreshContext();
  if (!freshContext || computePositionReviewContextFingerprint(freshContext) !== expectedFingerprint) {
    return { status: "CONTEXT_CHANGED" };
  }

  const affected = await executeNewerOnlyUpsert(candidate, expectedFingerprint);
  return affected > 0 ? { status: "SAVED" } : { status: "SUPERSEDED_BY_NEWER" };
}

/**
 * A single native Postgres UPSERT (INSERT ... ON CONFLICT DO UPDATE ... WHERE existing.evaluatedAt
 * < excluded.evaluatedAt), targeting the table's own natural compound primary key
 * (ownerId, accountId, campaignId, openingEventId) directly - the exact same "newer-only" pattern
 * already proven in earnings-calendar-cache.ts's buildUpsertQuery, adapted with a WHERE clause so a
 * late-arriving OLDER evaluation can never overwrite a newer one already written. Returns the
 * number of rows actually inserted or updated (0 means the WHERE condition rejected the write -
 * SUPERSEDED_BY_NEWER - never an error).
 */
function executeNewerOnlyUpsert(candidate: CurrentPositionAssessmentCandidate, contextFingerprint: string) {
  const { scope, context, result, sessionEvidence } = candidate;
  const explanation = result.explanation;
  // Write-eligibility already required evidence.session === "OPEN", so a containing interval is
  // guaranteed to exist in practice; the evaluatedAt fallback is defensive only (never reachable
  // through the public savePositionReviewAssessmentIfEligible entry point).
  const interval = regularSessionIntervalContaining(sessionEvidence, explanation.evaluatedAt) ?? { start: explanation.evaluatedAt, end: explanation.evaluatedAt };

  return prisma.$executeRaw`
    INSERT INTO "PositionReviewAssessment" (
      "ownerId", "accountId", "campaignId", "openingEventId", "contextFingerprint",
      "action", "reasonCodes",
      "evaluatedAt", "nySessionDate", "regularSessionStart", "regularSessionEnd",
      "underlyingPrice", "underlyingTradeTime",
      "ticker", "optionType", "strike", "expiration", "contracts",
      "dollarDistance", "percentageDistance", "appliedRollBufferPercent",
      "positionEvidenceSource", "brokerReceiptAt", "evaluationPolicyVersion",
      "updatedAt"
    ) VALUES (
      ${scope.ownerId}, ${scope.accountId}, ${scope.campaignId}, ${scope.openingEventId}, ${contextFingerprint},
      ${result.action}::"PositionReviewPersistedAction", ${explanation.reasonCodes}::text[],
      ${explanation.evaluatedAt}, ${nyCalendarDateOf(explanation.evaluatedAt)}, ${interval.start}, ${interval.end},
      ${explanation.stockPrice}, ${explanation.quoteTradeTime},
      ${context.ticker.toUpperCase()}, ${context.optionType}::"OptionType", ${explanation.strike}, ${context.expiration}, ${context.contracts},
      ${explanation.dollarDistance}, ${explanation.percentageDistance}, ${explanation.bufferPercent},
      ${result.evidence.position}, ${explanation.positionEvidenceAsOf}, ${context.evaluationPolicyVersion},
      ${explanation.evaluatedAt}
    )
    ON CONFLICT ("ownerId", "accountId", "campaignId", "openingEventId") DO UPDATE SET
      "contextFingerprint" = EXCLUDED."contextFingerprint",
      "action" = EXCLUDED."action",
      "reasonCodes" = EXCLUDED."reasonCodes",
      "evaluatedAt" = EXCLUDED."evaluatedAt",
      "nySessionDate" = EXCLUDED."nySessionDate",
      "regularSessionStart" = EXCLUDED."regularSessionStart",
      "regularSessionEnd" = EXCLUDED."regularSessionEnd",
      "underlyingPrice" = EXCLUDED."underlyingPrice",
      "underlyingTradeTime" = EXCLUDED."underlyingTradeTime",
      "ticker" = EXCLUDED."ticker",
      "optionType" = EXCLUDED."optionType",
      "strike" = EXCLUDED."strike",
      "expiration" = EXCLUDED."expiration",
      "contracts" = EXCLUDED."contracts",
      "dollarDistance" = EXCLUDED."dollarDistance",
      "percentageDistance" = EXCLUDED."percentageDistance",
      "appliedRollBufferPercent" = EXCLUDED."appliedRollBufferPercent",
      "positionEvidenceSource" = EXCLUDED."positionEvidenceSource",
      "brokerReceiptAt" = EXCLUDED."brokerReceiptAt",
      "evaluationPolicyVersion" = EXCLUDED."evaluationPolicyVersion",
      "updatedAt" = EXCLUDED."updatedAt"
    WHERE "PositionReviewAssessment"."evaluatedAt" < EXCLUDED."evaluatedAt"
  `;
}

type PositionReviewAssessmentRow = {
  ownerId: string;
  accountId: string;
  campaignId: string;
  openingEventId: string;
  contextFingerprint: string;
  action: string;
  reasonCodes: string[];
  evaluatedAt: Date;
  nySessionDate: string;
  regularSessionStart: Date;
  regularSessionEnd: Date;
  underlyingPrice: unknown;
  underlyingTradeTime: Date;
  ticker: string;
  optionType: string;
  strike: unknown;
  expiration: Date;
  contracts: number;
  dollarDistance: unknown;
  percentageDistance: unknown;
  appliedRollBufferPercent: unknown;
  positionEvidenceSource: string;
  brokerReceiptAt: Date | null;
  evaluationPolicyVersion: number;
};

function rowToStoredLastValidAssessment(row: PositionReviewAssessmentRow): StoredLastValidAssessment {
  return {
    scope: { ownerId: row.ownerId, accountId: row.accountId, campaignId: row.campaignId, openingEventId: row.openingEventId },
    contextFingerprint: row.contextFingerprint,
    action: row.action as StoredLastValidAssessment["action"],
    reasonCodes: row.reasonCodes,
    evaluatedAt: row.evaluatedAt,
    nySessionDate: row.nySessionDate,
    regularSessionStart: row.regularSessionStart,
    regularSessionEnd: row.regularSessionEnd,
    underlyingPrice: toNumber(row.underlyingPrice),
    underlyingTradeTime: row.underlyingTradeTime,
    ticker: row.ticker,
    optionType: row.optionType as "PUT" | "CALL",
    strike: toNumber(row.strike),
    expiration: row.expiration,
    contracts: row.contracts,
    dollarDistance: toNumber(row.dollarDistance),
    percentageDistance: toNumber(row.percentageDistance),
    appliedRollBufferPercent: toNumber(row.appliedRollBufferPercent),
    positionEvidenceSource: row.positionEvidenceSource as PositionEvidenceState,
    brokerReceiptAt: row.brokerReceiptAt,
    evaluationPolicyVersion: row.evaluationPolicyVersion,
  };
}

/**
 * Owner-scoped read: retrieves the candidate last-valid assessment for an exact scoped leg,
 * verifies it against the CURRENT resolved leg's own identity/context/lifecycle (via
 * evaluateHistoricalAssessmentEligibility), and returns typed historical data or null - never a
 * presentation string. `ownerId` must come from the caller's own authenticated session; it is
 * asserted against `scope.ownerId` so a mismatched scope (e.g. built from the wrong owner's
 * campaign) fails loudly rather than silently querying someone else's data. Owner isolation is
 * enforced at the QUERY level (ownerId is part of the compound primary key itself, not an
 * application-side post-filter) - never by component visibility, shared/Buddy-view access, ticker,
 * or campaign alone.
 */
export async function getLastValidPositionAssessment(args: {
  ownerId: string;
  scope: PositionReviewAssessmentScope;
  current: CurrentLegMatchContext | null;
}): Promise<StoredLastValidAssessment | null> {
  if (args.ownerId !== args.scope.ownerId) {
    throw new Error("getLastValidPositionAssessment: ownerId does not match scope.ownerId - refusing a cross-owner read.");
  }

  const row = await prisma.positionReviewAssessment.findUnique({
    where: {
      ownerId_accountId_campaignId_openingEventId: {
        ownerId: args.scope.ownerId,
        accountId: args.scope.accountId,
        campaignId: args.scope.campaignId,
        openingEventId: args.scope.openingEventId,
      },
    },
  });
  if (!row) {
    return null;
  }

  const eligibility = evaluateHistoricalAssessmentEligibility({
    stored: { scope: args.scope, contextFingerprint: row.contextFingerprint },
    current: args.current,
  });
  if (!eligibility.eligible) {
    return null;
  }

  return rowToStoredLastValidAssessment(row as unknown as PositionReviewAssessmentRow);
}
