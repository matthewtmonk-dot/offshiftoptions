import { describe, expect, it } from "vitest";
import type { MarketDataProvider, OptionContractSnapshot } from "@/providers/market-data/types";
import { evaluateLiveMarketScan, type LiveScanEarningsLookup, type LiveScanTechnicalLookup } from "./live-scan";
import type { ScannerRule } from "./scanner";

/**
 * "Most cushion that still meets your target" (Matt, 2026-10-14). Among strikes that tie on setup
 * score and PASS the user's ROR target, the scanner now shows the LOWEST strike (most distance below
 * the stock price) instead of the highest-return one - which is always the strike closest to the
 * price. Stock is $20 in every case; the chain has four weekly strikes with falling premium.
 */
const asOf = new Date("2026-10-14T14:00:00Z");
const ready: LiveScanTechnicalLookup = { state: "READY", rsi: 30, bbLower: 18, bbMiddle: 23, bbUpper: 28 };
const earnings: LiveScanEarningsLookup = { daysUntilReport: 36, reportDate: "2026-11-19" };

const baseRules: ScannerRule[] = [
  { key: "price", name: "Stock price", operator: "BETWEEN", desired: [10, 50] },
  { key: "rsi", name: "RSI", operator: "LTE", desired: 40 },
  { key: "bbPercent", name: "BB %", operator: "LTE", desired: 33 },
  { key: "earningsDistance", name: "Earnings distance", operator: "GTE", desired: 10 },
  { key: "optionBid", name: "Option bid", operator: "GTE", desired: 0.1 },
  { key: "openInterest", name: "Open interest", operator: "GTE", desired: 100 },
];
const rorRule: ScannerRule = { key: "ror", name: "Put ROR", operator: "GTE", desired: 1 };
const deltaRule: ScannerRule = { key: "delta", name: "Absolute delta", operator: "BETWEEN", desired: [0.12, 0.3] };

function put(strike: number, bid: number, overrides: Partial<OptionContractSnapshot> = {}): OptionContractSnapshot {
  return {
    symbol: `T-${strike}-PUT`, underlyingSymbol: "T", optionType: "PUT", strike,
    expiration: new Date(Date.UTC(2026, 9, 21, 20)), // 7 DTE
    bid, ask: bid + 0.05, mark: bid + 0.02, openInterest: 200, volume: 10, delta: -(0.5 - (20 - strike) * 0.1),
    ...overrides,
  };
}

// ROR (bid / strike): 19 -> 2.1%, 18 -> 1.4%, 17 -> 1.06%, 16 -> 0.6%
const chain = () => [put(19, 0.4), put(18, 0.25), put(17, 0.18), put(16, 0.1)];

async function select(options: OptionContractSnapshot[], rules: ScannerRule[]) {
  const provider: MarketDataProvider = {
    async getQuote(symbol) { return { symbol, price: 20, volume: 100_000, asOf }; },
    async getPriceHistory() { throw new Error("no live history"); },
    async getOptionChain() { return options; },
    async getInstrument(symbol) { return { symbol, description: symbol, assetType: "EQUITY" }; },
    async getMarketHours() { return { isOpen: true }; },
  };
  const [row] = await evaluateLiveMarketScan({
    provider, rules, asOf, universe: ["T"],
    technicalCache: new Map([["T", ready]]), earningsLookup: new Map([["T", earnings]]),
  });
  return row;
}

describe("strike selection: most cushion that still meets the ROR target", () => {
  it("picks the lowest strike that still passes ROR, not the highest-return strike nearest the price", async () => {
    const row = await select(chain(), [...baseRules, rorRule]);
    expect(row.values.strike).toBe(17); // 1.06% >= 1%; the 16 strike only pays 0.6%
    expect(row.values.optionSymbol).toBe("T-17-PUT");
    expect(row.summary.results.find((result) => result.key === "ror")?.status).toBe("PASS");
    expect(row.summary.status).toBe("PASS");
  });

  it("keeps the old highest-return choice when the user has no ROR target enabled", async () => {
    const row = await select(chain(), baseRules);
    expect(row.values.strike).toBe(19);
  });

  it("never prefers a strike that misses the target: if nothing passes ROR, the highest return stands", async () => {
    const row = await select([put(19, 0.12), put(18, 0.1), put(17, 0.1)], [...baseRules, rorRule]); // best ROR = 0.63%
    expect(row.values.strike).toBe(19);
    expect(row.summary.results.find((result) => result.key === "ror")?.status).toBe("FAIL");
  });

  it("score still decides first: a lower strike that fails another rule loses to a higher one that passes everything", async () => {
    const row = await select([put(19, 0.4), put(18, 0.25), put(17, 0.18, { openInterest: 20 })], [...baseRules, rorRule]);
    expect(row.values.strike).toBe(18); // 17 would be the most cushion, but its open interest (20) fails the >=100 rule
  });

  it("works together with a delta range: far-out strikes below the minimum delta are never the pick", async () => {
    // deltas: 19 -> .40, 18 -> .30, 17 -> .20, 16 -> .10 (below the .12 floor). 16 fails ROR anyway,
    // so give it a passing premium to prove the delta rule - not just ROR - is what keeps it out.
    const row = await select([put(19, 0.4), put(18, 0.25), put(17, 0.18), put(16, 0.2)], [...baseRules, rorRule, deltaRule]);
    expect(row.values.strike).toBe(17); // 16 passes ROR (1.25%) but delta .10 < .12, so it is gated out
  });

  it("breaks an exact-strike tie by higher annualized return, then symbol (deterministic)", async () => {
    const row = await select([put(17, 0.18, { symbol: "B" }), put(17, 0.2, { symbol: "A" })], [...baseRules, rorRule]);
    expect(row.values.optionSymbol).toBe("A"); // same strike; the higher bid has the higher return
  });
});
