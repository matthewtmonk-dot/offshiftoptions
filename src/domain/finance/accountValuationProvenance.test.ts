import { describe, expect, it } from "vitest";
import { isBenchmarkSessionEligible, type AccountValuationObservationEvidence } from "./accountValuationProvenance";

function evidence(overrides: Partial<AccountValuationObservationEvidence> = {}): AccountValuationObservationEvidence {
  return {
    accountId: "account-1",
    provider: "SCHWAB",
    currency: "USD",
    valueSource: "CURRENT_BALANCES_LIQUIDATION_VALUE",
    value: 10_000,
    captureStatus: "CAPTURED",
    provenanceStatus: "VERIFIED_SESSION_CLOSE",
    providerSessionDate: new Date("2026-09-25T00:00:00Z"),
    providerCutoff: new Date("2026-09-25T20:00:00Z"),
    provenanceEvidenceReference: "schwab-docs://trader-api/account-balances#liquidationValue",
    provenanceRuleVersion: 1,
    ...overrides,
  };
}

describe("isBenchmarkSessionEligible", () => {
  it("accepts a fully evidenced, internally coherent VERIFIED_SESSION_CLOSE observation", () => {
    expect(isBenchmarkSessionEligible(evidence())).toBe(true);
  });
  it("requires captureStatus === CAPTURED", () => {
    expect(isBenchmarkSessionEligible(evidence({ captureStatus: "UNAVAILABLE" }))).toBe(false);
    expect(isBenchmarkSessionEligible(evidence({ captureStatus: "MISSED" }))).toBe(false);
  });
  it("rejects BROKER_VALUE_UNVERIFIED_SESSION - today's only producible status", () => {
    expect(isBenchmarkSessionEligible(evidence({ provenanceStatus: "BROKER_VALUE_UNVERIFIED_SESSION" }))).toBe(false);
  });
  it("rejects UNAVAILABLE", () => {
    expect(isBenchmarkSessionEligible(evidence({
      provenanceStatus: "UNAVAILABLE", captureStatus: "UNAVAILABLE", value: null,
      providerSessionDate: null, providerCutoff: null,
    }))).toBe(false);
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
  it("rejects a cutoff that precedes its own session date (Astra repro: session Sep 25, cutoff Sep 20)", () => {
    expect(isBenchmarkSessionEligible(evidence({
      providerSessionDate: new Date("2026-09-25T00:00:00Z"),
      providerCutoff: new Date("2026-09-20T20:00:00Z"),
    }))).toBe(false);
  });
  it("accepts a cutoff exactly equal to the session date", () => {
    const same = new Date("2026-09-25T20:00:00Z");
    expect(isBenchmarkSessionEligible(evidence({ providerSessionDate: same, providerCutoff: same }))).toBe(true);
  });
  it("requires a non-blank provenance evidence reference", () => {
    expect(isBenchmarkSessionEligible(evidence({ provenanceEvidenceReference: null }))).toBe(false);
    expect(isBenchmarkSessionEligible(evidence({ provenanceEvidenceReference: "" }))).toBe(false);
    expect(isBenchmarkSessionEligible(evidence({ provenanceEvidenceReference: "   " }))).toBe(false);
  });
  it("rejects a reference made only of tab/newline/CR whitespace - must agree with the SQL CHECK", () => {
    expect(isBenchmarkSessionEligible(evidence({ provenanceEvidenceReference: "\t" }))).toBe(false);
    expect(isBenchmarkSessionEligible(evidence({ provenanceEvidenceReference: "\n" }))).toBe(false);
    expect(isBenchmarkSessionEligible(evidence({ provenanceEvidenceReference: "\r\n" }))).toBe(false);
    expect(isBenchmarkSessionEligible(evidence({ provenanceEvidenceReference: " \t\n " }))).toBe(false);
  });
  it("requires a valid, positive provenance rule version", () => {
    expect(isBenchmarkSessionEligible(evidence({ provenanceRuleVersion: null }))).toBe(false);
    expect(isBenchmarkSessionEligible(evidence({ provenanceRuleVersion: 0 }))).toBe(false);
    expect(isBenchmarkSessionEligible(evidence({ provenanceRuleVersion: -1 }))).toBe(false);
    expect(isBenchmarkSessionEligible(evidence({ provenanceRuleVersion: 1.5 }))).toBe(false);
  });
  it("rejects an unsupported provider even when every other field says VERIFIED", () => {
    expect(isBenchmarkSessionEligible(evidence({ provider: "OTHER" }))).toBe(false);
    expect(isBenchmarkSessionEligible(evidence({ provider: "MOCK" }))).toBe(false);
  });
  it("rejects an unsupported valueSource", () => {
    expect(isBenchmarkSessionEligible(evidence({ valueSource: "SOMETHING_ELSE" }))).toBe(false);
  });
  it("rejects missing or whitespace-only account/currency identity", () => {
    expect(isBenchmarkSessionEligible(evidence({ accountId: "" }))).toBe(false);
    expect(isBenchmarkSessionEligible(evidence({ accountId: "   " }))).toBe(false);
    expect(isBenchmarkSessionEligible(evidence({ currency: "" }))).toBe(false);
    expect(isBenchmarkSessionEligible(evidence({ currency: "   " }))).toBe(false);
  });
});
