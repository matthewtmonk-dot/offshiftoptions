import type { MarketDataProvider, MarketQuote, OptionContractSnapshot, PriceCandle } from "./types";

const demoQuotes: Record<string, MarketQuote> = {
  CORZ: { symbol: "CORZ", price: 16.89, change: 0.21, changePercent: 1.26, asOf: new Date("2026-08-28T14:45:00Z") },
  SOFI: { symbol: "SOFI", price: 18.42, change: -0.14, changePercent: -0.75, asOf: new Date("2026-08-28T14:45:00Z") },
  AMD: { symbol: "AMD", price: 156.2, change: 1.88, changePercent: 1.22, asOf: new Date("2026-08-28T14:45:00Z") },
};

export class MockMarketDataProvider implements MarketDataProvider {
  async getQuote(symbol: string): Promise<MarketQuote> {
    const normalized = symbol.toUpperCase();
    return demoQuotes[normalized] ?? {
      symbol: normalized,
      price: 25,
      asOf: new Date("2026-08-28T14:45:00Z"),
    };
  }

  async getPriceHistory(symbol: string, days: number): Promise<PriceCandle[]> {
    const quote = await this.getQuote(symbol);
    return Array.from({ length: days }, (_, index) => {
      const close = quote.price * (1 + Math.sin(index / 3) * 0.015);
      return {
        symbol: quote.symbol,
        date: new Date(Date.UTC(2026, 7, 28 - (days - index))),
        open: close * 0.995,
        high: close * 1.015,
        low: close * 0.985,
        close,
        volume: 2_000_000 + index * 11_000,
      };
    });
  }

  async getOptionChain(symbol: string): Promise<OptionContractSnapshot[]> {
    const normalized = symbol.toUpperCase();
    return [
      {
        symbol: `${normalized} 2026-09-18 P16.5`,
        underlyingSymbol: normalized,
        optionType: "PUT",
        strike: 16.5,
        expiration: new Date("2026-09-18T20:00:00Z"),
        bid: 0.04,
        ask: 0.06,
        mark: 0.05,
        delta: -0.18,
        gamma: 0.045,
        theta: -0.012,
        vega: 0.022,
        impliedVolatility: 0.72,
        openInterest: 840,
        volume: 126,
      },
    ];
  }

  async getInstrument(symbol: string) {
    return {
      symbol: symbol.toUpperCase(),
      description: `${symbol.toUpperCase()} demo common stock`,
      assetType: "EQUITY",
    };
  }

  async getMarketHours(date: Date) {
    const open = new Date(date);
    open.setUTCHours(13, 30, 0, 0);
    const close = new Date(date);
    close.setUTCHours(20, 0, 0, 0);
    return { isOpen: true, opensAt: open, closesAt: close };
  }
}
