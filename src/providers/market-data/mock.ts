import { DEMO_SCAN_CANDIDATES } from "@/domain/scanner/profile";
import type { MarketDataProvider, MarketQuote, OptionContractSnapshot, PriceCandle } from "./types";

const demoAsOf = new Date("2026-08-28T14:45:00Z");
const demoCandidatesBySymbol = new Map(DEMO_SCAN_CANDIDATES.map((candidate) => [candidate.ticker, candidate.values]));
const demoQuotes: Record<string, MarketQuote> = Object.fromEntries(
  DEMO_SCAN_CANDIDATES.flatMap((candidate) => {
    const price = numericValue(candidate.values.price);
    if (price === null) {
      return [];
    }

    return [
      [
        candidate.ticker,
        {
          symbol: candidate.ticker,
          price,
          change: numericValue(candidate.values.priceChange) ?? undefined,
          changePercent: numericValue(candidate.values.priceChangePercent) ?? undefined,
          asOf: demoAsOf,
        },
      ],
    ];
  }),
);

export class DemoMarketDataProvider implements MarketDataProvider {
  async getQuote(symbol: string): Promise<MarketQuote> {
    const normalized = symbol.toUpperCase();
    return demoQuotes[normalized] ?? {
      symbol: normalized,
      price: 25,
      asOf: demoAsOf,
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
    const candidate = demoCandidatesBySymbol.get(normalized);
    if (!candidate) {
      return [];
    }

    const strike = numericValue(candidate.strike);
    const expiration = stringValue(candidate.expiration);
    const bid = numericValue(candidate.optionBid);
    const ask = numericValue(candidate.optionAsk);
    const mark = numericValue(candidate.midpoint);
    if (strike === null || !expiration || bid === null || ask === null || mark === null) {
      return [];
    }

    return [
      {
        symbol: `${normalized} ${expiration} P${strike}`,
        underlyingSymbol: normalized,
        optionType: "PUT",
        strike,
        expiration: new Date(`${expiration}T20:00:00Z`),
        bid,
        ask,
        mark,
        delta: signedPutDelta(numericValue(candidate.delta)),
        openInterest: numericValue(candidate.openInterest) ?? undefined,
        volume: numericValue(candidate.optionVolume) ?? undefined,
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

export class MockMarketDataProvider extends DemoMarketDataProvider {}

function numericValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: unknown) {
  return value ? String(value) : null;
}

function signedPutDelta(value: number | null) {
  return value === null ? undefined : -Math.abs(value);
}
