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
}
