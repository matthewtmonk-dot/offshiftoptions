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
  let getEarningsEvidenceLookup: typeof import("./earnings-calendar-cache").getEarningsEvidenceLookup;
  let getAlphaVantageUsageToday: typeof import("./alpha-vantage-budget").getAlphaVantageUsageToday;
  let originalApiKey: string | undefined;

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    ({ refreshEarningsCalendarCache, getEarningsCalendarCacheStatus, getEarningsCalendarLookup, getEarningsEvidenceLookup } = await import(
      "./earnings-calendar-cache"
    ));
    ({ getAlphaVantageUsageToday } = await import("./alpha-vantage-budget"));
    originalApiKey = process.env.ALPHA_VANTAGE_API_KEY;
    process.env.ALPHA_VANTAGE_API_KEY = "test-earnings-calendar-key";
  });

  afterEach(async () => {
    // Scoped to this file's own far-future synthetic date range (earliest fixture is
    // STALEENTRY's 2099-01-01), never an unscoped deleteMany({}) - EarningsCalendarEntry is a
    // genuinely global, unowned table (no per-test source/owner column, unlike
    // OptionableUniverseSymbol's own `source`), so a blanket delete here would also destroy any
    // other concurrently-running test file's own real-world-dated rows under Vitest's
    // parallel-by-file execution against the shared local dev DB - the same test-isolation hazard
    // documented elsewhere in this codebase, this time found via the broad-scanner-activation
    // integration tests intermittently losing their own seeded earnings rows mid-test.
    await prisma.earningsCalendarEntry.deleteMany({ where: { reportDate: { gte: new Date("2099-01-01T00:00:00.000Z") } } });
    // Some tests here pass a `now` more than 24h past TEST_NOW (e.g. TEST_NOW + 25h/+26h, to
    // exercise a later refresh), which rolls the AlphaVantageDailyUsage dateKey onto the next
    // calendar day - clean up the whole file-unique synthetic date range, not just TEST_NOW's own
    // day, so repeated local/CI runs never accumulate a stale AUTO reservation count against a
    // fixed future date and spuriously start returning BUDGET_EXHAUSTED.
    await prisma.alphaVantageDailyUsage.deleteMany({
      where: { date: { gte: new Date("2099-11-20T00:00:00.000Z"), lte: new Date("2099-11-22T00:00:00.000Z") } },
    });
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

    // Scoped to this file's own far-future date range - see the afterEach cleanup's own note on
    // why an unscoped read/delete here would be unreliable under Vitest's parallel-file execution.
    const stored = await prisma.earningsCalendarEntry.findMany({
      where: { reportDate: { gte: new Date("2099-01-01T00:00:00.000Z") } },
      orderBy: { ticker: "asc" },
    });
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
    const earningsCacheWhere = { reportDate: { gte: new Date("2099-01-01T00:00:00.000Z") } };
    const beforeFailure = await prisma.earningsCalendarEntry.findMany({ where: earningsCacheWhere });

    const laterButStillWithinBudget = new Date(TEST_NOW.getTime() + 25 * 60 * 60 * 1000); // beyond staleness window
    const failureResult = await refreshEarningsCalendarCache({
      now: laterButStillWithinBudget,
      fetchFn: fetchFnReturning(JSON.stringify({ Information: "Please slow down." })),
    });
    expect(failureResult.status).toBe("FETCH_FAILED");

    const afterFailure = await prisma.earningsCalendarEntry.findMany({ where: earningsCacheWhere });
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

  it("a reschedule (ticker moves from date A to date B) does not leave date A as a surviving current row", async () => {
    const refreshOne = new Date(TEST_NOW.getTime());
    await refreshEarningsCalendarCache({
      now: refreshOne,
      fetchFn: fetchFnReturning("symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\nAAPL,APPLE INC,2099-12-01,2099-09-30,,USD,\n"),
    });
    const afterFirst = await prisma.earningsCalendarEntry.findMany({ where: { ticker: "AAPL" } });
    expect(afterFirst.map((row) => row.reportDate.toISOString().slice(0, 10))).toEqual(["2099-12-01"]);

    // Provider reschedules AAPL to a later date in the very next coherent refresh.
    const refreshTwo = new Date(refreshOne.getTime() + 21 * 60 * 60 * 1000); // past the 20h freshness window
    const result = await refreshEarningsCalendarCache({
      now: refreshTwo,
      fetchFn: fetchFnReturning("symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\nAAPL,APPLE INC,2099-12-10,2099-09-30,,USD,\n"),
    });
    expect(result.status).toBe("SUCCESS");
    if (result.status !== "SUCCESS") throw new Error("expected SUCCESS");
    expect(result.supersededCount).toBe(1); // the old 2099-12-01 row was removed as part of this coherent refresh

    const afterSecond = await prisma.earningsCalendarEntry.findMany({ where: { ticker: "AAPL" } });
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].reportDate.toISOString().slice(0, 10)).toBe("2099-12-10");

    // The legacy Scanner-facing lookup must also now see only the new date - never both.
    const legacyLookup = await getEarningsCalendarLookup(["AAPL"], refreshTwo);
    expect(legacyLookup.get("AAPL")?.reportDate.toISOString().slice(0, 10)).toBe("2099-12-10");
  });

  it("multiple old future dates for a ticker do not survive as competing 'next' candidates after a coherent refresh", async () => {
    // Simulate leftover rows from before this coherence fix existed: two old future dates for one ticker.
    await prisma.earningsCalendarEntry.createMany({
      data: [
        { ticker: "MULTI", reportDate: new Date("2099-12-05"), fetchedAt: new Date(TEST_NOW.getTime() - 48 * 60 * 60 * 1000) },
        { ticker: "MULTI", reportDate: new Date("2099-12-20"), fetchedAt: new Date(TEST_NOW.getTime() - 48 * 60 * 60 * 1000) },
      ],
    });

    const result = await refreshEarningsCalendarCache({
      now: TEST_NOW,
      force: true,
      fetchFn: fetchFnReturning("symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\nMULTI,MULTI CORP,2099-12-15,2099-09-30,,USD,\n"),
    });
    expect(result.status).toBe("SUCCESS");
    if (result.status !== "SUCCESS") throw new Error("expected SUCCESS");

    const rows = await prisma.earningsCalendarEntry.findMany({ where: { ticker: "MULTI" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].reportDate.toISOString().slice(0, 10)).toBe("2099-12-15");
  });

  it("a ticker absent from a successful response keeps its prior evidence untouched - absence is not proof of no earnings", async () => {
    await prisma.earningsCalendarEntry.create({
      data: { ticker: "UNMENTIONED", reportDate: new Date("2099-12-25"), fetchedAt: new Date(TEST_NOW.getTime() - 1000) },
    });

    const result = await refreshEarningsCalendarCache({ now: TEST_NOW, force: true, fetchFn: fetchFnReturning(SAMPLE_CSV) });
    expect(result.status).toBe("SUCCESS");
    if (result.status !== "SUCCESS") throw new Error("expected SUCCESS");
    expect(result.supersededCount).toBe(0); // UNMENTIONED was never part of this batch, so nothing to supersede

    const stillThere = await prisma.earningsCalendarEntry.findFirst({ where: { ticker: "UNMENTIONED" } });
    expect(stillThere).not.toBeNull();
    expect(stillThere?.reportDate.toISOString().slice(0, 10)).toBe("2099-12-25");
  });

  it("an empty-but-valid provider response (parsed successfully, zero usable rows) leaves the existing cache untouched", async () => {
    await refreshEarningsCalendarCache({ now: TEST_NOW, fetchFn: fetchFnReturning(SAMPLE_CSV) });
    const before = await prisma.earningsCalendarEntry.findMany({ where: { ticker: { in: ["AAPL", "MSFT"] } } });

    // Valid header, zero data rows - the adapter classifies this as EMPTY, not SUCCESS. Forced
    // (rather than waiting out the freshness window) so the attempt actually reaches the fetch,
    // while staying well within the freshness window so AAPL's untouched evidence stays SCHEDULED
    // below (freshness-driven STALE is covered by its own dedicated test).
    const emptyButValidNow = new Date(TEST_NOW.getTime() + 60 * 60 * 1000);
    const result = await refreshEarningsCalendarCache({
      now: emptyButValidNow,
      force: true,
      fetchFn: fetchFnReturning("symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\n"),
    });
    expect(result.status).toBe("FETCH_FAILED");
    if (result.status !== "FETCH_FAILED") throw new Error("expected FETCH_FAILED");
    expect(result.outcome).toBe("EMPTY");

    const after = await prisma.earningsCalendarEntry.findMany({ where: { ticker: { in: ["AAPL", "MSFT"] } } });
    expect(after).toEqual(before);

    // An empty response must never be read as "no tickers have earnings" by the evidence lookup.
    const evidence = await getEarningsEvidenceLookup(["AAPL", "NEVERSEEN"], emptyButValidNow);
    expect(evidence.get("AAPL")?.status).toBe("SCHEDULED");
    expect(evidence.get("NEVERSEEN")?.status).toBe("NO_EVIDENCE");
  });

  it("getEarningsEvidenceLookup: a missing ticker is NO_EVIDENCE, never CLEAR/fabricated", async () => {
    const evidence = await getEarningsEvidenceLookup(["TOTALLYUNKNOWNTICKER"], TEST_NOW);
    expect(evidence.get("TOTALLYUNKNOWNTICKER")).toEqual({
      ticker: "TOTALLYUNKNOWNTICKER",
      status: "NO_EVIDENCE",
      reportDate: null,
      observedAt: null,
      candidateReportDates: [],
    });
  });

  it("getEarningsEvidenceLookup: evidence older than the freshness window is reported STALE, not SCHEDULED", async () => {
    await prisma.earningsCalendarEntry.create({
      data: { ticker: "OLDOBS", reportDate: new Date("2099-12-30"), fetchedAt: new Date(TEST_NOW.getTime() - 25 * 60 * 60 * 1000) },
    });

    const evidence = await getEarningsEvidenceLookup(["OLDOBS"], TEST_NOW);
    expect(evidence.get("OLDOBS")?.status).toBe("STALE");
  });

  it("getEarningsEvidenceLookup preserves fetchedAt as observedAt, distinct from reportDate", async () => {
    const observedAt = new Date(TEST_NOW.getTime() - 60 * 60 * 1000);
    await prisma.earningsCalendarEntry.create({ data: { ticker: "OBSERVED", reportDate: new Date("2099-12-28"), fetchedAt: observedAt } });

    const evidence = await getEarningsEvidenceLookup(["OBSERVED"], TEST_NOW);
    expect(evidence.get("OBSERVED")?.observedAt?.toISOString()).toBe(observedAt.toISOString());
    expect(evidence.get("OBSERVED")?.reportDate?.toISOString()).toBe(new Date("2099-12-28").toISOString());
  });

  it("Scanner compatibility: getEarningsCalendarLookup's shape and soonest-date behavior are unchanged by the coherence fix", async () => {
    await refreshEarningsCalendarCache({ now: TEST_NOW, fetchFn: fetchFnReturning(SAMPLE_CSV) });
    const lookup = await getEarningsCalendarLookup(["AAPL"], TEST_NOW);
    const entry = lookup.get("AAPL");
    expect(entry).toBeDefined();
    expect(Object.keys(entry!).sort()).toEqual(["daysUntilReport", "reportDate"]);
  });
});
