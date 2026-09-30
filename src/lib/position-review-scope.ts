import "server-only";

import {
  getCurrentOpenCall,
  getCurrentOpenPut,
  getIncompleteOpenCallTerms,
  getIncompleteOpenPutTerms,
  getOpenCallEvidenceState,
  getOpenPutEvidenceState,
  summarizeCampaign,
  type CampaignEventInput,
  type CampaignStatusInput,
} from "@/domain/finance/campaigns";
import type { PositionReviewLeg } from "@/domain/finance/positionReview";
import type { TrackedCall, TrackedPut } from "@/domain/finance/trackerPositionMatch";

/**
 * Codex UX follow-up (universal "Refresh status" control) - the campaign-leg-scoping step, pulled
 * out into its own lower-level file (rather than living in position-review.ts, which itself imports
 * from workflows.ts) so workflows.ts's own refreshPositionEvidenceForUser can import it too without
 * creating a circular module dependency (workflows.ts -> position-review.ts -> workflows.ts).
 * position-review.ts re-exports these same symbols for its own existing callers - there is exactly
 * ONE implementation, never two independently-maintained answers to "which campaigns/tickers
 * currently need review evidence."
 */
export type PositionReviewCampaignInput = {
  id: string;
  ownerId: string;
  accountId: string;
  ticker: string;
  status: CampaignStatusInput;
  events: CampaignEventInput[];
};

export type PositionReviewAccountInput = {
  id: string;
  userId: string;
  externalAccountId: string | null;
  source: "MANUAL" | "SCHWAB";
};

export type RelevantCampaignLegs = {
  relevant: PositionReviewCampaignInput[];
  legByCampaignId: Map<string, PositionReviewLeg>;
  lifecycleByCampaignId: Map<string, ReturnType<typeof summarizeCampaign>["currentStage"]>;
  trackedPuts: TrackedPut[];
  trackedCalls: TrackedCall[];
};

/** Pure/no I/O - identical to resolvePositionReviewsForUser's own former inline loop, moved here
 * verbatim (see position-review.ts's own history) so it has exactly one implementation. */
export function resolveRelevantCampaignLegs(campaigns: PositionReviewCampaignInput[], now: Date): RelevantCampaignLegs {
  const relevant = campaigns.filter((campaign) => campaign.status === "OPEN" || campaign.status === "ASSIGNED");

  const legByCampaignId = new Map<string, PositionReviewLeg>();
  const lifecycleByCampaignId = new Map<string, ReturnType<typeof summarizeCampaign>["currentStage"]>();
  const trackedPuts: TrackedPut[] = [];
  const trackedCalls: TrackedCall[] = [];

  for (const campaign of relevant) {
    const summary = summarizeCampaign({ events: campaign.events, status: campaign.status, asOf: now });
    lifecycleByCampaignId.set(campaign.id, summary.currentStage);

    const openPut = getCurrentOpenPut(campaign.events);
    const openCall = getCurrentOpenCall(campaign.events);

    if (openPut) {
      legByCampaignId.set(campaign.id, { kind: "PUT", strike: openPut.strike, expiration: openPut.expiration, contracts: openPut.contracts });
      trackedPuts.push({
        id: campaign.id,
        ownerId: campaign.ownerId,
        accountId: campaign.accountId,
        ticker: campaign.ticker,
        status: campaign.status,
        strike: openPut.strike,
        expiration: openPut.expiration,
        contracts: openPut.contracts,
      });
    } else if (openCall) {
      legByCampaignId.set(campaign.id, { kind: "CALL", strike: openCall.strike, expiration: openCall.expiration, contracts: openCall.contracts });
      trackedCalls.push({
        id: campaign.id,
        ownerId: campaign.ownerId,
        accountId: campaign.accountId,
        ticker: campaign.ticker,
        status: campaign.status,
        strike: openCall.strike,
        expiration: openCall.expiration,
        contracts: openCall.contracts,
      });
    } else if (campaign.status === "ASSIGNED") {
      // Codex P1 (B6) - an incomplete call record must survive as a CANNOT_ASSESS leg, never
      // silently collapse into "no call at all" (which would wrongly read as "Assigned shares -
      // review next step" instead of the real "incomplete call evidence" state).
      const callEvidenceState = getOpenCallEvidenceState(campaign.events);
      if (callEvidenceState === "INCOMPLETE") {
        const partial = getIncompleteOpenCallTerms(campaign.events);
        legByCampaignId.set(campaign.id, {
          kind: "CALL",
          strike: partial?.strike ?? null,
          expiration: partial?.expiration ?? null,
          contracts: partial?.contracts ?? null,
        });
      } else {
        legByCampaignId.set(campaign.id, { kind: "NONE" });
      }
    } else if (campaign.status === "OPEN") {
      // Codex P1 (B6) - an OPEN campaign whose last trade event DOES attempt to open a put, but
      // whose own terms are incomplete, must also survive as a CANNOT_ASSESS leg rather than
      // vanishing from the review set entirely. A genuinely put-less "Review needed" campaign (no
      // open-attempt event at all) still has no leg to review - that stage is already surfaced by
      // the Dashboard's own factual row, independent of this evaluator.
      if (getOpenPutEvidenceState(campaign.events) === "INCOMPLETE") {
        const partial = getIncompleteOpenPutTerms(campaign.events);
        legByCampaignId.set(campaign.id, {
          kind: "PUT",
          strike: partial?.strike ?? null,
          expiration: partial?.expiration ?? null,
          contracts: partial?.contracts ?? null,
        });
      }
    }
  }

  return { relevant, legByCampaignId, lifecycleByCampaignId, trackedPuts, trackedCalls };
}

/** The exact ticker set resolvePositionReviewsForUser itself requests quote evidence for - a
 * campaign counts only when it has a real (non-"NONE") current leg. Shared by
 * refreshPositionEvidenceForUser so it can force-refresh precisely these tickers, never more. */
export function tickersNeedingReviewQuotes(relevant: PositionReviewCampaignInput[], legByCampaignId: Map<string, PositionReviewLeg>): string[] {
  return [
    ...new Set(relevant.filter((campaign) => legByCampaignId.get(campaign.id)?.kind !== "NONE" && legByCampaignId.has(campaign.id)).map((campaign) => campaign.ticker.toUpperCase())),
  ];
}
