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

  it("a far-future contract IS selectable when the DTE rule is disabled - no hidden 14-45 gate", async () => {
    // `rules` (shared across this describe block) has no `dte` entry - the DTE rule is
    // disabled, exactly like its documented default (SCANNER_RULE_DEFINITIONS: defaultEnabled:
    // false). A contract nearly a year out must still be selectable; the old hardcoded 14-45
    // pre-filter in bestPutValues() would have silently discarded it before Scanner Rules ever
    // ran, regardless of what the user configured.
    const provider: MarketDataProvider = {
      async getQuote(symbol) {
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
            symbol: `${symbol} 270101P00011000`,
            underlyingSymbol: symbol,
            optionType: "PUT",
            strike: 11,
            expiration: new Date("2027-01-01T20:00:00Z"), // far beyond the old hardcoded 14-45 window
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
      universe: ["RIOT"],
      asOf: new Date("2026-08-31T12:00:00Z"),
      maxOptionChainLookups: 1,
    });

    const riot = results.find((result) => result.ticker === "RIOT");
    expect(riot?.values.strike).toBe(11);
    expect(riot?.values.optionBid).toBe(0.2);
    expect(riot?.values.dte).toBeGreaterThan(100);
    expect(riot?.values.scanNote).toBeUndefined();
    expect(riot?.values.contractReasonCode).toBeUndefined();
  });

  it("when the DTE rule IS enabled, contract discovery uses the user's own configured range - not a hidden 14-45 window", async () => {
    const dteRules: ScannerRule[] = [...rules, { key: "dte", name: "DTE", operator: "BETWEEN", desired: [60, 400] }];
    const provider: MarketDataProvider = {
      async getQuote(symbol) {
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
          // 21 DTE - inside the OLD hardcoded 14-45 window, but outside the user's configured
          // 60-400 range, so it must NOT be selected now that DTE is enabled.
          {
            symbol: `${symbol} 260921P00011000`,
            underlyingSymbol: symbol,
            optionType: "PUT",
            strike: 11,
            expiration: new Date("2026-09-21T20:00:00Z"),
            bid: 0.2,
            ask: 0.26,
            mark: 0.23,
            delta: -0.22,
            openInterest: 250,
            volume: 41,
          },
          // ~123 DTE - outside the old hardcoded window, but inside the user's configured range.
          {
            symbol: `${symbol} 270101P00011500`,
            underlyingSymbol: symbol,
            optionType: "PUT",
            strike: 11.5,
            expiration: new Date("2027-01-01T20:00:00Z"),
            bid: 0.3,
            ask: 0.36,
            mark: 0.33,
            delta: -0.25,
            openInterest: 300,
            volume: 50,
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
      rules: dteRules,
      universe: ["RIOT"],
      asOf: new Date("2026-08-31T12:00:00Z"),
      maxOptionChainLookups: 1,
    });

    const riot = results.find((result) => result.ticker === "RIOT");
    expect(riot?.values.strike).toBe(11.5);
    expect(riot?.values.dte).toBeGreaterThanOrEqual(60);
  });

  it("reports NO_EXPIRATIONS_IN_CONFIGURED_RANGE when the DTE rule is enabled and nothing qualifies", async () => {
    const dteRules: ScannerRule[] = [...rules, { key: "dte", name: "DTE", operator: "BETWEEN", desired: [200, 300] }];
    const provider: MarketDataProvider = {
      async getQuote(symbol) {
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
      async getOptionChain(symbol) {
        return [
          {
            symbol: `${symbol} 260918P00011000`,
            underlyingSymbol: symbol,
            optionType: "PUT",
            strike: 11,
            expiration: new Date("2026-09-18T20:00:00Z"), // ~18 DTE - outside 200-300
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
      rules: dteRules,
      universe: ["RIOT"],
      asOf: new Date("2026-08-31T12:00:00Z"),
      maxOptionChainLookups: 1,
    });

    const riot = results.find((result) => result.ticker === "RIOT");
    expect(riot?.values.contractReasonCode).toBe("NO_EXPIRATIONS_IN_CONFIGURED_RANGE");
    expect(riot?.values.scanNote).toBe("No put matched your configured DTE range.");
    expect(riot?.values.strike).toBeNull();
    // Stock-level values ARE known here (unlike a whole-ticker fetch failure) - only the
    // option side is blank, which is exactly what distinguishes this from case D.
    expect(riot?.values.price).toBe(12);
  });

  it("reports NO_CONTRACT_WITH_POSITIVE_BID when every otherwise-eligible put has a zero bid", async () => {
    const provider: MarketDataProvider = {
      async getQuote(symbol) {
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
      async getOptionChain(symbol) {
        return [
          {
            symbol: `${symbol} 260918P00011000`,
            underlyingSymbol: symbol,
            optionType: "PUT",
            strike: 11,
            expiration: new Date("2026-09-18T20:00:00Z"),
            bid: 0,
            ask: 0.05,
            mark: 0.02,
            delta: -0.1,
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
      universe: ["RIOT"],
      asOf: new Date("2026-08-31T12:00:00Z"),
      maxOptionChainLookups: 1,
    });

    const riot = results.find((result) => result.ticker === "RIOT");
    expect(riot?.values.contractReasonCode).toBe("NO_CONTRACT_WITH_POSITIVE_BID");
    expect(riot?.values.scanNote).toBe("Option chain returned, but no contract had a positive bid.");
  });

  it("reports NO_PUT_CONTRACTS when the chain has no put contracts at all", async () => {
    const provider: MarketDataProvider = {
      async getQuote(symbol) {
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
      async getOptionChain(symbol) {
        return [
          {
            symbol: `${symbol} 260918C00013000`,
            underlyingSymbol: symbol,
            optionType: "CALL",
            strike: 13,
            expiration: new Date("2026-09-18T20:00:00Z"),
            bid: 0.2,
            ask: 0.26,
            mark: 0.23,
            delta: 0.3,
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
      universe: ["RIOT"],
      asOf: new Date("2026-08-31T12:00:00Z"),
      maxOptionChainLookups: 1,
    });

    const riot = results.find((result) => result.ticker === "RIOT");
    expect(riot?.values.contractReasonCode).toBe("NO_PUT_CONTRACTS");
  });

  it("reports OPTION_LIQUIDITY_FAILED when every put fails an enabled liquidity gate (open interest)", async () => {
    const liquidityRules: ScannerRule[] = [...rules]; // openInterest GTE 100 already enabled
    const provider: MarketDataProvider = {
      async getQuote(symbol) {
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
            openInterest: 5, // well below the enabled openInterest >= 100 gate
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
      rules: liquidityRules,
      universe: ["RIOT"],
      asOf: new Date("2026-08-31T12:00:00Z"),
      maxOptionChainLookups: 1,
    });

    const riot = results.find((result) => result.ticker === "RIOT");
    expect(riot?.values.contractReasonCode).toBe("OPTION_LIQUIDITY_FAILED");
  });

  it("does not exclude on open interest when the openInterest rule is disabled", async () => {
    const noLiquidityRules: ScannerRule[] = rules.filter((rule) => rule.key !== "openInterest");
    const provider: MarketDataProvider = {
      async getQuote(symbol) {
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
            openInterest: 5, // would fail the rule if enabled, but it is disabled here
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
      rules: noLiquidityRules,
      universe: ["RIOT"],
      asOf: new Date("2026-08-31T12:00:00Z"),
      maxOptionChainLookups: 1,
    });

    const riot = results.find((result) => result.ticker === "RIOT");
    expect(riot?.values.strike).toBe(11);
    expect(riot?.values.contractReasonCode).toBeUndefined();
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

  it("option volume never hard-excludes a contract even when the optionVolume rule is enabled - it is a preference, not a gate", async () => {
    // optionVolume is intentionally absent from profile.ts's GATING_RULE_KEYS - a FAIL should
    // only lower the score/label, never remove the contract from consideration the way an
    // enabled openInterest/optionBid/spreadPercent/delta FAIL does.
    const volumeRules: ScannerRule[] = [...rules, { key: "optionVolume", name: "Option volume", operator: "GTE", desired: 500 }];
    const provider: MarketDataProvider = {
      async getQuote(symbol) {
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
            volume: 5, // well below the enabled optionVolume >= 500 rule
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
      rules: volumeRules,
      universe: ["RIOT"],
      asOf: new Date("2026-08-31T12:00:00Z"),
      maxOptionChainLookups: 1,
    });

    const riot = results.find((result) => result.ticker === "RIOT");
    // Still selected (not blank) - only its own optionVolume criterion reads FAIL.
    expect(riot?.values.strike).toBe(11);
    expect(riot?.values.contractReasonCode).toBeUndefined();
    expect(riot?.summary.results.find((result) => result.key === "optionVolume")?.status).toBe("FAIL");
  });

  it("an ETF/ETN ticker is scored the same as any equity - nothing in the engine excludes by asset class", async () => {
    const provider: MarketDataProvider = {
      async getQuote(symbol) {
        return { symbol, price: 17.74, volume: 40_000_000, asOf: new Date("2026-08-31T14:30:00Z") };
      },
      async getPriceHistory(symbol, days) {
        return Array.from({ length: days }, (_, index) => ({
          symbol,
          date: new Date(Date.UTC(2026, 7, index + 1)),
          open: 17.5,
          high: 18,
          low: 17,
          close: 17.74 - index * 0.05,
          volume: 40_000_000,
        }));
      },
      async getOptionChain(symbol) {
        return [
          {
            symbol: `${symbol} 260918P00016000`,
            underlyingSymbol: symbol,
            optionType: "PUT",
            strike: 16,
            expiration: new Date("2026-09-18T20:00:00Z"),
            bid: 0.2,
            ask: 0.26,
            mark: 0.23,
            delta: -0.2,
            openInterest: 500,
            volume: 100,
          },
        ];
      },
      async getInstrument(symbol) {
        // Schwab reports an ETN like VXX with assetType "ETF"/"ETN", not "EQUITY" - nothing in
        // the scan engine reads assetType at all, so this must not matter either way.
        return { symbol, description: `${symbol} exchange-traded note`, assetType: "ETN" };
      },
      async getMarketHours() {
        return { isOpen: true };
      },
    };

    const results = await evaluateLiveMarketScan({
      provider,
      rules,
      universe: ["VXX"],
      asOf: new Date("2026-08-31T12:00:00Z"),
      maxOptionChainLookups: 1,
    });

    const vxx = results.find((result) => result.ticker === "VXX");
    expect(vxx?.values.strike).toBe(16);
    expect(vxx?.values.contractReasonCode).toBeUndefined();
    expect(vxx?.summary.status).not.toBe("UNKNOWN");
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

  it("carries verified Schwab fundamentals as a sibling of values, never merged into scoring, and preserves real negative/zero values", async () => {
    const provider: MarketDataProvider = {
      async getQuote(symbol) {
        return {
          symbol,
          price: 12,
          asOf: new Date("2026-09-04T21:00:00Z"),
          companyDescription: `${symbol} REAL COMPANY NAME`,
          fundamentals: { peRatio: -27.5, eps: -0.9, dividendAmount: 0, dividendYield: 0, dividendFrequency: 0 },
        };
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
        return { isOpen: false };
      },
    };

    const results = await evaluateLiveMarketScan({ provider, rules, universe: ["APLD"] });
    const apld = results.find((result) => result.ticker === "APLD");

    // Negative/zero values must survive exactly - never dropped, never coerced to null/0-as-absent.
    expect(apld?.verifiedFundamentals).toEqual({ peRatio: -27.5, eps: -0.9, dividendAmount: 0, dividendYield: 0, dividendFrequency: 0 });
    expect(apld?.values.companyDescription).toBe("APLD REAL COMPANY NAME");
    expect(apld?.values.dividendFrequency).toBe(0);

    // None of the new fields are Scanner rule keys, so scoring must be identical to a run
    // where the provider supplies no fundamentals/company data at all.
    const plainProvider: MarketDataProvider = {
      ...provider,
      async getQuote(symbol) {
        return { symbol, price: 12, asOf: new Date("2026-09-04T21:00:00Z") };
      },
    };
    const plainResults = await evaluateLiveMarketScan({ provider: plainProvider, rules, universe: ["APLD"] });
    const plainApld = plainResults.find((result) => result.ticker === "APLD");
    expect(apld?.summary).toEqual(plainApld?.summary);
    expect(apld?.summary.status).toBe(plainApld?.summary.status);
  });
});
