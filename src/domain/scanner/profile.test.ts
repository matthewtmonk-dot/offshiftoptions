import { describe, expect, it } from "vitest";
import { diffScannerRulesFromLstCore, resultsPredateCurrentSettings, SCANNER_RULE_DEFINITIONS } from "./profile";

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

describe("resultsPredateCurrentSettings (Ticket 7: honest disclosure when settings changed after the visible run)", () => {
  it("8. flags a run whose results were generated before the profile's settings last changed", () => {
    const runCreatedAt = new Date("2026-09-01T12:00:00Z");
    const profileUpdatedAt = new Date("2026-09-02T09:00:00Z"); // settings saved AFTER the run
    expect(resultsPredateCurrentSettings(profileUpdatedAt, runCreatedAt)).toBe(true);
  });

  it("does not flag a run created after the most recent settings change", () => {
    const runCreatedAt = new Date("2026-09-02T09:00:00Z");
    const profileUpdatedAt = new Date("2026-09-01T12:00:00Z"); // settings saved BEFORE the run
    expect(resultsPredateCurrentSettings(profileUpdatedAt, runCreatedAt)).toBe(false);
  });

  it("does not flag a run created at the exact same instant as the settings change", () => {
    const instant = new Date("2026-09-01T12:00:00Z");
    expect(resultsPredateCurrentSettings(instant, instant)).toBe(false);
  });
});

describe("resultsPredateCurrentSettings - Astra follow-up: overlapping save/scan concurrency", () => {
  // Astra's exact scenario: a scan reads rules A at 14:00:00, the user saves new rules B at
  // 14:00:10 (while the scan is still evaluating), and the scan finishes and persists its
  // ScanRun at 14:00:20 - AFTER the save. The old mechanism compared profileUpdatedAt against
  // ScanRun.createdAt (14:00:20), which is later than the save (14:00:10), and so incorrectly
  // concluded the results were current. The fix compares against the settings revision the scan
  // actually captured at read time (14:00:00, via withSettingsRevision in workflows.ts) instead.
  const scanReadsRulesAt = new Date("2026-09-21T14:00:00Z");
  const settingsSavedAt = new Date("2026-09-21T14:00:10Z");
  const scanPersistsAt = new Date("2026-09-21T14:00:20Z");

  it("1. scan A reads old rules, settings save lands mid-scan, scan A persists after the save -> must warn", () => {
    // The corrected mechanism: compare against the captured read-time revision.
    expect(resultsPredateCurrentSettings(settingsSavedAt, scanReadsRulesAt)).toBe(true);
  });

  it("demonstrates the old mechanism's bug directly: comparing against persist time instead would have missed it", () => {
    expect(resultsPredateCurrentSettings(settingsSavedAt, scanPersistsAt)).toBe(false); // the bug
    expect(resultsPredateCurrentSettings(settingsSavedAt, scanReadsRulesAt)).toBe(true); // the fix
  });

  it("2. a scan that reads rules AFTER the save captures the already-current revision -> no warning", () => {
    const scanReadsRulesAfterSave = new Date("2026-09-21T14:00:15Z"); // after settingsSavedAt
    expect(resultsPredateCurrentSettings(settingsSavedAt, scanReadsRulesAfterSave)).toBe(false);
  });

  it("3. ordinary sequential case - scan finishes, then settings are saved later -> warning", () => {
    const laterSave = new Date("2026-09-21T15:00:00Z");
    expect(resultsPredateCurrentSettings(laterSave, scanReadsRulesAt)).toBe(true);
  });

  it("4. settings saved, then a brand-new scan reads the already-current rules -> no warning", () => {
    const newScanReadsRulesAt = new Date("2026-09-21T14:05:00Z"); // after settingsSavedAt
    expect(resultsPredateCurrentSettings(settingsSavedAt, newScanReadsRulesAt)).toBe(false);
  });
});
