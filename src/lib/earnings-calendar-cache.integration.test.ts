import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

// A fixed, far-future, file-unique test date isolates these tests' AlphaVantageDailyUsage row
// from every other Alpha Vantage integration test file (a single global-by-date row) - see
// alpha-vantage-budget.integration.test.ts's own header note for why this matters under
// Vitest's parallel-by-file execution.
const TEST_NOW = new Date("2099-11-20T12:00:00.000Z");

function fetchFnReturning(text: string, status = 200) {
  return (async () => new Response(text, { status })) as unknown as typeof fetch;
}

const SAMPLE_CSV = `symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay
AAPL,APPLE INC,2099-12-01,2099-09-30,,USD,
MSFT,MICROSOFT CORP,2099-12-02,2099-09-30,,USD,pre-market
`;

maybeDescribe("Earnings calendar cache - one shared Alpha Vantage refresh, never per-ticker", () => {
  let prisma: typeof import("./prisma").prisma;
  let refreshEarningsCalendarCache: typeof import("./earnings-calendar-cache").refreshEarningsCalendarCache;
  let getEarningsCalendarCacheStatus: typeof import("./earnings-calendar-cache").getEarningsCalendarCacheStatus;
  let getEarningsCalendarLookup: typeof import("./earnings-calendar-cache").getEarningsCalendarLookup;
  let getAlphaVantageUsageToday: typeof import("./alpha-vantage-budget").getAlphaVantageUsageToday;
  let originalApiKey: string | undefined;

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    ({ refreshEarningsCalendarCache, getEarningsCalendarCacheStatus, getEarningsCalendarLookup } = await import("./earnings-calendar-cache"));
    ({ getAlphaVantageUsageToday } = await import("./alpha-vantage-budget"));
    originalApiKey = process.env.ALPHA_VANTAGE_API_KEY;
    process.env.ALPHA_VANTAGE_API_KEY = "test-earnings-calendar-key";
  });

  afterEach(async () => {
    await prisma.earningsCalendarEntry.deleteMany({});
    await prisma.alphaVantageDailyUsage.deleteMany({ where: { date: new Date("2099-11-20T00:00:00.000Z") } });
  });

  afterAll(() => {
    if (originalApiKey === undefined) {
      delete process.env.ALPHA_VANTAGE_API_KEY;
    } else {
      process.env.ALPHA_VANTAGE_API_KEY = originalApiKey;
    }
  });

  it("a successful refresh persists entries and costs exactly one Alpha Vantage reservation", async () => {
    const before = await getAlphaVantageUsageToday(TEST_NOW);

    const result = await refreshEarningsCalendarCache({ now: TEST_NOW, fetchFn: fetchFnReturning(SAMPLE_CSV) });
    expect(result.status).toBe("SUCCESS");
    if (result.status !== "SUCCESS") throw new Error("expected SUCCESS");
    expect(result.entryCount).toBe(2);

    const after = await getAlphaVantageUsageToday(TEST_NOW);
    expect(after.totalCount).toBe(before.totalCount + 1);

    const stored = await prisma.earningsCalendarEntry.findMany({ orderBy: { ticker: "asc" } });
    expect(stored).toHaveLength(2);
    expect(stored.map((row) => row.ticker)).toEqual(["AAPL", "MSFT"]);
  });

  it("reportDate stores as the exact same calendar date regardless of reader/server timezone (date-only, never a timestamp)", async () => {
    await refreshEarningsCalendarCache({ now: TEST_NOW, fetchFn: fetchFnReturning(SAMPLE_CSV) });

    const aapl = await prisma.earningsCalendarEntry.findFirst({ where: { ticker: "AAPL" } });
    // @db.Date stores no time-of-day/timezone component at all - toISOString() must read back
    // exactly midnight UTC on the calendar date Alpha Vantage reported, never shifted a day
    // either direction by a local timezone (the same class of bug already fixed for Campaign
    // date-only fields - see shortCalendarDate in format.ts).
    expect(aapl?.reportDate.toISOString()).toBe("2099-12-01T00:00:00.000Z");
    expect(aapl?.reportDate.getUTCDate()).toBe(1);
    expect(aapl?.reportDate.getUTCMonth()).toBe(11); // December, 0-indexed
  });

  it("a fresh cache costs zero Alpha Vantage calls on the next refresh attempt", async () => {
    await refreshEarningsCalendarCache({ now: TEST_NOW, fetchFn: fetchFnReturning(SAMPLE_CSV) });
    const usageAfterFirst = await getAlphaVantageUsageToday(TEST_NOW);

    const secondAttempt = new Date(TEST_NOW.getTime() + 60 * 60 * 1000); // 1 hour later - still fresh
    const result = await refreshEarningsCalendarCache({ now: secondAttempt, fetchFn: fetchFnReturning(SAMPLE_CSV) });
    expect(result.status).toBe("ALREADY_FRESH");

    const usageAfterSecond = await getAlphaVantageUsageToday(TEST_NOW);
    expect(usageAfterSecond.totalCount).toBe(usageAfterFirst.totalCount); // no new reservation
  });

  it("a failed fetch never touches the existing cache - yesterday's valid data stays usable", async () => {
    await refreshEarningsCalendarCache({ now: TEST_NOW, fetchFn: fetchFnReturning(SAMPLE_CSV) });
    const beforeFailure = await prisma.earningsCalendarEntry.findMany();

    const laterButStillWithinBudget = new Date(TEST_NOW.getTime() + 25 * 60 * 60 * 1000); // beyond staleness window
    const failureResult = await refreshEarningsCalendarCache({
      now: laterButStillWithinBudget,
      fetchFn: fetchFnReturning(JSON.stringify({ Information: "Please slow down." })),
    });
    expect(failureResult.status).toBe("FETCH_FAILED");

    const afterFailure = await prisma.earningsCalendarEntry.findMany();
    expect(afterFailure).toEqual(beforeFailure); // completely untouched by the failed attempt

    const status = await getEarningsCalendarCacheStatus(laterButStillWithinBudget);
    expect(status.entryCount).toBe(2);
    expect(status.isStale).toBe(true); // honestly reported as stale, not silently treated as fresh
  });

  it("a ticker with no cached earnings entry returns nothing from the lookup - stays honestly UNKNOWN, never fabricated", async () => {
    await refreshEarningsCalendarCache({ now: TEST_NOW, fetchFn: fetchFnReturning(SAMPLE_CSV) });

    const lookup = await getEarningsCalendarLookup(["AAPL", "NOTCACHED"], TEST_NOW);
    expect(lookup.has("AAPL")).toBe(true);
    expect(lookup.has("NOTCACHED")).toBe(false);
  });

  it("prunes past report dates only after a successful refresh, never on a failed one", async () => {
    // A past-dated entry from an earlier refresh.
    await prisma.earningsCalendarEntry.create({
      data: { ticker: "STALEENTRY", reportDate: new Date("2099-01-01T00:00:00.000Z"), fetchedAt: new Date(TEST_NOW.getTime() - 48 * 60 * 60 * 1000) },
    });

    const failedNow = new Date(TEST_NOW.getTime() + 25 * 60 * 60 * 1000);
    await refreshEarningsCalendarCache({ now: failedNow, fetchFn: fetchFnReturning(JSON.stringify({ Note: "throttled" })) });
    expect(await prisma.earningsCalendarEntry.findFirst({ where: { ticker: "STALEENTRY" } })).not.toBeNull();

    const successNow = new Date(failedNow.getTime() + 60 * 60 * 1000);
    const result = await refreshEarningsCalendarCache({ now: successNow, force: true, fetchFn: fetchFnReturning(SAMPLE_CSV) });
    expect(result.status).toBe("SUCCESS");
    if (result.status !== "SUCCESS") throw new Error("expected SUCCESS");
    expect(result.prunedCount).toBe(1);
    expect(await prisma.earningsCalendarEntry.findFirst({ where: { ticker: "STALEENTRY" } })).toBeNull();
  });
});
