import { describe, expect, it } from "vitest";
import { fetchAlphaVantageBalanceSheetForTicker } from "./balance-sheet";

function fetchFnReturning(payload: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status })) as unknown as typeof fetch;
}

describe("fetchAlphaVantageBalanceSheetForTicker", () => {
  it("computes Current Ratio from the latest quarterly report's totalCurrentAssets/totalCurrentLiabilities", async () => {
    const result = await fetchAlphaVantageBalanceSheetForTicker({
      apiKey: "key",
      ticker: "APLD",
      fetchFn: fetchFnReturning({
        symbol: "APLD",
        quarterlyReports: [{ fiscalDateEnding: "2026-06-30", totalCurrentAssets: "5000000", totalCurrentLiabilities: "2000000" }],
      }),
    });
    expect(result.outcome).toBe("SUCCESS");
    if (result.outcome === "SUCCESS") {
      expect(result.fields.currentRatio).toBe(2.5);
      expect(result.fields.fiscalDateEnding).toBe("2026-06-30");
    }
  });

  it("returns null (never divides by zero) when totalCurrentLiabilities is zero", async () => {
    const result = await fetchAlphaVantageBalanceSheetForTicker({
      apiKey: "key",
      ticker: "APLD",
      fetchFn: fetchFnReturning({
        symbol: "APLD",
        quarterlyReports: [{ fiscalDateEnding: "2026-06-30", totalCurrentAssets: "5000000", totalCurrentLiabilities: "0" }],
      }),
    });
    expect(result.outcome).toBe("SUCCESS");
    if (result.outcome === "SUCCESS") {
      expect(result.fields.currentRatio).toBeNull();
    }
  });

  it("normalizes None/-/empty-string sentinels to null rather than a fabricated ratio", async () => {
    const result = await fetchAlphaVantageBalanceSheetForTicker({
      apiKey: "key",
      ticker: "APLD",
      fetchFn: fetchFnReturning({
        symbol: "APLD",
        quarterlyReports: [{ fiscalDateEnding: "2026-06-30", totalCurrentAssets: "None", totalCurrentLiabilities: "2000000" }],
      }),
    });
    expect(result.outcome).toBe("SUCCESS");
    if (result.outcome === "SUCCESS") {
      expect(result.fields.currentRatio).toBeNull();
    }
  });

  it("returns EMPTY when there are no quarterly reports at all", async () => {
    const result = await fetchAlphaVantageBalanceSheetForTicker({
      apiKey: "key",
      ticker: "APLD",
      fetchFn: fetchFnReturning({ symbol: "APLD", quarterlyReports: [] }),
    });
    expect(result.outcome).toBe("EMPTY");
  });

  it("classifies a Note/Information field as RATE_LIMITED", async () => {
    const result = await fetchAlphaVantageBalanceSheetForTicker({
      apiKey: "key",
      ticker: "APLD",
      fetchFn: fetchFnReturning({ Note: "Please consider spreading out your free API requests more sparingly." }),
    });
    expect(result.outcome).toBe("RATE_LIMITED");
  });

  it("classifies a non-2xx HTTP status as HTTP_ERROR", async () => {
    const result = await fetchAlphaVantageBalanceSheetForTicker({
      apiKey: "key",
      ticker: "APLD",
      fetchFn: fetchFnReturning({}, 500),
    });
    expect(result.outcome).toBe("HTTP_ERROR");
  });

  it("redacts the API key from a returned message rather than ever echoing it", async () => {
    const result = await fetchAlphaVantageBalanceSheetForTicker({
      apiKey: "super-secret-key",
      ticker: "APLD",
      fetchFn: fetchFnReturning({ Note: "Your key super-secret-key has been throttled." }),
    });
    expect(result.outcome).toBe("RATE_LIMITED");
    if (result.outcome === "RATE_LIMITED") {
      expect(result.message).not.toContain("super-secret-key");
    }
  });
});
