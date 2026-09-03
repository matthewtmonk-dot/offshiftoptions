import { describe, expect, it } from "vitest";
import { evaluateLiveMarketScan, SCAN_FETCH_CONCURRENCY } from "./live-scan";
import type { MarketDataProvider } from "@/providers/market-data/types";
import type { ScannerRule } from "./scanner";

const rules: ScannerRule[] = [
  { key: "price", name: "Stock price", operator: "BETWEEN", desired: [5, 30] },
  { key: "optionBid", name: "Option bid", operator: "GTE", desired: 0.05 },
  { key: "spreadPercent", name: "Bid/ask spread", operator: "LTE", desired: 30 },
  { key: "openInterest", name: "Open interest", operator: "GTE", desired: 100 },
  { key: "ror", name: "Put ROR", operator: "GTE", desired: 1 },
];

/** Serializes every provider call to 1-at-a-time, regardless of caller concurrency. */
function serialize(provider: MarketDataProvider): MarketDataProvider {
  let chain = Promise.resolve();
  function gate<T>(run: () => Promise<T>): Promise<T> {
    const result = chain.then(run);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    getQuote: (symbol) => gate(() => provider.getQuote(symbol)),
    getPriceHistory: (symbol, days) => gate(() => provider.getPriceHistory(symbol, days)),
    getOptionChain: (symbol) => gate(() => provider.getOptionChain(symbol)),
    getInstrument: (symbol) => gate(() => provider.getInstrument(symbol)),
    getMarketHours: (date) => gate(() => provider.getMarketHours(date)),
  };
}

describe("live market-data scanner", () => {
  it("calculates scanner values from provider fixtures and limits option-chain calls", async () => {
    const optionChainCalls: string[] = [];
    const provider: MarketDataProvider = {
      async getQuote(symbol) {
        return { symbol, price: symbol === "RIOT" ? 12 : 55, volume: 1_000_000, asOf: new Date("2026-08-31T14:30:00Z") };
      },
      async getPriceHistory(symbol, days) {
        return Array.from({ length: days }, (_, index) => ({
          symbol,
          date: new Date(Date.UTC(2026, 7, index + 1)),
          open: 12,
          high: 12.5,
          low: 11.5,
          close: 12 - index * 0.01,
          volume: 1000 + index,
        }));
      },
      async getOptionChain(symbol) {
        optionChainCalls.push(symbol);
        return [
          {
            symbol: `${symbol} 260918P00011000`,
            underlyingSymbol: symbol,
            optionType: "PUT",
            strike: 11,
            expiration: new Date("2026-09-18T20:00:00Z"),
            bid: 0.2,
            ask: 0.26,
            mark: 0.23,
            delta: -0.22,
            openInterest: 250,
            volume: 41,
          },
        ];
      },
      async getInstrument(symbol) {
        return { symbol, description: `${symbol} common stock`, assetType: "EQUITY" };
      },
      async getMarketHours() {
        return { isOpen: true };
      },
    };

    const results = await evaluateLiveMarketScan({
      provider,
      rules,
      universe: ["RIOT", "TOOHI"],
      asOf: new Date("2026-08-31T12:00:00Z"),
      maxOptionChainLookups: 1,
    });

    const riot = results.find((result) => result.ticker === "RIOT");
    const tooHigh = results.find((result) => result.ticker === "TOOHI");

    expect(optionChainCalls).toEqual(["RIOT"]);
    expect(riot?.values).toMatchObject({
      optionBid: 0.2,
      optionAsk: 0.26,
      openInterest: 250,
      ror: 1.82,
      annualizedRor: 36.91,
    });
    expect(riot?.summary.status).toBe("PASS");
    expect(tooHigh?.summary.status).toBe("FAIL");
    expect(tooHigh?.values.optionBid).toBeNull();
  });

  it("does not substitute demo data when the live provider fails", async () => {
    const provider: MarketDataProvider = {
      async getQuote() {
        throw new Error("Schwab unavailable");
      },
      async getPriceHistory() {
        return [];
      },
      async getOptionChain() {
        return [];
      },
      async getInstrument(symbol) {
        return { symbol, description: symbol, assetType: "EQUITY" };
      },
      async getMarketHours() {
        return { isOpen: false };
      },
    };

    await expect(evaluateLiveMarketScan({ provider, rules, universe: ["RIOT"] })).rejects.toThrow("Schwab unavailable");
  });

  it("returns partial results with an UNKNOWN candidate when only some tickers fail", async () => {
    const provider: MarketDataProvider = {
      async getQuote(symbol) {
        if (symbol === "BADCO") {
          throw new Error("Schwab timeout for BADCO");
        }
        return { symbol, price: 12, volume: 1_000_000, asOf: new Date("2026-08-31T14:30:00Z") };
      },
      async getPriceHistory(symbol, days) {
        return Array.from({ length: days }, (_, index) => ({
          symbol,
          date: new Date(Date.UTC(2026, 7, index + 1)),
          open: 12,
          high: 12.5,
          low: 11.5,
          close: 12 - index * 0.01,
          volume: 1000 + index,
        }));
      },
      async getOptionChain(symbol) {
        return [
          {
            symbol: `${symbol} 260918P00011000`,
            underlyingSymbol: symbol,
            optionType: "PUT",
            strike: 11,
            expiration: new Date("2026-09-18T20:00:00Z"),
            bid: 0.2,
            ask: 0.26,
            mark: 0.23,
            delta: -0.22,
            openInterest: 250,
            volume: 41,
          },
        ];
      },
      async getInstrument(symbol) {
        return { symbol, description: `${symbol} common stock`, assetType: "EQUITY" };
      },
      async getMarketHours() {
        return { isOpen: true };
      },
    };

    const results = await evaluateLiveMarketScan({
      provider,
      rules,
      universe: ["RIOT", "BADCO"],
      asOf: new Date("2026-08-31T12:00:00Z"),
    });

    const riot = results.find((result) => result.ticker === "RIOT");
    const badco = results.find((result) => result.ticker === "BADCO");

    expect(riot?.summary.status).toBe("PASS");
    expect(badco?.summary.status).toBe("UNKNOWN");
    expect(badco?.values.price).toBeNull();
    expect(badco?.values.scanNote).toContain("unavailable");
  });

  it("caps in-flight quote/history requests at SCAN_FETCH_CONCURRENCY", async () => {
    let active = 0;
    let maxActive = 0;
    const universe = Array.from({ length: 10 }, (_, index) => `TICK${index}`);
    const provider: MarketDataProvider = {
      async getQuote(symbol) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { symbol, price: 12, volume: 1_000_000, asOf: new Date("2026-08-31T14:30:00Z") };
      },
      async getPriceHistory(symbol, days) {
        return Array.from({ length: days }, (_, index) => ({
          symbol,
          date: new Date(Date.UTC(2026, 7, index + 1)),
          open: 12,
          high: 12.5,
          low: 11.5,
          close: 12,
          volume: 1000,
        }));
      },
      async getOptionChain() {
        return [];
      },
      async getInstrument(symbol) {
        return { symbol, description: symbol, assetType: "EQUITY" };
      },
      async getMarketHours() {
        return { isOpen: true };
      },
    };

    await evaluateLiveMarketScan({ provider, rules, universe });

    expect(maxActive).toBeLessThanOrEqual(SCAN_FETCH_CONCURRENCY);
  });

  it("produces identical results whether requests are serialized or run at bounded concurrency", async () => {
    const universe = Array.from({ length: 10 }, (_, index) => `TICK${index}`);
    function buildProvider(): MarketDataProvider {
      return {
        async getQuote(symbol) {
          const seed = universe.indexOf(symbol);
          return { symbol, price: 10 + seed, volume: 1_000_000 + seed * 1000, asOf: new Date("2026-08-31T14:30:00Z") };
        },
        async getPriceHistory(symbol, days) {
          const seed = universe.indexOf(symbol);
          return Array.from({ length: days }, (_, index) => ({
            symbol,
            date: new Date(Date.UTC(2026, 7, index + 1)),
            open: 10 + seed,
            high: 10.5 + seed,
            low: 9.5 + seed,
            close: 10 + seed - Math.sin((index + seed) / 3) * 0.4,
            volume: 1000 + index,
          }));
        },
        async getOptionChain(symbol) {
          const seed = universe.indexOf(symbol);
          return [
            {
              symbol: `${symbol} 260918P00011000`,
              underlyingSymbol: symbol,
              optionType: "PUT",
              strike: 9 + seed,
              expiration: new Date("2026-09-18T20:00:00Z"),
              bid: 0.2 + seed * 0.01,
              ask: 0.26 + seed * 0.01,
              mark: 0.23 + seed * 0.01,
              delta: -0.22,
              openInterest: 250 + seed,
              volume: 41 + seed,
            },
          ];
        },
        async getInstrument(symbol) {
          return { symbol, description: `${symbol} common stock`, assetType: "EQUITY" };
        },
        async getMarketHours() {
          return { isOpen: true };
        },
      };
    }

    const asOf = new Date("2026-08-31T12:00:00Z");
    const serializedResults = await evaluateLiveMarketScan({ provider: serialize(buildProvider()), rules, universe, asOf });
    const concurrentResults = await evaluateLiveMarketScan({ provider: buildProvider(), rules, universe, asOf });

    expect(concurrentResults).toEqual(serializedResults);
  });
});
