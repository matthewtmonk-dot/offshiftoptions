import { describe, expect, it } from "vitest";
import { buildAiAdvisorPacket, hardRuleFailures, hasUnknownHardRule, unknownHardRules, validateAiAdvisorPacket, type AiAdvisorPacketSourceCriterion } from "./aiAdvisorPacket";

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

const baseSnapshot = {
  price: 45,
  rsi: 52,
  bbPercent: 0.4,
  strike: 40,
  optionBid: 1.2,
  optionAsk: 1.3,
  midpoint: 1.25,
  premium: 1.25,
  premiumBasis: "MARK_MIDPOINT",
  bidProceedsPerContract: 120,
  delta: 0.28,
  openInterest: 500,
  optionVolume: 100,
  ror: 3.1,
  annualizedRor: 25.4,
  rorBasis: "BID",
  distanceOtmPercent: 11.1,
  spreadPercent: 7.7,
  dte: 14,
  expiration: "2026-10-24",
  earningsDate: "2026-11-05",
  earningsDistance: 25,
  earningsWithinHoldingPeriod: false,
  optionEnrichment: "ENRICHED",
  retrievedAt: "2026-10-10T20:00:00.000Z",
  retrievedOnNonTradingDay: false,
  companyDescription: "Example Corp",
};

describe("buildAiAdvisorPacket", () => {
  it("reuses the persisted criterion rows verbatim as rule evidence, classified HARD/SOFT by GATING_RULE_KEYS", () => {
    const packet = buildAiAdvisorPacket({
      ticker: "XYZ",
      evaluatedAt: new Date("2026-10-10T20:05:00.000Z"),
      snapshot: baseSnapshot,
      criteria: [
        criterion({ criterionName: "Stock price", status: "PASS" }), // gating ("price")
        criterion({ criterionName: "RSI", status: "PASS", actualValue: "52" }), // soft preference
      ],
    });

    const priceRule = packet.rules.find((rule) => rule.ruleId === "price");
    expect(priceRule?.classification).toBe("HARD");
    expect(priceRule?.status).toBe("PASS");

    const rsiRule = packet.rules.find((rule) => rule.ruleId === "rsi");
    expect(rsiRule?.classification).toBe("SOFT");
  });

  it("never recomputes a rule's status - a deterministic FAIL stays FAIL regardless of the underlying numbers", () => {
    const packet = buildAiAdvisorPacket({
      ticker: "XYZ",
      evaluatedAt: new Date(),
      snapshot: { ...baseSnapshot, price: 999 }, // a price that would obviously PASS if re-evaluated
      criteria: [criterion({ criterionName: "Stock price", status: "FAIL", explanation: "Stock price is below the minimum." })],
    });
    expect(packet.rules[0].status).toBe("FAIL");
    expect(packet.rules[0].explanation).toBe("Stock price is below the minimum.");
  });

  it("preserves UNKNOWN exactly as UNKNOWN - never silently converted to a number or PASS/FAIL", () => {
    const packet = buildAiAdvisorPacket({
      ticker: "XYZ",
      evaluatedAt: new Date(),
      snapshot: baseSnapshot,
      criteria: [criterion({ criterionName: "Open interest", status: "UNKNOWN", actualValue: null, explanation: "Open interest is unknown for this candidate." })],
    });
    expect(packet.rules[0].status).toBe("UNKNOWN");
    expect(packet.rules[0].actualValue).toBe("unknown");
  });

  it("carries full underlying/option/risk evidence from the snapshot, never fabricating a missing field", () => {
    const packet = buildAiAdvisorPacket({ ticker: "XYZ", evaluatedAt: new Date(), snapshot: baseSnapshot, criteria: [criterion()] });
    expect(packet.underlying.stockPrice).toBe(45);
    expect(packet.underlying.rsi).toBe(52);
    expect(packet.option.strike).toBe(40);
    expect(packet.option.ror).toBe(3.1);
    expect(packet.riskContext.earningsDistance).toBe(25);
    expect(packet.identity.companyDescription).toBe("Example Corp");
  });

  it("a candidate with genuinely missing snapshot fields reports null, never a fabricated zero", () => {
    const packet = buildAiAdvisorPacket({ ticker: "XYZ", evaluatedAt: new Date(), snapshot: {}, criteria: [criterion()] });
    expect(packet.underlying.stockPrice).toBeNull();
    expect(packet.option.strike).toBeNull();
    expect(packet.option.delta).toBeNull();
    expect(packet.riskContext.earningsDate).toBeNull();
  });

  it("reuses the real deterministic scoring functions - a hard-rule FAIL caps the score and forces the Fails label", () => {
    const packet = buildAiAdvisorPacket({
      ticker: "XYZ",
      evaluatedAt: new Date(),
      snapshot: baseSnapshot,
      criteria: [criterion({ criterionName: "Stock price", status: "FAIL" })],
    });
    expect(packet.riskContext.deterministicScoreLabel).toBe("Fails");
    expect(packet.riskContext.deterministicReadiness).toBe("FAIL");
  });
});

describe("hardRuleFailures / hasUnknownHardRule", () => {
  it("identifies a hard-rule failure directly from the packet - never from anything AI-supplied", () => {
    const packet = buildAiAdvisorPacket({
      ticker: "XYZ",
      evaluatedAt: new Date(),
      snapshot: baseSnapshot,
      criteria: [criterion({ criterionName: "Stock price", status: "FAIL" }), criterion({ criterionName: "RSI", status: "FAIL" })],
    });
    const failures = hardRuleFailures(packet);
    expect(failures).toHaveLength(1);
    expect(failures[0].ruleId).toBe("price");
  });

  it("a soft-preference FAIL is never reported as a hard-rule failure", () => {
    const packet = buildAiAdvisorPacket({ ticker: "XYZ", evaluatedAt: new Date(), snapshot: baseSnapshot, criteria: [criterion({ criterionName: "RSI", status: "FAIL" })] });
    expect(hardRuleFailures(packet)).toHaveLength(0);
  });

  it("an UNKNOWN hard rule is flagged distinctly from a FAIL", () => {
    const packet = buildAiAdvisorPacket({
      ticker: "XYZ",
      evaluatedAt: new Date(),
      snapshot: baseSnapshot,
      criteria: [criterion({ criterionName: "Stock price", status: "UNKNOWN", actualValue: null })],
    });
    expect(hardRuleFailures(packet)).toHaveLength(0); // UNKNOWN is not FAIL
    expect(hasUnknownHardRule(packet)).toBe(true);
  });

  it("unknownHardRules returns the actual rows (ruleId + explanation), not just a boolean - the UI renders these directly, same reliability guarantee as a failure", () => {
    const packet = buildAiAdvisorPacket({
      ticker: "XYZ",
      evaluatedAt: new Date(),
      snapshot: baseSnapshot,
      criteria: [
        criterion({ criterionName: "Stock price", status: "UNKNOWN", actualValue: null, explanation: "Stock price is unknown for this candidate." }),
        criterion({ criterionName: "RSI", status: "UNKNOWN", actualValue: null }), // soft - must not appear here
      ],
    });
    const result = unknownHardRules(packet);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ ruleId: "price", label: "Stock price", status: "UNKNOWN", actualValue: "unknown", thresholdOrRequirement: "20", explanation: "Stock price is unknown for this candidate.", classification: "HARD" });
  });
});

describe("validateAiAdvisorPacket - pre-call gating only, never a judgment about the candidate itself", () => {
  it("rejects a missing ticker", () => {
    const packet = buildAiAdvisorPacket({ ticker: "", evaluatedAt: new Date(), snapshot: baseSnapshot, criteria: [criterion()] });
    const result = validateAiAdvisorPacket(packet);
    expect(result.ok).toBe(false);
  });

  it("rejects a candidate with zero evaluated rules", () => {
    const packet = buildAiAdvisorPacket({ ticker: "XYZ", evaluatedAt: new Date(), snapshot: baseSnapshot, criteria: [] });
    expect(validateAiAdvisorPacket(packet).ok).toBe(false);
  });

  it("rejects an impossible negative/zero stock price or strike", () => {
    const negativePrice = buildAiAdvisorPacket({ ticker: "XYZ", evaluatedAt: new Date(), snapshot: { ...baseSnapshot, price: -5 }, criteria: [criterion()] });
    expect(validateAiAdvisorPacket(negativePrice).ok).toBe(false);
    const zeroStrike = buildAiAdvisorPacket({ ticker: "XYZ", evaluatedAt: new Date(), snapshot: { ...baseSnapshot, strike: 0 }, criteria: [criterion()] });
    expect(validateAiAdvisorPacket(zeroStrike).ok).toBe(false);
  });

  it("does NOT reject a candidate with missing/UNKNOWN option evidence - that is a valid INSUFFICIENT_DATA case, not a malformed request", () => {
    const packet = buildAiAdvisorPacket({
      ticker: "XYZ",
      evaluatedAt: new Date(),
      snapshot: { price: 45 }, // no option evidence at all
      criteria: [criterion({ criterionName: "Open interest", status: "UNKNOWN", actualValue: null })],
    });
    expect(validateAiAdvisorPacket(packet).ok).toBe(true);
  });

  it("accepts a complete, well-formed packet", () => {
    const packet = buildAiAdvisorPacket({ ticker: "XYZ", evaluatedAt: new Date(), snapshot: baseSnapshot, criteria: [criterion()] });
    expect(validateAiAdvisorPacket(packet)).toEqual({ ok: true });
  });
});
