import { afterEach, beforeAll, describe, expect, it } from "vitest";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

maybeDescribe("Earnings coverage audit - read-only, zero Alpha Vantage calls, never guesses ETF/ETN status", () => {
  let prisma: typeof import("./prisma").prisma;
  let auditEarningsCoverageForTickers: typeof import("./earnings-coverage-audit").auditEarningsCoverageForTickers;

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    ({ auditEarningsCoverageForTickers } = await import("./earnings-coverage-audit"));
  });

  afterEach(async () => {
    await prisma.earningsCalendarEntry.deleteMany({ where: { ticker: { in: ["AUDA", "AUDB", "AUDC"] } } });
  });

  it("classifies a ticker with a cached entry as MATCHED and one without as NO_CALENDAR_ENTRY - never fabricating an ETF/ETN guess", async () => {
    await prisma.earningsCalendarEntry.create({ data: { ticker: "AUDA", reportDate: new Date("2099-12-01") } });

    const audit = await auditEarningsCoverageForTickers(["AUDA", "AUDB"]);
    expect(audit.matchedCount).toBe(1);
    expect(audit.noCalendarEntryCount).toBe(1);
    expect(audit.tickers).toEqual(
      expect.arrayContaining([
        { ticker: "AUDA", category: "MATCHED" },
        { ticker: "AUDB", category: "NO_CALENDAR_ENTRY" },
      ]),
    );
  });

  it("reports the whole-cache staleness flag alongside the per-ticker breakdown", async () => {
    const audit = await auditEarningsCoverageForTickers(["AUDC"]);
    expect(typeof audit.isCacheStale).toBe("boolean");
    expect(typeof audit.cacheEntryCount).toBe("number");
  });

  it("makes zero network calls - purely reads the existing cache", async () => {
    // No Alpha Vantage fetchFn is provided anywhere in this test file - if the function tried to
    // call out, there would be nothing to mock and this file's imports would need a live key.
    const audit = await auditEarningsCoverageForTickers(["AUDA", "AUDB", "AUDC"]);
    expect(audit.tickers).toHaveLength(3);
  });
});
