/**
 * Covered Call scanner (Covered Call Phase 4, see PROJECT_HANDOFF.md) - a deliberately SEPARATE
 * selection path from the CSP live scanner (live-scan.ts), not a generalization of it. This is
 * NOT a market-wide scanner: the universe is only the authenticated user's own ASSIGNED campaigns
 * with shares actually available to cover a call. The primary question it answers is "what
 * covered call can I sell against shares I already own, preferably at or above my adjusted
 * basis, using roughly weekly expirations" - not "which stock should I trade."
 *
 * Reused verbatim from the CSP scanner (option-type-agnostic, unmodified): weeklyHorizonFor,
 * expirationWindowFor, compareExpirations, passesEnabledGate, WEEKLY_TARGET_DTE. Reused verbatim
 * from prior Covered Call phases: summarizeCampaign, getCurrentOpenCall,
 * describeCallStrikeVsAdjustedBasis, computeCoveredCallRollStatus. Never reuses bestPutValues,
 * cashSecuredReturnOnRisk, or CSP's OTM definition (strike < price) - a covered call's basis-safe
 * definition is strike >= adjustedBasis, not moneyness, and its return is against adjusted basis
 * or current stock value, not cash-secured collateral.
 */
import {
  describeCallStrikeVsAdjustedBasis,
  getCurrentOpenCall,
  summarizeCampaign,
  type CallStrikeBasisRelationship,
  type CampaignEventInput,
  type CampaignStatusInput,
  type CurrentOpenCall,
} from "../finance/campaigns";
import { annualizedReturnOnRisk, bidAskSpreadPercent, daysToExpiration, optionContractValue, round } from "../finance/calculations";
import { computeCoveredCallRollStatus, type RollStatus } from "../finance/rollStatus";
import { compareExpirations, expirationWindowFor, weeklyHorizonFor, WEEKLY_TARGET_DTE } from "./live-scan";
import { evaluateCriterion, type CriterionResult, type ScannerRule } from "./scanner";
import type { OptionContractSnapshot } from "@/providers/market-data/types";

export { expirationWindowFor, weeklyHorizonFor, WEEKLY_TARGET_DTE };

/** Compact shortlist caps - "do not overload the page with dozens of strikes." */
const MAX_BASIS_SAFE_SHOWN = 4;
const MAX_BELOW_BASIS_SHOWN = 2;
const LIQUIDITY_RULE_KEYS = ["optionBid", "openInterest", "spreadPercent", "optionVolume"] as const;

export type CoveredCallCampaignReasonCode =
  | "NO_SHARES_AVAILABLE"
  | "FULLY_COVERED"
  | "PRICE_UNAVAILABLE"
  | "CHAIN_UNAVAILABLE"
  | "NO_CALL_CONTRACTS"
  | "NO_CONTRACT_WITH_POSITIVE_BID"
  | "NO_EXPIRATIONS_IN_CONFIGURED_RANGE"
  | "NO_WEEKLY_EXPIRATION"
  | "NO_BASIS_SAFE_WEEKLY_CALL";

const REASON_MESSAGES: Record<CoveredCallCampaignReasonCode, string> = {
  NO_SHARES_AVAILABLE: "No assigned shares are currently available for covered calls.",
  FULLY_COVERED: "Shares already covered by an open call.",
  PRICE_UNAVAILABLE: "Current stock price is unavailable.",
  CHAIN_UNAVAILABLE: "Option-chain data was unavailable for this ticker.",
  NO_CALL_CONTRACTS: "Schwab's option chain for this ticker contained no call contracts.",
  NO_CONTRACT_WITH_POSITIVE_BID: "Option chain returned, but no call had a positive bid.",
  NO_EXPIRATIONS_IN_CONFIGURED_RANGE: "No call matched your configured DTE range.",
  NO_WEEKLY_EXPIRATION: "No suitable weekly expiration available.",
  NO_BASIS_SAFE_WEEKLY_CALL: "No weekly call strike is available at or above your adjusted basis.",
};

export function reasonMessage(code: CoveredCallCampaignReasonCode): string {
  return REASON_MESSAGES[code];
}

export type CoveredCallCandidate = {
  strike: number;
  expiration: string;
  dte: number;
  bid: number;
  ask: number;
  openInterest: number | null;
  optionVolume: number | null;
  spreadPercent: number | null;
  /** bid * 100 for one contract - see optionContractValue. */
  premiumPerContract: number;
  /** Signed per-share premium / adjusted basis, as a percent - null when basis is unavailable. */
  returnOnAdjustedBasisPercent: number | null;
  /** Signed per-share premium / current stock price, as a percent - null when price is unavailable. */
  returnOnCurrentValuePercent: number | null;
  annualizedReturnOnAdjustedBasis: number | null;
  /** strike + bid (per share) - the cash effectively received per share if called away, distinct
   * from adjustedBasis and never overwriting it. */
  effectiveExitPrice: number;
  /** null only when adjustedBasis itself is unavailable - never fabricated. */
  strikeVsBasis: CallStrikeBasisRelationship | null;
  /** Reuses computeCoveredCallRollStatus's exact distance/direction math for OTM/near/ITM framing
   * on a not-yet-sold candidate - never re-derives the sign logic. Null when currentPrice is
   * unavailable. */
  distanceStatus: RollStatus | null;
  /** Projected total campaign P/L if this exact call is sold and later called away at expiration -
   * derived by feeding a hypothetical SELL_COVERED_CALL + STOCK_SALE pair into the real
   * summarizeCampaign, never a parallel P/L formula. Null when it cannot be safely derived (e.g.
   * shares would remain held and no current price exists to mark them). */
  estimatedCampaignPLIfCalledAway: number | null;
  /** True only when every ENABLED reused liquidity rule does not FAIL - a disabled or UNKNOWN rule
   * never excludes, matching passesEnabledGate's own semantics. */
  liquidityPass: boolean;
  liquidityCriteria: CriterionResult[];
};

export type CoveredCallCampaignScan = {
  campaignId: string;
  ticker: string;
  sharesHeld: number;
  openCall: CurrentOpenCall | null;
  availableShares: number;
  maxContracts: number;
  adjustedBasis: number | null;
  currentPrice: number | null;
  earningsDate: string | null;
  earningsDistance: number | null;
  /** Evaluated against the reused earningsDistance rule when the user has it enabled - null (not
   * a fabricated PASS) when the rule is disabled or the distance itself is unknown. */
  earningsCriterion: CriterionResult | null;
  reasonCode: CoveredCallCampaignReasonCode | null;
  selectedExpiration: string | null;
  targetDte: number;
  basisSafeCandidates: CoveredCallCandidate[];
  belowBasisCandidates: CoveredCallCandidate[];
  /** Populated instead of the two arrays above when adjustedBasis itself is unavailable - shows
   * candidates exist without ever labeling one "basis-safe" on a guess. */
  unknownBasisCandidates: CoveredCallCandidate[];
};

/** sharesHeld minus whatever an already-open covered call already obligates - never shares from
 * another campaign, user, or account (the caller only ever passes this campaign's own events). */
export function availableSharesForCoveredCall(sharesHeld: number, openCall: CurrentOpenCall | null): number {
  return sharesHeld - (openCall ? openCall.contracts * 100 : 0);
}

/** floor(availableShares / 100) - never recommends more contracts than owned shares support (no
 * naked calls). */
export function maxCoveredCallContracts(availableShares: number): number {
  return Math.max(0, Math.floor(availableShares / 100));
}

export function evaluateCoveredCallCampaign({
  campaignId,
  ticker,
  events,
  status,
  currentPrice,
  options,
  rules,
  earnings,
  rollBufferPercent,
  asOf = new Date(),
}: {
  campaignId: string;
  ticker: string;
  events: CampaignEventInput[];
  status: CampaignStatusInput;
  currentPrice: number | null;
  /** null means the chain fetch itself failed/was never attempted - distinct from an empty array
   * (chain returned, no CALL contracts). */
  options: OptionContractSnapshot[] | null;
  rules: ScannerRule[];
  earnings: { daysUntilReport: number; reportDate: string } | null;
  rollBufferPercent: number;
  asOf?: Date;
}): CoveredCallCampaignScan {
  const summary = summarizeCampaign({ status, events, currentUnderlyingPrice: currentPrice, asOf });
  const openCall = getCurrentOpenCall(events);
  const availableShares = availableSharesForCoveredCall(summary.sharesHeld, openCall);
  const maxContracts = maxCoveredCallContracts(availableShares);

  const earningsDistance = earnings?.daysUntilReport ?? null;
  const earningsRule = rules.find((rule) => rule.key === "earningsDistance");
  const earningsCriterion = earningsRule ? evaluateCriterion(earningsRule, earningsDistance) : null;

  const base: CoveredCallCampaignScan = {
    campaignId,
    ticker,
    sharesHeld: summary.sharesHeld,
    openCall,
    availableShares,
    maxContracts,
    adjustedBasis: summary.adjustedBasis,
    currentPrice,
    earningsDate: earnings?.reportDate ?? null,
    earningsDistance,
    earningsCriterion,
    reasonCode: null,
    selectedExpiration: null,
    targetDte: WEEKLY_TARGET_DTE,
    basisSafeCandidates: [],
    belowBasisCandidates: [],
    unknownBasisCandidates: [],
  };

  if (maxContracts <= 0) {
    return { ...base, reasonCode: openCall ? "FULLY_COVERED" : "NO_SHARES_AVAILABLE" };
  }
  if (currentPrice === null) {
    return { ...base, reasonCode: "PRICE_UNAVAILABLE" };
  }
  if (options === null) {
    return { ...base, reasonCode: "CHAIN_UNAVAILABLE" };
  }

  const calls = options.filter((option) => option.optionType === "CALL");
  if (!calls.length) {
    return { ...base, reasonCode: "NO_CALL_CONTRACTS" };
  }

  const withBid = calls.filter((option) => option.bid > 0 && Number.isFinite(option.ask));
  if (!withBid.length) {
    return { ...base, reasonCode: "NO_CONTRACT_WITH_POSITIVE_BID" };
  }

  const withDte = withBid.map((option) => ({ option, dte: daysToExpiration(option.expiration, asOf) }));
  const dteRule = rules.find((rule) => rule.key === "dte");
  const [horizonLow, horizonHigh] = weeklyHorizonFor(rules);
  const withinHorizon = withDte.filter((entry) => entry.dte >= horizonLow && entry.dte <= horizonHigh);
  if (!withinHorizon.length) {
    return { ...base, reasonCode: dteRule ? "NO_EXPIRATIONS_IN_CONFIGURED_RANGE" : "NO_WEEKLY_EXPIRATION" };
  }

  // Expiration selection happens before any liquidity gate, exactly mirroring the CSP philosophy -
  // a normal weekly expiration must not disappear merely because its liquidity is thin at that
  // date; that is an honest strike-level result, never a reason to jump to a different expiration.
  const comparable = withinHorizon.map((entry) => ({ dte: entry.dte, expiration: entry.option.expiration.toISOString().slice(0, 10) }));
  const selectedExpiration = [...comparable].sort(compareExpirations)[0].expiration;
  const atSelectedExpiration = withinHorizon.filter((entry) => entry.option.expiration.toISOString().slice(0, 10) === selectedExpiration);

  const candidates = atSelectedExpiration
    .filter((entry) => Number.isFinite(entry.option.strike) && entry.option.strike > 0)
    .map((entry) =>
      buildCandidate({
        option: entry.option,
        dte: entry.dte,
        adjustedBasis: summary.adjustedBasis,
        currentPrice,
        maxContracts,
        rules,
        rollBufferPercent,
        asOf,
        events,
        status,
      }),
    );

  if (summary.adjustedBasis === null) {
    return {
      ...base,
      selectedExpiration,
      unknownBasisCandidates: candidates.sort((left, right) => left.strike - right.strike).slice(0, MAX_BASIS_SAFE_SHOWN),
    };
  }

  const basisSafe = candidates
    .filter((candidate) => candidate.strikeVsBasis !== null && !candidate.strikeVsBasis.belowBasis)
    .sort((left, right) => left.strike - right.strike)
    .slice(0, MAX_BASIS_SAFE_SHOWN);
  const belowBasis = candidates
    .filter((candidate) => candidate.strikeVsBasis !== null && candidate.strikeVsBasis.belowBasis)
    .sort((left, right) => right.strike - left.strike)
    .slice(0, MAX_BELOW_BASIS_SHOWN);

  return {
    ...base,
    selectedExpiration,
    reasonCode: basisSafe.length ? null : "NO_BASIS_SAFE_WEEKLY_CALL",
    basisSafeCandidates: basisSafe,
    belowBasisCandidates: belowBasis,
  };
}

function buildCandidate({
  option,
  dte,
  adjustedBasis,
  currentPrice,
  maxContracts,
  rules,
  rollBufferPercent,
  asOf,
  events,
  status,
}: {
  option: OptionContractSnapshot;
  dte: number;
  adjustedBasis: number | null;
  currentPrice: number;
  maxContracts: number;
  rules: ScannerRule[];
  rollBufferPercent: number;
  asOf: Date;
  events: CampaignEventInput[];
  status: CampaignStatusInput;
}): CoveredCallCandidate {
  const spreadPercent = bidAskSpreadPercent(option.bid, option.ask);
  const openInterest = option.openInterest ?? null;
  const optionVolume = option.volume ?? null;

  const liquidityCriteria = LIQUIDITY_RULE_KEYS.flatMap((key) => {
    const rule = rules.find((candidate) => candidate.key === key);
    if (!rule) {
      return [];
    }
    const actual = key === "optionBid" ? option.bid : key === "openInterest" ? openInterest : key === "spreadPercent" ? spreadPercent : optionVolume;
    return [evaluateCriterion(rule, actual)];
  });
  const liquidityPass = liquidityCriteria.every((criterion) => criterion.status !== "FAIL");

  const returnOnAdjustedBasisPercent = adjustedBasis !== null && adjustedBasis > 0 ? round((option.bid / adjustedBasis) * 100, 2) : null;
  const returnOnCurrentValuePercent = currentPrice > 0 ? round((option.bid / currentPrice) * 100, 2) : null;
  const annualizedReturnOnAdjustedBasis =
    returnOnAdjustedBasisPercent !== null ? annualizedReturnOnRisk(returnOnAdjustedBasisPercent, dte) : null;

  return {
    strike: option.strike,
    expiration: option.expiration.toISOString().slice(0, 10),
    dte,
    bid: option.bid,
    ask: option.ask,
    openInterest,
    optionVolume,
    spreadPercent,
    premiumPerContract: optionContractValue(option.bid, 1),
    returnOnAdjustedBasisPercent,
    returnOnCurrentValuePercent,
    annualizedReturnOnAdjustedBasis,
    effectiveExitPrice: round(option.strike + option.bid, 2),
    strikeVsBasis: describeCallStrikeVsAdjustedBasis(option.strike, adjustedBasis),
    distanceStatus: computeCoveredCallRollStatus({ currentPrice, strike: option.strike, rollBufferPercent, now: asOf }),
    estimatedCampaignPLIfCalledAway: estimateCampaignOutcomeIfCalledAway({
      events,
      status,
      contracts: maxContracts,
      strike: option.strike,
      premium: option.bid,
      expiration: option.expiration,
      currentPrice,
      asOf,
    }),
    liquidityPass,
    liquidityCriteria,
  };
}

/**
 * Projects total campaign P/L if `contracts` calls at `strike`/`premium` are sold now and the
 * covered shares are called away at expiration - by appending a hypothetical SELL_COVERED_CALL and
 * STOCK_SALE pair to the campaign's REAL event history and handing the whole thing to the real
 * summarizeCampaign. Never a parallel P/L engine: every dollar here is computed by the same
 * function that computes every other campaign's real P/L. Only the `contracts * 100` shares this
 * call would cover are modeled as sold - any remaining uncovered shares stay held and, if a
 * current price exists, are marked at it (never a guessed future price) via summarizeCampaign's
 * own existing unrealizedPL logic; if no price exists and shares would remain, summarizeCampaign
 * already returns null rather than fabricating a number.
 */
function estimateCampaignOutcomeIfCalledAway({
  events,
  status,
  contracts,
  strike,
  premium,
  expiration,
  currentPrice,
  asOf,
}: {
  events: CampaignEventInput[];
  status: CampaignStatusInput;
  contracts: number;
  strike: number;
  premium: number;
  expiration: Date;
  currentPrice: number | null;
  asOf: Date;
}): number | null {
  const hypotheticalEvents: CampaignEventInput[] = [
    ...events,
    {
      type: "SELL_COVERED_CALL",
      occurredAt: asOf,
      sortOrder: 9000,
      optionType: "CALL",
      contracts,
      strike,
      expiration,
      premium,
      fees: 0,
    },
    {
      type: "STOCK_SALE",
      occurredAt: expiration,
      sortOrder: 9001,
      shares: contracts * 100,
      underlyingPrice: strike,
      fees: 0,
    },
  ];

  return summarizeCampaign({
    status,
    events: hypotheticalEvents,
    currentUnderlyingPrice: currentPrice,
    asOf: expiration > asOf ? expiration : asOf,
  }).totalCampaignPL;
}
