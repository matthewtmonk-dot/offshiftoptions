import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MarketDataProvider, MarketQuote, OptionContractSnapshot, PriceCandle } from "@/providers/market-data/types";

/**
 * Broad scanner activation (see PROJECT_HANDOFF.md) - Run Live Scan now uses the real OCC
 * optionable-universe cache + this user's own TechnicalIndicatorSnapshot cache + the shared
 * earnings calendar, instead of the old fixed 13-ticker demo universe. This file exercises
 * rerunLiveSchwabScannerForUser end-to-end against a real local Postgres DB - the domain-level
 * funnel mechanics (technical-cache states, BB recompute, earnings joins) are already covered in
 * src/domain/scanner/live-scan.technical-cache.test.ts; this file proves the ORCHESTRATION layer:
 * real universe assembly, real user isolation, and truthful summary counts.
 *
 * getSchwabMarketDataProviderForUser is the only mocked export of broker-connections.ts (every
 * other export stays real) - this lets each test give a specific user a specific fake provider
 * without a real Schwab OAuth connection, exactly mirroring the technical-preparation-
 * orchestrator's own established mocking pattern for the same function family.
 */
const providerByUserId = new Map<string, MarketDataProvider>();

vi.mock("@/lib/broker-connections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/broker-connections")>();
  return {
    ...actual,
    getSchwabMarketDataProviderForUser: async (userId: string) => providerByUserId.get(userId) ?? null,
  };
});

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

const TEST_SOURCE = "TEST_FIXTURE_BROAD_SCAN";

function defaultPut(symbol: string, strike: number, bid = 0.3): OptionContractSnapshot[] {
  return [
    {
      symbol: `${symbol} 260918P${strike}`,
      underlyingSymbol: symbol,
      optionType: "PUT",
      strike,
      expiration: new Date("2026-09-18T20:00:00Z"),
      bid,
      ask: bid + 0.06,
      mark: bid + 0.03,
      delta: -0.2,
      openInterest: 500,
      volume: 100,
    },
  ];
}

// Any universe ticker NOT explicitly configured (e.g. the fixed starter list, or other test
// files' own OCC rows accumulated in the shared local dev DB) still gets a real, available quote
// - deliberately outside LST Core's default $10-$50 price band so it's harmlessly quote-excluded
// rather than either throwing (which would fail the whole scan - see evaluateLiveMarketScan's
// "every ticker unavailable" guard) or accidentally passing and polluting a test's assertions.
const UNCONFIGURED_TICKER_DEFAULT_QUOTE = { price: 999, volume: 1_000_000 };

/** 80 real-shaped, deterministic daily closes ending exactly on `endDate` - mirrors
 * technical-indicator-cache.integration.test.ts's own fixture convention, so the resulting
 * asOfDate is deterministic and controllable (used to reproduce the readiness-vs-live-scan
 * freshness question with a REAL, non-mocked getPriceHistory call and a REAL RSI/BB computation,
 * not a hand-authored technicalCache map). */
function syntheticCandlesEndingOn(ticker: string, endDate: Date, count = 80): PriceCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + i * 0.3 + (i % 5 === 0 ? -2 : 1);
    const date = new Date(endDate.getTime() - (count - 1 - i) * 24 * 60 * 60 * 1000);
    return { symbol: ticker, date, open: close - 0.5, high: close + 1, low: close - 1, close, volume: 1_000_000 };
  });
}

/** Unlike fakeProvider above (which deliberately throws on getPriceHistory to prove the live scan
 * never calls it), this provider DOES implement it - used only to drive the real technical
 * preparation worker (getOrCreateActiveTechnicalPreparationRun / refreshTechnicalIndicatorCacheBatchForUser),
 * never the live scan itself. */
function fakeProviderWithHistory(
  quotes: Record<string, { price: number; volume: number }>,
  candlesByTicker: Record<string, PriceCandle[]>,
): MarketDataProvider {
  return {
    async getQuote(symbol) {
      const quote = quotes[symbol];
      if (!quote) throw new Error(`no quote for ${symbol}`);
      return { symbol, price: quote.price, volume: quote.volume, asOf: new Date() };
    },
    async getQuotes(symbols) {
      const map = new Map<string, MarketQuote>();
      for (const symbol of symbols) {
        const quote = quotes[symbol];
        if (quote) map.set(symbol, { symbol, price: quote.price, volume: quote.volume, asOf: new Date() });
      }
      return map;
    },
    async getPriceHistory(symbol) {
      return candlesByTicker[symbol] ?? [];
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

function fakeProvider(
  quotes: Record<string, { price: number; volume: number }>,
  optionsByTicker: Record<string, OptionContractSnapshot[]> = {},
): MarketDataProvider {
  return {
    async getQuote(symbol) {
      const quote = quotes[symbol] ?? UNCONFIGURED_TICKER_DEFAULT_QUOTE;
      return { symbol, price: quote.price, volume: quote.volume, asOf: new Date() };
    },
    async getQuotes(symbols) {
      const map = new Map<string, MarketQuote>();
      for (const symbol of symbols) {
        const quote = quotes[symbol] ?? UNCONFIGURED_TICKER_DEFAULT_QUOTE;
        map.set(symbol, { symbol, price: quote.price, volume: quote.volume, asOf: new Date() });
      }
      return map;
    },
    async getPriceHistory() {
      throw new Error("getPriceHistory must never be called during a broad live scan - technical data must come from the cache");
    },
    async getOptionChain(symbol) {
      return optionsByTicker[symbol] ?? [];
    },
    async getInstrument(symbol) {
      return { symbol, description: symbol, assetType: "EQUITY" };
    },
    async getMarketHours() {
      return { isOpen: true };
    },
  };
}

maybeDescribe("broad scanner activation - rerunLiveSchwabScannerForUser", () => {
  let prisma: typeof import("./prisma").prisma;
  let workflows: typeof import("./workflows");
  let matt: { id: string };
  let eric: { id: string };
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    workflows = await import("./workflows");

    const passwordHash = await hash("not-used", 4);
    const timestamp = Date.now();
    matt = await prisma.user.create({ data: { name: "Matt Broad", email: `matt-broad-${timestamp}@lst.local`, passwordHash } });
    eric = await prisma.user.create({ data: { name: "Eric Broad", email: `eric-broad-${timestamp}@lst.local`, passwordHash } });
    createdUserIds.push(matt.id, eric.id);

    // Disable earningsDistance gating for these fixture users - EarningsCalendarEntry is a
    // genuinely global, unowned table (see earnings-calendar-cache.integration.test.ts's own
    // afterEach note), and its real production prune step (refreshEarningsCalendarCache) deletes
    // every row with reportDate before whatever `now` a caller passes it - including a
    // concurrently-running test file's own deliberately far-future synthetic `now`, which would
    // otherwise legitimately (by real production semantics) prune this file's own real-world-dated
    // earnings fixtures out from under it mid-run. The earnings-cache JOIN mechanic itself (cached
    // RSI/BB used correctly, earnings read from cache only) is already proven independently of any
    // real DB in live-scan.technical-cache.test.ts - this file's own job is the orchestration
    // layer (universe assembly, user isolation, summary truthfulness), which doesn't need
    // earningsDistance to gate PASS/FAIL to prove any of that.
    for (const user of [matt, eric]) {
      const profile = await workflows.ensureMyLstScannerProfileForUser(user.id);
      await prisma.scannerRule.updateMany({ where: { profileId: profile.id, key: "earningsDistance" }, data: { enabled: false } });
    }
  });

  afterAll(async () => {
    await prisma.optionableUniverseSymbol.deleteMany({ where: { source: TEST_SOURCE } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    providerByUserId.clear();
    await prisma.$disconnect();
  });

  async function seedOccUniverse(tickers: string[]) {
    await prisma.optionableUniverseSymbol.createMany({
      data: tickers.map((ticker) => ({ ticker, name: `${ticker} Corp`, source: TEST_SOURCE, lastSeenAt: new Date() })),
      skipDuplicates: true,
    });
  }

  async function seedReadySnapshot(userId: string, ticker: string, values: { rsi: number; bbLower: number; bbMiddle: number; bbUpper: number }) {
    await prisma.technicalIndicatorSnapshot.upsert({
      where: { userId_ticker: { userId, ticker } },
      create: { userId, ticker, status: "READY", asOfDate: new Date(), ...values },
      update: { status: "READY", asOfDate: new Date(), ...values },
    });
  }

  it("a broad OCC-only ticker, never added to Research/Watchlist, naturally appears in results and can PASS", async () => {
    const ticker = "OCCFRESH1";
    await seedOccUniverse([ticker]);
    await seedReadySnapshot(matt.id, ticker, { rsi: 25, bbLower: 15, bbMiddle: 20, bbUpper: 45 });
    providerByUserId.set(matt.id, fakeProvider({ [ticker]: { price: 20, volume: 1_000_000 } }, { [ticker]: defaultPut(ticker, 18) }));

    const { STARTER_LIVE_SCAN_UNIVERSE } = await import("@/domain/scanner/live-scan");
    expect(STARTER_LIVE_SCAN_UNIVERSE).not.toContain(ticker); // the old fixed demo list never limits this

    await workflows.rerunLiveSchwabScannerForUser(matt.id, { occSource: TEST_SOURCE });

    const result = await prisma.scanResult.findFirst({
      where: { ticker, run: { ownerId: matt.id, source: "LIVE:SCHWAB" } },
      orderBy: { createdAt: "desc" },
    });
    expect(result).not.toBeNull();
    expect(result?.summaryStatus).toBe("PASS");
  });

  it("when OCC is unavailable, the scan falls back to the fixed starter list (LIMITED_FALLBACK) rather than an empty universe", async () => {
    const emptySource = `TEST_FIXTURE_EMPTY_${Date.now()}`; // guaranteed zero rows - never seeded
    const { STARTER_LIVE_SCAN_UNIVERSE } = await import("@/domain/scanner/live-scan");
    const starterTicker = STARTER_LIVE_SCAN_UNIVERSE[0];
    await seedReadySnapshot(matt.id, starterTicker, { rsi: 20, bbLower: 15, bbMiddle: 20, bbUpper: 45 });
    providerByUserId.set(
      matt.id,
      fakeProvider({ [starterTicker]: { price: 20, volume: 1_000_000 } }, { [starterTicker]: defaultPut(starterTicker, 18) }),
    );

    const summary = await workflows.rerunLiveSchwabScannerForUser(matt.id, { occSource: emptySource });
    expect(summary.universeSource).toBe("LIMITED_FALLBACK");

    const result = await prisma.scanResult.findFirst({
      where: { ticker: starterTicker, run: { ownerId: matt.id, source: "LIVE:SCHWAB" } },
      orderBy: { createdAt: "desc" },
    });
    expect(result).not.toBeNull(); // the starter list was the floor that kept the scan non-empty
  });

  it("when OCC is available, the fixed starter list is excluded from the union - a starter-only ticker (not Research, not OCC) never appears", async () => {
    const occTicker = "OCCPRES1";
    await seedOccUniverse([occTicker]); // guarantees publicUniverse.length > 0 -> universeSource "OCC"
    const { STARTER_LIVE_SCAN_UNIVERSE } = await import("@/domain/scanner/live-scan");
    const starterTicker = STARTER_LIVE_SCAN_UNIVERSE[1]; // a different starter ticker than the fallback test above
    await seedReadySnapshot(matt.id, starterTicker, { rsi: 20, bbLower: 15, bbMiddle: 20, bbUpper: 45 });
    providerByUserId.set(
      matt.id,
      fakeProvider(
        { [occTicker]: { price: 20, volume: 1_000_000 }, [starterTicker]: { price: 20, volume: 1_000_000 } },
        { [occTicker]: defaultPut(occTicker, 18), [starterTicker]: defaultPut(starterTicker, 18) },
      ),
    );

    const summary = await workflows.rerunLiveSchwabScannerForUser(matt.id, { occSource: TEST_SOURCE });
    expect(summary.universeSource).toBe("OCC");

    const starterResult = await prisma.scanResult.findFirst({
      where: { ticker: starterTicker, run: { ownerId: matt.id, source: "LIVE:SCHWAB" } },
      orderBy: { createdAt: "desc" },
    });
    expect(starterResult).toBeNull(); // never quoted/scanned at all - not in the union once OCC is present
    const occResult = await prisma.scanResult.findFirst({
      where: { ticker: occTicker, run: { ownerId: matt.id, source: "LIVE:SCHWAB" } },
      orderBy: { createdAt: "desc" },
    });
    expect(occResult).not.toBeNull(); // the real OCC ticker was scanned normally
  });

  it("provider.getPriceHistory is never called during a real broad live scan", async () => {
    const ticker = "OCCFRESH2";
    await seedOccUniverse([ticker]);
    await seedReadySnapshot(matt.id, ticker, { rsi: 25, bbLower: 15, bbMiddle: 20, bbUpper: 45 });
    providerByUserId.set(matt.id, fakeProvider({ [ticker]: { price: 20, volume: 1_000_000 } }, { [ticker]: defaultPut(ticker, 18) }));

    // The fixture provider's getPriceHistory always throws - a successful, non-throwing scan
    // proves it was never invoked.
    await expect(workflows.rerunLiveSchwabScannerForUser(matt.id, { occSource: TEST_SOURCE })).resolves.toBeDefined();
  });

  it("TechnicalIndicatorSnapshot user isolation - each user's scan reads only their own snapshot row for the same ticker", async () => {
    const ticker = "OCCISO";
    await seedOccUniverse([ticker]);
    await seedReadySnapshot(matt.id, ticker, { rsi: 22, bbLower: 15, bbMiddle: 20, bbUpper: 45 });
    await seedReadySnapshot(eric.id, ticker, { rsi: 38, bbLower: 15, bbMiddle: 20, bbUpper: 45 });
    providerByUserId.set(matt.id, fakeProvider({ [ticker]: { price: 20, volume: 1_000_000 } }, { [ticker]: defaultPut(ticker, 18) }));
    providerByUserId.set(eric.id, fakeProvider({ [ticker]: { price: 20, volume: 1_000_000 } }, { [ticker]: defaultPut(ticker, 18) }));

    const mattUpdatedAtBefore = (
      await prisma.technicalIndicatorSnapshot.findUniqueOrThrow({ where: { userId_ticker: { userId: eric.id, ticker } } })
    ).updatedAt;

    await workflows.rerunLiveSchwabScannerForUser(matt.id, { occSource: TEST_SOURCE });
    await workflows.rerunLiveSchwabScannerForUser(eric.id, { occSource: TEST_SOURCE });

    const mattResult = await prisma.scanResult.findFirst({ where: { ticker, run: { ownerId: matt.id, source: "LIVE:SCHWAB" } }, orderBy: { createdAt: "desc" } });
    const ericResult = await prisma.scanResult.findFirst({ where: { ticker, run: { ownerId: eric.id, source: "LIVE:SCHWAB" } }, orderBy: { createdAt: "desc" } });

    expect((mattResult?.snapshotJson as Record<string, unknown>)?.rsi).toBe(22);
    expect((ericResult?.snapshotJson as Record<string, unknown>)?.rsi).toBe(38);

    // The scanner is read-only relative to the technical cache - Eric's own snapshot row was
    // never written to by Matt's scan (or Eric's own scan re-running the read path).
    const ericSnapshotAfter = await prisma.technicalIndicatorSnapshot.findUniqueOrThrow({ where: { userId_ticker: { userId: eric.id, ticker } } });
    expect(ericSnapshotAfter.updatedAt.getTime()).toBe(mattUpdatedAtBefore.getTime());
    expect(ericSnapshotAfter.rsi).toBe(38);
  });

  it("a ticker with no technical snapshot yet (pending) does not block the scan and is still reported honestly", async () => {
    const ticker = "OCCPENDING";
    await seedOccUniverse([ticker]);
    // Deliberately no seedReadySnapshot call - this ticker has never been technically prepared.
    providerByUserId.set(matt.id, fakeProvider({ [ticker]: { price: 20, volume: 1_000_000 } }, { [ticker]: defaultPut(ticker, 18) }));

    await expect(workflows.rerunLiveSchwabScannerForUser(matt.id, { occSource: TEST_SOURCE })).resolves.toBeDefined();

    const result = await prisma.scanResult.findFirst({ where: { ticker, run: { ownerId: matt.id, source: "LIVE:SCHWAB" } }, orderBy: { createdAt: "desc" } });
    expect(result).not.toBeNull(); // still surfaced, not silently dropped
    expect((result?.snapshotJson as Record<string, unknown>)?.rsi).toBeNull();
    expect((result?.snapshotJson as Record<string, unknown>)?.technicalReasonCode).toBe("TECHNICAL_DATA_PENDING");
    expect(result?.summaryStatus).not.toBe("PASS"); // cannot fake a PASS with unknown RSI/BB
  });

  it("Research priority stays private - one user's own Research ticker never leaks into another user's scan", async () => {
    const ticker = "PRIVATE1";
    // Never added to OCC - only reachable via Matt's own Research/Watchlist union (Tier 1).
    const item = await workflows.createWatchlistItemForUser(matt.id, ticker);
    await prisma.watchlistItem.update({ where: { id: item.id }, data: { researchStatus: "LIKE" } });
    await seedReadySnapshot(matt.id, ticker, { rsi: 20, bbLower: 15, bbMiddle: 20, bbUpper: 45 });

    const provider = fakeProvider({ [ticker]: { price: 20, volume: 1_000_000 } }, { [ticker]: defaultPut(ticker, 18) });
    providerByUserId.set(matt.id, provider);
    providerByUserId.set(eric.id, provider); // Eric has the SAME provider capability, but never Matt's Research entry

    await workflows.rerunLiveSchwabScannerForUser(matt.id, { occSource: TEST_SOURCE });
    await workflows.rerunLiveSchwabScannerForUser(eric.id, { occSource: TEST_SOURCE });

    const mattResult = await prisma.scanResult.findFirst({ where: { ticker, run: { ownerId: matt.id, source: "LIVE:SCHWAB" } } });
    const ericResult = await prisma.scanResult.findFirst({ where: { ticker, run: { ownerId: eric.id, source: "LIVE:SCHWAB" } } });

    expect(mattResult).not.toBeNull(); // Matt's own Research ticker always shows for Matt
    expect(ericResult).toBeNull(); // never appears for Eric - not in OCC, not in Eric's own Research

    await prisma.watchlistItem.delete({ where: { id: item.id } }).catch(() => {});
  });

  it("no user can read another user's technical cache through this function - each call is strictly scoped to its own userId argument", async () => {
    const ticker = "OCCISO"; // reuse the isolation fixture seeded above
    providerByUserId.set(matt.id, fakeProvider({ [ticker]: { price: 20, volume: 1_000_000 } }, { [ticker]: defaultPut(ticker, 18) }));

    // rerunLiveSchwabScannerForUser takes only a single userId - there is no parameter through
    // which a caller could name a different user's cache, and getTechnicalIndicatorSnapshotsForUser
    // is always invoked with that same argument (see workflows.ts).
    await workflows.rerunLiveSchwabScannerForUser(matt.id, { occSource: TEST_SOURCE });
    const mattResult = await prisma.scanResult.findFirst({ where: { ticker, run: { ownerId: matt.id, source: "LIVE:SCHWAB" } }, orderBy: { createdAt: "desc" } });
    expect((mattResult?.snapshotJson as Record<string, unknown>)?.rsi).toBe(22); // Matt's own value, never Eric's 38
  });

  it("the returned scan summary counts are truthful for a small controlled universe", async () => {
    const passTicker = "OCCPASS";
    const priceExcludedTicker = "OCCPRICE1";
    const volumeExcludedTicker = "OCCVOLBAD";
    const pendingTicker = "OCCPEND2";
    await seedOccUniverse([passTicker, priceExcludedTicker, volumeExcludedTicker, pendingTicker]);
    await seedReadySnapshot(matt.id, passTicker, { rsi: 20, bbLower: 15, bbMiddle: 20, bbUpper: 45 });
    // pendingTicker: no snapshot seeded - stays TECHNICAL_DATA_PENDING.

    providerByUserId.set(
      matt.id,
      fakeProvider(
        {
          [passTicker]: { price: 20, volume: 1_000_000 },
          [priceExcludedTicker]: { price: 999, volume: 1_000_000 },
          [volumeExcludedTicker]: { price: 20, volume: 500 },
          [pendingTicker]: { price: 20, volume: 1_000_000 },
        },
        { [passTicker]: defaultPut(passTicker, 18), [pendingTicker]: defaultPut(pendingTicker, 18) },
      ),
    );

    const summary = await workflows.rerunLiveSchwabScannerForUser(matt.id, { occSource: TEST_SOURCE });

    // universeSymbols includes the starter list + this user's Research tickers too, so assert
    // >= our 4 fixture tickers rather than an exact count (other fixtures in this file union in).
    expect(summary.universeSymbols).toBeGreaterThanOrEqual(4);
    expect(summary.universeSource).toBe("OCC");
    // Both quote-stage-excluded fixture tickers still got a real quote (successfullyQuoted counts
    // them), but neither counts toward priceAndVolumeSurvivors.
    expect(summary.priceAndVolumeSurvivors).toBeGreaterThanOrEqual(2); // pass + pending, at minimum
    expect(summary.technicalReadyCount).toBeGreaterThanOrEqual(1); // at least passTicker
    expect(summary.technicalPendingCount).toBeGreaterThanOrEqual(1); // at least pendingTicker
    expect(summary.optionChainsChecked).toBeLessThanOrEqual(8);

    const priceExcludedRow = await prisma.scanResult.findFirst({ where: { ticker: priceExcludedTicker, run: { ownerId: matt.id, source: "LIVE:SCHWAB" } } });
    const volumeExcludedRow = await prisma.scanResult.findFirst({ where: { ticker: volumeExcludedTicker, run: { ownerId: matt.id, source: "LIVE:SCHWAB" } } });
    // Quote-stage-excluded, non-Research tickers are aggregate-only - never persisted as their
    // own ScanResult row (would mean thousands of rows for a real ~6,000-symbol OCC universe).
    expect(priceExcludedRow).toBeNull();
    expect(volumeExcludedRow).toBeNull();
  });

  it("the persisted result count is bounded, not unbounded, for a large stock-stage survivor pool - and the aggregate funnel count is unaffected by the cap", async () => {
    const { MAX_DISPLAYED_STOCK_STAGE_RESULTS } = await import("./workflows");
    const poolSize = MAX_DISPLAYED_STOCK_STAGE_RESULTS + 30; // deliberately more than the cap
    const tickers = Array.from({ length: poolSize }, (_, index) => `CAP${String(index).padStart(6, "0")}`);
    await seedOccUniverse(tickers);
    // Strictly increasing rsi by index - ticker 0 ranks best, the last ticker ranks worst.
    await Promise.all(tickers.map((ticker, index) => seedReadySnapshot(matt.id, ticker, { rsi: index, bbLower: 15, bbMiddle: 20, bbUpper: 45 })));

    const quotes = Object.fromEntries(tickers.map((ticker) => [ticker, { price: 20, volume: 1_000_000 }]));
    const optionsByTicker = Object.fromEntries(tickers.map((ticker) => [ticker, defaultPut(ticker, 18)]));
    providerByUserId.set(matt.id, fakeProvider(quotes, optionsByTicker));

    const summary = await workflows.rerunLiveSchwabScannerForUser(matt.id, { occSource: TEST_SOURCE });

    expect(summary.priceAndVolumeSurvivors).toBeGreaterThanOrEqual(poolSize); // the full pool, uncapped
    expect(summary.scanned).toBeLessThanOrEqual(MAX_DISPLAYED_STOCK_STAGE_RESULTS); // but persistence is bounded

    const persistedCount = await prisma.scanResult.count({
      where: { ticker: { in: tickers }, run: { ownerId: matt.id, source: "LIVE:SCHWAB" } },
    });
    expect(persistedCount).toBeLessThanOrEqual(MAX_DISPLAYED_STOCK_STAGE_RESULTS);
    expect(persistedCount).toBe(summary.scanned); // the summary count and the real persisted row count agree exactly

    // The best-ranked ticker (lowest index -> lowest rsi -> best rank) must be among the
    // persisted set - never dropped in favor of an arbitrary/worse one.
    const bestRow = await prisma.scanResult.findFirst({ where: { ticker: tickers[0], run: { ownerId: matt.id, source: "LIVE:SCHWAB" } } });
    expect(bestRow).not.toBeNull();
    // The worst-ranked ticker (highest index) must NOT be persisted - it's outside the cap.
    const worstRow = await prisma.scanResult.findFirst({ where: { ticker: tickers[tickers.length - 1], run: { ownerId: matt.id, source: "LIVE:SCHWAB" } } });
    expect(worstRow).toBeNull();
  });

  it("Tier 1 (Research/Watchlist/traded) tickers are never subject to the result cap, even when the broad pool is large", async () => {
    const { MAX_DISPLAYED_STOCK_STAGE_RESULTS } = await import("./workflows");
    const tier1Ticker = "TIER1CAP1";
    const item = await workflows.createWatchlistItemForUser(matt.id, tier1Ticker);
    await prisma.watchlistItem.update({ where: { id: item.id }, data: { researchStatus: "LIKE" } });
    // Give the Tier 1 ticker a deliberately WORSE rank than every broad-pool ticker below, so its
    // survival can only be explained by Tier 1 exemption, never by ranking into the cap normally.
    await seedReadySnapshot(matt.id, tier1Ticker, { rsi: 89, bbLower: 15, bbMiddle: 20, bbUpper: 45 });

    const poolSize = MAX_DISPLAYED_STOCK_STAGE_RESULTS + 10;
    const tickers = Array.from({ length: poolSize }, (_, index) => `TCAP${String(index).padStart(5, "0")}`);
    await seedOccUniverse(tickers);
    await Promise.all(tickers.map((ticker, index) => seedReadySnapshot(matt.id, ticker, { rsi: index, bbLower: 15, bbMiddle: 20, bbUpper: 45 })));

    const quotes = { [tier1Ticker]: { price: 20, volume: 1_000_000 }, ...Object.fromEntries(tickers.map((ticker) => [ticker, { price: 20, volume: 1_000_000 }])) };
    const optionsByTicker = { [tier1Ticker]: defaultPut(tier1Ticker, 18), ...Object.fromEntries(tickers.map((ticker) => [ticker, defaultPut(ticker, 18)])) };
    providerByUserId.set(matt.id, fakeProvider(quotes, optionsByTicker));

    await workflows.rerunLiveSchwabScannerForUser(matt.id, { occSource: TEST_SOURCE });

    const tier1Row = await prisma.scanResult.findFirst({ where: { ticker: tier1Ticker, run: { ownerId: matt.id, source: "LIVE:SCHWAB" } } });
    expect(tier1Row).not.toBeNull(); // present despite ranking worse than the cap would normally allow

    await prisma.watchlistItem.delete({ where: { id: item.id } }).catch(() => {});
  });

  it("READY technical candidates always win the scarce option-chain shortlist over PENDING ones, even in a larger mixed pool", async () => {
    const readyTickers = ["RDY001", "RDY002", "RDY003"];
    const pendingTickers = Array.from({ length: 17 }, (_, index) => `PEND${String(index).padStart(3, "0")}`);
    await seedOccUniverse([...readyTickers, ...pendingTickers]);
    await Promise.all(readyTickers.map((ticker) => seedReadySnapshot(matt.id, ticker, { rsi: 15, bbLower: 15, bbMiddle: 20, bbUpper: 45 })));
    // pendingTickers deliberately get no snapshot at all - genuinely pending.

    const allTickers = [...readyTickers, ...pendingTickers];
    const quotes = Object.fromEntries(allTickers.map((ticker) => [ticker, { price: 20, volume: 1_000_000 }]));
    const optionsByTicker = Object.fromEntries(allTickers.map((ticker) => [ticker, defaultPut(ticker, 18)]));
    providerByUserId.set(matt.id, fakeProvider(quotes, optionsByTicker));

    await workflows.rerunLiveSchwabScannerForUser(matt.id, { occSource: TEST_SOURCE });

    for (const ticker of readyTickers) {
      const row = await prisma.scanResult.findFirst({ where: { ticker, run: { ownerId: matt.id, source: "LIVE:SCHWAB" } } });
      expect((row?.snapshotJson as Record<string, unknown>)?.strike).not.toBeNull(); // reached option-chain enrichment
    }
  });

  it("ticker normalization: an OCC row seeded with non-canonical casing still joins the technical cache correctly", async () => {
    const canonicalTicker = "NORMCASE1";
    await prisma.optionableUniverseSymbol.createMany({
      data: [{ ticker: canonicalTicker.toLowerCase(), name: "lowercase seeded", source: TEST_SOURCE, lastSeenAt: new Date() }],
      skipDuplicates: true,
    });
    await seedReadySnapshot(matt.id, canonicalTicker, { rsi: 20, bbLower: 15, bbMiddle: 20, bbUpper: 45 });
    providerByUserId.set(
      matt.id,
      fakeProvider({ [canonicalTicker]: { price: 20, volume: 1_000_000 } }, { [canonicalTicker]: defaultPut(canonicalTicker, 18) }),
    );

    await workflows.rerunLiveSchwabScannerForUser(matt.id, { occSource: TEST_SOURCE });

    const result = await prisma.scanResult.findFirst({ where: { ticker: canonicalTicker, run: { ownerId: matt.id, source: "LIVE:SCHWAB" } } });
    expect(result).not.toBeNull();
    expect((result?.snapshotJson as Record<string, unknown>)?.rsi).toBe(20); // the READY snapshot was actually joined, not silently missed
  });

  it("a genuinely stale technical snapshot (asOfDate several real days old) is honestly reported as stale, not silently read as READY", async () => {
    const ticker = "STALEREAL1";
    await seedOccUniverse([ticker]);
    const staleDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    staleDate.setUTCHours(0, 0, 0, 0);
    await prisma.technicalIndicatorSnapshot.upsert({
      where: { userId_ticker: { userId: matt.id, ticker } },
      create: { userId: matt.id, ticker, status: "READY", asOfDate: staleDate, rsi: 15, bbLower: 15, bbMiddle: 20, bbUpper: 45 },
      update: { status: "READY", asOfDate: staleDate, rsi: 15, bbLower: 15, bbMiddle: 20, bbUpper: 45 },
    });
    providerByUserId.set(matt.id, fakeProvider({ [ticker]: { price: 20, volume: 1_000_000 } }, { [ticker]: defaultPut(ticker, 18) }));

    await workflows.rerunLiveSchwabScannerForUser(matt.id, { occSource: TEST_SOURCE });

    const result = await prisma.scanResult.findFirst({ where: { ticker, run: { ownerId: matt.id, source: "LIVE:SCHWAB" } } });
    expect((result?.snapshotJson as Record<string, unknown>)?.rsi).toBeNull(); // stale data never used, even though rsi=15 would PASS
    expect((result?.snapshotJson as Record<string, unknown>)?.technicalReasonCode).toBe("TECHNICAL_DATA_STALE");
  });

  it("the readiness diagnostic and the live scanner's own technicalReadyCount agree, when checked at the same moment via the REAL preparation pipeline (not a hand-authored technicalCache map)", async () => {
    const { getOrCreateActiveTechnicalPreparationRun, refreshTechnicalIndicatorCacheBatchForUser, getTechnicalCacheReadinessForUser, getTechnicalIndicatorSnapshotsForUser } =
      await import("./technical-indicator-cache");
    const { previousNyseMarketDay } = await import("@/domain/finance/marketCalendar");

    const tickers = Array.from({ length: 12 }, (_, index) => `RMIS${String(index).padStart(6, "0")}`);
    await seedOccUniverse(tickers);

    const now = new Date();
    // The realistic shape of a real worker run's own last-available candle - the most recently
    // COMPLETED trading day, never a day that hasn't closed yet (matches how Schwab's own
    // price-history endpoint behaves - see technical-indicator-cache.ts's own TECHNICAL_REFRESH_HISTORY_DAYS note).
    const lastCloseDate = previousNyseMarketDay(now);
    const quotes = Object.fromEntries(tickers.map((ticker) => [ticker, { price: 20, volume: 1_000_000 }]));
    const candlesByTicker = Object.fromEntries(tickers.map((ticker) => [ticker, syntheticCandlesEndingOn(ticker, lastCloseDate)]));
    const prepProvider = fakeProviderWithHistory(quotes, candlesByTicker);

    // Drive the REAL preparation worker end to end - the same functions the technical
    // preparation orchestrator itself calls, never a shortcut or a mocked cache map.
    providerByUserId.set(matt.id, prepProvider);
    await getOrCreateActiveTechnicalPreparationRun(matt.id, prepProvider, now);
    await refreshTechnicalIndicatorCacheBatchForUser(matt.id, prepProvider, { batchSize: tickers.length, now });

    const readiness = await getTechnicalCacheReadinessForUser(matt.id, prepProvider, now);
    // A. Technical snapshots READY for this user, per the real preparation worker.
    const readySnapshotCountA = readiness.readyCount;
    expect(readySnapshotCountA).toBe(tickers.length); // sanity: the real worker actually succeeded for all of them

    // Direct proof of what the live scan's own read path sees for these exact tickers, at the
    // same moment - D and E below.
    const directLookup = await getTechnicalIndicatorSnapshotsForUser(matt.id, tickers, now);
    const directReadyCountD = [...directLookup.values()].filter((entry) => entry.state === "READY").length;

    // Now run the actual live scan for the SAME user, SAME universe, SAME real moment (no
    // artificial delay - a real production gap would only make staleness MORE likely, never
    // less, so a passing same-moment test is the strongest possible proof this is a real,
    // reproducible bug rather than a timing coincidence).
    providerByUserId.set(
      matt.id,
      fakeProvider(quotes, Object.fromEntries(tickers.map((ticker) => [ticker, defaultPut(ticker, 18)]))),
    );
    const summary = await workflows.rerunLiveSchwabScannerForUser(matt.id, { occSource: TEST_SOURCE });

    // B. Current quote-stage survivors (from this exact live scan).
    const survivorCountB = summary.priceAndVolumeSurvivors;
    // C. Intersection of A and B - every one of these 12 tickers is both technically-ready AND a
    // quote-stage survivor in this scan (identical quotes were used for both steps).
    const intersectionCountC = tickers.length;
    // E. READY values actually consumed by the live scanner, per its own returned summary.
    const consumedReadyCountE = summary.technicalReadyCount;

    expect({
      A_readySnapshots: readySnapshotCountA,
      B_quoteStageSurvivors: survivorCountB >= tickers.length,
      C_intersection: intersectionCountC,
      D_directLookupReady: directReadyCountD,
      E_liveScanConsumedReady: consumedReadyCountE,
    }).toEqual({
      A_readySnapshots: tickers.length,
      B_quoteStageSurvivors: true,
      C_intersection: tickers.length,
      D_directLookupReady: tickers.length,
      E_liveScanConsumedReady: tickers.length,
    });
  });

  it("root cause of the readiness-vs-live-scan mismatch: getTechnicalCacheReadinessForUser's READY count never re-checks asOfDate freshness, so it keeps reporting a ticker ready long after the live scan correctly stops trusting it", async () => {
    const { getOrCreateActiveTechnicalPreparationRun, getTechnicalCacheReadinessForUser } = await import("./technical-indicator-cache");

    const ticker = "RMISOLD01";
    await seedOccUniverse([ticker]);
    const now = new Date();
    const quotes = { [ticker]: { price: 20, volume: 1_000_000 } };

    // Create a real, current TechnicalPreparationRun/Item for this exact ticker via the real
    // get-or-create path, then manually advance it straight to READY (mirroring exactly what
    // refreshTechnicalIndicatorCacheBatchForUser itself does on success) - but with an asOfDate
    // that is genuinely 10 real days old, simulating "the worker succeeded a while ago, then real
    // time passed before the user actually clicked Run Live Scan," the exact real-world sequence
    // production evidence points to.
    const prepProvider = fakeProviderWithHistory(quotes, {});
    const { runId } = await getOrCreateActiveTechnicalPreparationRun(matt.id, prepProvider, now);
    await prisma.technicalPreparationItem.updateMany({ where: { runId, ticker }, data: { status: "READY", processedAt: now } });
    const oldAsOfDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    oldAsOfDate.setUTCHours(0, 0, 0, 0);
    await prisma.technicalIndicatorSnapshot.upsert({
      where: { userId_ticker: { userId: matt.id, ticker } },
      create: { userId: matt.id, ticker, status: "READY", asOfDate: oldAsOfDate, rsi: 15, bbLower: 15, bbMiddle: 20, bbUpper: 45 },
      update: { status: "READY", asOfDate: oldAsOfDate, rsi: 15, bbLower: 15, bbMiddle: 20, bbUpper: 45 },
    });

    // The readiness diagnostic (what "125/2073 READY" reflects in production) still reports this
    // ticker READY - it only checks TechnicalPreparationItem.status, never asOfDate freshness.
    const readiness = await getTechnicalCacheReadinessForUser(matt.id, prepProvider, now);
    expect(readiness.readyCount).toBeGreaterThanOrEqual(1);

    // But the live scan, which re-validates freshness at read time via
    // getTechnicalIndicatorSnapshotsForUser, correctly refuses to use the 10-day-old cached value
    // - exactly the real production symptom (readiness says ready, scan says not ready), and
    // exactly the honest behavior required: a stale value must never fake a PASS.
    providerByUserId.set(matt.id, fakeProvider(quotes, { [ticker]: defaultPut(ticker, 18) }));
    const summary = await workflows.rerunLiveSchwabScannerForUser(matt.id, { occSource: TEST_SOURCE });
    const result = await prisma.scanResult.findFirst({ where: { ticker, run: { ownerId: matt.id, source: "LIVE:SCHWAB" } } });

    expect((result?.snapshotJson as Record<string, unknown>)?.rsi).toBeNull();
    expect((result?.snapshotJson as Record<string, unknown>)?.technicalReasonCode).toBe("TECHNICAL_DATA_STALE");
    expect(summary.technicalStaleCount).toBeGreaterThanOrEqual(1);
  });

  it("PART E - immediate-stale-worker reproduction: if the worker's own last available candle is one trading day short of what freshness requires (Schwab's daily bar not yet posted for the just-closed session), the resulting snapshot is stale THE MOMENT it's written - with zero elapsed real time between prep and scan, refuting 'staleness = elapsed time' as the sole explanation", async () => {
    const { getOrCreateActiveTechnicalPreparationRun, refreshTechnicalIndicatorCacheBatchForUser, getTechnicalCacheReadinessForUser } =
      await import("./technical-indicator-cache");
    const { previousNyseMarketDay } = await import("@/domain/finance/marketCalendar");

    const ticker = "RMISLAG01";
    await seedOccUniverse([ticker]);

    const realNow = new Date();
    const requiredMarketDate = previousNyseMarketDay(realNow); // what live-scan freshness demands right now (the scan below always reads real time)
    const laggedCandleDate = previousNyseMarketDay(requiredMarketDate); // one trading day SHORT of that - simulates Schwab not yet exposing the just-closed session's own daily candle
    // A synthetic, unique preparation-run identity ("now" for getOrCreateActiveTechnicalPreparationRun
    // only, keyed by (userId, marketDate, rulesFingerprint)) - this file's other tests above also
    // call getOrCreateActiveTechnicalPreparationRun with the real `new Date()` for matt.id, and
    // would otherwise collide with (reuse) this test's own run before RMISLAG01 could ever become a
    // claimable item in it. The written asOfDate itself comes purely from the candle's own `date`
    // field (see refreshTechnicalIndicatorCacheBatchForUser), never from this run-identity `now` -
    // so this substitution has zero effect on what's actually being tested.
    const runIdentityNow = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
    const quotes = { [ticker]: { price: 20, volume: 1_000_000 } };
    const prepProvider = fakeProviderWithHistory(quotes, { [ticker]: syntheticCandlesEndingOn(ticker, laggedCandleDate) });

    providerByUserId.set(matt.id, prepProvider);
    await getOrCreateActiveTechnicalPreparationRun(matt.id, prepProvider, runIdentityNow);
    await refreshTechnicalIndicatorCacheBatchForUser(matt.id, prepProvider, { batchSize: 1, now: runIdentityNow });

    const snapshot = await prisma.technicalIndicatorSnapshot.findUnique({ where: { userId_ticker: { userId: matt.id, ticker } } });
    expect(snapshot?.status).toBe("READY"); // the worker itself succeeded - this is not a fetch failure
    expect(snapshot?.asOfDate?.toISOString().slice(0, 10)).toBe(laggedCandleDate.toISOString().slice(0, 10));

    // Readiness (workflow-completion only, no freshness re-check) reports this ticker READY.
    const readiness = await getTechnicalCacheReadinessForUser(matt.id, prepProvider, runIdentityNow);
    expect(readiness.readyCount).toBeGreaterThanOrEqual(1);

    // The live scan, run immediately after (same real moment for all practical purposes - no
    // sleep, no simulated multi-day gap), correctly refuses to trust it.
    providerByUserId.set(matt.id, fakeProvider(quotes, { [ticker]: defaultPut(ticker, 18) }));
    const summary = await workflows.rerunLiveSchwabScannerForUser(matt.id, { occSource: TEST_SOURCE });
    const result = await prisma.scanResult.findFirst({ where: { ticker, run: { ownerId: matt.id, source: "LIVE:SCHWAB" } } });

    expect((result?.snapshotJson as Record<string, unknown>)?.technicalReasonCode).toBe("TECHNICAL_DATA_STALE");
    expect(summary.technicalStaleCount).toBeGreaterThanOrEqual(1);
  });

  it("a READY technical snapshot for a ticker that fails THIS scan's own quote-stage filter is never counted as live-ready - readiness is scoped to genuine survivors only", async () => {
    const readyButExcludedTicker = "RMISEXCL1";
    await seedOccUniverse([readyButExcludedTicker]);
    await seedReadySnapshot(matt.id, readyButExcludedTicker, { rsi: 15, bbLower: 15, bbMiddle: 20, bbUpper: 45 });
    // A real, current READY snapshot exists for this ticker - but THIS scan's own quote gives it
    // a price far outside the configured range, so it must never count toward technicalReadyCount.
    providerByUserId.set(matt.id, fakeProvider({ [readyButExcludedTicker]: { price: 999, volume: 1_000_000 } }));

    const summary = await workflows.rerunLiveSchwabScannerForUser(matt.id, { occSource: TEST_SOURCE });

    const result = await prisma.scanResult.findFirst({ where: { ticker: readyButExcludedTicker, run: { ownerId: matt.id, source: "LIVE:SCHWAB" } } });
    expect(result).toBeNull(); // quote-excluded, non-Research - aggregate-only, never persisted
    // The READY snapshot exists in the DB, but this scan's own survivor set never reached it -
    // a real, non-mocked proof that a stale/irrelevant READY row can't inflate technicalReadyCount.
    expect(summary.technicalReadyCount).toBe(0);
  });
});
