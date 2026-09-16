import { describe, expect, it, vi } from "vitest";
import type { MarketDataProvider, OptionContractSnapshot } from "@/providers/market-data/types";
import { compareStockStageCandidates, evaluateLiveMarketScan, type LiveScanEarningsLookup, type LiveScanTechnicalLookup } from "./live-scan";
import { SCANNER_RULE_DEFINITIONS } from "./profile";
import { getNearMisses, type ScannerRule } from "./scanner";

const asOf = new Date("2026-09-16T14:00:00Z");
const rules: ScannerRule[] = SCANNER_RULE_DEFINITIONS.filter((rule) => rule.defaultEnabled).map((rule) => ({
  key: rule.key, name: rule.name, operator: rule.operator, desired: rule.defaultDesired,
}));
const ready: LiveScanTechnicalLookup = { state: "READY", rsi: 30, bbLower: 18, bbMiddle: 23, bbUpper: 28 };
const earnings: LiveScanEarningsLookup = { daysUntilReport: 36, reportDate: "2026-10-22" };

function put(dte: number, overrides: Partial<OptionContractSnapshot> = {}): OptionContractSnapshot {
  return {
    symbol: `TEST-${dte}-19-PUT`, underlyingSymbol: "TEST", optionType: "PUT", strike: 19,
    expiration: new Date(Date.UTC(2026, 8, 16 + dte, 20)),
    bid: 0.25, ask: 0.30, mark: 0.275, openInterest: 200, volume: 0, delta: -0.2,
    ...overrides,
  };
}

function fixture(options: OptionContractSnapshot[], tickers = ["TEST"]) {
  const calls: string[] = [];
  const history = vi.fn(async () => { throw new Error("Unexpected live history fetch"); });
  const provider: MarketDataProvider = {
    async getQuote(symbol) { return { symbol, price: 20, volume: 100_000, asOf }; },
    getPriceHistory: history,
    async getOptionChain(symbol) { calls.push(symbol); return options; },
    async getInstrument(symbol) { return { symbol, description: symbol, assetType: "EQUITY" }; },
    async getMarketHours() { return { isOpen: true }; },
  };
  const technicalCache = new Map(tickers.map((ticker) => [ticker, ready]));
  const earningsLookup = new Map(tickers.map((ticker) => [ticker, earnings]));
  return { provider, calls, history, technicalCache, earningsLookup, universe: tickers, rules, asOf };
}

describe("weekly expiration before strike scoring", () => {
  it("selects 7 DTE over a higher-return 21 DTE with hard DTE disabled", async () => {
    const input = fixture([put(21, { bid: 0.9, ask: 1, mark: 0.95 }), put(7)]);
    const [row] = await evaluateLiveMarketScan(input);
    expect(row.values).toMatchObject({ dte: 7, expiration: "2026-09-23", optionSelectionTargetDte: 7,
      optionSelectionFallback: false, optionSelectionReason: "CLOSEST_USABLE_EXPIRATION_TO_WEEKLY_TARGET" });
    expect(row.summary.status).toBe("PASS");
    expect(input.history).not.toHaveBeenCalled();
  });

  it("keeps the weekly ROR miss rather than replacing it with a longer PASS", async () => {
    const [row] = await evaluateLiveMarketScan(fixture([put(7, { bid: 0.18 }), put(21)]));
    expect(row.values.dte).toBe(7);
    expect(row.values.ror).toBe(0.95);
    expect(row.summary.status).toBe("FAIL");
    expect(row.summary.results.find((result) => result.key === "ror")?.status).toBe("FAIL");
    expect(getNearMisses(row.summary.results).map((result) => result.result.key)).toContain("ror");
    expect(row.values.optionSelectionFallback).toBe(false);
  });

  it.each([
    ["OTM", { strike: 20 }],
    ["positive bid", { bid: 0 }],
    ["minimum bid", { bid: 0.09 }],
    ["OI", { openInterest: 99 }],
  ] as const)("falls back only when all preferred-date contracts fail %s eligibility", async (_name, overrides) => {
    const [row] = await evaluateLiveMarketScan(fixture([put(21), put(7, overrides), put(9)]));
    expect(row.values).toMatchObject({ dte: 9, optionSelectionFallback: true, optionSelectionPreferredExpiration: "2026-09-23" });
  });

  it("keeps a date if even one of its strikes survives structural gates", async () => {
    const [row] = await evaluateLiveMarketScan(fixture([put(7, { bid: 0 }), put(7, { symbol: "USABLE", strike: 18 }), put(9)]));
    expect(row.values).toMatchObject({ dte: 7, optionSymbol: "USABLE", optionSelectionFallback: false });
  });

  it("does not count absent weekly listings or call-only dates as rejected put expirations", async () => {
    const [row] = await evaluateLiveMarketScan(fixture([put(7, { optionType: "CALL" }), put(21)]));
    expect(row.values).toMatchObject({ dte: 21, optionSelectionFallback: false });
  });

  it("honors enabled hard DTE bounds before preferring the closest remaining expiration", async () => {
    const input = fixture([put(7), put(14), put(21)]);
    const [row] = await evaluateLiveMarketScan({ ...input, rules: [...rules, { key: "dte", name: "DTE", operator: "BETWEEN", desired: [14, 21] }] });
    expect(row.values).toMatchObject({ dte: 14, optionSelectionFallback: true });
    const [none] = await evaluateLiveMarketScan({ ...input, rules: [...rules, { key: "dte", name: "DTE", operator: "BETWEEN", desired: [30, 40] }] });
    expect(none.values.contractReasonCode).toBe("NO_EXPIRATIONS_IN_CONFIGURED_RANGE");
  });

  it.each([[5, 9, 9], [2, 12, 12], [2, 9, 9], [0, 7, 7]])("%i vs %i DTE selects %i", async (first, second, expected) => {
    for (const chain of [[put(first), put(second)], [put(second), put(first)]]) {
      const [row] = await evaluateLiveMarketScan(fixture(chain));
      expect(row.values.dte).toBe(expected);
    }
  });

  it("preserves enabled spread/delta gates and ignores them when disabled", async () => {
    const input = fixture([put(7, { ask: 2, delta: -0.9 }), put(9)]);
    expect((await evaluateLiveMarketScan(input))[0].values.dte).toBe(7);
    for (const extra of [
      { key: "spreadPercent", name: "Spread", operator: "LTE", desired: 30 },
      { key: "delta", name: "Delta", operator: "BETWEEN", desired: [0.12, 0.30] },
    ] satisfies ScannerRule[]) {
      const [row] = await evaluateLiveMarketScan({ ...input, rules: [...rules, extra] });
      expect(row.values).toMatchObject({ dte: 9, optionSelectionFallback: true });
    }
  });

  it("retains UNKNOWN OI on the preferred date instead of switching to a known longer PASS", async () => {
    const [row] = await evaluateLiveMarketScan(fixture([put(7, { openInterest: undefined }), put(21)]));
    expect(row.values).toMatchObject({ dte: 7, openInterest: null, optionSelectionFallback: false });
    expect(row.summary.status).toBe("UNKNOWN");
  });

  it("selects by score then annualized ROR within the chosen date", async () => {
    const [row] = await evaluateLiveMarketScan(fixture([
      put(7, { symbol: "UNKNOWN-OI", bid: 1, openInterest: undefined }),
      put(7, { symbol: "LOWER-ROR", bid: 0.25 }),
      put(7, { symbol: "WINNER", bid: 0.3 }), put(21, { bid: 2 }),
    ]));
    expect(row.values.optionSymbol).toBe("WINNER");
  });

  it("intentionally prefers lower strike for LST cushion when score and annualized return tie, then symbol regardless of provider order", async () => {
    // Matt's accepted preference: at a $20 stock price both puts return 2%, but $18
    // supplies more downside cushion and requires less collateral than $19.
    const options = [put(7, { symbol: "Z", strike: 18, bid: 0.36 }), put(7, { symbol: "HIGHER-STRIKE", strike: 19, bid: 0.38 }), put(7, { symbol: "A", strike: 18, bid: 0.36 })];
    const results = [];
    for (const chain of [options, [...options].reverse(), [options[1], options[0], options[2]]]) {
      results.push((await evaluateLiveMarketScan(fixture(chain)))[0]);
    }
    expect(results[0].values.optionSymbol).toBe("A");
    expect(results[0].values).toMatchObject({ strike: 18, ror: 2, dte: 7 });
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });
});

describe("chain shortlist evidence priority", () => {
  it("uses exactly eight slots for known-PASS stocks before stronger RSI with unknown earnings", async () => {
    const known = ["AAL", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH"];
    const input = fixture([put(7)], ["PL", ...known].reverse());
    input.earningsLookup.delete("PL");
    input.technicalCache.set("PL", { ...ready, rsi: 10 });
    const rows = await evaluateLiveMarketScan(input);
    expect(input.calls).toEqual(known);
    expect(rows.find((row) => row.ticker === "PL")).toMatchObject({ stockStagePriority: 1, reachedOptionChainLookup: false });
    expect(rows.find((row) => row.ticker === "AAL")).toMatchObject({ stockStagePriority: 0, reachedOptionChainLookup: true });
  });

  it("retains RSI/BB order inside each group, then ticker order even when universe order changes", async () => {
    for (const universe of [["ZZZ", "AAA", "BBB", "CCC"], ["CCC", "BBB", "AAA", "ZZZ"]]) {
      const input = fixture([put(7)], universe);
      input.technicalCache.set("ZZZ", { ...ready, rsi: 15 });
      input.earningsLookup.delete("BBB");
      input.earningsLookup.delete("CCC");
      input.technicalCache.set("CCC", { ...ready, rsi: 10 });
      await evaluateLiveMarketScan(input);
      expect(input.calls).toEqual(["ZZZ", "AAA", "CCC", "BBB"]);
    }
  });

  it("does not penalize missing earnings when that stock rule is disabled", async () => {
    const input = fixture([put(7)], ["KNOWN", "MISSING"]);
    input.earningsLookup.delete("MISSING");
    input.technicalCache.set("MISSING", { ...ready, rsi: 10 });
    await evaluateLiveMarketScan({ ...input, rules: rules.filter((rule) => rule.key !== "earningsDistance") });
    expect(input.calls).toEqual(["MISSING", "KNOWN"]);
  });

  it("excludes known stock failures while retaining incomplete evidence as lower priority", async () => {
    const input = fixture([put(7)], ["RSIFAIL", "BBFAIL", "EARNFAIL", "PENDING", "KNOWN"]);
    input.technicalCache.set("RSIFAIL", { ...ready, rsi: 41 });
    input.technicalCache.set("BBFAIL", { ...ready, bbLower: 10, bbMiddle: 15, bbUpper: 20 });
    input.earningsLookup.set("EARNFAIL", { ...earnings, daysUntilReport: 9 });
    input.technicalCache.set("PENDING", { state: "TECHNICAL_DATA_PENDING" });
    await evaluateLiveMarketScan(input);
    expect(input.calls).toEqual(["KNOWN", "PENDING"]);
  });

  it("keeps all chain-enriched candidates within the same-order saved-result cap", async () => {
    const unknown = Array.from({ length: 110 }, (_, i) => `UNKNOWN${i}`);
    const input = fixture([put(7)], [...unknown, "KNOWN"]);
    for (const ticker of unknown) {
      input.technicalCache.set(ticker, { ...ready, rsi: 10 });
      input.earningsLookup.delete(ticker);
    }
    const rows = await evaluateLiveMarketScan(input);
    const saved = [...rows].sort(compareStockStageCandidates).slice(0, 100);
    expect(saved[0].ticker).toBe("KNOWN");
    expect(saved.filter((row) => row.reachedOptionChainLookup)).toHaveLength(8);
  });
});
