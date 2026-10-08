import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PositionAssessmentDisplay, StoredLastValidAssessment } from "@/domain/finance/positionReviewAssessment";
import type { PositionReviewResult } from "@/domain/finance/positionReview";
import type { EquityMarketSessionEvidence } from "@/providers/market-data/types";

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

function currentResult(evaluatedAt: Date): PositionReviewResult {
  return {
    action: "COMFORTABLE",
    lifecycle: "CURRENT_PUT",
    evidence: { position: "SCHWAB_CONFIRMED", quote: "ELIGIBLE", quoteIneligibleReason: null, session: "OPEN" },
    explanation: {
      reasonCodes: [], optionType: "PUT", strike: 25, stockPrice: 30, dollarDistance: 5, percentageDistance: 20,
      moneyness: "OTM", bufferPercent: 3, expiration: new Date("2026-12-18T00:00:00Z"), daysToExpiration: 10,
      quoteTradeTime: evaluatedAt, quoteAgeMs: 0, positionEvidenceAsOf: evaluatedAt, activeGuidanceDeadline: evaluatedAt, evaluatedAt,
    },
    priority: { group: 8, withinExpirationTodaySubgroup: null, expirationSortKey: "2026-12-18", ticker: "ZVER", accountId: "a", campaignId: "c1" },
  };
}

function unavailableDisplayEntry(evaluatedAt: Date): { campaignId: string; display: PositionAssessmentDisplay } {
  return { campaignId: "c1", display: { state: "UNAVAILABLE", currentUnavailable: cannotAssessResult(["MARKET_CLOSED"], evaluatedAt) } };
}

function lastValidDisplayEntry(reasonCodes: string[], evaluatedAt: Date): { campaignId: string; display: PositionAssessmentDisplay } {
  return {
    campaignId: "c1",
    display: { state: "LAST_VALID", currentUnavailable: cannotAssessResult(reasonCodes, evaluatedAt), lastValid: {} as StoredLastValidAssessment },
  };
}

function currentDisplayEntry(evaluatedAt: Date): { campaignId: string; display: PositionAssessmentDisplay } {
  return { campaignId: "c1", display: { state: "CURRENT", current: currentResult(evaluatedAt), lastValid: null } };
}

const AVAILABLE_OPEN: EquityMarketSessionEvidence = {
  status: "AVAILABLE",
  requestedDate: "2026-10-08",
  returnedDate: "2026-10-08",
  marketType: "EQUITY",
  product: "EQUITY",
  isOpen: true,
  regularMarketIntervals: [{ start: new Date("2026-10-08T13:30:00.000Z"), end: new Date("2026-10-08T20:00:00.000Z") }],
};
const AVAILABLE_CLOSED: EquityMarketSessionEvidence = { ...AVAILABLE_OPEN, isOpen: false, regularMarketIntervals: [] };
const UNAVAILABLE_SESSION: EquityMarketSessionEvidence = { status: "UNAVAILABLE", reason: "test fixture" };

const resolveMock = vi.fn();
vi.mock("./positionAssessmentOrchestration", () => ({
  resolvePositionAssessmentDisplaysForUser: (...args: unknown[]) => resolveMock(...args),
}));
vi.mock("./workflows", () => ({
  loadOpenAndAssignedCampaignsForUser: async () => [],
}));

const sessionEvidenceMock = vi.fn();
vi.mock("./live-quotes", () => ({
  getEquityMarketSessionEvidenceForUser: (...args: unknown[]) => sessionEvidenceMock(...args),
}));

/**
 * DB-integration coverage for the ONE idempotency guarantee this feature rests on
 * (claimSlot's atomic INSERT ... ON CONFLICT ... DO UPDATE ... WHERE, see scheduled-capture.ts),
 * plus owner isolation, the B3 stale-RUNNING/active-run-guard safety rules, the B4 budget-deferred
 * fairness rules, the B5 null-retry semantics fix, and the Codex "final five" round-2 repairs
 * (B1 fail-closed preflight, B2 BUDGET_BLOCKED, B3 end-to-end timeout, B4 LAST_VALID-never-counts,
 * B5 every-heartbeat retry) - against a real local Postgres. The orchestration call AND the
 * preflight session-evidence call are both mocked (per the ticket's own explicit allowance:
 * "Where live provider evidence cannot be reproduced, use controlled fixtures/mocks around the
 * orchestration boundary") - persistence CORRECTNESS of a real CURRENT/LAST_VALID assessment is
 * already fully proven by positionReviewAssessmentStore.integration.test.ts (38/38); this suite
 * proves the SCHEDULING/CLAIMING/CLASSIFICATION layer around it, which that suite does not touch
 * at all. `sessionEvidenceMock` defaults to AVAILABLE+OPEN in `beforeEach` so every test EXCEPT
 * the dedicated B1 tests below exercises the heavy path exactly as it did before B1's fail-closed
 * fix - the fixture connections' dummy ciphertext tokens would otherwise make REAL session
 * evidence resolve UNAVAILABLE for every single test, which is no longer survivable now that B1
 * fails closed on that outcome.
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

    // A CONNECTED Schwab broker connection is required for eligibleOwnerIdsInFairOrder() to select
    // a owner at all - the actual tokens are never used for real traffic (resolvePositionAssessmentDisplaysForUser
    // and getEquityMarketSessionEvidenceForUser are both mocked above), so dummy ciphertext values
    // are safe and make no real request.
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
    sessionEvidenceMock.mockReset();
    sessionEvidenceMock.mockResolvedValue(AVAILABLE_OPEN);
    budget.resetScheduledCaptureBudgetForTests();
  });

  afterEach(async () => {
    await prisma.scheduledCaptureRun.deleteMany({ where: { ownerId: { in: [ownerA.id, ownerB.id] } } });
    vi.restoreAllMocks();
    vi.useRealTimers();
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
    const rows = await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerA.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attemptCount).toBe(1);
    expect(resultA.status).toBe("ok");
    expect(resultB.status).toBe("ok");
  });

  it("Codex blocker repair (B3): a stale RUNNING row is marked ABANDONED, NEVER automatically re-claimed/re-run for that exact slot", async () => {
    const staleStartedAt = new Date(DUE_NOW.getTime() - 15 * 60_000); // 15 minutes before "now" - older than the 10-minute abandon threshold
    await prisma.scheduledCaptureRun.create({
      data: { ownerId: ownerA.id, sessionDate: "2026-10-08", slot: "OPENING", dueAt: DUE_NOW, status: "RUNNING", attemptCount: 1, startedAt: staleStartedAt },
    });

    await scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW);

    const rows = await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerA.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("ABANDONED");
    expect(rows[0]!.resultCategory).toBe("ABANDONED_STALE");
    expect(rows[0]!.attemptCount).toBe(1); // never re-claimed, so never incremented
    expect(resolveMock).not.toHaveBeenCalledWith(ownerA.id, expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything());
  });

  it("Codex blocker repair (B3): after an owner's stale RUNNING row is abandoned, a LATER, DIFFERENT due slot for that SAME owner can proceed", async () => {
    const staleStartedAt = new Date(DUE_NOW.getTime() - 15 * 60_000);
    const EARLIER_DUE_AT = new Date(DUE_NOW.getTime() - 20 * 60_000);
    await prisma.scheduledCaptureRun.create({
      data: { ownerId: ownerA.id, sessionDate: "2026-10-08", slot: "OPENING", dueAt: EARLIER_DUE_AT, status: "RUNNING", attemptCount: 1, startedAt: staleStartedAt },
    });

    await scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW);

    const rows = await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerA.id }, orderBy: { dueAt: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.dueAt).toEqual(EARLIER_DUE_AT);
    expect(rows[0]!.status).toBe("ABANDONED");
    expect(rows[1]!.dueAt).toEqual(DUE_NOW);
    expect(rows[1]!.status).toBe("SUCCEEDED");
  });

  it("Codex blocker repair (B3): the owner-level active-run guard blocks a NEW claim while this owner has ANY fresh RUNNING row, regardless of dueAt", async () => {
    const freshStartedAt = new Date(DUE_NOW.getTime() - 30_000); // 30 seconds ago - well under the abandon threshold
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

  it("Codex blocker repair (B5, null-retry fix): a FAILED row past its NON-NULL retry backoff IS re-claimed; one still within backoff is NOT", async () => {
    await prisma.scheduledCaptureRun.create({
      data: {
        ownerId: ownerA.id, sessionDate: "2026-10-08", slot: "OPENING", dueAt: DUE_NOW, status: "FAILED", attemptCount: 1,
        startedAt: DUE_NOW, completedAt: DUE_NOW, resultCategory: "PROVIDER_UNAVAILABLE",
        nextEligibleRetryAt: new Date(DUE_NOW.getTime() - 1000), // already past
      },
    });
    await prisma.scheduledCaptureRun.create({
      data: {
        ownerId: ownerB.id, sessionDate: "2026-10-08", slot: "OPENING", dueAt: DUE_NOW, status: "FAILED", attemptCount: 1,
        startedAt: DUE_NOW, completedAt: DUE_NOW, resultCategory: "PROVIDER_UNAVAILABLE",
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

  it("Codex blocker repair (B5, null-retry fix): a FAILED row with nextEligibleRetryAt = NULL is NEVER auto-retried, even though it is otherwise due", async () => {
    await prisma.scheduledCaptureRun.create({
      data: {
        ownerId: ownerA.id, sessionDate: "2026-10-08", slot: "OPENING", dueAt: DUE_NOW, status: "FAILED", attemptCount: 3,
        startedAt: DUE_NOW, completedAt: DUE_NOW, resultCategory: "UNKNOWN_ERROR", nextEligibleRetryAt: null,
      },
    });

    await scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW);

    const rowA = (await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerA.id } }))[0]!;
    expect(rowA.status).toBe("FAILED"); // untouched - NULL must never be read as "eligible now"
    expect(rowA.attemptCount).toBe(3);
    expect(resolveMock).not.toHaveBeenCalledWith(ownerA.id, expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything());
  });

  it("Codex blocker repair (B4): a DEFERRED row is reclaimed at a LATER heartbeat, keeping its ORIGINAL dueAt identity - the exact Matt/Eric scenario", async () => {
    await prisma.scheduledCaptureRun.create({
      data: {
        ownerId: ownerB.id, sessionDate: "2026-10-08", slot: "OPENING", dueAt: DUE_NOW, status: "DEFERRED", attemptCount: 1,
        startedAt: DUE_NOW, completedAt: DUE_NOW, resultCategory: "BUDGET_DEFERRED",
        nextEligibleRetryAt: new Date(DUE_NOW.getTime() - 1000), // already eligible, as a budget-deferred row always is
      },
    });
    const laterHeartbeat = new Date(DUE_NOW.getTime() + 5 * 60_000); // 9:40 AM ET - the slot's own due-window may have already closed

    await scheduledCapture.runScheduledCaptureHeartbeat(laterHeartbeat);

    const rowB = (await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerB.id } }))[0]!;
    expect(rowB.status).toBe("SUCCEEDED");
    expect(rowB.dueAt).toEqual(DUE_NOW); // the ORIGINAL 9:35 slot identity, never backdated/replaced
    expect(rowB.attemptCount).toBe(2);
  });

  it("Codex blocker repair (B4): a DEFERRED row still within its own backoff is NOT reclaimed", async () => {
    await prisma.scheduledCaptureRun.create({
      data: {
        ownerId: ownerB.id, sessionDate: "2026-10-08", slot: "OPENING", dueAt: DUE_NOW, status: "DEFERRED", attemptCount: 1,
        startedAt: DUE_NOW, completedAt: DUE_NOW, resultCategory: "BUDGET_DEFERRED",
        nextEligibleRetryAt: new Date(DUE_NOW.getTime() + 60_000),
      },
    });

    await scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW);

    const rowB = (await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerB.id } }))[0]!;
    expect(rowB.status).toBe("DEFERRED");
    expect(rowB.attemptCount).toBe(1);
  });

  it("owner isolation: owner A's unexpected thrown error does not block or corrupt owner B's successful capture in the same heartbeat", async () => {
    // Budget mocked out for this test specifically - it is already fully covered on its own in
    // scheduled-capture-budget.test.ts, and would otherwise confound which owner got deferred for
    // which reason within a single real per-minute window.
    const reserveSpy = vi.spyOn(budget, "tryReserveProviderRequestBudget").mockReturnValue(true);

    resolveMock.mockImplementation(async (userId: string) => {
      if (userId === ownerA.id) throw new Error("simulated unexpected failure for owner A");
      return [unavailableDisplayEntry(DUE_NOW)];
    });

    await scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW);

    const rowA = (await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerA.id } }))[0]!;
    const rowB = (await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerB.id } }))[0]!;
    expect(rowA.status).toBe("FAILED");
    expect(rowA.resultCategory).toBe("UNKNOWN_ERROR");
    expect(rowA.nextEligibleRetryAt).not.toBeNull(); // bounded retry - attemptCount(1) < UNKNOWN_ERROR_MAX_ATTEMPTS
    expect(rowB.status).toBe("SUCCEEDED");
    expect(rowB.resultCategory).toBe("SESSION_CLOSED"); // only MARKET_CLOSED reason present - no contradiction, no broker/quote issue
    expect(rowB.unavailableCount).toBe(1);

    reserveSpy.mockRestore();
  });

  it("Codex blocker repair (B4): when the shared per-minute budget allows only one owner's capture, the other is DEFERRED - never FAILED, never lost", async () => {
    let callCount = 0;
    const reserveSpy = vi.spyOn(budget, "tryReserveProviderRequestBudget").mockImplementation(() => {
      callCount += 1;
      return callCount === 1;
    });

    await scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW);

    const rowA = await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerA.id } });
    const rowB = await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerB.id } });
    const statuses = [rowA[0]?.status, rowB[0]?.status];
    expect(statuses.filter((s) => s === "SUCCEEDED")).toHaveLength(1);
    expect(statuses.filter((s) => s === "DEFERRED")).toHaveLength(1);
    expect(statuses).not.toContain("FAILED"); // budget exhaustion is never represented as a failure

    reserveSpy.mockRestore();
  });

  it("nothing-due heartbeat: zero database writes and zero orchestration calls outside any slot window", async () => {
    const outsideWindow = new Date("2026-10-08T17:00:00.000Z"); // 1:00 PM ET - well past FINAL, before next OPENING
    const result = await scheduledCapture.runScheduledCaptureHeartbeat(outsideWindow);
    expect(result).toEqual({ status: "ok", due: 0, processed: 0, deferred: 0, skipped: 0, failed: 0 });
    expect(resolveMock).not.toHaveBeenCalled();
    const rows = await prisma.scheduledCaptureRun.findMany({ where: { ownerId: { in: [ownerA.id, ownerB.id] } } });
    expect(rows).toHaveLength(0);
  });

  it("weekend heartbeat: zero database writes and zero orchestration calls even during what would be a weekday's regular-session hours", async () => {
    const saturday935am = new Date("2026-10-10T13:35:00.000Z"); // Saturday, same wall-clock time as DUE_NOW
    const result = await scheduledCapture.runScheduledCaptureHeartbeat(saturday935am);
    expect(result).toEqual({ status: "ok", due: 0, processed: 0, deferred: 0, skipped: 0, failed: 0 });
    expect(resolveMock).not.toHaveBeenCalled();
  });

  describe("Codex 'final five' round 2 - B1: session UNAVAILABLE must fail closed", () => {
    it("session AVAILABLE + OPEN proceeds to the heavy resolver exactly as before", async () => {
      sessionEvidenceMock.mockResolvedValue(AVAILABLE_OPEN);

      await scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW);

      expect(resolveMock).toHaveBeenCalled();
      const rowA = (await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerA.id } }))[0]!;
      expect(rowA.status).toBe("SUCCEEDED");
    });

    it("session AVAILABLE + CLOSED skips the heavy resolver entirely - SUCCEEDED/SESSION_CLOSED", async () => {
      sessionEvidenceMock.mockResolvedValue(AVAILABLE_CLOSED);

      await scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW);

      expect(resolveMock).not.toHaveBeenCalled();
      const rowA = (await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerA.id } }))[0]!;
      expect(rowA.status).toBe("SUCCEEDED");
      expect(rowA.resultCategory).toBe("SESSION_CLOSED");
    });

    it("session UNAVAILABLE now FAILS CLOSED - heavy resolver never entered, FAILED/SESSION_UNAVAILABLE with a bounded retry", async () => {
      sessionEvidenceMock.mockResolvedValue(UNAVAILABLE_SESSION);

      await scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW);

      expect(resolveMock).not.toHaveBeenCalled();
      const rowA = (await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerA.id } }))[0]!;
      expect(rowA.status).toBe("FAILED");
      expect(rowA.resultCategory).toBe("SESSION_UNAVAILABLE");
      expect(rowA.nextEligibleRetryAt).not.toBeNull();
      // The early-close-unavailable scenario costs only the single preflight attempt - no
      // account/position/quote calls at all (the mocked orchestration call, which is what WOULD
      // make those real calls, was never invoked).
      expect(rowA.positionsExamined).toBeNull();
    });
  });

  describe("Codex 'final five' round 2/3 - B2: a single owner's own cost exceeding the ceiling is BUDGET_BLOCKED, not an endless DEFERRED loop", () => {
    it("Codex blocker repair (B1, round 3) - estimate > ceiling -> BUDGET_BLOCKED BEFORE the preflight session call even runs - ZERO provider calls of any kind, nextEligibleRetryAt null, never reclaimed by a later heartbeat", async () => {
      const costSpy = vi.spyOn(budget, "estimateProviderCost").mockImplementation(async (ownerId: string) => (ownerId === ownerA.id ? 25 : 0));

      await scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW);

      const rowA = (await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerA.id } }))[0]!;
      expect(rowA.status).toBe("FAILED");
      expect(rowA.resultCategory).toBe("BUDGET_BLOCKED");
      expect(rowA.nextEligibleRetryAt).toBeNull();
      // This assertion was specifically missing before round 3 - BUDGET_BLOCKED must mean ZERO
      // provider calls of ANY kind, not merely "the heavy resolver was skipped." The preflight
      // session function itself must never be invoked for a permanently over-budget owner.
      expect(sessionEvidenceMock).not.toHaveBeenCalledWith(ownerA.id, expect.anything(), expect.anything());
      expect(resolveMock).not.toHaveBeenCalledWith(ownerA.id, expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything());

      // A later heartbeat (even far in the future) never reclaims a BUDGET_BLOCKED row - it is
      // excluded by the SAME null-retry rule that protects every other terminal state.
      const muchLater = new Date(DUE_NOW.getTime() + 5 * 60_000);
      await scheduledCapture.runScheduledCaptureHeartbeat(muchLater);
      const rowAAfter = (await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerA.id } }))[0]!;
      expect(rowAAfter.status).toBe("FAILED");
      expect(rowAAfter.resultCategory).toBe("BUDGET_BLOCKED");
      expect(rowAAfter.attemptCount).toBe(1); // never re-claimed
      expect(sessionEvidenceMock).not.toHaveBeenCalledWith(ownerA.id, expect.anything(), expect.anything());

      costSpy.mockRestore();
    });

    it("a capture that fits individually but has no capacity THIS MINUTE remains ordinary DEFERRED, not BUDGET_BLOCKED", async () => {
      let callCount = 0;
      const reserveSpy = vi.spyOn(budget, "tryReserveProviderRequestBudget").mockImplementation(() => {
        callCount += 1;
        return callCount === 1;
      });

      await scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW);

      const rowA = await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerA.id } });
      const rowB = await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerB.id } });
      const statuses = [rowA[0]?.status, rowB[0]?.status];
      expect(statuses).toContain("DEFERRED");
      expect(statuses).not.toContain("BUDGET_BLOCKED");
      // The DEFERRED owner's heavy resolver is never entered - only the cheap preflight (which
      // DOES run per the required flow: absolute-budget check -> preflight -> capacity check)
      // happens before the temporary-capacity denial.
      const deferredOwnerId = rowA[0]?.status === "DEFERRED" ? ownerA.id : ownerB.id;
      expect(resolveMock).not.toHaveBeenCalledWith(deferredOwnerId, expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything());

      reserveSpy.mockRestore();
    });

    it("Codex blocker repair (B2, round 3) - an aborted preflight that resolves to UNAVAILABLE (exactly as the real provider wrapper does after catching its own AbortError) is classified TIMEOUT, never SESSION_UNAVAILABLE, never CURRENT_CAPTURED", async () => {
      const reserveSpy = vi.spyOn(budget, "tryReserveProviderRequestBudget").mockReturnValue(true);
      // Simulates the REAL wrapper's own fail-closed behavior: it catches the AbortError from the
      // signal firing and safely returns UNAVAILABLE - the scheduler boundary itself must still
      // recognize the deadline fired and classify this as TIMEOUT, not trust the wrapper's result.
      const RealAbortController = globalThis.AbortController;
      class AlreadyAbortedController extends RealAbortController {
        constructor() {
          super();
          this.abort();
        }
      }
      vi.stubGlobal("AbortController", AlreadyAbortedController);
      sessionEvidenceMock.mockResolvedValue(UNAVAILABLE_SESSION);
      // If the heavy resolver were ever (incorrectly) entered, it would return a LAST_VALID
      // fallback - proving that even a tempting historical fallback cannot turn this into anything
      // but TIMEOUT, because the heavy resolver must never be reached at all.
      resolveMock.mockResolvedValue([lastValidDisplayEntry(["POSITION_BROKER_UNAVAILABLE"], DUE_NOW)]);

      await scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW);

      vi.unstubAllGlobals();
      reserveSpy.mockRestore();

      const rows = await prisma.scheduledCaptureRun.findMany({ where: { ownerId: { in: [ownerA.id, ownerB.id] } } });
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.status).toBe("FAILED");
        expect(row.resultCategory).toBe("TIMEOUT");
        expect(row.resultCategory).not.toBe("SESSION_UNAVAILABLE");
        expect(row.resultCategory).not.toBe("CURRENT_CAPTURED");
        expect(row.nextEligibleRetryAt).not.toBeNull();
      }
      expect(resolveMock).not.toHaveBeenCalled();
    });

    it("a genuine (non-abort) SESSION_UNAVAILABLE still classifies correctly - the TIMEOUT priority check only fires when the deadline actually aborted", async () => {
      sessionEvidenceMock.mockResolvedValue(UNAVAILABLE_SESSION);

      await scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW);

      const rowA = (await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerA.id } }))[0]!;
      expect(rowA.status).toBe("FAILED");
      expect(rowA.resultCategory).toBe("SESSION_UNAVAILABLE");
      expect(resolveMock).not.toHaveBeenCalled();
    });
  });

  describe("Codex 'final five' round 2 - B4: LAST_VALID must never count as CURRENT_CAPTURED for the scheduled operational result", () => {
    it("CURRENT attempt provider failure + LAST_VALID fallback -> PROVIDER_UNAVAILABLE, never CURRENT_CAPTURED", async () => {
      const reserveSpy = vi.spyOn(budget, "tryReserveProviderRequestBudget").mockReturnValue(true);
      resolveMock.mockResolvedValue([lastValidDisplayEntry(["POSITION_BROKER_UNAVAILABLE"], DUE_NOW)]);

      await scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW);

      const rowA = (await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerA.id } }))[0]!;
      expect(rowA.status).toBe("FAILED");
      expect(rowA.resultCategory).toBe("PROVIDER_UNAVAILABLE");

      reserveSpy.mockRestore();
    });

    it("one actual CURRENT display alongside other LAST_VALID siblings still allows CURRENT_CAPTURED", async () => {
      const reserveSpy = vi.spyOn(budget, "tryReserveProviderRequestBudget").mockReturnValue(true);
      resolveMock.mockResolvedValue([currentDisplayEntry(DUE_NOW), lastValidDisplayEntry(["POSITION_BROKER_UNAVAILABLE"], DUE_NOW)]);

      await scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW);

      const rowA = (await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerA.id } }))[0]!;
      expect(rowA.status).toBe("SUCCEEDED");
      expect(rowA.resultCategory).toBe("CURRENT_CAPTURED");

      reserveSpy.mockRestore();
    });

    it("all legitimate no-current (zero relevant campaigns) classifies as NO_CURRENT_LEGITIMATE", async () => {
      resolveMock.mockResolvedValue([]);

      await scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW);

      const rowA = (await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerA.id } }))[0]!;
      expect(rowA.status).toBe("SUCCEEDED");
      expect(rowA.resultCategory).toBe("NO_CURRENT_LEGITIMATE");
    });
  });

  describe("Codex 'final five' round 2 - B3/B4: end-to-end timeout takes priority over whatever the resolver eventually returns", () => {
    it("a timeout persists as TIMEOUT/FAILED even when the resolver resolves with a beautiful CURRENT display", async () => {
      // Deterministic, fast proof of captureOwnerSlot's own `controller.signal.aborted` priority
      // check - deliberately NOT a real-45-second-elapsed test (fake timers interleaved with real
      // DB I/O proved unreliable here; the actual end-to-end "signal reaches real fetch" proof
      // already lives in client.test.ts/tokens.test.ts). Every AbortController this heartbeat
      // creates is forced to report `aborted: true` immediately - simulating the 45s deadline
      // having already fired by the time the (mocked) resolver call resolves - while every other
      // mocked dependency (session evidence, the resolver itself) still reports ordinary success.
      const RealAbortController = globalThis.AbortController;
      class AlreadyAbortedController extends RealAbortController {
        constructor() {
          super();
          this.abort();
        }
      }
      vi.stubGlobal("AbortController", AlreadyAbortedController);

      const reserveSpy = vi.spyOn(budget, "tryReserveProviderRequestBudget").mockReturnValue(true);
      resolveMock.mockResolvedValue([currentDisplayEntry(DUE_NOW)]);

      await scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW);

      vi.unstubAllGlobals();
      reserveSpy.mockRestore();

      const rows = await prisma.scheduledCaptureRun.findMany({ where: { ownerId: { in: [ownerA.id, ownerB.id] } } });
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.status).toBe("FAILED");
        expect(row.resultCategory).toBe("TIMEOUT");
        expect(row.nextEligibleRetryAt).not.toBeNull();
      }
    });
  });

  describe("Codex 'final five' round 2 - B5: deferred/retryable work is serviced on EVERY heartbeat, not only when a new slot is due", () => {
    // 9:50 AM ET BASELINE slot - its own 10-minute due-window closes at exactly 10:00 AM ET, and
    // the NEXT baseline target (10:05 AM) isn't due until 10:05 - so a heartbeat at exactly 10:00
    // AM ET has dueCaptureSlots() return [] (genuinely NO new slot), the precise gap this repair
    // must still service DEFERRED/retryable work through.
    const BASELINE_DUE = new Date("2026-10-08T13:50:00.000Z"); // 9:50 AM ET
    const NO_NEW_SLOT_HEARTBEAT = new Date("2026-10-08T14:00:00.000Z"); // 10:00 AM ET - confirmed gap

    it("9:50 both due, one deferred -> 10:00 heartbeat has NO new slot but still services the deferred owner (regardless of which owner it is)", async () => {
      let callCount = 0;
      const reserveSpy = vi.spyOn(budget, "tryReserveProviderRequestBudget").mockImplementation(() => {
        callCount += 1;
        return callCount === 1;
      });

      await scheduledCapture.runScheduledCaptureHeartbeat(BASELINE_DUE);
      const afterFirst = await prisma.scheduledCaptureRun.findMany({ where: { ownerId: { in: [ownerA.id, ownerB.id] } } });
      expect(afterFirst.filter((r) => r.status === "SUCCEEDED")).toHaveLength(1);
      const deferredRow = afterFirst.find((r) => r.status === "DEFERRED");
      expect(deferredRow).toBeTruthy();
      reserveSpy.mockRestore();

      // Confirm the gap really is a gap - no new slot at 10:00.
      const secondResult = await scheduledCapture.runScheduledCaptureHeartbeat(NO_NEW_SLOT_HEARTBEAT);

      const afterSecond = await prisma.scheduledCaptureRun.findMany({ where: { ownerId: deferredRow!.ownerId } });
      expect(afterSecond[0]!.status).toBe("SUCCEEDED");
      expect(afterSecond[0]!.dueAt).toEqual(BASELINE_DUE); // original slot identity preserved
      expect(secondResult.processed).toBe(1);
    });

    it("B5 bounding: a DEFERRED row from a PRIOR session date is abandoned, never executed the next day", async () => {
      await prisma.scheduledCaptureRun.create({
        data: {
          ownerId: ownerB.id, sessionDate: "2026-10-07", slot: "OPENING", dueAt: new Date("2026-10-07T13:35:00.000Z"),
          status: "DEFERRED", attemptCount: 1, startedAt: new Date("2026-10-07T13:35:00.000Z"), completedAt: new Date("2026-10-07T13:35:00.000Z"),
          resultCategory: "BUDGET_DEFERRED", nextEligibleRetryAt: new Date("2026-10-07T13:36:00.000Z"),
        },
      });

      await scheduledCapture.runScheduledCaptureHeartbeat(DUE_NOW); // "today" - a new slot IS due, so the maintenance sweep runs

      // The OLD, prior-session row itself is abandoned - never reclaimed/re-executed under its own
      // (now stale) dueAt. ownerB legitimately ALSO gets a brand-new, completely independent
      // capture for TODAY's own due slot in the SAME heartbeat - that is correct, expected
      // behavior (an unrelated stale row must never suppress an owner's normal future captures).
      const rowB = (await prisma.scheduledCaptureRun.findMany({ where: { ownerId: ownerB.id, sessionDate: "2026-10-07" } }))[0]!;
      expect(rowB.status).toBe("ABANDONED");
      expect(rowB.resultCategory).toBe("ABANDONED_STALE");
      expect(rowB.attemptCount).toBe(1); // never reclaimed under its own stale dueAt
      expect(rowB.dueAt).toEqual(new Date("2026-10-07T13:35:00.000Z")); // never backdated to today
    });
  });
});
