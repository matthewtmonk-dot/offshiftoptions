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
}
