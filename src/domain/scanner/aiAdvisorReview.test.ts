import { describe, expect, it } from "vitest";
import { buildAiAdvisorPacket, type AiAdvisorPacketSourceCriterion } from "./aiAdvisorPacket";
import {
  AiAdvisorDecisionSchema,
  AiAdvisorReviewSchema,
  buildAiAdvisorDeveloperPrompt,
  buildAiAdvisorUserPrompt,
  buildHardRuleFailureGateResult,
  buildHardRuleUnknownGateResult,
  enforceHardRuleConsistency,
  hardRuleSummaryLabel,
  hardRuleSummaryState,
  LST_ADVISOR_PROMPT_VERSION,
  resolveAiAdvisorPresentation,
  scannerReadinessPresentation,
  type AiAdvisorReviewResult,
} from "./aiAdvisorReview";

function criterion(overrides: Partial<AiAdvisorPacketSourceCriterion> = {}): AiAdvisorPacketSourceCriterion {
  return {
    criterionName: "Stock price",
    actualValue: "45",
    operator: "GTE",
    desiredValue: "20",
    status: "PASS",
    explanation: "Stock price $45.00 is above the $20.00 minimum.",
    ...overrides,
  };
}

function packetWith(criteria: AiAdvisorPacketSourceCriterion[]) {
  return buildAiAdvisorPacket({ ticker: "XYZ", evaluatedAt: new Date("2026-10-10T20:00:00.000Z"), snapshot: { price: 45 }, criteria });
}

function reviewFixture(overrides: Partial<AiAdvisorReviewResult> = {}): AiAdvisorReviewResult {
  return {
    decision: "CONSIDER",
    confidence: "MEDIUM",
    headline: "Looks reasonable",
    summary: "A solid setup overall.",
    strongestReasons: ["Good premium"],
    mainConcerns: [],
    hardRuleFailures: [],
    unknownCriticalEvidence: [],
    softPreferenceNotes: [],
    whatWouldChangeDecision: [],
    riskNotes: [],
    ...overrides,
  };
}

describe("AiAdvisorDecisionSchema - SKIP replaces the old ambiguous PASS value", () => {
  it("accepts SKIP as a valid decision", () => {
    expect(AiAdvisorDecisionSchema.safeParse("SKIP").success).toBe(true);
  });

  it("no longer accepts the old PASS value - Scanner already owns PASS to mean a deterministic pass, never 'skip this candidate'", () => {
    expect(AiAdvisorDecisionSchema.safeParse("PASS").success).toBe(false);
  });
});

describe("AiAdvisorReviewSchema - strict structured output contract", () => {
  it("accepts a well-formed review", () => {
    expect(AiAdvisorReviewSchema.safeParse(reviewFixture()).success).toBe(true);
  });

  it("rejects an invented decision value (e.g. BUY) - only the four conservative decision-support values are valid", () => {
    const result = AiAdvisorReviewSchema.safeParse({ ...reviewFixture(), decision: "BUY" });
    expect(result.success).toBe(false);
  });

  it("rejects an array exceeding its bounded max length", () => {
    const result = AiAdvisorReviewSchema.safeParse({ ...reviewFixture(), strongestReasons: ["a", "b", "c", "d", "e"] });
    expect(result.success).toBe(false);
  });
});

describe("prompt building", () => {
  it("has a stable, versioned prompt identity", () => {
    expect(LST_ADVISOR_PROMPT_VERSION).toBe("v1");
  });

  it("the developer prompt instructs the model never to override a deterministic rule status or treat UNKNOWN as a pass", () => {
    const prompt = buildAiAdvisorDeveloperPrompt();
    expect(prompt).toMatch(/never.*recompute|never.*override/i);
    expect(prompt).toMatch(/UNKNOWN/);
    expect(prompt).toMatch(/final decision always belongs to the user/i);
  });

  it("the developer prompt never implies an order is or should be placed automatically", () => {
    const prompt = buildAiAdvisorDeveloperPrompt();
    expect(prompt.toLowerCase()).not.toMatch(/place the order|execute the trade|buy now|sell now/);
  });

  it("the developer prompt uses SKIP, never PASS, for the decline-this-candidate decision", () => {
    const prompt = buildAiAdvisorDeveloperPrompt();
    expect(prompt).toMatch(/- SKIP:/);
    expect(prompt).not.toMatch(/- PASS:/);
  });

  it("the user prompt frames the packet as DATA, not instructions - prompt-injection resistance", () => {
    const packet = packetWith([criterion()]);
    const prompt = buildAiAdvisorUserPrompt(packet);
    expect(prompt).toMatch(/DATA ONLY/);
    expect(prompt).toContain(JSON.stringify(packet, null, 2));
  });
});

/**
 * enforceHardRuleConsistency - now only ever reachable (via src/lib/ai-advisor.ts) with a packet
 * whose hard rules are already known-passing, but still tested directly here as the independent
 * backstop it is: even if something upstream ever changes, it must still be unable to describe a
 * hard-rule-failing/unknown candidate as CONSIDER.
 */
describe("enforceHardRuleConsistency", () => {
  it("a hard-rule FAIL survives even when the model's own hardRuleFailures array is empty", () => {
    const packet = packetWith([criterion({ criterionName: "Stock price", status: "FAIL", explanation: "Below minimum price." })]);
    const review = enforceHardRuleConsistency(packet, reviewFixture({ decision: "SKIP", hardRuleFailures: [] }));
    expect(review.hardRuleFailures).toEqual([{ ruleId: "price", explanation: "Below minimum price." }]);
  });

  it("downgrades a model-returned CONSIDER to SKIP when a hard rule actually failed - never shows a hard-rule-failing candidate as worth considering", () => {
    const packet = packetWith([criterion({ criterionName: "Stock price", status: "FAIL" })]);
    const review = enforceHardRuleConsistency(packet, reviewFixture({ decision: "CONSIDER" }));
    expect(review.decision).toBe("SKIP");
    expect(review.mainConcerns[0]).toMatch(/hard LST rule failed/i);
  });

  it("downgrades CONSIDER when a hard rule is UNKNOWN too, not only FAIL", () => {
    const packet = packetWith([criterion({ criterionName: "Stock price", status: "UNKNOWN", actualValue: null })]);
    const review = enforceHardRuleConsistency(packet, reviewFixture({ decision: "CONSIDER" }));
    expect(review.decision).toBe("SKIP");
  });

  it("leaves a genuinely clean CONSIDER untouched when every hard rule passes", () => {
    const packet = packetWith([criterion({ criterionName: "Stock price", status: "PASS" })]);
    const review = enforceHardRuleConsistency(packet, reviewFixture({ decision: "CONSIDER" }));
    expect(review.decision).toBe("CONSIDER");
  });

  it("a soft-preference FAIL never downgrades CONSIDER - only HARD rules gate the decision", () => {
    const packet = packetWith([criterion({ criterionName: "RSI", status: "FAIL" })]);
    const review = enforceHardRuleConsistency(packet, reviewFixture({ decision: "CONSIDER" }));
    expect(review.decision).toBe("CONSIDER");
  });

  it("WATCH/SKIP/INSUFFICIENT_DATA decisions are never altered even with a hard-rule failure present", () => {
    const packet = packetWith([criterion({ criterionName: "Stock price", status: "FAIL" })]);
    for (const decision of ["WATCH", "SKIP", "INSUFFICIENT_DATA"] as const) {
      expect(enforceHardRuleConsistency(packet, reviewFixture({ decision })).decision).toBe(decision);
    }
  });
});

describe("buildHardRuleFailureGateResult / buildHardRuleUnknownGateResult - deterministic, no model text involved", () => {
  it("a hard FAIL produces a deterministic SKIP with the authoritative failure list, not model prose", () => {
    const packet = packetWith([criterion({ criterionName: "Stock price", status: "FAIL", explanation: "Below minimum price." })]);
    const review = buildHardRuleFailureGateResult(packet);
    expect(review.decision).toBe("SKIP");
    expect(review.headline).toBe("Hard LST rule failed.");
    expect(review.hardRuleFailures).toEqual([{ ruleId: "price", explanation: "Below minimum price." }]);
  });

  it("a hard UNKNOWN (no FAIL) produces a deterministic INSUFFICIENT_DATA, never 'all passed'", () => {
    const packet = packetWith([criterion({ criterionName: "Stock price", status: "UNKNOWN", actualValue: null, explanation: "Stock price is unknown for this candidate." })]);
    const review = buildHardRuleUnknownGateResult(packet);
    expect(review.decision).toBe("INSUFFICIENT_DATA");
    expect(review.headline).toBe("Critical LST evidence is still unknown.");
    expect(review.unknownCriticalEvidence).toEqual(["Stock price is unknown for this candidate."]);
    expect(review.hardRuleFailures).toEqual([]);
  });
});

describe("hardRuleSummaryState / hardRuleSummaryLabel - exactly one of three correct states", () => {
  it("FAILED whenever there is at least one hard-rule failure, regardless of unknowns", () => {
    expect(hardRuleSummaryState(1, 3)).toBe("FAILED");
    expect(hardRuleSummaryLabel(hardRuleSummaryState(1, 0))).toBe("HARD RULES — FAILED");
  });

  it("UNKNOWN when there is no failure but at least one unknown - never 'All passed'", () => {
    expect(hardRuleSummaryState(0, 1)).toBe("UNKNOWN");
    expect(hardRuleSummaryLabel(hardRuleSummaryState(0, 1))).toBe("HARD RULES — UNKNOWN");
    expect(hardRuleSummaryLabel(hardRuleSummaryState(0, 1))).not.toMatch(/all passed/i);
  });

  it("ALL_PASSED only when there is neither a failure nor an unknown", () => {
    expect(hardRuleSummaryState(0, 0)).toBe("ALL_PASSED");
    expect(hardRuleSummaryLabel(hardRuleSummaryState(0, 0))).toBe("HARD RULES — ALL PASSED");
  });
});

describe("resolveAiAdvisorPresentation - the ticket's exact badge/color scenarios", () => {
  it("5. all hard PASS + Scanner PASS + AI CONSIDER -> green CONSIDER", () => {
    const presentation = resolveAiAdvisorPresentation({ decision: "CONSIDER", reviewSource: "MODEL", scannerReadiness: "PASS" });
    expect(presentation).toEqual({ label: "CONSIDER", tone: "good" });
  });

  it("6. all hard PASS + soft FAIL + Scanner FAIL + AI CONSIDER -> amber CONSIDER WITH TRADEOFFS", () => {
    const presentation = resolveAiAdvisorPresentation({ decision: "CONSIDER", reviewSource: "MODEL", scannerReadiness: "FAIL" });
    expect(presentation).toEqual({ label: "CONSIDER WITH TRADEOFFS", tone: "warn" });
  });

  it("a NEAR or NEEDS_DATA Scanner readiness with an AI CONSIDER is also treated as tradeoffs, never a plain green CONSIDER", () => {
    expect(resolveAiAdvisorPresentation({ decision: "CONSIDER", reviewSource: "MODEL", scannerReadiness: "NEAR" }).label).toBe("CONSIDER WITH TRADEOFFS");
    expect(resolveAiAdvisorPresentation({ decision: "CONSIDER", reviewSource: "MODEL", scannerReadiness: "NEEDS_DATA" }).label).toBe("CONSIDER WITH TRADEOFFS");
  });

  it("a hard-rule gate always reads SKIP — HARD RULE FAILED, regardless of the (never-called) model's decision field", () => {
    const presentation = resolveAiAdvisorPresentation({ decision: "SKIP", reviewSource: "HARD_RULE_GATE", scannerReadiness: "FAIL" });
    expect(presentation).toEqual({ label: "SKIP — HARD RULE FAILED", tone: "bad" });
  });

  it("a hard-unknown gate always reads INSUFFICIENT DATA — CRITICAL EVIDENCE UNKNOWN", () => {
    const presentation = resolveAiAdvisorPresentation({ decision: "INSUFFICIENT_DATA", reviewSource: "HARD_UNKNOWN_GATE", scannerReadiness: "NEEDS_DATA" });
    expect(presentation).toEqual({ label: "INSUFFICIENT DATA — CRITICAL EVIDENCE UNKNOWN", tone: "info" });
  });

  it("7. AI SKIP terminology - a plain model SKIP never renders as the old ambiguous PASS label", () => {
    const presentation = resolveAiAdvisorPresentation({ decision: "SKIP", reviewSource: "MODEL", scannerReadiness: "FAIL" });
    expect(presentation.label).toBe("SKIP");
    expect(presentation.label).not.toMatch(/^PASS$/);
  });

  it("WATCH renders plainly regardless of Scanner readiness", () => {
    expect(resolveAiAdvisorPresentation({ decision: "WATCH", reviewSource: "MODEL", scannerReadiness: "FAIL" })).toEqual({ label: "WATCH", tone: "warn" });
  });
});

describe("scannerReadinessPresentation - the always-shown deterministic Scanner chip", () => {
  it("maps each ScannerReadiness value to a distinct label/tone", () => {
    expect(scannerReadinessPresentation("PASS")).toEqual({ label: "PASS", tone: "good" });
    expect(scannerReadinessPresentation("NEAR")).toEqual({ label: "NEAR", tone: "warn" });
    expect(scannerReadinessPresentation("NEEDS_DATA")).toEqual({ label: "NEEDS DATA", tone: "info" });
    expect(scannerReadinessPresentation("FAIL")).toEqual({ label: "FAIL", tone: "bad" });
  });
});
