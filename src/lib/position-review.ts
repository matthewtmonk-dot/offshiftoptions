import "server-only";

import { OPTION_MULTIPLIER } from "@/domain/finance/campaigns";
import type { EquityMarketSessionEvidence, QuoteReviewEvidence } from "@/providers/market-data/types";
import { nyCalendarDateOf } from "@/domain/finance/marketSession";
import { formatOccSymbol, occContractKey, parseOccOptionSymbol } from "@/domain/finance/occOption";
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
import {
  resolveRelevantCampaignLegs,
  tickersNeedingReviewQuotes,
  type PositionReviewAccountInput,
  type PositionReviewCampaignInput,
  type RelevantCampaignLegs,
} from "./position-review-scope";
import { getSchwabOpenPositionsForUser } from "./workflows";

/**
 * Dashboard V2 Phase 2 - the ONE place Dashboard and Tracker both call to get position-review
 * results, so the two pages can never disagree. Resolves live Schwab positions, quote-review
 * evidence, and equity market-session evidence for the requesting user once, then evaluates every
 * open/assigned campaign's CURRENT leg through the shared evaluatePositionReview. Never throws - a
 * broker/quote/session resolution failure becomes BROKER_UNAVAILABLE/UNAVAILABLE evidence for the
 * affected campaigns, never a thrown error that would blank the whole page.
 *
 * The campaign-leg-scoping step (resolveRelevantCampaignLegs/tickersNeedingReviewQuotes) lives in
 * position-review-scope.ts, re-exported below for this module's own existing callers - see that
 * file's own doc comment for why (workflows.ts's refreshPositionEvidenceForUser needs the exact
 * same logic without creating a circular import with this file, which itself imports from
 * workflows.ts).
 */
export type { PositionReviewAccountInput, PositionReviewCampaignInput, RelevantCampaignLegs };
export { resolveRelevantCampaignLegs, tickersNeedingReviewQuotes };

export type ResolvedPositionReview = {
  campaignId: string;
  result: PositionReviewResult;
  /** LST Last-Valid-Position-Assessment Phase 2A - the exact evaluatePositionReview input used to
   * produce `result`, carried alongside it (never reconstructed from the result's own rounded
   * output) so the orchestration layer (positionAssessmentOrchestration.ts) can bind a persistence
   * candidate's context to this identical evaluation without a second, independent evaluation. */
  input: PositionReviewInput;
  /** The resolved regular-session evidence this evaluation actually used - carried alongside
   * `result` for the same reason as `input` above (Phase 1's persistence service needs it to
   * derive the stored regular-session interval). */
  sessionEvidence: EquityMarketSessionEvidence;
  /** The originating OPENING CampaignEvent.id for this campaign's current leg (from
   * resolveRelevantCampaignLegs's own openingEventIdByCampaignId map) - null when there is no
   * current leg, or the leg's own terms are incomplete. The durable scoped-identity component
   * Phase 1 persistence requires; never inferred independently here. */
  openingEventId: string | null;
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
  /**
   * Codex blocker repair (C) - `skipLiveEvidence: true` skips the three live Schwab/market-data
   * calls below entirely (zero network/provider calls) and treats evidence as uniformly
   * unavailable instead. Used ONLY right after a manual refresh attempt genuinely failed (see
   * workflows.ts's refreshPositionEvidenceForUserGuarded/RefreshStatusControl) - that attempt
   * already cleared the relevant caches, so a normal re-render would otherwise MISS cache and
   * make a second real provider call for the same click. This reuses the EXACT existing
   * BROKER_UNAVAILABLE code path (`resolvePositionEvidence`'s own `brokerPositions === null`
   * branch below) a genuine Schwab outage already takes - not a new rule, and if anything more
   * conservative than most real partial outages (quote/session are forced unavailable too, not
   * just broker positions). Every Phase 1 contradiction protection (past-expiration, assigned-
   * shares-no-call, opening-event/context-fingerprint mismatch) comes from resolveRelevantCampaignLegs'
   * read of this app's own CampaignEvent ledger, never from live broker data - completely
   * unaffected by this mode.
   */
  options: { skipLiveEvidence?: boolean } = {},
): Promise<ResolvedPositionReview[]> {
  const { relevant, legByCampaignId, lifecycleByCampaignId, trackedPuts, trackedCalls, openingEventIdByCampaignId } = resolveRelevantCampaignLegs(campaigns, now);
  if (relevant.length === 0) {
    return [];
  }

  const tickersNeedingQuotes = tickersNeedingReviewQuotes(relevant, legByCampaignId);
  const requestedNyDate = nyCalendarDateOf(now);

  let brokerPositions: (BrokerPosition & { accountLabel: string })[] | null;
  let quoteEvidenceByTicker: Map<string, QuoteReviewEvidence>;
  let sessionEvidenceAsRequested: EquityMarketSessionEvidence;
  if (options.skipLiveEvidence) {
    brokerPositions = null;
    quoteEvidenceByTicker = new Map();
    sessionEvidenceAsRequested = { status: "UNAVAILABLE", reason: "Live evidence skipped - resolving from durable historical data only." };
  } else {
    [brokerPositions, quoteEvidenceByTicker, sessionEvidenceAsRequested] = await Promise.all([
      getSchwabOpenPositionsForUser(userId).catch(() => null),
      getQuoteReviewEvidenceForUser(userId, tickersNeedingQuotes),
      getEquityMarketSessionEvidenceForUser(userId, requestedNyDate),
    ]);
  }

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

    results.push({
      campaignId: campaign.id,
      result: evaluatePositionReview(input),
      input,
      sessionEvidence,
      openingEventId: openingEventIdByCampaignId.get(campaign.id) ?? null,
    });
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
  callShareCoverageByCampaignId: Map<string, CallShareCoverageOutcome>;
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
  if (leg.kind === "CALL") {
    const coverage = callShareCoverageByCampaignId.get(campaign.id);
    if (coverage === "UNSUPPORTED_CONTRACT_DELIVERABLE") {
      return { state: "UNSUPPORTED_CONTRACT_DELIVERABLE" };
    }
    if (coverage !== "COVERED") {
      return { state: "INSUFFICIENT_SHARE_COVERAGE" };
    }
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

/** Codex P2 (B, round 3) - `computeCallShareCoverage`'s per-campaign outcome. `COVERED` is the
 * only outcome that may ever receive "covered call" active guidance; both other outcomes fail
 * closed to CANNOT_ASSESS, but are kept distinct so the caller (and its tests) can tell "the
 * share math itself doesn't add up / is ambiguous" apart from "the deliverable can never be
 * proven, regardless of what the share math says." */
type CallShareCoverageOutcome = "COVERED" | "INSUFFICIENT_SHARE_COVERAGE" | "UNSUPPORTED_CONTRACT_DELIVERABLE";

/**
 * Codex P1 (B5) / Codex P2 (B, rounds 2-3) - proves underlying-share coverage for every currently
 * -open covered call, at the complete owner+account+underlying allocation level - never
 * per-campaign in isolation, since two campaigns can each independently record their own "open
 * call" while actually competing for the SAME real broker-held shares. Every campaign in a
 * competing group maps to the SAME outcome - no first-campaign-wins allocation, no partial credit.
 *
 * Codex P2 (B, round 3) - BROKER POSITION DATA IS AUTHORITATIVE for each contract's actual current
 * short-call obligation quantity, full stop. The group's total obligation is now built ENTIRELY
 * from broker-visible short-call rows' own `Math.abs(quantity)` - a tracked campaign's own claimed
 * `contracts` field is NEVER substituted into this total, not even for a broker row that DOES
 * match a tracked campaign's contract key. (Round 2's approach of summing tracked campaigns' own
 * `contracts` for their matching rows, and only broker quantity for the rest, undercounted the
 * group's real obligation whenever a tracked campaign's claimed count disagreed with what the
 * broker actually reports for that same contract - e.g. campaign claims 1, broker reports -3: the
 * real obligation is 3, not 1, and every OTHER campaign in the group must see the real number.) A
 * tracked campaign's own `contracts` field is used only upstream, by trackerPositionMatch.ts's
 * exact-quantity check, to decide whether THAT campaign's own identity match is confirmed - it
 * plays no role in this function's group-wide obligation total.
 *
 * Duplicate broker rows for the identical OCC contract key are never summed - this app has no
 * verified provider evidence that Schwab ever legitimately reports the same contract as separate
 * additive lots, so a duplicate is treated as AMBIGUOUS and the whole group fails closed.
 *
 * A group fails closed (`INSUFFICIENT_SHARE_COVERAGE`) whenever: the account/share evidence can't
 * be resolved at all; a duplicate same-contract broker row exists; any broker short-call row's
 * quantity is not a positive finite number; more than one broker equity row exists for the same
 * account+underlying (no verified provider semantics support summing separate rows); or the one
 * equity row's quantity is not a positive real long-share count.
 *
 * Codex P2 (B, round 3) - CRITICAL, and checked independently of the above: OCC symbol syntax
 * alone never proves a contract's actual deliverable is a standard 100 shares (see
 * BrokerPosition.sharesPerContract's own doc comment - adjusted/nonstandard deliverables can
 * exist, and this app has no live diagnostic confirming a trustworthy multiplier field exists in
 * Schwab's provider response today). If ANY broker short-call row contributing to a group's
 * obligation lacks a PROVEN `sharesPerContract === 100`, the entire group resolves to
 * `UNSUPPORTED_CONTRACT_DELIVERABLE` - never `COVERED`, regardless of how the share arithmetic
 * would otherwise come out. This is intentionally the dominant, most commonly reached outcome in
 * production today, since no normalizer currently populates `sharesPerContract` at all: this is
 * acceptable fail-closed behavior, not a bug - see the ticket's own instruction not to infer a
 * standard deliverable from symbol formatting, and not to invent evidence that doesn't exist.
 */
function computeCallShareCoverage(
  trackedCalls: TrackedCall[],
  brokerPositions: (BrokerPosition & { accountLabel: string })[] | null,
  accounts: PositionReviewAccountInput[],
): Map<string, CallShareCoverageOutcome> {
  const coverageByCampaignId = new Map<string, CallShareCoverageOutcome>();
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
    const externalAccountId = account?.externalAccountId;
    if (!externalAccountId) {
      for (const call of calls) coverageByCampaignId.set(call.id, "INSUFFICIENT_SHARE_COVERAGE");
      continue;
    }

    const shortCallPositions = brokerPositions.filter(
      (position) => position.accountId === externalAccountId && isShortCallPositionForUnderlying(position, ticker!),
    );

    // Codex P2 (B, round 3) - duplicate rows for the SAME OCC contract are ambiguous, never
    // blindly summed - this app has no verified provider evidence that Schwab legitimately
    // reports the same contract as separate additive lots.
    const contractKeyCounts = new Map<string, number>();
    for (const position of shortCallPositions) {
      const contractKey = occContractKey(position.symbol);
      if (contractKey !== null) {
        contractKeyCounts.set(contractKey, (contractKeyCounts.get(contractKey) ?? 0) + 1);
      }
    }
    let obligationUnresolvable = [...contractKeyCounts.values()].some((count) => count > 1);

    let totalShortCallContracts = 0;
    let multiplierProven = true;
    for (const position of shortCallPositions) {
      const positionContracts = Math.abs(position.quantity);
      // Defensive only - isShortCallPositionForUnderlying above already requires a finite, negative
      // `quantity` before a row reaches this loop at all, so `positionContracts` is always a finite
      // positive number here in practice. Kept in case that upstream guarantee ever changes.
      if (!Number.isFinite(positionContracts) || positionContracts <= 0) {
        obligationUnresolvable = true;
        continue;
      }
      totalShortCallContracts += positionContracts;
      // Codex P2 (B, round 3) - OCC symbol shape (checked upstream by isShortCallPositionForUnderlying
      // via parseOccOptionSymbol) proves the symbol is well-formed, never that the deliverable is a
      // standard 100 shares. Only an explicit, provider-verified `sharesPerContract === 100` proves it.
      if (position.sharesPerContract !== 100) {
        multiplierProven = false;
      }
    }

    // Codex P2 (B) - never a first-match `.find()`: multiple broker equity rows for the same
    // account+underlying are ambiguous (this app has no verified provider semantics establishing
    // they safely sum to one real holding) and fail closed rather than guessing.
    const equityPositions = brokerPositions.filter(
      (position) => position.accountId === externalAccountId && isEquitySharePosition(position, ticker!),
    );

    let outcome: CallShareCoverageOutcome;
    if (!multiplierProven) {
      outcome = "UNSUPPORTED_CONTRACT_DELIVERABLE";
    } else if (obligationUnresolvable || equityPositions.length !== 1) {
      outcome = "INSUFFICIENT_SHARE_COVERAGE";
    } else {
      const shares = equityPositions[0]!.quantity;
      const totalSharesNeeded = totalShortCallContracts * OPTION_MULTIPLIER;
      const covers = Number.isFinite(shares) && shares > 0 && totalSharesNeeded <= shares;
      outcome = covers ? "COVERED" : "INSUFFICIENT_SHARE_COVERAGE";
    }

    for (const call of calls) {
      coverageByCampaignId.set(call.id, outcome);
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

/** Codex P2 (B) - any SHORT call option position on `ticker`, tracked by a campaign or not.
 * Prefers Schwab's own `putCall`/`underlyingSymbol` fields (the most authoritative signal, per
 * BrokerPosition's own doc comments); falls back to OCC symbol parsing only when those fields are
 * absent. A position must genuinely be short (negative quantity) - a long call is never a
 * short-call obligation against the underlying shares. */
function isShortCallPositionForUnderlying(position: BrokerPosition, ticker: string): boolean {
  if (!(position.quantity < 0) || !Number.isFinite(position.quantity)) {
    return false;
  }
  const parsed = parseOccOptionSymbol(position.symbol);
  const underlying = position.underlyingSymbol?.trim().toUpperCase() || parsed?.underlying || null;
  if (underlying !== ticker.toUpperCase()) {
    return false;
  }
  if (position.putCall) {
    return position.putCall === "CALL";
  }
  return parsed?.optionType === "CALL";
}
