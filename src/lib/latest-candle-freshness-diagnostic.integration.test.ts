import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MarketDataProvider, MarketQuote, PriceCandle } from "@/providers/market-data/types";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

const TEST_SOURCE = "TEST_FIXTURE_LATEST_CANDLE_DIAGNOSTIC";

function syntheticCandlesEndingOn(ticker: string, endDate: Date, count = 5): PriceCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + i;
    const date = new Date(endDate.getTime() - (count - 1 - i) * 24 * 60 * 60 * 1000);
    return { symbol: ticker, date, open: close, high: close + 1, low: close - 1, close, volume: 1_000_000 };
  });
}

function fakeProvider(options: {
  candlesByTicker: Record<string, PriceCandle[]>;
  failTickers?: Set<string>;
  onGetPriceHistory?: (ticker: string) => void;
}): MarketDataProvider {
  return {
    async getQuote(symbol) {
      return { symbol, price: 20, volume: 1_000_000, asOf: new Date() } as MarketQuote;
    },
    async getQuotes(symbols) {
      return new Map(symbols.map((s) => [s, { symbol: s, price: 20, volume: 1_000_000, asOf: new Date() }]));
    },
    async getPriceHistory(symbol) {
      options.onGetPriceHistory?.(symbol);
      if (options.failTickers?.has(symbol)) {
        throw new Error("simulated provider failure");
      }
      return options.candlesByTicker[symbol] ?? [];
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
}

maybeDescribe("Latest candle freshness diagnostic - read-only, bounded to a handful of deterministic public symbols", () => {
  let prisma: typeof import("./prisma").prisma;
  let runLatestCandleFreshnessDiagnostic: typeof import("./latest-candle-freshness-diagnostic").runLatestCandleFreshnessDiagnostic;

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    ({ runLatestCandleFreshnessDiagnostic } = await import("./latest-candle-freshness-diagnostic"));
  });

  afterEach(async () => {
    await prisma.optionableUniverseSymbol.deleteMany({ where: { source: TEST_SOURCE } });
    await prisma.technicalIndicatorSnapshot.deleteMany({ where: { ticker: { startsWith: "LCFD" } } });
  });

  async function seedSymbols(tickers: string[]) {
    await prisma.optionableUniverseSymbol.createMany({
      data: tickers.map((ticker) => ({ ticker, name: `${ticker} Corp`, source: TEST_SOURCE, lastSeenAt: new Date() })),
    });
  }

  it("reports fresh: true for a current candle and fresh: false for a lagged one, using the same freshness rule as the live scan", async () => {
    const { previousNyseMarketDay } = await import("@/domain/finance/marketCalendar");
    const now = new Date();
    const requiredMarketDate = previousNyseMarketDay(now);
    const laggedDate = previousNyseMarketDay(requiredMarketDate);

    await seedSymbols(["LCFDA", "LCFDB"]);
    const provider = fakeProvider({
      candlesByTicker: {
        LCFDA: syntheticCandlesEndingOn("LCFDA", requiredMarketDate),
        LCFDB: syntheticCandlesEndingOn("LCFDB", laggedDate),
      },
    });

    const result = await runLatestCandleFreshnessDiagnostic(provider, now, { universeSource: TEST_SOURCE, symbolCount: 2 });
    expect(result.readOnly).toBe(true);
    expect(result.nothingSaved).toBe(true);
    expect(result.accountDataTouched).toBe(false);
    expect(result.requiredMarketDate).toBe(requiredMarketDate.toISOString().slice(0, 10));

    const byTicker = new Map(result.rows.map((row) => [row.ticker, row]));
    expect(byTicker.get("LCFDA")).toMatchObject({ fresh: true, latestCandleMarketDate: requiredMarketDate.toISOString().slice(0, 10) });
    expect(byTicker.get("LCFDB")).toMatchObject({ fresh: false, latestCandleMarketDate: laggedDate.toISOString().slice(0, 10) });
  });

  it("a single symbol's fetch failure is reported honestly (null/false), never aborting the rest of the diagnostic", async () => {
    const now = new Date();
    await seedSymbols(["LCFDFAIL", "LCFDOK"]);
    const { previousNyseMarketDay } = await import("@/domain/finance/marketCalendar");
    const provider = fakeProvider({
      candlesByTicker: { LCFDOK: syntheticCandlesEndingOn("LCFDOK", previousNyseMarketDay(now)) },
      failTickers: new Set(["LCFDFAIL"]),
    });

    const result = await runLatestCandleFreshnessDiagnostic(provider, now, { universeSource: TEST_SOURCE, symbolCount: 2 });
    const byTicker = new Map(result.rows.map((row) => [row.ticker, row]));
    expect(byTicker.get("LCFDFAIL")).toMatchObject({ fresh: false, latestCandleMarketDate: null });
    expect(byTicker.get("LCFDOK")).toMatchObject({ fresh: true });
  });

  it("never requests more than the configured symbol count (default 5), and never writes to the database", async () => {
    const now = new Date();
    await seedSymbols(Array.from({ length: 8 }, (_, i) => `LCFDMANY${i}`));
    let callCount = 0;
    const provider = fakeProvider({ candlesByTicker: {}, onGetPriceHistory: () => (callCount += 1) });

    const result = await runLatestCandleFreshnessDiagnostic(provider, now, { universeSource: TEST_SOURCE, symbolCount: 5 });
    expect(callCount).toBe(5);
    expect(result.rows).toHaveLength(5);

    const snapshotCount = await prisma.technicalIndicatorSnapshot.count({ where: { ticker: { startsWith: "LCFD" } } });
    expect(snapshotCount).toBe(0); // read-only - nothing persisted
  });

  it("uses a deterministic ticker ASC order - repeated runs against the same pool return the same symbols", async () => {
    const now = new Date();
    await seedSymbols(["LCFDZ", "LCFDA", "LCFDM"]);
    const provider = fakeProvider({ candlesByTicker: {} });

    const first = await runLatestCandleFreshnessDiagnostic(provider, now, { universeSource: TEST_SOURCE, symbolCount: 3 });
    const second = await runLatestCandleFreshnessDiagnostic(provider, now, { universeSource: TEST_SOURCE, symbolCount: 3 });
    expect(first.rows.map((r) => r.ticker)).toEqual(["LCFDA", "LCFDM", "LCFDZ"]);
    expect(second.rows.map((r) => r.ticker)).toEqual(first.rows.map((r) => r.ticker));
  });
});
