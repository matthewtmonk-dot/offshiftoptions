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
  getOptionChain(symbol: string, expiration?: Date): Promise<OptionContractSnapshot[]>;
  getInstrument(symbol: string): Promise<{ symbol: string; description: string; assetType: string }>;
  getMarketHours(date: Date): Promise<{ isOpen: boolean; opensAt?: Date; closesAt?: Date }>;
}
