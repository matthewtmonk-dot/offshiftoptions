import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { hash } from "bcryptjs";
import { STARTER_LIVE_SCAN_UNIVERSE } from "@/domain/scanner/live-scan";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

// A different fixed test date than alpha-vantage-budget.integration.test.ts uses - Vitest runs
// test files in parallel by default, and AlphaVantageDailyUsage is a single global-by-date row,
// so two test files sharing one date would race on the same row across files.
const TEST_NOW = new Date("2099-06-15T12:00:00.000Z");
const TEST_DATE_ONLY = new Date("2099-06-15T00:00:00.000Z");

function fetchFnReturning(payload: unknown, status = 200) {
  return (async () => new Response(JSON.stringify(payload), { status })) as unknown as typeof fetch;
}

maybeDescribe("Alpha Vantage shared fundamentals cache and priority queue", () => {
  let prisma: typeof import("./prisma").prisma;
  let workflows: typeof import("./workflows");
  let fundamentals: typeof import("./alpha-vantage-fundamentals");
  let budget: typeof import("./alpha-vantage-budget");
  let userA: { id: string };
  let userB: { id: string };
  const userIds: string[] = [];
  const testTickers = ["ZZAV1", "ZZAV2", "ZZAV3", "ZZAV4", "ZZAV5"];

  beforeAll(async () => {
    process.env.ALPHA_VANTAGE_API_KEY = "test-key-for-integration-tests";
    prisma = (await import("./prisma")).prisma;
    workflows = await import("./workflows");
    fundamentals = await import("./alpha-vantage-fundamentals");
    budget = await import("./alpha-vantage-budget");

    const passwordHash = await hash("not-used", 4);
    const timestamp = Date.now();
    userA = await prisma.user.create({
      data: { name: "Fundamentals User A", email: `av-fund-a-${timestamp}@lst.local`, passwordHash },
      select: { id: true },
    });
    userB = await prisma.user.create({
      data: { name: "Fundamentals User B", email: `av-fund-b-${timestamp}@lst.local`, passwordHash },
      select: { id: true },
    });
    userIds.push(userA.id, userB.id);
  });

  afterEach(async () => {
    await prisma.tickerFundamentals.deleteMany({ where: { ticker: { in: testTickers } } });
    await prisma.watchlistItem.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.watchlist.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.scanResult.deleteMany({ where: { run: { ownerId: { in: userIds } } } });
    await prisma.scanRun.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.alphaVantageDailyUsage.deleteMany({ where: { date: TEST_DATE_ONLY } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("stores exactly one shared cache row per ticker, regardless of which user's research references it", async () => {
    await workflows.setResearchStatusForUser(userA.id, testTickers[0], "LIKE");
    await workflows.setResearchStatusForUser(userB.id, testTickers[0], "WATCH");

    const result = await fundamentals.refreshSingleTickerFundamentals(testTickers[0], {
      now: TEST_NOW,
      fetchFn: fetchFnReturning({ Symbol: testTickers[0], Name: "Shared Co", PERatio: "12.3" }),
    });
    expect(result.status).toBe("DONE");

    const rows = await prisma.tickerFundamentals.findMany({ where: { ticker: testTickers[0] } });
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("Shared Co");
  });

  it("collapses Matt+Eric researching the same ticker into one queue candidate entry", async () => {
    await workflows.setResearchStatusForUser(userA.id, testTickers[1], "LIKE");
    await workflows.setResearchStatusForUser(userB.id, testTickers[1], "LIKE");

    const candidates = await fundamentals.getFundamentalsQueueCandidates(TEST_NOW);
    const occurrences = candidates.filter((t) => t === testTickers[1]);
    expect(occurrences.length).toBe(1);
  });

  it("collapses a ticker appearing in both Research and a PASS scan result into one queue entry", async () => {
    await workflows.setResearchStatusForUser(userA.id, testTickers[2], "WATCH");
    const profile = await workflows.ensureMyLstScannerProfileForUser(userA.id);
    const run = await prisma.scanRun.create({ data: { profileId: profile.id, ownerId: userA.id, source: "DEMO" } });
    await prisma.scanResult.create({
      data: { runId: run.id, ticker: testTickers[2], summaryStatus: "PASS", passedCriteria: 8, totalCriteria: 8, snapshotJson: {} },
    });

    const candidates = await fundamentals.getFundamentalsQueueCandidates(TEST_NOW);
    expect(candidates.filter((t) => t === testTickers[2]).length).toBe(1);
  });

  it("never leaks which user (or research status) a queued ticker belongs to - only bare ticker strings are returned", async () => {
    await workflows.setResearchStatusForUser(userA.id, testTickers[3], "NEVER_TRADE");
    const candidates = await fundamentals.getFundamentalsQueueCandidates(TEST_NOW);
    expect(candidates).toContain(testTickers[3]);
    // The return type itself is string[] - there is no way for a user id, status, or note to
    // travel through this function; this assertion just documents that expectation concretely.
    expect(candidates.every((t) => typeof t === "string")).toBe(true);
  });

  it("excludes a ticker with fresh (non-stale) cached fundamentals from the queue", async () => {
    await workflows.setResearchStatusForUser(userA.id, testTickers[4], "LIKE");
    await prisma.tickerFundamentals.create({
      data: {
        ticker: testTickers[4],
        fetchedAt: TEST_NOW,
        staleAfter: new Date(TEST_NOW.getTime() + 24 * 60 * 60 * 1000),
        lastAttemptAt: TEST_NOW,
        lastAttemptStatus: "SUCCESS",
      },
    });

    const candidates = await fundamentals.getFundamentalsQueueCandidates(TEST_NOW);
    expect(candidates).not.toContain(testTickers[4]);
  });

  it("includes a ticker whose cached fundamentals have gone stale (past staleAfter)", async () => {
    await workflows.setResearchStatusForUser(userA.id, testTickers[4], "LIKE");
    await prisma.tickerFundamentals.create({
      data: {
        ticker: testTickers[4],
        fetchedAt: new Date(TEST_NOW.getTime() - 8 * 24 * 60 * 60 * 1000),
        staleAfter: new Date(TEST_NOW.getTime() - 24 * 60 * 60 * 1000),
        lastAttemptAt: new Date(TEST_NOW.getTime() - 8 * 24 * 60 * 60 * 1000),
        lastAttemptStatus: "SUCCESS",
      },
    });

    const candidates = await fundamentals.getFundamentalsQueueCandidates(TEST_NOW);
    expect(candidates).toContain(testTickers[4]);
  });

  it("normalizes None/-/empty-string sentinels to real NULL end-to-end, never 0", async () => {
    await fundamentals.refreshSingleTickerFundamentals(testTickers[0], {
      now: TEST_NOW,
      fetchFn: fetchFnReturning({ Symbol: testTickers[0], PEGRatio: "None", OperatingMarginTTM: "-", ReturnOnAssetsTTM: "" }),
    });

    const row = await prisma.tickerFundamentals.findUnique({ where: { ticker: testTickers[0] } });
    expect(row?.pegRatio).toBeNull();
    expect(row?.operatingMarginTtm).toBeNull();
    expect(row?.returnOnAssetsTtm).toBeNull();
  });

  it("preserves a real numeric 0 end-to-end, never collapsing it to null", async () => {
    await fundamentals.refreshSingleTickerFundamentals(testTickers[0], {
      now: TEST_NOW,
      fetchFn: fetchFnReturning({ Symbol: testTickers[0], DividendPerShare: "0", DividendYield: "0" }),
    });

    const row = await prisma.tickerFundamentals.findUnique({ where: { ticker: testTickers[0] } });
    expect(Number(row?.dividendPerShare)).toBe(0);
    expect(Number(row?.dividendYield)).toBe(0);
  });

  it("does not fabricate fundamentals for a failed (EMPTY) fetch - value fields stay null", async () => {
    const result = await fundamentals.refreshSingleTickerFundamentals(testTickers[0], {
      now: TEST_NOW,
      fetchFn: fetchFnReturning({}),
    });
    expect(result.status).toBe("DONE");

    const row = await prisma.tickerFundamentals.findUnique({ where: { ticker: testTickers[0] } });
    expect(row?.peRatio).toBeNull();
    expect(row?.name).toBeNull();
    expect(row?.fetchedAt).toBeNull();
    expect(row?.lastAttemptStatus).toBe("EMPTY");
  });

  it("stops the automatic queue immediately on a real throttle response, leaving later tickers untouched", async () => {
    await workflows.setResearchStatusForUser(userA.id, testTickers[0], "LIKE");
    await workflows.setResearchStatusForUser(userA.id, testTickers[1], "LIKE");

    const summary = await fundamentals.processAlphaVantageFundamentalsQueue({
      now: TEST_NOW,
      fetchFn: fetchFnReturning({ Information: "Please consider spreading out your free API requests more sparingly (1 request per second)." }),
    });

    expect(summary.stoppedReason).toBe("RATE_LIMITED");
    expect(summary.callsConsumed).toBe(1);

    const secondTickerRow = await prisma.tickerFundamentals.findUnique({ where: { ticker: testTickers[1] } });
    expect(secondTickerRow).toBeNull();
  });

  it("refuses to run the automatic queue at all once today's auto budget is already exhausted", async () => {
    await workflows.setResearchStatusForUser(userA.id, testTickers[0], "LIKE");
    await prisma.alphaVantageDailyUsage.create({ data: { date: TEST_DATE_ONLY, autoCount: 22, manualCount: 0 } });

    const summary = await fundamentals.processAlphaVantageFundamentalsQueue({
      now: TEST_NOW,
      fetchFn: fetchFnReturning({ Symbol: testTickers[0] }),
    });

    expect(summary.stoppedReason).toBe("BUDGET_EXHAUSTED");
    expect(summary.callsConsumed).toBe(0);
  });

  it("refuses to run a manual refresh at all once today's total budget is exhausted", async () => {
    await prisma.alphaVantageDailyUsage.create({ data: { date: TEST_DATE_ONLY, autoCount: 22, manualCount: 3 } });

    const result = await fundamentals.refreshSingleTickerFundamentals(testTickers[0], {
      now: TEST_NOW,
      force: true,
      fetchFn: fetchFnReturning({ Symbol: testTickers[0] }),
    });

    expect(result.status).toBe("BUDGET_EXHAUSTED");
  });

  it("refuses a manual refresh of already-fresh data without spending a call, unless forced", async () => {
    await prisma.tickerFundamentals.create({
      data: {
        ticker: testTickers[0],
        fetchedAt: TEST_NOW,
        staleAfter: new Date(TEST_NOW.getTime() + 24 * 60 * 60 * 1000),
        lastAttemptAt: TEST_NOW,
        lastAttemptStatus: "SUCCESS",
      },
    });

    const result = await fundamentals.refreshSingleTickerFundamentals(testTickers[0], { now: TEST_NOW });
    expect(result.status).toBe("ALREADY_FRESH");

    const usage = await (await import("./alpha-vantage-budget")).getAlphaVantageUsageToday(TEST_NOW);
    expect(usage.totalCount).toBe(0);
  });

  describe("Scanner Near reuse (canonical getNearMisses, not a second approximate definition)", () => {
    async function createScanResultWithCriterion(
      ticker: string,
      criterion: { actualValue: string | null; operator: string; desiredValue: unknown; status: "PASS" | "FAIL" | "UNKNOWN" },
    ) {
      const profile = await workflows.ensureMyLstScannerProfileForUser(userA.id);
      const run = await prisma.scanRun.create({ data: { profileId: profile.id, ownerId: userA.id, source: "DEMO" } });
      await prisma.scanResult.create({
        data: {
          runId: run.id,
          ticker,
          summaryStatus: "FAIL",
          passedCriteria: 7,
          totalCriteria: 8,
          snapshotJson: {},
          criterionResults: {
            create: {
              criterionName: "Stock Volume",
              actualValue: criterion.actualValue,
              operator: criterion.operator,
              desiredValue: JSON.stringify(criterion.desiredValue),
              status: criterion.status,
              explanation: "test fixture",
            },
          },
        },
      });
    }

    it("includes a ticker whose only failure is a genuine near-miss (gap <= 12%), matching Scanner's own definition", async () => {
      // GTE 40000 desired, actual 38000 -> gap = 2000/40000 = 5% <= 12% -> near, same as
      // getNearMisses() would report for a live scan with this exact shape.
      await createScanResultWithCriterion(testTickers[0], { actualValue: "38000", operator: "GTE", desiredValue: 40000, status: "FAIL" });

      const candidates = await fundamentals.getFundamentalsQueueCandidates(TEST_NOW);
      expect(candidates).toContain(testTickers[0]);
    });

    it("does not prioritize a ticker whose only failure is a far miss (gap > 12%)", async () => {
      // GTE 40000 desired, actual 5000 -> gap = 87.5%, nowhere near - Scanner would not count
      // this as a near miss either, so the queue must not treat it as high-priority.
      await createScanResultWithCriterion(testTickers[0], { actualValue: "5000", operator: "GTE", desiredValue: 40000, status: "FAIL" });

      const candidates = await fundamentals.getFundamentalsQueueCandidates(TEST_NOW);
      expect(candidates).not.toContain(testTickers[0]);
    });

    it("correctly reconstructs a BETWEEN-operator desiredValue as a real array (JSON.parse), not a stringified array", async () => {
      // Price BETWEEN [10, 50], actual 52 -> distance 2, span 40 -> gap 5% -> near. This only
      // works if desiredValue round-trips through JSON.parse correctly as [10, 50], not the
      // literal string "[10,50]" (Array.isArray would be false and this would wrongly report
      // "not near" via the non-BETWEEN numeric fallback).
      await createScanResultWithCriterion(testTickers[0], { actualValue: "52", operator: "BETWEEN", desiredValue: [10, 50], status: "FAIL" });

      const candidates = await fundamentals.getFundamentalsQueueCandidates(TEST_NOW);
      expect(candidates).toContain(testTickers[0]);
    });
  });

  describe("stale run lock recovery (never permanently deadlocks Alpha Vantage access)", () => {
    afterEach(async () => {
      await budget.releaseAlphaVantageRunLock(TEST_NOW);
    });

    it("a fresh lock held by another caller blocks the automatic queue processor", async () => {
      expect(await budget.tryAcquireAlphaVantageRunLock(TEST_NOW)).toBe(true);

      const summary = await fundamentals.processAlphaVantageFundamentalsQueue({
        now: TEST_NOW,
        fetchFn: fetchFnReturning({ Symbol: testTickers[0] }),
      });
      expect(summary.stoppedReason).toBe("LOCK_UNAVAILABLE");
      expect(summary.callsConsumed).toBe(0);
    });

    it("a stale lock (older than the timeout) can be reclaimed by the queue processor", async () => {
      await workflows.setResearchStatusForUser(userA.id, testTickers[0], "LIKE");
      // Simulate a crashed process that acquired the lock and never released it.
      expect(await budget.tryAcquireAlphaVantageRunLock(TEST_NOW)).toBe(true);
      await prisma.alphaVantageDailyUsage.update({
        where: { date: TEST_DATE_ONLY },
        data: { runningSince: new Date(TEST_NOW.getTime() - budget.ALPHA_VANTAGE_RUN_LOCK_STALE_AFTER_MS - 1000) },
      });

      const summary = await fundamentals.processAlphaVantageFundamentalsQueue({
        now: TEST_NOW,
        maxTickers: 1,
        fetchFn: fetchFnReturning({ Symbol: testTickers[0] }),
      });
      expect(summary.stoppedReason).not.toBe("LOCK_UNAVAILABLE");
      expect(summary.callsConsumed).toBe(1);
    });

    it("releases the run lock even when the provider call throws (network/provider failure)", async () => {
      await workflows.setResearchStatusForUser(userA.id, testTickers[0], "LIKE");
      const throwingFetch = (async () => {
        throw new Error("simulated network failure");
      }) as unknown as typeof fetch;

      await expect(fundamentals.processAlphaVantageFundamentalsQueue({ now: TEST_NOW, fetchFn: throwingFetch })).rejects.toThrow();

      expect(await budget.tryAcquireAlphaVantageRunLock(TEST_NOW)).toBe(true);
    });

    it("releases the run lock after a throttle response, not just on success", async () => {
      await workflows.setResearchStatusForUser(userA.id, testTickers[0], "LIKE");
      const summary = await fundamentals.processAlphaVantageFundamentalsQueue({
        now: TEST_NOW,
        fetchFn: fetchFnReturning({ Information: "Please consider spreading out your free API requests more sparingly (1 request per second)." }),
      });
      expect(summary.stoppedReason).toBe("RATE_LIMITED");

      expect(await budget.tryAcquireAlphaVantageRunLock(TEST_NOW)).toBe(true);
    });
  });

  describe("request-attempt counting (never refunded merely because nothing was saved)", () => {
    it("counts a RATE_LIMITED attempt toward the tracked auto budget - it is not refunded", async () => {
      await workflows.setResearchStatusForUser(userA.id, testTickers[0], "LIKE");
      await fundamentals.processAlphaVantageFundamentalsQueue({
        now: TEST_NOW,
        fetchFn: fetchFnReturning({ Information: "Please consider spreading out your free API requests more sparingly (1 request per second)." }),
      });

      const usage = await budget.getAlphaVantageUsageToday(TEST_NOW);
      expect(usage.autoCount).toBe(1);
    });

    it("counts an EMPTY/invalid-response manual refresh toward the tracked manual budget - it is not refunded", async () => {
      const result = await fundamentals.refreshSingleTickerFundamentals(testTickers[0], {
        now: TEST_NOW,
        fetchFn: fetchFnReturning({}),
      });
      expect(result.status).toBe("DONE");

      const usage = await budget.getAlphaVantageUsageToday(TEST_NOW);
      expect(usage.manualCount).toBe(1);
    });

    it("counts an HTTP error response toward the tracked budget - it is not refunded", async () => {
      await workflows.setResearchStatusForUser(userA.id, testTickers[0], "LIKE");
      await fundamentals.processAlphaVantageFundamentalsQueue({
        now: TEST_NOW,
        maxTickers: 1,
        fetchFn: fetchFnReturning({}, 500),
      });

      const usage = await budget.getAlphaVantageUsageToday(TEST_NOW);
      expect(usage.autoCount).toBe(1);
    });

    it("reserves the budget slot atomically before the outbound call is made, not after", async () => {
      let reservedCountAtCallTime = -1;
      const fetchFn = (async () => {
        reservedCountAtCallTime = (await budget.getAlphaVantageUsageToday(TEST_NOW)).autoCount;
        return new Response(JSON.stringify({ Symbol: testTickers[0] }), { status: 200 });
      }) as unknown as typeof fetch;

      await workflows.setResearchStatusForUser(userA.id, testTickers[0], "LIKE");
      await fundamentals.processAlphaVantageFundamentalsQueue({ now: TEST_NOW, maxTickers: 1, fetchFn });

      // The reservation already incremented autoCount to 1 by the time the outbound call fires.
      expect(reservedCountAtCallTime).toBe(1);
    });
  });

  describe("BALANCE_SHEET (Current Ratio) - endpoint-specific freshness, priority, and safety", () => {
    function balanceSheetPayload(overrides: Record<string, unknown> = {}) {
      return {
        symbol: testTickers[0],
        quarterlyReports: [{ fiscalDateEnding: "2026-06-30", ...overrides }],
      };
    }

    // These SUCCESS-value assertions target testTickers[0] directly via
    // refreshSingleTickerBalanceSheet rather than the priority queue, for the same reason the
    // pre-existing OVERVIEW value-assertion tests above use refreshSingleTickerFundamentals
    // instead of processAlphaVantageFundamentalsQueue: this local dev database has real
    // Matt/Eric seeded scan history, so the unscoped-by-design Research/Scanner-PASS candidate
    // queries (see getBalanceSheetQueueCandidates) are not guaranteed to order a specific test
    // ticker first, making maxTickers-limited queue runs non-deterministic about which ticker
    // actually gets fetched. Queue-level tests below (dedupe/priority/budget/lock/pacing) don't
    // have this problem since they assert on queue mechanics, not a specific ticker's value.

    it("stores Current Ratio, fiscal date, and independent BALANCE_SHEET freshness on a real SUCCESS", async () => {
      const result = await fundamentals.refreshSingleTickerBalanceSheet(testTickers[0], {
        now: TEST_NOW,
        fetchFn: fetchFnReturning(balanceSheetPayload({ totalCurrentAssets: "5000000", totalCurrentLiabilities: "2000000" })),
      });
      expect(result.status).toBe("DONE");

      const row = await prisma.tickerFundamentals.findUnique({ where: { ticker: testTickers[0] } });
      expect(Number(row?.balanceSheetCurrentRatio)).toBe(2.5);
      expect(row?.balanceSheetFiscalDateEnding?.toISOString().slice(0, 10)).toBe("2026-06-30");
      expect(row?.balanceSheetFetchedAt).not.toBeNull();
      expect(row?.balanceSheetStaleAfter).not.toBeNull();
      // Debt/Equity is never computed by this slice - stays null regardless of a SUCCESS balance sheet fetch.
      expect(row?.balanceSheetDebtToEquity).toBeNull();
    });

    it("treats a zero denominator as unavailable (null), never dividing by zero", async () => {
      await fundamentals.refreshSingleTickerBalanceSheet(testTickers[0], {
        now: TEST_NOW,
        fetchFn: fetchFnReturning(balanceSheetPayload({ totalCurrentAssets: "5000000", totalCurrentLiabilities: "0" })),
      });

      const row = await prisma.tickerFundamentals.findUnique({ where: { ticker: testTickers[0] } });
      expect(row?.balanceSheetCurrentRatio).toBeNull();
    });

    it("normalizes a None/missing quarterly field to null rather than a fabricated ratio", async () => {
      await fundamentals.refreshSingleTickerBalanceSheet(testTickers[0], {
        now: TEST_NOW,
        fetchFn: fetchFnReturning(balanceSheetPayload({ totalCurrentAssets: "None", totalCurrentLiabilities: "2000000" })),
      });

      const row = await prisma.tickerFundamentals.findUnique({ where: { ticker: testTickers[0] } });
      expect(row?.balanceSheetCurrentRatio).toBeNull();
    });

    it("does not fabricate a ratio when Alpha Vantage returns no quarterly reports at all (EMPTY)", async () => {
      await fundamentals.refreshSingleTickerBalanceSheet(testTickers[0], {
        now: TEST_NOW,
        fetchFn: fetchFnReturning({ symbol: testTickers[0], quarterlyReports: [] }),
      });

      const row = await prisma.tickerFundamentals.findUnique({ where: { ticker: testTickers[0] } });
      expect(row?.balanceSheetCurrentRatio).toBeNull();
      expect(row?.balanceSheetLastAttemptStatus).toBe("EMPTY");
    });

    it("tracks BALANCE_SHEET freshness independently from OVERVIEW - a fresh OVERVIEW row does not exempt BALANCE_SHEET from the queue", async () => {
      await workflows.setResearchStatusForUser(userA.id, testTickers[0], "LIKE");
      await prisma.tickerFundamentals.create({
        data: {
          ticker: testTickers[0],
          fetchedAt: TEST_NOW,
          staleAfter: new Date(TEST_NOW.getTime() + 24 * 60 * 60 * 1000), // OVERVIEW fresh
          // balanceSheetStaleAfter intentionally left unset (never fetched).
        },
      });

      const candidates = await fundamentals.getBalanceSheetQueueCandidates(TEST_NOW);
      expect(candidates).toContain(testTickers[0]);
    });

    it("excludes a ticker whose BALANCE_SHEET data is still fresh, even if OVERVIEW has gone stale", async () => {
      await workflows.setResearchStatusForUser(userA.id, testTickers[0], "LIKE");
      await prisma.tickerFundamentals.create({
        data: {
          ticker: testTickers[0],
          staleAfter: new Date(TEST_NOW.getTime() - 24 * 60 * 60 * 1000), // OVERVIEW stale
          balanceSheetStaleAfter: new Date(TEST_NOW.getTime() + 24 * 60 * 60 * 1000), // BALANCE_SHEET fresh
        },
      });

      const candidates = await fundamentals.getBalanceSheetQueueCandidates(TEST_NOW);
      expect(candidates).not.toContain(testTickers[0]);
    });

    it("collapses Matt+Eric researching the same ticker into one BALANCE_SHEET queue candidate entry", async () => {
      await workflows.setResearchStatusForUser(userA.id, testTickers[1], "LIKE");
      await workflows.setResearchStatusForUser(userB.id, testTickers[1], "WATCH");

      const candidates = await fundamentals.getBalanceSheetQueueCandidates(TEST_NOW);
      expect(candidates.filter((t) => t === testTickers[1]).length).toBe(1);
    });

    it("prioritizes Research tickers ahead of Scanner PASS candidates", async () => {
      await workflows.setResearchStatusForUser(userA.id, testTickers[2], "WATCH");
      const profile = await workflows.ensureMyLstScannerProfileForUser(userA.id);
      const run = await prisma.scanRun.create({ data: { profileId: profile.id, ownerId: userA.id, source: "DEMO" } });
      await prisma.scanResult.create({
        data: { runId: run.id, ticker: testTickers[3], summaryStatus: "PASS", passedCriteria: 8, totalCriteria: 8, snapshotJson: {} },
      });

      const candidates = await fundamentals.getBalanceSheetQueueCandidates(TEST_NOW);
      expect(candidates.indexOf(testTickers[2])).toBeLessThan(candidates.indexOf(testTickers[3]));
    });

    it("never includes the starter scanner universe or Scanner Near candidates - only Research and Scanner PASS", async () => {
      const candidates = await fundamentals.getBalanceSheetQueueCandidates(TEST_NOW);
      expect(candidates).not.toContain("AAPL"); // a plausible starter-universe ticker never queued here without Research/PASS backing
    });

    it("never leaks which user or research status a queued ticker belongs to - only bare ticker strings", async () => {
      await workflows.setResearchStatusForUser(userA.id, testTickers[3], "NEVER_TRADE");
      const candidates = await fundamentals.getBalanceSheetQueueCandidates(TEST_NOW);
      expect(candidates).toContain(testTickers[3]);
      expect(candidates.every((t) => typeof t === "string")).toBe(true);
    });

    it("shares the exact same daily budget as OVERVIEW - exhausting AUTO via OVERVIEW blocks BALANCE_SHEET too", async () => {
      await workflows.setResearchStatusForUser(userA.id, testTickers[0], "LIKE");
      await prisma.alphaVantageDailyUsage.create({ data: { date: TEST_DATE_ONLY, autoCount: 22, manualCount: 0 } });

      const summary = await fundamentals.processAlphaVantageBalanceSheetQueue({
        now: TEST_NOW,
        fetchFn: fetchFnReturning(balanceSheetPayload()),
      });
      expect(summary.stoppedReason).toBe("BUDGET_EXHAUSTED");
      expect(summary.callsConsumed).toBe(0);
    });

    it("respects the same global run lock as the OVERVIEW queue", async () => {
      expect(await budget.tryAcquireAlphaVantageRunLock(TEST_NOW)).toBe(true);
      try {
        await workflows.setResearchStatusForUser(userA.id, testTickers[0], "LIKE");
        const summary = await fundamentals.processAlphaVantageBalanceSheetQueue({
          now: TEST_NOW,
          fetchFn: fetchFnReturning(balanceSheetPayload()),
        });
        expect(summary.stoppedReason).toBe("LOCK_UNAVAILABLE");
        expect(summary.callsConsumed).toBe(0);
      } finally {
        await budget.releaseAlphaVantageRunLock(TEST_NOW);
      }
    });

    it("stops the BALANCE_SHEET queue immediately on a real throttle response, leaving later tickers untouched", async () => {
      await workflows.setResearchStatusForUser(userA.id, testTickers[0], "LIKE");
      await workflows.setResearchStatusForUser(userA.id, testTickers[1], "LIKE");

      const summary = await fundamentals.processAlphaVantageBalanceSheetQueue({
        now: TEST_NOW,
        fetchFn: fetchFnReturning({ Information: "Please consider spreading out your free API requests more sparingly (1 request per second)." }),
      });

      expect(summary.stoppedReason).toBe("RATE_LIMITED");
      expect(summary.callsConsumed).toBe(1);
      const secondTickerRow = await prisma.tickerFundamentals.findUnique({ where: { ticker: testTickers[1] } });
      expect(secondTickerRow?.balanceSheetFetchedAt ?? null).toBeNull();
    });
  });

  describe("Unified work queue (getUnifiedAlphaVantageWorkQueue / processAlphaVantageQueues) - fixes OVERVIEW/BALANCE_SHEET starvation", () => {
    // All ordering/dedup assertions below compare the RELATIVE position of the test's own
    // disposable fixture tickers, never the queue's total length or exact index numbers - this
    // local dev database has real Matt/Eric seeded Research/Scanner data that legitimately
    // appears in the same tiers, and asserting on absolute counts/positions would be flaky (see
    // the BALANCE_SHEET describe block above, where exactly this class of bug was found and
    // fixed earlier in this file). Comparing two known fixtures' relative order is robust
    // regardless of how much real data surrounds them.

    it("Research BALANCE_SHEET cannot be starved by Scanner-only OVERVIEW work - it is scheduled first", async () => {
      // testTickers[0]: Research, OVERVIEW already fresh, BALANCE_SHEET never fetched.
      await workflows.setResearchStatusForUser(userA.id, testTickers[0], "LIKE");
      await prisma.tickerFundamentals.create({
        data: { ticker: testTickers[0], fetchedAt: TEST_NOW, staleAfter: new Date(TEST_NOW.getTime() + 24 * 60 * 60 * 1000) },
      });

      // testTickers[1]: Scanner PASS only (not Research), nothing cached at all.
      const profile = await workflows.ensureMyLstScannerProfileForUser(userA.id);
      const run = await prisma.scanRun.create({ data: { profileId: profile.id, ownerId: userA.id, source: "DEMO" } });
      await prisma.scanResult.create({
        data: { runId: run.id, ticker: testTickers[1], summaryStatus: "PASS", passedCriteria: 8, totalCriteria: 8, snapshotJson: {} },
      });

      const items = await fundamentals.getUnifiedAlphaVantageWorkQueue(TEST_NOW);
      const researchBalanceSheetIndex = items.findIndex((item) => item.ticker === testTickers[0] && item.endpoint === "BALANCE_SHEET");
      const scannerOverviewIndex = items.findIndex((item) => item.ticker === testTickers[1] && item.endpoint === "OVERVIEW");

      expect(researchBalanceSheetIndex).toBeGreaterThanOrEqual(0);
      expect(scannerOverviewIndex).toBeGreaterThanOrEqual(0);
      expect(researchBalanceSheetIndex).toBeLessThan(scannerOverviewIndex);
      // Fresh OVERVIEW for testTickers[0] must not be re-queued.
      expect(items.some((item) => item.ticker === testTickers[0] && item.endpoint === "OVERVIEW")).toBe(false);
    });

    it("Research endpoint work outranks Scanner-only work even against the broad starter universe", async () => {
      // A Research ticker missing everything must sort ahead of the fixed starter universe
      // (Scanner's lowest-priority tier) for both endpoints it needs.
      await workflows.setResearchStatusForUser(userA.id, testTickers[0], "WATCH");

      const items = await fundamentals.getUnifiedAlphaVantageWorkQueue(TEST_NOW);
      const researchOverviewIndex = items.findIndex((item) => item.ticker === testTickers[0] && item.endpoint === "OVERVIEW");
      const starterIndices = items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.endpoint === "OVERVIEW" && (STARTER_LIVE_SCAN_UNIVERSE as string[]).includes(item.ticker) && item.ticker !== testTickers[0]);

      expect(researchOverviewIndex).toBeGreaterThanOrEqual(0);
      for (const { index } of starterIndices) {
        expect(researchOverviewIndex).toBeLessThan(index);
      }
    });

    it("fresh OVERVIEW + stale BALANCE_SHEET triggers only a BALANCE_SHEET item, never OVERVIEW", async () => {
      await workflows.setResearchStatusForUser(userA.id, testTickers[0], "LIKE");
      await prisma.tickerFundamentals.create({
        data: {
          ticker: testTickers[0],
          fetchedAt: TEST_NOW,
          staleAfter: new Date(TEST_NOW.getTime() + 24 * 60 * 60 * 1000), // OVERVIEW fresh
          balanceSheetStaleAfter: new Date(TEST_NOW.getTime() - 24 * 60 * 60 * 1000), // BALANCE_SHEET stale
        },
      });

      const items = await fundamentals.getUnifiedAlphaVantageWorkQueue(TEST_NOW);
      const forTicker = items.filter((item) => item.ticker === testTickers[0]);
      expect(forTicker).toEqual([{ ticker: testTickers[0], endpoint: "BALANCE_SHEET" }]);
    });

    it("stale OVERVIEW + fresh BALANCE_SHEET triggers only an OVERVIEW item, never BALANCE_SHEET", async () => {
      await workflows.setResearchStatusForUser(userA.id, testTickers[0], "LIKE");
      await prisma.tickerFundamentals.create({
        data: {
          ticker: testTickers[0],
          staleAfter: new Date(TEST_NOW.getTime() - 24 * 60 * 60 * 1000), // OVERVIEW stale
          balanceSheetFetchedAt: TEST_NOW,
          balanceSheetStaleAfter: new Date(TEST_NOW.getTime() + 24 * 60 * 60 * 1000), // BALANCE_SHEET fresh
        },
      });

      const items = await fundamentals.getUnifiedAlphaVantageWorkQueue(TEST_NOW);
      const forTicker = items.filter((item) => item.ticker === testTickers[0]);
      expect(forTicker).toEqual([{ ticker: testTickers[0], endpoint: "OVERVIEW" }]);
    });

    it("a Research ticker missing both endpoints queues both - legitimately up to two calls for one ticker", async () => {
      await workflows.setResearchStatusForUser(userA.id, testTickers[0], "LIKE");
      // No TickerFundamentals row at all - both endpoints missing.

      const items = await fundamentals.getUnifiedAlphaVantageWorkQueue(TEST_NOW);
      const forTicker = items.filter((item) => item.ticker === testTickers[0]);
      expect(forTicker).toEqual([
        { ticker: testTickers[0], endpoint: "OVERVIEW" },
        { ticker: testTickers[0], endpoint: "BALANCE_SHEET" },
      ]);
      // Each of these two items reserves its own AUTO budget slot when processed - proven
      // generically (regardless of which ticker) by the existing "reserves the budget slot
      // atomically" and per-outcome request-counting tests above, which apply unchanged since
      // processAlphaVantageQueues reserves via the exact same reserveAlphaVantageCall("AUTO", ...)
      // call per work item.
    });

    it("Matt and Eric researching the same ticker still dedupes to exactly one work item per endpoint", async () => {
      await workflows.setResearchStatusForUser(userA.id, testTickers[1], "LIKE");
      await workflows.setResearchStatusForUser(userB.id, testTickers[1], "WATCH");

      const items = await fundamentals.getUnifiedAlphaVantageWorkQueue(TEST_NOW);
      expect(items.filter((item) => item.ticker === testTickers[1] && item.endpoint === "OVERVIEW").length).toBe(1);
      expect(items.filter((item) => item.ticker === testTickers[1] && item.endpoint === "BALANCE_SHEET").length).toBe(1);
    });

    it("never leaks which user or research status a queued ticker belongs to - only bare ticker/endpoint pairs", async () => {
      await workflows.setResearchStatusForUser(userA.id, testTickers[0], "NEVER_TRADE");
      const items = await fundamentals.getUnifiedAlphaVantageWorkQueue(TEST_NOW);
      expect(items.every((item) => typeof item.ticker === "string" && (item.endpoint === "OVERVIEW" || item.endpoint === "BALANCE_SHEET"))).toBe(true);
    });

    it("total AUTO calls never exceed 22 - the unified processor refuses to run at all once exhausted, regardless of queue size", async () => {
      await workflows.setResearchStatusForUser(userA.id, testTickers[0], "LIKE");
      await prisma.alphaVantageDailyUsage.create({ data: { date: TEST_DATE_ONLY, autoCount: 22, manualCount: 0 } });

      const summary = await fundamentals.processAlphaVantageQueues({ now: TEST_NOW, fetchFn: fetchFnReturning({ Symbol: testTickers[0] }) });
      expect(summary.stoppedReason).toBe("BUDGET_EXHAUSTED");
      expect(summary.callsConsumed).toBe(0);
    });

    it("the 3-call manual reserve is never spent by the automatic unified queue", async () => {
      await workflows.setResearchStatusForUser(userA.id, testTickers[0], "LIKE");
      // AUTO already at its 22 cap; 3 MANUAL slots remain, but the automatic queue must never draw from them.
      await prisma.alphaVantageDailyUsage.create({ data: { date: TEST_DATE_ONLY, autoCount: 22, manualCount: 0 } });

      const summary = await fundamentals.processAlphaVantageQueues({ now: TEST_NOW, fetchFn: fetchFnReturning({ Symbol: testTickers[0] }) });
      expect(summary.stoppedReason).toBe("BUDGET_EXHAUSTED");

      const usage = await budget.getAlphaVantageUsageToday(TEST_NOW);
      expect(usage.manualCount).toBe(0);
      expect(usage.autoRemaining).toBe(0);
      expect(usage.totalRemaining).toBe(3);
    });

    it("respects the same global run lock as the single-endpoint queues - no separate lock for the unified queue", async () => {
      expect(await budget.tryAcquireAlphaVantageRunLock(TEST_NOW)).toBe(true);
      try {
        await workflows.setResearchStatusForUser(userA.id, testTickers[0], "LIKE");
        const summary = await fundamentals.processAlphaVantageQueues({ now: TEST_NOW, fetchFn: fetchFnReturning({ Symbol: testTickers[0] }) });
        expect(summary.stoppedReason).toBe("LOCK_UNAVAILABLE");
        expect(summary.callsConsumed).toBe(0);
      } finally {
        await budget.releaseAlphaVantageRunLock(TEST_NOW);
      }
    });

    it("stops the unified queue immediately on a real throttle response, same pacing/stop semantics as the single-endpoint queues", async () => {
      await workflows.setResearchStatusForUser(userA.id, testTickers[0], "LIKE");
      const summary = await fundamentals.processAlphaVantageQueues({
        now: TEST_NOW,
        fetchFn: fetchFnReturning({ Information: "Please consider spreading out your free API requests more sparingly (1 request per second)." }),
      });
      expect(summary.stoppedReason).toBe("RATE_LIMITED");
      expect(summary.callsConsumed).toBe(1);
    });

    it("reading cached fundamentals for Research display never makes an Alpha Vantage call or touches the daily budget", async () => {
      await fundamentals.getTickerFundamentalsMap([testTickers[0], testTickers[1]]);
      const usage = await budget.getAlphaVantageUsageToday(TEST_NOW);
      expect(usage.totalCount).toBe(0);
    });
  });
});
