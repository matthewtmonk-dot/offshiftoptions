import { describe, expect, it } from "vitest";
import { evaluateCompanyQuality, isFinancialSic, isMixedSic, type CompanyFacts } from "./companyQuality";
import { parseCompanyFacts, trailingTwelveMonths } from "./secCompanyFacts";

const healthy: CompanyFacts = {
  sic: 3571, dataAgeDays: 60, ocfTtm: 500, capexTtm: 100, ocfLast2Q: 250, capexLast2Q: 50,
  cash: 800, liquidInvestments: 200, debtDue12m: 100, equity: 2_000, currentAssets: 1_500, currentLiabilities: 900,
  sharesNow: 100, sharesYearAgo: 99, goingConcernDoubt: null,
};

describe("evaluateCompanyQuality", () => {
  it("A: positive free cash flow and no flags", () => {
    const quality = evaluateCompanyQuality(healthy);
    expect(quality.tier).toBe("A");
    expect(quality.eligibleForAutomaticPass).toBe(true);
    expect(quality.fcfTtm).toBe(400);
    expect(quality.reasons.join(" ")).toMatch(/Going-concern language is not checked/);
  });

  it("B: positive cash flow but a weak current ratio or heavy dilution", () => {
    expect(evaluateCompanyQuality({ ...healthy, currentAssets: 900, currentLiabilities: 1_000 }).tier).toBe("B");
    const diluted = evaluateCompanyQuality({ ...healthy, sharesNow: 125 });
    expect(diluted.tier).toBe("B");
    expect(diluted.reasons.join(" ")).toMatch(/dilution/);
  });

  it("burning cash: 8+ quarters of runway is B, 4-8 is CAUTION, under 4 is REJECT", () => {
    // FCF = -400/yr -> burn 100/quarter. Liquid = cash + investments - debt due.
    const burner = { ...healthy, ocfTtm: -300, capexTtm: 100, ocfLast2Q: null, capexLast2Q: null, liquidInvestments: 0, debtDue12m: 0 };
    const b = evaluateCompanyQuality({ ...burner, cash: 900 }); // 9 quarters
    expect(b.tier).toBe("B");
    expect(b.runwayQuarters).toBeCloseTo(9);
    const caution = evaluateCompanyQuality({ ...burner, cash: 600 }); // 6 quarters
    expect(caution.tier).toBe("CAUTION");
    expect(caution.eligibleForAutomaticPass).toBe(false);
    const reject = evaluateCompanyQuality({ ...burner, cash: 300 }); // 3 quarters
    expect(reject.tier).toBe("REJECT");
    expect(reject.reasons.join(" ")).toMatch(/3 quarters/);
  });

  it("debt due within a year shrinks the runway, and no usable cash is zero runway", () => {
    const burner = { ...healthy, ocfTtm: -300, capexTtm: 100, ocfLast2Q: null, capexLast2Q: null, liquidInvestments: 0, cash: 900 };
    // Burn is 100 a quarter. 900 - 500 = 400 liquid = exactly 4 quarters: the CAUTION floor (REJECT is strictly under 4).
    expect(evaluateCompanyQuality({ ...burner, debtDue12m: 500 }).tier).toBe("CAUTION");
    expect(evaluateCompanyQuality({ ...burner, debtDue12m: 600 }).tier).toBe("REJECT"); // 3 quarters
    const underwater = evaluateCompanyQuality({ ...burner, debtDue12m: 1_500 }); // debt due exceeds all liquid cash
    expect(underwater.tier).toBe("REJECT");
    expect(underwater.runwayQuarters).toBe(0);
  });

  it("recent acceleration of burn counts even when the trailing year looks fine", () => {
    // TTM FCF is +100 (burn 0) but the last two quarters burned 300 combined -> 150/quarter.
    const accelerating = { ...healthy, ocfTtm: 150, capexTtm: 50, ocfLast2Q: -250, capexLast2Q: 50, cash: 600, liquidInvestments: 0, debtDue12m: 0 };
    const quality = evaluateCompanyQuality(accelerating);
    expect(quality.runwayQuarters).toBeCloseTo(4);
    expect(quality.tier).toBe("CAUTION");
  });

  it("VERIFY: missing essentials, stale data, financial companies, or negative equity - never an automatic pass", () => {
    expect(evaluateCompanyQuality({ ...healthy, ocfTtm: null }).tier).toBe("VERIFY");
    expect(evaluateCompanyQuality({ ...healthy, equity: null }).tier).toBe("VERIFY");
    expect(evaluateCompanyQuality({ ...healthy, dataAgeDays: 900 }).tier).toBe("VERIFY");
    expect(evaluateCompanyQuality({ ...healthy, dataAgeDays: null }).tier).toBe("VERIFY");
    expect(evaluateCompanyQuality({ ...healthy, sic: 6021 }).tier).toBe("VERIFY");
    expect(evaluateCompanyQuality({ ...healthy, sic: 6798 }).tier).toBe("VERIFY");
    // Negative equity while NOT generating free cash flow needs a human look.
    const negative = evaluateCompanyQuality({ ...healthy, equity: -50, ocfTtm: 50, capexTtm: 100, ocfLast2Q: null, capexLast2Q: null });
    expect(negative.tier).toBe("VERIFY");
    expect(negative.eligibleForAutomaticPass).toBe(false);
  });

  it("negative equity with strong free cash flow (buyback-style) is a B, not a block", () => {
    const quality = evaluateCompanyQuality({ ...healthy, equity: -50 });
    expect(quality.tier).toBe("B");
    expect(quality.eligibleForAutomaticPass).toBe(true);
    expect(quality.reasons.join(" ")).toMatch(/equity is negative/);
  });

  it("banks, lenders, brokers, insurers and REITs are VERIFY; ordinary industrial codes are not", () => {
    for (const sic of [6021, 6141, 6211, 6331, 6512, 6798]) expect(isFinancialSic(sic)).toBe(true);
    for (const sic of [3571, 3812, 7372, 6199, 6770, null]) expect(isFinancialSic(sic)).toBe(false);
  });

  it("the catch-all finance code can earn A/B but can never be REJECTed or CAUTIONed by the cash-flow rules", () => {
    expect(isMixedSic(6199)).toBe(true);
    const burner = { ...healthy, sic: 6199, ocfTtm: -300, capexTtm: 100, ocfLast2Q: null, capexLast2Q: null, liquidInvestments: 0, debtDue12m: 0 };
    const distressed = evaluateCompanyQuality({ ...burner, cash: 300 }); // would be REJECT (3 quarters)
    expect(distressed.tier).toBe("VERIFY");
    expect(distressed.reasons.join(" ")).toMatch(/needs a human check/);
    expect(evaluateCompanyQuality({ ...burner, cash: 600 }).tier).toBe("VERIFY"); // would be CAUTION
    expect(evaluateCompanyQuality({ ...burner, cash: 900 }).tier).toBe("B"); // 9 quarters
    expect(evaluateCompanyQuality({ ...healthy, sic: 6199 }).tier).toBe("A");
  });

  it("REJECT only on a confirmed going-concern doubt or clear cash distress; unknown going-concern does not reject", () => {
    expect(evaluateCompanyQuality({ ...healthy, goingConcernDoubt: true }).tier).toBe("REJECT");
    expect(evaluateCompanyQuality({ ...healthy, goingConcernDoubt: null }).tier).toBe("A");
  });

  it("notes when capital spending is missing instead of silently treating FCF as exact", () => {
    const quality = evaluateCompanyQuality({ ...healthy, capexTtm: null });
    expect(quality.tier).toBe("A");
    expect(quality.reasons.join(" ")).toMatch(/Capital spending was not found/);
  });
});

// --- SEC Company Facts parsing --------------------------------------------------------------------------------------
const flow = (start: string, end: string, val: number, filed = end) => ({ start, end, val, form: "10-Q", filed });
const instant = (end: string, val: number, filed = end) => ({ end, val, form: "10-Q", filed });
const wrap = (facts: Record<string, unknown[]>, dei: unknown[] = []) => ({
  facts: {
    "us-gaap": Object.fromEntries(Object.entries(facts).map(([concept, rows]) => [concept, { units: { USD: rows } }])),
    dei: { EntityCommonStockSharesOutstanding: { units: { shares: dei } } },
  },
});

describe("trailingTwelveMonths", () => {
  it("builds the TTM as latest fiscal year + latest year-to-date - the same year-to-date a year earlier (no double counting)", () => {
    const rows = [
      flow("2024-01-01", "2024-12-31", 400), // FY2024
      flow("2024-01-01", "2024-06-30", 150), // H1 2024 (prior-year same window)
      flow("2025-01-01", "2025-06-30", 220), // H1 2025 (latest YTD)
      flow("2025-01-01", "2025-03-31", 100), // Q1 2025 - overlaps H1 and must not be added
    ];
    const result = trailingTwelveMonths(rows);
    expect(result.ttm).toBe(400 + 220 - 150);
    expect(result.last2Q).toBe(220);
    expect(result.latestEnd).toBe("2025-06-30");
  });

  it("uses the fiscal-year total when nothing newer has been reported", () => {
    expect(trailingTwelveMonths([flow("2024-01-01", "2024-12-31", 400)])).toEqual({ ttm: 400, last2Q: null, latestEnd: "2024-12-31" });
  });

  it("returns null (never a guess) when the prior-year comparison window is missing", () => {
    const rows = [flow("2024-01-01", "2024-12-31", 400), flow("2025-01-01", "2025-06-30", 220)];
    expect(trailingTwelveMonths(rows).ttm).toBeNull();
  });

  it("prefers the most recently filed value when a period was restated", () => {
    const rows = [flow("2024-01-01", "2024-12-31", 100, "2025-02-01"), flow("2024-01-01", "2024-12-31", 120, "2025-08-01")];
    expect(trailingTwelveMonths(rows).ttm).toBe(120);
  });

  it("has no quarter-only figure after three quarters (it cannot be derived from year-to-date data)", () => {
    const rows = [
      flow("2024-01-01", "2024-12-31", 400), flow("2024-01-01", "2024-09-30", 300),
      flow("2025-01-01", "2025-09-30", 360), flow("2025-01-01", "2025-06-30", 220),
    ];
    const result = trailingTwelveMonths(rows);
    expect(result.ttm).toBe(400 + 360 - 300);
    expect(result.last2Q).toBeNull();
  });
});

describe("parseCompanyFacts", () => {
  const json = wrap(
    {
      NetCashProvidedByUsedInOperatingActivities: [flow("2024-01-01", "2024-12-31", -300), flow("2024-01-01", "2024-06-30", -140), flow("2025-01-01", "2025-06-30", -120)],
      PaymentsToAcquirePropertyPlantAndEquipment: [flow("2024-01-01", "2024-12-31", 80), flow("2024-01-01", "2024-06-30", 40), flow("2025-01-01", "2025-06-30", 30)],
      CashAndCashEquivalentsAtCarryingValue: [instant("2025-06-30", 900)],
      ShortTermInvestments: [instant("2025-06-30", 100), instant("2024-12-31", 50)],
      LongTermDebtCurrent: [instant("2025-06-30", 25)],
      StockholdersEquity: [instant("2025-06-30", 700)],
      AssetsCurrent: [instant("2025-06-30", 1_100)],
      LiabilitiesCurrent: [instant("2025-06-30", 500)],
    },
    [instant("2024-08-01", 100), instant("2025-08-01", 130)],
  );

  it("normalizes balance-sheet items at the cash date, flows to a TTM, and shares to a year-over-year pair", () => {
    const facts = parseCompanyFacts(json, { now: new Date("2025-09-15T00:00:00Z"), sic: 7372 });
    expect(facts).toMatchObject({
      sic: 7372,
      ocfTtm: -300 + -120 - -140,
      capexTtm: 80 + 30 - 40,
      ocfLast2Q: -120,
      capexLast2Q: 30,
      cash: 900, liquidInvestments: 100, debtDue12m: 25, equity: 700, currentAssets: 1_100, currentLiabilities: 500,
      sharesNow: 130, sharesYearAgo: 100, goingConcernDoubt: null,
    });
    expect(facts.dataAgeDays).toBe(77);
  });

  it("flows end to end into a tier", () => {
    const quality = evaluateCompanyQuality(parseCompanyFacts(json, { now: new Date("2025-09-15T00:00:00Z"), sic: 7372 }));
    // FCF TTM = (-280) - 70 = -350 -> 87.5/quarter; last 2Q = (-120 - 30)/2 = 75 -> burn 87.5; liquid = 900 + 100 - 25 = 975 -> 11 quarters.
    expect(quality.runwayQuarters).toBeCloseTo(975 / 87.5);
    expect(quality.tier).toBe("B");
  });

  it("returns empty facts (and so VERIFY) for junk or missing data instead of throwing", () => {
    for (const junk of [null, undefined, {}, { facts: {} }, "nope", 42]) {
      const facts = parseCompanyFacts(junk, { now: new Date("2025-09-15T00:00:00Z") });
      expect(facts.ocfTtm).toBeNull();
      expect(evaluateCompanyQuality(facts).tier).toBe("VERIFY");
    }
  });
});

describe("parseCompanyFacts concept choice (found on real HPQ data)", () => {
  it("uses the alternative concept name when the common name only has ancient rows", () => {
    const json = wrap({
      NetCashProvidedByUsedInOperatingActivities: [flow("2024-01-01", "2024-12-31", 500)],
      // Stale 2008-style rows under the usual capex name must not hide the real, current figure under the other name.
      PaymentsToAcquirePropertyPlantAndEquipment: [flow("2007-11-01", "2008-07-31", 1_966)],
      PaymentsToAcquireProductiveAssets: [flow("2024-01-01", "2024-12-31", 90)],
      CashAndCashEquivalentsAtCarryingValue: [instant("2024-12-31", 700)],
    });
    const facts = parseCompanyFacts(json, { now: new Date("2025-02-15T00:00:00Z") });
    expect(facts.capexTtm).toBe(90);
    expect(facts.ocfTtm).toBe(500);
  });
});
