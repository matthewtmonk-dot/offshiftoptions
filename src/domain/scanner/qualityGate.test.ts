import { describe, expect, it } from "vitest";
import { qualityGateFor } from "./qualityGate";

describe("qualityGateFor", () => {
  it("gates nothing when the feature is not configured", () => {
    expect(qualityGateFor({ configured: false, tier: null, reviewed: false })).toBeNull();
    expect(qualityGateFor({ configured: false, tier: "REJECT", reviewed: false })).toBeNull();
  });

  it("A and B are eligible; unchecked is not", () => {
    expect(qualityGateFor({ configured: true, tier: "A", reviewed: false })!.eligible).toBe(true);
    expect(qualityGateFor({ configured: true, tier: "B", reviewed: false })!.eligible).toBe(true);
    const unchecked = qualityGateFor({ configured: true, tier: null, reviewed: false })!;
    expect(unchecked.eligible).toBe(false);
    expect(unchecked.reason).toMatch(/not checked yet/);
  });

  it("CAUTION and VERIFY are excluded until the owner reviews them", () => {
    for (const tier of ["CAUTION", "VERIFY"] as const) {
      expect(qualityGateFor({ configured: true, tier, reviewed: false })!.eligible).toBe(false);
      const reviewed = qualityGateFor({ configured: true, tier, reviewed: true })!;
      expect(reviewed.eligible).toBe(true);
      expect(reviewed.label).toMatch(/reviewed/);
    }
  });

  it("REJECT can never be overridden", () => {
    const gate = qualityGateFor({ configured: true, tier: "REJECT", reviewed: true })!;
    expect(gate.eligible).toBe(false);
    expect(gate.reason).toMatch(/cannot be overridden/);
  });
});
