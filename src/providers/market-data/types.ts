export type MarketQuote = {
  symbol: string;
  price: number;
  change?: number;
  changePercent?: number;
  asOf: Date;
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
  getPriceHistory(symbol: string, days: number): Promise<PriceCandle[]>;
  getOptionChain(symbol: string, expiration?: Date): Promise<OptionContractSnapshot[]>;
  getInstrument(symbol: string): Promise<{ symbol: string; description: string; assetType: string }>;
  getMarketHours(date: Date): Promise<{ isOpen: boolean; opensAt?: Date; closesAt?: Date }>;
}
