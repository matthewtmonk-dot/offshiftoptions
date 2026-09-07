import { hash } from "bcryptjs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bollingerBands, bollingerPositionPercent, wilderRsi } from "@/domain/finance/calculations";
import type { MarketDataProvider, MarketQuote, PriceCandle } from "@/providers/market-data/types";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

const TEST_SOURCE = "TEST_FIXTURE_TECHNICAL_CACHE";

/** 80 real-shaped, deterministic daily closes (never real market data) - enough for both RSI
 * (needs >=15) and Bollinger Bands (needs >=20). A simple upward-drifting sawtooth so the
 * resulting RSI/BB are neither degenerate (constant price) nor requiring real market data.
 * Counts backward from `endDate` (default: right now) so the LAST candle - the one that becomes
 * `asOfDate` - lands exactly on `endDate`, matching how real daily candles always end "as of"
 * whenever they were fetched. */
function syntheticCandles(ticker: string, count = 80, endDate: Date = new Date(), seed = 1): PriceCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + i * 0.3 * seed + (i % 5 === 0 ? -2 * seed : 1);
    const date = new Date(endDate.getTime() - (count - 1 - i) * 24 * 60 * 60 * 1000);
    return { symbol: ticker, date, open: close - 0.5, high: close + 1, low: close - 1, close, volume: 1_000_000 };
  });
}

function fakeProvider(options: {
  quotes: Record<string, { price: number; volume: number }>;
  candlesByTicker?: Record<string, PriceCandle[]>;
  failTickers?: Set<string>;
  onGetPriceHistory?: (ticker: string) => void;
}): MarketDataProvider {
  const quotesByTicker = new Map<string, MarketQuote>(
    Object.entries(options.quotes).map(([ticker, { price, volume }]) => [ticker, { symbol: ticker, price, volume, asOf: new Date() }]),
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
      options.onGetPriceHistory?.(symbol);
      if (options.failTickers?.has(symbol)) {
        throw new Error("simulated provider failure");
      }
      return options.candlesByTicker?.[symbol] ?? syntheticCandles(symbol);
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

maybeDescribe("Technical indicator cache - user-scoped, never shared, reproduces existing RSI/BB math exactly", () => {
  let prisma: typeof import("./prisma").prisma;
  let getEligibleTechnicalRefreshTickersForUser: typeof import("./technical-indicator-cache").getEligibleTechnicalRefreshTickersForUser;
  let refreshTechnicalIndicatorCacheBatchForUser: typeof import("./technical-indicator-cache").refreshTechnicalIndicatorCacheBatchForUser;
  let getTechnicalIndicatorSnapshotsForUser: typeof import("./technical-indicator-cache").getTechnicalIndicatorSnapshotsForUser;
  let getTechnicalCacheReadinessForUser: typeof import("./technical-indicator-cache").getTechnicalCacheReadinessForUser;
  let matt: { id: string };
  let eric: { id: string };
  const universeTickers: string[] = [];

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    ({
      getEligibleTechnicalRefreshTickersForUser,
      refreshTechnicalIndicatorCacheBatchForUser,
      getTechnicalIndicatorSnapshotsForUser,
      getTechnicalCacheReadinessForUser,
    } = await import("./technical-indicator-cache"));

    const passwordHash = await hash("not-used", 4);
    const timestamp = Date.now();
    matt = await prisma.user.create({ data: { name: "Matt Technical", email: `matt-technical-${timestamp}@lst.local`, passwordHash } });
    eric = await prisma.user.create({ data: { name: "Eric Technical", email: `eric-technical-${timestamp}@lst.local`, passwordHash } });
  });

  afterEach(async () => {
    await prisma.technicalIndicatorSnapshot.deleteMany({ where: { userId: { in: [matt.id, eric.id] } } });
    await prisma.optionableUniverseSymbol.deleteMany({ where: { source: TEST_SOURCE } });
    await prisma.watchlistItem.deleteMany({ where: { ownerId: { in: [matt.id, eric.id] } } });
    await prisma.watchlist.deleteMany({ where: { ownerId: { in: [matt.id, eric.id] } } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [matt.id, eric.id] } } });
    await prisma.$disconnect();
  });

  async function seedUniverse(tickers: string[], prices: Record<string, number> = {}) {
    const now = new Date();
    await prisma.optionableUniverseSymbol.createMany({
      data: tickers.map((ticker) => ({ ticker, name: `${ticker} Corp`, source: TEST_SOURCE, lastSeenAt: now })),
    });
    universeTickers.push(...tickers);
    return tickers.reduce<Record<string, { price: number; volume: number }>>((acc, ticker) => {
      acc[ticker] = { price: prices[ticker] ?? 20, volume: 1_000_000 };
      return acc;
    }, {});
  }

  it("cached RSI equals wilderRsi computed directly on the identical candle input - not an approximation", async () => {
    await seedUniverse(["TECHA"]);
    const candles = syntheticCandles("TECHA");
    const provider = fakeProvider({ quotes: { TECHA: { price: 20, volume: 1_000_000 } }, candlesByTicker: { TECHA: candles } });

    await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 5 });

    const row = await prisma.technicalIndicatorSnapshot.findUniqueOrThrow({ where: { userId_ticker: { userId: matt.id, ticker: "TECHA" } } });
    const expectedRsi = wilderRsi(candles.map((c) => c.close));
    expect(row.rsi).toBe(expectedRsi);
    expect(expectedRsi).not.toBeNull(); // sanity: the fixture actually produced a real value
  });

  it("cached Bollinger Bands, combined with a fresh quote price, reproduce live-scan's exact bbPercent (bollingerPositionPercent) - the live quote genuinely participates", async () => {
    await seedUniverse(["TECHB"]);
    const candles = syntheticCandles("TECHB");
    const provider = fakeProvider({ quotes: { TECHB: { price: 20, volume: 1_000_000 } }, candlesByTicker: { TECHB: candles } });

    await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 5 });

    const row = await prisma.technicalIndicatorSnapshot.findUniqueOrThrow({ where: { userId_ticker: { userId: matt.id, ticker: "TECHB" } } });
    const expectedBands = bollingerBands(candles.map((c) => c.close));
    expect(row.bbLower).toBe(expectedBands?.lower);
    expect(row.bbMiddle).toBe(expectedBands?.middle);
    expect(row.bbUpper).toBe(expectedBands?.upper);

    // A later, different live quote price (market moved since the background refresh) -
    // bbPercent computed from the CACHED bands + that fresh price must equal what live-scan's
    // own mergeHistoryValues would compute for the identical candles + that same price.
    const freshQuotePrice = 123.45;
    const cachedBands = { lower: row.bbLower!, middle: row.bbMiddle!, upper: row.bbUpper! };
    const cachedBbPercent = bollingerPositionPercent(freshQuotePrice, cachedBands);
    const liveBbPercent = bollingerPositionPercent(freshQuotePrice, bollingerBands(candles.map((c) => c.close))!);
    expect(cachedBbPercent).toBe(liveBbPercent);
  });

  it("the financial calendar asOfDate is stored as a real UTC date-only value, never shifted by timezone", async () => {
    await seedUniverse(["TECHC"]);
    const candles = syntheticCandles("TECHC", 80, new Date("2026-09-04T21:00:00Z")); // last candle lands on a specific late-UTC timestamp
    const provider = fakeProvider({ quotes: { TECHC: { price: 20, volume: 1_000_000 } }, candlesByTicker: { TECHC: candles } });

    await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 5 });

    const row = await prisma.technicalIndicatorSnapshot.findUniqueOrThrow({ where: { userId_ticker: { userId: matt.id, ticker: "TECHC" } } });
    const lastCandleDate = candles.at(-1)!.date;
    expect(row.asOfDate?.toISOString().slice(0, 10)).toBe(lastCandleDate.toISOString().slice(0, 10));
    expect(row.asOfDate?.toISOString()).toMatch(/T00:00:00\.000Z$/); // pure date, no time-of-day component
  });

  it("Matt's cache row cannot satisfy Eric's lookup, and vice versa - the exact same ticker refreshed differently per user stays isolated", async () => {
    await seedUniverse(["ISOTICK"]);
    const mattCandles = syntheticCandles("ISOTICK"); // seed 1, ending today - fresh
    const ericCandles = syntheticCandles("ISOTICK", 80, new Date(), 3); // different price pattern (seed 3) -> different RSI/BB, also fresh

    await refreshTechnicalIndicatorCacheBatchForUser(
      matt.id,
      fakeProvider({ quotes: { ISOTICK: { price: 20, volume: 1_000_000 } }, candlesByTicker: { ISOTICK: mattCandles } }),
      { batchSize: 5 },
    );
    await refreshTechnicalIndicatorCacheBatchForUser(
      eric.id,
      fakeProvider({ quotes: { ISOTICK: { price: 20, volume: 1_000_000 } }, candlesByTicker: { ISOTICK: ericCandles } }),
      { batchSize: 5 },
    );

    const mattLookup = await getTechnicalIndicatorSnapshotsForUser(matt.id, ["ISOTICK"]);
    const ericLookup = await getTechnicalIndicatorSnapshotsForUser(eric.id, ["ISOTICK"]);
    const mattResult = mattLookup.get("ISOTICK");
    const ericResult = ericLookup.get("ISOTICK");
    if (mattResult?.state !== "READY" || ericResult?.state !== "READY") throw new Error("expected both READY");
    expect(mattResult.rsi).not.toBe(ericResult.rsi); // genuinely independent computations, not shared state

    // Deleting Eric's row (simulated by re-querying with a third, never-refreshed user) proves
    // there is no fallback/cross-user read path at all.
    const strangerLookup = await getTechnicalIndicatorSnapshotsForUser("nonexistent-user-id", ["ISOTICK"]);
    expect(strangerLookup.get("ISOTICK")).toEqual({ state: "TECHNICAL_DATA_PENDING" });
  });

  it("a missing cache row is honestly TECHNICAL_DATA_PENDING - never fabricated", async () => {
    const lookup = await getTechnicalIndicatorSnapshotsForUser(matt.id, ["NEVERREFRESHED"]);
    expect(lookup.get("NEVERREFRESHED")).toEqual({ state: "TECHNICAL_DATA_PENDING" });
  });

  it("a stale READY row (asOfDate before the most recent completed trading day) is honestly TECHNICAL_DATA_STALE, not silently treated as fresh", async () => {
    await seedUniverse(["TECHSTALE"]);
    // A trading day well over a week ago relative to `now` below.
    const oldCandles = syntheticCandles("TECHSTALE", 80, new Date("2026-08-01T00:00:00Z"));
    const refreshNow = new Date("2026-08-19T12:00:00Z"); // a real NYSE market day
    await refreshTechnicalIndicatorCacheBatchForUser(
      matt.id,
      fakeProvider({ quotes: { TECHSTALE: { price: 20, volume: 1_000_000 } }, candlesByTicker: { TECHSTALE: oldCandles } }),
      { batchSize: 5, now: refreshNow },
    );

    const muchLater = new Date("2026-09-07T12:00:00Z");
    const lookup = await getTechnicalIndicatorSnapshotsForUser(matt.id, ["TECHSTALE"], muchLater);
    expect(lookup.get("TECHSTALE")?.state).toBe("TECHNICAL_DATA_STALE");
  });

  it("a price-history failure for one symbol is isolated - other symbols in the same batch still succeed, and the failed row is HISTORY_UNAVAILABLE not fabricated", async () => {
    await seedUniverse(["TECHGOOD", "TECHBAD"]);
    const provider = fakeProvider({
      quotes: { TECHGOOD: { price: 20, volume: 1_000_000 }, TECHBAD: { price: 20, volume: 1_000_000 } },
      failTickers: new Set(["TECHBAD"]),
    });

    const result = await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 5 });
    expect(result.succeededCount).toBe(1);
    expect(result.failedCount).toBe(1);

    const lookup = await getTechnicalIndicatorSnapshotsForUser(matt.id, ["TECHGOOD", "TECHBAD"]);
    expect(lookup.get("TECHGOOD")?.state).toBe("READY");
    expect(lookup.get("TECHBAD")?.state).toBe("HISTORY_UNAVAILABLE");
  });

  it("a failed refresh never destroys a prior good READY row's indicator values - only status/failureReason change", async () => {
    await seedUniverse(["TECHFLAP"]);
    const goodCandles = syntheticCandles("TECHFLAP");
    await refreshTechnicalIndicatorCacheBatchForUser(
      matt.id,
      fakeProvider({ quotes: { TECHFLAP: { price: 20, volume: 1_000_000 } }, candlesByTicker: { TECHFLAP: goodCandles } }),
      { batchSize: 5 },
    );
    const before = await prisma.technicalIndicatorSnapshot.findUniqueOrThrow({ where: { userId_ticker: { userId: matt.id, ticker: "TECHFLAP" } } });
    expect(before.status).toBe("READY");
    expect(before.rsi).not.toBeNull();

    // Force a retry (failed cooldown doesn't apply to a READY row that's merely stale) by moving
    // far enough forward that TECHFLAP is due for refresh again, then simulate a provider failure.
    const muchLater = new Date(before.updatedAt.getTime() + 10 * 24 * 60 * 60 * 1000);
    await refreshTechnicalIndicatorCacheBatchForUser(
      matt.id,
      fakeProvider({ quotes: { TECHFLAP: { price: 20, volume: 1_000_000 } }, failTickers: new Set(["TECHFLAP"]) }),
      { batchSize: 5, now: muchLater },
    );

    const after = await prisma.technicalIndicatorSnapshot.findUniqueOrThrow({ where: { userId_ticker: { userId: matt.id, ticker: "TECHFLAP" } } });
    expect(after.status).toBe("FAILED");
    // The prior good values are still there, untouched - never nulled out by the failed attempt.
    expect(after.rsi).toBe(before.rsi);
    expect(after.bbLower).toBe(before.bbLower);
    expect(after.asOfDate?.getTime()).toBe(before.asOfDate?.getTime());
  });

  it("the background batch is bounded and resumable - a small batchSize never processes more than that many symbols per call, and repeated calls make forward progress", async () => {
    const tickers = Array.from({ length: 12 }, (_, i) => `TECHR${String(i).padStart(2, "0")}`);
    await seedUniverse(tickers);
    let callCount = 0;
    const provider = fakeProvider({
      quotes: Object.fromEntries(tickers.map((t) => [t, { price: 20, volume: 1_000_000 }])),
      onGetPriceHistory: () => {
        callCount += 1;
      },
    });

    const first = await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 5 });
    expect(callCount).toBe(5); // never more than batchSize outbound history requests in one call
    expect(first.processedCount).toBe(5);
    expect(first.remainingEligibleCount).toBe(7);

    const second = await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 5 });
    expect(callCount).toBe(10);
    expect(second.remainingEligibleCount).toBe(2);

    const third = await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 5 });
    expect(callCount).toBe(12); // only the last 2 remaining, not a full 5
    expect(third.remainingEligibleCount).toBe(0);

    const readyRows = await prisma.technicalIndicatorSnapshot.count({ where: { userId: matt.id, status: "READY" } });
    expect(readyRows).toBe(12); // every ticker refreshed exactly once across the three bounded calls
  });

  it("a duplicate/repeated invocation for the same already-fresh set is idempotent - it does not re-process or duplicate rows", async () => {
    await seedUniverse(["TECHDUP"]);
    const provider = fakeProvider({ quotes: { TECHDUP: { price: 20, volume: 1_000_000 } } });

    await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 5 });
    const afterFirst = await prisma.technicalIndicatorSnapshot.findMany({ where: { userId: matt.id } });
    expect(afterFirst).toHaveLength(1);

    const second = await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 5 });
    expect(second.processedCount).toBe(0); // already fresh - nothing to do
    const afterSecond = await prisma.technicalIndicatorSnapshot.findMany({ where: { userId: matt.id } });
    expect(afterSecond).toHaveLength(1); // no duplicate row (userId, ticker) is the primary key
  });

  it("Phase A (eligibility) never calls getPriceHistory - the quote stage never triggers history interactively", async () => {
    await seedUniverse(["TECHQ1", "TECHQ2"]);
    let historyCallCount = 0;
    const provider = fakeProvider({
      quotes: { TECHQ1: { price: 20, volume: 1_000_000 }, TECHQ2: { price: 20, volume: 1_000_000 } },
      onGetPriceHistory: () => {
        historyCallCount += 1;
      },
    });

    await getEligibleTechnicalRefreshTickersForUser(matt.id, provider);
    expect(historyCallCount).toBe(0);
  });

  it("Phase A delegates entirely to the provider's own getQuotes (and its already-verified chunking) - it never reimplements batching itself", async () => {
    await seedUniverse(["TECHQ3"]);
    let getQuotesCallCount = 0;
    let requestedSymbolCount = 0;
    const provider: MarketDataProvider = {
      async getQuote(symbol) {
        return { symbol, price: 20, volume: 1_000_000, asOf: new Date() };
      },
      async getQuotes(symbols) {
        getQuotesCallCount += 1;
        requestedSymbolCount = symbols.length;
        return new Map(symbols.map((s) => [s, { symbol: s, price: 20, volume: 1_000_000, asOf: new Date() }]));
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
        return { isOpen: true };
      },
    };

    const result = await getEligibleTechnicalRefreshTickersForUser(matt.id, provider);
    expect(getQuotesCallCount).toBe(1); // one call for the whole universe, batching left entirely to the provider
    expect(requestedSymbolCount).toBeGreaterThan(0);
    expect(result.length).toBeGreaterThan(0);
  });

  it("never invents financial scoring - non-Research/Watchlist survivors are ordered deterministically (ticker ascending), not by an invented strength score", async () => {
    await seedUniverse(["TECHZ", "TECHA2", "TECHM"]);
    const provider = fakeProvider({
      quotes: { TECHZ: { price: 20, volume: 1_000_000 }, TECHA2: { price: 20, volume: 1_000_000 }, TECHM: { price: 20, volume: 1_000_000 } },
    });

    const result = await getEligibleTechnicalRefreshTickersForUser(matt.id, provider);
    const priority2 = result.filter((r) => r.priority === 2).map((r) => r.ticker);
    expect(priority2).toEqual([...priority2].sort());
  });

  it("private Research/Watchlist priority never leaks across users - the same ticker is priority 1 only for the user who actually has it on their Watchlist", async () => {
    await seedUniverse(["PRIOTICK"]);
    const watchlist = await prisma.watchlist.create({ data: { ownerId: matt.id, name: "Matt Priority Test", visibility: "PRIVATE" } });
    await prisma.watchlistItem.create({
      data: { watchlistId: watchlist.id, ownerId: matt.id, ticker: "PRIOTICK", status: "WATCHING", visibility: "PRIVATE" },
    });

    const provider = fakeProvider({ quotes: { PRIOTICK: { price: 20, volume: 1_000_000 } } });
    const mattResult = await getEligibleTechnicalRefreshTickersForUser(matt.id, provider);
    const ericResult = await getEligibleTechnicalRefreshTickersForUser(eric.id, provider);

    expect(mattResult.find((r) => r.ticker === "PRIOTICK")?.priority).toBe(1);
    expect(ericResult.find((r) => r.ticker === "PRIOTICK")?.priority).toBe(2); // not on Eric's own Watchlist
  });

  it("getTechnicalCacheReadinessForUser reports honest ready/pending counts and the real last-prepared timestamp", async () => {
    await seedUniverse(["TECHRD1", "TECHRD2", "TECHRD3"]);
    await refreshTechnicalIndicatorCacheBatchForUser(
      matt.id,
      fakeProvider({
        quotes: { TECHRD1: { price: 20, volume: 1_000_000 }, TECHRD2: { price: 20, volume: 1_000_000 }, TECHRD3: { price: 20, volume: 1_000_000 } },
      }),
      { batchSize: 2 },
    );

    const status = await getTechnicalCacheReadinessForUser(matt.id, ["TECHRD1", "TECHRD2", "TECHRD3"]);
    expect(status.eligibleCount).toBe(3);
    expect(status.readyCount).toBe(2);
    expect(status.pendingCount).toBe(1);
    expect(status.lastPreparedAt).not.toBeNull();
  });
});
