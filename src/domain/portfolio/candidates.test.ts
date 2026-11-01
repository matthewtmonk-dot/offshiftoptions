import { describe, expect, it } from "vitest";
import { buildPlanCandidates, type ScannerRowForPlan } from "./candidates";
import { themeForTicker } from "./themes";

const values = { strike: 14, expiration: "2026-11-06", dte: 5, bidProceedsPerContract: 21, ror: 1.5, earningsVerifyReason: null };

function row(ticker: string, readiness: string, extra: Partial<ScannerRowForPlan> = {}): ScannerRowForPlan {
  return { ticker, readiness, gatingClear: true, score: 88, values, ...extra };
}

describe("buildPlanCandidates", () => {
  it("keeps only PASS and NEAR rows and marks companies without ethics research as UNREVIEWED", () => {
    const built = buildPlanCandidates(
      [row("RIOT", "PASS"), row("HL", "NEAR"), row("XYZ", "FAIL"), row("ABC", "NEEDS_DATA"), row("NEW", "PASS")],
      { RIOT: "OK", HL: "OK" },
      { RIOT: { companyName: "Riot Platforms", sector: "Financial Services", industry: "Capital Markets" } },
    );
    expect(built.map((candidate) => candidate.ticker)).toEqual(["RIOT", "HL", "NEW"]);
    expect(built.find((candidate) => candidate.ticker === "NEW")?.ethics).toBe("UNREVIEWED");
    expect(built[0]).toMatchObject({ companyName: "Riot Platforms", sector: "Financial Services", returnPct: 1.5, bidProceedsPerContract: 21 });
  });

  it("tags look-alike companies with the same theme regardless of their official sector", () => {
    expect(themeForTicker("corz")).toBe(themeForTicker("APLD"));
    expect(themeForTicker("UPST")).toBe(themeForTicker("SOFI"));
    expect(themeForTicker("UPST")).not.toBe(themeForTicker("CORZ"));
    expect(themeForTicker("NOPE")).toBeNull();
  });
});
