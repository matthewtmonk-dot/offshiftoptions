import { describe, expect, it } from "vitest";
import { isBenchmarkSessionEligible, type AccountValuationObservationEvidence } from "./accountValuationProvenance";

function evidence(overrides: Partial<AccountValuationObservationEvidence> = {}): AccountValuationObservationEvidence {
  return {
    accountId: "account-1",
    provider: "SCHWAB",
    currency: "USD",
    value: 10_000,
    provenanceStatus: "VERIFIED_SESSION_CLOSE",
    providerSessionDate: new Date("2026-09-25T00:00:00Z"),
    providerCutoff: new Date("2026-09-25T20:00:00Z"),
    ...overrides,
  };
}

describe("isBenchmarkSessionEligible", () => {
  it("accepts a fully evidenced VERIFIED_SESSION_CLOSE observation", () => {
    expect(isBenchmarkSessionEligible(evidence())).toBe(true);
  });
  it("rejects BROKER_VALUE_UNVERIFIED_SESSION - today's only producible status", () => {
    expect(isBenchmarkSessionEligible(evidence({ provenanceStatus: "BROKER_VALUE_UNVERIFIED_SESSION" }))).toBe(false);
  });
  it("rejects UNAVAILABLE", () => {
    expect(isBenchmarkSessionEligible(evidence({ provenanceStatus: "UNAVAILABLE", value: null }))).toBe(false);
  });
  it("requires an explicit provider session date", () => {
    expect(isBenchmarkSessionEligible(evidence({ providerSessionDate: null }))).toBe(false);
  });
  it("requires an explicit provider cutoff", () => {
    expect(isBenchmarkSessionEligible(evidence({ providerCutoff: null }))).toBe(false);
  });
  it("rejects a VERIFIED status with no actual value", () => {
    expect(isBenchmarkSessionEligible(evidence({ value: null }))).toBe(false);
  });
  it("rejects missing account/currency/provider evidence", () => {
    expect(isBenchmarkSessionEligible(evidence({ accountId: "" }))).toBe(false);
    expect(isBenchmarkSessionEligible(evidence({ currency: "" }))).toBe(false);
    expect(isBenchmarkSessionEligible(evidence({ provider: "" }))).toBe(false);
  });
});
