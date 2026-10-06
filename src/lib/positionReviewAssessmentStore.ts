import "server-only";

import {
  computePositionReviewContextFingerprint,
  POSITION_REVIEW_POLICY_VERSION,
  evaluateHistoricalAssessmentEligibility,
  evaluatePositionReviewWriteEligibility,
  evaluateVerifiedCurrentAssessmentEligibility,
  type CurrentLegMatchContext,
  type CurrentPositionAssessmentCandidate,
  type PositionReviewAssessmentScope,
  type PositionReviewContextFingerprintInput,
  type PositionReviewWriteIneligibleReason,
  type StoredLastValidAssessment,
} from "@/domain/finance/positionReviewAssessment";
import { validatedBufferPercent, type PositionEvidenceState } from "@/domain/finance/positionReview";
import { nyCalendarDateOf, regularSessionIntervalContaining } from "@/domain/finance/marketSession";
import type { Prisma } from "@/generated/prisma/client";
import { resolveRelevantCampaignLegs } from "./position-review-scope";
import { toNumber } from "./format";
import { prisma } from "./prisma";

export type SavePositionReviewAssessmentResult =
  /** Written - this is now the latest-valid row for its scoped leg. */
  | { status: "SAVED" }
  | { status: "UNAUTHORIZED" }
  /** Write eligibility failed, either before DB access or at the final fresh-clock recheck. */
  | { status: "INELIGIBLE"; reasonCode: PositionReviewWriteIneligibleReason }
  /** Authoritative account/campaign/current-leg/policy disagrees with the evaluated context. */
  | { status: "CONTEXT_CHANGED" }
  /** A newer or equal-time evaluation (by evaluatedAt) already occupies this scoped leg's row - the DB-level
   * "only if newer" condition rejected this write. The ticket's own example: snapshot A evaluated
   * 10:05, B evaluated 10:06, B writes first, A arrives late - A lands here, never overwriting B. */
  | { status: "SUPERSEDED_BY_NEWER" };

/** Authenticated ownership, authoritative current leg and policy, and newer-only write
 * share one transaction. READ COMMITTED deliberately obtains fresh snapshots AFTER lock waits;
 * SERIALIZABLE can retain a pre-wait snapshot and miss a just-committed roll. Parent FOR UPDATE
 * locks block new child inserts through their FK key-share locks; existing children are locked
 * too. This protects the current context through the write without distributed locking.
 * Bounded transaction-conflict retries redo ALL checks.
 * Clock injection is for deterministic tests; production defaults to a fresh server Date. */
export async function savePositionReviewAssessmentIfEligible(
  authenticatedOwnerId: string,
  candidateInput: CurrentPositionAssessmentCandidate,
  options: { clock?: () => Date } = {},
): Promise<SavePositionReviewAssessmentResult> {
  const candidate = structuredClone(candidateInput);
  if (authenticatedOwnerId !== candidate.scope.ownerId) return { status: "UNAUTHORIZED" };
  const clock = options.clock ?? (() => new Date());
  const initial = evaluatePositionReviewWriteEligibility(candidate, clock());
  if (!initial.eligible) return { status: "INELIGIBLE", reasonCode: initial.reasonCode };
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async (tx): Promise<SavePositionReviewAssessmentResult> => {
        const { scope } = candidate;
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${authenticatedOwnerId} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "TradingAccount" WHERE "id" = ${scope.accountId} AND "userId" = ${authenticatedOwnerId} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "Campaign" WHERE "id" = ${scope.campaignId} AND "ownerId" = ${authenticatedOwnerId} AND "accountId" = ${scope.accountId} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "UserSettings" WHERE "userId" = ${authenticatedOwnerId} FOR UPDATE`;
        await tx.$queryRaw`SELECT e."id" FROM "CampaignEvent" e JOIN "Campaign" c ON c."id" = e."campaignId"
          WHERE c."id" = ${scope.campaignId} AND c."ownerId" = ${authenticatedOwnerId} AND c."accountId" = ${scope.accountId} FOR SHARE OF e`;
        const account = await tx.tradingAccount.findFirst({ where: { id: scope.accountId, userId: authenticatedOwnerId } });
        const campaign = await tx.campaign.findFirst({ where: { id: scope.campaignId, ownerId: authenticatedOwnerId, accountId: scope.accountId }, include: { events: true } });
        const settings = await tx.userSettings.findUnique({ where: { userId: authenticatedOwnerId } });
        if (!account || !campaign || !campaign.events.some(event => event.id === scope.openingEventId)) return { status: "CONTEXT_CHANGED" };
        // No more awaited reads below this point: construct authoritative context at write time.
        const now = clock();
        const eligibility = evaluatePositionReviewWriteEligibility(candidate, now);
        if (!eligibility.eligible) return { status: "INELIGIBLE", reasonCode: eligibility.reasonCode };
        const resolved = resolveRelevantCampaignLegs([campaign], now);
        const leg = resolved.legByCampaignId.get(campaign.id);
        const stage = resolved.lifecycleByCampaignId.get(campaign.id);
        if (!leg || leg.kind === "NONE" || leg.strike === null || leg.expiration === null || leg.contracts === null || !stage ||
            resolved.openingEventIdByCampaignId.get(campaign.id) !== scope.openingEventId) return { status: "CONTEXT_CHANGED" };
        const authoritative: PositionReviewContextFingerprintInput = {
          scope, ticker: campaign.ticker, optionType: leg.kind, strike: leg.strike,
          expiration: leg.expiration, contracts: leg.contracts, campaignStatus: campaign.status,
          campaignLifecycleStage: stage, accountSource: account.source,
          brokerageMappingIdentity: account.externalAccountId,
          appliedRollBufferPercent: validatedBufferPercent(settings ? toNumber(settings.rollBufferPercent) : NaN),
          evaluationPolicyVersion: POSITION_REVIEW_POLICY_VERSION,
        };
        const fingerprint = computePositionReviewContextFingerprint(authoritative);
        if (fingerprint !== computePositionReviewContextFingerprint(candidate.context)) return { status: "CONTEXT_CHANGED" };
        const affected = await executeNewerOnlyUpsert(tx, candidate, fingerprint);
        return affected > 0 ? { status: "SAVED" } : { status: "SUPERSEDED_BY_NEWER" };
      }, { isolationLevel: "ReadCommitted" });
    } catch (error) {
      // Prisma 7's pg adapter nests SQLSTATE under driverAdapterError.cause.
      const failure = error as { code?: string; meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string; code?: string } } } } | null;
      const cause = failure?.meta?.driverAdapterError?.cause;
      const sqlState = failure?.meta?.code ?? cause?.originalCode ?? cause?.code;
      const retryable = failure?.code === "P2034" ||
        (failure?.code === "P2010" && (sqlState === "40001" || sqlState === "40P01"));
      if (attempt < 2 && retryable) continue;
      throw error;
    }
  }
}

/**
 * A single native Postgres UPSERT (INSERT ... ON CONFLICT DO UPDATE ... WHERE existing.evaluatedAt
 * < excluded.evaluatedAt), targeting the table's own natural compound primary key
 * (ownerId, accountId, campaignId, openingEventId) directly - the exact same "newer-only" pattern
 * already proven in earnings-calendar-cache.ts's buildUpsertQuery, adapted with a WHERE clause so a
 * late-arriving OLDER evaluation can never overwrite a newer one already written. Returns the
 * number of rows actually inserted or updated (0 means the WHERE condition rejected the write -
 * SUPERSEDED_BY_NEWER - never an error). Equal evaluatedAt is intentionally first-writer-wins.
 */
function executeNewerOnlyUpsert(tx: Prisma.TransactionClient, candidate: CurrentPositionAssessmentCandidate, contextFingerprint: string) {
  const { scope, context, result, sessionEvidence } = candidate;
  const explanation = result.explanation;
  const interval = regularSessionIntervalContaining(sessionEvidence, explanation.evaluatedAt);
  if (!interval) throw new Error("Assessment session validation failed");

  return tx.$executeRaw`
    INSERT INTO "PositionReviewAssessment" (
      "ownerId", "accountId", "campaignId", "openingEventId", "contextFingerprint",
      "action", "reasonCodes", "moneyness",
      "evaluatedAt", "nySessionDate", "regularSessionStart", "regularSessionEnd",
      "underlyingPrice", "underlyingTradeTime",
      "ticker", "optionType", "strike", "expiration", "contracts",
      "dollarDistance", "percentageDistance", "appliedRollBufferPercent",
      "positionEvidenceSource", "brokerReceiptAt", "evaluationPolicyVersion",
      "updatedAt"
    ) VALUES (
      ${scope.ownerId}, ${scope.accountId}, ${scope.campaignId}, ${scope.openingEventId}, ${contextFingerprint},
      ${result.action}::"PositionReviewPersistedAction", ${explanation.reasonCodes}::text[], ${explanation.moneyness}::"PositionReviewMoneyness",
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
      "moneyness" = EXCLUDED."moneyness",
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
  moneyness: StoredLastValidAssessment["moneyness"];
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
    moneyness: row.moneyness,
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
 * Shared owner-scoped fetch: retrieves the raw stored row for an exact scoped leg (or null), never
 * applying any eligibility predicate itself - both `getLastValidPositionAssessment` and
 * `getVerifiedPositionAssessmentForCurrentLeg` below fetch through this one path and apply their
 * own, DIFFERENT eligibility question to the same row, rather than duplicating the Prisma fetch/
 * row-mapping. `ownerId` must come from the caller's own authenticated session; it is asserted
 * against `scope.ownerId` so a mismatched scope (e.g. built from the wrong owner's campaign) fails
 * loudly rather than silently querying someone else's data. Owner isolation is enforced at the
 * QUERY level (ownerId is part of the compound primary key itself, not an application-side
 * post-filter) - never by component visibility, shared/Buddy-view access, ticker, or campaign alone.
 */
async function fetchStoredAssessmentRow(ownerId: string, scope: PositionReviewAssessmentScope) {
  if (ownerId !== scope.ownerId) {
    throw new Error("fetchStoredAssessmentRow: ownerId does not match scope.ownerId - refusing a cross-owner read.");
  }

  return prisma.positionReviewAssessment.findUnique({
    where: {
      ownerId_accountId_campaignId_openingEventId: {
        ownerId: scope.ownerId,
        accountId: scope.accountId,
        campaignId: scope.campaignId,
        openingEventId: scope.openingEventId,
      },
    },
  });
}

/**
 * Owner-scoped read: retrieves the candidate last-valid assessment for an exact scoped leg,
 * verifies it against the CURRENT resolved leg's own identity/context/lifecycle AND the
 * reasonCodes-vs-allowed-transient-outage allowlist (via evaluateHistoricalAssessmentEligibility),
 * and returns typed historical data or null - never a presentation string. This is the TRUE
 * historical-fallback question: only reached when CURRENT is CANNOT_ASSESS. See
 * getVerifiedPositionAssessmentForCurrentLeg below for the separate CURRENT-read-back question,
 * which must never reuse this function's reasonCodes allowlist (Codex blocker repair A).
 */
export async function getLastValidPositionAssessment(args: {
  ownerId: string;
  scope: PositionReviewAssessmentScope;
  current: CurrentLegMatchContext | null;
}): Promise<StoredLastValidAssessment | null> {
  const row = await fetchStoredAssessmentRow(args.ownerId, args.scope);
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

/**
 * Codex blocker repair (A) - owner-scoped read for the CURRENT read-back question only: "does a
 * durable row still exist for the exact leg I just persisted (or that a newer write now occupies),
 * safe to attach as CURRENT.lastValid?" Gates on evaluateVerifiedCurrentAssessmentEligibility
 * (identity/lifecycle/coverage safety only) - deliberately never the reasonCodes-vs-allowed-
 * transient-outage allowlist `getLastValidPositionAssessment` applies, since a persistable CURRENT
 * action's own reasonCodes (WITHIN_ROLL_BUFFER/PUT_AT_OR_ITM/etc.) are ordinary action reasons,
 * never outage reasons, and must never be checked against that allowlist.
 */
export async function getVerifiedPositionAssessmentForCurrentLeg(args: {
  ownerId: string;
  scope: PositionReviewAssessmentScope;
  current: CurrentLegMatchContext | null;
}): Promise<StoredLastValidAssessment | null> {
  const row = await fetchStoredAssessmentRow(args.ownerId, args.scope);
  if (!row) {
    return null;
  }

  const eligibility = evaluateVerifiedCurrentAssessmentEligibility({
    stored: { scope: args.scope, contextFingerprint: row.contextFingerprint },
    current: args.current,
  });
  if (!eligibility.eligible) {
    return null;
  }

  return rowToStoredLastValidAssessment(row as unknown as PositionReviewAssessmentRow);
}
