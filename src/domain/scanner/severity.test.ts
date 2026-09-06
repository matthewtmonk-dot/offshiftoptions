import { describe, expect, it } from "vitest";
import { evaluateCriterion, type ScannerRule } from "./scanner";
import { ruleSeverityTone } from "./severity";

function criterionFor(rule: ScannerRule, actualValue: number | string | boolean | null) {
  return evaluateCriterion(rule, actualValue);
}

describe("ruleSeverityTone", () => {
  it("is neutral when the rule is disabled (no criterion for this metric)", () => {
    expect(ruleSeverityTone(undefined)).toBe("neutral");
  });

  it("is neutral for an unknown value, never a false red", () => {
    const rule: ScannerRule = { key: "earningsDistance", name: "Days to earnings", operator: "GTE", desired: 10 };
    expect(ruleSeverityTone(criterionFor(rule, null))).toBe("neutral");
  });

  describe("stock price range $10-$50", () => {
    const rule: ScannerRule = { key: "price", name: "Stock price", operator: "BETWEEN", desired: [10, 50] };

    it("inside range is green", () => {
      expect(ruleSeverityTone(criterionFor(rule, 25))).toBe("good");
      expect(ruleSeverityTone(criterionFor(rule, 10))).toBe("good");
      expect(ruleSeverityTone(criterionFor(rule, 50))).toBe("good");
    });

    it("slightly outside (within ~20% of the $40 span) is amber", () => {
      expect(ruleSeverityTone(criterionFor(rule, 55))).toBe("warn"); // (55-50)/40 = 12.5%
      expect(ruleSeverityTone(criterionFor(rule, 58))).toBe("warn"); // (58-50)/40 = 20% boundary
    });

    it("far outside is red", () => {
      expect(ruleSeverityTone(criterionFor(rule, 65))).toBe("bad"); // (65-50)/40 = 37.5%
      expect(ruleSeverityTone(criterionFor(rule, 1))).toBe("bad"); // (10-1)/40 = 22.5%
    });
  });

  describe("RSI max 40", () => {
    const rule: ScannerRule = { key: "rsi", name: "RSI", operator: "LTE", desired: 40 };

    it("40 is green", () => {
      expect(ruleSeverityTone(criterionFor(rule, 40))).toBe("good");
    });

    it("41 is amber", () => {
      expect(ruleSeverityTone(criterionFor(rule, 41))).toBe("warn");
    });

    it("50 is amber - the designed boundary", () => {
      expect(ruleSeverityTone(criterionFor(rule, 50))).toBe("warn");
    });

    it("above 50 is red", () => {
      expect(ruleSeverityTone(criterionFor(rule, 51))).toBe("bad");
    });
  });

  describe("BB position max 33%", () => {
    const rule: ScannerRule = { key: "bbPercent", name: "BB %", operator: "LTE", desired: 33 };

    it("33 is green", () => {
      expect(ruleSeverityTone(criterionFor(rule, 33))).toBe("good");
    });

    it("40 is amber", () => {
      expect(ruleSeverityTone(criterionFor(rule, 40))).toBe("warn");
    });

    it("50 is amber - the designed boundary", () => {
      expect(ruleSeverityTone(criterionFor(rule, 50))).toBe("warn");
    });

    it("above 50 is red", () => {
      expect(ruleSeverityTone(criterionFor(rule, 51))).toBe("bad");
    });
  });

  describe("Put ROR minimum 1%", () => {
    const rule: ScannerRule = { key: "ror", name: "ROR", operator: "GTE", desired: 1 };

    it("meeting the minimum is green", () => {
      expect(ruleSeverityTone(criterionFor(rule, 1))).toBe("good");
      expect(ruleSeverityTone(criterionFor(rule, 1.5))).toBe("good");
    });

    it("75-99% of threshold is amber", () => {
      expect(ruleSeverityTone(criterionFor(rule, 0.99))).toBe("warn");
      expect(ruleSeverityTone(criterionFor(rule, 0.75))).toBe("warn");
    });

    it("below 75% of threshold is red", () => {
      expect(ruleSeverityTone(criterionFor(rule, 0.74))).toBe("bad");
      expect(ruleSeverityTone(criterionFor(rule, 0))).toBe("bad");
    });
  });

  describe("Open interest minimum 100", () => {
    const rule: ScannerRule = { key: "openInterest", name: "Open interest", operator: "GTE", desired: 100 };

    it("meeting the minimum is green", () => {
      expect(ruleSeverityTone(criterionFor(rule, 100))).toBe("good");
    });

    it("50-99 is amber", () => {
      expect(ruleSeverityTone(criterionFor(rule, 99))).toBe("warn");
      expect(ruleSeverityTone(criterionFor(rule, 50))).toBe("warn");
    });

    it("below 50 is red", () => {
      expect(ruleSeverityTone(criterionFor(rule, 49))).toBe("bad");
    });
  });

  it("a disabled rule (undefined criterion) never renders as pass/fail, only neutral", () => {
    // Simulates scannerRulesFromRecords dropping a disabled rule entirely - no CriterionResult exists for it.
    expect(ruleSeverityTone(undefined)).toBe("neutral");
    expect(ruleSeverityTone(undefined)).not.toBe("good");
    expect(ruleSeverityTone(undefined)).not.toBe("bad");
  });
});
