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

  describe("Debt/Equity - shortLongTermDebtTotal / totalShareholderEquity, verified against a real production APLD response", () => {
    function balanceSheetFetch(overrides: Record<string, unknown>) {
      return fetchFnReturning({
        symbol: "APLD",
        quarterlyReports: [{ fiscalDateEnding: "2026-05-31", ...overrides }],
      });
    }

    it("computes the exact verified real-world APLD example (shortLongTermDebtTotal / totalShareholderEquity)", async () => {
      const result = await fetchAlphaVantageBalanceSheetForTicker({
        apiKey: "key",
        ticker: "APLD",
        fetchFn: balanceSheetFetch({ shortLongTermDebtTotal: "509991600", totalShareholderEquity: "1780242000" }),
      });
      expect(result.outcome).toBe("SUCCESS");
      if (result.outcome === "SUCCESS") {
        expect(result.fields.debtToEquity).toBeCloseTo(0.286473, 5);
        expect(result.fields.fiscalDateEnding).toBe("2026-05-31");
      }
    });

    it("never adds shortTermDebt on top of shortLongTermDebtTotal - that would double-count debt already folded into it", async () => {
      const result = await fetchAlphaVantageBalanceSheetForTicker({
        apiKey: "key",
        ticker: "APLD",
        fetchFn: balanceSheetFetch({
          shortTermDebt: "82491000",
          shortLongTermDebtTotal: "509991600",
          totalShareholderEquity: "1780242000",
        }),
      });
      expect(result.outcome).toBe("SUCCESS");
      if (result.outcome === "SUCCESS") {
        // Would be ~0.333 if shortTermDebt were wrongly added on top - must stay the verified ~0.286.
        expect(result.fields.debtToEquity).toBeCloseTo(0.286473, 5);
      }
    });

    it("never uses totalLiabilities as the numerator - only shortLongTermDebtTotal", async () => {
      const result = await fetchAlphaVantageBalanceSheetForTicker({
        apiKey: "key",
        ticker: "APLD",
        fetchFn: balanceSheetFetch({
          shortLongTermDebtTotal: "509991600",
          totalLiabilities: "618573500",
          totalShareholderEquity: "1780242000",
        }),
      });
      expect(result.outcome).toBe("SUCCESS");
      if (result.outcome === "SUCCESS") {
        // 618573500 / 1780242000 would be ~0.347 if totalLiabilities were wrongly used.
        expect(result.fields.debtToEquity).toBeCloseTo(0.286473, 5);
      }
    });

    it("preserves a real numeric zero debt value as 0, never null", async () => {
      const result = await fetchAlphaVantageBalanceSheetForTicker({
        apiKey: "key",
        ticker: "APLD",
        fetchFn: balanceSheetFetch({ shortLongTermDebtTotal: "0", totalShareholderEquity: "1780242000" }),
      });
      expect(result.outcome).toBe("SUCCESS");
      if (result.outcome === "SUCCESS") {
        expect(result.fields.debtToEquity).toBe(0);
      }
    });

    it("returns null when shortLongTermDebtTotal is missing - never synthesized from other overlapping debt fields", async () => {
      const result = await fetchAlphaVantageBalanceSheetForTicker({
        apiKey: "key",
        ticker: "APLD",
        fetchFn: balanceSheetFetch({
          shortTermDebt: "82491000",
          longTermDebt: "400000000",
          totalShareholderEquity: "1780242000",
          // shortLongTermDebtTotal intentionally absent
        }),
      });
      expect(result.outcome).toBe("SUCCESS");
      if (result.outcome === "SUCCESS") {
        expect(result.fields.debtToEquity).toBeNull();
      }
    });

    it("returns null when totalShareholderEquity is missing", async () => {
      const result = await fetchAlphaVantageBalanceSheetForTicker({
        apiKey: "key",
        ticker: "APLD",
        fetchFn: balanceSheetFetch({ shortLongTermDebtTotal: "509991600" }),
      });
      expect(result.outcome).toBe("SUCCESS");
      if (result.outcome === "SUCCESS") {
        expect(result.fields.debtToEquity).toBeNull();
      }
    });

    it("returns null (not Infinity) when totalShareholderEquity is exactly zero", async () => {
      const result = await fetchAlphaVantageBalanceSheetForTicker({
        apiKey: "key",
        ticker: "APLD",
        fetchFn: balanceSheetFetch({ shortLongTermDebtTotal: "509991600", totalShareholderEquity: "0" }),
      });
      expect(result.outcome).toBe("SUCCESS");
      if (result.outcome === "SUCCESS") {
        expect(result.fields.debtToEquity).toBeNull();
      }
    });

    it("returns null (not a misleading negative ratio) when totalShareholderEquity is negative", async () => {
      const result = await fetchAlphaVantageBalanceSheetForTicker({
        apiKey: "key",
        ticker: "APLD",
        fetchFn: balanceSheetFetch({ shortLongTermDebtTotal: "509991600", totalShareholderEquity: "-50000000" }),
      });
      expect(result.outcome).toBe("SUCCESS");
      if (result.outcome === "SUCCESS") {
        expect(result.fields.debtToEquity).toBeNull();
      }
    });

    it("normalizes Alpha Vantage's None/-/empty-string sentinels for either field to null rather than a fabricated ratio", async () => {
      const noneDebt = await fetchAlphaVantageBalanceSheetForTicker({
        apiKey: "key",
        ticker: "APLD",
        fetchFn: balanceSheetFetch({ shortLongTermDebtTotal: "None", totalShareholderEquity: "1780242000" }),
      });
      expect(noneDebt.outcome).toBe("SUCCESS");
      if (noneDebt.outcome === "SUCCESS") {
        expect(noneDebt.fields.debtToEquity).toBeNull();
      }

      const noneEquity = await fetchAlphaVantageBalanceSheetForTicker({
        apiKey: "key",
        ticker: "APLD",
        fetchFn: balanceSheetFetch({ shortLongTermDebtTotal: "509991600", totalShareholderEquity: "-" }),
      });
      expect(noneEquity.outcome).toBe("SUCCESS");
      if (noneEquity.outcome === "SUCCESS") {
        expect(noneEquity.fields.debtToEquity).toBeNull();
      }
    });
  });
});
