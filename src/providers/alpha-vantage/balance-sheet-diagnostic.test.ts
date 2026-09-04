import { describe, expect, it } from "vitest";
import { buildAlphaVantageBalanceSheetDiagnosticFromApiKey } from "./balance-sheet-diagnostic";

function fetchFnReturning(payload: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status })) as unknown as typeof fetch;
}

describe("buildAlphaVantageBalanceSheetDiagnosticFromApiKey", () => {
  it("defaults to the hardcoded APLD ticker and reports SUCCESS with the computed Current Ratio", async () => {
    const report = await buildAlphaVantageBalanceSheetDiagnosticFromApiKey({
      apiKey: "key",
      fetchFn: fetchFnReturning({
        symbol: "APLD",
        quarterlyReports: [
          {
            fiscalDateEnding: "2026-06-30",
            reportedCurrency: "USD",
            totalCurrentAssets: "5000000",
            totalCurrentLiabilities: "2000000",
            shortLongTermDebtTotal: "1000000",
          },
        ],
      }),
    });
    expect(report.ticker).toBe("APLD");
    expect(report.outcome).toBe("SUCCESS");
    expect(report.computedCurrentRatio).toBe(2.5);
    expect(report.nothingSaved).toBe(true);
    expect(report.readOnly).toBe(true);

    const totalCurrentAssetsRow = report.rows.find((row) => row.key === "totalCurrentAssets");
    expect(totalCurrentAssetsRow?.presence).toMatchObject({ state: "PRESENT_VALUE", value: "5000000" });

    const currentDebtRow = report.rows.find((row) => row.key === "currentDebt");
    expect(currentDebtRow?.presence.state).toBe("ABSENT");

    const shortLongTermDebtRow = report.rows.find((row) => row.key === "shortLongTermDebtTotal");
    expect(shortLongTermDebtRow?.presence).toMatchObject({ state: "PRESENT_VALUE", value: "1000000" });
  });

  it("preserves ABSENT vs PRESENT_NULL vs PRESENT_VALUE exactly, same as the OVERVIEW diagnostic", async () => {
    const report = await buildAlphaVantageBalanceSheetDiagnosticFromApiKey({
      apiKey: "key",
      fetchFn: fetchFnReturning({
        symbol: "APLD",
        quarterlyReports: [
          { fiscalDateEnding: "2026-06-30", totalCurrentAssets: "None", totalCurrentLiabilities: "2000000" },
        ],
      }),
    });
    expect(report.outcome).toBe("SUCCESS");
    expect(report.computedCurrentRatio).toBeNull();
    const assetsRow = report.rows.find((row) => row.key === "totalCurrentAssets");
    expect(assetsRow?.presence.state).toBe("PRESENT_NULL");
    const shortTermDebtRow = report.rows.find((row) => row.key === "shortTermDebt");
    expect(shortTermDebtRow?.presence.state).toBe("ABSENT");
  });

  it("never divides by zero - a zero totalCurrentLiabilities yields a null computed ratio, not Infinity", async () => {
    const report = await buildAlphaVantageBalanceSheetDiagnosticFromApiKey({
      apiKey: "key",
      fetchFn: fetchFnReturning({
        symbol: "APLD",
        quarterlyReports: [{ fiscalDateEnding: "2026-06-30", totalCurrentAssets: "5000000", totalCurrentLiabilities: "0" }],
      }),
    });
    expect(report.computedCurrentRatio).toBeNull();
  });

  it("classifies a Note field as RATE_LIMITED and reports no rows as present", async () => {
    const report = await buildAlphaVantageBalanceSheetDiagnosticFromApiKey({
      apiKey: "key",
      fetchFn: fetchFnReturning({ Note: "Please consider spreading out your free API requests more sparingly." }),
    });
    expect(report.outcome).toBe("RATE_LIMITED");
    expect(report.computedCurrentRatio).toBeNull();
    expect(report.rows.every((row) => row.presence.state === "ABSENT")).toBe(true);
  });

  it("classifies no quarterly reports as EMPTY rather than fabricating a ratio", async () => {
    const report = await buildAlphaVantageBalanceSheetDiagnosticFromApiKey({
      apiKey: "key",
      fetchFn: fetchFnReturning({ symbol: "APLD", quarterlyReports: [] }),
    });
    expect(report.outcome).toBe("EMPTY");
    expect(report.computedCurrentRatio).toBeNull();
  });

  it("redacts the API key from any returned message", async () => {
    const report = await buildAlphaVantageBalanceSheetDiagnosticFromApiKey({
      apiKey: "super-secret-key",
      fetchFn: fetchFnReturning({ Note: "Your key super-secret-key has been throttled." }),
    });
    expect(report.message).not.toContain("super-secret-key");
  });

  it("never includes a raw payload dump - only the strict allowlisted field set", async () => {
    const report = await buildAlphaVantageBalanceSheetDiagnosticFromApiKey({
      apiKey: "key",
      fetchFn: fetchFnReturning({
        symbol: "APLD",
        quarterlyReports: [
          {
            fiscalDateEnding: "2026-06-30",
            totalCurrentAssets: "5000000",
            totalCurrentLiabilities: "2000000",
            someUnexpectedField: "should never appear",
          },
        ],
      }),
    });
    const keys = report.rows.map((row) => row.key);
    expect(keys).not.toContain("someUnexpectedField");
    expect(JSON.stringify(report)).not.toContain("should never appear");
  });
});
