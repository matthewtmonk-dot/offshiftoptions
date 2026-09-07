import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MarketDataProvider, MarketQuote, PriceCandle } from "./types";
import { clearMarketDataCacheForTests, MarketDataProviderError, withMarketDataCache } from "./cache";

function quote(symbol: string, price: number): MarketQuote {
  return { symbol, price, asOf: new Date("2026-08-31T12:00:00.000Z") };
}

function candle(symbol: string): PriceCandle {
  return {
    symbol,
    date: new Date("2026-08-31T00:00:00.000Z"),
    open: 10,
    high: 11,
    low: 9,
    close: 10.5,
    volume: 1000,
  };
}

function provider(overrides: Partial<MarketDataProvider> = {}): MarketDataProvider {
  return {
    getQuote: vi.fn(async (symbol: string) => quote(symbol, 12.34)),
    getPriceHistory: vi.fn(async (symbol: string) => [candle(symbol)]),
    getOptionChain: vi.fn(async () => []),
    getInstrument: vi.fn(async (symbol: string) => ({ symbol, description: "Test instrument", assetType: "EQUITY" })),
    getMarketHours: vi.fn(async () => ({ isOpen: true })),
    ...overrides,
  };
}

describe("withMarketDataCache", () => {
  beforeEach(() => {
    clearMarketDataCacheForTests();
  });

  it("reuses repeated quote requests for the same provider key", async () => {
    const inner = provider();
    const cached = withMarketDataCache(inner, "schwab:user:user-a:connection:one", { quoteTtlMs: 30_000 });

    await expect(cached.getQuote("lsto")).resolves.toMatchObject({ price: 12.34 });
    await expect(cached.getQuote("LSTO")).resolves.toMatchObject({ price: 12.34 });

    expect(inner.getQuote).toHaveBeenCalledTimes(1);
  });

  it("does not share cache entries across provider keys", async () => {
    const first = provider({ getQuote: vi.fn(async (symbol: string) => quote(symbol, 10)) });
    const second = provider({ getQuote: vi.fn(async (symbol: string) => quote(symbol, 20)) });

    const firstCached = withMarketDataCache(first, "schwab:user:user-a:connection:one");
    const secondCached = withMarketDataCache(second, "schwab:user:user-b:connection:two");

    await expect(firstCached.getQuote("LSTO")).resolves.toMatchObject({ price: 10 });
    await expect(secondCached.getQuote("LSTO")).resolves.toMatchObject({ price: 20 });

    expect(first.getQuote).toHaveBeenCalledTimes(1);
    expect(second.getQuote).toHaveBeenCalledTimes(1);
  });

  it("coalesces simultaneous price-history requests within one provider", async () => {
    const historyGate: { resolve?: (candles: PriceCandle[]) => void } = {};
    const inner = provider({
      getPriceHistory: vi.fn(
        (symbol: string) =>
          new Promise<PriceCandle[]>((resolve) => {
            historyGate.resolve = resolve;
          }).then(() => [candle(symbol)]),
      ),
    });
    const cached = withMarketDataCache(inner, "schwab:user:user-a:connection:one");

    const first = cached.getPriceHistory("LSTO", 30);
    const second = cached.getPriceHistory("lsto", 30);
    expect(historyGate.resolve).toBeDefined();
    historyGate.resolve?.([candle("LSTO")]);

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(inner.getPriceHistory).toHaveBeenCalledTimes(1);
  });

  it("wraps failures with the provider identity but no credentials", async () => {
    const inner = provider({
      getQuote: vi.fn(async () => {
        throw new Error("rate limited");
      }),
    });
    const cached = withMarketDataCache(inner, "schwab:user:user-a:connection:one");

    await expect(cached.getQuote("LSTO")).rejects.toMatchObject({
      name: "MarketDataProviderError",
      providerKey: "schwab:user:user-a",
    } satisfies Partial<MarketDataProviderError>);
  });

  describe("getQuotes (always exposed on the wrapper, even when the underlying provider lacks it)", () => {
    it("uses the underlying provider's native getQuotes when available", async () => {
      const nativeGetQuotes = vi.fn(async (symbols: string[]) => new Map(symbols.map((symbol) => [symbol, quote(symbol, 42)])));
      const inner = provider({ getQuotes: nativeGetQuotes });
      const cached = withMarketDataCache(inner, "schwab:user:user-a:connection:one");

      const result = await cached.getQuotes(["AAA", "BBB"]);
      expect(result.get("AAA")?.price).toBe(42);
      expect(result.get("BBB")?.price).toBe(42);
      expect(nativeGetQuotes).toHaveBeenCalledTimes(1);
      expect(inner.getQuote).not.toHaveBeenCalled();
    });

    it("falls back to one getQuote call per symbol when the underlying provider has no getQuotes", async () => {
      const inner = provider(); // no getQuotes override - default has none
      const cached = withMarketDataCache(inner, "schwab:user:user-a:connection:one");

      const result = await cached.getQuotes(["AAA", "BBB"]);
      expect(result.get("AAA")?.price).toBe(12.34);
      expect(result.get("BBB")?.price).toBe(12.34);
      expect(inner.getQuote).toHaveBeenCalledTimes(2);
    });

    it("in the fallback path, one bad symbol never drops the others", async () => {
      const inner = provider({
        getQuote: vi.fn(async (symbol: string) => {
          if (symbol === "BAD") {
            throw new Error("invalid symbol");
          }
          return quote(symbol, 10);
        }),
      });
      const cached = withMarketDataCache(inner, "schwab:user:user-a:connection:one");

      const result = await cached.getQuotes(["GOOD", "BAD"]);
      expect(result.has("GOOD")).toBe(true);
      expect(result.has("BAD")).toBe(false);
    });

    it("reuses an already-cached single quote instead of re-fetching it in a batch", async () => {
      const nativeGetQuotes = vi.fn(async (symbols: string[]) => new Map(symbols.map((symbol) => [symbol, quote(symbol, 99)])));
      const inner = provider({ getQuotes: nativeGetQuotes });
      const cached = withMarketDataCache(inner, "schwab:user:user-a:connection:one", { quoteTtlMs: 30_000 });

      await cached.getQuote("AAA"); // populates the per-symbol cache via getQuote
      const result = await cached.getQuotes(["AAA", "BBB"]);

      expect(result.get("AAA")?.price).toBe(12.34); // from the earlier getQuote call, not re-fetched
      expect(result.get("BBB")?.price).toBe(99);
      expect(nativeGetQuotes).toHaveBeenCalledWith(["BBB"]); // AAA already cached, never requested again
    });

    it("a batch-fetched quote populates the cache so a later single getQuote() call reuses it", async () => {
      const nativeGetQuotes = vi.fn(async (symbols: string[]) => new Map(symbols.map((symbol) => [symbol, quote(symbol, 55)])));
      const inner = provider({ getQuotes: nativeGetQuotes });
      const cached = withMarketDataCache(inner, "schwab:user:user-a:connection:one", { quoteTtlMs: 30_000 });

      await cached.getQuotes(["AAA"]);
      await expect(cached.getQuote("AAA")).resolves.toMatchObject({ price: 55 });
      expect(inner.getQuote).not.toHaveBeenCalled();
    });
  });
});
