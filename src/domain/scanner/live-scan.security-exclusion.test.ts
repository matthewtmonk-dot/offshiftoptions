import { describe, expect, it } from "vitest";
import type { MarketDataProvider, OptionContractSnapshot } from "@/providers/market-data/types";
import { evaluateLiveMarketScan, type LiveScanEarningsLookup, type LiveScanTechnicalLookup } from "./live-scan";
import { SCANNER_RULE_DEFINITIONS } from "./profile";
import type { ScannerRule } from "./scanner";

const asOf = new Date("2026-11-02T15:30:00Z");
const rules: ScannerRule[] = SCANNER_RULE_DEFINITIONS.filter((rule) => rule.defaultEnabled).map((rule) => ({
  key: rule.key, name: rule.name, operator: rule.operator, desired: rule.defaultDesired,
}));
const ready: LiveScanTechnicalLookup = { state: "READY", rsi: 30, bbLower: 18, bbMiddle: 23, bbUpper: 28 };
const earnings: LiveScanEarningsLookup = { daysUntilReport: 36, reportDate: "2026-12-08" };

const DESCRIPTIONS: Record<string, string | null> = {
  GOODCO: "Good Company, Inc.",
  FUNDY: "YieldMax FUNDY Option Income Strategy ETF",
  PLAINETF: "Plain Total Market ETF",
  ULTY: null, // description missing: caught by the known-ticker list
};

function setup(tickers: string[]) {
  const chainSymbols: string[] = [];
  const historySymbols: string[] = [];
  const provider: MarketDataProvider = {
    async getQuote(symbol) { return { symbol, price: 20, volume: 2_000_000, asOf, companyDescription: DESCRIPTIONS[symbol] ?? null }; },
    async getPriceHistory(symbol) { historySymbols.push(symbol); throw new Error("Unexpected live history fetch"); },
    async getOptionChain(symbol): Promise<OptionContractSnapshot[]> { chainSymbols.push(symbol); return []; },
    async getInstrument(symbol) { return { symbol, description: symbol, assetType: "EQUITY" }; },
    async getMarketHours() { return { isOpen: true }; },
  };
  return {
    provider, chainSymbols, historySymbols, rules, asOf, universe: tickers,
    technicalCache: new Map(tickers.map((ticker) => [ticker, ready])),
    earningsLookup: new Map(tickers.map((ticker) => [ticker, earnings])),
  };
}

describe("security-type exclusion in the live scan", () => {
  it("never spends a chain request on a leveraged/income/preferred fund, and says why", async () => {
    const input = setup(["GOODCO", "FUNDY", "ULTY", "PLAINETF"]);
    const rows = await evaluateLiveMarketScan(input);
    const byTicker = new Map(rows.map((row) => [row.ticker, row]));

    expect(input.chainSymbols.sort()).toEqual(["GOODCO", "PLAINETF"]);
    for (const excluded of ["FUNDY", "ULTY"]) {
      const row = byTicker.get(excluded)!;
      expect(row.funnelStage).toBe("QUOTE_EXCLUDED");
      expect(row.reachedOptionChainLookup).toBe(false);
      expect(row.values.optionEnrichment).toBe("NOT_ENRICHED_STOCK_FILTER");
      expect(row.values.securityExclusion).toBe("OPTION_INCOME");
      expect(String(row.values.scanNote)).toMatch(/^Excluded: option-income fund/);
    }
  });

  it("leaves ordinary stocks and plain ETFs alone", async () => {
    const rows = await evaluateLiveMarketScan(setup(["GOODCO", "PLAINETF"]));
    for (const row of rows) {
      expect(row.funnelStage).toBe("STOCK_STAGE");
      expect(row.values.securityExclusion).toBeUndefined();
    }
  });
});
