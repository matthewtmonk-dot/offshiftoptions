import { describe, expect, it } from "vitest";
import { diffScannerRulesFromLstCore, SCANNER_RULE_DEFINITIONS } from "./profile";

describe("LST Core profile diff", () => {
  it("reports no differences for records matching the LST Core defaults", () => {
    const records = SCANNER_RULE_DEFINITIONS.map((definition) => ({
      key: definition.key,
      valueJson: { desired: definition.defaultDesired },
      enabled: definition.defaultEnabled,
    }));

    const diff = diffScannerRulesFromLstCore(records);
    expect(diff.every((entry) => !entry.changed)).toBe(true);
  });

  it("flags a rule whose desired value was customized away from LST Core", () => {
    const records = SCANNER_RULE_DEFINITIONS.map((definition) => ({
      key: definition.key,
      valueJson: {
        desired: definition.key === "rsi" ? 55 : definition.defaultDesired,
      },
      enabled: definition.defaultEnabled,
    }));

    const diff = diffScannerRulesFromLstCore(records);
    const rsi = diff.find((entry) => entry.key === "rsi");
    expect(rsi?.changed).toBe(true);
    expect(rsi?.coreDesired).toBe(40);
    expect(rsi?.currentDesired).toBe(55);

    const others = diff.filter((entry) => entry.key !== "rsi");
    expect(others.every((entry) => !entry.changed)).toBe(true);
  });

  it("flags a rule that was enabled/disabled away from LST Core without touching its value", () => {
    const records = SCANNER_RULE_DEFINITIONS.map((definition) => ({
      key: definition.key,
      valueJson: { desired: definition.defaultDesired },
      enabled: definition.key === "delta" ? true : definition.defaultEnabled,
    }));

    const diff = diffScannerRulesFromLstCore(records);
    const delta = diff.find((entry) => entry.key === "delta");
    expect(delta?.changed).toBe(true);
    expect(delta?.coreEnabled).toBe(false);
    expect(delta?.currentEnabled).toBe(true);
  });

  it("treats a missing record as still matching LST Core defaults", () => {
    const diff = diffScannerRulesFromLstCore([]);
    expect(diff.every((entry) => !entry.changed)).toBe(true);
  });
});
