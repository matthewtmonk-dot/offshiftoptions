import { describe, expect, it } from "vitest";
import { pickHoldBackReasons } from "./pickHoldBacks";
import { DEFAULT_PLAN_LIMITS, type PlanCandidate } from "./portfolioPlan";

function candidate(overrides: Partial<PlanCandidate> = {}): PlanCandidate {
  return {
    ticker: "WORK",
    companyName: null,
    readiness: "PASS",
    gatingClear: true,
    score: 100,
    strike: 10,
    expiration: "2026-11-20",
    dte: 7,
    bidProceedsPerContract: 40,
    returnPct: 1.2,
    sector: null,
    industry: null,
    theme: null,
    ethics: "OK",
    earningsVerifyReason: null,
    quality: null,
    ...overrides,
  };
}

describe("pickHoldBackReasons", () => {
  it("returns nothing for a clean candidate that fits the per-company limit", () => {
    expect(pickHoldBackReasons(candidate(), DEFAULT_PLAN_LIMITS, 10_000)).toEqual([]);
  });

  it("flags one contract that is bigger than the per-company limit", () => {
    const reasons = pickHoldBackReasons(candidate({ strike: 44 }), DEFAULT_PLAN_LIMITS, 10_731);
    expect(reasons).toEqual(["one contract holds $4,400 (41.0% of the account), over the 20% per-company limit"]);
  });

  it("does not flag a contract exactly at the limit", () => {
    expect(pickHoldBackReasons(candidate({ strike: 20 }), DEFAULT_PLAN_LIMITS, 10_000)).toEqual([]);
  });

  it("keeps the planner's own blockers and adds the size reason after them", () => {
    const reasons = pickHoldBackReasons(
      candidate({ strike: 27.5, ethics: "UNREVIEWED", quality: { eligible: false, reason: "Company quality CAUTION: excluded unless you review it" } }),
      DEFAULT_PLAN_LIMITS,
      10_731,
    );
    expect(reasons).toEqual([
      "Ethics not researched yet",
      "Company quality CAUTION: excluded unless you review it",
      "one contract holds $2,750 (25.6% of the account), over the 20% per-company limit",
    ]);
  });

  it("skips the size check when the account value is unknown, but still reports other blockers", () => {
    expect(pickHoldBackReasons(candidate({ strike: 44 }), DEFAULT_PLAN_LIMITS, null)).toEqual([]);
    expect(pickHoldBackReasons(candidate({ strike: 44, gatingClear: false }), DEFAULT_PLAN_LIMITS, 0)).toEqual(["A required scanner rule is not a clear pass"]);
  });
});
