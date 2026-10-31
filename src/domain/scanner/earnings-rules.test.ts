import { describe, expect, it } from "vitest";
import { evaluateCandidate } from "./scanner";
import {
  COVERED_CALL_ONLY_RULE_KEYS,
  defaultScannerRules,
  GATING_RULE_KEYS,
  missingScannerRuleDefinitions,
  scannerRulesFromRecords,
  SCANNER_RULE_DEFINITIONS,
} from "./profile";
import { computeQuoteStageRulesFingerprint } from "../../lib/technical-indicator-cache";

const record = (key: string, enabled = true, desired: unknown = undefined) => {
  const definition = SCANNER_RULE_DEFINITIONS.find((d) => d.key === key)!;
  return { key, name: definition.name, operator: definition.operator, valueJson: { desired: desired ?? definition.defaultDesired }, enabled };
};

describe("earnings rule definitions", () => {
  const byKey = (key: string) => SCANNER_RULE_DEFINITIONS.find((d) => d.key === key)!;

  it("ships the four-day buffer and one exit session as on-by-default, gating, configurable numbers", () => {
    expect(byKey("earningsFreeDaysAfterExpiry")).toMatchObject({ operator: "GTE", defaultDesired: 3, defaultEnabled: true });
    expect(byKey("earningsExitSessions")).toMatchObject({ operator: "GTE", defaultDesired: 1, defaultEnabled: true });
    expect(GATING_RULE_KEYS.has("earningsFreeDaysAfterExpiry")).toBe(true);
    expect(GATING_RULE_KEYS.has("earningsExitSessions")).toBe(true);
  });

  it("the covered-call earnings notice is its own rule: off by default and never gating", () => {
    expect(byKey("coveredCallEarningsDistance").defaultEnabled).toBe(false);
    expect(GATING_RULE_KEYS.has("coveredCallEarningsDistance")).toBe(false);
  });

  it("rule keys are unique", () => {
    const keys = SCANNER_RULE_DEFINITIONS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("evaluating the put buffer rules", () => {
  const rules = defaultScannerRules().filter((r) => r.key === "earningsFreeDaysAfterExpiry" || r.key === "earningsExitSessions");
  it("passes at the default thresholds, fails below them, and is UNKNOWN (never PASS) when the numbers are missing", () => {
    expect(evaluateCandidate(rules, { earningsFreeDaysAfterExpiry: 3, earningsExitSessions: 1 }).status).toBe("PASS");
    expect(evaluateCandidate(rules, { earningsFreeDaysAfterExpiry: 2, earningsExitSessions: 1 }).status).toBe("FAIL");
    expect(evaluateCandidate(rules, { earningsFreeDaysAfterExpiry: 5, earningsExitSessions: 0 }).status).toBe("FAIL");
    expect(evaluateCandidate(rules, { earningsFreeDaysAfterExpiry: null, earningsExitSessions: null }).status).toBe("UNKNOWN");
  });
});

describe("covered-call-only rules stay out of put scans", () => {
  it("defaultScannerRules and scannerRulesFromRecords omit them unless covered-call rules are requested", () => {
    expect(defaultScannerRules().some((r) => COVERED_CALL_ONLY_RULE_KEYS.has(r.key))).toBe(false);
    const enabledEverywhere = SCANNER_RULE_DEFINITIONS.map((d) => record(d.key, true));
    expect(scannerRulesFromRecords(enabledEverywhere).some((r) => COVERED_CALL_ONLY_RULE_KEYS.has(r.key))).toBe(false);
    expect(scannerRulesFromRecords(enabledEverywhere, { includeCoveredCallRules: true }).some((r) => r.key === "coveredCallEarningsDistance")).toBe(true);
  });
});

describe("rules added after a profile was created", () => {
  const existingKeys = SCANNER_RULE_DEFINITIONS.map((d) => d.key).filter((key) => !["earningsFreeDaysAfterExpiry", "earningsExitSessions", "coveredCallEarningsDistance"].includes(key));

  it("missingScannerRuleDefinitions returns only the absent keys with their definition order", () => {
    const missing = missingScannerRuleDefinitions(existingKeys);
    expect(missing.map((m) => m.definition.key).sort()).toEqual(["coveredCallEarningsDistance", "earningsExitSessions", "earningsFreeDaysAfterExpiry"]);
    for (const { definition, sortOrder } of missing) expect(SCANNER_RULE_DEFINITIONS[sortOrder].key).toBe(definition.key);
  });

  it("is idempotent: once the rows exist nothing is missing, and a user's saved values are never part of the result", () => {
    expect(missingScannerRuleDefinitions(SCANNER_RULE_DEFINITIONS.map((d) => d.key))).toEqual([]);
    expect(missingScannerRuleDefinitions([...existingKeys, "earningsFreeDaysAfterExpiry", "earningsExitSessions", "coveredCallEarningsDistance"])).toEqual([]);
  });

  it("before a row exists, a new default-ON rule applies and a new default-OFF rule stays off", () => {
    const rules = scannerRulesFromRecords(existingKeys.map((key) => record(key, true)), { includeCoveredCallRules: true });
    expect(rules.find((r) => r.key === "earningsFreeDaysAfterExpiry")?.desired).toBe(3);
    expect(rules.find((r) => r.key === "earningsExitSessions")?.desired).toBe(1);
    expect(rules.some((r) => r.key === "coveredCallEarningsDistance")).toBe(false);
  });

  it("a user's own saved value or off switch is respected over the default", () => {
    const rules = scannerRulesFromRecords(
      [...existingKeys.map((key) => record(key, true)), record("earningsFreeDaysAfterExpiry", true, 5), record("earningsExitSessions", false)],
      { includeCoveredCallRules: true },
    );
    expect(rules.find((r) => r.key === "earningsFreeDaysAfterExpiry")?.desired).toBe(5);
    expect(rules.some((r) => r.key === "earningsExitSessions")).toBe(false);
  });
});

describe("adding rules does not disturb technical preparation", () => {
  it("the quote-stage fingerprint depends only on the price rule", () => {
    const base = [{ key: "price", name: "Price", operator: "BETWEEN" as const, desired: [10, 50] as [number, number] }];
    const withEarnings = [...base, ...defaultScannerRules().filter((r) => r.key.startsWith("earnings"))];
    expect(computeQuoteStageRulesFingerprint(withEarnings)).toBe(computeQuoteStageRulesFingerprint(base));
  });
});
