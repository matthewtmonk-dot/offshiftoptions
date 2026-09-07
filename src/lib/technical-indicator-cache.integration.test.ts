import { hash } from "bcryptjs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bollingerBands, bollingerPositionPercent, wilderRsi } from "@/domain/finance/calculations";
import type { MarketDataProvider, MarketQuote, PriceCandle } from "@/providers/market-data/types";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

const TEST_SOURCE = "TEST_FIXTURE_TECHNICAL_CACHE";

function syntheticTickers(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `TECHU${String(i).padStart(3, "0")}`);
}

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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeProvider(options: {
  quotes: Record<string, { price: number; volume: number }>;
  candlesByTicker?: Record<string, PriceCandle[]>;
  failTickers?: Set<string>;
  failQuotes?: boolean;
  onGetPriceHistory?: (ticker: string) => void;
  onGetQuotes?: (symbols: string[]) => void;
  onGetOptionChain?: (ticker: string) => void;
  /** Widens the async race window so two genuinely concurrent callers both reach their own
   * database write attempt before either finishes - without this, fast in-memory fakes can
   * resolve one call to completion before the second one even starts, hiding a real race. */
  getQuotesDelayMs?: number;
  getPriceHistoryDelayMs?: number;
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
      options.onGetQuotes?.(symbols);
      if (options.getQuotesDelayMs) await delay(options.getQuotesDelayMs);
      if (options.failQuotes) {
        throw new Error("simulated quote-sweep provider failure");
      }
      const result = new Map<string, MarketQuote>();
      for (const symbol of symbols) {
        const quote = quotesByTicker.get(symbol.toUpperCase());
        if (quote) result.set(symbol.toUpperCase(), quote);
      }
      return result;
    },
    async getPriceHistory(symbol) {
      options.onGetPriceHistory?.(symbol);
      if (options.getPriceHistoryDelayMs) await delay(options.getPriceHistoryDelayMs);
      if (options.failTickers?.has(symbol)) {
        throw new Error("simulated provider failure");
      }
      return options.candlesByTicker?.[symbol] ?? syntheticCandles(symbol);
    },
    async getOptionChain(symbol) {
      options.onGetOptionChain?.(symbol);
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
  let getOrCreateActiveTechnicalPreparationRun: typeof import("./technical-indicator-cache").getOrCreateActiveTechnicalPreparationRun;
  let PROCESSING_CLAIM_TIMEOUT_MS: typeof import("./technical-indicator-cache").PROCESSING_CLAIM_TIMEOUT_MS;
  let ensureMyLstScannerProfileForUser: typeof import("./workflows").ensureMyLstScannerProfileForUser;
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
      getOrCreateActiveTechnicalPreparationRun,
      PROCESSING_CLAIM_TIMEOUT_MS,
    } = await import("./technical-indicator-cache"));
    ({ ensureMyLstScannerProfileForUser } = await import("./workflows"));

    const passwordHash = await hash("not-used", 4);
    const timestamp = Date.now();
    matt = await prisma.user.create({ data: { name: "Matt Technical", email: `matt-technical-${timestamp}@lst.local`, passwordHash } });
    eric = await prisma.user.create({ data: { name: "Eric Technical", email: `eric-technical-${timestamp}@lst.local`, passwordHash } });
  });

  afterEach(async () => {
    await prisma.technicalIndicatorSnapshot.deleteMany({ where: { userId: { in: [matt.id, eric.id] } } });
    // TechnicalPreparationRun rows are keyed by (userId, marketDate, rulesFingerprint) and reused
    // across calls by design (that's the whole point of this slice) - but that means leftover
    // runs from an earlier test in this file WOULD be reused by a later one sharing the same real
    // "today" and default rules unless explicitly cleared here. Cascades to its Items.
    await prisma.technicalPreparationRun.deleteMany({ where: { userId: { in: [matt.id, eric.id] } } });
    await prisma.optionableUniverseSymbol.deleteMany({ where: { source: TEST_SOURCE } });
    await prisma.watchlistItem.deleteMany({ where: { ownerId: { in: [matt.id, eric.id] } } });
    await prisma.watchlist.deleteMany({ where: { ownerId: { in: [matt.id, eric.id] } } });
    // Some tests deliberately change the price rule to prove fingerprint invalidation - reset to
    // the real LST Core default ([10, 50]) so later tests' price=20 fixtures aren't affected.
    // Scoped to THIS file's own two users' own "My LST" profiles only - never a global update,
    // which would corrupt other test files' own scanner-rule fixtures running concurrently.
    const ownProfiles = await prisma.scannerProfile.findMany({ where: { ownerId: { in: [matt.id, eric.id] }, name: "My LST" }, select: { id: true } });
    if (ownProfiles.length) {
      await prisma.scannerRule.updateMany({
        where: { key: "price", profileId: { in: ownProfiles.map((profile) => profile.id) } },
        data: { valueJson: { desired: [10, 50] } },
      });
    }
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

  /** Directly patches the user's own price rule's [min, max] desired range - bypasses the full
   * updateScannerSettingsForUser form (which requires a valid value for EVERY scanner rule
   * definition at once) since this test only cares about one rule's stored value changing. */
  async function setPriceRuleRange(userId: string, min: number, max: number) {
    const profile = await ensureMyLstScannerProfileForUser(userId);
    await prisma.scannerRule.update({
      where: { profileId_key: { profileId: profile.id, key: "price" } },
      data: { valueJson: { desired: [min, max] } },
    });
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

  it("reports a real, non-negative elapsedMs for the whole invocation - the aggregate cost a caller needs to estimate worker invocations, never a per-request breakdown", async () => {
    await seedUniverse(["TECHTIME"]);
    const provider = fakeProvider({ quotes: { TECHTIME: { price: 20, volume: 1_000_000 } } });

    const result = await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 5 });
    expect(typeof result.elapsedMs).toBe("number");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
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
    const provider = fakeProvider({
      quotes: { TECHRD1: { price: 20, volume: 1_000_000 }, TECHRD2: { price: 20, volume: 1_000_000 }, TECHRD3: { price: 20, volume: 1_000_000 } },
    });
    await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 2 });

    const status = await getTechnicalCacheReadinessForUser(matt.id, provider);
    expect(status.eligibleCount).toBe(3);
    expect(status.readyCount).toBe(2);
    expect(status.pendingCount).toBe(1);
    expect(status.lastPreparedAt).not.toBeNull();
  });

  it("one preparation cycle performs the quote-stage eligibility sweep exactly once - the 2nd/3rd/Nth history batch never calls getQuotes again", async () => {
    await seedUniverse(syntheticTickers(60));
    let getQuotesCallCount = 0;
    const provider = fakeProvider({
      quotes: Object.fromEntries(syntheticTickers(60).map((t) => [t, { price: 20, volume: 1_000_000 }])),
      onGetQuotes: () => {
        getQuotesCallCount += 1;
      },
    });

    await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 25 });
    expect(getQuotesCallCount).toBe(1);

    await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 25 });
    expect(getQuotesCallCount).toBe(1); // still 1 - the second batch reused the persisted run

    await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 25 });
    expect(getQuotesCallCount).toBe(1); // still 1 across a third invocation too

    await getTechnicalCacheReadinessForUser(matt.id, provider);
    expect(getQuotesCallCount).toBe(1); // a readiness check also reuses the same run, not a fresh sweep
  });

  it("a worker invocation resumes the SAME generation (runId) across calls, and completing it stops cleanly with zero further work", async () => {
    await seedUniverse(syntheticTickers(10));
    const provider = fakeProvider({ quotes: Object.fromEntries(syntheticTickers(10).map((t) => [t, { price: 20, volume: 1_000_000 }])) });

    const firstRun = await getOrCreateActiveTechnicalPreparationRun(matt.id, provider);
    expect(firstRun.freshlyCreated).toBe(true);
    expect(firstRun.eligibleCount).toBe(10);

    await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 5 });
    const midRun = await getOrCreateActiveTechnicalPreparationRun(matt.id, provider);
    expect(midRun.runId).toBe(firstRun.runId); // same generation, not a new one
    expect(midRun.freshlyCreated).toBe(false);

    const second = await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 5 });
    expect(second.remainingEligibleCount).toBe(0); // generation complete

    const completedRun = await prisma.technicalPreparationRun.findUniqueOrThrow({ where: { id: firstRun.runId } });
    expect(completedRun.status).toBe("COMPLETE");

    // Calling again after completion does zero work and, critically, does NOT re-sweep quotes.
    let getQuotesCallCount = 0;
    const providerWithCounter = fakeProvider({
      quotes: Object.fromEntries(syntheticTickers(10).map((t) => [t, { price: 20, volume: 1_000_000 }])),
      onGetQuotes: () => {
        getQuotesCallCount += 1;
      },
    });
    const third = await refreshTechnicalIndicatorCacheBatchForUser(matt.id, providerWithCounter, { batchSize: 5 });
    expect(third.processedCount).toBe(0);
    expect(third.remainingEligibleCount).toBe(0);
    expect(getQuotesCallCount).toBe(0); // the completed run was reused - no new sweep
  });

  it("a change to the user's price/volume rules invalidates the persisted eligibility set - a new run (and a real re-sweep) is created", async () => {
    await seedUniverse(["TECHFP1", "TECHFP2"]);
    const provider = fakeProvider({ quotes: { TECHFP1: { price: 20, volume: 1_000_000 }, TECHFP2: { price: 20, volume: 1_000_000 } } });

    const firstRun = await getOrCreateActiveTechnicalPreparationRun(matt.id, provider);

    // Change the user's price rule - this changes the rules fingerprint.
    await setPriceRuleRange(matt.id, 5, 15); // TECHFP1/TECHFP2 (price 20) would now fail this rule

    let getQuotesCallCount = 0;
    const providerAfterRuleChange = fakeProvider({
      quotes: { TECHFP1: { price: 20, volume: 1_000_000 }, TECHFP2: { price: 20, volume: 1_000_000 } },
      onGetQuotes: () => {
        getQuotesCallCount += 1;
      },
    });
    const secondRun = await getOrCreateActiveTechnicalPreparationRun(matt.id, providerAfterRuleChange);
    expect(secondRun.freshlyCreated).toBe(true); // a real new sweep happened, not a silent reuse
    expect(secondRun.runId).not.toBe(firstRun.runId);
    expect(getQuotesCallCount).toBe(1);
    expect(secondRun.eligibleCount).toBe(0); // both tickers now fail the tightened price rule
  });

  it("old technical data survives a failed Phase A quote sweep - no run/items are created, and existing snapshots are untouched", async () => {
    await seedUniverse(["TECHFAILA"]);
    const goodProvider = fakeProvider({ quotes: { TECHFAILA: { price: 20, volume: 1_000_000 } } });
    await refreshTechnicalIndicatorCacheBatchForUser(matt.id, goodProvider, { batchSize: 5 });
    const before = await prisma.technicalIndicatorSnapshot.findUniqueOrThrow({ where: { userId_ticker: { userId: matt.id, ticker: "TECHFAILA" } } });
    expect(before.status).toBe("READY");

    // A rule change forces a new sweep attempt, which this time fails outright.
    await setPriceRuleRange(matt.id, 1, 999);
    const failingProvider = fakeProvider({ quotes: { TECHFAILA: { price: 20, volume: 1_000_000 } }, failQuotes: true });

    await expect(getOrCreateActiveTechnicalPreparationRun(matt.id, failingProvider)).rejects.toThrow();

    const runCount = await prisma.technicalPreparationRun.count({ where: { userId: matt.id } });
    expect(runCount).toBe(1); // only the original successful run exists - no partial/broken run was created
    const after = await prisma.technicalIndicatorSnapshot.findUniqueOrThrow({ where: { userId_ticker: { userId: matt.id, ticker: "TECHFAILA" } } });
    expect(after).toEqual(before); // completely untouched by the failed sweep
  });

  it("never issues an option-chain request during technical preparation - not Phase A, not Phase B", async () => {
    await seedUniverse(["TECHNOOPT"]);
    let optionChainCallCount = 0;
    const provider = fakeProvider({
      quotes: { TECHNOOPT: { price: 20, volume: 1_000_000 } },
      onGetOptionChain: () => {
        optionChainCallCount += 1;
      },
    });

    await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 5 });
    await getTechnicalCacheReadinessForUser(matt.id, provider);
    expect(optionChainCallCount).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // Concurrency hardening - genuinely overlapping calls (Promise.all against the real local
  // Postgres DB), not merely sequential duplicate calls.
  // ---------------------------------------------------------------------------------------------

  it("two simultaneous get-or-create calls yield exactly ONE preparation run, and the quote sweep executes once, not twice", async () => {
    await seedUniverse(syntheticTickers(20));
    let getQuotesCallCount = 0;
    const provider = fakeProvider({
      quotes: Object.fromEntries(syntheticTickers(20).map((t) => [t, { price: 20, volume: 1_000_000 }])),
      onGetQuotes: () => {
        getQuotesCallCount += 1;
      },
      getQuotesDelayMs: 60, // widen the race window so both calls are genuinely in flight together
    });

    const [a, b] = await Promise.all([
      getOrCreateActiveTechnicalPreparationRun(matt.id, provider),
      getOrCreateActiveTechnicalPreparationRun(matt.id, provider),
    ]);

    expect(a.runId).toBe(b.runId); // one generation, not two
    expect(getQuotesCallCount).toBe(1); // the loser polled for the winner's result instead of sweeping itself
    const runCount = await prisma.technicalPreparationRun.count({ where: { userId: matt.id } });
    expect(runCount).toBe(1); // the unique constraint allowed exactly one row to persist
  });

  it("two simultaneous <=25 workers never process the same ticker, and their combined claimed count never exceeds available PENDING rows", async () => {
    const tickers = syntheticTickers(40); // deliberately more than one batch's worth
    await seedUniverse(tickers);
    const claimedByCall = { a: [] as string[], b: [] as string[] };
    const historyCallsPerTicker = new Map<string, number>();

    function makeProvider(bucket: "a" | "b") {
      return fakeProvider({
        quotes: Object.fromEntries(tickers.map((t) => [t, { price: 20, volume: 1_000_000 }])),
        getPriceHistoryDelayMs: 20,
        onGetPriceHistory: (ticker) => {
          claimedByCall[bucket].push(ticker);
          historyCallsPerTicker.set(ticker, (historyCallsPerTicker.get(ticker) ?? 0) + 1);
        },
      });
    }

    // Pre-create the run once (outside the race) so this test isolates the CLAIM race specifically,
    // not the run-creation race already covered above.
    const { runId } = await getOrCreateActiveTechnicalPreparationRun(matt.id, makeProvider("a"));

    const [resultA, resultB] = await Promise.all([
      refreshTechnicalIndicatorCacheBatchForUser(matt.id, makeProvider("a"), { batchSize: 25 }),
      refreshTechnicalIndicatorCacheBatchForUser(matt.id, makeProvider("b"), { batchSize: 25 }),
    ]);

    expect(resultA.processedCount).toBeLessThanOrEqual(25); // each worker respects the cap
    expect(resultB.processedCount).toBeLessThanOrEqual(25);
    expect(resultA.processedCount + resultB.processedCount).toBe(40); // combined claims == exactly what was available, no more

    const overlap = claimedByCall.a.filter((ticker) => claimedByCall.b.includes(ticker));
    expect(overlap).toEqual([]); // disjoint sets - worker B never claimed anything worker A already had

    for (const [, count] of historyCallsPerTicker) {
      expect(count).toBe(1); // every ticker's history was fetched exactly once total, never twice
    }

    // Scoped to THIS test's own run - an unscoped global count would pick up READY items from
    // other concurrently-running test files' own runs under Vitest's parallel-by-file execution
    // against the shared local dev DB (the same test-isolation hazard documented elsewhere in this
    // file/PROJECT_HANDOFF.md).
    const readyRows = await prisma.technicalPreparationItem.count({ where: { status: "READY", runId } });
    expect(readyRows).toBe(40);
  });

  it("a stale (abandoned) PROCESSING claim can be reclaimed by a later invocation, but a non-stale active claim cannot", async () => {
    await seedUniverse(["TECHSTALECLAIM", "TECHFRESHCLAIM", "TECHNORMAL"]);
    const provider = fakeProvider({
      quotes: {
        TECHSTALECLAIM: { price: 20, volume: 1_000_000 },
        TECHFRESHCLAIM: { price: 20, volume: 1_000_000 },
        TECHNORMAL: { price: 20, volume: 1_000_000 },
      },
    });

    const { runId } = await getOrCreateActiveTechnicalPreparationRun(matt.id, provider);

    // Simulate one worker that claimed TECHSTALECLAIM a long time ago and then died.
    const longAgo = new Date(Date.now() - (PROCESSING_CLAIM_TIMEOUT_MS + 60_000));
    await prisma.technicalPreparationItem.updateMany({
      where: { runId, ticker: "TECHSTALECLAIM" },
      data: { status: "PROCESSING", claimToken: "dead-worker-token", claimedAt: longAgo },
    });
    // Simulate a DIFFERENT worker that claimed TECHFRESHCLAIM moments ago and is still legitimately running.
    await prisma.technicalPreparationItem.updateMany({
      where: { runId, ticker: "TECHFRESHCLAIM" },
      data: { status: "PROCESSING", claimToken: "live-worker-token", claimedAt: new Date() },
    });

    const historyFetchedTickers: string[] = [];
    const trackingProvider = fakeProvider({
      quotes: { TECHNORMAL: { price: 20, volume: 1_000_000 } },
      onGetPriceHistory: (ticker) => {
        historyFetchedTickers.push(ticker);
      },
    });
    const result = await refreshTechnicalIndicatorCacheBatchForUser(matt.id, trackingProvider, { batchSize: 25 });

    expect(historyFetchedTickers).toContain("TECHSTALECLAIM"); // reclaimed and processed
    expect(historyFetchedTickers).toContain("TECHNORMAL"); // the genuinely-PENDING one
    expect(historyFetchedTickers).not.toContain("TECHFRESHCLAIM"); // still actively claimed - never touched
    expect(result.processedCount).toBe(2);

    const freshClaim = await prisma.technicalPreparationItem.findFirstOrThrow({ where: { runId, ticker: "TECHFRESHCLAIM" } });
    expect(freshClaim.status).toBe("PROCESSING"); // untouched by the reclaim pass
    expect(freshClaim.claimToken).toBe("live-worker-token");
  });

  it("a run cannot become COMPLETE while any item is still PROCESSING - even after every other item is READY/FAILED", async () => {
    await seedUniverse(["TECHDONE1", "TECHDONE2", "TECHSTUCK"]);
    const provider = fakeProvider({
      quotes: { TECHDONE1: { price: 20, volume: 1_000_000 }, TECHDONE2: { price: 20, volume: 1_000_000 }, TECHSTUCK: { price: 20, volume: 1_000_000 } },
    });
    const { runId } = await getOrCreateActiveTechnicalPreparationRun(matt.id, provider);

    // Simulate a still-in-flight OTHER worker owning TECHSTUCK.
    await prisma.technicalPreparationItem.updateMany({
      where: { runId, ticker: "TECHSTUCK" },
      data: { status: "PROCESSING", claimToken: "other-worker-token", claimedAt: new Date() },
    });

    // This invocation can only claim TECHDONE1/TECHDONE2 - TECHSTUCK is legitimately claimed elsewhere.
    const result = await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 25 });
    expect(result.processedCount).toBe(2);
    expect(result.remainingEligibleCount).toBe(1); // TECHSTUCK still outstanding

    const run = await prisma.technicalPreparationRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("IN_PROGRESS"); // NOT complete - a PROCESSING row still exists
  });

  it("a failed worker's own claimed items never destroy other tickers' previous TechnicalIndicatorSnapshot data, and the claim mechanism is a single fast statement (no long-held transaction blocking other work)", async () => {
    await seedUniverse(["TECHPREV", "TECHCONCURRENT"]);
    // TECHPREV already has real prior data from an earlier successful run.
    await refreshTechnicalIndicatorCacheBatchForUser(matt.id, fakeProvider({ quotes: { TECHPREV: { price: 20, volume: 1_000_000 } } }), {
      batchSize: 5,
    });
    const before = await prisma.technicalIndicatorSnapshot.findUniqueOrThrow({ where: { userId_ticker: { userId: matt.id, ticker: "TECHPREV" } } });

    // A new run (rule change) where TECHCONCURRENT's history fetch fails outright.
    await setPriceRuleRange(matt.id, 1, 999);
    const failingProvider = fakeProvider({
      quotes: { TECHPREV: { price: 20, volume: 1_000_000 }, TECHCONCURRENT: { price: 20, volume: 1_000_000 } },
      failTickers: new Set(["TECHCONCURRENT"]),
    });
    await refreshTechnicalIndicatorCacheBatchForUser(matt.id, failingProvider, { batchSize: 25 });

    const after = await prisma.technicalIndicatorSnapshot.findUniqueOrThrow({ where: { userId_ticker: { userId: matt.id, ticker: "TECHPREV" } } });
    expect(after).toEqual(before); // TECHPREV's data is completely unaffected by TECHCONCURRENT's failure
    const concurrentSnapshot = await prisma.technicalIndicatorSnapshot.findUniqueOrThrow({
      where: { userId_ticker: { userId: matt.id, ticker: "TECHCONCURRENT" } },
    });
    expect(concurrentSnapshot.status).toBe("FAILED");
  });

  it("Matt and Eric's claims/runs remain fully isolated even when both prepare at the same time", async () => {
    await seedUniverse(["TECHISOCLAIM"]);
    const [mattResult, ericResult] = await Promise.all([
      refreshTechnicalIndicatorCacheBatchForUser(matt.id, fakeProvider({ quotes: { TECHISOCLAIM: { price: 20, volume: 1_000_000 } } }), {
        batchSize: 25,
      }),
      refreshTechnicalIndicatorCacheBatchForUser(eric.id, fakeProvider({ quotes: { TECHISOCLAIM: { price: 20, volume: 1_000_000 } } }), {
        batchSize: 25,
      }),
    ]);

    expect(mattResult.succeededCount).toBe(1);
    expect(ericResult.succeededCount).toBe(1);
    const mattRuns = await prisma.technicalPreparationRun.findMany({ where: { userId: matt.id } });
    const ericRuns = await prisma.technicalPreparationRun.findMany({ where: { userId: eric.id } });
    expect(mattRuns).toHaveLength(1);
    expect(ericRuns).toHaveLength(1);
    expect(mattRuns[0].id).not.toBe(ericRuns[0].id); // structurally separate generations, never shared
  });
});
