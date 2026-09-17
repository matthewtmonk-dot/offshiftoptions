import { describe, expect, it } from "vitest";
import type { MarketDataProvider, OptionChainRequest, OptionContractSnapshot } from "@/providers/market-data/types";
import { evaluateLiveMarketScan, OPTION_CHAIN_ENRICHMENT_LIMIT, type LiveScanEarningsLookup, type LiveScanTechnicalLookup } from "./live-scan";
import { SCANNER_RULE_DEFINITIONS } from "./profile";
import type { ScannerRule } from "./scanner";

const asOf = new Date("2026-09-16T14:00:00Z");
const rules: ScannerRule[] = SCANNER_RULE_DEFINITIONS.filter((rule) => rule.defaultEnabled).map((rule) => ({
  key: rule.key, name: rule.name, operator: rule.operator, desired: rule.defaultDesired,
}));
/** price 20 against these bands puts BB at 20% - comfortably inside the <=33% rule. */
const ready: LiveScanTechnicalLookup = { state: "READY", rsi: 30, bbLower: 18, bbMiddle: 23, bbUpper: 28 };
const earnings: LiveScanEarningsLookup = { daysUntilReport: 36, reportDate: "2026-10-22" };

function put(dte: number, overrides: Partial<OptionContractSnapshot> = {}): OptionContractSnapshot {
  return {
    symbol: `P-${dte}`, underlyingSymbol: "TEST", optionType: "PUT", strike: 19,
    expiration: new Date(Date.UTC(2026, 8, 16 + dte, 20)),
    bid: 0.25, ask: 0.30, mark: 0.275, openInterest: 200, volume: 0, delta: -0.2,
    ...overrides,
  };
}

type ChainCall = { symbol: string; request?: OptionChainRequest };

function fixture(
  optionsFor: (symbol: string) => OptionContractSnapshot[],
  tickers: string[],
  options: { failChainFor?: Set<string> } = {},
) {
  const chainCalls: ChainCall[] = [];
  const provider: MarketDataProvider = {
    async getQuote(symbol) { return { symbol, price: 20, volume: 100_000, asOf }; },
    async getPriceHistory() { throw new Error("Unexpected live history fetch"); },
    async getOptionChain(symbol, request) {
      chainCalls.push({ symbol, request });
      if (options.failChainFor?.has(symbol)) {
        throw new Error("chain unavailable");
      }
      return optionsFor(symbol);
    },
    async getInstrument(symbol) { return { symbol, description: symbol, assetType: "EQUITY" }; },
    async getMarketHours() { return { isOpen: true }; },
  };
  const technicalCache = new Map<string, LiveScanTechnicalLookup>(tickers.map((ticker) => [ticker, ready]));
  const earningsLookup = new Map(tickers.map((ticker) => [ticker, earnings]));
  return { provider, chainCalls, technicalCache, earningsLookup, universe: tickers, rules, asOf };
}

/** More candidates than the chain budget, ranked deterministically by RSI so the exact winners
 * are predictable: RANK00 is strongest, RANK19 weakest. */
function rankedUniverse(count: number) {
  return Array.from({ length: count }, (_, index) => `RANK${String(index).padStart(2, "0")}`);
}

describe("option enrichment disposition", () => {
  it("marks the top-8 as ENRICHED and everything ranked below it as a BUDGET miss, never as missing Schwab data", async () => {
    const tickers = rankedUniverse(20);
    const input = fixture(() => [put(7)], tickers);
    tickers.forEach((ticker, index) => input.technicalCache.set(ticker, { ...ready, rsi: 20 + index }));

    const rows = await evaluateLiveMarketScan(input);
    const enriched = rows.filter((row) => row.values.optionEnrichment === "ENRICHED");
    const budgetMisses = rows.filter((row) => row.values.optionEnrichment === "NOT_ENRICHED_BUDGET");

    expect(enriched.map((row) => row.ticker)).toEqual(tickers.slice(0, OPTION_CHAIN_ENRICHMENT_LIMIT));
    expect(budgetMisses.map((row) => row.ticker)).toEqual(tickers.slice(OPTION_CHAIN_ENRICHMENT_LIMIT));
    expect(input.chainCalls).toHaveLength(OPTION_CHAIN_ENRICHMENT_LIMIT);
    // The honest reason is machine-readable AND in the note - never "Schwab had no option data".
    expect(budgetMisses[0].values.scanNote).toContain("outside the top 8");
    expect(budgetMisses[0].values.strike).toBeNull();
  });

  it("production cap is 8", () => {
    expect(OPTION_CHAIN_ENRICHMENT_LIMIT).toBe(8);
  });

  it("marks a known stock-level FAIL as STOCK_FILTER, never as a budget loss (the AAL case)", async () => {
    // Mirrors the real AAL row: BB just above the <=33% rule, so it is a known stock-level FAIL
    // and is excluded from the shortlist outright - it never competed for the budget at all.
    const input = fixture(() => [put(7)], ["AALLIKE", "CLEAN"]);
    input.technicalCache.set("AALLIKE", { state: "READY", rsi: 34, bbLower: 15, bbMiddle: 17, bbUpper: 19 });

    const rows = await evaluateLiveMarketScan(input);
    const aal = rows.find((row) => row.ticker === "AALLIKE");

    expect(aal?.values.optionEnrichment).toBe("NOT_ENRICHED_STOCK_FILTER");
    expect(aal?.values.scanNote).not.toContain("budget");
    expect(input.chainCalls.map((call) => call.symbol)).toEqual(["CLEAN"]);
  });

  it("keeps the enrichment state machine-readable even when a technical note owns the scanNote", async () => {
    const tickers = rankedUniverse(12);
    const input = fixture(() => [put(7)], tickers);
    tickers.forEach((ticker, index) => input.technicalCache.set(ticker, { ...ready, rsi: 20 + index }));
    // A pending technical entry sets its own, more specific scanNote - which must not erase the
    // separate fact that this row never got an option-chain request.
    input.technicalCache.set("RANK11", { state: "TECHNICAL_DATA_PENDING" });

    const row = (await evaluateLiveMarketScan(input)).find((candidate) => candidate.ticker === "RANK11");

    expect(row?.values.optionEnrichment).toBe("NOT_ENRICHED_BUDGET");
    expect(row?.values.technicalReasonCode).toBe("TECHNICAL_DATA_PENDING");
    expect(row?.values.scanNote).toContain("Technical preparation");
  });

  it("treats a REQUESTED chain that failed as assessed, keeping real UNKNOWN option semantics", async () => {
    const input = fixture(() => [put(7)], ["BROKEN"], { failChainFor: new Set(["BROKEN"]) });

    const row = (await evaluateLiveMarketScan(input))[0];

    // Requested but unanswerable is a genuinely different fact from never requested.
    expect(row.values.optionEnrichment).toBe("ENRICHED");
    expect(row.values.contractReasonCode).toBe("CHAIN_UNAVAILABLE");
    expect(row.summary.status).toBe("UNKNOWN");
  });

  it("marks a successfully enriched row ENRICHED with its real option metrics intact", async () => {
    const row = (await evaluateLiveMarketScan(fixture(() => [put(7)], ["GOOD"])))[0];

    expect(row.values.optionEnrichment).toBe("ENRICHED");
    expect(row.values).toMatchObject({ dte: 7, strike: 19, optionSelectionTargetDte: 7 });
    expect(row.summary.status).toBe("PASS");
  });

  it("reports data-unavailable separately from a screening verdict when the quote itself fails", async () => {
    const input = fixture(() => [put(7)], ["OKTICK"]);
    const provider: MarketDataProvider = {
      ...input.provider,
      async getQuote(symbol) {
        if (symbol === "NOQUOTE") throw new Error("unavailable");
        return { symbol, price: 20, volume: 100_000, asOf };
      },
    };

    const rows = await evaluateLiveMarketScan({ ...input, provider, universe: ["OKTICK", "NOQUOTE"] });
    const noQuote = rows.find((row) => row.ticker === "NOQUOTE");

    expect(noQuote?.values.optionEnrichment).toBe("NOT_ENRICHED_DATA_UNAVAILABLE");
    expect(noQuote?.values.scanNote).not.toContain("budget");
  });
});

describe("narrowed option-chain request", () => {
  it("asks Schwab only for PUTs inside the default 1-13 DTE weekly horizon", async () => {
    const input = fixture(() => [put(7)], ["TEST"]);

    await evaluateLiveMarketScan(input);

    expect(input.chainCalls).toHaveLength(1);
    expect(input.chainCalls[0].request?.contractType).toBe("PUT");
    // asOf is 2026-09-16, so DTE 1 => 2026-09-17 and DTE 13 => 2026-09-29, inclusive.
    expect(input.chainCalls[0].request?.fromDate?.toISOString().slice(0, 10)).toBe("2026-09-17");
    expect(input.chainCalls[0].request?.toDate?.toISOString().slice(0, 10)).toBe("2026-09-29");
  });

  it("uses the user's own enabled hard DTE window instead of the weekly default", async () => {
    const input = fixture(() => [put(16)], ["TEST"]);

    await evaluateLiveMarketScan({
      ...input,
      rules: [...rules, { key: "dte", name: "DTE", operator: "BETWEEN", desired: [14, 21] }],
    });

    expect(input.chainCalls[0].request?.contractType).toBe("PUT");
    expect(input.chainCalls[0].request?.fromDate?.toISOString().slice(0, 10)).toBe("2026-09-30");
    expect(input.chainCalls[0].request?.toDate?.toISOString().slice(0, 10)).toBe("2026-10-07");
  });

  it("selects exactly the same contract from a narrowed response as from the old broad one", async () => {
    // The broad response is what Schwab used to return: every expiration, including ones the
    // weekly horizon would discard anyway. The narrowed response is only the in-window subset.
    const inWindow = [put(5, { symbol: "IN-5" }), put(7, { symbol: "IN-7" }), put(9, { symbol: "IN-9" })];
    const outOfWindow = [put(30, { symbol: "OUT-30", bid: 3 }), put(93, { symbol: "OUT-93", bid: 5 }), put(121, { symbol: "OUT-121", bid: 9 })];

    const broad = (await evaluateLiveMarketScan(fixture(() => [...inWindow, ...outOfWindow], ["TEST"])))[0];
    const narrowed = (await evaluateLiveMarketScan(fixture(() => inWindow, ["TEST"])))[0];

    expect(narrowed.values.optionSymbol).toBe("IN-7");
    expect(narrowed.values.strike).toBe(broad.values.strike);
    expect(narrowed.values.optionSymbol).toBe(broad.values.optionSymbol);
    expect(narrowed.values.dte).toBe(broad.values.dte);
    expect(narrowed.values.ror).toBe(broad.values.ror);
    expect(narrowed.summary.status).toBe(broad.summary.status);
  });
});
