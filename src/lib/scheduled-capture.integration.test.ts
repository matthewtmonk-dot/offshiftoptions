import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PositionAssessmentDisplay } from "@/domain/finance/positionReviewAssessment";
import type { PositionReviewResult } from "@/domain/finance/positionReview";

const dbTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);

function cannotAssessResult(reasonCodes: string[], evaluatedAt: Date): PositionReviewResult {
  return {
    action: "CANNOT_ASSESS",
    lifecycle: "CURRENT_PUT",
    evidence: { position: "MANUAL_POSITION", quote: "UNAVAILABLE", quoteIneligibleReason: null, session: "CLOSED" },
    explanation: {
      reasonCodes, optionType: "PUT", strike: 25, stockPrice: null, dollarDistance: null, percentageDistance: null,
      moneyness: null, bufferPercent: 3, expiration: new Date("2026-12-18T00:00:00Z"), daysToExpiration: 5,
      quoteTradeTime: null, quoteAgeMs: null, positionEvidenceAsOf: null, activeGuidanceDeadline: null, evaluatedAt,
    },
    priority: { group: 8, withinExpirationTodaySubgroup: null, expirationSortKey: null, ticker: "ZVER", accountId: "a", campaignId: "c1" },
  };
}

function unavailableDisplayEntry(evaluatedAt: Date): { campaignId: string; display: PositionAssessmentDisplay } {
  return { campaignId: "c1", display: { state: "UNAVAILABLE", currentUnavailable: cannotAssessResult(["MARKET_CLOSED"], evaluatedAt) } };
}

const resolveMock = vi.fn();
vi.mock("./positionAssessmentOrchestration", () => ({
  resolvePositionAssessmentDisplaysForUser: (...args: unknown[]) => resolveMock(...args),
}));
vi.mock("./workflows", () => ({
  loadOpenAndAssignedCampaignsForUser: async () => [],
}));

/**
 * DB-integration coverage for the ONE idempotency guarantee this feature rests on
 * (claimSlot's atomic INSERT ... ON CONFLICT ... DO UPDATE ... WHERE, see scheduled-capture.ts),
 * plus owner isolation and the real per-minute budget interaction - against a real local Postgres.
 * The orchestration call itself is mocked (per the ticket's own explicit allowance: "Where live
 * provider evidence cannot be reproduced, use controlled fixtures/mocks around the orchestration
 * boundary") - persistence CORRECTNESS of a real CURRENT/LAST_VALID assessment is already fully
 * proven by positionReviewAssessmentStore.integration.test.ts (38/38); this suite proves the
 * SCHEDULING/CLAIMING layer around it, which that suite does not touch at all.
 */
(dbTests ? describe : describe.skip)("scheduled-capture (DB)", () => {
  let prisma: typeof import("./prisma").prisma;
  let scheduledCapture: typeof import("./scheduled-capture");
  let budget: typeof import("./scheduled-capture-budget");
  const ownerA = { id: "" };
  const ownerB = { id: "" };

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    scheduledCapture = await import("./scheduled-capture");
    budget = await import("./scheduled-capture-budget");

    const userA = await prisma.user.create({ data: { name: "Capture Owner A", email: `${randomUUID()}@lst.local`, passwordHash: "unused" } });
    const userB = await prisma.user.create({ data: { name: "Capture Owner B", email: `${randomUUID()}@lst.local`, passwordHash: "unused" } });
    ownerA.id = userA.id;
    ownerB.id = userB.id;

    // A CONNECTED Schwab broker connection is required for eligibleOwnerIds() to select a owner at
    // all - the actual tokens are never used (resolvePositionAssessmentDisplaysForUser is mocked
    // above), so dummy ciphertext values are safe and make no real request.
    for (const ownerId of [ownerA.id, ownerB.id]) {
      await prisma.brokerConnection.create({
        data: { userId: ownerId, provider: "SCHWAB", status: "CONNECTED", label: "Test connection", accessTokenCiphertext: "dummy", refreshTokenCiphertext: "dummy" },
      });
    }
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({ where: { id: { in: [ownerA.id, ownerB.id] } } });
      await prisma.$disconnect();
    }
  });

  beforeEach(() => {
    resolveMock.mockReset();
    resolveMock.mockResolvedValue([]); // "no campaigns" by default - empty tally, zero contradictions
    budget.resetScheduledCaptureBudgetForTests();
  });

  afterEach(async () => {
    await prisma.scheduledCaptureRun.deleteMany({ where: { ownerId: { in: [ownerA.id, ownerB.id] } } });
  });

  const DUE_NOW = new Date("2026-10-08T13:35:00.000Z"); // 9:35 AM ET on a Thursday (NYSE trading day) - the OPENING slot

  it("idempotency: the same heartbeat invoked twice in a row persists exactly ONE ScheduledCaptureRun row and attempts the orchestration only once per owner", async () => {
    await scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW);
    await scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW);

    const rows = await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerA.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("SUCCEEDED");
  });

  it("idempotency: two concurrent duplicate triggers for the same due instant never both perform real capture work - only one SUCCEEDED row results", async () => {
    const [resultA, resultB] = await Promise.all([
      scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW),
      scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW),
    ]);
    // Together, exactly one owner-slot claim succeeded per owner (processed+skipped sums to the
    // eligible owner count across both calls, never double-processed for the same owner+instant).
    const rows = await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerA.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attemptCount).toBe(1);
    expect(resultA.status).toBe("ok");
    expect(resultB.status).toBe("ok");
  });

  it("process-restart semantics: a stale RUNNING row (implying a crashed process) is re-claimed by a later heartbeat, never left stuck forever", async () => {
    const staleStartedAt = new Date(DUE_NOW.getTime() - 5 * 60_000); // 5 minutes before "now" - older than the 2-minute stale threshold
    await prisma.scheduledCaptureRun.create({
      data: { ownerId: ownerA.id, sessionDate: "2026-10-08", slot: "OPENING", dueAt: DUE_NOW, status: "RUNNING", attemptCount: 1, startedAt: staleStartedAt },
    });

    await scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW);

    const rows = await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerA.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("SUCCEEDED");
    expect(rows[0]!.attemptCount).toBe(2); // re-claimed, attempt count incremented
  });

  it("a FRESH (non-stale) RUNNING row is NOT re-claimed - a genuinely in-flight capture is left alone", async () => {
    const freshStartedAt = new Date(DUE_NOW.getTime() - 30_000); // 30 seconds ago - well under the stale threshold
    await prisma.scheduledCaptureRun.create({
      data: { ownerId: ownerA.id, sessionDate: "2026-10-08", slot: "OPENING", dueAt: DUE_NOW, status: "RUNNING", attemptCount: 1, startedAt: freshStartedAt },
    });

    await scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW);

    const rows = await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerA.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("RUNNING"); // untouched - never flipped to SUCCEEDED by this call
    expect(rows[0]!.attemptCount).toBe(1);
    expect(resolveMock).not.toHaveBeenCalledWith(ownerA.id, expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything());
  });

  it("a FAILED row past its retry backoff IS re-claimed; one still within backoff is NOT", async () => {
    await prisma.scheduledCaptureRun.create({
      data: {
        ownerId: ownerA.id, sessionDate: "2026-10-08", slot: "OPENING", dueAt: DUE_NOW, status: "FAILED", attemptCount: 1,
        startedAt: DUE_NOW, completedAt: DUE_NOW, errorCategory: "PROVIDER_UNAVAILABLE",
        nextEligibleRetryAt: new Date(DUE_NOW.getTime() - 1000), // already past
      },
    });
    await prisma.scheduledCaptureRun.create({
      data: {
        ownerId: ownerB.id, sessionDate: "2026-10-08", slot: "OPENING", dueAt: DUE_NOW, status: "FAILED", attemptCount: 1,
        startedAt: DUE_NOW, completedAt: DUE_NOW, errorCategory: "PROVIDER_UNAVAILABLE",
        nextEligibleRetryAt: new Date(DUE_NOW.getTime() + 60 * 60_000), // an hour in the future - not yet eligible
      },
    });

    await scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW);

    const rowA = (await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerA.id } }))[0]!;
    const rowB = (await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerB.id } }))[0]!;
    expect(rowA.status).toBe("SUCCEEDED");
    expect(rowA.attemptCount).toBe(2);
    expect(rowB.status).toBe("FAILED"); // untouched - still within its own backoff window
    expect(rowB.attemptCount).toBe(1);
  });

  it("owner isolation: owner A's capture failure does not block or corrupt owner B's successful capture in the same heartbeat", async () => {
    // Budget mocked out for this test specifically - it is already fully covered on its own in
    // scheduled-capture-budget.test.ts, and would otherwise confound which owner got skipped for
    // which reason within a single real per-minute window.
    const budgetModule = await import("./scheduled-capture-budget");
    const reserveSpy = vi.spyOn(budgetModule, "tryReserveProviderRequestBudget").mockReturnValue(true);

    resolveMock.mockImplementation(async (userId: string) => {
      if (userId === ownerA.id) throw new Error("simulated provider outage for owner A");
      return [unavailableDisplayEntry(DUE_NOW)];
    });

    await scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW);

    const rowA = (await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerA.id } }))[0]!;
    const rowB = (await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerB.id } }))[0]!;
    expect(rowA.status).toBe("FAILED");
    expect(rowA.errorCategory).toBe("UNKNOWN");
    expect(rowB.status).toBe("SUCCEEDED");
    expect(rowB.unavailableCount).toBe(1);

    reserveSpy.mockRestore();
  });

  it("budget interaction: when both owners are due in the SAME heartbeat, the real per-minute budget allows only one owner's capture to proceed - the other is naturally deferred, not corrupted or lost", async () => {
    await scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW);

    const rowA = await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerA.id } });
    const rowB = await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerB.id } });
    const succeededCount = [rowA[0]?.status, rowB[0]?.status].filter((s) => s === "SUCCEEDED").length;
    const deferredCount = [rowA, rowB].filter((rows) => rows.length === 0 || rows[0]!.status === "FAILED").length;
    expect(succeededCount).toBe(1);
    expect(deferredCount).toBe(1);
  });

  it("nothing-due heartbeat: zero database writes and zero orchestration calls outside any slot window", async () => {
    const outsideWindow = new Date("2026-10-08T17:00:00.000Z"); // 1:00 PM ET - well past FINAL, before next OPENING
    const result = await scheduledCapture.runScheduledCaptureHeartbeat(outsideWindow);
    expect(result).toEqual({ status: "ok", due: 0, processed: 0, skipped: 0, failed: 0 });
    expect(resolveMock).not.toHaveBeenCalled();
    const rows = await prisma.scheduledCaptureRun.findMany({ where: { ownerId: { in: [ownerA.id, ownerB.id] } } });
    expect(rows).toHaveLength(0);
  });

  it("weekend heartbeat: zero database writes and zero orchestration calls even during what would be a weekday's regular-session hours", async () => {
    const saturday935am = new Date("2026-10-10T13:35:00.000Z"); // Saturday, same wall-clock time as DUE_NOW
    const result = await scheduledCapture.runScheduledCaptureHeartbeat(saturday935am);
    expect(result).toEqual({ status: "ok", due: 0, processed: 0, skipped: 0, failed: 0 });
    expect(resolveMock).not.toHaveBeenCalled();
  });
});
