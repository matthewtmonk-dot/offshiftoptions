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
  let buildUpsertQuery: typeof import("./earnings-calendar-cache").buildUpsertQuery;
  let getAlphaVantageUsageToday: typeof import("./alpha-vantage-budget").getAlphaVantageUsageToday;
  let originalApiKey: string | undefined;

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    ({
      refreshEarningsCalendarCache,
      getEarningsCalendarCacheStatus,
      getEarningsCalendarLookup,
      getEarningsEvidenceLookup,
      buildUpsertQuery,
    } = await import("./earnings-calendar-cache"));
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

  it("a mixed valid+malformed response (PARTIAL_UNTRUSTED) makes zero writes and preserves all prior cached future evidence", async () => {
    await prisma.earningsCalendarEntry.create({
      data: { ticker: "PRIORGOOD", reportDate: new Date("2099-12-05"), fetchedAt: new Date(TEST_NOW.getTime() - 1000) },
    });
    const before = await prisma.earningsCalendarEntry.findMany({ where: { reportDate: { gte: new Date("2099-01-01T00:00:00.000Z") } } });

    // PRIORGOOD itself has a valid new row here (would normally supersede its old one), but XYZ's
    // row is malformed (impossible date) - the whole response must be rejected, so even
    // PRIORGOOD's otherwise-legitimate new date must NOT be written.
    const mixedCsv =
      "symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\n" +
      "PRIORGOOD,PRIOR GOOD CORP,2099-12-20,2099-09-30,,USD,\n" +
      "XYZ,XYZ CORP,2099-10-32,2099-09-30,,USD,\n";
    const result = await refreshEarningsCalendarCache({ now: TEST_NOW, force: true, fetchFn: fetchFnReturning(mixedCsv) });
    expect(result.status).toBe("FETCH_FAILED");
    if (result.status !== "FETCH_FAILED") throw new Error("expected FETCH_FAILED");
    expect(result.outcome).toBe("PARTIAL_UNTRUSTED");

    const after = await prisma.earningsCalendarEntry.findMany({ where: { reportDate: { gte: new Date("2099-01-01T00:00:00.000Z") } } });
    expect(after).toEqual(before); // zero writes - PRIORGOOD's old row untouched, XYZ never created
  });

  it("multiple distinct valid report dates for one ticker in the same successful response both persist and become AMBIGUOUS evidence", async () => {
    const csv =
      "symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\n" +
      "TWODATES,TWO DATES CORP,2099-12-05,2099-09-30,,USD,\n" +
      "TWODATES,TWO DATES CORP,2099-12-20,2099-09-30,,USD,\n";
    const result = await refreshEarningsCalendarCache({ now: TEST_NOW, fetchFn: fetchFnReturning(csv) });
    expect(result.status).toBe("SUCCESS");
    if (result.status !== "SUCCESS") throw new Error("expected SUCCESS");

    const rows = await prisma.earningsCalendarEntry.findMany({ where: { ticker: "TWODATES" } });
    expect(rows).toHaveLength(2); // both genuinely distinct dates persisted - neither silently dropped

    const evidence = await getEarningsEvidenceLookup(["TWODATES"], TEST_NOW);
    expect(evidence.get("TWODATES")?.status).toBe("AMBIGUOUS");
    expect(evidence.get("TWODATES")?.candidateReportDates.map((d) => d.toISOString().slice(0, 10))).toEqual(["2099-12-05", "2099-12-20"]);
  });

  it("a real DB transaction rollback leaves no partial new schedule committed and preserves old evidence intact", async () => {
    await prisma.earningsCalendarEntry.create({
      data: { ticker: "ROLLBACK", reportDate: new Date("2099-12-01"), fetchedAt: new Date(TEST_NOW.getTime() - 1000) },
    });

    // Compose the exact real production upsert statement (buildUpsertQuery) alongside a second
    // statement guaranteed to fail at the database level (division by zero) - proves Postgres
    // really does roll back the whole transaction, including the upsert, when any statement in it
    // fails. Does not modify or bypass refreshEarningsCalendarCache's own real control flow.
    //
    // Asserted on the SPECIFIC expected failure (Postgres SQLSTATE 22012, division_by_zero) via
    // the driver adapter's own error detail, not a generic rejects.toThrow() - a bare toThrow()
    // would also pass if the FIRST statement (the real upsert) were the one that failed for some
    // unrelated reason, which would prove nothing about rollback atomicity specifically.
    const entries = [{ ticker: "ROLLBACK", reportDate: new Date("2099-12-20") }];
    let caught: unknown;
    try {
      await prisma.$transaction([buildUpsertQuery(entries, TEST_NOW), prisma.$executeRaw`SELECT 1/0`]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const driverCause = (caught as { meta?: { driverAdapterError?: { cause?: { originalCode?: string } } } }).meta?.driverAdapterError?.cause;
    expect(driverCause?.originalCode).toBe("22012"); // Postgres division_by_zero - confirms it was the deliberately-failing second statement

    const rows = await prisma.earningsCalendarEntry.findMany({ where: { ticker: "ROLLBACK" } });
    expect(rows).toHaveLength(1); // the upsert's new row was NOT committed
    expect(rows[0].reportDate.toISOString().slice(0, 10)).toBe("2099-12-01"); // old evidence intact, never partially replaced
  });

  it("NY/UTC rollover: a report dated the current New York calendar day is not discarded as already-past merely because UTC has advanced past midnight", async () => {
    // 2099-12-01T02:00:00Z is 2099-11-30 21:00 America/New_York (EST, UTC-5) - still Nov 30 in NY,
    // even though UTC has already rolled over to Dec 1.
    const rolloverNow = new Date("2099-12-01T02:00:00.000Z");
    await prisma.earningsCalendarEntry.create({
      data: { ticker: "ROLLOVER", reportDate: new Date("2099-11-30T00:00:00.000Z"), fetchedAt: new Date(rolloverNow.getTime() - 1000) },
    });

    const legacyLookup = await getEarningsCalendarLookup(["ROLLOVER"], rolloverNow);
    expect(legacyLookup.has("ROLLOVER")).toBe(true); // a naive UTC-only "today" would have wrongly excluded this as already-past

    const evidence = await getEarningsEvidenceLookup(["ROLLOVER"], rolloverNow);
    expect(evidence.get("ROLLOVER")?.status).toBe("SCHEDULED");
    expect(evidence.get("ROLLOVER")?.reportDate?.toISOString()).toBe("2099-11-30T00:00:00.000Z");
  });

  it("a malformed-CSV response (unterminated quote swallowing a later real row) makes zero writes - existing schedule survives intact", async () => {
    await prisma.earningsCalendarEntry.create({
      data: { ticker: "XYZ", reportDate: new Date("2099-10-12"), fetchedAt: new Date(TEST_NOW.getTime() - 1000) },
    });

    // The exact Codex-reported fixture: an unterminated quote in the first XYZ row's last field
    // swallows the entire second XYZ row (including its 2099-10-12 date) into one field value. A
    // lenient parser could recover only the first (2099-11-20) row and let it coherently supersede
    // the real cached 2099-10-12 date - that must never happen.
    const malformedCsv =
      'symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\nXYZ,XYZ,2099-11-20,2099-09-30,,USD,"\nXYZ,XYZ,2099-10-12,2099-09-30,,USD,\n';

    const result = await refreshEarningsCalendarCache({ now: TEST_NOW, force: true, fetchFn: fetchFnReturning(malformedCsv) });
    expect(result.status).toBe("FETCH_FAILED");
    if (result.status !== "FETCH_FAILED") throw new Error("expected FETCH_FAILED");
    expect(result.outcome).toBe("ERROR_MESSAGE");

    // No upsert, no supersede-delete - the real, correct 2099-10-12 row is exactly as it was.
    const rows = await prisma.earningsCalendarEntry.findMany({ where: { ticker: "XYZ" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].reportDate.toISOString().slice(0, 10)).toBe("2099-10-12");
    expect(rows[0].reportDate.toISOString().slice(0, 10)).not.toBe("2099-11-20"); // the malformed response's own date never got written
  });
});
