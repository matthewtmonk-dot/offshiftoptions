import "server-only";

import { getCurrentOpenCall, getCurrentOpenPut, summarizeCampaign, type CampaignEventInput, type CampaignStatusInput } from "@/domain/finance/campaigns";
import { nyCalendarDateOf } from "@/domain/finance/marketSession";
import { formatOccSymbol, occContractKey } from "@/domain/finance/occOption";
import {
  evaluatePositionReview,
  sortPositionReviews,
  type PositionReviewInput,
  type PositionReviewLeg,
  type PositionReviewPositionInput,
  type PositionReviewResult,
} from "@/domain/finance/positionReview";
import {
  exactMatchedCallCampaignId,
  exactMatchedCampaignId,
  matchTrackedCall,
  matchTrackedPut,
  type TrackedCall,
  type TrackedPut,
} from "@/domain/finance/trackerPositionMatch";
import type { BrokerPosition } from "@/providers/broker-read/types";
import { getEquityMarketSessionEvidenceForUser, getQuoteReviewEvidenceForUser } from "./live-quotes";
import { getSchwabOpenPositionsForUser } from "./workflows";

/**
 * Dashboard V2 Phase 2 - the ONE place Dashboard and Tracker both call to get position-review
 * results, so the two pages can never disagree. Resolves live Schwab positions, quote-review
 * evidence, and equity market-session evidence for the requesting user once, then evaluates every
 * open/assigned campaign's CURRENT leg through the shared evaluatePositionReview. Never throws - a
 * broker/quote/session resolution failure becomes BROKER_UNAVAILABLE/UNAVAILABLE evidence for the
 * affected campaigns, never a thrown error that would blank the whole page.
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

export type ResolvedPositionReview = {
  campaignId: string;
  result: PositionReviewResult;
};

export async function resolvePositionReviewsForUser(
  userId: string,
  campaigns: PositionReviewCampaignInput[],
  accounts: PositionReviewAccountInput[],
  rollBufferPercent: number,
  now: Date = new Date(),
): Promise<ResolvedPositionReview[]> {
  const relevant = campaigns.filter((campaign) => campaign.status === "OPEN" || campaign.status === "ASSIGNED");
  if (relevant.length === 0) {
    return [];
  }

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
      legByCampaignId.set(campaign.id, { kind: "PUT", strike: openPut.strike, expiration: openPut.expiration });
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
      legByCampaignId.set(campaign.id, { kind: "CALL", strike: openCall.strike, expiration: openCall.expiration });
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
      legByCampaignId.set(campaign.id, { kind: "NONE" });
    }
    // An OPEN campaign with neither a recognizable open put nor a recognizable stage (e.g. a
    // legacy "Review needed" row with incomplete evidence) has no leg to review yet, and is
    // intentionally absent from legByCampaignId - never guessed into a leg it doesn't have.
  }

  const tickersNeedingQuotes = [
    ...new Set(relevant.filter((campaign) => legByCampaignId.get(campaign.id)?.kind !== "NONE" && legByCampaignId.has(campaign.id)).map((campaign) => campaign.ticker.toUpperCase())),
  ];

  const [brokerPositions, quoteEvidenceByTicker, sessionEvidence] = await Promise.all([
    getSchwabOpenPositionsForUser(userId).catch(() => null),
    getQuoteReviewEvidenceForUser(userId, tickersNeedingQuotes),
    getEquityMarketSessionEvidenceForUser(userId, nyCalendarDateOf(now)),
  ]);

  const results: ResolvedPositionReview[] = [];
  for (const campaign of relevant) {
    const leg = legByCampaignId.get(campaign.id);
    if (!leg) {
      continue;
    }
    const account = accounts.find((candidate) => candidate.id === campaign.accountId) ?? null;
    const position = resolvePositionEvidence({ userId, campaign, leg, account, accounts, brokerPositions, trackedPuts, trackedCalls, now });
    const quote =
      leg.kind === "NONE"
        ? ({ status: "UNAVAILABLE", reason: "No option leg to quote." } as const)
        : (quoteEvidenceByTicker.get(campaign.ticker.toUpperCase()) ?? ({ status: "UNAVAILABLE", reason: "Quote not requested." } as const));

    const input: PositionReviewInput = {
      campaignId: campaign.id,
      accountId: campaign.accountId,
      ticker: campaign.ticker,
      leg,
      lifecycleStage: lifecycleByCampaignId.get(campaign.id)!,
      rollBufferPercent,
      position,
      quote,
      session: sessionEvidence,
      now,
    };

    results.push({ campaignId: campaign.id, result: evaluatePositionReview(input) });
  }

  return results;
}

/** Convenience for callers (e.g. the Dashboard's "Positions to Review" table) that want the
 * results already in the ticket's deterministic priority order. */
export async function resolveSortedPositionReviewsForUser(
  userId: string,
  campaigns: PositionReviewCampaignInput[],
  accounts: PositionReviewAccountInput[],
  rollBufferPercent: number,
  now: Date = new Date(),
): Promise<ResolvedPositionReview[]> {
  const resolved = await resolvePositionReviewsForUser(userId, campaigns, accounts, rollBufferPercent, now);
  const sorted = sortPositionReviews(resolved.map((entry) => entry.result));
  const byCampaignId = new Map(resolved.map((entry) => [entry.campaignId, entry]));
  return sorted.map((result) => byCampaignId.get(result.priority.campaignId)!);
}

function resolvePositionEvidence({
  userId,
  campaign,
  leg,
  account,
  accounts,
  brokerPositions,
  trackedPuts,
  trackedCalls,
}: {
  userId: string;
  campaign: PositionReviewCampaignInput;
  leg: PositionReviewLeg;
  account: PositionReviewAccountInput | null;
  accounts: PositionReviewAccountInput[];
  brokerPositions: (BrokerPosition & { accountLabel: string })[] | null;
  trackedPuts: TrackedPut[];
  trackedCalls: TrackedCall[];
  now: Date;
}): PositionReviewPositionInput {
  // An owner-classified manual (non-Schwab-linked) account uses its own complete manual terms -
  // never inferred silently for an unmatched Schwab campaign (the ticket's own explicit rule).
  if (account?.source === "MANUAL") {
    return { state: "MANUAL_POSITION" };
  }
  if (brokerPositions === null) {
    return { state: "BROKER_UNAVAILABLE" };
  }
  if (leg.kind === "NONE" || leg.strike === null || leg.expiration === null || !account?.externalAccountId) {
    return { state: "NOT_ASSESSED" };
  }

  const occSymbol = formatOccSymbol(campaign.ticker, leg.expiration, leg.strike, leg.kind);
  const contractKey = occContractKey(occSymbol);
  const brokerRow = brokerPositions.find(
    (position) => position.accountId === account.externalAccountId && occContractKey(position.symbol) === contractKey,
  );
  if (!brokerRow) {
    return { state: "NOT_ASSESSED" };
  }

  const accountRows = accounts.map((a) => ({ id: a.id, userId: a.userId, externalAccountId: a.externalAccountId }));
  const matchState =
    leg.kind === "PUT"
      ? matchTrackedPut(userId, brokerRow, brokerPositions, accountRows, trackedPuts)
      : matchTrackedCall(userId, brokerRow, brokerPositions, accountRows, trackedCalls);

  if (matchState === "AMBIGUOUS") {
    return { state: "POSITION_MISMATCH_AMBIGUOUS" };
  }
  if (matchState !== "EXACT") {
    return { state: "NOT_ASSESSED" };
  }

  const confirmedId =
    leg.kind === "PUT"
      ? exactMatchedCampaignId(userId, brokerRow, brokerPositions, accountRows, trackedPuts)
      : exactMatchedCallCampaignId(userId, brokerRow, brokerPositions, accountRows, trackedCalls);
  if (confirmedId !== campaign.id) {
    // The broker position EXACTLY matches a DIFFERENT campaign - this campaign has no confirming
    // evidence of its own (never borrow another campaign's confirmation).
    return { state: "NOT_ASSESSED" };
  }
  if (!brokerRow.valuationAsOf) {
    // A genuine Schwab match, but with no known read time - never fabricate "now" as if the read
    // were fresh; the caller can't confirm the 5-minute freshness rule without a real timestamp.
    return { state: "NOT_ASSESSED" };
  }

  return { state: "SCHWAB_CONFIRMED", asOf: brokerRow.valuationAsOf };
}
