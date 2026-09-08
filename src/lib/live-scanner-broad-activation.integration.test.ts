import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MarketDataProvider, MarketQuote, OptionContractSnapshot } from "@/providers/market-data/types";

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
});
