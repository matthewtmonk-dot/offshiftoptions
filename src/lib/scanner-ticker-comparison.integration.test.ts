import { hash } from "bcryptjs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MarketDataProvider, MarketQuote, OptionContractSnapshot, PriceCandle } from "@/providers/market-data/types";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

const TEST_SOURCE = "TEST_FIXTURE_TICKER_COMPARISON";

function syntheticCandles(ticker: string, count = 80, endDate: Date = new Date()): PriceCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + i * 0.3 + (i % 5 === 0 ? -2 : 1);
    const date = new Date(endDate.getTime() - (count - 1 - i) * 24 * 60 * 60 * 1000);
    return { symbol: ticker, date, open: close - 0.5, high: close + 1, low: close - 1, close, volume: 1_000_000 };
  });
}

function fakeProvider(quotes: Record<string, { price: number; volume: number }>): MarketDataProvider {
  const quotesByTicker = new Map<string, MarketQuote>(
    Object.entries(quotes).map(([ticker, { price, volume }]) => [ticker, { symbol: ticker, price, volume, asOf: new Date() }]),
  );
  return {
    async getQuote(symbol) {
      const quote = quotesByTicker.get(symbol.toUpperCase());
      if (!quote) throw new Error(`no quote for ${symbol}`);
      return quote;
    },
    async getQuotes(symbols) {
      const result = new Map<string, MarketQuote>();
      for (const symbol of symbols) {
        const quote = quotesByTicker.get(symbol.toUpperCase());
        if (quote) result.set(symbol.toUpperCase(), quote);
      }
      return result;
    },
    async getPriceHistory(symbol) {
      return syntheticCandles(symbol);
    },
    async getOptionChain() {
      return [] as OptionContractSnapshot[];
    },
    async getInstrument(symbol) {
      return { symbol, description: symbol, assetType: "EQUITY" };
    },
    async getMarketHours() {
      return { isOpen: true };
    },
  };
}

maybeDescribe("Scanner ticker comparison tool - read-only, bounded, user-scoped", () => {
  let prisma: typeof import("./prisma").prisma;
  let compareScannerTickersForUser: typeof import("./scanner-ticker-comparison").compareScannerTickersForUser;
  let refreshTechnicalIndicatorCacheBatchForUser: typeof import("./technical-indicator-cache").refreshTechnicalIndicatorCacheBatchForUser;
  let matt: { id: string };
  let eric: { id: string };

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    ({ compareScannerTickersForUser } = await import("./scanner-ticker-comparison"));
    ({ refreshTechnicalIndicatorCacheBatchForUser } = await import("./technical-indicator-cache"));

    const passwordHash = await hash("not-used", 4);
    const timestamp = Date.now();
    matt = await prisma.user.create({ data: { name: "Matt Comparison", email: `matt-comparison-${timestamp}@lst.local`, passwordHash } });
    eric = await prisma.user.create({ data: { name: "Eric Comparison", email: `eric-comparison-${timestamp}@lst.local`, passwordHash } });
  });

  afterEach(async () => {
    await prisma.technicalIndicatorSnapshot.deleteMany({ where: { userId: { in: [matt.id, eric.id] } } });
    await prisma.technicalPreparationRun.deleteMany({ where: { userId: { in: [matt.id, eric.id] } } });
    await prisma.optionableUniverseSymbol.deleteMany({ where: { source: TEST_SOURCE } });
    await prisma.watchlistItem.deleteMany({ where: { ownerId: { in: [matt.id, eric.id] } } });
    await prisma.watchlist.deleteMany({ where: { ownerId: { in: [matt.id, eric.id] } } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [matt.id, eric.id] } } });
    await prisma.$disconnect();
  });

  it("reports universe membership, price-rule survival, and technical state honestly for a mixed set of tickers", async () => {
    await prisma.optionableUniverseSymbol.createMany({
      data: [
        { ticker: "CMPINUNIV", name: "In Universe", source: TEST_SOURCE, lastSeenAt: new Date() },
      ],
    });
    // CMPINUNIV: real quote, price out of [10,50] range - default LST Core price rule.
    // CMPNOTFOUND: never in the universe, no Research/Watchlist membership.
    const provider = fakeProvider({ CMPINUNIV: { price: 999, volume: 1_000_000 } });

    const result = await compareScannerTickersForUser(matt.id, provider, ["CMPINUNIV", "CMPNOTFOUND"]);
    expect(result.readOnly).toBe(true);
    expect(result.nothingSaved).toBe(true);

    const byTicker = new Map(result.rows.map((row) => [row.ticker, row]));
    const inUniv = byTicker.get("CMPINUNIV")!;
    expect(inUniv.inOccUniverse).toBe(true);
    expect(inUniv.quote?.price).toBe(999);
    expect(inUniv.survivesPriceRule).toBe(false); // $999 is outside the default $10-$50 range
    expect(inUniv.reasonSummary).toMatch(/price rule/i);

    const notFound = byTicker.get("CMPNOTFOUND")!;
    expect(notFound.inOccUniverse).toBe(false);
    expect(notFound.inResearchTier1).toBe(false);
    expect(notFound.reasonSummary).toMatch(/never considered/i);
  });

  it("reports a genuinely fresh technical snapshot as READY with real RSI/BB, and a ticker with no snapshot as PENDING", async () => {
    // The global daily-candle gate (checkDailyCandleAvailabilityGate) requires at least 3
    // successful probes out of up to 5 symbols drawn from the probe universe before it will let
    // any preparation run proceed at all - so this fixture needs a real probe pool, not just the
    // 2 tickers under actual test, or the whole batch would report INCONCLUSIVE and write nothing.
    const gateProbeTickers = ["CMPGATE1", "CMPGATE2", "CMPGATE3"];
    const allTickers = ["CMPFRESH", "CMPPENDING", ...gateProbeTickers];
    await prisma.optionableUniverseSymbol.createMany({
      data: allTickers.map((ticker) => ({ ticker, name: ticker, source: TEST_SOURCE, lastSeenAt: new Date() })),
    });
    const now = new Date();
    const provider = fakeProvider(Object.fromEntries(allTickers.map((t) => [t, { price: 20, volume: 1_000_000 }])));
    await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 1, now, probeUniverseSource: TEST_SOURCE });
    // Only CMPFRESH gets a real technical refresh - CMPPENDING is left untouched to prove the
    // honest PENDING state for a ticker that simply hasn't been prepared yet.

    const result = await compareScannerTickersForUser(matt.id, provider, ["CMPFRESH", "CMPPENDING"], now);
    const byTicker = new Map(result.rows.map((row) => [row.ticker, row]));
    expect(byTicker.get("CMPFRESH")?.technicalState).toBe("READY");
    expect(byTicker.get("CMPFRESH")?.rsi).not.toBeNull();
    expect(byTicker.get("CMPPENDING")?.technicalState).toBe("TECHNICAL_DATA_PENDING");
    expect(byTicker.get("CMPPENDING")?.rsi).toBeNull();
  });

  it("never requests more than TICKER_COMPARISON_MAX_TICKERS tickers even when given more", async () => {
    const { TICKER_COMPARISON_MAX_TICKERS } = await import("./scanner-ticker-comparison");
    const manyTickers = Array.from({ length: TICKER_COMPARISON_MAX_TICKERS + 10 }, (_, i) => `CMPMANY${i}`);
    const provider = fakeProvider(Object.fromEntries(manyTickers.map((t) => [t, { price: 20, volume: 1_000_000 }])));

    const result = await compareScannerTickersForUser(matt.id, provider, manyTickers);
    expect(result.rows).toHaveLength(TICKER_COMPARISON_MAX_TICKERS);
  });

  it("Matt's comparison never reflects Eric's Research/Watchlist membership or Eric's technical cache", async () => {
    // Same gate-probe-pool requirement as above: at least 3 probe-eligible symbols are needed for
    // Eric's own refresh to actually pass the global candle gate and write a REAL snapshot -
    // otherwise this test would pass for the wrong reason (nobody got a snapshot at all).
    const gateProbeTickers = ["CMPGATE1", "CMPGATE2", "CMPGATE3"];
    const allTickers = ["CMPISOLATION", ...gateProbeTickers];
    await prisma.optionableUniverseSymbol.createMany({
      data: allTickers.map((ticker) => ({ ticker, name: ticker, source: TEST_SOURCE, lastSeenAt: new Date() })),
    });
    const now = new Date();
    const ericProvider = fakeProvider(Object.fromEntries(allTickers.map((t) => [t, { price: 20, volume: 1_000_000 }])));
    const ericResult = await refreshTechnicalIndicatorCacheBatchForUser(eric.id, ericProvider, {
      batchSize: allTickers.length, // process the whole small probe pool, not just one ticker
      now,
      probeUniverseSource: TEST_SOURCE,
    });
    expect(ericResult.status).toBe("OK");
    if (ericResult.status === "OK") expect(ericResult.succeededCount).toBe(allTickers.length);
    const ericSnapshot = await prisma.technicalIndicatorSnapshot.findFirst({ where: { userId: eric.id, ticker: "CMPISOLATION" } });
    expect(ericSnapshot?.status).toBe("READY"); // confirms Eric genuinely has a real, fresh snapshot to isolate against

    const mattProvider = fakeProvider({ CMPISOLATION: { price: 20, volume: 1_000_000 } });
    const result = await compareScannerTickersForUser(matt.id, mattProvider, ["CMPISOLATION"], now);
    // Eric's real, fresh technical snapshot for the identical ticker must never leak into Matt's
    // own comparison result.
    expect(result.rows[0]?.technicalState).toBe("TECHNICAL_DATA_PENDING");
  });
});
