import { describe, expect, it } from "vitest";
import {
  defaultScannerRules,
  evaluateDemoScan,
  GATING_RULE_KEYS,
  parseScannerDesiredFromForm,
  SCANNER_RULE_DEFINITIONS,
} from "./profile";
import {
  buildExclusionDiagnostics,
  evaluateCandidate,
  evaluateCriterion,
  getNearMisses,
  honestSetupLabel,
  honestSetupScore,
  parseStoredCriterionActualValue,
  parseStoredCriterionDesiredValue,
  setupScore,
  setupScoreLabel,
  type CriterionResult,
  type ScannerRule,
} from "./scanner";

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

  it("evaluates the shared LST Core demo profile with pass/fail/unknown results", () => {
    // Only the rules enabled by default in LST Core - matching how a fresh profile
    // actually scans, rather than every experimental/disabled rule at once.
    const coreRules = SCANNER_RULE_DEFINITIONS.filter((definition) => definition.defaultEnabled).map(
      (definition) => ({
        key: definition.key,
        name: definition.name,
        operator: definition.operator,
        desired: definition.defaultDesired,
      }),
    );
    const results = evaluateDemoScan(coreRules);
    const amd = results.find((result) => result.ticker === "AMD");
    const rivn = results.find((result) => result.ticker === "RIVN");
    const f = results.find((result) => result.ticker === "F");

    expect(results).toHaveLength(13);
    expect(rivn?.summary.status).toBe("PASS");
    expect(f).toBeDefined();
    expect(getNearMisses(f!.summary.results)).toHaveLength(1);
    expect(amd?.summary.results.some((result) => result.status === "UNKNOWN")).toBe(true);
    expect(amd?.summary.status).toBe("FAIL");
  });

  it("scores setup quality without treating it as profit probability", () => {
    const pass = evaluateCandidate(rules, {
      price: 16.89,
      rsi: 48,
      openInterest: 500,
    });
    const near = evaluateCandidate(rules, {
      price: 16.89,
      rsi: 56,
      openInterest: 500,
    });
    const poor = evaluateCandidate(rules, {
      price: 125,
      rsi: 76,
      openInterest: 12,
    });

    expect(setupScore(pass)).toBe(100);
    expect(setupScore(near)).toBe(91);
    expect(setupScoreLabel(setupScore(near))).toBe("Excellent");
    expect(setupScore(poor)).toBe(0);
  });

  it("never labels an UNKNOWN row Excellent/Strong, even at a high known-score", () => {
    // Matches the audit's live example: 92 "Excellent" sitting next to a grey UNKNOWN -
    // 12 of 14 criteria clean passes, 2 unknown, which still nets a high raw score.
    const passRules: ScannerRule[] = Array.from({ length: 12 }, (_, index) => ({
      key: `pass${index}`,
      name: `Pass rule ${index}`,
      operator: "GTE",
      desired: 0,
    }));
    const lstRules: ScannerRule[] = [
      ...passRules,
      { key: "earningsDistance", name: "Earnings distance", operator: "GTE", desired: 10 },
      { key: "debtToEquity", name: "Debt/equity", operator: "LTE", desired: 1.2 },
    ];
    const values: Record<string, number | null> = Object.fromEntries(lstRules.map((rule) => [rule.key, 1]));
    values.earningsDistance = null;
    values.debtToEquity = null;
    const summary = evaluateCandidate(lstRules, values);

    expect(summary.status).toBe("UNKNOWN");
    const score = honestSetupScore(summary, GATING_RULE_KEYS);
    expect(score).toBeGreaterThanOrEqual(90);
    expect(honestSetupLabel(summary, GATING_RULE_KEYS)).toBe("Verify");
  });

  it("caps the score and forces a non-positive label on a gating criterion FAIL", () => {
    // Matches the audit's live example: 85 "Strong" on a candidate with a 76.9% spread,
    // and 90 "Excellent" on a candidate with a delta well outside the strategy's band.
    const lstRules: ScannerRule[] = [
      { key: "price", name: "Stock price", operator: "BETWEEN", desired: [10, 50] },
      { key: "delta", name: "Absolute delta", operator: "BETWEEN", desired: [0.12, 0.3] },
      { key: "ror", name: "Put ROR", operator: "GTE", desired: 1 },
    ];
    const summary = evaluateCandidate(lstRules, { price: 28.1, delta: 0.41, ror: 1.5 });

    expect(summary.status).toBe("FAIL");
    const rawScore = setupScore(summary);
    const score = honestSetupScore(summary, GATING_RULE_KEYS);
    expect(rawScore).toBeGreaterThan(49);
    expect(score).toBeLessThanOrEqual(49);
    expect(honestSetupLabel(summary, GATING_RULE_KEYS)).toBe("Fails");
  });

  it("leaves the graded label scale in place for a preference-only miss", () => {
    // RSI is a preference rule, not gating - a miss there can still read positively if
    // nothing gating failed and nothing is unknown.
    const lstRules: ScannerRule[] = [
      { key: "price", name: "Stock price", operator: "BETWEEN", desired: [10, 50] },
      { key: "rsi", name: "RSI", operator: "LTE", desired: 40 },
      { key: "ror", name: "Put ROR", operator: "GTE", desired: 1 },
    ];
    const summary = evaluateCandidate(lstRules, { price: 28.1, rsi: 41, ror: 1.5 });

    expect(summary.status).toBe("FAIL");
    expect(honestSetupLabel(summary, GATING_RULE_KEYS)).not.toBe("Fails");
    expect(honestSetupLabel(summary, GATING_RULE_KEYS)).not.toBe("Verify");
  });

  it("summarizes first-rule scanner exclusions", () => {
    const candidates = evaluateDemoScan(defaultScannerRules()).map((result) => ({
      ticker: result.ticker,
      summary: result.summary,
    }));
    const diagnostics = buildExclusionDiagnostics(candidates);

    expect(diagnostics.startingUniverse).toBe(13);
    expect(diagnostics.finalMatches).toBeGreaterThan(0);
    expect(diagnostics.removals.some((removal) => removal.criterionName === "RSI")).toBe(true);
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
          defaultEnabled: true,
          explanation: "Test",
          input: { kind: "range", minLabel: "Min", maxLabel: "Max" },
        },
        formData,
      ),
    ).toEqual([12, 60]);
  });
});

describe("persisted-criterion reconstruction helpers (shared by Research's scan snapshot and the Alpha Vantage queue's Near-tier)", () => {
  it("parses stored actualValue sentinels back to null/boolean/number, and a plain string otherwise", () => {
    expect(parseStoredCriterionActualValue(null)).toBeNull();
    expect(parseStoredCriterionActualValue("")).toBeNull();
    expect(parseStoredCriterionActualValue("true")).toBe(true);
    expect(parseStoredCriterionActualValue("false")).toBe(false);
    expect(parseStoredCriterionActualValue("38000")).toBe(38000);
    expect(parseStoredCriterionActualValue("not-a-number")).toBe("not-a-number");
  });

  it("parses a stored desiredValue back into its real type, including a BETWEEN tuple as a real array (not a stringified array)", () => {
    expect(parseStoredCriterionDesiredValue(JSON.stringify([10, 50]))).toEqual([10, 50]);
    expect(parseStoredCriterionDesiredValue(JSON.stringify(40))).toBe(40);
    expect(parseStoredCriterionDesiredValue(JSON.stringify("text"))).toBe("text");
  });

  it("falls back to the raw string if desiredValue somehow isn't valid JSON, rather than throwing", () => {
    expect(parseStoredCriterionDesiredValue("not-json")).toBe("not-json");
  });

  it("a BETWEEN criterion reconstructed via these helpers is correctly classified as a near miss by getNearMisses - proving the fix for a prior bug where an unparsed desiredValue string broke Array.isArray()", () => {
    const reconstructed: CriterionResult = {
      key: "price",
      name: "Price",
      actualValue: parseStoredCriterionActualValue("52"),
      operator: "BETWEEN",
      desiredValue: parseStoredCriterionDesiredValue(JSON.stringify([10, 50])),
      status: "FAIL",
      explanation: "",
    };

    const misses = getNearMisses([reconstructed]);
    expect(misses).toHaveLength(1);
    expect(misses[0].near).toBe(true);
  });
});
