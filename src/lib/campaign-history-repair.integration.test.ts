import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

maybeDescribe("Campaign history repair - narrow, dry-run-first, token-locked, never touches valid history/other users", () => {
  let prisma: typeof import("./prisma").prisma;
  let createCampaignForUser: typeof import("./workflows").createCampaignForUser;
  let closeCampaignPutForUser: typeof import("./workflows").closeCampaignPutForUser;
  let rollCampaignPutForUser: typeof import("./workflows").rollCampaignPutForUser;
  let previewCampaignHistoryRepairForUser: typeof import("./campaign-history-repair").previewCampaignHistoryRepairForUser;
  let repairCampaignHistoryForUser: typeof import("./campaign-history-repair").repairCampaignHistoryForUser;
  let userA: { id: string };
  let userB: { id: string };
  const userIds: string[] = [];
  let recordCounter = 0;

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    ({ createCampaignForUser, closeCampaignPutForUser, rollCampaignPutForUser } = await import("./workflows"));
    ({ previewCampaignHistoryRepairForUser, repairCampaignHistoryForUser } = await import("./campaign-history-repair"));

    const passwordHash = await hash("not-used", 4);
    const timestamp = Date.now();
    userA = await prisma.user.create({ data: { name: "History Repair User A", email: `hist-repair-a-${timestamp}@lst.local`, passwordHash } });
    userB = await prisma.user.create({ data: { name: "History Repair User B", email: `hist-repair-b-${timestamp}@lst.local`, passwordHash } });
    userIds.push(userA.id, userB.id);
  });

  afterAll(async () => {
    await prisma.brokerRecord.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.campaignEvent.deleteMany({ where: { campaign: { ownerId: { in: userIds } } } });
    await prisma.campaign.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.tradingAccount.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  async function schwabAccount(userId: string, name: string) {
    // A real Schwab-synced account has source: "SCHWAB" (see syncSchwabAccountForUser) -
    // createTradingAccountForUser is the manual-account workflow and always creates
    // source: "MANUAL", so this repair predicate's account.source check needs a real
    // SCHWAB-sourced row created directly.
    return prisma.tradingAccount.create({
      data: { userId, name, brokerName: "Schwab", accountType: "Brokerage", source: "SCHWAB", visibility: "PRIVATE" },
    });
  }

  async function createBrokerRecord(
    userId: string,
    accountId: string,
    overrides: { linkedCampaignId?: string | null; action: string; description: string; fees?: number | null },
  ) {
    recordCounter += 1;
    return prisma.brokerRecord.create({
      data: {
        userId,
        accountId,
        linkedCampaignId: overrides.linkedCampaignId ?? null,
        provider: "SCHWAB",
        kind: "TRANSACTION",
        status: "CONFIRMED",
        fingerprint: `hist-repair-fp-${userId}-${recordCounter}`,
        identityKey: `hist-repair-id-${userId}-${recordCounter}`,
        symbol: "TEST 260904P00020000",
        underlyingSymbol: "TEST",
        action: overrides.action,
        description: overrides.description,
        fees: overrides.fees === undefined ? null : overrides.fees,
        sources: ["SCHWAB_API"],
        metadata: {},
      },
    });
  }

  /** Reproduces exactly what the OLD, buggy normalizer + reconciliation produced: a real SELL_PUT
   * open, then a zero-premium CLOSE_PUT created from a real "Removed due to Expiration" record
   * that got misclassified as Buy to Close and linked as closing evidence. */
  async function createBuggyClosedCampaign(userId: string, accountId: string, ticker: string) {
    const campaign = await createCampaignForUser(userId, accountId, ticker, "2026-08-31", "2026-09-04", "20", "1", "0.28", "0.66", "", "PRIVATE");
    await closeCampaignPutForUser(userId, campaign.id, "2026-09-05", "0", null, null);
    const brokerRecord = await createBrokerRecord(userId, accountId, {
      linkedCampaignId: campaign.id,
      action: "Buy to Close",
      description: `Removed due to Expiration PUT ${ticker} CORP $20 EXP 09/04/26`,
      fees: null,
    });
    return { campaign, brokerRecord };
  }

  it("preview identifies exactly two real-style bad campaigns and excludes a valid roll and a legitimate BTC", async () => {
    const account = await schwabAccount(userA.id, "Repair Preview Account");

    await createBuggyClosedCampaign(userA.id, account.id, "APLD");
    await createBuggyClosedCampaign(userA.id, account.id, "RIOT");

    // Valid CORZ roll - three events, never two - must never qualify.
    const corz = await createCampaignForUser(userA.id, account.id, "CORZ", "2026-08-24", "2026-09-04", "16.5", "1", "0.26", "0.66", "", "PRIVATE");
    await rollCampaignPutForUser(userA.id, corz.id, "2026-08-28", "0.23", "2026-09-04", "18", "0.68", "0.66", null, "0.66");

    // A legitimate Buy to Close - real trade, nonzero premium, no expiration-removal text - must never qualify.
    const legit = await createCampaignForUser(userA.id, account.id, "LEGIT", "2026-08-20", "2026-09-04", "15", "1", "0.4", "0.66", "", "PRIVATE");
    await closeCampaignPutForUser(userA.id, legit.id, "2026-08-25", "0.1", "0.66", null);
    await createBrokerRecord(userA.id, account.id, { linkedCampaignId: legit.id, action: "Buy to Close", description: "Buy to Close" });

    const preview = await previewCampaignHistoryRepairForUser(userA.id);

    expect(preview.totalMatched).toBe(2);
    expect(preview.candidates.map((c) => c.ticker).sort()).toEqual(["APLD", "RIOT"]);
    expect(preview.candidates.every((c) => c.eventSequence.join(",") === "SELL_PUT,CLOSE_PUT")).toBe(true);
    expect(preview.safetyCapExceeded).toBe(false);
    expect(preview.matchToken).toMatch(/^[0-9a-f]{64}$/);

    // Sanity: CORZ and the legitimate close are genuinely unaffected/untouched.
    const corzAfter = await prisma.campaign.findUnique({ where: { id: corz.id }, include: { events: true } });
    expect(corzAfter?.status).toBe("OPEN");
    expect(corzAfter?.events).toHaveLength(3);
    const legitAfter = await prisma.campaign.findUnique({ where: { id: legit.id } });
    expect(legitAfter?.status).toBe("CLOSED");

    await prisma.brokerRecord.deleteMany({ where: { userId: userA.id } });
    await prisma.campaignEvent.deleteMany({ where: { campaign: { ownerId: userA.id } } });
    await prisma.campaign.deleteMany({ where: { ownerId: userA.id } });
  });

  it("a legitimate assignment or exercise can NEVER qualify, even if its description carries expiration-removal wording", async () => {
    const account = await schwabAccount(userA.id, "Repair Assignment Exclusion Account");

    // Same shape as the bug signature (SELL_PUT + $0 CLOSE_PUT, expiration-removal-style text)
    // but classified as a real settlement (ASSIGNMENT/EXERCISE) - must be excluded outright,
    // never merely by the text check, since a genuine assignment is never expiration noise.
    const assigned = await createCampaignForUser(userA.id, account.id, "ASGN", "2026-08-20", "2026-09-04", "15", "1", "0.4", "0.66", "", "PRIVATE");
    await closeCampaignPutForUser(userA.id, assigned.id, "2026-09-05", "0", null, null);
    await createBrokerRecord(userA.id, account.id, {
      linkedCampaignId: assigned.id,
      action: "Assignment",
      description: "Removed due to Expiration PUT ASGN CORP $15 EXP 09/04/26",
    });

    const exercised = await createCampaignForUser(userA.id, account.id, "EXER", "2026-08-20", "2026-09-04", "15", "1", "0.4", "0.66", "", "PRIVATE");
    await closeCampaignPutForUser(userA.id, exercised.id, "2026-09-05", "0", null, null);
    await createBrokerRecord(userA.id, account.id, {
      linkedCampaignId: exercised.id,
      action: "Exercise",
      description: "Removed due to Expiration PUT EXER CORP $15 EXP 09/04/26",
    });

    const preview = await previewCampaignHistoryRepairForUser(userA.id);
    expect(preview.totalMatched).toBe(0);
    expect(preview.candidates).toHaveLength(0);

    const assignedAfter = await prisma.campaign.findUnique({ where: { id: assigned.id } });
    const exercisedAfter = await prisma.campaign.findUnique({ where: { id: exercised.id } });
    expect(assignedAfter?.status).toBe("CLOSED");
    expect(exercisedAfter?.status).toBe("CLOSED");

    await prisma.brokerRecord.deleteMany({ where: { userId: userA.id } });
    await prisma.campaignEvent.deleteMany({ where: { campaign: { ownerId: userA.id } } });
    await prisma.campaign.deleteMany({ where: { ownerId: userA.id } });
  });

  it("repair restores OPEN/Expiration-Processing lifecycle, corrects the source record, and leaves option economics unchanged", async () => {
    const account = await schwabAccount(userA.id, "Repair Fix Account");
    const { campaign, brokerRecord } = await createBuggyClosedCampaign(userA.id, account.id, "APLD");

    const preview = await previewCampaignHistoryRepairForUser(userA.id);
    expect(preview.totalMatched).toBe(1);

    const result = await repairCampaignHistoryForUser(userA.id, preview.matchToken);
    expect(result.repairedCount).toBe(1);

    const repairedCampaign = await prisma.campaign.findUnique({ where: { id: campaign.id }, include: { events: true } });
    expect(repairedCampaign?.status).toBe("OPEN");
    expect(repairedCampaign?.closedAt).toBeNull();
    expect(repairedCampaign?.events.map((e) => e.type)).toEqual(["SELL_PUT"]);

    const { summarizeCampaign } = await import("@/domain/finance/campaigns");
    const summary = summarizeCampaign({ events: repairedCampaign!.events, status: repairedCampaign!.status });
    expect(summary.currentStage).toBe("Expiration processing"); // asOf (now) is well after the 2026-09-04 expiration
    // Option economics untouched by the lifecycle repair: $28 gross - $0.66 fee = $27.34.
    expect(summary.totalPremiumReceived).toBe(28);
    expect(Math.round((summary.realizedPL ?? 0) * 100) / 100).toBe(27.34);

    const repairedRecord = await prisma.brokerRecord.findUnique({ where: { id: brokerRecord.id } });
    expect(repairedRecord?.action).toBe("Removed - Expiration");
    expect(repairedRecord?.linkedCampaignId).toBeNull();

    const { classifyBrokerTransactionAction } = await import("@/domain/finance/brokerTransactionActions");
    expect(classifyBrokerTransactionAction(repairedRecord?.action ?? null)).toBe("OPTION_REMOVED_EXPIRATION");
    expect(classifyBrokerTransactionAction(repairedRecord?.action ?? null)).not.toBe("BUY_TO_CLOSE");

    await prisma.brokerRecord.deleteMany({ where: { userId: userA.id } });
    await prisma.campaignEvent.deleteMany({ where: { campaign: { ownerId: userA.id } } });
    await prisma.campaign.deleteMany({ where: { ownerId: userA.id } });
  });

  it("refuses a stale/garbage token and mutates nothing", async () => {
    const account = await schwabAccount(userA.id, "Repair Stale Account");
    await createBuggyClosedCampaign(userA.id, account.id, "APLD");

    await expect(repairCampaignHistoryForUser(userA.id, "not-a-real-token")).rejects.toThrow(/matching set has changed/i);

    const stillClosed = await prisma.campaign.count({ where: { ownerId: userA.id, status: "CLOSED" } });
    expect(stillClosed).toBe(1);

    await prisma.brokerRecord.deleteMany({ where: { userId: userA.id } });
    await prisma.campaignEvent.deleteMany({ where: { campaign: { ownerId: userA.id } } });
    await prisma.campaign.deleteMany({ where: { ownerId: userA.id } });
  });

  it("refuses when the qualifying set changed since the preview - e.g. a second bad campaign appeared", async () => {
    const account = await schwabAccount(userA.id, "Repair Changed Account");
    await createBuggyClosedCampaign(userA.id, account.id, "APLD");

    const stalePreview = await previewCampaignHistoryRepairForUser(userA.id);
    expect(stalePreview.totalMatched).toBe(1);

    await createBuggyClosedCampaign(userA.id, account.id, "RIOT");

    await expect(repairCampaignHistoryForUser(userA.id, stalePreview.matchToken)).rejects.toThrow(/matching set has changed/i);

    const stillClosed = await prisma.campaign.count({ where: { ownerId: userA.id, status: "CLOSED" } });
    expect(stillClosed).toBe(2); // nothing was mutated

    await prisma.brokerRecord.deleteMany({ where: { userId: userA.id } });
    await prisma.campaignEvent.deleteMany({ where: { campaign: { ownerId: userA.id } } });
    await prisma.campaign.deleteMany({ where: { ownerId: userA.id } });
  });

  it("repeated repair after a successful fix is idempotent - finds nothing left to repair and mutates nothing", async () => {
    const account = await schwabAccount(userA.id, "Repair Idempotent Account");
    await createBuggyClosedCampaign(userA.id, account.id, "APLD");

    const firstPreview = await previewCampaignHistoryRepairForUser(userA.id);
    const firstResult = await repairCampaignHistoryForUser(userA.id, firstPreview.matchToken);
    expect(firstResult.repairedCount).toBe(1);

    const secondPreview = await previewCampaignHistoryRepairForUser(userA.id);
    expect(secondPreview.totalMatched).toBe(0);
    const secondResult = await repairCampaignHistoryForUser(userA.id, secondPreview.matchToken);
    expect(secondResult.repairedCount).toBe(0);

    await prisma.brokerRecord.deleteMany({ where: { userId: userA.id } });
    await prisma.campaignEvent.deleteMany({ where: { campaign: { ownerId: userA.id } } });
    await prisma.campaign.deleteMany({ where: { ownerId: userA.id } });
  });

  it("Eric's equivalent bad campaign is detected within Eric's own account, and Matt's repair can never touch it", async () => {
    const accountA = await schwabAccount(userA.id, "Matt Repair Account");
    await createBuggyClosedCampaign(userA.id, accountA.id, "APLD");

    const accountB = await schwabAccount(userB.id, "Eric Repair Account");
    const { campaign: ericCampaign } = await createBuggyClosedCampaign(userB.id, accountB.id, "NVDA");

    // Eric's own preview finds his own bad campaign.
    const ericPreview = await previewCampaignHistoryRepairForUser(userB.id);
    expect(ericPreview.totalMatched).toBe(1);
    expect(ericPreview.candidates[0].ticker).toBe("NVDA");

    // Matt repairs his own set - Eric's campaign must remain untouched.
    const mattPreview = await previewCampaignHistoryRepairForUser(userA.id);
    await repairCampaignHistoryForUser(userA.id, mattPreview.matchToken);

    const ericCampaignAfter = await prisma.campaign.findUnique({ where: { id: ericCampaign.id } });
    expect(ericCampaignAfter?.status).toBe("CLOSED"); // still broken - Matt's repair never reached it

    await prisma.brokerRecord.deleteMany({ where: { userId: { in: [userA.id, userB.id] } } });
    await prisma.campaignEvent.deleteMany({ where: { campaign: { ownerId: { in: [userA.id, userB.id] } } } });
    await prisma.campaign.deleteMany({ where: { ownerId: { in: [userA.id, userB.id] } } });
  });
});
