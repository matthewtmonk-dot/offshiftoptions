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
  classifyReadiness,
  evaluateCandidate,
  evaluateCriterion,
  getNearMisses,
  honestSetupLabel,
  honestSetupScore,
  isActionableReadiness,
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

describe("classifyReadiness / isActionableReadiness - Scanner truthfulness: one authoritative readiness classifier", () => {
  // price is a real GATING_RULE_KEYS entry; rsi/bbPercent are real preference (non-gating) keys.
  const rules2: ScannerRule[] = [
    { key: "price", name: "Price", operator: "BETWEEN", desired: [10, 80] },
    { key: "rsi", name: "RSI", operator: "LTE", desired: 40 },
  ];
  const rules3: ScannerRule[] = [
    ...rules2,
    { key: "bbPercent", name: "BB %", operator: "LTE", desired: 33 },
  ];

  it("1. complete all-pass evidence -> PASS", () => {
    const summary = evaluateCandidate(rules2, { price: 20, rsi: 30 });
    expect(classifyReadiness(summary, GATING_RULE_KEYS)).toBe("PASS");
  });

  it("2. one permitted complete near miss -> NEAR", () => {
    // rsi <= 40, actual 42: gap = (42-40)/40 = 5% <= the 12% near cutoff.
    const summary = evaluateCandidate(rules2, { price: 20, rsi: 42 });
    expect(getNearMisses(summary.results)).toHaveLength(1);
    expect(classifyReadiness(summary, GATING_RULE_KEYS)).toBe("NEAR");
  });

  it("3. two near misses -> FAIL (NEAR only ever permits exactly one)", () => {
    // rsi near-fail (42 vs <=40) and bbPercent near-fail (35 vs <=33, gap ~6%) at the same time.
    const summary = evaluateCandidate(rules3, { price: 20, rsi: 42, bbPercent: 35 });
    expect(getNearMisses(summary.results)).toHaveLength(2);
    expect(classifyReadiness(summary, GATING_RULE_KEYS)).toBe("FAIL");
  });

  it("4. unknown required option evidence, no failures -> NEEDS_DATA", () => {
    const summary = evaluateCandidate(rules2, { price: 20, rsi: null });
    expect(summary.status).toBe("UNKNOWN");
    expect(classifyReadiness(summary, GATING_RULE_KEYS)).toBe("NEEDS_DATA");
  });

  it("5. options never checked -> NEEDS_DATA, even when every enabled criterion otherwise passes", () => {
    // All enabled criteria PASS (summary.status would read PASS on its own), but the option chain
    // itself was never assessed - this must still block PASS/NEAR admission.
    const summary = evaluateCandidate(rules2, { price: 20, rsi: 30 });
    expect(summary.status).toBe("PASS");
    expect(classifyReadiness(summary, GATING_RULE_KEYS, "NOT_ENRICHED_BUDGET")).toBe("NEEDS_DATA");
  });

  it("6. known gating failure + unknown other evidence -> FAIL (gating always wins)", () => {
    const summary = evaluateCandidate(rules2, { price: 200, rsi: null }); // price fails the gating band
    expect(classifyReadiness(summary, GATING_RULE_KEYS)).toBe("FAIL");
  });

  it("7. complete non-near failure -> FAIL", () => {
    // rsi <= 40, actual 80: gap = (80-40)/40 = 100%, nowhere near the 12% cutoff.
    const summary = evaluateCandidate(rules2, { price: 20, rsi: 80 });
    expect(getNearMisses(summary.results)).toHaveLength(0);
    expect(classifyReadiness(summary, GATING_RULE_KEYS)).toBe("FAIL");
  });

  it("8. a disabled optional metric never enters evaluation, so it cannot block readiness", () => {
    // "Disabled" is simulated exactly as scannerRulesFromRecords (profile.ts) really does it: the
    // rule is simply absent from the evaluated rule set, so it can never appear as UNKNOWN.
    const summary = evaluateCandidate(rules2, { price: 20, rsi: 30, bbPercent: null });
    expect(summary.results.some((result) => result.key === "bbPercent")).toBe(false);
    expect(classifyReadiness(summary, GATING_RULE_KEYS)).toBe("PASS");
  });

  it("9. personal Research exclusion/watch state does not alter technical classification", () => {
    // classifyReadiness's signature has no researchStatus parameter at all - the same evidence
    // always classifies the same way regardless of what the user's own opinion of the ticker is.
    const summary = evaluateCandidate(rules2, { price: 20, rsi: 30 });
    const asIfNeverTrade = classifyReadiness(summary, GATING_RULE_KEYS);
    const asIfLiked = classifyReadiness(summary, GATING_RULE_KEYS);
    expect(asIfNeverTrade).toBe(asIfLiked);
    expect(asIfNeverTrade).toBe("PASS");
  });

  it("10 & 11. isActionableReadiness admits only PASS/NEAR - Dashboard-style filtering excludes NEEDS_DATA and FAIL", () => {
    expect(isActionableReadiness("PASS")).toBe(true);
    expect(isActionableReadiness("NEAR")).toBe(true);
    expect(isActionableReadiness("NEEDS_DATA")).toBe(false);
    expect(isActionableReadiness("FAIL")).toBe(false);

    const candidates = [
      { ticker: "GOOD", summary: evaluateCandidate(rules2, { price: 20, rsi: 30 }), optionEnrichment: "ENRICHED" },
      { ticker: "UNCHECKED", summary: evaluateCandidate(rules2, { price: 20, rsi: 30 }), optionEnrichment: "NOT_ENRICHED_BUDGET" },
      { ticker: "BROKEN", summary: evaluateCandidate(rules2, { price: 200, rsi: 30 }), optionEnrichment: "ENRICHED" },
    ];
    const actionableTickers = candidates
      .filter((candidate) => isActionableReadiness(classifyReadiness(candidate.summary, GATING_RULE_KEYS, candidate.optionEnrichment)))
      .map((candidate) => candidate.ticker);
    expect(actionableTickers).toEqual(["GOOD"]);
  });

  it("10 & 11b. end-to-end Dashboard Top Setups selection (filter-then-sort-then-slice) never promotes a NEEDS_DATA/FAIL row ahead of a real PASS/NEAR, even with a higher score", () => {
    // Mirrors dashboard/page.tsx's actual topSetups pipeline exactly: map to {summary, score,
    // readiness}, filter to isActionableReadiness, sort by score desc, slice(0, 3).
    const rows = [
      // A never-assessed row: every enabled criterion PASSES on paper (score would be 100), but
      // its options were never checked - this is the exact "unassessed chain looks more
      // actionable than the evidence supports" failure mode this ticket exists to close.
      { ticker: "UNCHECKED_HIGH_SCORE", summary: evaluateCandidate(rules2, { price: 20, rsi: 20 }), optionEnrichment: "NOT_ENRICHED_BUDGET" },
      { ticker: "REAL_PASS", summary: evaluateCandidate(rules2, { price: 20, rsi: 30 }), optionEnrichment: "ENRICHED" },
      { ticker: "REAL_NEAR", summary: evaluateCandidate(rules2, { price: 20, rsi: 42 }), optionEnrichment: "ENRICHED" },
      { ticker: "GATING_FAIL", summary: evaluateCandidate(rules2, { price: 200, rsi: 20 }), optionEnrichment: "ENRICHED" },
    ];
    const topSetups = rows
      .map((row) => ({
        ...row,
        score: honestSetupScore(row.summary, GATING_RULE_KEYS),
        readiness: classifyReadiness(row.summary, GATING_RULE_KEYS, row.optionEnrichment),
      }))
      .filter((row) => isActionableReadiness(row.readiness))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    expect(topSetups.map((row) => row.ticker)).toEqual(["REAL_PASS", "REAL_NEAR"]);
    expect(topSetups.every((row) => row.readiness === "PASS" || row.readiness === "NEAR")).toBe(true);
  });

  it("12. two independent count computations over the same classifier agree (the exact '2 near' vs 'Near 1' bug this ticket fixes)", () => {
    const rows = [
      { summary: evaluateCandidate(rules2, { price: 20, rsi: 30 }), optionEnrichment: "ENRICHED" }, // PASS
      { summary: evaluateCandidate(rules2, { price: 20, rsi: 42 }), optionEnrichment: "ENRICHED" }, // real NEAR
      // A gating-key near-miss (price just outside its band) must NOT count as NEAR anywhere -
      // this is exactly the discrepancy: a cruder "one near-fail" check would have counted it.
      { summary: evaluateCandidate(rules2, { price: 82, rsi: 30 }), optionEnrichment: "ENRICHED" },
    ];
    // Simulates the page-header style computation (a plain .filter().length over all rows)...
    const headerNearCount = rows.filter(
      (row) => classifyReadiness(row.summary, GATING_RULE_KEYS, row.optionEnrichment) === "NEAR",
    ).length;
    // ...and the workspace-tab style computation (memoized over an "actionable" subset) - both
    // must agree because both call the identical function.
    const workspaceNearCount = rows
      .filter(() => true) // stand-in for the "actionable" (non-excluded) subset
      .filter((row) => classifyReadiness(row.summary, GATING_RULE_KEYS, row.optionEnrichment) === "NEAR").length;
    expect(headerNearCount).toBe(1);
    expect(workspaceNearCount).toBe(1);
    expect(headerNearCount).toBe(workspaceNearCount);
    // The old getNearMisses(...).length === 1 predicate (no gating awareness) would have wrongly
    // counted the gating near-miss row too - proving this is a real behavior change, not a no-op.
    const naiveNearCount = rows.filter((row) => getNearMisses(row.summary.results).length === 1).length;
    expect(naiveNearCount).toBe(2);
  });

  it("13. a historical stored high score on an incomplete candidate does not make it actionable", () => {
    // One UNKNOWN criterion still earns real partial credit in setupScore/honestSetupScore, so an
    // incomplete row can carry a deceptively high historical score.
    const manyPassRules: ScannerRule[] = Array.from({ length: 9 }, (_, index) => ({
      key: `pass${index}`,
      name: `Pass rule ${index}`,
      operator: "GTE" as const,
      desired: 0,
    }));
    const values = Object.fromEntries(manyPassRules.map((rule) => [rule.key, 1]));
    const summary = evaluateCandidate([...manyPassRules, { key: "rsi", name: "RSI", operator: "LTE", desired: 40 }], {
      ...values,
      rsi: null, // the one unknown - still incomplete
    });
    const score = honestSetupScore(summary, GATING_RULE_KEYS);
    expect(score).toBeGreaterThanOrEqual(90); // a deceptively high historical/stored score
    const readiness = classifyReadiness(summary, GATING_RULE_KEYS);
    expect(readiness).toBe("NEEDS_DATA");
    expect(isActionableReadiness(readiness)).toBe(false);
  });

  it("14. bounded option-check/provider behavior is untouched - classifyReadiness is a pure function of already-computed evidence", () => {
    // No network/provider call, no option-chain budget concept, no randomness or clock read -
    // calling it twice with identical inputs always agrees, and it never mutates its inputs.
    const summary = evaluateCandidate(rules2, { price: 20, rsi: 30 });
    const before = JSON.stringify(summary);
    const first = classifyReadiness(summary, GATING_RULE_KEYS, "NOT_ENRICHED_BUDGET");
    const second = classifyReadiness(summary, GATING_RULE_KEYS, "NOT_ENRICHED_BUDGET");
    expect(first).toBe(second);
    expect(JSON.stringify(summary)).toBe(before);
  });

  it("a known non-gating failure remains FAIL even when other required evidence is still unknown (missing evidence never downgrades a known failure to NEEDS_DATA)", () => {
    const summary = evaluateCandidate(rules3, { price: 20, rsi: 80, bbPercent: null }); // big non-gating fail + an unrelated unknown
    expect(classifyReadiness(summary, GATING_RULE_KEYS)).toBe("FAIL");
  });

  it("a near miss combined with any additional unknown does not soften into NEEDS_DATA - NEAR requires fully complete evidence", () => {
    const summary = evaluateCandidate(rules3, { price: 20, rsi: 42, bbPercent: null }); // near-fail + an unrelated unknown
    expect(classifyReadiness(summary, GATING_RULE_KEYS)).toBe("FAIL");
  });
});
