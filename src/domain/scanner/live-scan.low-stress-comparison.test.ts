import { describe, expect, it } from "vitest";
import { evaluateLiveMarketScan, STARTER_LIVE_SCAN_UNIVERSE } from "./live-scan";
import type { MarketDataProvider } from "@/providers/market-data/types";
import type { ScannerRule } from "./scanner";

/**
 * Diagnostic comparison against the Low Stress scanner screenshot (see PROJECT_HANDOFF.md
 * "Stabilization Slice 3 - Scanner"). These seven tickers are COMPARISON FIXTURES, never
 * hardcoded into production scanner logic - this file only proves how OSO's engine WOULD
 * evaluate them under an equivalent rule set, and documents exactly why today's live scan
 * never actually reaches them (see the universe-membership assertion in each case).
 *
 * Approximate settings from the Low Stress screenshot: stock price $10-$50, RSI <= 40,
 * BB% <= 33, Put ROR >= 1.00%, earnings distance >= 10 days. DTE is left disabled, matching
 * the confirmed default (SCANNER_RULE_DEFINITIONS: dte defaultEnabled: false) - Part B of this
 * slice removed the old hidden 14-45 DTE pre-filter, so any DTE is eligible for selection here.
 *
 * Price history is a synthetic, declining series (consistent with the low RSI every fixture
 * ticker shows) ending at the fixture's quoted price - it is NOT engineered to hit the exact
 * fixture RSI/BB numbers, since real market data at a different moment will never match a
 * screenshot exactly. The option contract for each ticker is constructed so its bid/strike
 * ratio matches the fixture's approximate Put ROR, since ROR is directly controllable and is
 * the figure most useful for verifying OSO's formula (see cashSecuredReturnOnRisk).
 */
const LOW_STRESS_COMPARISON_RULES: ScannerRule[] = [
  { key: "price", name: "Stock price", operator: "BETWEEN", desired: [10, 50] },
  { key: "rsi", name: "RSI", operator: "LTE", desired: 40 },
  { key: "bbPercent", name: "BB %", operator: "LTE", desired: 33 },
  { key: "ror", name: "Put ROR", operator: "GTE", desired: 1.0 },
  { key: "earningsDistance", name: "Earnings distance", operator: "GTE", desired: 10 },
];

type Fixture = {
  ticker: string;
  price: number;
  approximateRsi: number;
  approximateBbPercent: number;
  approximatePutRorPercent: number;
};

const LOW_STRESS_FIXTURES: Fixture[] = [
  { ticker: "AAL", price: 13.13, approximateRsi: 36.2, approximateBbPercent: 21.0, approximatePutRorPercent: 1.4 },
  { ticker: "BYND", price: 11.46, approximateRsi: 32.8, approximateBbPercent: 13.7, approximatePutRorPercent: 1.2 },
  { ticker: "PL", price: 18.11, approximateRsi: 28.6, approximateBbPercent: 4.5, approximatePutRorPercent: 8.1 },
  { ticker: "SCO", price: 22.43, approximateRsi: 35.2, approximateBbPercent: 8.5, approximatePutRorPercent: 1.8 },
  { ticker: "UVIX", price: 37.86, approximateRsi: 31.3, approximateBbPercent: 11.9, approximatePutRorPercent: 3.2 },
  { ticker: "UVXY", price: 17.54, approximateRsi: 32.0, approximateBbPercent: 11.7, approximatePutRorPercent: 2.7 },
  { ticker: "VXX", price: 17.74, approximateRsi: 32.7, approximateBbPercent: 11.4, approximatePutRorPercent: 1.1 },
];

function buildDecliningCandles(symbol: string, endPrice: number, days: number) {
  // An overall downtrend into the end price, with small day-to-day oscillation (not a purely
  // monotonic decline, which would degenerate Wilder RSI to a meaningless 0) - qualitatively
  // consistent with every fixture's sub-40 RSI (recent selling pressure), without claiming to
  // reproduce its exact value.
  const startPrice = endPrice * 1.18;
  return Array.from({ length: days }, (_, index) => {
    const progress = index / (days - 1);
    const trend = startPrice - (startPrice - endPrice) * progress;
    const wobble = Math.sin(index / 2) * (startPrice - endPrice) * 0.03;
    const close = trend + wobble;
    return {
      symbol,
      date: new Date(Date.UTC(2026, 7, 1 + index)),
      open: close * 1.005,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 5_000_000,
    };
  });
}

function buildFixtureProvider(fixture: Fixture): MarketDataProvider {
  const strike = Math.round(fixture.price * 0.92 * 100) / 100; // a plausible OTM put strike
  const bid = Math.round(((strike * fixture.approximatePutRorPercent) / 100) * 100) / 100;
  return {
    async getQuote(symbol) {
      return { symbol, price: fixture.price, volume: 5_000_000, asOf: new Date("2026-08-31T14:30:00Z") };
    },
    async getPriceHistory(symbol, days) {
      return buildDecliningCandles(symbol, fixture.price, days);
    },
    async getOptionChain(symbol) {
      return [
        {
          symbol: `${symbol} 260918P${strike}`,
          underlyingSymbol: symbol,
          optionType: "PUT",
          strike,
          expiration: new Date("2026-09-18T20:00:00Z"),
          bid,
          ask: Math.round((bid + 0.06) * 100) / 100,
          mark: Math.round((bid + 0.03) * 100) / 100,
          delta: -0.2,
          openInterest: 500,
          volume: 100,
        },
      ];
    },
    async getInstrument(symbol) {
      return { symbol, description: `${symbol} comparison fixture`, assetType: "ETN" };
    },
    async getMarketHours() {
      return { isOpen: true };
    },
  };
}

describe("Low Stress scanner comparison (diagnostic, not a production universe change)", () => {
  it.each(LOW_STRESS_FIXTURES)(
    "$ticker: absent from today's fixed starter universe, but evaluates cleanly on OSO's engine once included",
    async (fixture) => {
      // Part A finding, locked in as a regression: today's live scan can only ever reach a
      // ticker already in STARTER_LIVE_SCAN_UNIVERSE or the user's own Research/Watchlist -
      // this is exactly why OSO never discovered any of these seven on its own.
      expect(STARTER_LIVE_SCAN_UNIVERSE).not.toContain(fixture.ticker);

      const results = await evaluateLiveMarketScan({
        provider: buildFixtureProvider(fixture),
        rules: LOW_STRESS_COMPARISON_RULES,
        universe: [fixture.ticker],
        asOf: new Date("2026-08-31T12:00:00Z"),
      });

      const result = results.find((candidate) => candidate.ticker === fixture.ticker);
      expect(result).toBeDefined();

      // A real contract was selected - never blank/UNKNOWN - proving nothing in the engine
      // (asset class, hidden DTE gate, etc.) architecturally excludes this ticker once it is
      // actually scanned.
      expect(result?.values.strike).not.toBeNull();
      expect(result?.values.contractReasonCode).toBeUndefined();

      // ROR reflects OSO's documented formula (premium / secured capital * 100 - see
      // cashSecuredReturnOnRisk in calculations.ts) applied to this fixture's own bid/strike,
      // not a value copied from the Low Stress screenshot.
      const ror = Number(result?.values.ror);
      expect(ror).toBeCloseTo(fixture.approximatePutRorPercent, 0);

      // Earnings distance is structurally unknown from Schwab quote/price-history data alone
      // (see Part G) - the earnings-distance criterion must read UNKNOWN, never a fabricated
      // PASS, and must never by itself force the overall row to FAIL (see scanner.ts:
      // UNKNOWN-but-no-FAIL status is "UNKNOWN", not "FAIL").
      const earningsResult = result?.summary.results.find((criterion) => criterion.key === "earningsDistance");
      expect(earningsResult?.status).toBe("UNKNOWN");

      // Report the qualitative comparison for human review - RSI/BB are computed from a
      // synthetic (not reproduced) price series, so only a directional/neighborhood check is
      // meaningful, per this file's own header note.
      console.info(
        `[low-stress-comparison] ${fixture.ticker}: OSO price=${result?.values.price}, rsi=${result?.values.rsi}, ` +
          `bbPercent=${result?.values.bbPercent}, strike=${result?.values.strike}, bid=${result?.values.optionBid}, ` +
          `ror=${result?.values.ror}, dte=${result?.values.dte}, oi=${result?.values.openInterest}, ` +
          `volume=${result?.values.optionVolume}, status=${result?.summary.status} ` +
          `(fixture: price=${fixture.price}, rsi~${fixture.approximateRsi}, bb~${fixture.approximateBbPercent}, ` +
          `ror~${fixture.approximatePutRorPercent})`,
      );
    },
  );
});
