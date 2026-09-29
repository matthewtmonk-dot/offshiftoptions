import "server-only";

import {
  getCurrentOpenCall,
  getCurrentOpenPut,
  getIncompleteOpenCallTerms,
  getIncompleteOpenPutTerms,
  getOpenCallEvidenceState,
  getOpenPutEvidenceState,
  OPTION_MULTIPLIER,
  summarizeCampaign,
  type CampaignEventInput,
  type CampaignStatusInput,
} from "@/domain/finance/campaigns";
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
  /**
   * Codex P1 (B8) - `now` above is read by the CALLER before this function's own async evidence
   * retrieval even starts (it also drives which NY calendar date to REQUEST session evidence
   * for); it must never also stand in for the instant evaluation actually happens once that
   * retrieval completes. `clock` is called exactly once, AFTER every quote/session/broker fetch
   * resolves, to obtain the real evaluation time - defaulting to `() => now` so every existing
   * caller/test that only supplies `now` keeps its exact prior deterministic behavior; a
   * production caller that wants genuine post-retrieval timing passes `() => new Date()`.
   */
  clock: () => Date = () => now,
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
      // Codex P1 (B6) - an incomplete call record must survive as a CANNOT_ASSESS leg, never
      // silently collapse into "no call at all" (which would wrongly read as "Assigned shares -
      // review next step" instead of the real "incomplete call evidence" state).
      const callEvidenceState = getOpenCallEvidenceState(campaign.events);
      if (callEvidenceState === "INCOMPLETE") {
        const partial = getIncompleteOpenCallTerms(campaign.events);
        legByCampaignId.set(campaign.id, { kind: "CALL", strike: partial?.strike ?? null, expiration: partial?.expiration ?? null });
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
        legByCampaignId.set(campaign.id, { kind: "PUT", strike: partial?.strike ?? null, expiration: partial?.expiration ?? null });
      }
    }
  }

  const tickersNeedingQuotes = [
    ...new Set(relevant.filter((campaign) => legByCampaignId.get(campaign.id)?.kind !== "NONE" && legByCampaignId.has(campaign.id)).map((campaign) => campaign.ticker.toUpperCase())),
  ];

  const requestedNyDate = nyCalendarDateOf(now);
  const [brokerPositions, quoteEvidenceByTicker, sessionEvidenceAsRequested] = await Promise.all([
    getSchwabOpenPositionsForUser(userId).catch(() => null),
    getQuoteReviewEvidenceForUser(userId, tickersNeedingQuotes),
    getEquityMarketSessionEvidenceForUser(userId, requestedNyDate),
  ]);

  // Codex P1 (B8) - the REAL evaluation instant, read only now that every async fetch above has
  // actually resolved - never the `now` captured before this function started retrieving
  // anything. A quote/position genuinely observed WHILE this retrieval was in flight must be
  // judged against the moment evaluation actually happens, not an earlier instant it could
  // otherwise appear to be "from the future" relative to.
  const evaluationTime = clock();

  // Codex P1 (B8) - if the NY calendar date advanced between requesting session evidence and
  // actually evaluating (a request spanning NY midnight), the evidence we already fetched is for
  // the WRONG date - reusing it would silently misjudge session-membership/expiration-day state.
  // Smallest safe choice: fail closed to UNAVAILABLE rather than re-fetching or guessing.
  const sessionEvidence =
    sessionEvidenceAsRequested.status === "AVAILABLE" && sessionEvidenceAsRequested.returnedDate !== nyCalendarDateOf(evaluationTime)
      ? ({
          status: "UNAVAILABLE",
          reason: `Requested market-session evidence for ${requestedNyDate}, but evaluation happened on ${nyCalendarDateOf(evaluationTime)} - never reusing evidence for the wrong NY date.`,
        } as const)
      : sessionEvidenceAsRequested;

  // Codex P1 (B5) - computed ONCE across every competing covered-call campaign sharing the same
  // owner+account+underlying, never per-campaign in isolation (see computeCallShareCoverage).
  const callShareCoverageByCampaignId = computeCallShareCoverage(trackedCalls, brokerPositions, accounts);

  const results: ResolvedPositionReview[] = [];
  for (const campaign of relevant) {
    const leg = legByCampaignId.get(campaign.id);
    if (!leg) {
      continue;
    }
    const account = accounts.find((candidate) => candidate.id === campaign.accountId) ?? null;
    const position = resolvePositionEvidence({ userId, campaign, leg, account, accounts, brokerPositions, trackedPuts, trackedCalls, callShareCoverageByCampaignId });
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
      now: evaluationTime,
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
  clock: () => Date = () => now,
): Promise<ResolvedPositionReview[]> {
  const resolved = await resolvePositionReviewsForUser(userId, campaigns, accounts, rollBufferPercent, now, clock);
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
  callShareCoverageByCampaignId,
}: {
  userId: string;
  campaign: PositionReviewCampaignInput;
  leg: PositionReviewLeg;
  account: PositionReviewAccountInput | null;
  accounts: PositionReviewAccountInput[];
  brokerPositions: (BrokerPosition & { accountLabel: string })[] | null;
  trackedPuts: TrackedPut[];
  trackedCalls: TrackedCall[];
  callShareCoverageByCampaignId: Map<string, boolean>;
}): PositionReviewPositionInput {
  // Codex P1 (B7) - CRITICAL: active review guidance (a manual-account bypass, a Schwab broker
  // match, or the buffer-driven moneyness math this evidence state ultimately gates) is only ever
  // computed for the AUTHENTICATED VIEWER's own campaign on their own account. A buddy/shared
  // campaign passed into this same batch call (Tracker's Buddy/Both scope) must resolve to
  // NOT_ASSESSED here regardless of its account's source - it must never silently borrow the
  // viewer's own manual-bypass, broker connection, or roll-buffer setting. This check runs BEFORE
  // every other branch below, including the manual-account bypass.
  if (campaign.ownerId !== userId || account?.userId !== userId) {
    return { state: "NOT_ASSESSED" };
  }
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
  // Codex P1 (B5) - the call's own CONTRACT matching exactly (above) proves identity, never share
  // coverage. A short call backed by too few (or unverifiable) broker-held shares must never
  // receive "covered call" guidance, regardless of how cleanly its own contract matched.
  if (leg.kind === "CALL" && callShareCoverageByCampaignId.get(campaign.id) !== true) {
    return { state: "INSUFFICIENT_SHARE_COVERAGE" };
  }
  // Codex P1 (B1) - freshness is about WHEN WE READ this position, not the provider's own
  // (currently always-null, and conceptually unrelated) valuation timestamp. `valuationAsOf`
  // answers "as of when is this price true"; `positionReadReceivedAt` answers "when did our own
  // fetch actually complete" - only the latter can prove the ticket's 5-minute broker-freshness
  // rule. A missing OR non-finite receipt time is never fabricated as "now."
  const receivedAt = brokerRow.positionReadReceivedAt;
  if (!receivedAt || !Number.isFinite(receivedAt.getTime())) {
    return { state: "NOT_ASSESSED" };
  }

  return { state: "SCHWAB_CONFIRMED", asOf: receivedAt };
}

/**
 * Codex P1 (B5) - proves underlying-share coverage for every currently-open covered call, at the
 * complete owner+account+underlying allocation level - never per-campaign in isolation, since two
 * campaigns can each independently record their own "open call" while actually competing for the
 * SAME real broker-held shares (e.g. two ASSIGNED campaigns tracking separate lots of the same
 * ticker in the same account). Returns `true` for a campaign's id only when its entire competing
 * group's aggregate share need fits within the actual broker-held share count for that
 * owner+account+underlying; every other campaign in that same group maps to `false` too - no
 * first-campaign-wins allocation, no partial credit. A group whose broker share position can't be
 * resolved at all (missing account/external id, or no matching equity position) fails closed to
 * `false` for every campaign in it, since coverage cannot be proven.
 */
function computeCallShareCoverage(
  trackedCalls: TrackedCall[],
  brokerPositions: (BrokerPosition & { accountLabel: string })[] | null,
  accounts: PositionReviewAccountInput[],
): Map<string, boolean> {
  const coverageByCampaignId = new Map<string, boolean>();
  if (brokerPositions === null || trackedCalls.length === 0) {
    return coverageByCampaignId;
  }

  const groups = new Map<string, TrackedCall[]>();
  for (const call of trackedCalls) {
    const key = `${call.ownerId}|${call.accountId}|${call.ticker.trim().toUpperCase()}`;
    const group = groups.get(key);
    if (group) {
      group.push(call);
    } else {
      groups.set(key, [call]);
    }
  }

  for (const [key, calls] of groups) {
    const [, accountId, ticker] = key.split("|");
    const account = accounts.find((candidate) => candidate.id === accountId);
    const sharePosition = account?.externalAccountId
      ? brokerPositions.find((position) => position.accountId === account.externalAccountId && isEquitySharePosition(position, ticker!))
      : undefined;

    const coversAll =
      sharePosition !== undefined &&
      Number.isFinite(sharePosition.quantity) &&
      sharePosition.quantity > 0 &&
      calls.reduce((sum, call) => sum + call.contracts * OPTION_MULTIPLIER, 0) <= sharePosition.quantity;

    for (const call of calls) {
      coverageByCampaignId.set(call.id, coversAll);
    }
  }

  return coverageByCampaignId;
}

/** A real equity (stock) position for `ticker` - never an option contract on the same underlying.
 * Prefers Schwab's own `assetType` when present; falls back to "not an OCC-parseable option
 * symbol" when absent, mirroring BrokerPosition.putCall's own documented fallback convention. */
function isEquitySharePosition(position: BrokerPosition, ticker: string): boolean {
  if (position.symbol.trim().toUpperCase() !== ticker.toUpperCase()) {
    return false;
  }
  if (position.assetType) {
    return position.assetType === "EQUITY";
  }
  return occContractKey(position.symbol) === null;
}
