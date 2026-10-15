import { describe, expect, it } from "vitest";
import type { MarketDataProvider, OptionContractSnapshot } from "@/providers/market-data/types";
import { enrichPersistedStockStageRow, evaluateLiveMarketScan, stockScreenVerdict, type LiveScanEarningsLookup, type LiveScanTechnicalLookup } from "./live-scan";
import { SCANNER_RULE_DEFINITIONS } from "./profile";
import type { ScannerRule } from "./scanner";

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

function scanInput(options: OptionContractSnapshot[], tickers = ["TEST"]) {
  const provider: MarketDataProvider = {
    async getQuote(symbol) { return { symbol, price: 20, volume: 100_000, asOf }; },
    async getPriceHistory() { throw new Error("no live history in this mode"); },
    async getOptionChain() { return options; },
    async getInstrument(symbol) { return { symbol, description: symbol, assetType: "EQUITY" }; },
    async getMarketHours() { return { isOpen: true }; },
  };
  return {
    provider, rules, asOf, universe: tickers,
    technicalCache: new Map(tickers.map((ticker) => [ticker, ready])),
    earningsLookup: new Map(tickers.map((ticker) => [ticker, earnings])),
  };
}

// What persistScannerRun stores: undefined -> null (jsonReady), then it round-trips through JSON.
const persisted = (values: Record<string, unknown>) => JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value ?? null]))));

describe("enrichPersistedStockStageRow (the on-demand 'Check options' path)", () => {
  const chain = [put(7), put(9, { strike: 18, bid: 0.2, ask: 0.25, symbol: "TEST-9-18-PUT" }), put(21)];

  it("gives EXACTLY the answer a full-budget scan would have given for the same row and chain", async () => {
    const [budgetLimited] = await evaluateLiveMarketScan({ ...scanInput(chain), maxOptionChainLookups: 0 });
    expect(budgetLimited.values.optionEnrichment).toBe("NOT_ENRICHED_BUDGET");
    const [full] = await evaluateLiveMarketScan({ ...scanInput(chain), maxOptionChainLookups: 8 });
    expect(full.values.optionEnrichment).toBe("ENRICHED");

    const checked = enrichPersistedStockStageRow({ values: persisted(budgetLimited.values), options: chain, rules, asOf })!;
    expect(checked).not.toBeNull();
    expect(persisted(checked.values)).toEqual(persisted(full.values));
    expect(checked.summary).toEqual(full.summary);
  });

  it("clears the 'not checked' bookkeeping so a checked row can't still claim it was skipped", async () => {
    const [budgetLimited] = await evaluateLiveMarketScan({ ...scanInput(chain), maxOptionChainLookups: 0 });
    expect(budgetLimited.values.scanNote).toMatch(/Options not checked/);
    const checked = enrichPersistedStockStageRow({ values: persisted(budgetLimited.values), options: chain, rules, asOf })!;
    expect(checked.values.optionEnrichment).toBe("ENRICHED");
    expect(checked.values.scanNote ?? null).toBeNull();
    expect(checked.values.contractReasonCode ?? null).toBeNull();
    expect(checked.values.optionSymbol).toBeTruthy();
  });

  it("records an honest reason (not a skipped row) when the chain has no usable weekly contract", async () => {
    const [budgetLimited] = await evaluateLiveMarketScan({ ...scanInput([put(30), put(93)]), maxOptionChainLookups: 0 });
    const checked = enrichPersistedStockStageRow({ values: persisted(budgetLimited.values), options: [put(30), put(93)], rules, asOf })!;
    expect(checked.values.optionEnrichment).toBe("ENRICHED");
    expect(checked.values.contractReasonCode).toBe("NO_WEEKLY_EXPIRATION");
  });

  it("refuses (returns null) instead of guessing when the stored row has no price", async () => {
    const [budgetLimited] = await evaluateLiveMarketScan({ ...scanInput(chain), maxOptionChainLookups: 0 });
    const noPrice = persisted({ ...budgetLimited.values, price: null });
    expect(enrichPersistedStockStageRow({ values: noPrice, options: chain, rules, asOf })).toBeNull();
  });

  it("refuses when the row no longer passes the stock screen under the supplied rules", async () => {
    const [budgetLimited] = await evaluateLiveMarketScan({ ...scanInput(chain), maxOptionChainLookups: 0 });
    const stricter = rules.map((rule) => (rule.key === "rsi" ? { ...rule, desired: 20 } : rule)); // stored RSI is 30
    expect(enrichPersistedStockStageRow({ values: persisted(budgetLimited.values), options: chain, rules: stricter, asOf })).toBeNull();
  });

  it("does not mutate the stored values it was given", async () => {
    const [budgetLimited] = await evaluateLiveMarketScan({ ...scanInput(chain), maxOptionChainLookups: 0 });
    const stored = persisted(budgetLimited.values);
    const before = JSON.stringify(stored);
    enrichPersistedStockStageRow({ values: stored, options: chain, rules, asOf });
    expect(JSON.stringify(stored)).toBe(before);
  });
});

describe("stockScreenVerdict", () => {
  it("only looks at stock-level rules, ignoring option rules that are still unknown", () => {
    const values = { price: 20, stockVolume: 100_000, rsi: 30, bbPercent: 20, earningsDistance: 36, doNotTrade: false };
    expect(stockScreenVerdict(rules, values)).toBe("PASS");
    expect(stockScreenVerdict(rules, { ...values, rsi: 55 })).toBe("FAIL");
    expect(stockScreenVerdict(rules, { ...values, rsi: null })).toBe("UNKNOWN");
  });
});
