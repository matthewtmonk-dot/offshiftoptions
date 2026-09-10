import { describe, expect, it } from "vitest";
import { evaluateLiveMarketScan, type LiveScanEarningsLookup, type LiveScanTechnicalLookup } from "./live-scan";
import type { MarketDataProvider } from "@/providers/market-data/types";
import type { ScannerRule } from "./scanner";

/**
 * Covers the broad-scanner activation path: evaluateLiveMarketScan called WITH a technicalCache
 * (and optionally an earningsLookup) - the mode a real interactive scan against hundreds/thousands
 * of symbols must always use, per PROJECT_HANDOFF.md's explicit "never re-fetch price history for
 * the broad universe" requirement. live-scan.test.ts and live-scan.low-stress-comparison.test.ts
 * cover the OTHER (legacy, no technicalCache) mode - both must keep passing unchanged.
 */
const rules: ScannerRule[] = [
  { key: "price", name: "Stock price", operator: "BETWEEN", desired: [5, 60] },
  { key: "stockVolume", name: "Underlying volume", operator: "GTE", desired: 40_000 },
  { key: "rsi", name: "RSI", operator: "LTE", desired: 40 },
  { key: "bbPercent", name: "BB %", operator: "LTE", desired: 33 },
  { key: "earningsDistance", name: "Earnings distance", operator: "GTE", desired: 10 },
];

function buildProvider(overrides: Partial<MarketDataProvider> = {}): MarketDataProvider {
  return {
    async getQuote(symbol) {
      return { symbol, price: 20, volume: 1_000_000, asOf: new Date("2026-09-08T14:30:00Z") };
    },
    getQuotes: async (symbols) =>
      new Map(symbols.map((symbol) => [symbol, { symbol, price: 20, volume: 1_000_000, asOf: new Date("2026-09-08T14:30:00Z") }])),
    async getPriceHistory() {
      throw new Error("getPriceHistory must never be called when a technicalCache is supplied");
    },
    async getOptionChain(symbol) {
      return [
        {
          symbol: `${symbol} 260918P00018000`,
          underlyingSymbol: symbol,
          optionType: "PUT",
          strike: 18,
          expiration: new Date("2026-09-18T20:00:00Z"),
          bid: 0.3,
          ask: 0.36,
          mark: 0.33,
          delta: -0.2,
          openInterest: 500,
          volume: 100,
        },
      ];
    },
    async getInstrument(symbol) {
      return { symbol, description: symbol, assetType: "EQUITY" };
    },
    async getMarketHours() {
      return { isOpen: true };
    },
    ...overrides,
  };
}

describe("evaluateLiveMarketScan - technical cache mode (broad scanner)", () => {
  it("never calls provider.getPriceHistory when a technicalCache is supplied, even for quote-eligible survivors", async () => {
    const technicalCache = new Map<string, LiveScanTechnicalLookup>([
      ["AAA", { state: "READY", rsi: 25, bbLower: 15, bbMiddle: 20, bbUpper: 25 }],
    ]);

    const results = await evaluateLiveMarketScan({
      provider: buildProvider(),
      rules,
      universe: ["AAA"],
      technicalCache,
    });

    expect(results.find((result) => result.ticker === "AAA")?.values.rsi).toBe(25);
  });

  it("uses the cached RSI value directly for a READY entry", async () => {
    const technicalCache = new Map<string, LiveScanTechnicalLookup>([
      ["AAA", { state: "READY", rsi: 22.5, bbLower: 15, bbMiddle: 20, bbUpper: 25 }],
    ]);

    const results = await evaluateLiveMarketScan({ provider: buildProvider(), rules, universe: ["AAA"], technicalCache });
    const aaa = results.find((result) => result.ticker === "AAA");

    expect(aaa?.values.rsi).toBe(22.5);
    expect(aaa?.summary.results.find((result) => result.key === "rsi")?.status).toBe("PASS");
  });

  it("recomputes BB position from the LIVE quote price + cached bands - never a stale precomputed percent", async () => {
    const bands = { bbLower: 15, bbMiddle: 20, bbUpper: 25 };
    const technicalCache = new Map<string, LiveScanTechnicalLookup>([["LOW", { state: "READY", rsi: 20, ...bands }]]);
    const technicalCacheHigh = new Map<string, LiveScanTechnicalLookup>([["HIGH", { state: "READY", rsi: 20, ...bands }]]);

    // Same cached bands, two different LIVE quote prices - bbPercent must differ, proving it's
    // computed fresh from the quote each time, never read as a stored percent. getQuotes is
    // explicitly disabled here so the override to getQuote actually takes effect (otherwise the
    // base fixture's batched getQuotes, unaffected by this override, would still win).
    const lowPriceProvider = buildProvider({
      getQuotes: undefined,
      async getQuote(symbol) {
        return { symbol, price: 16, volume: 1_000_000, asOf: new Date() };
      },
    });
    const highPriceProvider = buildProvider({
      getQuotes: undefined,
      async getQuote(symbol) {
        return { symbol, price: 24, volume: 1_000_000, asOf: new Date() };
      },
    });

    const lowResults = await evaluateLiveMarketScan({ provider: lowPriceProvider, rules, universe: ["LOW"], technicalCache });
    const highResults = await evaluateLiveMarketScan({ provider: highPriceProvider, rules, universe: ["HIGH"], technicalCache: technicalCacheHigh });

    const lowBbPercent = lowResults.find((result) => result.ticker === "LOW")?.values.bbPercent;
    const highBbPercent = highResults.find((result) => result.ticker === "HIGH")?.values.bbPercent;

    // bollingerPositionPercent(price, {lower:15, upper:25}) = (price-15)/10*100
    expect(lowBbPercent).toBe(10); // (16-15)/10*100
    expect(highBbPercent).toBe(90); // (24-15)/10*100
  });

  it("a STALE technical entry never contributes rsi/bbPercent - cannot fake a PASS", async () => {
    const technicalCache = new Map<string, LiveScanTechnicalLookup>([
      ["AAA", { state: "TECHNICAL_DATA_STALE", rsi: 5, bbLower: 15, bbMiddle: 20, bbUpper: 25 }], // rsi=5 would PASS if used
    ]);

    const results = await evaluateLiveMarketScan({ provider: buildProvider(), rules, universe: ["AAA"], technicalCache });
    const aaa = results.find((result) => result.ticker === "AAA");

    expect(aaa?.values.rsi).toBeNull();
    expect(aaa?.values.bbPercent).toBeNull();
    expect(aaa?.summary.results.find((result) => result.key === "rsi")?.status).toBe("UNKNOWN");
    expect(aaa?.summary.status).not.toBe("PASS");
    expect(aaa?.values.technicalReasonCode).toBe("TECHNICAL_DATA_STALE");
  });

  it("a PENDING (missing) technical entry never contributes rsi/bbPercent - cannot fake a PASS", async () => {
    const technicalCache = new Map<string, LiveScanTechnicalLookup>(); // AAA absent entirely

    const results = await evaluateLiveMarketScan({ provider: buildProvider(), rules, universe: ["AAA"], technicalCache });
    const aaa = results.find((result) => result.ticker === "AAA");

    expect(aaa?.values.rsi).toBeNull();
    expect(aaa?.values.bbPercent).toBeNull();
    expect(aaa?.summary.results.find((result) => result.key === "rsi")?.status).toBe("UNKNOWN");
    expect(aaa?.summary.status).not.toBe("PASS");
    expect(aaa?.values.technicalReasonCode).toBe("TECHNICAL_DATA_PENDING");
  });

  it("a FAILED (HISTORY_UNAVAILABLE) technical entry never contributes rsi/bbPercent - cannot fake a PASS", async () => {
    const technicalCache = new Map<string, LiveScanTechnicalLookup>([["AAA", { state: "HISTORY_UNAVAILABLE" }]]);

    const results = await evaluateLiveMarketScan({ provider: buildProvider(), rules, universe: ["AAA"], technicalCache });
    const aaa = results.find((result) => result.ticker === "AAA");

    expect(aaa?.values.rsi).toBeNull();
    expect(aaa?.values.bbPercent).toBeNull();
    expect(aaa?.summary.results.find((result) => result.key === "rsi")?.status).toBe("UNKNOWN");
    expect(aaa?.summary.status).not.toBe("PASS");
    expect(aaa?.values.technicalReasonCode).toBe("TECHNICAL_DATA_FAILED");
  });

  it("a ticker still reaches the shortlist/option-chain stage with pending technical data - partial cache never blocks the scan", async () => {
    const technicalCache = new Map<string, LiveScanTechnicalLookup>(); // fully empty - everyone pending

    const results = await evaluateLiveMarketScan({
      provider: buildProvider(),
      rules,
      universe: ["AAA"],
      technicalCache,
      maxOptionChainLookups: 8,
    });

    const aaa = results.find((result) => result.ticker === "AAA");
    // Still reached the option-chain stage (only candidate, no competition for the 8 slots) and
    // got a real contract - technical-data pending does not exclude a ticker from scoring/ranking.
    expect(aaa?.reachedOptionChainLookup).toBe(true);
    expect(aaa?.values.strike).toBe(18);
  });

  it("reads earnings distance from the cache only - never a live Alpha Vantage call, absent ticker stays UNKNOWN", async () => {
    const technicalCache = new Map<string, LiveScanTechnicalLookup>([
      ["KNOWN", { state: "READY", rsi: 25, bbLower: 15, bbMiddle: 20, bbUpper: 25 }],
      ["UNKNOWNTICKER", { state: "READY", rsi: 25, bbLower: 15, bbMiddle: 20, bbUpper: 25 }],
    ]);
    const earningsLookup = new Map<string, LiveScanEarningsLookup>([["KNOWN", { daysUntilReport: 45, reportDate: "2026-10-23" }]]);

    const results = await evaluateLiveMarketScan({
      provider: buildProvider(),
      rules,
      universe: ["KNOWN", "UNKNOWNTICKER"],
      technicalCache,
      earningsLookup,
    });

    const known = results.find((result) => result.ticker === "KNOWN");
    const unknown = results.find((result) => result.ticker === "UNKNOWNTICKER");

    expect(known?.values.earningsDistance).toBe(45);
    expect(known?.values.earningsDate).toBe("2026-10-23");
    expect(known?.summary.results.find((result) => result.key === "earningsDistance")?.status).toBe("PASS");

    expect(unknown?.values.earningsDistance).toBeNull();
    expect(unknown?.summary.results.find((result) => result.key === "earningsDistance")?.status).toBe("UNKNOWN");
  });

  it("quote-stage gating excludes on underlying volume before any technical-cache read, with an honest scanNote", async () => {
    const provider = buildProvider({
      getQuotes: async (symbols) =>
        new Map(
          symbols.map((symbol) => [
            symbol,
            { symbol, price: 20, volume: symbol === "THIN" ? 500 : 1_000_000, asOf: new Date("2026-09-08T14:30:00Z") },
          ]),
        ),
    });
    const technicalCache = new Map<string, LiveScanTechnicalLookup>([
      ["THIN", { state: "READY", rsi: 25, bbLower: 15, bbMiddle: 20, bbUpper: 25 }],
      ["THICK", { state: "READY", rsi: 25, bbLower: 15, bbMiddle: 20, bbUpper: 25 }],
    ]);

    const results = await evaluateLiveMarketScan({ provider, rules, universe: ["THIN", "THICK"], technicalCache });
    const thin = results.find((result) => result.ticker === "THIN");
    const thick = results.find((result) => result.ticker === "THICK");

    expect(thin?.funnelStage).toBe("QUOTE_EXCLUDED");
    expect(thin?.values.rsi).toBeNull(); // never even looked up in the technical cache
    expect(thin?.values.scanNote).toBe("Below your configured minimum underlying volume; history and option-chain lookups were skipped.");
    expect(thick?.funnelStage).toBe("STOCK_STAGE");
    expect(thick?.values.rsi).toBe(25);
  });

  it("once live volume rises above the configured rule, an already-prepared ticker uses cached RSI/BB", async () => {
    const technicalCache = new Map<string, LiveScanTechnicalLookup>([
      ["THIN", { state: "READY", rsi: 25, bbLower: 15, bbMiddle: 20, bbUpper: 25 }],
    ]);
    const lowVolumeProvider = buildProvider({
      getQuotes: async (symbols) =>
        new Map(
          symbols.map((symbol) => [
            symbol,
            { symbol, price: 20, volume: 5_000, asOf: new Date("2026-09-08T12:30:00Z") },
          ]),
        ),
    });
    const higherVolumeProvider = buildProvider({
      getQuotes: async (symbols) =>
        new Map(
          symbols.map((symbol) => [
            symbol,
            { symbol, price: 20, volume: 100_000, asOf: new Date("2026-09-08T14:30:00Z") },
          ]),
        ),
    });

    const earlyResults = await evaluateLiveMarketScan({ provider: lowVolumeProvider, rules, universe: ["THIN"], technicalCache });
    const laterResults = await evaluateLiveMarketScan({ provider: higherVolumeProvider, rules, universe: ["THIN"], technicalCache });
    const earlyThin = earlyResults.find((result) => result.ticker === "THIN");
    const laterThin = laterResults.find((result) => result.ticker === "THIN");

    expect(earlyThin?.funnelStage).toBe("QUOTE_EXCLUDED");
    expect(earlyThin?.values.rsi).toBeNull();
    expect(laterThin?.funnelStage).toBe("STOCK_STAGE");
    expect(laterThin?.values.stockVolume).toBe(100_000);
    expect(laterThin?.values.rsi).toBe(25);
    expect(laterThin?.values.bbPercent).toBe(50);
  });

  it("tags funnelStage and reachedOptionChainLookup correctly across every category", async () => {
    const provider = buildProvider({
      async getQuote(symbol) {
        if (symbol === "NOQUOTE") throw new Error("unavailable");
        return { symbol, price: symbol === "TOOEXPENSIVE" ? 999 : 20, volume: 1_000_000, asOf: new Date() };
      },
      getQuotes: undefined,
    });
    const technicalCache = new Map<string, LiveScanTechnicalLookup>([
      // bbUpper wide enough that (20-15)/(45-15)*100 = 16.67 comfortably passes the bbPercent<=33
      // rule - a tight band here would fail GOOD on bbPercent and mask what this test checks.
      ["GOOD", { state: "READY", rsi: 20, bbLower: 15, bbMiddle: 20, bbUpper: 45 }],
    ]);

    const results = await evaluateLiveMarketScan({
      provider,
      rules,
      universe: ["GOOD", "TOOEXPENSIVE", "NOQUOTE"],
      technicalCache,
      maxOptionChainLookups: 8,
    });

    expect(results.find((r) => r.ticker === "GOOD")?.funnelStage).toBe("STOCK_STAGE");
    expect(results.find((r) => r.ticker === "GOOD")?.reachedOptionChainLookup).toBe(true);
    expect(results.find((r) => r.ticker === "TOOEXPENSIVE")?.funnelStage).toBe("QUOTE_EXCLUDED");
    expect(results.find((r) => r.ticker === "TOOEXPENSIVE")?.reachedOptionChainLookup).toBe(false);
    expect(results.find((r) => r.ticker === "NOQUOTE")?.funnelStage).toBe("UNAVAILABLE");
    expect(results.find((r) => r.ticker === "NOQUOTE")?.reachedOptionChainLookup).toBe(false);
  });
});
