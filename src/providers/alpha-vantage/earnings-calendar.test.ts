import { describe, expect, it } from "vitest";
import { fetchAlphaVantageEarningsCalendar } from "./earnings-calendar";

function fetchFnReturning(text: string, status = 200) {
  return (async () => new Response(text, { status })) as unknown as typeof fetch;
}

// A real, verified sample from Alpha Vantage's own EARNINGS_CALENDAR endpoint called WITHOUT a
// symbol parameter (confirmed live 2026-09 via Alpha Vantage's public demo key) - CSV, not
// JSON, and covers many companies in a single response.
const REAL_SAMPLE_CSV = `symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay
AIV,APARTMENT INVESTMENT AND MANAGEMENT COMPANY,2026-09-07,2026-06-30,,USD,
CBAT,CBAK ENERGY TECHNOLOGY LIMITED,2026-09-07,2026-06-30,-0.06,USD,
GRFS,GRIFOLS SOCIEDAD ANONIMA,2026-09-07,2026-06-30,0.27,USD,
ABM,ABM INDUSTRIES INCORPORATED,2026-09-08,2026-07-31,1.01,USD,pre-market
`;

describe("fetchAlphaVantageEarningsCalendar", () => {
  it("parses a real multi-company CSV response into ticker/reportDate entries without a symbol parameter", async () => {
    const result = await fetchAlphaVantageEarningsCalendar({ apiKey: "test-key", fetchFn: fetchFnReturning(REAL_SAMPLE_CSV) });
    expect(result.outcome).toBe("SUCCESS");
    if (result.outcome !== "SUCCESS") throw new Error("expected SUCCESS");
    expect(result.entries).toHaveLength(4);
    expect(result.entries.find((entry) => entry.ticker === "ABM")?.reportDate.toISOString()).toBe("2026-09-08T00:00:00.000Z");
    expect(result.entries.find((entry) => entry.ticker === "GRFS")?.reportDate.toISOString()).toBe("2026-09-07T00:00:00.000Z");
  });

  it("uppercases tickers and preserves date-only UTC parsing (no local timezone shift)", async () => {
    const csv = "symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\nriot,RIOT PLATFORMS INC,2026-09-04,2026-06-30,,USD,\n";
    const result = await fetchAlphaVantageEarningsCalendar({ apiKey: "test-key", fetchFn: fetchFnReturning(csv) });
    if (result.outcome !== "SUCCESS") throw new Error("expected SUCCESS");
    expect(result.entries[0].ticker).toBe("RIOT");
    expect(result.entries[0].reportDate.toISOString()).toBe("2026-09-04T00:00:00.000Z");
  });

  it("marks the whole response PARTIAL_UNTRUSTED (never silently SUCCESS) when any row is missing symbol or reportDate", async () => {
    // A dropped malformed row could just as easily have been the row that would have told us a
    // ticker's prior cached date was superseded - silently keeping only "REAL" and proceeding as
    // SUCCESS could let a destructive supersede-delete run on an incomplete picture of the
    // provider's actual response. See PARTIAL_UNTRUSTED's own doc comment.
    const csv =
      "symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\n" +
      ",MISSING SYMBOL CORP,2026-09-07,2026-06-30,,USD,\n" +
      "GOOD,GOOD CORP,,2026-06-30,,USD,\n" +
      "REAL,REAL CORP,2026-09-10,2026-06-30,,USD,\n";
    const result = await fetchAlphaVantageEarningsCalendar({ apiKey: "test-key", fetchFn: fetchFnReturning(csv) });
    expect(result.outcome).toBe("PARTIAL_UNTRUSTED");
    if (result.outcome !== "PARTIAL_UNTRUSTED") throw new Error("expected PARTIAL_UNTRUSTED");
    expect(result.malformedRowCount).toBe(2);
    expect(result.validEntryCount).toBe(1);
  });

  it("classifies a row with an impossible calendar date (e.g. day 32) as PARTIAL_UNTRUSTED, not SUCCESS with that row dropped", async () => {
    const csv =
      "symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\n" +
      "GOOD,GOOD CORP,2026-09-10,2026-06-30,,USD,\n" +
      "BAD,BAD CORP,2026-10-32,2026-06-30,,USD,\n";
    const result = await fetchAlphaVantageEarningsCalendar({ apiKey: "test-key", fetchFn: fetchFnReturning(csv) });
    expect(result.outcome).toBe("PARTIAL_UNTRUSTED");
    if (result.outcome !== "PARTIAL_UNTRUSTED") throw new Error("expected PARTIAL_UNTRUSTED");
    expect(result.malformedRowCount).toBe(1);
    expect(result.validEntryCount).toBe(1);
  });

  it("remains SUCCESS when every data row is well-formed, even with a trailing blank line", async () => {
    const csv = "symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\nGOOD,GOOD CORP,2026-09-10,2026-06-30,,USD,\n\n";
    const result = await fetchAlphaVantageEarningsCalendar({ apiKey: "test-key", fetchFn: fetchFnReturning(csv) });
    expect(result.outcome).toBe("SUCCESS");
    if (result.outcome !== "SUCCESS") throw new Error("expected SUCCESS");
    expect(result.entries).toHaveLength(1);
  });

  it("classifies a Note/Information throttle JSON body (instead of CSV) as RATE_LIMITED", async () => {
    const result = await fetchAlphaVantageEarningsCalendar({
      apiKey: "test-key",
      fetchFn: fetchFnReturning(JSON.stringify({ Information: "Please consider spreading out your free API requests." })),
    });
    expect(result.outcome).toBe("RATE_LIMITED");
  });

  it("classifies an Error Message JSON body as ERROR_MESSAGE", async () => {
    const result = await fetchAlphaVantageEarningsCalendar({
      apiKey: "test-key",
      fetchFn: fetchFnReturning(JSON.stringify({ "Error Message": "Invalid horizon." })),
    });
    expect(result.outcome).toBe("ERROR_MESSAGE");
  });

  it("classifies an empty response as EMPTY", async () => {
    const result = await fetchAlphaVantageEarningsCalendar({ apiKey: "test-key", fetchFn: fetchFnReturning("") });
    expect(result.outcome).toBe("EMPTY");
  });

  it("classifies a CSV response missing expected columns as ERROR_MESSAGE rather than guessing", async () => {
    const result = await fetchAlphaVantageEarningsCalendar({ apiKey: "test-key", fetchFn: fetchFnReturning("foo,bar\n1,2\n") });
    expect(result.outcome).toBe("ERROR_MESSAGE");
  });

  it("classifies a non-2xx status as HTTP_ERROR", async () => {
    const result = await fetchAlphaVantageEarningsCalendar({ apiKey: "test-key", fetchFn: fetchFnReturning("", 500) });
    expect(result.outcome).toBe("HTTP_ERROR");
  });

  describe("strict calendar-date parsing (via PARTIAL_UNTRUSTED on an otherwise-valid batch)", () => {
    const csvWith = (reportDate: string) =>
      `symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\nGOOD,GOOD CORP,2026-09-10,2026-06-30,,USD,\nTEST,TEST CORP,${reportDate},2026-06-30,,USD,\n`;

    const expectRejected = async (reportDate: string) => {
      const result = await fetchAlphaVantageEarningsCalendar({ apiKey: "test-key", fetchFn: fetchFnReturning(csvWith(reportDate)) });
      expect(result.outcome).toBe("PARTIAL_UNTRUSTED");
    };

    const expectAccepted = async (reportDate: string, expectedIso: string) => {
      const result = await fetchAlphaVantageEarningsCalendar({ apiKey: "test-key", fetchFn: fetchFnReturning(csvWith(reportDate)) });
      expect(result.outcome).toBe("SUCCESS");
      if (result.outcome !== "SUCCESS") throw new Error("expected SUCCESS");
      expect(result.entries.find((entry) => entry.ticker === "TEST")?.reportDate.toISOString()).toBe(expectedIso);
    };

    it("rejects 2026-10-32 (impossible day) rather than normalizing it to 2026-11-01", () => expectRejected("2026-10-32"));
    it("rejects 2026-02-29 (not a leap year)", () => expectRejected("2026-02-29"));
    it("accepts 2028-02-29 (a real leap year)", () => expectAccepted("2028-02-29", "2028-02-29T00:00:00.000Z"));
    it("rejects month 00", () => expectRejected("2026-00-15"));
    it("rejects month 13", () => expectRejected("2026-13-01"));
    it("rejects day 00", () => expectRejected("2026-09-00"));
    it("rejects a malformed non-date string", () => expectRejected("not-a-date"));
    it("rejects a string with trailing junk after a valid-looking date", () => expectRejected("2026-09-10x"));
    it("rejects a slash-delimited date (format must be exact YYYY-MM-DD)", () => expectRejected("2026/09/10"));
    it("rejects a single-digit day (format must be exact, not merely numeric)", () => expectRejected("2026-09-5"));
    it("accepts a valid ordinary date", () => expectAccepted("2026-09-15", "2026-09-15T00:00:00.000Z"));
  });

  it("never leaks the API key in a rate-limited message", async () => {
    const sentinelKey = "sentinel-earnings-calendar-key-must-never-leak";
    const result = await fetchAlphaVantageEarningsCalendar({
      apiKey: sentinelKey,
      fetchFn: fetchFnReturning(JSON.stringify({ Note: `spread out requests ${sentinelKey}` })),
    });
    expect(JSON.stringify(result)).not.toContain(sentinelKey);
  });
});
