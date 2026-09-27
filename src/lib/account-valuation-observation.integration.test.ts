import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dbTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const CONSTRAINT = "AccountValuationObservation_state_matrix_check";

/** Dedicated DB constraint coverage for the AccountValuationObservation state matrix (Astra Fix
 * 2) - separate from funding-sync.integration.test.ts, which covers the unrelated funding-sync
 * finalization/rollback path. Asserts the actual Postgres CHECK constraint name via the driver
 * error, never a generic rejects.toThrow(). */
(dbTests ? describe : describe.skip)("AccountValuationObservation state matrix (DB CHECK)", () => {
  let prisma: typeof import("./prisma").prisma;
  const owner = { id: "" };
  let accountId: string;

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    const user = await prisma.user.create({ data: { name: "Matrix Fixture", email: `${randomUUID()}@lst.local`, passwordHash: "unused" } });
    owner.id = user.id;
    const account = await prisma.tradingAccount.create({ data: { userId: owner.id, name: "Matrix fixture", source: "SCHWAB",
      externalAccountId: randomUUID(), visibility: "PRIVATE" } });
    accountId = account.id;
  });
  afterAll(async () => {
    if (prisma) { await prisma.user.deleteMany({ where: { id: owner.id } }); await prisma.$disconnect(); }
  });

  async function expectStateMatrixRejection(data: Record<string, unknown>) {
    let caught: { meta?: { driverAdapterError?: { cause?: { code?: string; message?: string } } } } | undefined;
    try {
      await prisma.accountValuationObservation.create({ data: { accountId, provider: "SCHWAB", currency: "USD",
        valueSource: "CURRENT_BALANCES_LIQUIDATION_VALUE", ...data } });
    } catch (error) {
      caught = error as typeof caught;
    }
    expect(caught, "expected the state-matrix CHECK to reject this row").toBeDefined();
    expect(caught!.meta?.driverAdapterError?.cause?.code).toBe("23514");
    expect(caught!.meta?.driverAdapterError?.cause?.message).toContain(CONSTRAINT);
  }

  const now = new Date("2026-09-25T20:00:00Z");
  const sessionStart = new Date("2026-09-25T00:00:00Z");

  describe("allowed matrix rows all succeed", () => {
    it("CAPTURED + BROKER_VALUE_UNVERIFIED_SESSION with a value", async () => {
      const row = await prisma.accountValuationObservation.create({ data: { accountId, provider: "SCHWAB", currency: "USD",
        valueSource: "CURRENT_BALANCES_LIQUIDATION_VALUE", captureStatus: "CAPTURED", provenanceStatus: "BROKER_VALUE_UNVERIFIED_SESSION",
        value: 10_500,
      } });
      expect(row.value?.toNumber()).toBe(10500);
    });
    it("CAPTURED + VERIFIED_SESSION_CLOSE with full provenance evidence", async () => {
      const row = await prisma.accountValuationObservation.create({ data: { accountId, provider: "SCHWAB", currency: "USD",
        valueSource: "CURRENT_BALANCES_LIQUIDATION_VALUE", captureStatus: "CAPTURED", provenanceStatus: "VERIFIED_SESSION_CLOSE",
        value: 10_500, providerSessionDate: sessionStart, providerCutoff: now,
        provenanceEvidenceReference: "schwab-docs://verified-close", provenanceRuleVersion: 1,
      } });
      expect(row.value?.toNumber()).toBe(10500);
    });
    it("UNAVAILABLE + UNAVAILABLE with a null value", async () => {
      const row = await prisma.accountValuationObservation.create({ data: { accountId, provider: "SCHWAB", currency: "USD",
        valueSource: "CURRENT_BALANCES_LIQUIDATION_VALUE", captureStatus: "UNAVAILABLE", provenanceStatus: "UNAVAILABLE",
        value: null, requestStartedAt: now, responseReceivedAt: now,
      } });
      expect(row.value).toBeNull();
    });
    it("MISSED + UNAVAILABLE with no transport/provider evidence, but scheduling context intact", async () => {
      const row = await prisma.accountValuationObservation.create({ data: { accountId, provider: "SCHWAB", currency: "USD",
        valueSource: "CURRENT_BALANCES_LIQUIDATION_VALUE", captureStatus: "MISSED", provenanceStatus: "UNAVAILABLE",
        value: null, intendedSessionDate: sessionStart, scheduledCaptureAt: now,
      } });
      expect(row.value).toBeNull();
      expect(row.intendedSessionDate).toEqual(sessionStart);
    });
  });

  describe("invalid combinations are rejected by the named CHECK constraint", () => {
    it("MISSED + VERIFIED_SESSION_CLOSE", () => expectStateMatrixRejection({
      captureStatus: "MISSED", provenanceStatus: "VERIFIED_SESSION_CLOSE", value: 100,
      providerSessionDate: sessionStart, providerCutoff: now, provenanceEvidenceReference: "ref", provenanceRuleVersion: 1,
    }));
    it("MISSED + a value", () => expectStateMatrixRejection({
      captureStatus: "MISSED", provenanceStatus: "UNAVAILABLE", value: 100,
    }));
    it("CAPTURED + UNAVAILABLE", () => expectStateMatrixRejection({
      captureStatus: "CAPTURED", provenanceStatus: "UNAVAILABLE", value: null,
    }));
    it("CAPTURED + BROKER_VALUE_UNVERIFIED_SESSION with a null value", () => expectStateMatrixRejection({
      captureStatus: "CAPTURED", provenanceStatus: "BROKER_VALUE_UNVERIFIED_SESSION", value: null,
    }));
    it("VERIFIED without a session date", () => expectStateMatrixRejection({
      captureStatus: "CAPTURED", provenanceStatus: "VERIFIED_SESSION_CLOSE", value: 100,
      providerSessionDate: null, providerCutoff: now, provenanceEvidenceReference: "ref", provenanceRuleVersion: 1,
    }));
    it("VERIFIED without a cutoff", () => expectStateMatrixRejection({
      captureStatus: "CAPTURED", provenanceStatus: "VERIFIED_SESSION_CLOSE", value: 100,
      providerSessionDate: sessionStart, providerCutoff: null, provenanceEvidenceReference: "ref", provenanceRuleVersion: 1,
    }));
    it("VERIFIED with a cutoff that precedes its own session date", () => expectStateMatrixRejection({
      captureStatus: "CAPTURED", provenanceStatus: "VERIFIED_SESSION_CLOSE", value: 100,
      providerSessionDate: sessionStart, providerCutoff: new Date("2026-09-20T20:00:00Z"),
      provenanceEvidenceReference: "ref", provenanceRuleVersion: 1,
    }));
    it("VERIFIED without an evidence reference", () => expectStateMatrixRejection({
      captureStatus: "CAPTURED", provenanceStatus: "VERIFIED_SESSION_CLOSE", value: 100,
      providerSessionDate: sessionStart, providerCutoff: now, provenanceEvidenceReference: null, provenanceRuleVersion: 1,
    }));
    it("VERIFIED with a blank (whitespace-only, spaces) evidence reference", () => expectStateMatrixRejection({
      captureStatus: "CAPTURED", provenanceStatus: "VERIFIED_SESSION_CLOSE", value: 100,
      providerSessionDate: sessionStart, providerCutoff: now, provenanceEvidenceReference: "   ", provenanceRuleVersion: 1,
    }));
    // btrim() with no explicit character set strips only ASCII space - these prove the CHECK uses
    // a real whitespace-aware rule (`~ '\S'`), matching JS trim()'s behavior, not just btrim().
    it("VERIFIED with a tab-only evidence reference", () => expectStateMatrixRejection({
      captureStatus: "CAPTURED", provenanceStatus: "VERIFIED_SESSION_CLOSE", value: 100,
      providerSessionDate: sessionStart, providerCutoff: now, provenanceEvidenceReference: "\t", provenanceRuleVersion: 1,
    }));
    it("VERIFIED with a newline-only evidence reference", () => expectStateMatrixRejection({
      captureStatus: "CAPTURED", provenanceStatus: "VERIFIED_SESSION_CLOSE", value: 100,
      providerSessionDate: sessionStart, providerCutoff: now, provenanceEvidenceReference: "\n", provenanceRuleVersion: 1,
    }));
    it("VERIFIED with a CRLF-only evidence reference", () => expectStateMatrixRejection({
      captureStatus: "CAPTURED", provenanceStatus: "VERIFIED_SESSION_CLOSE", value: 100,
      providerSessionDate: sessionStart, providerCutoff: now, provenanceEvidenceReference: "\r\n", provenanceRuleVersion: 1,
    }));
    it("VERIFIED with a mixed-whitespace-only evidence reference", () => expectStateMatrixRejection({
      captureStatus: "CAPTURED", provenanceStatus: "VERIFIED_SESSION_CLOSE", value: 100,
      providerSessionDate: sessionStart, providerCutoff: now, provenanceEvidenceReference: " \t\n ", provenanceRuleVersion: 1,
    }));
    it("VERIFIED without a valid (positive) rule version", () => expectStateMatrixRejection({
      captureStatus: "CAPTURED", provenanceStatus: "VERIFIED_SESSION_CLOSE", value: 100,
      providerSessionDate: sessionStart, providerCutoff: now, provenanceEvidenceReference: "ref", provenanceRuleVersion: 0,
    }));
    it("UNAVAILABLE with a value", () => expectStateMatrixRejection({
      captureStatus: "UNAVAILABLE", provenanceStatus: "UNAVAILABLE", value: 100,
    }));
    it("MISSED with retrieval/provider timestamps present", () => expectStateMatrixRejection({
      captureStatus: "MISSED", provenanceStatus: "UNAVAILABLE", value: null, requestStartedAt: now, responseReceivedAt: now,
    }));
  });
});
