import type { SchwabReconciliationEvidence } from "@/domain/finance/schwabReconciliation";
import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function completeEvidence(): SchwabReconciliationEvidence {
  return {
    positions: { status: "COMPLETE", data: [] },
    transactions: { status: "COMPLETE", from: new Date("2026-01-01"), to: new Date("2026-09-30") },
    persistenceStatus: "COMPLETE",
  };
}

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

/**
 * Covered Call Phase 3B (see PROJECT_HANDOFF.md): automates ONLY covered-call Sell to Open / Buy
 * to Close via reconcileSchwabCoveredCallActivityForUser - a deliberately separate path from the
 * put reconciler (reconcileSchwabActivityForUser), which stays untouched (see
 * campaign-reconciliation.integration.test.ts for its own unaffected regression coverage).
 */
maybeDescribe("Schwab covered-call auto-reconciliation", () => {
  let prisma: typeof import("./prisma").prisma;
  let createTradingAccountForUser: typeof import("./workflows").createTradingAccountForUser;
  let createCampaignForUser: typeof import("./workflows").createCampaignForUser;
  let assignCampaignPutForUser: typeof import("./workflows").assignCampaignPutForUser;
  let reconcileSchwabCoveredCallActivityForUser: typeof import("./covered-call-reconciliation").reconcileSchwabCoveredCallActivityForUser;
  let reconcileSchwabActivityForUser: typeof import("./campaign-reconciliation").reconcileSchwabActivityForUser;
  let userA: { id: string };
  let userB: { id: string };
  const userIds: string[] = [];
  let fingerprintCounter = 0;

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    ({ createTradingAccountForUser, createCampaignForUser, assignCampaignPutForUser } = await import("./workflows"));
    ({ reconcileSchwabCoveredCallActivityForUser } = await import("./covered-call-reconciliation"));
    ({ reconcileSchwabActivityForUser } = await import("./campaign-reconciliation"));

    const passwordHash = await hash("not-used", 4);
    const timestamp = Date.now();
    userA = await prisma.user.create({ data: { name: "CC Recon User A", email: `cc-recon-a-${timestamp}@lst.local`, passwordHash } });
    userB = await prisma.user.create({ data: { name: "CC Recon User B", email: `cc-recon-b-${timestamp}@lst.local`, passwordHash } });
    userIds.push(userA.id, userB.id);
  });

  afterAll(async () => {
    await prisma.brokerRecord.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.campaign.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.tradingAccount.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  /** Creates an ASSIGNED campaign with `contracts` * 100 shares held, via the same validated
   * manual workflow path Phase 1 already tests - not a shortcut, the real state machine. */
  async function createAssignedCampaign(userId: string, accountId: string, ticker: string, contracts: number, strike = "40") {
    const campaign = await createCampaignForUser(
      userId,
      accountId,
      ticker,
      "2026-08-01",
      "2026-08-28",
      strike,
      String(contracts),
      "0.30",
      "0",
      "Covered call reconciliation test",
      "PRIVATE",
    );
    return (await assignCampaignPutForUser(userId, campaign.id, "2026-08-28", "", "0", null))!;
  }

  async function createTransaction(
    userId: string,
    accountId: string,
    overrides: {
      symbol: string;
      underlyingSymbol: string;
      action: string;
      occurredAt: Date;
      quantity?: number;
      price?: number | null;
      fees?: number | null;
    },
  ) {
    fingerprintCounter += 1;
    return prisma.brokerRecord.create({
      data: {
        userId,
        accountId,
        provider: "SCHWAB",
        kind: "TRANSACTION",
        status: "CONFIRMED",
        fingerprint: `test-cc-fingerprint-${userId}-${fingerprintCounter}`,
        identityKey: `test-cc-identity-${userId}-${fingerprintCounter}`,
        symbol: overrides.symbol,
        underlyingSymbol: overrides.underlyingSymbol,
        action: overrides.action,
        occurredAt: overrides.occurredAt,
        quantity: overrides.quantity ?? 1,
        price: overrides.price ?? null,
        fees: overrides.fees === undefined ? 0 : overrides.fees,
        sources: ["SCHWAB_API"],
        metadata: {},
      },
    });
  }

  // --- CALL STO ---

  it("test 1/2/6: unique compatible assigned campaign (100 shares, 1 call) -> SELL_COVERED_CALL created and BrokerRecord linked", async () => {
    const account = await createTradingAccountForUser(userA.id, `CC STO Account ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    const campaign = await createAssignedCampaign(userA.id, account.id, "CCAA", 1);
    const txn = await createTransaction(userA.id, account.id, {
      symbol: "CCAA 260911C00044000",
      underlyingSymbol: "CCAA",
      action: "Sell to Open",
      occurredAt: new Date("2026-09-01T14:00:00Z"),
      price: 0.35,
    });

    const summary = await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);
    expect(summary.coveredCallsOpened).toBe(1);

    const updated = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id }, include: { events: true } });
    expect(updated.events.map((e) => e.type)).toContain("SELL_COVERED_CALL");
    const callEvent = updated.events.find((e) => e.type === "SELL_COVERED_CALL")!;
    expect(callEvent).toMatchObject({ strike: expect.any(Object), contracts: 1 });
    expect(Number(callEvent.strike)).toBe(44);

    const linkedRecord = await prisma.brokerRecord.findUniqueOrThrow({ where: { id: txn.id } });
    expect(linkedRecord.linkedCampaignId).toBe(campaign.id);
  });

  it("test 3: repeated reconciliation does not create a duplicate SELL_COVERED_CALL", async () => {
    const account = await createTradingAccountForUser(userA.id, `CC STO Repeat ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    const campaign = await createAssignedCampaign(userA.id, account.id, "CCAB", 1);
    await createTransaction(userA.id, account.id, {
      symbol: "CCAB 260911C00044000",
      underlyingSymbol: "CCAB",
      action: "Sell to Open",
      occurredAt: new Date("2026-09-01T14:00:00Z"),
      price: 0.35,
    });

    await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);
    const second = await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);
    expect(second.coveredCallsOpened).toBe(0);

    const updated = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id }, include: { events: true } });
    expect(updated.events.filter((e) => e.type === "SELL_COVERED_CALL")).toHaveLength(1);
  });

  it("test 4: no assigned shares -> no event, BrokerRecord stays unlinked for manual review", async () => {
    const account = await createTradingAccountForUser(userA.id, `CC STO NoShares ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    // A plain OPEN (never assigned) campaign - never eligible for a covered call.
    await createCampaignForUser(userA.id, account.id, "CCAC", "2026-08-01", "2026-09-18", "40", "1", "0.3", "0", null, "PRIVATE");
    const txn = await createTransaction(userA.id, account.id, {
      symbol: "CCAC 260911C00044000",
      underlyingSymbol: "CCAC",
      action: "Sell to Open",
      occurredAt: new Date("2026-09-01T14:00:00Z"),
      price: 0.35,
    });

    const summary = await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);
    expect(summary.coveredCallsOpened).toBe(0);
    expect((await prisma.brokerRecord.findUniqueOrThrow({ where: { id: txn.id } })).linkedCampaignId).toBeNull();
  });

  it("test 5: insufficient shares (100 held, 2 contracts requested) -> no event", async () => {
    const account = await createTradingAccountForUser(userA.id, `CC STO Insufficient ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    await createAssignedCampaign(userA.id, account.id, "CCAD", 1); // 100 shares
    const txn = await createTransaction(userA.id, account.id, {
      symbol: "CCAD 260911C00044000",
      underlyingSymbol: "CCAD",
      action: "Sell to Open",
      occurredAt: new Date("2026-09-01T14:00:00Z"),
      quantity: 2,
      price: 0.35,
    });

    const summary = await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);
    expect(summary.coveredCallsOpened).toBe(0);
    expect((await prisma.brokerRecord.findUniqueOrThrow({ where: { id: txn.id } })).linkedCampaignId).toBeNull();
  });

  it("test 7: 200 shares / 2 contracts requested -> works", async () => {
    const account = await createTradingAccountForUser(userA.id, `CC STO 200 ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    const campaign = await createAssignedCampaign(userA.id, account.id, "CCAE", 2); // 200 shares
    await createTransaction(userA.id, account.id, {
      symbol: "CCAE 260911C00044000",
      underlyingSymbol: "CCAE",
      action: "Sell to Open",
      occurredAt: new Date("2026-09-01T14:00:00Z"),
      quantity: 2,
      price: 0.35,
    });

    const summary = await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);
    expect(summary.coveredCallsOpened).toBe(1);
    const updated = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id }, include: { events: true } });
    expect(updated.events.find((e) => e.type === "SELL_COVERED_CALL")?.contracts).toBe(2);
  });

  it("test 8: multiple compatible assigned campaigns for the same ticker/account -> no auto-match", async () => {
    const account = await createTradingAccountForUser(userA.id, `CC STO Ambiguous ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    const campaignOne = await createAssignedCampaign(userA.id, account.id, "CCAF", 1);
    const campaignTwo = await createAssignedCampaign(userA.id, account.id, "CCAF", 1);
    const txn = await createTransaction(userA.id, account.id, {
      symbol: "CCAF 260911C00044000",
      underlyingSymbol: "CCAF",
      action: "Sell to Open",
      occurredAt: new Date("2026-09-01T14:00:00Z"),
      price: 0.35,
    });

    const summary = await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);
    expect(summary.coveredCallsOpened).toBe(0);
    expect((await prisma.brokerRecord.findUniqueOrThrow({ where: { id: txn.id } })).linkedCampaignId).toBeNull();

    const one = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignOne.id }, include: { events: true } });
    const two = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignTwo.id }, include: { events: true } });
    expect(one.events.some((e) => e.type === "SELL_COVERED_CALL")).toBe(false);
    expect(two.events.some((e) => e.type === "SELL_COVERED_CALL")).toBe(false);
  });

  it("test 9: a BrokerRecord under a different account never reconciles against this account's campaign", async () => {
    const accountOne = await createTradingAccountForUser(userA.id, `CC STO AcctOne ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    const accountTwo = await createTradingAccountForUser(userA.id, `CC STO AcctTwo ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    await createAssignedCampaign(userA.id, accountOne.id, "CCAG", 1);
    const txn = await createTransaction(userA.id, accountTwo.id, {
      symbol: "CCAG 260911C00044000",
      underlyingSymbol: "CCAG",
      action: "Sell to Open",
      occurredAt: new Date("2026-09-01T14:00:00Z"),
      price: 0.35,
    });

    const summaryWrongAccount = await reconcileSchwabCoveredCallActivityForUser(userA.id, accountTwo.id);
    expect(summaryWrongAccount.coveredCallsOpened).toBe(0);
    expect((await prisma.brokerRecord.findUniqueOrThrow({ where: { id: txn.id } })).linkedCampaignId).toBeNull();
  });

  it("test 10: a BrokerRecord under a different user is never visible to another user's reconciliation", async () => {
    const accountA = await createTradingAccountForUser(userA.id, `CC STO UserA ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    const accountB = await createTradingAccountForUser(userB.id, `CC STO UserB ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    await createAssignedCampaign(userB.id, accountB.id, "CCAH", 1);
    const txn = await createTransaction(userA.id, accountA.id, {
      symbol: "CCAH 260911C00044000",
      underlyingSymbol: "CCAH",
      action: "Sell to Open",
      occurredAt: new Date("2026-09-01T14:00:00Z"),
      price: 0.35,
    });

    // Reconciling user B's own account never sees user A's BrokerRecord at all (different account).
    const summary = await reconcileSchwabCoveredCallActivityForUser(userB.id, accountB.id);
    expect(summary.coveredCallsOpened).toBe(0);
    expect((await prisma.brokerRecord.findUniqueOrThrow({ where: { id: txn.id } })).linkedCampaignId).toBeNull();
  });

  it("test 11: a malformed OCC symbol never produces an event", async () => {
    const account = await createTradingAccountForUser(userA.id, `CC STO Malformed ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    await createAssignedCampaign(userA.id, account.id, "CCAI", 1);
    const txn = await createTransaction(userA.id, account.id, {
      symbol: "not-a-valid-occ-symbol",
      underlyingSymbol: "CCAI",
      action: "Sell to Open",
      occurredAt: new Date("2026-09-01T14:00:00Z"),
      price: 0.35,
    });

    const summary = await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);
    expect(summary.coveredCallsOpened).toBe(0);
    expect((await prisma.brokerRecord.findUniqueOrThrow({ where: { id: txn.id } })).linkedCampaignId).toBeNull();
  });

  it("test 12: PUT Sell to Open still follows the existing CSP path, unaffected by covered-call reconciliation", async () => {
    const account = await createTradingAccountForUser(userA.id, `CC STO PutUnaffected ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    await createTransaction(userA.id, account.id, {
      symbol: "CCAJ 260911P00020000",
      underlyingSymbol: "CCAJ",
      action: "Sell to Open",
      occurredAt: new Date("2026-09-01T14:00:00Z"),
      price: 0.3,
    });

    // The covered-call reconciler never touches a PUT transaction - it stays unlinked here.
    const ccSummary = await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);
    expect(ccSummary.coveredCallsOpened).toBe(0);

    // The existing put reconciler still opens a brand-new CSP campaign from it, exactly as before.
    const putSummary = await reconcileSchwabActivityForUser(userA.id, account.id, completeEvidence());
    expect(putSummary.campaignsOpened).toBe(1);
  });

  // --- CALL BTC ---

  it("test 13/14: exact current open CALL + Buy to Close -> CLOSE_COVERED_CALL created and linked", async () => {
    const account = await createTradingAccountForUser(userA.id, `CC BTC Exact ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    const campaign = await createAssignedCampaign(userA.id, account.id, "CCAK", 1);
    await createTransaction(userA.id, account.id, {
      symbol: "CCAK 260911C00044000",
      underlyingSymbol: "CCAK",
      action: "Sell to Open",
      occurredAt: new Date("2026-09-01T14:00:00Z"),
      price: 0.35,
    });
    await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);

    const closeTxn = await createTransaction(userA.id, account.id, {
      symbol: "CCAK 260911C00044000",
      underlyingSymbol: "CCAK",
      action: "Buy to Close",
      occurredAt: new Date("2026-09-08T14:00:00Z"),
      price: 0.1,
    });

    const summary = await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);
    expect(summary.coveredCallsClosed).toBe(1);

    const updated = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id }, include: { events: true } });
    expect(updated.events.map((e) => e.type)).toEqual(["SELL_PUT", "ASSIGNMENT", "SELL_COVERED_CALL", "CLOSE_COVERED_CALL"]);
    expect((await prisma.brokerRecord.findUniqueOrThrow({ where: { id: closeTxn.id } })).linkedCampaignId).toBe(campaign.id);
  });

  it("test 15: repeated reconciliation does not create a duplicate close", async () => {
    const account = await createTradingAccountForUser(userA.id, `CC BTC Repeat ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    const campaign = await createAssignedCampaign(userA.id, account.id, "CCAL", 1);
    await createTransaction(userA.id, account.id, {
      symbol: "CCAL 260911C00044000",
      underlyingSymbol: "CCAL",
      action: "Sell to Open",
      occurredAt: new Date("2026-09-01T14:00:00Z"),
      price: 0.35,
    });
    await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);
    await createTransaction(userA.id, account.id, {
      symbol: "CCAL 260911C00044000",
      underlyingSymbol: "CCAL",
      action: "Buy to Close",
      occurredAt: new Date("2026-09-08T14:00:00Z"),
      price: 0.1,
    });

    await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);
    const second = await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);
    expect(second.coveredCallsClosed).toBe(0);

    const updated = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id }, include: { events: true } });
    expect(updated.events.filter((e) => e.type === "CLOSE_COVERED_CALL")).toHaveLength(1);
  });

  it("test 16/17: a Buy to Close for the wrong strike or wrong expiration never closes the current open call", async () => {
    const account = await createTradingAccountForUser(userA.id, `CC BTC Wrong ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    await createAssignedCampaign(userA.id, account.id, "CCAM", 1);
    await createTransaction(userA.id, account.id, {
      symbol: "CCAM 260911C00044000",
      underlyingSymbol: "CCAM",
      action: "Sell to Open",
      occurredAt: new Date("2026-09-01T14:00:00Z"),
      price: 0.35,
    });
    await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);

    await createTransaction(userA.id, account.id, {
      symbol: "CCAM 260911C00045000", // wrong strike
      underlyingSymbol: "CCAM",
      action: "Buy to Close",
      occurredAt: new Date("2026-09-08T14:00:00Z"),
      price: 0.1,
    });
    await createTransaction(userA.id, account.id, {
      symbol: "CCAM 260918C00044000", // wrong expiration
      underlyingSymbol: "CCAM",
      action: "Buy to Close",
      occurredAt: new Date("2026-09-08T14:00:00Z"),
      price: 0.1,
    });

    const summary = await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);
    expect(summary.coveredCallsClosed).toBe(0);
  });

  it("test 18: a Buy to Close under a different account never closes another account's open call", async () => {
    const accountOne = await createTradingAccountForUser(userA.id, `CC BTC AcctOne ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    const accountTwo = await createTradingAccountForUser(userA.id, `CC BTC AcctTwo ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    const campaign = await createAssignedCampaign(userA.id, accountOne.id, "CCAN", 1);
    await createTransaction(userA.id, accountOne.id, {
      symbol: "CCAN 260911C00044000",
      underlyingSymbol: "CCAN",
      action: "Sell to Open",
      occurredAt: new Date("2026-09-01T14:00:00Z"),
      price: 0.35,
    });
    await reconcileSchwabCoveredCallActivityForUser(userA.id, accountOne.id);

    await createTransaction(userA.id, accountTwo.id, {
      symbol: "CCAN 260911C00044000",
      underlyingSymbol: "CCAN",
      action: "Buy to Close",
      occurredAt: new Date("2026-09-08T14:00:00Z"),
      price: 0.1,
    });

    const summary = await reconcileSchwabCoveredCallActivityForUser(userA.id, accountTwo.id);
    expect(summary.coveredCallsClosed).toBe(0);
    const updated = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id }, include: { events: true } });
    expect(updated.events.some((e) => e.type === "CLOSE_COVERED_CALL")).toBe(false);
  });

  it("test 19: no current open call on any campaign -> a Buy to Close never mutates anything", async () => {
    const account = await createTradingAccountForUser(userA.id, `CC BTC NoOpen ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    await createAssignedCampaign(userA.id, account.id, "CCAO", 1); // never sold a call
    const txn = await createTransaction(userA.id, account.id, {
      symbol: "CCAO 260911C00044000",
      underlyingSymbol: "CCAO",
      action: "Buy to Close",
      occurredAt: new Date("2026-09-08T14:00:00Z"),
      price: 0.1,
    });

    const summary = await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);
    expect(summary.coveredCallsClosed).toBe(0);
    expect((await prisma.brokerRecord.findUniqueOrThrow({ where: { id: txn.id } })).linkedCampaignId).toBeNull();
  });

  it("test 20: two campaigns holding the exact identical open call contract -> no auto-close, never guessed", async () => {
    const account = await createTradingAccountForUser(userA.id, `CC BTC DupOpen ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    const campaignOne = await createAssignedCampaign(userA.id, account.id, "CCAP", 1);
    const campaignTwo = await createAssignedCampaign(userA.id, account.id, "CCAP", 1);
    // Directly create the identical SELL_COVERED_CALL event on both campaigns (a pathological
    // coincidence the reconciler must still refuse to guess between).
    for (const campaign of [campaignOne, campaignTwo]) {
      await prisma.campaignEvent.create({
        data: {
          campaignId: campaign.id,
          type: "SELL_COVERED_CALL",
          occurredAt: new Date("2026-09-01T14:00:00Z"),
          sortOrder: 10,
          optionType: "CALL",
          contracts: 1,
          strike: "44",
          expiration: new Date("2026-09-11T00:00:00Z"),
          premium: "0.35",
          fees: 0,
        },
      });
    }
    const closeTxn = await createTransaction(userA.id, account.id, {
      symbol: "CCAP 260911C00044000",
      underlyingSymbol: "CCAP",
      action: "Buy to Close",
      occurredAt: new Date("2026-09-08T14:00:00Z"),
      price: 0.1,
    });

    const summary = await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);
    expect(summary.coveredCallsClosed).toBe(0);
    expect((await prisma.brokerRecord.findUniqueOrThrow({ where: { id: closeTxn.id } })).linkedCampaignId).toBeNull();

    const one = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignOne.id }, include: { events: true } });
    const two = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignTwo.id }, include: { events: true } });
    expect(one.events.some((e) => e.type === "CLOSE_COVERED_CALL")).toBe(false);
    expect(two.events.some((e) => e.type === "CLOSE_COVERED_CALL")).toBe(false);
  });

  it("test 21: a partial-quantity Buy to Close never auto-closes a multi-contract open call", async () => {
    const account = await createTradingAccountForUser(userA.id, `CC BTC Partial ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    const campaign = await createAssignedCampaign(userA.id, account.id, "CCAQ", 2); // 200 shares, up to 2 contracts
    await createTransaction(userA.id, account.id, {
      symbol: "CCAQ 260911C00044000",
      underlyingSymbol: "CCAQ",
      action: "Sell to Open",
      occurredAt: new Date("2026-09-01T14:00:00Z"),
      quantity: 2,
      price: 0.35,
    });
    await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);

    const partialClose = await createTransaction(userA.id, account.id, {
      symbol: "CCAQ 260911C00044000",
      underlyingSymbol: "CCAQ",
      action: "Buy to Close",
      occurredAt: new Date("2026-09-08T14:00:00Z"),
      quantity: 1, // only closing 1 of the 2 open contracts
      price: 0.1,
    });

    const summary = await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);
    expect(summary.coveredCallsClosed).toBe(0);
    expect((await prisma.brokerRecord.findUniqueOrThrow({ where: { id: partialClose.id } })).linkedCampaignId).toBeNull();

    const updated = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id }, include: { events: true } });
    expect(updated.events.some((e) => e.type === "CLOSE_COVERED_CALL")).toBe(false);
  });

  it("test 22: a full-quantity Buy to Close closes the call, leaves shares held, and keeps the campaign ASSIGNED", async () => {
    const account = await createTradingAccountForUser(userA.id, `CC BTC Full ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    const campaign = await createAssignedCampaign(userA.id, account.id, "CCAR", 2); // 200 shares
    await createTransaction(userA.id, account.id, {
      symbol: "CCAR 260911C00044000",
      underlyingSymbol: "CCAR",
      action: "Sell to Open",
      occurredAt: new Date("2026-09-01T14:00:00Z"),
      quantity: 2,
      price: 0.35,
    });
    await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);
    await createTransaction(userA.id, account.id, {
      symbol: "CCAR 260911C00044000",
      underlyingSymbol: "CCAR",
      action: "Buy to Close",
      occurredAt: new Date("2026-09-08T14:00:00Z"),
      quantity: 2,
      price: 0.1,
    });

    const summary = await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);
    expect(summary.coveredCallsClosed).toBe(1);

    const updated = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id }, include: { events: true } });
    expect(updated.status).toBe("ASSIGNED");
    const { summarizeCampaign, getCurrentOpenCall } = await import("@/domain/finance/campaigns");
    expect(summarizeCampaign({ status: updated.status, events: updated.events }).sharesHeld).toBe(200);
    expect(getCurrentOpenCall(updated.events)).toBeNull();
  });

  it("test 23: PUT Buy to Close behavior unchanged by covered-call reconciliation", async () => {
    const account = await createTradingAccountForUser(userA.id, `CC BTC PutUnaffected ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    await createTransaction(userA.id, account.id, {
      symbol: "CCAS 260911P00020000",
      underlyingSymbol: "CCAS",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-25T14:00:00Z"),
      price: 0.3,
    });
    // asOf pinned before the put's Sep 11 expiration so the first sync opens the campaign
    // without also auto-expiring it before the Buy to Close below ever gets a chance to apply.
    await reconcileSchwabActivityForUser(userA.id, account.id, completeEvidence(), new Date("2026-08-26T14:00:00Z"));
    await createTransaction(userA.id, account.id, {
      symbol: "CCAS 260911P00020000",
      underlyingSymbol: "CCAS",
      action: "Buy to Close",
      occurredAt: new Date("2026-09-01T14:00:00Z"),
      price: 0.15,
    });

    // The covered-call reconciler must never touch this PUT close.
    await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);
    const putSummary = await reconcileSchwabActivityForUser(userA.id, account.id, completeEvidence(), new Date("2026-09-02T14:00:00Z"));
    expect(putSummary.campaignsClosed).toBe(1);
  });

  // --- NON-SCOPE (must never auto-create these) ---

  it("test 24: a CALL expiration-style transaction never auto-creates COVERED_CALL_EXPIRED", async () => {
    const account = await createTradingAccountForUser(userA.id, `CC NonScope Expiry ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    const campaign = await createAssignedCampaign(userA.id, account.id, "CCAT", 1);
    await createTransaction(userA.id, account.id, {
      symbol: "CCAT 260911C00044000",
      underlyingSymbol: "CCAT",
      action: "Sell to Open",
      occurredAt: new Date("2026-09-01T14:00:00Z"),
      price: 0.35,
    });
    await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);

    await createTransaction(userA.id, account.id, {
      symbol: "CCAT 260911C00044000",
      underlyingSymbol: "CCAT",
      action: "Removed - Expiration",
      occurredAt: new Date("2026-09-12T14:00:00Z"),
      price: 0,
    });

    await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);
    const updated = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id }, include: { events: true } });
    expect(updated.events.some((e) => e.type === "COVERED_CALL_EXPIRED")).toBe(false);
  });

  it("test 25: a CALL assignment/removal transaction never auto-creates STOCK_SALE or an assignment-style event", async () => {
    const account = await createTradingAccountForUser(userA.id, `CC NonScope CalledAway ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    const campaign = await createAssignedCampaign(userA.id, account.id, "CCAU", 1);
    await createTransaction(userA.id, account.id, {
      symbol: "CCAU 260911C00044000",
      underlyingSymbol: "CCAU",
      action: "Sell to Open",
      occurredAt: new Date("2026-09-01T14:00:00Z"),
      price: 0.35,
    });
    await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);

    await createTransaction(userA.id, account.id, {
      symbol: "CCAU 260911C00044000",
      underlyingSymbol: "CCAU",
      action: "Assignment",
      occurredAt: new Date("2026-09-11T20:00:00Z"),
      price: 0,
    });

    await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);
    const updated = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id }, include: { events: true } });
    expect(updated.events.some((e) => e.type === "STOCK_SALE")).toBe(false);
    expect(updated.status).toBe("ASSIGNED");
  });

  it("test 26/27: a generic or partial stock sale transaction never auto-creates STOCK_SALE", async () => {
    const account = await createTradingAccountForUser(userA.id, `CC NonScope StockSale ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    const campaign = await createAssignedCampaign(userA.id, account.id, "CCAV", 2); // 200 shares
    await createTransaction(userA.id, account.id, {
      symbol: "CCAV",
      underlyingSymbol: "CCAV",
      action: "Sell",
      occurredAt: new Date("2026-09-05T14:00:00Z"),
      quantity: 100, // a plain partial stock sale
      price: 43,
    });

    await reconcileSchwabCoveredCallActivityForUser(userA.id, account.id);
    const updated = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id }, include: { events: true } });
    expect(updated.events.some((e) => e.type === "STOCK_SALE")).toBe(false);
  });

  // --- SECURITY ---

  it("test 28: a cross-user BrokerRecord never mutates another user's campaign", async () => {
    const accountA = await createTradingAccountForUser(userA.id, `CC Security UserA ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    const accountB = await createTradingAccountForUser(userB.id, `CC Security UserB ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    const campaignB = await createAssignedCampaign(userB.id, accountB.id, "CCAW", 1);
    // A record that happens to share userB's account id would still never be found by userA's
    // scoped query - simulate the more realistic case of userA running reconciliation broadly.
    await createTransaction(userA.id, accountA.id, {
      symbol: "CCAW 260911C00044000",
      underlyingSymbol: "CCAW",
      action: "Sell to Open",
      occurredAt: new Date("2026-09-01T14:00:00Z"),
      price: 0.35,
    });

    await reconcileSchwabCoveredCallActivityForUser(userA.id, accountA.id);
    const campaignBAfter = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignB.id }, include: { events: true } });
    expect(campaignBAfter.events.some((e) => e.type === "SELL_COVERED_CALL")).toBe(false);
  });

  it("test 29: a cross-account record never mutates another account's campaign", async () => {
    const account = await createTradingAccountForUser(userA.id, `CC Security CrossAcct ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    const otherAccount = await createTradingAccountForUser(userA.id, `CC Security OtherAcct ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    const campaign = await createAssignedCampaign(userA.id, account.id, "CCAX", 1);
    await createTransaction(userA.id, otherAccount.id, {
      symbol: "CCAX 260911C00044000",
      underlyingSymbol: "CCAX",
      action: "Sell to Open",
      occurredAt: new Date("2026-09-01T14:00:00Z"),
      price: 0.35,
    });

    await reconcileSchwabCoveredCallActivityForUser(userA.id, otherAccount.id);
    const updated = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id }, include: { events: true } });
    expect(updated.events.some((e) => e.type === "SELL_COVERED_CALL")).toBe(false);
  });
});
