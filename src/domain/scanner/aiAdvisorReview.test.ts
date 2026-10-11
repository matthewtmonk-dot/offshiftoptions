import { describe, expect, it } from "vitest";
import { buildAiAdvisorPacket, type AiAdvisorPacketSourceCriterion } from "./aiAdvisorPacket";
import { AiAdvisorReviewSchema, buildAiAdvisorDeveloperPrompt, buildAiAdvisorUserPrompt, enforceHardRuleConsistency, LST_ADVISOR_PROMPT_VERSION, type AiAdvisorReviewResult } from "./aiAdvisorReview";

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

  it("the user prompt frames the packet as DATA, not instructions - prompt-injection resistance", () => {
    const packet = packetWith([criterion()]);
    const prompt = buildAiAdvisorUserPrompt(packet);
    expect(prompt).toMatch(/DATA ONLY/);
    expect(prompt).toContain(JSON.stringify(packet, null, 2));
  });
});

/**
 * enforceHardRuleConsistency - the actual Codex-relevant test: a hard-rule failure (or UNKNOWN)
 * can never disappear from the rendered result, and the model's own decision is never trusted to
 * describe a hard-rule-failing candidate as CONSIDER.
 */
describe("enforceHardRuleConsistency", () => {
  it("a hard-rule FAIL survives even when the model's own hardRuleFailures array is empty", () => {
    const packet = packetWith([criterion({ criterionName: "Stock price", status: "FAIL", explanation: "Below minimum price." })]);
    const review = enforceHardRuleConsistency(packet, reviewFixture({ decision: "PASS", hardRuleFailures: [] }));
    expect(review.hardRuleFailures).toEqual([{ ruleId: "price", explanation: "Below minimum price." }]);
  });

  it("downgrades a model-returned CONSIDER to PASS when a hard rule actually failed - never shows a hard-rule-failing candidate as worth considering", () => {
    const packet = packetWith([criterion({ criterionName: "Stock price", status: "FAIL" })]);
    const review = enforceHardRuleConsistency(packet, reviewFixture({ decision: "CONSIDER" }));
    expect(review.decision).toBe("PASS");
    expect(review.mainConcerns[0]).toMatch(/hard LST rule failed/i);
  });

  it("downgrades CONSIDER when a hard rule is UNKNOWN too, not only FAIL", () => {
    const packet = packetWith([criterion({ criterionName: "Stock price", status: "UNKNOWN", actualValue: null })]);
    const review = enforceHardRuleConsistency(packet, reviewFixture({ decision: "CONSIDER" }));
    expect(review.decision).toBe("PASS");
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

  it("WATCH/PASS/INSUFFICIENT_DATA decisions are never altered even with a hard-rule failure present", () => {
    const packet = packetWith([criterion({ criterionName: "Stock price", status: "FAIL" })]);
    for (const decision of ["WATCH", "PASS", "INSUFFICIENT_DATA"] as const) {
      expect(enforceHardRuleConsistency(packet, reviewFixture({ decision })).decision).toBe(decision);
    }
  });
});
