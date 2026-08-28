import { describe, expect, it } from "vitest";
import { defaultScannerRules, evaluateDemoScan, parseScannerDesiredFromForm } from "./profile";
import { evaluateCandidate, evaluateCriterion, type ScannerRule } from "./scanner";

const rules: ScannerRule[] = [
  { key: "price", name: "Price", operator: "BETWEEN", desired: [10, 80] },
  { key: "rsi", name: "RSI", operator: "LTE", desired: 55 },
  { key: "openInterest", name: "Open Interest", operator: "GTE", desired: 100 },
];

describe("scanner engine", () => {
  it("keeps criterion-level PASS, FAIL, and UNKNOWN state", () => {
    expect(evaluateCriterion(rules[0], 16.89).status).toBe("PASS");
    expect(evaluateCriterion(rules[1], 71).status).toBe("FAIL");
    expect(evaluateCriterion(rules[2], null).status).toBe("UNKNOWN");
  });

  it("derives summary without losing explanations", () => {
    const summary = evaluateCandidate(rules, {
      price: 16.89,
      rsi: 48,
      openInterest: undefined,
    });

    expect(summary.status).toBe("UNKNOWN");
    expect(summary.passed).toBe(2);
    expect(summary.total).toBe(3);
    expect(summary.results).toHaveLength(3);
    expect(summary.results[2].explanation).toContain("unknown");
  });

  it("fails overall when any known criterion fails", () => {
    const summary = evaluateCandidate(rules, {
      price: 16.89,
      rsi: 70,
      openInterest: 500,
    });

    expect(summary.status).toBe("FAIL");
    expect(summary.passed).toBe(2);
  });

  it("evaluates the shared My LST demo profile with pass/fail/unknown results", () => {
    const results = evaluateDemoScan(defaultScannerRules());
    const amd = results.find((result) => result.ticker === "AMD");

    expect(results).toHaveLength(4);
    expect(amd?.summary.results.some((result) => result.status === "UNKNOWN")).toBe(true);
    expect(amd?.summary.status).toBe("FAIL");
  });

  it("parses editable scanner setting ranges independently", () => {
    const formData = new FormData();
    formData.set("price:min", "12");
    formData.set("price:max", "60");

    expect(
      parseScannerDesiredFromForm(
        {
          key: "price",
          name: "Stock price",
          operator: "BETWEEN",
          defaultDesired: [10, 80],
          explanation: "Test",
          input: { kind: "range", minLabel: "Min", maxLabel: "Max" },
        },
        formData,
      ),
    ).toEqual([12, 60]);
  });
});
