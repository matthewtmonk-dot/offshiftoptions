import "server-only";

import {
  composePositionAssessmentDisplay,
  computePositionReviewContextFingerprint,
  isPersistablePositionReviewAction,
  POSITION_REVIEW_POLICY_VERSION,
  type CurrentLegMatchContext,
  type CurrentPositionAssessmentCandidate,
  type PositionAssessmentDisplay,
  type PositionReviewAssessmentScope,
  type PositionReviewContextFingerprintInput,
} from "@/domain/finance/positionReviewAssessment";
import { validatedBufferPercent } from "@/domain/finance/positionReview";
import {
  resolvePositionReviewsForUser,
  type PositionReviewAccountInput,
  type PositionReviewCampaignInput,
  type ResolvedPositionReview,
} from "./position-review";
import { getLastValidPositionAssessment, getVerifiedPositionAssessmentForCurrentLeg, savePositionReviewAssessmentIfEligible } from "./positionReviewAssessmentStore";

/**
 * LST "Last Valid Position Assessment" - Phase 2A shared server-side orchestration. The ONE place
 * that composes a live evaluatePositionReview result and the Phase 1 durable-assessment store into
 * the CURRENT/LAST_VALID/UNAVAILABLE display model. Reuses resolvePositionReviewsForUser exactly
 * as-is for current-leg resolution/evaluation (never a second evaluator, never a re-derivation of
 * getCurrentOpenPut/getCurrentOpenCall/resolveRelevantCampaignLegs), and the approved Phase 1
 * predicates/service for every persistence and historical-match guarantee (owner auth, relational
 * validation, current-leg/context binding, newer-only concurrency-safe write, exact-leg owner-
 * scoped read) - none of those guarantees are re-implemented or weakened here.
 *
 * A current valid assessment always wins: CURRENT is returned whenever the live result is one of
 * the four meaningful actions, regardless of whether a historical fallback exists. Historical data
 * is attempted ONLY when the live result is CANNOT_ASSESS, and only through
 * evaluateHistoricalAssessmentEligibility's own existing allowlist (via getLastValidPositionAssessment)
 * - never a second, independently-invented interpretation of "transient" vs. "contradictory."
 *
 * No Dashboard/Tracker/badge wiring happens here (Phase 2B) - this module is pure orchestration.
 */

export type ResolvedPositionAssessmentDisplay = {
  campaignId: string;
  display: PositionAssessmentDisplay;
};

/**
 * Non-sensitive, structured diagnostic for a swallowed persistence failure - mirrors
 * broker-connections.ts's own logSchwabSyncFailure convention (stage/campaign/owner/timestamp
 * only, never the raw error or any evidence payload). A persistence problem is never allowed to
 * read as a current market/evaluation failure - see this module's own save-failure handling below.
 */
function logPersistenceDiagnostic(stage: string, context: { userId: string; campaignId: string }, error?: unknown) {
  console.error("[position-assessment-persistence]", {
    stage,
    userId: context.userId,
    campaignId: context.campaignId,
    hadError: error !== undefined,
    at: new Date().toISOString(),
  });
}

/**
 * Builds the exact-leg identity/context a resolved evaluation represents, or null when there is no
 * durable identity to scope by at all (no current leg, or the leg's own terms are incomplete - both
 * cases are already CANNOT_ASSESS by construction and have nothing a fingerprint could describe).
 */
function buildScopeAndContext(args: {
  userId: string;
  campaign: PositionReviewCampaignInput;
  account: PositionReviewAccountInput;
  entry: ResolvedPositionReview;
}): { scope: PositionReviewAssessmentScope; context: PositionReviewContextFingerprintInput } | null {
  const { userId, campaign, account, entry } = args;
  const { input, openingEventId } = entry;
  const leg = input.leg;
  if (!openingEventId || leg.kind === "NONE" || leg.strike === null || leg.expiration === null || leg.contracts === null) {
    return null;
  }

  const scope: PositionReviewAssessmentScope = { ownerId: userId, accountId: campaign.accountId, campaignId: campaign.id, openingEventId };
  const context: PositionReviewContextFingerprintInput = {
    scope,
    ticker: campaign.ticker,
    optionType: leg.kind,
    strike: leg.strike,
    expiration: leg.expiration,
    contracts: leg.contracts,
    campaignStatus: campaign.status,
    campaignLifecycleStage: input.lifecycleStage,
    accountSource: account.source,
    brokerageMappingIdentity: account.externalAccountId,
    appliedRollBufferPercent: validatedBufferPercent(input.rollBufferPercent),
    evaluationPolicyVersion: POSITION_REVIEW_POLICY_VERSION,
  };
  return { scope, context };
}

function matchContextFor(entry: ResolvedPositionReview, scope: PositionReviewAssessmentScope, context: PositionReviewContextFingerprintInput): CurrentLegMatchContext {
  return {
    scope,
    contextFingerprint: computePositionReviewContextFingerprint(context),
    positionEvidenceState: entry.result.evidence.position,
    lifecycle: entry.result.lifecycle,
    reasonCodes: entry.result.explanation.reasonCodes,
  };
}

async function resolveSingleDisplay(args: {
  userId: string;
  campaign: PositionReviewCampaignInput;
  account: PositionReviewAccountInput | null;
  entry: ResolvedPositionReview;
  clock: () => Date;
}): Promise<PositionAssessmentDisplay> {
  const { userId, campaign, account, entry, clock } = args;

  // Owner isolation (Buddy/Both) - a campaign that isn't the authenticated user's own never
  // touches the durable store in either direction. Its live CURRENT/CANNOT_ASSESS result passes
  // through unchanged (today's existing shared/public display semantics), but no private
  // historical snapshot is ever read or written on behalf of another owner. In practice a
  // non-owned campaign's position evidence already resolves to NOT_ASSESSED upstream (see
  // resolvePositionEvidence's own owner check), making its action CANNOT_ASSESS - this check is
  // explicit and independent of that incidental fact, never relying on it alone.
  const isOwnCampaign = campaign.ownerId === userId && account?.userId === userId;
  if (!isOwnCampaign) {
    return composePositionAssessmentDisplay({ current: entry.result, verifiedFallback: null });
  }

  const scoped = buildScopeAndContext({ userId, campaign, account, entry });
  if (!scoped) {
    return composePositionAssessmentDisplay({ current: entry.result, verifiedFallback: null });
  }
  const { scope, context } = scoped;
  const matchContext = matchContextFor(entry, scope, context);

  if (isPersistablePositionReviewAction(entry.result.action)) {
    const candidate: CurrentPositionAssessmentCandidate = {
      scope,
      context,
      result: entry.result,
      evaluationInput: entry.input,
      evaluationScope: scope,
      sessionEvidence: entry.sessionEvidence,
    };

    let verifiedDurable = false;
    try {
      const outcome = await savePositionReviewAssessmentIfEligible(userId, candidate, { clock });
      // SAVED: this exact evaluation is now the durable row. SUPERSEDED_BY_NEWER: a DIFFERENT
      // (newer) evaluation already occupies this scoped leg's row - still a verified durable row
      // for the exact same leg, just not necessarily this one's own numbers. Either way, a fresh
      // read below reports exactly what is actually stored, never an assumption.
      verifiedDurable = outcome.status === "SAVED" || outcome.status === "SUPERSEDED_BY_NEWER";
      if (outcome.status === "INELIGIBLE" || outcome.status === "CONTEXT_CHANGED" || outcome.status === "UNAUTHORIZED") {
        // Not every ineligible/changed outcome is a "failure" worth logging (INELIGIBLE is the
        // ordinary, frequent case for a result that merely isn't persist-eligible this instant) -
        // but CONTEXT_CHANGED/UNAUTHORIZED on what this orchestration believed was the owner's own
        // exact leg is unexpected and worth a non-alarming diagnostic.
        if (outcome.status !== "INELIGIBLE") {
          logPersistenceDiagnostic(`save:${outcome.status}`, { userId, campaignId: campaign.id });
        }
      }
    } catch (error) {
      // A persistence THROW must never be read as "current market guidance is unavailable" - the
      // live evaluation already succeeded and is returned below regardless. Only the optional
      // durable-fallback payload is affected (it stays null/not fabricated).
      logPersistenceDiagnostic("save:threw", { userId, campaignId: campaign.id }, error);
    }

    // Codex blocker repair (A) - this is the CURRENT read-back question ("does a durable row
    // exist for this exact leg"), never the true historical-fallback question - a persistable
    // CURRENT action's own reasonCodes (WITHIN_ROLL_BUFFER/PUT_AT_OR_ITM/etc.) must never be
    // checked against the transient-outage allowlist getLastValidPositionAssessment applies.
    const verifiedFallback = verifiedDurable
      ? await getVerifiedPositionAssessmentForCurrentLeg({ ownerId: userId, scope, current: matchContext }).catch((error) => {
          logPersistenceDiagnostic("read-after-save:threw", { userId, campaignId: campaign.id }, error);
          return null;
        })
      : null;

    return composePositionAssessmentDisplay({ current: entry.result, verifiedFallback });
  }

  // CANNOT_ASSESS - historical fallback is attempted ONLY through the approved classifier
  // (evaluateHistoricalAssessmentEligibility, invoked inside getLastValidPositionAssessment).
  // Never reinterpreted here: an unknown/contradictory current reason denies fallback there, not
  // in this orchestration layer.
  const verifiedFallback = await getLastValidPositionAssessment({ ownerId: userId, scope, current: matchContext }).catch((error) => {
    logPersistenceDiagnostic("read:threw", { userId, campaignId: campaign.id }, error);
    return null;
  });

  return composePositionAssessmentDisplay({ current: entry.result, verifiedFallback });
}

/**
 * The shared entry point: resolves every relevant campaign's CURRENT leg/evaluation exactly once
 * (via resolvePositionReviewsForUser), then - for the authenticated owner's own campaigns only -
 * persists an eligible CURRENT evaluation through the approved Phase 1 service and/or reads back an
 * eligible historical fallback, composing the final CURRENT/LAST_VALID/UNAVAILABLE display for
 * each campaign. A buddy/shared campaign (Mine/Buddy/Both) never touches the durable store in
 * either direction - see resolveSingleDisplay's own owner-isolation note.
 *
 * Query shape: one evaluatePositionReview per campaign (unchanged, via resolvePositionReviewsForUser),
 * plus AT MOST one persistence write-attempt and one historical read per OWN campaign whose result
 * is persist-eligible-or-not-yet-decided (CANNOT_ASSESS campaigns get exactly one read; persistable
 * campaigns get one write-attempt - itself a no-DB-access no-op when the pure write-eligibility
 * check already rejects it - plus one read only when that write verified a durable row). This is
 * proportional to the existing per-campaign evaluation loop, never a multiplicative blowup; Phase 1
 * exposes only an exact-leg getter (no batch API), so for a owner's typical small open-campaign
 * count this bounded number of reads is an acceptable V1 trade-off over premature batching -
 * documented here rather than silently assumed.
 */
export async function resolvePositionAssessmentDisplaysForUser(
  userId: string,
  campaigns: PositionReviewCampaignInput[],
  accounts: PositionReviewAccountInput[],
  rollBufferPercent: number,
  now: Date = new Date(),
  clock: () => Date = () => now,
  /** Codex blocker repair (C) - passed straight through to resolvePositionReviewsForUser; see its
   * own doc comment. */
  options: { skipLiveEvidence?: boolean } = {},
): Promise<ResolvedPositionAssessmentDisplay[]> {
  const resolved = await resolvePositionReviewsForUser(userId, campaigns, accounts, rollBufferPercent, now, clock, options);
  const campaignById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
  const accountById = new Map(accounts.map((account) => [account.id, account]));

  return Promise.all(
    resolved.map(async (entry): Promise<ResolvedPositionAssessmentDisplay> => {
      const campaign = campaignById.get(entry.campaignId)!;
      const account = accountById.get(campaign.accountId) ?? null;
      const display = await resolveSingleDisplay({ userId, campaign, account, entry, clock });
      return { campaignId: entry.campaignId, display };
    }),
  );
}
