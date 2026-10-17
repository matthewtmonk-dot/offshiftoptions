import { describe, expect, it } from "vitest";
import { describeExpirationEvidenceGap, type SchwabReconciliationEvidence } from "./schwabReconciliation";

const symbol = "USAR  260724P00014000";
const expiration = new Date("2026-07-24T00:00:00Z");

function evidence(overrides: Partial<SchwabReconciliationEvidence> = {}): SchwabReconciliationEvidence {
  return {
    positions: { status: "COMPLETE", data: [] },
    transactions: { status: "COMPLETE", from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-10-17T00:00:00Z") },
    persistenceStatus: "COMPLETE",
    ...overrides,
  } as SchwabReconciliationEvidence;
}

describe("describeExpirationEvidenceGap", () => {
  it("returns null when nothing about the evidence is incomplete", () => {
    expect(describeExpirationEvidenceGap({ expiration, symbol, evidence: evidence() })).toBeNull();
  });
  it("explains a sync window that starts after the put expired (the 90-day lookback)", () => {
    const result = describeExpirationEvidenceGap({
      expiration,
      symbol,
      evidence: evidence({ transactions: { status: "COMPLETE", from: new Date("2026-07-29T00:00:00Z"), to: new Date("2026-10-17T00:00:00Z") } } as Partial<SchwabReconciliationEvidence>),
    });
    expect(result).toContain("starts after this put expired");
  });
  it("explains partially received transactions", () => {
    const result = describeExpirationEvidenceGap({
      expiration,
      symbol,
      evidence: evidence({ transactions: { status: "PARTIAL", from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-10-17T00:00:00Z") } } as Partial<SchwabReconciliationEvidence>),
    });
    expect(result).toContain("transactions weren't fully received");
  });
});
