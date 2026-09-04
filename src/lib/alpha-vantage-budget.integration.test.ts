import { afterEach, beforeAll, describe, expect, it } from "vitest";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

// A fixed, far-future test date isolates these tests from any real "today" tracked usage and
// from each other's runs within this file (cleaned up in afterEach). Any other test file that
// touches AlphaVantageDailyUsage MUST use a different date - Vitest runs test files in
// parallel by default, and this table is a single global-by-date row, not per-test-file.
const TEST_NOW = new Date("2099-01-01T12:00:00.000Z");
const TEST_DATE_ONLY = new Date("2099-01-01T00:00:00.000Z");

maybeDescribe("Alpha Vantage daily budget - atomic reservation and concurrency safety", () => {
  let prisma: typeof import("./prisma").prisma;
  let reserveAlphaVantageCall: typeof import("./alpha-vantage-budget").reserveAlphaVantageCall;
  let getAlphaVantageUsageToday: typeof import("./alpha-vantage-budget").getAlphaVantageUsageToday;
  let tryAcquireAlphaVantageRunLock: typeof import("./alpha-vantage-budget").tryAcquireAlphaVantageRunLock;
  let releaseAlphaVantageRunLock: typeof import("./alpha-vantage-budget").releaseAlphaVantageRunLock;
  let ALPHA_VANTAGE_AUTO_DAILY_LIMIT: number;
  let ALPHA_VANTAGE_TOTAL_DAILY_LIMIT: number;

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    const budget = await import("./alpha-vantage-budget");
    reserveAlphaVantageCall = budget.reserveAlphaVantageCall;
    getAlphaVantageUsageToday = budget.getAlphaVantageUsageToday;
    tryAcquireAlphaVantageRunLock = budget.tryAcquireAlphaVantageRunLock;
    releaseAlphaVantageRunLock = budget.releaseAlphaVantageRunLock;
    ALPHA_VANTAGE_AUTO_DAILY_LIMIT = budget.ALPHA_VANTAGE_AUTO_DAILY_LIMIT;
    ALPHA_VANTAGE_TOTAL_DAILY_LIMIT = budget.ALPHA_VANTAGE_TOTAL_DAILY_LIMIT;
  });

  afterEach(async () => {
    await prisma.alphaVantageDailyUsage.deleteMany({ where: { date: TEST_DATE_ONLY } });
  });

  it("allows exactly ALPHA_VANTAGE_AUTO_DAILY_LIMIT (22) auto reservations, then refuses the next", async () => {
    for (let i = 0; i < ALPHA_VANTAGE_AUTO_DAILY_LIMIT; i++) {
      const result = await reserveAlphaVantageCall("AUTO", TEST_NOW);
      expect(result.reserved).toBe(true);
    }
    const overLimit = await reserveAlphaVantageCall("AUTO", TEST_NOW);
    expect(overLimit.reserved).toBe(false);
    expect(overLimit.usage.autoCount).toBe(ALPHA_VANTAGE_AUTO_DAILY_LIMIT);
  });

  it("reserves the 3-call manual reserve even after auto has used its full 22, up to the shared 25 total", async () => {
    for (let i = 0; i < ALPHA_VANTAGE_AUTO_DAILY_LIMIT; i++) {
      await reserveAlphaVantageCall("AUTO", TEST_NOW);
    }
    for (let i = 0; i < ALPHA_VANTAGE_TOTAL_DAILY_LIMIT - ALPHA_VANTAGE_AUTO_DAILY_LIMIT; i++) {
      const result = await reserveAlphaVantageCall("MANUAL", TEST_NOW);
      expect(result.reserved).toBe(true);
    }
    const overTotal = await reserveAlphaVantageCall("MANUAL", TEST_NOW);
    expect(overTotal.reserved).toBe(false);

    const usage = await getAlphaVantageUsageToday(TEST_NOW);
    expect(usage.totalCount).toBe(ALPHA_VANTAGE_TOTAL_DAILY_LIMIT);
    expect(usage.autoCount).toBe(ALPHA_VANTAGE_AUTO_DAILY_LIMIT);
  });

  it("never lets the automatic queue exceed its 22 cap even if manual has used none of its reserve", async () => {
    for (let i = 0; i < ALPHA_VANTAGE_AUTO_DAILY_LIMIT; i++) {
      await reserveAlphaVantageCall("AUTO", TEST_NOW);
    }
    const stillOverAutoCap = await reserveAlphaVantageCall("AUTO", TEST_NOW);
    expect(stillOverAutoCap.reserved).toBe(false);
    // The 3-call reserve is still fully available to manual.
    const manual = await reserveAlphaVantageCall("MANUAL", TEST_NOW);
    expect(manual.reserved).toBe(true);
  });

  it("never overspends the auto budget under concurrent reservations racing for the last slot", async () => {
    for (let i = 0; i < ALPHA_VANTAGE_AUTO_DAILY_LIMIT - 1; i++) {
      await reserveAlphaVantageCall("AUTO", TEST_NOW);
    }
    // Exactly 1 slot remains; fire 5 concurrent reservations at it.
    const results = await Promise.all(Array.from({ length: 5 }, () => reserveAlphaVantageCall("AUTO", TEST_NOW)));
    const succeeded = results.filter((r) => r.reserved);
    expect(succeeded.length).toBe(1);

    const usage = await getAlphaVantageUsageToday(TEST_NOW);
    expect(usage.autoCount).toBe(ALPHA_VANTAGE_AUTO_DAILY_LIMIT);
  });

  it("never overspends the shared total budget under concurrent mixed auto/manual reservations", async () => {
    for (let i = 0; i < ALPHA_VANTAGE_TOTAL_DAILY_LIMIT - 1; i++) {
      await reserveAlphaVantageCall(i % 2 === 0 ? "AUTO" : "MANUAL", TEST_NOW);
    }
    const results = await Promise.all([
      reserveAlphaVantageCall("MANUAL", TEST_NOW),
      reserveAlphaVantageCall("MANUAL", TEST_NOW),
      reserveAlphaVantageCall("MANUAL", TEST_NOW),
    ]);
    const succeeded = results.filter((r) => r.reserved);
    expect(succeeded.length).toBe(1);

    const usage = await getAlphaVantageUsageToday(TEST_NOW);
    expect(usage.totalCount).toBe(ALPHA_VANTAGE_TOTAL_DAILY_LIMIT);
  });

  it("reports zero usage for a day with no reservations", async () => {
    const usage = await getAlphaVantageUsageToday(TEST_NOW);
    expect(usage).toMatchObject({ autoCount: 0, manualCount: 0, totalCount: 0 });
  });

  describe("single-flight run lock", () => {
    afterEach(async () => {
      await releaseAlphaVantageRunLock(TEST_NOW);
    });

    it("allows only one acquire to succeed while the lock is held", async () => {
      const first = await tryAcquireAlphaVantageRunLock(TEST_NOW);
      expect(first).toBe(true);
      const second = await tryAcquireAlphaVantageRunLock(TEST_NOW);
      expect(second).toBe(false);
    });

    it("allows re-acquiring after release", async () => {
      expect(await tryAcquireAlphaVantageRunLock(TEST_NOW)).toBe(true);
      await releaseAlphaVantageRunLock(TEST_NOW);
      expect(await tryAcquireAlphaVantageRunLock(TEST_NOW)).toBe(true);
    });

    it("lets only one of several concurrent acquire attempts win", async () => {
      const results = await Promise.all(Array.from({ length: 5 }, () => tryAcquireAlphaVantageRunLock(TEST_NOW)));
      expect(results.filter(Boolean).length).toBe(1);
    });

    it("self-heals a stale lock left by a crashed process, rather than deadlocking forever", async () => {
      expect(await tryAcquireAlphaVantageRunLock(TEST_NOW)).toBe(true);
      // Simulate a crash: force the lock's timestamp far enough into the past to be stale.
      await prisma.alphaVantageDailyUsage.update({
        where: { date: TEST_DATE_ONLY },
        data: { runningSince: new Date(TEST_NOW.getTime() - 10 * 60 * 1000) },
      });
      expect(await tryAcquireAlphaVantageRunLock(TEST_NOW)).toBe(true);
    });
  });
});
