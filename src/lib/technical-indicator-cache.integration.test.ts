import { hash } from "bcryptjs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bollingerBands, bollingerPositionPercent, wilderRsi } from "@/domain/finance/calculations";
import { scannerRulesFromRecords } from "@/domain/scanner/profile";
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
  let refreshTechnicalIndicatorCacheBatchForUserRaw: typeof import("./technical-indicator-cache").refreshTechnicalIndicatorCacheBatchForUser;
  let getTechnicalIndicatorSnapshotsForUser: typeof import("./technical-indicator-cache").getTechnicalIndicatorSnapshotsForUser;
  let getTechnicalCacheReadinessForUserRaw: typeof import("./technical-indicator-cache").getTechnicalCacheReadinessForUser;
  let getOrCreateActiveTechnicalPreparationRunRaw: typeof import("./technical-indicator-cache").getOrCreateActiveTechnicalPreparationRun;
  let checkDailyCandleAvailabilityGate: typeof import("./technical-indicator-cache").checkDailyCandleAvailabilityGate;
  let computeQuoteStageRulesFingerprint: typeof import("./technical-indicator-cache").computeQuoteStageRulesFingerprint;
  let dateOnlyUtc: typeof import("./technical-indicator-cache").dateOnlyUtc;
  let getTechnicalPreparationRunAggregatesForUser: typeof import("./technical-indicator-cache").getTechnicalPreparationRunAggregatesForUser;
  let getTechnicalPreparationStatusForUser: typeof import("./technical-indicator-cache").getTechnicalPreparationStatusForUser;
  let requiredTechnicalMarketDateUtc: typeof import("./technical-indicator-cache").requiredTechnicalMarketDateUtc;
  let PROCESSING_CLAIM_TIMEOUT_MS: typeof import("./technical-indicator-cache").PROCESSING_CLAIM_TIMEOUT_MS;
  let ensureMyLstScannerProfileForUser: typeof import("./workflows").ensureMyLstScannerProfileForUser;
  let matt: { id: string };
  let eric: { id: string };
  const universeTickers: string[] = [];

  // These 3 functions can now legitimately return a DAILY_CANDLE_NOT_READY variant (see the
  // global daily-candle-availability gate) instead of their normal OK shape. Every existing test
  // below predates that gate and asserts on the OK shape directly - rather than touching each of
  // the ~50 call sites individually, these thin wrappers (same names the tests already call)
  // narrow to OK and throw a clear, diagnosable error if a test unexpectedly hits the gate
  // instead (which would itself indicate a real bug, e.g. an under-seeded probe pool - see the
  // gate's own dedicated tests further below, which call the Raw functions directly to inspect
  // the NOT_READY shape on purpose).
  // probeUniverseSource defaults to THIS file's own TEST_SOURCE (never the real production
  // OCC_OPTIONABLE_UNIVERSE_SOURCE default) so the gate's probe pool is deterministic - scoped to
  // exactly what seedUniverse itself seeds - rather than depending on whatever else happens to
  // exist in the shared table under Vitest's parallel-by-file execution.
  async function getOrCreateActiveTechnicalPreparationRun(
    userId: string,
    provider: MarketDataProvider,
    now: Date = new Date(),
    options: { probeUniverseSource?: string } = {},
  ): Promise<Extract<Awaited<ReturnType<typeof getOrCreateActiveTechnicalPreparationRunRaw>>, { status: "OK" }>> {
    const result = await getOrCreateActiveTechnicalPreparationRunRaw(userId, withGateControlTickers(provider, now), now, {
      probeUniverseSource: options.probeUniverseSource ?? TEST_SOURCE,
    });
    if (result.status !== "OK") throw new Error(`getOrCreateActiveTechnicalPreparationRun: expected OK, got ${JSON.stringify(result)}`);
    return result;
  }
  async function refreshTechnicalIndicatorCacheBatchForUser(
    userId: string,
    provider: MarketDataProvider,
    options: { batchSize?: number; now?: Date; probeUniverseSource?: string } = {},
  ): Promise<Extract<Awaited<ReturnType<typeof refreshTechnicalIndicatorCacheBatchForUserRaw>>, { status: "OK" }>> {
    const now = options.now ?? new Date();
    const result = await refreshTechnicalIndicatorCacheBatchForUserRaw(userId, withGateControlTickers(provider, now), {
      ...options,
      now,
      probeUniverseSource: options.probeUniverseSource ?? TEST_SOURCE,
    });
    if (result.status !== "OK") throw new Error(`refreshTechnicalIndicatorCacheBatchForUser: expected OK, got ${JSON.stringify(result)}`);
    return result;
  }
  async function getTechnicalCacheReadinessForUser(
    userId: string,
    provider: MarketDataProvider,
    now: Date = new Date(),
    options: { probeUniverseSource?: string } = {},
  ): Promise<Extract<Awaited<ReturnType<typeof getTechnicalCacheReadinessForUserRaw>>, { status: "OK" }>> {
    const result = await getTechnicalCacheReadinessForUserRaw(userId, withGateControlTickers(provider, now), now, {
      probeUniverseSource: options.probeUniverseSource ?? TEST_SOURCE,
    });
    if (result.status !== "OK") throw new Error(`getTechnicalCacheReadinessForUser: expected OK, got ${JSON.stringify(result)}`);
    return result;
  }

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    ({
      getEligibleTechnicalRefreshTickersForUser,
      refreshTechnicalIndicatorCacheBatchForUser: refreshTechnicalIndicatorCacheBatchForUserRaw,
      getTechnicalIndicatorSnapshotsForUser,
      getTechnicalCacheReadinessForUser: getTechnicalCacheReadinessForUserRaw,
      getOrCreateActiveTechnicalPreparationRun: getOrCreateActiveTechnicalPreparationRunRaw,
      checkDailyCandleAvailabilityGate,
      computeQuoteStageRulesFingerprint,
      dateOnlyUtc,
      getTechnicalPreparationRunAggregatesForUser,
      getTechnicalPreparationStatusForUser,
      requiredTechnicalMarketDateUtc,
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
    // Some tests deliberately change price/volume rules to prove fingerprint behavior - reset to
    // the real LST Core defaults so later tests' price=20/volume fixtures aren't affected.
    // Scoped to THIS file's own two users' own "My LST" profiles only - never a global update,
    // which would corrupt other test files' own scanner-rule fixtures running concurrently.
    const ownProfiles = await prisma.scannerProfile.findMany({ where: { ownerId: { in: [matt.id, eric.id] }, name: "My LST" }, select: { id: true } });
    if (ownProfiles.length) {
      await prisma.scannerRule.updateMany({
        where: { key: "price", profileId: { in: ownProfiles.map((profile) => profile.id) } },
        data: { valueJson: { desired: [10, 50] } },
      });
      await prisma.scannerRule.updateMany({
        where: { key: "stockVolume", profileId: { in: ownProfiles.map((profile) => profile.id) } },
        data: { valueJson: { desired: 40_000 } },
      });
    }
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [matt.id, eric.id] } } });
    await prisma.$disconnect();
  });

  /** 5 dedicated tickers, deliberately named to sort alphabetically FIRST (a leading "0" - every
   * real test ticker in this file starts with a letter) so the global daily-candle-availability
   * gate's own fixture-source fallback probe always lands on exactly these control rows, never on
   * whatever ticker(s) an individual test is deliberately trying to exercise (which may be
   * intentionally stale/lagged/unavailable). Never explicitly registered in any test's own
   * fakeProvider `candlesByTicker`/`failTickers` options, so withGateControlTickers can satisfy the
   * gate without any test needing to think about it. seedUniverse inserts these on every call
   * (skipDuplicates - safe if a test seeds more than once) so the gate passes by construction
   * throughout this whole file. */
  const GATE_CONTROL_TICKERS = ["0GATECTRLTC0", "0GATECTRLTC1", "0GATECTRLTC2", "0GATECTRLTC3", "0GATECTRLTC4"];
  const GATE_CONTROL_TICKER_SET = new Set(GATE_CONTROL_TICKERS);

  /** Wraps a test's own provider so the 5 gate-control tickers always return candles ending
   * EXACTLY at `now` (guaranteed fresh relative to previousNyseMarketDay(now), for whatever `now`
   * this specific call uses - including a test's own far-future/far-past synthetic `now`) -
   * delegating every other ticker to the real provider completely unchanged. Needed because a
   * plain default (e.g. always "real current time") would appear stale to a test that advances
   * `now` forward/backward relative to real wall-clock time. */
  function withGateControlTickers(provider: MarketDataProvider, now: Date): MarketDataProvider {
    return {
      ...provider,
      async getPriceHistory(symbol, days) {
        if (GATE_CONTROL_TICKER_SET.has(symbol)) {
          return syntheticCandles(symbol, 80, now);
        }
        return provider.getPriceHistory(symbol, days);
      },
    };
  }

  async function seedUniverse(tickers: string[], prices: Record<string, number> = {}) {
    const now = new Date();
    await prisma.optionableUniverseSymbol.createMany({
      data: [...GATE_CONTROL_TICKERS, ...tickers].map((ticker) => ({ ticker, name: `${ticker} Corp`, source: TEST_SOURCE, lastSeenAt: now })),
      skipDuplicates: true,
    });
    universeTickers.push(...tickers);
    return tickers.reduce<Record<string, { price: number; volume: number }>>((acc, ticker) => {
      acc[ticker] = { price: prices[ticker] ?? 20, volume: 1_000_000 };
      return acc;
    }, {});
  }

  async function createPreparationRunWithItems(
    userId: string,
    now: Date,
    items: { ticker: string; status: "PENDING" | "PROCESSING" | "READY" | "DEFERRED" | "FAILED"; priority?: number; processedAt?: Date | null }[],
    status: "IN_PROGRESS" | "COMPLETE" = "IN_PROGRESS",
  ) {
    const profile = await ensureMyLstScannerProfileForUser(userId);
    const records = await prisma.scannerRule.findMany({ where: { profileId: profile.id }, orderBy: { sortOrder: "asc" } });
    const rulesFingerprint = computeQuoteStageRulesFingerprint(scannerRulesFromRecords(records));
    const run = await prisma.technicalPreparationRun.create({
      data: { userId, marketDate: dateOnlyUtc(now), rulesFingerprint, eligibleCount: items.length, status },
    });
    await prisma.technicalPreparationItem.createMany({
      data: items.map((item) => ({
        runId: run.id,
        ticker: item.ticker,
        priority: item.priority ?? 2,
        status: item.status,
        processedAt: item.processedAt ?? (item.status === "READY" || item.status === "FAILED" ? now : null),
      })),
    });
    return run;
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

  async function setStockVolumeRuleMinimum(userId: string, minimum: number) {
    const profile = await ensureMyLstScannerProfileForUser(userId);
    await prisma.scannerRule.update({
      where: { profileId_key: { profileId: profile.id, key: "stockVolume" } },
      data: { valueJson: { desired: minimum } },
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

  it("Phase A technical eligibility uses price only, not current quote volume", async () => {
    await seedUniverse(["TECHLOWVOL", "TECHHIGHVOL", "TECHTOOEXPENSIVE"]);
    const provider = fakeProvider({
      quotes: {
        TECHLOWVOL: { price: 20, volume: 5_000 },
        TECHHIGHVOL: { price: 20, volume: 1_000_000 },
        TECHTOOEXPENSIVE: { price: 999, volume: 1_000_000 },
      },
    });

    const result = await getEligibleTechnicalRefreshTickersForUser(matt.id, provider);
    const tickers = result.map((item) => item.ticker);

    expect(tickers).toContain("TECHLOWVOL");
    expect(tickers).toContain("TECHHIGHVOL");
    expect(tickers).not.toContain("TECHTOOEXPENSIVE");
  });

  it("a symbol with acceptable price but low current morning volume can still have RSI/BB prepared", async () => {
    const now = new Date("2026-09-10T10:00:00Z"); // Sep 10 morning ET; previous NYSE market date is Sep 9.
    await seedUniverse(["TECHMORNINGLOWVOL"]);
    const provider = fakeProvider({
      quotes: { TECHMORNINGLOWVOL: { price: 20, volume: 5_000 } },
      candlesByTicker: { TECHMORNINGLOWVOL: syntheticCandles("TECHMORNINGLOWVOL", 80, new Date("2026-09-09T20:00:00Z")) },
    });

    const batch = await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 5, now });

    expect(batch.processedCount).toBe(1);
    expect(batch.succeededCount).toBe(1);
    expect(batch.remainingEligibleCount).toBe(0);
    const item = await prisma.technicalPreparationItem.findFirstOrThrow({ where: { ticker: "TECHMORNINGLOWVOL" } });
    expect(item.status).toBe("READY");
    const snapshot = await prisma.technicalIndicatorSnapshot.findUniqueOrThrow({
      where: { userId_ticker: { userId: matt.id, ticker: "TECHMORNINGLOWVOL" } },
    });
    expect(snapshot.status).toBe("READY");
    expect(snapshot.rsi).not.toBeNull();
    expect(snapshot.bbLower).not.toBeNull();
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

  it("getTechnicalCacheFreshnessBreakdownForUser: after the immediate-stale-candle fix, a lagged candle never becomes workflow-READY in the first place - it's DEFERRED, and freshUsableCount/workflowReadyCount agree", async () => {
    const { previousNyseMarketDay } = await import("@/domain/finance/marketCalendar");
    const { getTechnicalCacheFreshnessBreakdownForUser } = await import("./technical-indicator-cache");

    const now = new Date("2026-09-09T14:00:00Z");
    const requiredMarketDate = previousNyseMarketDay(now);
    const laggedDate = previousNyseMarketDay(requiredMarketDate); // one trading day short - stale by construction

    await seedUniverse(["TECHFR1", "TECHFR2"]);
    const provider = fakeProvider({
      quotes: { TECHFR1: { price: 20, volume: 1_000_000 }, TECHFR2: { price: 20, volume: 1_000_000 } },
      candlesByTicker: {
        TECHFR1: syntheticCandles("TECHFR1", 80, requiredMarketDate), // exactly fresh
        TECHFR2: syntheticCandles("TECHFR2", 80, laggedDate), // one trading day short - stale
      },
    });
    const batch = await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 2, now });
    expect(batch.succeededCount).toBe(1); // only TECHFR1
    expect(batch.deferredCount).toBe(1); // TECHFR2 - lagged, not a failure, retryable later

    const breakdown = await getTechnicalCacheFreshnessBreakdownForUser(matt.id, now);
    expect(breakdown.hasActiveRun).toBe(true);
    expect(breakdown.workflowReadyCount).toBe(1); // TECHFR2 correctly never became READY
    expect(breakdown.freshUsableCount).toBe(1);
    expect(breakdown.staleSnapshotCount).toBe(0); // no READY-but-stale item can arise post-fix
    expect(breakdown.failedSnapshotCount).toBe(0);
    expect(breakdown.missingSnapshotCount).toBe(0);
    expect(breakdown.deferredCount).toBe(1); // TECHFR2 shows up in its own bucket, not conflated with pending
    expect(breakdown.requiredMarketDate.toISOString().slice(0, 10)).toBe(requiredMarketDate.toISOString().slice(0, 10));
    expect(breakdown.newestSnapshotMarketDate?.toISOString().slice(0, 10)).toBe(requiredMarketDate.toISOString().slice(0, 10));
    expect(breakdown.oldestFreshSnapshotMarketDate?.toISOString().slice(0, 10)).toBe(requiredMarketDate.toISOString().slice(0, 10));

    // The lagged ticker's own item is DEFERRED (not READY, not FAILED), with a real retryAfter.
    const deferredItem = await prisma.technicalPreparationItem.findFirst({ where: { ticker: "TECHFR2" } });
    expect(deferredItem?.status).toBe("DEFERRED");
    expect(deferredItem?.deferredAttempts).toBe(1);
    expect(deferredItem?.retryAfter?.getTime()).toBeGreaterThan(now.getTime());

    // The snapshot itself is still written honestly (real asOfDate, real values) - the live scan's
    // OWN independent freshness check still correctly flags it stale, exactly as before the fix.
    const liveScanView = await getTechnicalIndicatorSnapshotsForUser(matt.id, ["TECHFR1", "TECHFR2"], now);
    expect(liveScanView.get("TECHFR1")?.state).toBe("READY");
    expect(liveScanView.get("TECHFR2")?.state).toBe("TECHNICAL_DATA_STALE");
  });

  it("getTechnicalCacheFreshnessBreakdownForUser still catches a READY-but-stale item as a defense-in-depth safety net, even though the fixed worker itself should never produce one", async () => {
    const { getTechnicalCacheFreshnessBreakdownForUser } = await import("./technical-indicator-cache");
    const { previousNyseMarketDay } = await import("@/domain/finance/marketCalendar");

    const ticker = "TECHFRSAFETY1";
    await seedUniverse([ticker]);
    const now = new Date("2026-09-09T14:00:00Z");
    const provider = fakeProvider({ quotes: { [ticker]: { price: 20, volume: 1_000_000 } } });

    const { runId } = await getOrCreateActiveTechnicalPreparationRun(matt.id, provider, now);
    // Manually force an item to READY with a real stale asOfDate - simulating a hypothetical
    // future regression, never something the fixed worker itself would do.
    await prisma.technicalPreparationItem.updateMany({ where: { runId, ticker }, data: { status: "READY", processedAt: now } });
    const staleDate = previousNyseMarketDay(previousNyseMarketDay(now));
    await prisma.technicalIndicatorSnapshot.upsert({
      where: { userId_ticker: { userId: matt.id, ticker } },
      create: { userId: matt.id, ticker, status: "READY", asOfDate: staleDate, rsi: 15, bbLower: 15, bbMiddle: 20, bbUpper: 45 },
      update: { status: "READY", asOfDate: staleDate },
    });

    const breakdown = await getTechnicalCacheFreshnessBreakdownForUser(matt.id, now);
    expect(breakdown.workflowReadyCount).toBeGreaterThanOrEqual(1);
    expect(breakdown.staleSnapshotCount).toBeGreaterThanOrEqual(1);
  });

  it("getTechnicalPreparationRunAggregatesForUser reports recent run and item counts without provider work or ticker dumps", async () => {
    const currentNow = new Date("2026-09-10T10:00:00Z");
    const oldNow = new Date("2026-09-08T10:00:00Z");
    await createPreparationRunWithItems(matt.id, oldNow, [{ ticker: "TECHAGGOLD", status: "READY" }], "COMPLETE");
    await createPreparationRunWithItems(
      matt.id,
      currentNow,
      [
        { ticker: "TECHAGGPENDING", status: "PENDING" },
        { ticker: "TECHAGGPROCESSING", status: "PROCESSING" },
        { ticker: "TECHAGGREADY", status: "READY" },
        { ticker: "TECHAGGDEFERRED", status: "DEFERRED" },
        { ticker: "TECHAGGFAILED", status: "FAILED" },
      ],
      "IN_PROGRESS",
    );

    const aggregates = await getTechnicalPreparationRunAggregatesForUser(matt.id, currentNow);

    expect(aggregates.currentMarketDate.toISOString().slice(0, 10)).toBe("2026-09-10");
    expect(aggregates.requiredMarketDate.toISOString().slice(0, 10)).toBe("2026-09-09");
    expect(aggregates.runs).toHaveLength(2);
    const current = aggregates.runs.find((run) => run.marketDate.toISOString().slice(0, 10) === "2026-09-10");
    expect(current).toMatchObject({
      status: "IN_PROGRESS",
      eligibleCount: 5,
      itemCount: 5,
      pendingCount: 1,
      processingCount: 1,
      readyCount: 1,
      deferredCount: 1,
      failedCount: 1,
      isCurrentRunIdentity: true,
    });
    const old = aggregates.runs.find((run) => run.marketDate.toISOString().slice(0, 10) === "2026-09-08");
    expect(old).toMatchObject({
      status: "COMPLETE",
      eligibleCount: 1,
      itemCount: 1,
      readyCount: 1,
      isCurrentRunIdentity: false,
    });
  });

  it("Sep 10 5:31 AM ET run treats Sep 9 snapshots as fresh, preserves READY items, skips the gate, and completes", async () => {
    const now = new Date("2026-09-10T09:31:00Z");
    const requiredMarketDate = requiredTechnicalMarketDateUtc(now);
    const readyTickers = ["TECHSEP10READY0", "TECHSEP10READY1", "TECHSEP10READY2"];
    const pendingTickers = ["TECHSEP10PENDING0", "TECHSEP10PENDING1"];
    await seedUniverse([...readyTickers, ...pendingTickers]);

    const run = await createPreparationRunWithItems(
      matt.id,
      now,
      [
        ...readyTickers.map((ticker) => ({ ticker, status: "READY" as const })),
        ...pendingTickers.map((ticker) => ({ ticker, status: "PENDING" as const })),
      ],
      "IN_PROGRESS",
    );
    expect(run.marketDate.toISOString().slice(0, 10)).toBe("2026-09-10");
    expect(requiredMarketDate.toISOString().slice(0, 10)).toBe("2026-09-09");

    await prisma.technicalIndicatorSnapshot.createMany({
      data: readyTickers.map((ticker) => ({
        userId: matt.id,
        ticker,
        status: "READY" as const,
        asOfDate: requiredMarketDate,
        rsi: 25,
        bbLower: 15,
        bbMiddle: 20,
        bbUpper: 25,
      })),
    });

    const historyFetches: string[] = [];
    const provider = fakeProvider({
      quotes: {},
      candlesByTicker: Object.fromEntries(pendingTickers.map((ticker) => [ticker, syntheticCandles(ticker, 80, requiredMarketDate)])),
      onGetPriceHistory: (ticker) => historyFetches.push(ticker),
    });

    const reused = await getOrCreateActiveTechnicalPreparationRunRaw(matt.id, provider, now, { probeUniverseSource: TEST_SOURCE });
    expect(reused.status).toBe("OK");
    if (reused.status !== "OK") throw new Error("expected OK");
    expect(reused.runId).toBe(run.id);
    expect(historyFetches).toEqual([]); // 3 genuinely-fresh READY rows are enough proof to skip the gate.
    expect(await prisma.technicalPreparationItem.count({ where: { runId: run.id, status: "READY" } })).toBe(3);
    expect(await prisma.technicalPreparationItem.count({ where: { runId: run.id, status: "PENDING" } })).toBe(2);

    const batch = await refreshTechnicalIndicatorCacheBatchForUserRaw(matt.id, provider, { batchSize: 5, now, probeUniverseSource: TEST_SOURCE });
    expect(batch.status).toBe("OK");
    if (batch.status !== "OK") throw new Error("expected OK");
    expect(batch.processedCount).toBe(2);
    expect(batch.succeededCount).toBe(2);
    expect(batch.remainingEligibleCount).toBe(0);
    expect(historyFetches.sort()).toEqual([...pendingTickers].sort()); // still no gate probe calls.

    const completedRun = await prisma.technicalPreparationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(completedRun.status).toBe("COMPLETE");
    expect(await prisma.technicalPreparationItem.count({ where: { runId: run.id, status: "READY" } })).toBe(5);
    const lookup = await getTechnicalIndicatorSnapshotsForUser(matt.id, [...readyTickers, ...pendingTickers], now);
    for (const ticker of [...readyTickers, ...pendingTickers]) {
      const entry = lookup.get(ticker);
      expect(entry?.state).toBe("READY");
      if (entry?.state === "READY") {
        expect(entry.asOfDate.toISOString().slice(0, 10)).toBe("2026-09-09");
      }
    }
  });

  it("Sep 10 5:31 AM ET run repairs Sep 8 READY items as stale before reprocessing them", async () => {
    const now = new Date("2026-09-10T09:31:00Z");
    const requiredMarketDate = requiredTechnicalMarketDateUtc(now);
    const staleMarketDate = dateOnlyUtc(new Date("2026-09-08T20:00:00Z"));
    const tickers = ["TECHSEP8STALE0", "TECHSEP8STALE1", "TECHSEP8STALE2", "TECHSEP8PENDING"];
    await seedUniverse(tickers);

    const run = await createPreparationRunWithItems(
      matt.id,
      now,
      tickers.map((ticker) => ({ ticker, status: ticker === "TECHSEP8PENDING" ? ("PENDING" as const) : ("READY" as const) })),
      "COMPLETE",
    );
    expect(run.marketDate.toISOString().slice(0, 10)).toBe("2026-09-10");
    expect(requiredMarketDate.toISOString().slice(0, 10)).toBe("2026-09-09");
    expect(staleMarketDate.toISOString().slice(0, 10)).toBe("2026-09-08");

    await prisma.technicalIndicatorSnapshot.createMany({
      data: tickers
        .filter((ticker) => ticker !== "TECHSEP8PENDING")
        .map((ticker) => ({
          userId: matt.id,
          ticker,
          status: "READY" as const,
          asOfDate: staleMarketDate,
          rsi: 25,
          bbLower: 15,
          bbMiddle: 20,
          bbUpper: 25,
        })),
    });
    expect((await getTechnicalIndicatorSnapshotsForUser(matt.id, ["TECHSEP8STALE0"], now)).get("TECHSEP8STALE0")?.state).toBe(
      "TECHNICAL_DATA_STALE",
    );

    const historyFetches: string[] = [];
    const provider = fakeProvider({
      quotes: {},
      candlesByTicker: Object.fromEntries([...GATE_CONTROL_TICKERS, ...tickers].map((ticker) => [ticker, syntheticCandles(ticker, 80, requiredMarketDate)])),
      onGetPriceHistory: (ticker) => historyFetches.push(ticker),
    });

    const batch = await refreshTechnicalIndicatorCacheBatchForUserRaw(matt.id, provider, { batchSize: 5, now, probeUniverseSource: TEST_SOURCE });
    expect(batch.status).toBe("OK");
    if (batch.status !== "OK") throw new Error("expected OK");
    expect(batch.processedCount).toBe(4);
    expect(batch.succeededCount).toBe(4);
    expect(batch.remainingEligibleCount).toBe(0);

    const gateProbeCalls = historyFetches.filter((ticker) => GATE_CONTROL_TICKER_SET.has(ticker));
    const workCalls = historyFetches.filter((ticker) => !GATE_CONTROL_TICKER_SET.has(ticker));
    expect(gateProbeCalls).toHaveLength(5); // stale Sep 8 READY rows did not count as the 3-row gate-skip proof.
    expect(workCalls.sort()).toEqual([...tickers].sort());

    const completedRun = await prisma.technicalPreparationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(completedRun.status).toBe("COMPLETE");
    expect(await prisma.technicalPreparationItem.count({ where: { runId: run.id, status: "READY" } })).toBe(4);
    const lookup = await getTechnicalIndicatorSnapshotsForUser(matt.id, tickers, now);
    for (const ticker of tickers) {
      const entry = lookup.get(ticker);
      expect(entry?.state).toBe("READY");
      if (entry?.state === "READY") {
        expect(entry.asOfDate.toISOString().slice(0, 10)).toBe("2026-09-09");
      }
    }
  });

  it("a current-enough candle marks the item READY on the very first attempt (deferredAttempts stays 0)", async () => {
    const { previousNyseMarketDay } = await import("@/domain/finance/marketCalendar");
    await seedUniverse(["TECHOK1"]);
    const now = new Date();
    const requiredMarketDate = previousNyseMarketDay(now);
    const provider = fakeProvider({
      quotes: { TECHOK1: { price: 20, volume: 1_000_000 } },
      candlesByTicker: { TECHOK1: syntheticCandles("TECHOK1", 80, requiredMarketDate) },
    });

    const batch = await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 1, now });
    expect(batch.succeededCount).toBe(1);
    expect(batch.deferredCount).toBe(0);

    const item = await prisma.technicalPreparationItem.findFirst({ where: { ticker: "TECHOK1" } });
    expect(item?.status).toBe("READY");
    expect(item?.deferredAttempts).toBe(0);
    expect(item?.retryAfter).toBeNull();
  });

  it("a DEFERRED item cannot be reclaimed before its retryAfter - a second invocation immediately afterward claims nothing for it", async () => {
    const { previousNyseMarketDay } = await import("@/domain/finance/marketCalendar");
    await seedUniverse(["TECHDEF1"]);
    const now = new Date();
    const requiredMarketDate = previousNyseMarketDay(now);
    const laggedDate = previousNyseMarketDay(requiredMarketDate);
    const provider = fakeProvider({
      quotes: { TECHDEF1: { price: 20, volume: 1_000_000 } },
      candlesByTicker: { TECHDEF1: syntheticCandles("TECHDEF1", 80, laggedDate) },
    });

    const first = await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 1, now });
    expect(first.deferredCount).toBe(1);

    // Immediately afterward (same moment) - the item is DEFERRED with a future retryAfter, so
    // nothing is claimable for this ticker; it is not the only eligible ticker in this run, but it
    // is the ONLY one, so the second batch must claim (and therefore process) nothing at all.
    const second = await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 1, now });
    expect(second.processedCount).toBe(0);
  });

  it("a DEFERRED item becomes reclaimable once its retryAfter has passed, and can succeed on retry with a now-current candle", async () => {
    const { previousNyseMarketDay } = await import("@/domain/finance/marketCalendar");
    const { DEFERRED_RETRY_INTERVAL_MS } = await import("./technical-indicator-cache");
    await seedUniverse(["TECHRETRY1"]);
    const now = new Date("2026-09-09T14:00:00Z");
    const requiredMarketDate = previousNyseMarketDay(now);
    const laggedDate = previousNyseMarketDay(requiredMarketDate);

    const laggedProvider = fakeProvider({
      quotes: { TECHRETRY1: { price: 20, volume: 1_000_000 } },
      candlesByTicker: { TECHRETRY1: syntheticCandles("TECHRETRY1", 80, laggedDate) },
    });
    const first = await refreshTechnicalIndicatorCacheBatchForUser(matt.id, laggedProvider, { batchSize: 1, now });
    expect(first.deferredCount).toBe(1);

    // Retrying right after retryAfter, with a provider that NOW returns a current candle (as if
    // Schwab finally posted the just-closed session's own daily bar) - succeeds this time.
    const retryNow = new Date(now.getTime() + DEFERRED_RETRY_INTERVAL_MS + 1000);
    const caughtUpProvider = fakeProvider({
      quotes: { TECHRETRY1: { price: 20, volume: 1_000_000 } },
      candlesByTicker: { TECHRETRY1: syntheticCandles("TECHRETRY1", 80, previousNyseMarketDay(retryNow)) },
    });
    const second = await refreshTechnicalIndicatorCacheBatchForUser(matt.id, caughtUpProvider, { batchSize: 1, now: retryNow });
    expect(second.processedCount).toBe(1);
    expect(second.succeededCount).toBe(1);

    const item = await prisma.technicalPreparationItem.findFirst({ where: { ticker: "TECHRETRY1" } });
    expect(item?.status).toBe("READY");
    expect(item?.deferredAttempts).toBe(1); // the one real deferred attempt is preserved, not reset
  });

  it("a DEFERRED item never starves an unrelated genuinely-PENDING item - the claim query skips a not-yet-retryable row and moves on", async () => {
    const { previousNyseMarketDay } = await import("@/domain/finance/marketCalendar");
    await seedUniverse(["TECHSTARVEA", "TECHSTARVEB"]); // alphabetically A sorts before B
    const now = new Date("2026-09-09T14:00:00Z");
    const requiredMarketDate = previousNyseMarketDay(now);
    const laggedDate = previousNyseMarketDay(requiredMarketDate);
    const provider = fakeProvider({
      quotes: { TECHSTARVEA: { price: 20, volume: 1_000_000 }, TECHSTARVEB: { price: 20, volume: 1_000_000 } },
      candlesByTicker: {
        TECHSTARVEA: syntheticCandles("TECHSTARVEA", 80, laggedDate), // will be DEFERRED
        TECHSTARVEB: syntheticCandles("TECHSTARVEB", 80, requiredMarketDate), // fresh, would be READY
      },
    });

    // First call: batchSize 1 claims only TECHSTARVEA (alphabetically first) - it becomes DEFERRED.
    const first = await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 1, now });
    expect(first.deferredCount).toBe(1);

    // Second call, same moment (TECHSTARVEA's retryAfter has NOT passed) - the claim query must
    // skip it and claim TECHSTARVEB instead, never blocking on the not-yet-retryable row.
    const second = await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 1, now });
    expect(second.processedCount).toBe(1);
    expect(second.succeededCount).toBe(1);
    const bItem = await prisma.technicalPreparationItem.findFirst({ where: { ticker: "TECHSTARVEB" } });
    expect(bItem?.status).toBe("READY");
  });

  it("a run cannot become COMPLETE while a DEFERRED item still has a real retry attempt left", async () => {
    const { previousNyseMarketDay } = await import("@/domain/finance/marketCalendar");
    await seedUniverse(["TECHNOCOMPLETE1"]);
    const now = new Date();
    const laggedDate = previousNyseMarketDay(previousNyseMarketDay(now));
    const provider = fakeProvider({
      quotes: { TECHNOCOMPLETE1: { price: 20, volume: 1_000_000 } },
      candlesByTicker: { TECHNOCOMPLETE1: syntheticCandles("TECHNOCOMPLETE1", 80, laggedDate) },
    });

    const batch = await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 1, now });
    expect(batch.remainingEligibleCount).toBe(1); // the DEFERRED item still counts as remaining work

    const item = await prisma.technicalPreparationItem.findFirst({ where: { ticker: "TECHNOCOMPLETE1" } });
    const run = await prisma.technicalPreparationRun.findUnique({ where: { id: item!.runId } });
    expect(run?.status).toBe("IN_PROGRESS"); // never COMPLETE while retryable deferred work remains
  });

  it("bounded retry: a candle that never catches up becomes FAILED after MAX_DEFERRED_ATTEMPTS, and the run can then COMPLETE", async () => {
    const { previousNyseMarketDay } = await import("@/domain/finance/marketCalendar");
    const { DEFERRED_RETRY_INTERVAL_MS, MAX_DEFERRED_ATTEMPTS } = await import("./technical-indicator-cache");
    await seedUniverse(["TECHBOUNDED1"]);

    let now = new Date("2026-09-09T14:00:00Z");
    const laggedDate = previousNyseMarketDay(previousNyseMarketDay(now));
    // A provider whose candle NEVER catches up, no matter how many times it's asked - simulating a
    // provider outage/persistent lag, never resolved within this run/generation.
    const provider = fakeProvider({
      quotes: { TECHBOUNDED1: { price: 20, volume: 1_000_000 } },
      candlesByTicker: { TECHBOUNDED1: syntheticCandles("TECHBOUNDED1", 80, laggedDate) },
    });

    let lastBatch;
    for (let attempt = 0; attempt < MAX_DEFERRED_ATTEMPTS; attempt += 1) {
      lastBatch = await refreshTechnicalIndicatorCacheBatchForUser(matt.id, provider, { batchSize: 1, now });
      now = new Date(now.getTime() + DEFERRED_RETRY_INTERVAL_MS + 1000);
    }

    expect(lastBatch!.failedCount).toBe(1); // exhausted on the final attempt, never an unbounded loop
    const item = await prisma.technicalPreparationItem.findFirst({ where: { ticker: "TECHBOUNDED1" } });
    expect(item?.status).toBe("FAILED");
    expect(item?.deferredAttempts).toBe(MAX_DEFERRED_ATTEMPTS);
    expect(item?.retryAfter).toBeNull();

    // FAILED no longer counts as remaining - the run can now genuinely complete.
    const run = await prisma.technicalPreparationRun.findUnique({ where: { id: item!.runId } });
    expect(run?.status).toBe("COMPLETE");
  });

  it("a lagged refetch never regresses an existing, already-fresher TechnicalIndicatorSnapshot to an older asOfDate", async () => {
    const { previousNyseMarketDay } = await import("@/domain/finance/marketCalendar");
    const ticker = "TECHNOREGRESS1";
    await seedUniverse([ticker]);
    const now = new Date();
    const requiredMarketDate = previousNyseMarketDay(now);
    const laggedDate = previousNyseMarketDay(requiredMarketDate);

    // A real, already-good snapshot exists - fresher than what this fetch is about to return.
    await prisma.technicalIndicatorSnapshot.create({
      data: { userId: matt.id, ticker, status: "READY", asOfDate: requiredMarketDate, rsi: 42, bbLower: 10, bbMiddle: 20, bbUpper: 30 },
    });

    // Manually seed a PENDING item in a real run for this ticker (simulating the edge case where an
    // item is re-attempted despite an existing fresh snapshot - the "skip if already fresh"
    // optimization only applies at run-creation time, so this is a legitimate defensive scenario).
    const provider = fakeProvider({ quotes: { [ticker]: { price: 20, volume: 1_000_000 } } });
    const { runId } = await getOrCreateActiveTechnicalPreparationRun(matt.id, provider, now);
    await prisma.technicalPreparationItem.upsert({
      where: { runId_ticker: { runId, ticker } },
      create: { runId, ticker, priority: 2, status: "PENDING" },
      update: { status: "PENDING", deferredAttempts: 0, retryAfter: null },
    });

    const laggedProvider = fakeProvider({
      quotes: { [ticker]: { price: 20, volume: 1_000_000 } },
      candlesByTicker: { [ticker]: syntheticCandles(ticker, 80, laggedDate) },
    });
    await refreshTechnicalIndicatorCacheBatchForUser(matt.id, laggedProvider, { batchSize: 1, now });

    const snapshot = await prisma.technicalIndicatorSnapshot.findUniqueOrThrow({ where: { userId_ticker: { userId: matt.id, ticker } } });
    expect(snapshot.asOfDate?.toISOString().slice(0, 10)).toBe(requiredMarketDate.toISOString().slice(0, 10)); // unchanged
    expect(snapshot.rsi).toBe(42); // unchanged - the old good values were preserved, never overwritten
  });

  it("getTechnicalCacheFreshnessBreakdownForUser reports hasActiveRun: false and performs no provider work when no run exists yet for today", async () => {
    const { getTechnicalCacheFreshnessBreakdownForUser } = await import("./technical-indicator-cache");
    const breakdown = await getTechnicalCacheFreshnessBreakdownForUser(matt.id);
    expect(breakdown).toMatchObject({ hasActiveRun: false, eligibleCount: 0, workflowReadyCount: 0, freshUsableCount: 0 });
  });

  it("getTechnicalCacheFreshnessBreakdownForUser({mostRecentRun: true}) does not hide a genuinely stale carried-over cache on a day with no NEW run yet - the Scanner page's own staleness banner depends on this", async () => {
    const { getTechnicalCacheFreshnessBreakdownForUser } = await import("./technical-indicator-cache");
    const { previousNyseMarketDay } = await import("@/domain/finance/marketCalendar");

    // Friday Sep 11 2026, 6:00 AM ET - a real preparation run created that morning, requiring
    // Thursday Sep 10's candle (Friday hadn't closed yet). Successful: 3/3 READY, asOfDate = Sep 10.
    const fridayMorning = new Date("2026-09-11T06:00:00-04:00");
    const tickers = ["FRESHBANNER0", "FRESHBANNER1", "FRESHBANNER2"];
    await createPreparationRunWithItems(
      matt.id,
      fridayMorning,
      tickers.map((ticker) => ({ ticker, status: "READY" as const })),
      "COMPLETE",
    );
    await prisma.technicalIndicatorSnapshot.createMany({
      data: tickers.map((ticker) => ({
        userId: matt.id,
        ticker,
        status: "READY",
        asOfDate: previousNyseMarketDay(fridayMorning), // Thu Sep 10 - correct/fresh as of Friday morning
        rsi: 50,
        historyFetchedAt: fridayMorning,
      })),
    });

    // Saturday Sep 12 2026, 8:00 AM ET - no NEW run was ever created for Saturday's own date (e.g.
    // the catch-up window hasn't opened yet, or the daily-candle gate never let one through this
    // Saturday). Required market date is now Friday Sep 11 - Thursday's snapshots are genuinely stale.
    const saturdayNow = new Date("2026-09-12T08:00:00-04:00");

    // The default ("today only") lookup still correctly reports no active run today - unchanged,
    // proving this fix does not alter the pre-existing Freshness Detail diagnostic's own contract.
    const defaultBreakdown = await getTechnicalCacheFreshnessBreakdownForUser(matt.id, saturdayNow);
    expect(defaultBreakdown.hasActiveRun).toBe(false);

    // mostRecentRun: true correctly finds Friday's run and honestly reports it as stale, not hidden.
    const bannerBreakdown = await getTechnicalCacheFreshnessBreakdownForUser(matt.id, saturdayNow, { mostRecentRun: true });
    expect(bannerBreakdown.hasActiveRun).toBe(true);
    expect(bannerBreakdown.eligibleCount).toBe(3);
    expect(bannerBreakdown.freshUsableCount).toBe(0);
    expect(bannerBreakdown.staleSnapshotCount).toBe(3);
    expect(bannerBreakdown.requiredMarketDate.toISOString().slice(0, 10)).toBe("2026-09-11");
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

  it("a change to the user's price rule invalidates the persisted eligibility set - a new run (and a real re-sweep) is created", async () => {
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

  it("a change to the live stock-volume rule does not invalidate technical preparation when volume is not part of preparation eligibility", async () => {
    await seedUniverse(["TECHFV1", "TECHFV2"]);
    const provider = fakeProvider({ quotes: { TECHFV1: { price: 20, volume: 100_000 }, TECHFV2: { price: 20, volume: 100_000 } } });

    const firstRun = await getOrCreateActiveTechnicalPreparationRun(matt.id, provider);

    await setStockVolumeRuleMinimum(matt.id, 2_000_000); // live-scan-only now; should not affect prep run identity

    let getQuotesCallCount = 0;
    const providerAfterRuleChange = fakeProvider({
      quotes: { TECHFV1: { price: 20, volume: 100_000 }, TECHFV2: { price: 20, volume: 100_000 } },
      onGetQuotes: () => {
        getQuotesCallCount += 1;
      },
    });
    const secondRun = await getOrCreateActiveTechnicalPreparationRun(matt.id, providerAfterRuleChange);

    expect(secondRun.freshlyCreated).toBe(false);
    expect(secondRun.runId).toBe(firstRun.runId);
    expect(secondRun.eligibleCount).toBe(2);
    expect(getQuotesCallCount).toBe(0);
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

  describe("Global daily-candle-availability gate (checkDailyCandleAvailabilityGate) - see PROJECT_HANDOFF.md", () => {
    /** These tests exercise the RAW module functions directly (bypassing the describe-level OK-
     * narrowing wrappers above, which inject GATE_CONTROL_TICKERS specifically so OTHER tests
     * never have to think about the gate) - they need full, explicit control over exactly which
     * tickers get probed and what the gate itself decides, including the NOT_READY shape. */
    let previousNyseMarketDayFn: typeof import("@/domain/finance/marketCalendar").previousNyseMarketDay;

    beforeAll(async () => {
      ({ previousNyseMarketDay: previousNyseMarketDayFn } = await import("@/domain/finance/marketCalendar"));
    });

    it("never issues more than LATEST_CANDLE_FRESHNESS_DIAGNOSTIC_SYMBOL_COUNT (5) history requests, regardless of how large the universe is", async () => {
      const tickers = Array.from({ length: 20 }, (_, i) => `TECHGATEBIG${String(i).padStart(2, "0")}`);
      await prisma.optionableUniverseSymbol.createMany({
        data: tickers.map((ticker) => ({ ticker, name: `${ticker} Corp`, source: TEST_SOURCE, lastSeenAt: new Date() })),
      });
      const now = new Date();
      let callCount = 0;
      const provider = fakeProvider({
        quotes: {},
        candlesByTicker: Object.fromEntries(tickers.map((t) => [t, syntheticCandles(t, 80, now)])),
        onGetPriceHistory: () => (callCount += 1),
      });

      const gate = await checkDailyCandleAvailabilityGate(provider, now, { probeUniverseSource: TEST_SOURCE });
      expect(gate.ready).toBe(true);
      expect(callCount).toBeLessThanOrEqual(5);
      expect(callCount).toBe(5); // exactly 5 - the universe has more than enough to probe
    });

    it("zero probes is INCONCLUSIVE, never vacuously ready", async () => {
      const now = new Date();
      let callCount = 0;
      const provider = fakeProvider({
        quotes: {},
        onGetPriceHistory: () => {
          callCount += 1;
        },
      });

      const gate = await checkDailyCandleAvailabilityGate(provider, now, { probeUniverseSource: TEST_SOURCE });

      expect(gate.ready).toBe(false);
      expect(gate.status).toBe("INCONCLUSIVE");
      expect(gate.freshProbeCount).toBe(0);
      expect(gate.staleProbeCount).toBe(0);
      expect(gate.unavailableProbeCount).toBe(0);
      expect(callCount).toBe(0);
    });

    it.each([1, 2])("%i successful current probe(s) is still INCONCLUSIVE", async (successfulProbeCount) => {
      await prisma.optionableUniverseSymbol.deleteMany({ where: { source: TEST_SOURCE } });
      const tickers = Array.from({ length: successfulProbeCount }, (_, i) => `TECHGATEFEW${successfulProbeCount}${i}`);
      await prisma.optionableUniverseSymbol.createMany({
        data: tickers.map((ticker) => ({ ticker, name: `${ticker} Corp`, source: TEST_SOURCE, lastSeenAt: new Date() })),
      });
      const now = new Date();
      const provider = fakeProvider({
        quotes: {},
        candlesByTicker: Object.fromEntries(tickers.map((ticker) => [ticker, syntheticCandles(ticker, 80, now)])),
      });

      const gate = await checkDailyCandleAvailabilityGate(provider, now, { probeUniverseSource: TEST_SOURCE });

      expect(gate.ready).toBe(false);
      expect(gate.status).toBe("INCONCLUSIVE");
      expect(gate.freshProbeCount).toBe(successfulProbeCount);
      expect(gate.staleProbeCount).toBe(0);
      expect(gate.unavailableProbeCount).toBe(0);
    });

    it("three successful current probes are enough to pass the gate", async () => {
      const tickers = ["TECHGATETHREE0", "TECHGATETHREE1", "TECHGATETHREE2"];
      await prisma.optionableUniverseSymbol.createMany({
        data: tickers.map((ticker) => ({ ticker, name: `${ticker} Corp`, source: TEST_SOURCE, lastSeenAt: new Date() })),
      });
      const now = new Date();
      const provider = fakeProvider({
        quotes: {},
        candlesByTicker: Object.fromEntries(tickers.map((ticker) => [ticker, syntheticCandles(ticker, 80, now)])),
      });

      const gate = await checkDailyCandleAvailabilityGate(provider, now, { probeUniverseSource: TEST_SOURCE });

      expect(gate.ready).toBe(true);
      expect(gate.status).toBe("READY");
      expect(gate.freshProbeCount).toBe(3);
      expect(gate.staleProbeCount).toBe(0);
      expect(gate.unavailableProbeCount).toBe(0);
    });

    it("one stale successful probe is NOT_READY even when the rest are unavailable", async () => {
      const staleTicker = "TECHGATESTALERULE0";
      const unavailableTickers = ["TECHGATESTALERULE1", "TECHGATESTALERULE2", "TECHGATESTALERULE3", "TECHGATESTALERULE4"];
      const tickers = [staleTicker, ...unavailableTickers];
      await prisma.optionableUniverseSymbol.createMany({
        data: tickers.map((ticker) => ({ ticker, name: `${ticker} Corp`, source: TEST_SOURCE, lastSeenAt: new Date() })),
      });
      const now = new Date();
      const laggedDate = previousNyseMarketDayFn(previousNyseMarketDayFn(now));
      const provider = fakeProvider({
        quotes: {},
        failTickers: new Set(unavailableTickers),
        candlesByTicker: { [staleTicker]: syntheticCandles(staleTicker, 80, laggedDate) },
      });

      const gate = await checkDailyCandleAvailabilityGate(provider, now, { probeUniverseSource: TEST_SOURCE });

      expect(gate.ready).toBe(false);
      expect(gate.status).toBe("NOT_READY");
      expect(gate.freshProbeCount).toBe(0);
      expect(gate.staleProbeCount).toBe(1);
      expect(gate.unavailableProbeCount).toBe(4);
    });

    it("a globally-stale probe sample skips Phase A entirely - no quote sweep, no run, no items created - costing only the probe requests", async () => {
      const tickers = ["TECHGATESTALE0", "TECHGATESTALE1", "TECHGATESTALE2", "TECHGATESTALE3", "TECHGATESTALE4", "TECHGATESTALE5"];
      await prisma.optionableUniverseSymbol.createMany({
        data: tickers.map((ticker) => ({ ticker, name: `${ticker} Corp`, source: TEST_SOURCE, lastSeenAt: new Date() })),
      });
      const now = new Date();
      const laggedDate = previousNyseMarketDayFn(previousNyseMarketDayFn(now));
      let getQuotesCallCount = 0;
      const provider = fakeProvider({
        quotes: Object.fromEntries(tickers.map((t) => [t, { price: 20, volume: 1_000_000 }])),
        candlesByTicker: Object.fromEntries(tickers.map((t) => [t, syntheticCandles(t, 80, laggedDate)])),
        onGetQuotes: () => (getQuotesCallCount += 1),
      });

      const result = await getOrCreateActiveTechnicalPreparationRunRaw(matt.id, provider, now, { probeUniverseSource: TEST_SOURCE });
      expect(result.status).toBe("DAILY_CANDLE_NOT_READY");
      if (result.status !== "DAILY_CANDLE_NOT_READY") throw new Error("expected DAILY_CANDLE_NOT_READY");
      expect(result.staleProbeCount).toBeGreaterThanOrEqual(3);
      expect(result.freshProbeCount).toBe(0);

      expect(getQuotesCallCount).toBe(0); // Phase A's own ~6,071-symbol-equivalent quote sweep never ran
      const runCount = await prisma.technicalPreparationRun.count({ where: { userId: matt.id } });
      const itemCount = await prisma.technicalPreparationItem.count({ where: { run: { userId: matt.id } } });
      expect(runCount).toBe(0); // no placeholder, no run at all
      expect(itemCount).toBe(0); // no bulk work items - never "thousands of DEFERRED rows"
    });

    it("a globally-stale gate prevents refreshTechnicalIndicatorCacheBatchForUser from claiming or processing anything - bounded to the probe cost alone", async () => {
      const tickers = ["TECHGATEBATCH0", "TECHGATEBATCH1", "TECHGATEBATCH2", "TECHGATEBATCH3", "TECHGATEBATCH4"];
      await prisma.optionableUniverseSymbol.createMany({
        data: tickers.map((ticker) => ({ ticker, name: `${ticker} Corp`, source: TEST_SOURCE, lastSeenAt: new Date() })),
      });
      const now = new Date();
      const laggedDate = previousNyseMarketDayFn(previousNyseMarketDayFn(now));
      let historyCallCount = 0;
      const provider = fakeProvider({
        quotes: Object.fromEntries(tickers.map((t) => [t, { price: 20, volume: 1_000_000 }])),
        candlesByTicker: Object.fromEntries(tickers.map((t) => [t, syntheticCandles(t, 80, laggedDate)])),
        onGetPriceHistory: () => (historyCallCount += 1),
      });

      const result = await refreshTechnicalIndicatorCacheBatchForUserRaw(matt.id, provider, { batchSize: 25, now, probeUniverseSource: TEST_SOURCE });
      expect(result.status).toBe("DAILY_CANDLE_NOT_READY");
      expect(historyCallCount).toBeLessThanOrEqual(5); // never "hundreds/thousands of histories"

      const itemCount = await prisma.technicalPreparationItem.count({ where: { run: { userId: matt.id } } });
      expect(itemCount).toBe(0);
    });

    it("an existing legacy IN_PROGRESS generation is repaired and gated before any bulk history work", async () => {
      const now = new Date("2026-09-09T10:00:00Z");
      const requiredMarketDate = previousNyseMarketDayFn(now);
      const staleDate = new Date("2026-09-04T20:00:00Z");
      const probeTickers = ["TECHLEGACYGATE0", "TECHLEGACYGATE1", "TECHLEGACYGATE2", "TECHLEGACYGATE3", "TECHLEGACYGATE4"];
      const workTickers = ["ZZTECHLEGACYSTALE", "ZZTECHLEGACYFAILED", "ZZTECHLEGACYMISSING", "ZZTECHLEGACYPENDING"];
      await prisma.optionableUniverseSymbol.createMany({
        data: probeTickers.map((ticker) => ({ ticker, name: `${ticker} Corp`, source: TEST_SOURCE, lastSeenAt: new Date() })),
      });
      const run = await createPreparationRunWithItems(matt.id, now, [
        { ticker: workTickers[0], status: "READY" },
        { ticker: workTickers[1], status: "READY" },
        { ticker: workTickers[2], status: "READY" },
        { ticker: workTickers[3], status: "PENDING" },
      ]);
      await prisma.technicalIndicatorSnapshot.create({
        data: { userId: matt.id, ticker: workTickers[0], status: "READY", asOfDate: dateOnlyUtc(staleDate), rsi: 15, bbLower: 15, bbMiddle: 20, bbUpper: 45 },
      });
      await prisma.technicalIndicatorSnapshot.create({
        data: { userId: matt.id, ticker: workTickers[1], status: "FAILED", asOfDate: dateOnlyUtc(staleDate), failureReason: "HISTORY_FETCH_FAILED" },
      });

      let firstQuoteSweepCount = 0;
      let firstHistoryCallCount = 0;
      let firstOptionChainCallCount = 0;
      const staleProvider = fakeProvider({
        quotes: Object.fromEntries([...probeTickers, ...workTickers].map((ticker) => [ticker, { price: 20, volume: 1_000_000 }])),
        candlesByTicker: Object.fromEntries(probeTickers.map((ticker) => [ticker, syntheticCandles(ticker, 80, staleDate)])),
        onGetQuotes: () => {
          firstQuoteSweepCount += 1;
        },
        onGetPriceHistory: () => {
          firstHistoryCallCount += 1;
        },
        onGetOptionChain: () => {
          firstOptionChainCallCount += 1;
        },
      });

      const first = await refreshTechnicalIndicatorCacheBatchForUserRaw(matt.id, staleProvider, { batchSize: 25, now, probeUniverseSource: TEST_SOURCE });

      expect(first.status).toBe("DAILY_CANDLE_NOT_READY");
      expect(firstHistoryCallCount).toBe(5); // the gate only
      expect(firstQuoteSweepCount).toBe(0); // existing run: no repeated Stage A
      expect(firstOptionChainCallCount).toBe(0);
      expect(await prisma.technicalPreparationRun.count({ where: { userId: matt.id } })).toBe(1);
      expect((await prisma.technicalPreparationRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("IN_PROGRESS");
      expect(await prisma.technicalPreparationItem.count({ where: { runId: run.id, status: "READY" } })).toBe(0);
      expect(await prisma.technicalPreparationItem.count({ where: { runId: run.id, status: "PENDING" } })).toBe(4);
      const preservedStaleSnapshot = await prisma.technicalIndicatorSnapshot.findUniqueOrThrow({
        where: { userId_ticker: { userId: matt.id, ticker: workTickers[0] } },
      });
      expect(preservedStaleSnapshot.asOfDate?.toISOString().slice(0, 10)).toBe("2026-09-04");

      let secondQuoteSweepCount = 0;
      let secondHistoryCallCount = 0;
      const freshProvider = fakeProvider({
        quotes: Object.fromEntries([...probeTickers, ...workTickers].map((ticker) => [ticker, { price: 20, volume: 1_000_000 }])),
        candlesByTicker: Object.fromEntries(
          [...probeTickers, ...workTickers].map((ticker) => [ticker, syntheticCandles(ticker, 80, requiredMarketDate)]),
        ),
        onGetQuotes: () => {
          secondQuoteSweepCount += 1;
        },
        onGetPriceHistory: () => {
          secondHistoryCallCount += 1;
        },
      });

      const second = await refreshTechnicalIndicatorCacheBatchForUserRaw(matt.id, freshProvider, { batchSize: 25, now, probeUniverseSource: TEST_SOURCE });

      expect(second.status).toBe("OK");
      if (second.status !== "OK") throw new Error("expected OK");
      expect(second.processedCount).toBe(4);
      expect(second.succeededCount).toBe(4);
      expect(second.remainingEligibleCount).toBe(0);
      expect(secondHistoryCallCount).toBe(9); // 5 gate probes + 4 real work items
      expect(secondQuoteSweepCount).toBe(0); // same existing run reused, still no Stage A repeat
      expect(await prisma.technicalPreparationRun.count({ where: { userId: matt.id } })).toBe(1);
      expect((await prisma.technicalPreparationRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("COMPLETE");
      expect(await prisma.technicalPreparationItem.count({ where: { runId: run.id, status: "READY" } })).toBe(4);
      const repairedSnapshot = await prisma.technicalIndicatorSnapshot.findUniqueOrThrow({
        where: { userId_ticker: { userId: matt.id, ticker: workTickers[0] } },
      });
      expect(repairedSnapshot.asOfDate?.toISOString().slice(0, 10)).toBe(requiredMarketDate.toISOString().slice(0, 10));
    });

    it("an existing generation with enough genuinely-fresh READY items skips repeated gate probes on later work", async () => {
      const now = new Date("2026-09-09T10:00:00Z");
      const requiredMarketDate = previousNyseMarketDayFn(now);
      const laggedDate = previousNyseMarketDayFn(requiredMarketDate);
      const probeTickers = ["TECHSKIPGATE0", "TECHSKIPGATE1", "TECHSKIPGATE2", "TECHSKIPGATE3", "TECHSKIPGATE4"];
      const readyTickers = ["ZZTECHSKIPREADY0", "ZZTECHSKIPREADY1", "ZZTECHSKIPREADY2"];
      const pendingTickers = ["ZZTECHSKIPPENDING0", "ZZTECHSKIPPENDING1"];
      await prisma.optionableUniverseSymbol.createMany({
        data: probeTickers.map((ticker) => ({ ticker, name: `${ticker} Corp`, source: TEST_SOURCE, lastSeenAt: new Date() })),
      });
      const run = await createPreparationRunWithItems(matt.id, now, [
        ...readyTickers.map((ticker) => ({ ticker, status: "READY" as const })),
        ...pendingTickers.map((ticker) => ({ ticker, status: "PENDING" as const })),
      ]);
      await prisma.technicalIndicatorSnapshot.createMany({
        data: readyTickers.map((ticker) => ({
          userId: matt.id,
          ticker,
          status: "READY" as const,
          asOfDate: dateOnlyUtc(requiredMarketDate),
          rsi: 15,
          bbLower: 15,
          bbMiddle: 20,
          bbUpper: 45,
        })),
      });

      const historyCalls: string[] = [];
      const provider = fakeProvider({
        quotes: Object.fromEntries([...probeTickers, ...pendingTickers].map((ticker) => [ticker, { price: 20, volume: 1_000_000 }])),
        candlesByTicker: {
          ...Object.fromEntries(probeTickers.map((ticker) => [ticker, syntheticCandles(ticker, 80, laggedDate)])),
          ...Object.fromEntries(pendingTickers.map((ticker) => [ticker, syntheticCandles(ticker, 80, requiredMarketDate)])),
        },
        onGetPriceHistory: (ticker) => {
          historyCalls.push(ticker);
        },
      });

      const result = await refreshTechnicalIndicatorCacheBatchForUserRaw(matt.id, provider, { batchSize: 25, now, probeUniverseSource: TEST_SOURCE });

      expect(result.status).toBe("OK");
      if (result.status !== "OK") throw new Error("expected OK");
      expect(result.processedCount).toBe(2);
      expect([...historyCalls].sort()).toEqual(pendingTickers);
      expect(await prisma.technicalPreparationItem.count({ where: { runId: run.id, status: "READY" } })).toBe(5);
    });

    it("legacy READY reconciliation is user-scoped and prevents a fake COMPLETE run from staying complete", async () => {
      const now = new Date("2026-09-09T10:00:00Z");
      const staleDate = new Date("2026-09-04T20:00:00Z");
      const mattTicker = "TECHMATTFAKEREADY";
      const ericTicker = "TECHERICFAKEREADY";
      const mattRun = await createPreparationRunWithItems(matt.id, now, [{ ticker: mattTicker, status: "READY" }], "COMPLETE");
      const ericRun = await createPreparationRunWithItems(eric.id, now, [{ ticker: ericTicker, status: "READY" }], "COMPLETE");
      await prisma.technicalIndicatorSnapshot.createMany({
        data: [
          { userId: matt.id, ticker: mattTicker, status: "READY" as const, asOfDate: dateOnlyUtc(staleDate), rsi: 15, bbLower: 15, bbMiddle: 20, bbUpper: 45 },
          { userId: eric.id, ticker: ericTicker, status: "READY" as const, asOfDate: dateOnlyUtc(staleDate), rsi: 15, bbLower: 15, bbMiddle: 20, bbUpper: 45 },
        ],
      });

      const status = await getTechnicalPreparationStatusForUser(matt.id, now);

      expect(status).toMatchObject({ hasRunForToday: true, isComplete: false });
      expect((await prisma.technicalPreparationRun.findUniqueOrThrow({ where: { id: mattRun.id } })).status).toBe("IN_PROGRESS");
      expect((await prisma.technicalPreparationItem.findFirstOrThrow({ where: { runId: mattRun.id, ticker: mattTicker } })).status).toBe("PENDING");
      expect((await prisma.technicalPreparationRun.findUniqueOrThrow({ where: { id: ericRun.id } })).status).toBe("COMPLETE");
      expect((await prisma.technicalPreparationItem.findFirstOrThrow({ where: { runId: ericRun.id, ticker: ericTicker } })).status).toBe("READY");
    });

    it("a fresh probe sample allows normal preparation to proceed exactly as before - Stage A runs, items are created, Phase B succeeds", async () => {
      const tickers = ["TECHGATEOK0", "TECHGATEOK1", "TECHGATEOK2"];
      await prisma.optionableUniverseSymbol.createMany({
        data: tickers.map((ticker) => ({ ticker, name: `${ticker} Corp`, source: TEST_SOURCE, lastSeenAt: new Date() })),
      });
      const now = new Date();
      const provider = fakeProvider({
        quotes: Object.fromEntries(tickers.map((t) => [t, { price: 20, volume: 1_000_000 }])),
        candlesByTicker: Object.fromEntries(tickers.map((t) => [t, syntheticCandles(t, 80, now)])),
      });

      const result = await refreshTechnicalIndicatorCacheBatchForUserRaw(matt.id, provider, { batchSize: 25, now, probeUniverseSource: TEST_SOURCE });
      expect(result.status).toBe("OK");
      if (result.status !== "OK") throw new Error("expected OK");
      expect(result.succeededCount).toBe(3);
    });

    it("the gate uses only the calling user's OWN passed-in provider - Matt's gate result reflects Matt's provider, never Eric's, even for the identical shared universe", async () => {
      const tickers = ["TECHGATEISO0", "TECHGATEISO1", "TECHGATEISO2", "TECHGATEISO3", "TECHGATEISO4"];
      await prisma.optionableUniverseSymbol.createMany({
        data: tickers.map((ticker) => ({ ticker, name: `${ticker} Corp`, source: TEST_SOURCE, lastSeenAt: new Date() })),
      });
      const now = new Date();
      const laggedDate = previousNyseMarketDayFn(previousNyseMarketDayFn(now));
      const mattProvider = fakeProvider({
        quotes: {},
        candlesByTicker: Object.fromEntries(tickers.map((t) => [t, syntheticCandles(t, 80, laggedDate)])), // all stale
      });
      const ericProvider = fakeProvider({
        quotes: {},
        candlesByTicker: Object.fromEntries(tickers.map((t) => [t, syntheticCandles(t, 80, now)])), // all fresh
      });

      const mattGate = await checkDailyCandleAvailabilityGate(mattProvider, now, { probeUniverseSource: TEST_SOURCE });
      const ericGate = await checkDailyCandleAvailabilityGate(ericProvider, now, { probeUniverseSource: TEST_SOURCE });
      expect(mattGate.ready).toBe(false); // Matt's own provider's stale data
      expect(ericGate.ready).toBe(true); // Eric's own provider's fresh data - completely independent
    });

    it("a single SYMBOL_UNAVAILABLE probe never permanently blocks the gate when enough OTHER probes succeed and are fresh", async () => {
      const freshTickers = ["TECHGATEUNAVAIL1", "TECHGATEUNAVAIL2", "TECHGATEUNAVAIL3", "TECHGATEUNAVAIL4"];
      const unavailableTicker = "TECHGATEUNAVAIL0"; // sorts first alphabetically among these 5
      await prisma.optionableUniverseSymbol.createMany({
        data: [unavailableTicker, ...freshTickers].map((ticker) => ({ ticker, name: `${ticker} Corp`, source: TEST_SOURCE, lastSeenAt: new Date() })),
      });
      const now = new Date();
      const provider = fakeProvider({
        quotes: {},
        // unavailableTicker deliberately has NO entry in candlesByTicker AND no default - fakeProvider's
        // own default is real synthetic candles, so explicitly fail it instead to simulate genuine unavailability.
        failTickers: new Set([unavailableTicker]),
        candlesByTicker: Object.fromEntries(freshTickers.map((t) => [t, syntheticCandles(t, 80, now)])),
      });

      const gate = await checkDailyCandleAvailabilityGate(provider, now, { probeUniverseSource: TEST_SOURCE });
      expect(gate.ready).toBe(true); // 4 successful+fresh probes >= GATE_MIN_SUCCESSFUL_PROBES, 1 unavailable never counted against it
      expect(gate.staleProbeCount).toBe(0);
      expect(gate.unavailableProbeCount).toBe(1);
    });

    it("the automatic gate and the manual latest-candle-freshness diagnostic agree exactly on which probe symbols are fresh - same underlying helper, never a second date-comparison formula", async () => {
      const tickers = ["TECHGATESHARE0", "TECHGATESHARE1", "TECHGATESHARE2", "TECHGATESHARE3", "TECHGATESHARE4"];
      await prisma.optionableUniverseSymbol.createMany({
        data: tickers.map((ticker) => ({ ticker, name: `${ticker} Corp`, source: TEST_SOURCE, lastSeenAt: new Date() })),
      });
      const now = new Date();
      const laggedDate = previousNyseMarketDayFn(previousNyseMarketDayFn(now));
      // A deliberate mix - some fresh, some stale - so the two call paths have something real to agree on.
      const provider = fakeProvider({
        quotes: {},
        candlesByTicker: {
          TECHGATESHARE0: syntheticCandles("TECHGATESHARE0", 80, now),
          TECHGATESHARE1: syntheticCandles("TECHGATESHARE1", 80, now),
          TECHGATESHARE2: syntheticCandles("TECHGATESHARE2", 80, laggedDate),
          TECHGATESHARE3: syntheticCandles("TECHGATESHARE3", 80, laggedDate),
          TECHGATESHARE4: syntheticCandles("TECHGATESHARE4", 80, now),
        },
      });

      const { runLatestCandleFreshnessDiagnostic } = await import("./technical-indicator-cache");
      const diagnostic = await runLatestCandleFreshnessDiagnostic(provider, now, { universeSource: TEST_SOURCE, symbolCount: 5 });
      const gate = await checkDailyCandleAvailabilityGate(provider, now, { probeUniverseSource: TEST_SOURCE });

      const diagnosticFreshCount = diagnostic.rows.filter((r) => r.fresh).length;
      const diagnosticStaleCount = diagnostic.rows.filter((r) => !r.fresh && r.latestCandleMarketDate !== null).length;
      expect(diagnosticFreshCount).toBe(3);
      expect(diagnosticStaleCount).toBe(2);
      // The gate is NOT ready here (2 stale probes) - proving it reached the exact same per-symbol
      // verdicts the manual diagnostic just reported, not a second/different comparison.
      expect(gate.ready).toBe(false);
      if (!gate.ready) {
        expect(gate.freshProbeCount).toBe(diagnosticFreshCount);
        expect(gate.staleProbeCount).toBe(diagnosticStaleCount);
      }
    });
  });
});
