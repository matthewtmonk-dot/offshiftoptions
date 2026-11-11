import { describe, expect, it } from "vitest";
import { pickHoldBackReasons } from "./pickHoldBacks";
import { DEFAULT_PLAN_LIMITS as SHIPPED_DEFAULTS, type PlanCandidate } from "./portfolioPlan";

// Size limits enforced at any account size, to test the size-limit wording itself (the shipped default starts them at $25,000).
const DEFAULT_PLAN_LIMITS = { ...SHIPPED_DEFAULTS, sizeLimitsFromAccountValue: 0 };

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

  const noLargeSlot = { ...DEFAULT_PLAN_LIMITS, maxPerCompanyPct: 20, maxLargePositionPct: 20 };

  it("allows one contract above the normal limit when it fits the larger-position cap", () => {
    expect(pickHoldBackReasons(candidate({ strike: 44 }), DEFAULT_PLAN_LIMITS, 10_731)).toEqual([]);
  });

  it("flags one contract that is bigger than the larger-position cap", () => {
    const reasons = pickHoldBackReasons(candidate({ strike: 60 }), DEFAULT_PLAN_LIMITS, 10_731);
    expect(reasons).toEqual(["one contract holds $6,000 (55.9% of the account), over the 50% limit for one larger position"]);
  });

  it("uses the per-company limit when the larger-position exception is switched off", () => {
    const reasons = pickHoldBackReasons(candidate({ strike: 44 }), noLargeSlot, 10_731);
    expect(reasons).toEqual(["one contract holds $4,400 (41.0% of the account), over the 20% limit per company"]);
  });

  it("does not flag a contract exactly at the limit", () => {
    expect(pickHoldBackReasons(candidate({ strike: 20 }), noLargeSlot, 10_000)).toEqual([]);
  });

  it("keeps the planner's own blockers and adds the size reason after them", () => {
    const reasons = pickHoldBackReasons(
      candidate({ strike: 60, ethics: "UNREVIEWED", quality: { eligible: false, reason: "Company quality CAUTION: excluded unless you review it" } }),
      DEFAULT_PLAN_LIMITS,
      10_731,
    );
    expect(reasons).toEqual([
      "Ethics not researched yet",
      "Company quality CAUTION: excluded unless you review it",
      "one contract holds $6,000 (55.9% of the account), over the 50% limit for one larger position",
    ]);
  });

  it("skips the size check when the account value is unknown, but still reports other blockers", () => {
    expect(pickHoldBackReasons(candidate({ strike: 60 }), DEFAULT_PLAN_LIMITS, null)).toEqual([]);
    expect(pickHoldBackReasons(candidate({ strike: 60, gatingClear: false }), DEFAULT_PLAN_LIMITS, 0)).toEqual(["A required scanner rule is not a clear pass"]);
  });

  it("with the shipped defaults, size is not a hold-back on an account under $25,000 but is on a larger one", () => {
    expect(pickHoldBackReasons(candidate({ strike: 60 }), SHIPPED_DEFAULTS, 10_731)).toEqual([]);
    expect(pickHoldBackReasons(candidate({ strike: 160 }), SHIPPED_DEFAULTS, 30_000)).toEqual(["one contract holds $16,000 (53.3% of the account), over the 50% limit for one larger position"]);
  });
});
