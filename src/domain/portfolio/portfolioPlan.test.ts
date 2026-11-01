import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAN_LIMITS,
  canAdd,
  candidateBlockers,
  evaluatePlan,
  optimizePlan,
  themeKeyOf,
  type ExistingExposure,
  type PlanCandidate,
  type PlanCapital,
} from "./portfolioPlan";

const capital: PlanCapital = { accountValue: 10_680.91, availableToTrade: 7_124.91 };
const limits = DEFAULT_PLAN_LIMITS;

function candidate(overrides: Partial<PlanCandidate> & { ticker: string }): PlanCandidate {
  return {
    companyName: null,
    readiness: "PASS",
    gatingClear: true,
    score: 90,
    strike: 10,
    expiration: "2026-11-06",
    dte: 5,
    bidProceedsPerContract: 12,
    returnPct: 1.2,
    sector: "Technology",
    industry: null,
    theme: null,
    ethics: "OK",
    earningsVerifyReason: null,
    ...overrides,
  };
}

const upstPut: ExistingExposure = { ticker: "UPST", kind: "PUT", amount: 2_500, theme: "Fintech lending", sector: "Financial Services" };
const corzShares: ExistingExposure = { ticker: "CORZ", kind: "SHARES", amount: 1_450, theme: "AI infrastructure and bitcoin mining", sector: "Financial Services" };

describe("evaluatePlan", () => {
  it("never subtracts existing put collateral from Schwab's available cash a second time", () => {
    const result = evaluatePlan([candidate({ ticker: "HL", strike: 20 })], [upstPut], capital, limits);
    expect(result.newCollateral).toBe(2_000);
    expect(result.cashRemaining).toBe(5_124.91);
    expect(result.committedAfter).toBe(4_500);
    expect(result.valid).toBe(true);
  });

  it("blocks a trade that needs more cash than Schwab says is available", () => {
    const result = evaluatePlan([candidate({ ticker: "A", strike: 25 }), candidate({ ticker: "B", strike: 25, theme: "x" }), candidate({ ticker: "C", strike: 25, theme: "y" })], [], capital, limits);
    expect(result.cashRemaining).toBeLessThan(0);
    expect(result.violations.map((v) => v.code)).toContain("CASH");
  });

  it("enforces the per-company limit, counting shares already held in that company", () => {
    expect(evaluatePlan([candidate({ ticker: "HL", strike: 26 })], [], capital, limits).valid).toBe(true);
    expect(evaluatePlan([candidate({ ticker: "HL", strike: 27 })], [], capital, limits).violations.map((v) => v.code)).toContain("COMPANY");
    const withShares = evaluatePlan([candidate({ ticker: "CORZ", strike: 14, theme: "AI infrastructure and bitcoin mining" })], [corzShares], capital, limits);
    expect(withShares.violations.map((v) => v.code)).toContain("COMPANY");
  });

  it("treats the committed limit as a ceiling", () => {
    const heavy: ExistingExposure[] = [
      { ticker: "X", kind: "PUT", amount: 2_500, theme: "t1", sector: "s1" },
      { ticker: "Y", kind: "PUT", amount: 2_500, theme: "t2", sector: "s2" },
      { ticker: "Z", kind: "PUT", amount: 1_700, theme: "t3", sector: "s3" },
    ];
    const result = evaluatePlan([candidate({ ticker: "HL", strike: 20 })], heavy, capital, limits);
    expect(result.committedAfterPct).toBeGreaterThan(80);
    expect(result.violations.map((v) => v.code)).toContain("COMMITTED");
  });

  it("allows only one company per theme, including companies already held", () => {
    const sofi = candidate({ ticker: "SOFI", strike: 15, theme: "Fintech lending", sector: "Financial Services" });
    const result = evaluatePlan([sofi], [upstPut], capital, limits);
    expect(result.violations.map((v) => v.code)).toContain("THEME");
    expect(result.violations.find((v) => v.code === "THEME")?.message).toContain("UPST");
  });

  it("falls back to industry, then sector, when a company has no theme tag", () => {
    expect(themeKeyOf({ theme: null, industry: "Gold", sector: "Basic Materials" })).toBe("Gold");
    expect(themeKeyOf({ theme: null, industry: null, sector: "Basic Materials" })).toBe("Basic Materials");
    expect(themeKeyOf({ theme: null, industry: null, sector: null })).toBeNull();
    const result = evaluatePlan([candidate({ ticker: "ZZZ", sector: null })], [], capital, limits);
    expect(result.warnings.join(" ")).toContain("ZZZ has no sector");
  });

  it("only warns, never blocks, on a crowded sector", () => {
    const existing: ExistingExposure[] = [
      { ticker: "A", kind: "PUT", amount: 1_000, theme: "ta", sector: "Basic Materials" },
      { ticker: "B", kind: "PUT", amount: 1_000, theme: "tb", sector: "Basic Materials" },
    ];
    const result = evaluatePlan([candidate({ ticker: "C", strike: 10, theme: "tc", sector: "Basic Materials" })], existing, capital, limits);
    expect(result.valid).toBe(true);
    expect(result.warnings.join(" ")).toContain("3 companies in Basic Materials");
  });
});

describe("candidateBlockers", () => {
  it("keeps unreviewed, review-pending and excluded ethics out of recommendations", () => {
    expect(candidateBlockers(candidate({ ticker: "A", ethics: "UNREVIEWED" }), limits)).toContain("Ethics not researched yet");
    expect(candidateBlockers(candidate({ ticker: "A", ethics: "REVIEW" }), limits)).toContain("Ethics needs your review");
    expect(candidateBlockers(candidate({ ticker: "A", ethics: "BLOCKED" }), limits)).toContain("Excluded by ethics");
  });

  it("blocks on unclear gates, unverified earnings, missing bids and a return below the floor", () => {
    expect(candidateBlockers(candidate({ ticker: "A", gatingClear: false }), limits)).toHaveLength(1);
    expect(candidateBlockers(candidate({ ticker: "A", earningsVerifyReason: "stale" }), limits)).toContain("Earnings date needs checking");
    expect(candidateBlockers(candidate({ ticker: "A", bidProceedsPerContract: null }), limits)).toContain("No bid to sell into");
    expect(candidateBlockers(candidate({ ticker: "A", returnPct: 0.4 }), limits)[0]).toContain("below your 0.6% floor");
    expect(candidateBlockers(candidate({ ticker: "A" }), limits)).toEqual([]);
  });
});

describe("canAdd", () => {
  it("explains why a trade no longer fits after other selections", () => {
    const first = candidate({ ticker: "A", strike: 26, theme: "ta" });
    const second = candidate({ ticker: "B", strike: 26, theme: "tb" });
    const third = candidate({ ticker: "C", strike: 26, theme: "tc" });
    expect(canAdd(second, [first], [], capital, limits)).toEqual({ ok: true });
    const result = canAdd(third, [first, second], [], capital, limits);
    expect(result.ok).toBe(false);
  });
});

describe("optimizePlan", () => {
  it("picks the best-quality company per theme and never doubles up a theme", () => {
    const picks = optimizePlan(
      [
        candidate({ ticker: "AAA", strike: 10, theme: "mining", score: 80 }),
        candidate({ ticker: "BBB", strike: 12, theme: "mining", score: 95 }),
        candidate({ ticker: "CCC", strike: 20, theme: "quantum", score: 85 }),
      ],
      [],
      capital,
      limits,
    );
    expect(picks.picks.map((pick) => pick.ticker).sort()).toEqual(["BBB", "CCC"]);
    expect(picks.evaluation.valid).toBe(true);
  });

  it("ignores ineligible names however attractive, and leaves cash idle when nothing qualifies", () => {
    const result = optimizePlan(
      [
        candidate({ ticker: "NEW", ethics: "UNREVIEWED", score: 99, theme: "a" }),
        candidate({ ticker: "THIN", returnPct: 0.3, theme: "b" }),
        candidate({ ticker: "EARN", earningsVerifyReason: "no date on file", theme: "c" }),
      ],
      [],
      capital,
      limits,
    );
    expect(result.picks).toEqual([]);
    expect(result.evaluation.cashRemaining).toBe(capital.availableToTrade);
  });

  it("stops at the cash and ceiling limits instead of forcing more trades in", () => {
    const many = ["A", "B", "C", "D", "E", "F"].map((ticker, index) => candidate({ ticker, strike: 25, theme: `theme-${index}`, score: 90 - index }));
    const result = optimizePlan(many, [upstPut], capital, limits);
    expect(result.evaluation.valid).toBe(true);
    expect(result.picks.length).toBeLessThan(many.length);
    expect(result.evaluation.cashRemaining).toBeGreaterThanOrEqual(0);
    expect(result.evaluation.committedAfterPct).toBeLessThanOrEqual(80);
  });

  it("prefers a PASS over a NEAR, and never takes two contracts on one company", () => {
    const result = optimizePlan(
      [candidate({ ticker: "NEAR1", readiness: "NEAR", score: 99, theme: "x" }), candidate({ ticker: "PASS1", readiness: "PASS", score: 60, theme: "x" }), candidate({ ticker: "PASS1", readiness: "PASS", score: 59, strike: 11, theme: "x" })],
      [],
      capital,
      limits,
    );
    expect(result.picks.map((pick) => pick.ticker)).toEqual(["PASS1"]);
  });
});
