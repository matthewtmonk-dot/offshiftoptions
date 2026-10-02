import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { EquityMarketSessionEvidence, QuoteReviewEvidence } from "@/providers/market-data/types";
import { evaluatePositionReview, type PositionReviewInput, type PositionReviewResult } from "@/domain/finance/positionReview";
import type { CurrentPositionAssessmentCandidate, PositionReviewAssessmentScope, PositionReviewContextFingerprintInput } from "@/domain/finance/positionReviewAssessment";

const dbTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);

const NY_DATE = "2026-06-15";
const NOON = new Date(`${NY_DATE}T16:00:00Z`);
const SESSION_OPEN = new Date(`${NY_DATE}T09:30:00-04:00`);
const SESSION_CLOSE = new Date(`${NY_DATE}T16:00:00-04:00`);

function ordinarySession(): EquityMarketSessionEvidence {
  return {
    status: "AVAILABLE",
    requestedDate: NY_DATE,
    returnedDate: NY_DATE,
    marketType: "EQUITY",
    product: "EQ",
    isOpen: true,
    regularMarketIntervals: [{ start: SESSION_OPEN, end: SESSION_CLOSE }],
  };
}

function quote(price: number, tradeTime: Date = NOON): QuoteReviewEvidence {
  return {
    status: "AVAILABLE",
    requestedSymbol: "UPST",
    returnedSymbol: "UPST",
    assetMainType: "EQUITY",
    realtime: true,
    price,
    tradeTime,
    requestStartedAt: tradeTime,
    responseReceivedAt: tradeTime,
  };
}

/** Dedicated DB-level coverage for the Phase 1 "Last Valid Position Assessment" persistence/read
 * service (positionReviewAssessmentStore.ts) - the newer-only upsert, decimal round-trip, and
 * owner-isolation guarantees can only be proven against a real Postgres instance, never a mock. */
(dbTests ? describe : describe.skip)("positionReviewAssessmentStore (DB)", () => {
  let prisma: typeof import("./prisma").prisma;
  let store: typeof import("./positionReviewAssessmentStore");
  const ownerA = { id: "" };
  const ownerB = { id: "" };
  let accountA: string;
  let campaignA: string;
  let openingEventA: string;

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    store = await import("./positionReviewAssessmentStore");

    const userA = await prisma.user.create({ data: { name: "Owner A", email: `${randomUUID()}@lst.local`, passwordHash: "unused" } });
    const userB = await prisma.user.create({ data: { name: "Owner B", email: `${randomUUID()}@lst.local`, passwordHash: "unused" } });
    ownerA.id = userA.id;
    ownerB.id = userB.id;

    const acctA = await prisma.tradingAccount.create({ data: { userId: ownerA.id, name: "A", source: "SCHWAB", externalAccountId: randomUUID(), visibility: "PRIVATE" } });
    await prisma.tradingAccount.create({ data: { userId: ownerB.id, name: "B", source: "SCHWAB", externalAccountId: randomUUID(), visibility: "PRIVATE" } });
    accountA = acctA.id;

    const campaign = await prisma.campaign.create({ data: { ownerId: ownerA.id, accountId: accountA, ticker: "UPST", status: "OPEN", openedAt: new Date("2026-05-01T00:00:00.000Z") } });
    campaignA = campaign.id;

    const event = await prisma.campaignEvent.create({
      data: { campaignId: campaignA, type: "SELL_PUT", occurredAt: new Date("2026-05-01T00:00:00.000Z"), optionType: "PUT", contracts: 1, strike: 25, expiration: new Date("2026-10-02T00:00:00.000Z"), premium: 1 },
    });
    openingEventA = event.id;
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({ where: { id: { in: [ownerA.id, ownerB.id] } } });
      await prisma.$disconnect();
    }
  });

  // Each test writes against the same fixed scope/openingEventId (for realistic unique-constraint
  // coverage) - a clean slate per test keeps the newer-only/concurrency assertions from depending
  // on execution order or on rows a previous test happened to leave behind.
  afterEach(async () => {
    await prisma.positionReviewAssessment.deleteMany({ where: { ownerId: { in: [ownerA.id, ownerB.id] } } });
  });

  function scope(overrides: Partial<PositionReviewAssessmentScope> = {}): PositionReviewAssessmentScope {
    return { ownerId: ownerA.id, accountId: accountA, campaignId: campaignA, openingEventId: openingEventA, ...overrides };
  }

  function contextInput(overrides: Partial<PositionReviewContextFingerprintInput> = {}): PositionReviewContextFingerprintInput {
    return {
      scope: scope(),
      ticker: "UPST",
      optionType: "PUT",
      strike: 25,
      expiration: new Date("2026-10-02T00:00:00.000Z"),
      contracts: 1,
      campaignStatus: "OPEN",
      campaignLifecycleStage: "Cash-secured put",
      accountSource: "SCHWAB",
      brokerageMappingIdentity: "broker-a",
      appliedRollBufferPercent: 3,
      evaluationPolicyVersion: 1,
      ...overrides,
    };
  }

  function baseInput(overrides: Partial<PositionReviewInput> = {}): PositionReviewInput {
    return {
      campaignId: campaignA,
      accountId: accountA,
      ticker: "UPST",
      leg: { kind: "PUT", strike: 25, expiration: new Date("2026-10-02T00:00:00.000Z"), contracts: 1 },
      lifecycleStage: "Cash-secured put",
      rollBufferPercent: 3,
      position: { state: "SCHWAB_CONFIRMED", asOf: NOON },
      quote: quote(30),
      session: ordinarySession(),
      now: NOON,
      ...overrides,
    };
  }

  function candidateFor(result: PositionReviewResult, contextOverrides: Partial<PositionReviewContextFingerprintInput> = {}): CurrentPositionAssessmentCandidate {
    return { scope: scope(), context: contextInput(contextOverrides), result, sessionEvidence: ordinarySession() };
  }

  const alwaysFreshMatchingContext = (overrides: Partial<PositionReviewContextFingerprintInput> = {}) => async () => contextInput(overrides);

  it("saves an eligible COMFORTABLE result and reads it back with decimals round-tripped as numbers", async () => {
    const result = evaluatePositionReview(baseInput({ now: NOON, quote: quote(30) }));
    expect(result.action).toBe("COMFORTABLE");

    const outcome = await store.savePositionReviewAssessmentIfEligible(candidateFor(result), NOON, { verifyFreshContext: alwaysFreshMatchingContext() });
    expect(outcome).toEqual({ status: "SAVED" });

    const { computePositionReviewContextFingerprint } = await import("@/domain/finance/positionReviewAssessment");
    const current = {
      scope: scope(),
      contextFingerprint: computePositionReviewContextFingerprint(contextInput()),
      positionEvidenceState: "SCHWAB_CONFIRMED" as const,
      lifecycle: "CURRENT_PUT" as const,
    };
    const reread = await store.getLastValidPositionAssessment({ ownerId: ownerA.id, scope: scope(), current });

    expect(reread).not.toBeNull();
    expect(reread!.action).toBe("COMFORTABLE");
    expect(reread!.underlyingPrice).toBe(30);
    expect(reread!.strike).toBe(25);
    expect(reread!.dollarDistance).toBe(5);
    expect(reread!.percentageDistance).toBeCloseTo(20, 4);
    expect(reread!.appliedRollBufferPercent).toBe(3);
    expect(typeof reread!.underlyingPrice).toBe("number");
  });

  it("never persists an ineligible (CANNOT_ASSESS) evaluation", async () => {
    const result = evaluatePositionReview(baseInput({ leg: { kind: "NONE" } }));
    expect(result.action).toBe("CANNOT_ASSESS");
    const outcome = await store.savePositionReviewAssessmentIfEligible(candidateFor(result), NOON, { verifyFreshContext: alwaysFreshMatchingContext() });
    expect(outcome).toEqual({ status: "INELIGIBLE", reasonCode: "NOT_MEANINGFUL_ACTION" });
  });

  it("aborts without writing when the fresh context recheck finds a changed context", async () => {
    const result = evaluatePositionReview(baseInput({ quote: quote(30) }));
    const outcome = await store.savePositionReviewAssessmentIfEligible(candidateFor(result), NOON, {
      verifyFreshContext: alwaysFreshMatchingContext({ strike: 999 }),
    });
    expect(outcome).toEqual({ status: "CONTEXT_CHANGED" });
  });

  it("aborts without writing when the fresh context recheck finds the leg is gone", async () => {
    const result = evaluatePositionReview(baseInput({ quote: quote(30) }));
    const outcome = await store.savePositionReviewAssessmentIfEligible(candidateFor(result), NOON, { verifyFreshContext: async () => null });
    expect(outcome).toEqual({ status: "CONTEXT_CHANGED" });
  });

  it("never lets an older evaluation overwrite a newer one already written (newer-only upsert)", async () => {
    const earlier = new Date(`${NY_DATE}T14:05:00Z`);
    const later = new Date(`${NY_DATE}T14:06:00Z`);

    const resultB = evaluatePositionReview(baseInput({ now: later, quote: quote(31, later), position: { state: "SCHWAB_CONFIRMED", asOf: later } }));
    const savedB = await store.savePositionReviewAssessmentIfEligible(candidateFor(resultB), later, { verifyFreshContext: alwaysFreshMatchingContext() });
    expect(savedB).toEqual({ status: "SAVED" });

    const resultA = evaluatePositionReview(baseInput({ now: earlier, quote: quote(29, earlier), position: { state: "SCHWAB_CONFIRMED", asOf: earlier } }));
    const savedA = await store.savePositionReviewAssessmentIfEligible(candidateFor(resultA), earlier, { verifyFreshContext: alwaysFreshMatchingContext() });
    expect(savedA).toEqual({ status: "SUPERSEDED_BY_NEWER" });

    const row = await prisma.positionReviewAssessment.findUnique({ where: { ownerId_accountId_campaignId_openingEventId: scope() } });
    expect(row?.underlyingPrice.toNumber()).toBe(31);
  });

  describe("owner isolation", () => {
    it("getLastValidPositionAssessment throws rather than querying a mismatched owner/scope pair", async () => {
      await expect(
        store.getLastValidPositionAssessment({ ownerId: ownerB.id, scope: scope(), current: null }),
      ).rejects.toThrow(/ownerId does not match scope\.ownerId/);
    });

    it("owner B's own (non-existent) scope never sees owner A's row, even with the same would-be identifiers reused as a different owner's scope", async () => {
      const result = evaluatePositionReview(baseInput({ quote: quote(30) }));
      await store.savePositionReviewAssessmentIfEligible(candidateFor(result), NOON, { verifyFreshContext: alwaysFreshMatchingContext() });

      const crossOwnerScope = scope({ ownerId: ownerB.id });
      const read = await store.getLastValidPositionAssessment({ ownerId: ownerB.id, scope: crossOwnerScope, current: null });
      expect(read).toBeNull();

      const rowForB = await prisma.positionReviewAssessment.findUnique({ where: { ownerId_accountId_campaignId_openingEventId: crossOwnerScope } });
      expect(rowForB).toBeNull();
    });
  });

  describe("historical match/read eligibility composed through the store", () => {
    it("returns null once the opening event id has changed (roll/reopen)", async () => {
      const result = evaluatePositionReview(baseInput({ quote: quote(30) }));
      await store.savePositionReviewAssessmentIfEligible(candidateFor(result), NOON, { verifyFreshContext: alwaysFreshMatchingContext() });

      const { computePositionReviewContextFingerprint } = await import("@/domain/finance/positionReviewAssessment");
      const current = {
        scope: scope({ openingEventId: "evt-rolled" }),
        contextFingerprint: computePositionReviewContextFingerprint(contextInput()),
        positionEvidenceState: "SCHWAB_CONFIRMED" as const,
        lifecycle: "CURRENT_PUT" as const,
      };
      const read = await store.getLastValidPositionAssessment({ ownerId: ownerA.id, scope: scope(), current });
      expect(read).toBeNull();
    });

    it("returns null once the current leg no longer exists (closed/assigned)", async () => {
      const result = evaluatePositionReview(baseInput({ quote: quote(30) }));
      await store.savePositionReviewAssessmentIfEligible(candidateFor(result), NOON, { verifyFreshContext: alwaysFreshMatchingContext() });

      const read = await store.getLastValidPositionAssessment({ ownerId: ownerA.id, scope: scope(), current: null });
      expect(read).toBeNull();
    });
  });
});
