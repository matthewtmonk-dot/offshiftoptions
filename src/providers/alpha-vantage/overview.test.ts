import { describe, expect, it } from "vitest";
import { fetchAlphaVantageOverviewForTicker } from "./overview";

function fetchFnReturning(payload: unknown, status = 200) {
  return (async () => new Response(JSON.stringify(payload), { status })) as unknown as typeof fetch;
}

describe("fetchAlphaVantageOverviewForTicker - normalization", () => {
  const realPayload = {
    Symbol: "APLD",
    Name: "Applied Digital Corporation",
    Description: "Applied Digital Corporation designs and operates data centers.",
    Sector: "TECHNOLOGY",
    Industry: "SERVICES-COMPUTER PROGRAMMING",
    MarketCapitalization: "5123456789",
    PERatio: "-12.5",
    PEGRatio: "1.829",
    EPS: "-0.42",
    DividendPerShare: "0",
    DividendYield: "0",
    ProfitMargin: "None",
    OperatingMarginTTM: "-",
    ReturnOnAssetsTTM: "",
    ReturnOnEquityTTM: "0.081",
    RevenueTTM: "200000000",
    GrossProfitTTM: "50000000",
    QuarterlyEarningsGrowthYOY: "0.15",
    QuarterlyRevenueGrowthYOY: "0.22",
    AnalystTargetPrice: "18.50",
    AnalystRatingStrongBuy: "3",
    AnalystRatingBuy: "5",
    AnalystRatingHold: "2",
    AnalystRatingSell: "0",
    AnalystRatingStrongSell: "0",
    BookValue: "4.21",
    PriceToBookRatio: "2.1",
    EVToEBITDA: "None",
    Beta: "1.9",
  };

  it("normalizes a real, populated response into typed numeric/string fields", async () => {
    const result = await fetchAlphaVantageOverviewForTicker({ apiKey: "test-key", ticker: "APLD", fetchFn: fetchFnReturning(realPayload) });
    expect(result.outcome).toBe("SUCCESS");
    if (result.outcome !== "SUCCESS") throw new Error("expected SUCCESS");
    expect(result.fields.name).toBe("Applied Digital Corporation");
    expect(result.fields.peRatio).toBe(-12.5);
    expect(result.fields.pegRatio).toBe(1.829);
    expect(result.fields.eps).toBe(-0.42);
    expect(result.fields.analystStrongBuy).toBe(3);
  });

  it("preserves real zero values as numeric 0, never null", async () => {
    const result = await fetchAlphaVantageOverviewForTicker({ apiKey: "test-key", ticker: "APLD", fetchFn: fetchFnReturning(realPayload) });
    if (result.outcome !== "SUCCESS") throw new Error("expected SUCCESS");
    expect(result.fields.dividendPerShare).toBe(0);
    expect(result.fields.dividendYield).toBe(0);
  });

  it('maps "None", "-", and "" null sentinels to null, never 0 or a literal string', async () => {
    const result = await fetchAlphaVantageOverviewForTicker({ apiKey: "test-key", ticker: "APLD", fetchFn: fetchFnReturning(realPayload) });
    if (result.outcome !== "SUCCESS") throw new Error("expected SUCCESS");
    expect(result.fields.profitMargin).toBeNull();
    expect(result.fields.operatingMarginTtm).toBeNull();
    expect(result.fields.returnOnAssetsTtm).toBeNull();
    expect(result.fields.evToEbitda).toBeNull();
  });

  it("maps a genuinely missing key to null as well", async () => {
    const { BookValue: _unused, ...withoutBookValue } = realPayload;
    void _unused;
    const result = await fetchAlphaVantageOverviewForTicker({ apiKey: "test-key", ticker: "APLD", fetchFn: fetchFnReturning(withoutBookValue) });
    if (result.outcome !== "SUCCESS") throw new Error("expected SUCCESS");
    expect(result.fields.bookValue).toBeNull();
  });

  it("classifies a Note/Information throttle response as RATE_LIMITED", async () => {
    const result = await fetchAlphaVantageOverviewForTicker({
      apiKey: "test-key",
      ticker: "RIOT",
      fetchFn: fetchFnReturning({ Information: "Please consider spreading out your free API requests more sparingly (1 request per second)." }),
    });
    expect(result.outcome).toBe("RATE_LIMITED");
  });

  it("classifies an empty object (no Symbol) as EMPTY", async () => {
    const result = await fetchAlphaVantageOverviewForTicker({ apiKey: "test-key", ticker: "CORZ", fetchFn: fetchFnReturning({}) });
    expect(result.outcome).toBe("EMPTY");
  });

  it("classifies a non-2xx status as HTTP_ERROR", async () => {
    const result = await fetchAlphaVantageOverviewForTicker({ apiKey: "test-key", ticker: "CORZ", fetchFn: fetchFnReturning({}, 500) });
    expect(result.outcome).toBe("HTTP_ERROR");
  });

  it("never leaks the API key anywhere in a successful result, including inside a field value", async () => {
    const sentinelKey = "sentinel-overview-key-must-never-leak";
    const result = await fetchAlphaVantageOverviewForTicker({
      apiKey: sentinelKey,
      ticker: "APLD",
      fetchFn: fetchFnReturning({ ...realPayload, Description: `Text containing ${sentinelKey}` }),
    });
    expect(JSON.stringify(result)).not.toContain(sentinelKey);
  });

  it("never leaks the API key in a rate-limited/error message either", async () => {
    const sentinelKey = "sentinel-overview-throttle-key-must-never-leak";
    const result = await fetchAlphaVantageOverviewForTicker({
      apiKey: sentinelKey,
      ticker: "RIOT",
      fetchFn: fetchFnReturning({ Note: `spread out requests ${sentinelKey}` }),
    });
    expect(JSON.stringify(result)).not.toContain(sentinelKey);
  });
});
