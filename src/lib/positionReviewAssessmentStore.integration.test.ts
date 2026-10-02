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
  let mappingA: string;
  let accountB: string;
  let campaignB: string;
  let openingEventB: string;
  let openingEventA: string;

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    store = await import("./positionReviewAssessmentStore");

    const userA = await prisma.user.create({ data: { name: "Owner A", email: `${randomUUID()}@lst.local`, passwordHash: "unused" } });
    const userB = await prisma.user.create({ data: { name: "Owner B", email: `${randomUUID()}@lst.local`, passwordHash: "unused" } });
    ownerA.id = userA.id;
    ownerB.id = userB.id;

    const acctA = await prisma.tradingAccount.create({ data: { userId: ownerA.id, name: "A", source: "SCHWAB", externalAccountId: randomUUID(), visibility: "PRIVATE" } });
    const acctB = await prisma.tradingAccount.create({ data: { userId: ownerB.id, name: "B", source: "SCHWAB", externalAccountId: randomUUID(), visibility: "PRIVATE" } });
    accountA = acctA.id;
    mappingA = acctA.externalAccountId!;
    accountB = acctB.id;

    const campaign = await prisma.campaign.create({ data: { ownerId: ownerA.id, accountId: accountA, ticker: "UPST", status: "OPEN", openedAt: new Date("2026-05-01T00:00:00.000Z") } });
    campaignA = campaign.id;

    const event = await prisma.campaignEvent.create({
      data: { campaignId: campaignA, type: "SELL_PUT", occurredAt: new Date("2026-05-01T00:00:00.000Z"), optionType: "PUT", contracts: 1, strike: 25, expiration: new Date("2026-10-02T00:00:00.000Z"), premium: 1 },
    });
    openingEventA = event.id;
    const other = await prisma.campaign.create({ data: { ownerId: ownerB.id, accountId: accountB, ticker: "UPST", status: "OPEN", openedAt: NOON } });
    campaignB = other.id;
    openingEventB = (await prisma.campaignEvent.create({ data: { campaignId: campaignB, type: "SELL_PUT", occurredAt: NOON, optionType: "PUT", strike: 25, contracts: 1, expiration: new Date("2026-10-02T00:00:00Z") } })).id;
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
      brokerageMappingIdentity: mappingA,
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
    const evaluationInput = baseInput({
      now: result.explanation.evaluatedAt,
      leg: { kind: result.explanation.optionType ?? "PUT", strike: 25, contracts: 1, expiration: new Date("2026-10-02T00:00:00.000Z") },
      quote: quote(result.explanation.stockPrice ?? 30, result.explanation.quoteTradeTime ?? NOON),
      position: result.evidence.position === "MANUAL_POSITION" ? { state: "MANUAL_POSITION" } : { state: "SCHWAB_CONFIRMED", asOf: result.explanation.positionEvidenceAsOf ?? NOON },
    });
    return { scope: scope(), context: contextInput(contextOverrides), result, evaluationInput, evaluationScope: { ...scope() }, sessionEvidence: ordinarySession() };
  }

  it("saves an eligible COMFORTABLE result and reads it back with decimals round-tripped as numbers", async () => {
    const result = evaluatePositionReview(baseInput({ now: NOON, quote: quote(30) }));
    expect(result.action).toBe("COMFORTABLE");

    const outcome = await store.savePositionReviewAssessmentIfEligible(ownerA.id, candidateFor(result), { clock: () => NOON });
    expect(outcome).toEqual({ status: "SAVED" });

    const { computePositionReviewContextFingerprint } = await import("@/domain/finance/positionReviewAssessment");
    const current = {
      scope: scope(),
      contextFingerprint: computePositionReviewContextFingerprint(contextInput()),
      positionEvidenceState: "SCHWAB_CONFIRMED" as const,
      lifecycle: "CURRENT_PUT" as const,
      reasonCodes: [],
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
    const outcome = await store.savePositionReviewAssessmentIfEligible(ownerA.id, candidateFor(result), { clock: () => NOON });
    expect(outcome).toEqual({ status: "INELIGIBLE", reasonCode: "NOT_MEANINGFUL_ACTION" });
  });

  it("rejects a caller context whose mapping disagrees with the authoritative account", async () => {
    const candidate = candidateFor(evaluatePositionReview(baseInput()), { brokerageMappingIdentity: "fabricated" });
    expect(await store.savePositionReviewAssessmentIfEligible(ownerA.id, candidate, { clock: () => NOON })).toEqual({ status: "CONTEXT_CHANGED" });
  });

  it("never lets an older evaluation overwrite a newer one already written (newer-only upsert)", async () => {
    const earlier = new Date(`${NY_DATE}T14:05:00Z`);
    const later = new Date(`${NY_DATE}T14:06:00Z`);

    const resultB = evaluatePositionReview(baseInput({ now: later, quote: quote(31, later), position: { state: "SCHWAB_CONFIRMED", asOf: later } }));
    const savedB = await store.savePositionReviewAssessmentIfEligible(ownerA.id, candidateFor(resultB), { clock: () => later });
    expect(savedB).toEqual({ status: "SAVED" });

    const resultA = evaluatePositionReview(baseInput({ now: earlier, quote: quote(29, earlier), position: { state: "SCHWAB_CONFIRMED", asOf: earlier } }));
    const savedA = await store.savePositionReviewAssessmentIfEligible(ownerA.id, candidateFor(resultA), { clock: () => earlier });
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
      await store.savePositionReviewAssessmentIfEligible(ownerA.id, candidateFor(result), { clock: () => NOON });

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
      await store.savePositionReviewAssessmentIfEligible(ownerA.id, candidateFor(result), { clock: () => NOON });

      const { computePositionReviewContextFingerprint } = await import("@/domain/finance/positionReviewAssessment");
      const current = {
        scope: scope({ openingEventId: "evt-rolled" }),
        contextFingerprint: computePositionReviewContextFingerprint(contextInput()),
        positionEvidenceState: "SCHWAB_CONFIRMED" as const,
        lifecycle: "CURRENT_PUT" as const,
      reasonCodes: [],
      };
      const read = await store.getLastValidPositionAssessment({ ownerId: ownerA.id, scope: scope(), current });
      expect(read).toBeNull();
    });

    it("returns null once the current leg no longer exists (closed/assigned)", async () => {
      const result = evaluatePositionReview(baseInput({ quote: quote(30) }));
      await store.savePositionReviewAssessmentIfEligible(ownerA.id, candidateFor(result), { clock: () => NOON });

      const read = await store.getLastValidPositionAssessment({ ownerId: ownerA.id, scope: scope(), current: null });
      expect(read).toBeNull();
    });
  });
  describe("repair: authoritative write boundary", () => {
    function valid() { return candidateFor(evaluatePositionReview(baseInput())); }
    function rebind(c: CurrentPositionAssessmentCandidate, changes: Partial<PositionReviewAssessmentScope>) {
      c.scope = { ...c.scope, ...changes }; c.context.scope = c.scope; c.evaluationScope = { ...c.scope };
      c.evaluationInput.accountId = c.scope.accountId; c.evaluationInput.campaignId = c.scope.campaignId;
      c.result = evaluatePositionReview(c.evaluationInput);
      return c;
    }
    it("requires authenticated owner independently of candidate owner", async () => {
      expect(await store.savePositionReviewAssessmentIfEligible(ownerB.id, valid(), { clock: () => NOON })).toEqual({ status: "UNAUTHORIZED" });
      expect(await prisma.positionReviewAssessment.count()).toBe(0);
    });
    it.each(["account", "campaign", "event"])("rejects foreign %s even when result agrees with supplied scope", async field => {
      const c = rebind(valid(), field === "account" ? { accountId: accountB } : field === "campaign" ? { campaignId: campaignB } : { openingEventId: openingEventB });
      expect(await store.savePositionReviewAssessmentIfEligible(ownerA.id, c, { clock: () => NOON })).toEqual({ status: "CONTEXT_CHANGED" });
      expect(await prisma.positionReviewAssessment.count()).toBe(0);
    });
    it("rejects a same-owner campaign attached to the wrong account", async () => {
      const other = await prisma.campaign.create({ data: { ownerId: ownerA.id, accountId: accountB, ticker: "UPST", status: "OPEN", openedAt: NOON } });
      const c = rebind(valid(), { campaignId: other.id });
      expect(await store.savePositionReviewAssessmentIfEligible(ownerA.id, c, { clock: () => NOON })).toEqual({ status: "CONTEXT_CHANGED" });
    });
    it("rejects a noncurrent opening event belonging to the same campaign", async () => {
      const old = await prisma.campaignEvent.create({ data: { campaignId: campaignA, type: "SELL_PUT", occurredAt: new Date("2026-04-01T00:00:00Z"), strike: 25, contracts: 1, optionType: "PUT", expiration: new Date("2026-10-02T00:00:00Z") } });
      try {
        expect(await store.savePositionReviewAssessmentIfEligible(ownerA.id, rebind(valid(), { openingEventId: old.id }), { clock: () => NOON })).toEqual({ status: "CONTEXT_CHANGED" });
      } finally { await prisma.campaignEvent.delete({ where: { id: old.id } }); }
    });
    it.each([
      ["ticker", { ticker: "OTHER" }], ["strike", { strike: 24 }],
      ["expiration", { expiration: new Date("2026-10-09T00:00:00Z") }], ["quantity", { contracts: 2 }],
      ["PUT/CALL", { optionType: "CALL" }], ["roll buffer", { appliedRollBufferPercent: 4 }],
      ["policy", { evaluationPolicyVersion: 2 }], ["lifecycle", { campaignLifecycleStage: "Rolled put" }],
    ] as Array<[string, Partial<PositionReviewContextFingerprintInput>]>)("rejects fabricated %s even with a matching replayed evaluator result", async (_name, change) => {
      const c = valid(); c.context = { ...c.context, ...change };
      const ctx = c.context;
      c.evaluationInput = { ...c.evaluationInput, ticker: ctx.ticker, leg: { kind: ctx.optionType, strike: ctx.strike, expiration: ctx.expiration, contracts: ctx.contracts }, rollBufferPercent: ctx.appliedRollBufferPercent, lifecycleStage: ctx.campaignLifecycleStage as PositionReviewInput["lifecycleStage"], quote: { ...quote(30), requestedSymbol: ctx.ticker, returnedSymbol: ctx.ticker } as QuoteReviewEvidence };
      c.result = evaluatePositionReview(c.evaluationInput);
      const outcome = await store.savePositionReviewAssessmentIfEligible(ownerA.id, c, { clock: () => NOON });
      expect(["CONTEXT_CHANGED", "INELIGIBLE"]).toContain(outcome.status);
      expect(await prisma.positionReviewAssessment.count()).toBe(0);
    });
    it("rejects campaign A result transplanted onto campaign B scope", async () => {
      const c = valid(); c.scope = { ownerId: ownerB.id, accountId: accountB, campaignId: campaignB, openingEventId: openingEventB }; c.context.scope = c.scope;
      expect(await store.savePositionReviewAssessmentIfEligible(ownerB.id, c, { clock: () => NOON })).toEqual({ status: "INELIGIBLE", reasonCode: "RESULT_CONTEXT_MISMATCH" });
    });
    it("rejects a policy changed in the authoritative settings row", async () => {
      await prisma.userSettings.create({ data: { userId: ownerA.id, rollBufferPercent: 5 } });
      try { expect(await store.savePositionReviewAssessmentIfEligible(ownerA.id, valid(), { clock: () => NOON })).toEqual({ status: "CONTEXT_CHANGED" }); }
      finally { await prisma.userSettings.delete({ where: { userId: ownerA.id } }); }
    });
    it.each(["guidance", "position receipt", "session close", "invalid clock"])("rechecks %s after asynchronous DB validation", async kind => {
      const input = baseInput(kind === "position receipt" ? { position: { state: "SCHWAB_CONFIRMED", asOf: new Date(NOON.getTime() - 299000) } } : {});
      const c = candidateFor(evaluatePositionReview(input)); c.evaluationInput = input;
      let reads = 0;
      const late = kind === "position receipt" ? new Date(NOON.getTime() + 1001) : kind === "session close" ? SESSION_CLOSE : kind === "invalid clock" ? new Date(NaN) : new Date(NOON.getTime() + 120001);
      expect((await store.savePositionReviewAssessmentIfEligible(ownerA.id, c, { clock: () => ++reads === 1 ? NOON : late })).status).toBe("INELIGIBLE");
      expect(reads).toBe(2);
      expect(await prisma.positionReviewAssessment.count()).toBe(0);
    });
    it("equal evaluatedAt preserves the first committed payload", async () => {
      expect(await store.savePositionReviewAssessmentIfEligible(ownerA.id, valid(), { clock: () => NOON })).toEqual({ status: "SAVED" });
      const second = candidateFor(evaluatePositionReview(baseInput({ quote: quote(31) })));
      expect(await store.savePositionReviewAssessmentIfEligible(ownerA.id, second, { clock: () => NOON })).toEqual({ status: "SUPERSEDED_BY_NEWER" });
      expect((await prisma.positionReviewAssessment.findFirstOrThrow()).underlyingPrice.toNumber()).toBe(30);
    });
    it("parallel writers converge on the newer evaluation", async () => {
      const later = new Date(NOON.getTime() + 1000);
      const newerInput = baseInput({ now: later, quote: quote(31, later), position: { state: "SCHWAB_CONFIRMED", asOf: later } });
      const outcomes = await Promise.all([
        store.savePositionReviewAssessmentIfEligible(ownerA.id, valid(), { clock: () => later }),
        store.savePositionReviewAssessmentIfEligible(ownerA.id, candidateFor(evaluatePositionReview(newerInput)), { clock: () => later }),
      ]);
      expect(outcomes.every(o => ["SAVED", "SUPERSEDED_BY_NEWER"].includes(o.status))).toBe(true);
      expect((await prisma.positionReviewAssessment.findFirstOrThrow()).underlyingPrice.toNumber()).toBe(31);
    });
    it.each(["CLOSED", "ASSIGNED"] as const)("rejects a put whose campaign became %s", async status => {
      await prisma.campaign.update({ where: { id: campaignA }, data: { status } });
      try {
        expect(await store.savePositionReviewAssessmentIfEligible(ownerA.id, valid(), { clock: () => NOON })).toEqual({ status: "CONTEXT_CHANGED" });
        expect(await prisma.positionReviewAssessment.count()).toBe(0);
      } finally { await prisma.campaign.update({ where: { id: campaignA }, data: { status: "OPEN" } }); }
    });
    it("observes a roll committed while the save waits on authoritative account validation", async () => {
      let unlock!: () => void; let locked!: () => void; let started!: () => void;
      const gate = new Promise<void>(resolve => { unlock = resolve; });
      const lockReady = new Promise<void>(resolve => { locked = resolve; });
      const saveStarted = new Promise<void>(resolve => { started = resolve; });
      const rollId = randomUUID();
      const writer = prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "TradingAccount" WHERE "id" = ${accountA} FOR UPDATE`;
        locked(); await gate;
        await tx.campaignEvent.create({ data: { id: rollId, campaignId: campaignA, type: "ROLL_PUT_OPEN", occurredAt: NOON, optionType: "PUT", strike: 25, contracts: 1, expiration: new Date("2026-10-02T00:00:00Z") } });
      });
      await lockReady;
      const saving = store.savePositionReviewAssessmentIfEligible(ownerA.id, valid(), { clock: () => { started(); return NOON; } });
      await saveStarted;
      try {
        // Prove an actual PostgreSQL lock wait, rather than relying on promise scheduling.
        let waiting = false;
        const timeout = Date.now() + 3000;
        while (!waiting && Date.now() < timeout) {
          const rows = await prisma.$queryRaw<Array<{ waiting: boolean }>>`
            SELECT EXISTS (SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%FROM "TradingAccount"%FOR UPDATE%') AS waiting`;
          waiting = rows[0].waiting;
          if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        unlock();
        await writer;
        expect(await saving).toEqual({ status: "CONTEXT_CHANGED" });
        const { getCurrentOpenPut } = await import("@/domain/finance/campaigns");
        expect(getCurrentOpenPut(await prisma.campaignEvent.findMany({ where: { campaignId: campaignA } }))?.openingEventId).toBe(rollId);
        expect(await prisma.positionReviewAssessment.count()).toBe(0);
      } finally {
        unlock(); await writer; await saving;
        await prisma.campaignEvent.deleteMany({ where: { id: rollId } });
      }
    });
    it.each([[24, "ITM"], [25, "ATM"], [26, "OTM"], [25.00001, "OTM"], [24.99999, "ITM"]] as const)("round-trips exact moneyness at price %s", async (price, expected) => {
      const c = candidateFor(evaluatePositionReview(baseInput({ quote: quote(price) })));
      expect(c.result.explanation.moneyness).toBe(expected);
      expect(await store.savePositionReviewAssessmentIfEligible(ownerA.id, c, { clock: () => NOON })).toEqual({ status: "SAVED" });
      const { computePositionReviewContextFingerprint } = await import("@/domain/finance/positionReviewAssessment");
      const read = await store.getLastValidPositionAssessment({ ownerId: ownerA.id, scope: scope(), current: { scope: scope(), contextFingerprint: computePositionReviewContextFingerprint(contextInput()), positionEvidenceState: "SCHWAB_CONFIRMED", lifecycle: "CURRENT_PUT", reasonCodes: [] } });
      expect(read?.moneyness).toBe(expected);
      if (Math.abs(price - 25) < 0.0001 && price !== 25) {
        expect(read?.underlyingPrice).toBe(25);
        expect(read?.dollarDistance).toBe(0);
        expect(read?.moneyness).not.toBe("ATM");
      }
    });
  });

});
