export type QuoteFundamentals = {
  peRatio: number | null;
  eps: number | null;
  dividendAmount: number | null;
  dividendYield: number | null;
  dividendFrequency: number | null;
};

export type MarketQuote = {
  symbol: string;
  price: number;
  change?: number;
  changePercent?: number;
  volume?: number;
  asOf: Date;
  /** Company/legal name from Schwab's `reference` quote field group, when present. Never
   * fabricated - undefined/null when the provider didn't supply it (e.g. demo data). */
  companyDescription?: string | null;
  /** Verified values from Schwab's `fundamental` quote field group. Optional/undefined for
   * providers that don't supply it (e.g. demo data) - never guessed or backfilled. */
  fundamentals?: QuoteFundamentals | null;
};

export type PriceCandle = {
  symbol: string;
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type OptionContractSnapshot = {
  symbol: string;
  underlyingSymbol: string;
  optionType: "PUT" | "CALL";
  strike: number;
  expiration: Date;
  bid: number;
  ask: number;
  mark: number;
  last?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  impliedVolatility?: number;
  openInterest?: number;
  volume?: number;
};

/**
 * Narrows what an option-chain request actually asks the provider for. Every field is optional,
 * so an omitted request means "the whole OTM chain, both contract types" - exactly what callers
 * got before this type existed. A caller that already knows it will discard most of the response
 * (the weekly scanner only ever evaluates PUTs inside a bounded DTE horizon - see live-scan.ts)
 * should narrow here rather than downloading and parsing every expiration and both contract types.
 * This is a transport-level narrowing only: it must never change which contract a caller would
 * have selected from an identical set of returned contracts.
 */
export type OptionChainRequest = {
  /** Earliest expiration date to return, inclusive. Omitted means no lower bound. */
  fromDate?: Date;
  /** Latest expiration date to return, inclusive. Omitted means no upper bound. */
  toDate?: Date;
  /** Defaults to "ALL" - the pre-existing behavior for any caller that doesn't narrow. */
  contractType?: "PUT" | "CALL" | "ALL";
};

/**
 * Dashboard V2 Phase 2 - an ADDITIVE, stricter evidence contract for position-review advisory
 * status. Deliberately NOT a replacement for MarketQuote (which many existing, unrelated
 * consumers already trust) - MarketQuote's own fallback chains and `asOf` semantics are
 * unchanged by this type's existence. This type exists because MarketQuote's `asOf` is already a
 * fallback-chain result (quoteTimeInLong ?? regularMarketTradeTimeInLong ?? ...) and carries no
 * asset-identity/realtime evidence at all - exactly what a colored advisory status needs and
 * MarketQuote was never designed to prove.
 *
 * `price` and `tradeTime` MUST be selected atomically from the SAME source field pair (Schwab:
 * quote.lastPrice + quote.tradeTime) - never independently-chosen fallbacks. See
 * src/domain/finance/quoteEvidence.ts for the eligibility rules built on this type, and
 * src/providers/schwab/normalizers.ts's normalizeSchwabQuoteReviewEvidence for the one producer.
 */
export type QuoteReviewEvidence =
  | {
      status: "AVAILABLE";
      requestedSymbol: string;
      returnedSymbol: string;
      assetMainType: string | null;
      realtime: boolean | null;
      /** The exact price/time pair, selected atomically - never re-paired with any other field. */
      price: number;
      tradeTime: Date;
      /** This app's own observation evidence - never substituted for `tradeTime` above. */
      requestStartedAt: Date;
      responseReceivedAt: Date;
    }
  | { status: "UNAVAILABLE"; reason: string };

export type EquityRegularSessionInterval = { start: Date; end: Date };

/**
 * Dashboard V2 Phase 2 - full, unflattened equity regular-session evidence for exactly one
 * requested America/New_York calendar date. Deliberately NOT a replacement for
 * MarketDataProvider.getMarketHours (the existing flattened {isOpen, opensAt, closesAt} shape,
 * still used by fundamentals-diagnostic.ts) - this type preserves every regularMarket interval
 * (never just index 0) so a position-review evaluator can validate session membership itself
 * rather than trusting a single pre-selected open/close pair.
 */
export type EquityMarketSessionEvidence =
  | {
      status: "AVAILABLE";
      requestedDate: string;
      returnedDate: string;
      marketType: string;
      product: string;
      isOpen: boolean;
      regularMarketIntervals: EquityRegularSessionInterval[];
    }
  | { status: "UNAVAILABLE"; reason: string };

/**
 * Trade Prep strict option-evidence foundation - an ADDITIVE, parallel path to
 * OptionContractSnapshot/getOptionChain above, never a replacement. The legacy snapshot path
 * (OptionContractSnapshot, normalizeSchwabOptionChainResponse) stays exactly as it is for the
 * production-approved Scanner: it may synthesize a fallback symbol when the provider omits one,
 * and it drops strict timing/contract-terms evidence entirely. Strict evidence exists because a
 * future Trade Prep READY/VERIFY/BLOCKED decision needs exactly the opposite guarantees: never a
 * synthesized identity, and every missing/invalid field preserved as an explicit state rather than
 * silently dropped. See src/domain/trade-prep/optionEvidence.ts for the pure evaluators built on
 * these types, and src/providers/schwab/normalizers.ts's normalizeSchwabStrictOptionChainSnapshot
 * for the one producer. `null` always means "this field was missing, present-but-wrong-type, or
 * otherwise unusable" - never a fabricated/assumed value (e.g. a missing multiplier is `null`,
 * never 100).
 */
/** Bumped whenever the strict normalizer's field-extraction semantics change. Shared by the
 * normalizer (stamps it onto every produced snapshot) and the market-data cache (folds it into the
 * strict cache key), so a cache entry produced under an older policy can never be read back as if
 * it satisfied a newer one - see StrictOptionChainTransportEvidence.evidencePolicyVersion. */
export const STRICT_OPTION_EVIDENCE_POLICY_VERSION = "v1";

export type StrictOptionDeliverableEvidence = {
  symbol: string | null;
  assetType: string | null;
  deliverableUnits: number | null;
  currencyType: string | null;
};

/** Where this contract was found within the raw chain response - distinct from its own claimed
 * identity fields (see StrictOptionContractIdentity), so a mismatch between "where we found it"
 * and "what it claims to be" is independently detectable. */
export type StrictOptionContractLocation = {
  expirationMapKey: string;
  strikeMapKey: string;
  originatingMap: "PUT" | "CALL";
};

/** `optionRoot` is DERIVED (via OCC-style parsing of `providerSymbol`, consistency-check only -
 * see the ticket's own "structured provider fields remain authoritative" rule), never a raw field
 * Schwab's chain response supplies under that name. `providerSymbol` is preserved EXACTLY as
 * returned, including any padding - never trimmed, never synthesized when absent. */
export type StrictOptionContractIdentity = {
  providerSymbol: string | null;
  putCall: string | null;
  strikePrice: number | null;
  expirationDate: Date | null;
  optionRoot: string | null;
};

/** `quoteTimeInLong` is preserved as the raw epoch-millisecond number exactly as returned -
 * `tradeTimeInLong` is deliberately never captured here at all (see the ticket's own "never use
 * tradeTimeInLong for bid/ask freshness" rule) - there is nothing for a caller to accidentally
 * reach for. */
export type StrictOptionContractQuote = {
  bid: number | null;
  ask: number | null;
  quoteTimeInLong: number | null;
};

export type StrictOptionContractTerms = {
  multiplier: number | null;
  nonStandard: boolean | null;
  mini: boolean | null;
  /** `null` = the field itself was absent/invalid; `[]` = the field was present and genuinely
   * empty - these are two different claims and must never be collapsed into one. */
  optionDeliverablesList: StrictOptionDeliverableEvidence[] | null;
  settlementType: string | null;
  deliverableNote: string | null;
};

/** Provider-reported rule inputs, preserved as-is. Never described as "live" - only that they were
 * reported in this one chain response (see this type's own evaluators in optionEvidence.ts). */
export type StrictOptionContractRuleInputs = {
  openInterest: number | null;
  totalVolume: number | null;
  delta: number | null;
};

export type StrictOptionContractSnapshot = {
  location: StrictOptionContractLocation;
  identity: StrictOptionContractIdentity;
  quote: StrictOptionContractQuote;
  terms: StrictOptionContractTerms;
  ruleInputs: StrictOptionContractRuleInputs;
};

/** Chain-root, response-level evidence - distinct from any one contract. `isDelayed` is `null`
 * unless the raw field was an ACTUAL boolean (a string "false", a missing key, or any other shape
 * all normalize to `null`, never to `false`) - see evaluateChainDelay's own strict-boolean gate. */
export type StrictOptionChainEnvelope = {
  status: string | null;
  /** The chain root's own reported underlying symbol - compared against the requested underlying
   * and each contract's derived optionRoot for identity consistency. */
  rootSymbol: string | null;
  isDelayed: boolean | null;
};

export type StrictOptionChainRequestEvidence = {
  requestedUnderlying: string;
  fromDate: Date | null;
  toDate: Date | null;
  contractType: "PUT" | "CALL" | "ALL";
};

/** This app's own observation evidence around the one Schwab request - never substituted for any
 * provider-reported quote/trade time. `httpDateHeader` is kept separate and purely informational
 * (transport evidence, not option-quote evidence - never used by any strict evaluator). */
export type StrictOptionChainTransportEvidence = {
  provider: "SCHWAB";
  requestStartedAt: Date;
  responseReceivedAt: Date;
  httpDateHeader: string | null;
  /** Bumped whenever this normalizer's field-extraction semantics change, so a cache entry keyed
   * on an older policy version can never be read back as if it satisfied a newer one. */
  evidencePolicyVersion: string;
};

export type StrictOptionChainSnapshot =
  | {
      status: "AVAILABLE";
      envelope: StrictOptionChainEnvelope;
      request: StrictOptionChainRequestEvidence;
      contracts: StrictOptionContractSnapshot[];
      transport: StrictOptionChainTransportEvidence;
    }
  | { status: "UNAVAILABLE"; reason: string; transport: StrictOptionChainTransportEvidence };

export interface MarketDataProvider {
  getQuote(symbol: string): Promise<MarketQuote>;
  /**
   * Optional batch variant of getQuote, for providers that support a native multi-symbol quote
   * request (see SchwabMarketDataProvider.getQuotes) - lets a broad-universe scan fetch Stage 1
   * quotes in a handful of requests instead of one per symbol. Optional (not every provider,
   * e.g. test/demo providers, needs to implement it) so existing callers/mocks are never broken
   * by its addition - see evaluateLiveMarketScan, which falls back to one getQuote call per
   * symbol when a provider omits this. A symbol absent from the returned Map means the provider
   * had nothing usable for it (an invalid/delisted symbol, or an isolated request failure for
   * just that symbol's batch) - never thrown for one bad symbol in an otherwise-good batch.
   */
  getQuotes?(symbols: string[]): Promise<Map<string, MarketQuote>>;
  getPriceHistory(symbol: string, days: number): Promise<PriceCandle[]>;
  getOptionChain(symbol: string, request?: OptionChainRequest): Promise<OptionContractSnapshot[]>;
  getInstrument(symbol: string): Promise<{ symbol: string; description: string; assetType: string }>;
  getMarketHours(date: Date): Promise<{ isOpen: boolean; opensAt?: Date; closesAt?: Date }>;
  /** Dashboard V2 Phase 2 - the stricter, additive review-evidence quote path (see
   * QuoteReviewEvidence above). Optional so no existing provider/mock is broken by its addition;
   * a provider that omits this simply can never produce an active colored advisory (positionReview
   * treats the missing capability as UNAVAILABLE evidence, never a guess). */
  /** `signal` is optional and purely additive - see schwabGetJson's own doc comment
   * (providers/schwab/client.ts). Only the manual "Refresh status" bounded-operation path ever
   * passes one; every other existing caller keeps its exact prior behavior. */
  getQuoteReviewEvidence?(symbol: string, signal?: AbortSignal): Promise<QuoteReviewEvidence>;
  /** Dashboard V2 Phase 2 - full equity regular-session evidence for one NY calendar date
   * ("YYYY-MM-DD"). Optional for the same reason as getQuoteReviewEvidence above. */
  getEquityMarketSessionEvidence?(nyDate: string, signal?: AbortSignal): Promise<EquityMarketSessionEvidence>;
  /** Trade Prep strict option-evidence foundation - the additive raw-evidence path (see
   * StrictOptionChainSnapshot's own doc comment above). Optional for the same reason as the other
   * Phase-2 evidence methods; a provider that omits this can never produce strict Trade Prep
   * evidence (never a guess, never a fallback to the legacy getOptionChain shape). */
  getStrictOptionChainSnapshot?(symbol: string, request?: OptionChainRequest, signal?: AbortSignal): Promise<StrictOptionChainSnapshot>;
}
