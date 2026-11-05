import { describe, expect, it } from "vitest";
import type { MarketDataProvider, OptionContractSnapshot } from "@/providers/market-data/types";
import { evaluateLiveMarketScan, type LiveScanEarningsLookup, type LiveScanTechnicalLookup } from "./live-scan";
import { SCANNER_RULE_DEFINITIONS } from "./profile";
import type { ScannerRule } from "./scanner";
import { averageVolume } from "../finance/calculations";

const asOf = new Date("2026-11-05T15:10:00Z"); // 10:10 AM ET: today's cumulative volume is still small
const rules: ScannerRule[] = SCANNER_RULE_DEFINITIONS.filter((rule) => rule.defaultEnabled).map((rule) => ({
  key: rule.key, name: rule.name, operator: rule.operator, desired: rule.key === "stockVolume" ? 1_000_000 : rule.defaultDesired,
}));
const earnings: LiveScanEarningsLookup = { daysUntilReport: 36, reportDate: "2026-12-11" };
const tech = (avgVolume20?: number | null): LiveScanTechnicalLookup => ({ state: "READY", rsi: 30, bbLower: 18, bbMiddle: 23, bbUpper: 28, avgVolume20 });

// Quote volume (what has traded so far today) per ticker.
const TODAY: Record<string, number> = { BUSY: 80_000, THIN: 2_500_000, OLD: 80_000 };

function setup(cache: Record<string, LiveScanTechnicalLookup>) {
  const chains: string[] = [];
  const provider: MarketDataProvider = {
    async getQuote(symbol) { return { symbol, price: 20, volume: TODAY[symbol], asOf }; },
    async getPriceHistory() { throw new Error("Unexpected live history fetch"); },
    async getOptionChain(symbol): Promise<OptionContractSnapshot[]> { chains.push(symbol); return []; },
    async getInstrument(symbol) { return { symbol, description: symbol, assetType: "EQUITY" }; },
    async getMarketHours() { return { isOpen: true }; },
  };
  const tickers = Object.keys(cache);
  return {
    provider, chains, rules, asOf, universe: tickers,
    technicalCache: new Map(Object.entries(cache)),
    earningsLookup: new Map(tickers.map((ticker) => [ticker, earnings])),
  };
}

describe("averageVolume", () => {
  it("averages the last 20 sessions and rounds to a whole share count", () => {
    const volumes = [...Array(5).fill(1), ...Array(20).fill(1_000)];
    expect(averageVolume(volumes)).toBe(1000);
    expect(averageVolume([...Array(19).fill(100), 120])).toBe(101);
  });
  it("is null with fewer than 20 sessions or any missing/garbage volume (never treated as zero)", () => {
    expect(averageVolume(Array(19).fill(1000))).toBeNull();
    expect(averageVolume([...Array(19).fill(1000), null])).toBeNull();
    expect(averageVolume([...Array(19).fill(1000), Number.NaN])).toBeNull();
    expect(averageVolume([...Array(19).fill(1000), -5])).toBeNull();
    expect(averageVolume([])).toBeNull();
  });
});

describe("underlying-volume rule uses the 20-day average when cached", () => {
  it("keeps a liquid stock that merely looks quiet early in the day, and drops a thin one with a busy morning", async () => {
    const input = setup({ BUSY: tech(4_000_000), THIN: tech(300_000) });
    const rows = await evaluateLiveMarketScan(input);
    const byTicker = new Map(rows.map((row) => [row.ticker, row]));

    // BUSY: 80k so far today would fail a 1M floor, but its 20-day average is 4M -> stays a candidate.
    expect(byTicker.get("BUSY")!.funnelStage).toBe("STOCK_STAGE");
    expect(byTicker.get("BUSY")!.values).toMatchObject({ stockVolume: 4_000_000, stockVolumeBasis: "AVG_20_DAY", quoteVolume: 80_000 });
    // THIN: 2.5M so far today would pass, but the 20-day average is only 300k -> excluded before any chain request.
    expect(byTicker.get("THIN")!.funnelStage).toBe("QUOTE_EXCLUDED");
    expect(String(byTicker.get("THIN")!.values.scanNote)).toMatch(/minimum underlying volume/);
    expect(byTicker.get("THIN")!.values.stockVolume).toBe(300_000);
    expect(input.chains).toEqual(["BUSY"]);
  });

  it("falls back to today's quote volume (unchanged behaviour) when no average is cached yet", async () => {
    const input = setup({ OLD: tech(null), THIN: tech(undefined) });
    const rows = await evaluateLiveMarketScan(input);
    const byTicker = new Map(rows.map((row) => [row.ticker, row]));
    expect(byTicker.get("OLD")!.funnelStage).toBe("QUOTE_EXCLUDED"); // 80k today < 1M, no average to say otherwise
    expect(byTicker.get("THIN")!.funnelStage).toBe("STOCK_STAGE"); // 2.5M today >= 1M
    expect(byTicker.get("THIN")!.values).toMatchObject({ stockVolume: 2_500_000, stockVolumeBasis: "TODAY" });
  });
});
