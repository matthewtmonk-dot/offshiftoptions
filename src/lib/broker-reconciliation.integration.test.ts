import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ValidationError } from "./tickers";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

maybeDescribe("Schwab broker reconciliation (linking, dashboard dedupe, privacy)", () => {
  let prisma: typeof import("./prisma").prisma;
  let createTradingAccountForUser: typeof import("./workflows").createTradingAccountForUser;
  let getBrokerActivityAwaitingReviewForUser: typeof import("./broker-reconciliation").getBrokerActivityAwaitingReviewForUser;
  let confirmBrokerPositionAsCampaignForUser: typeof import("./broker-reconciliation").confirmBrokerPositionAsCampaignForUser;
  let skipBrokerReconciliationForUser: typeof import("./broker-reconciliation").skipBrokerReconciliationForUser;
  let splitBrokerPositionsByCampaignLink: typeof import("./broker-reconciliation").splitBrokerPositionsByCampaignLink;
  let userA: { id: string };
  let userB: { id: string };
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    ({ createTradingAccountForUser } = await import("./workflows"));
    ({
      getBrokerActivityAwaitingReviewForUser,
      confirmBrokerPositionAsCampaignForUser,
      skipBrokerReconciliationForUser,
      splitBrokerPositionsByCampaignLink,
    } = await import("./broker-reconciliation"));

    const passwordHash = await hash("not-used", 4);
    const timestamp = Date.now();
    userA = await prisma.user.create({ data: { name: "Reconcile User A", email: `reconcile-a-${timestamp}@lst.local`, passwordHash } });
    userB = await prisma.user.create({ data: { name: "Reconcile User B", email: `reconcile-b-${timestamp}@lst.local`, passwordHash } });
    userIds.push(userA.id, userB.id);
  });

  afterAll(async () => {
    await prisma.brokerRecord.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.campaign.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.tradingAccount.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  async function createOpenShortPutPosition(userId: string, symbol: string, underlying: string) {
    return prisma.brokerRecord.create({
      data: {
        userId,
        provider: "SCHWAB",
        kind: "POSITION",
        status: "CONFIRMED",
        fingerprint: `test-fingerprint-${userId}-${symbol}`,
        identityKey: `test-identity-${userId}-${symbol}`,
        symbol,
        underlyingSymbol: underlying,
        quantity: -1,
        amount: -16,
        observedAt: new Date("2026-08-31T23:09:00.000Z"),
        sources: ["SCHWAB_POSITIONS_CSV"],
        metadata: {},
      },
    });
  }

  it("stays unlinked until explicitly confirmed, and shows up as awaiting review", async () => {
    await createOpenShortPutPosition(userA.id, "LSTO 260904P00017500", "LSTO");
    const items = await getBrokerActivityAwaitingReviewForUser(userA.id);
    const item = items.find((entry) => entry.symbol === "LSTO 260904P00017500");
    expect(item).toBeDefined();
    expect(item?.likelyCsp).toBe(true);
  });

  it("confirming links the campaign so the Dashboard counts it once, not twice", async () => {
    const account = await createTradingAccountForUser(userA.id, "Reconcile Test Account", "Manual", "10000", "10000", "PRIVATE");
    const position = await createOpenShortPutPosition(userA.id, "WORK 260904P00023500", "WORK");

    const campaign = await confirmBrokerPositionAsCampaignForUser(
      userA.id,
      position.id,
      account.id,
      "WORK",
      "2026-08-31",
      "2026-09-04",
      "23.5",
      "1",
      "0.28",
      "0",
      "Reconciled from broker evidence",
      "PRIVATE",
    );
    expect(campaign.ticker).toBe("WORK");

    const linked = await prisma.brokerRecord.findUnique({ where: { id: position.id } });
    expect(linked?.linkedCampaignId).toBe(campaign.id);

    // It must no longer show up as awaiting review once linked.
    const stillAwaiting = await getBrokerActivityAwaitingReviewForUser(userA.id);
    expect(stillAwaiting.some((entry) => entry.brokerRecordId === position.id)).toBe(false);

    // The live-position dedupe split must now classify this exact symbol as "linked."
    const { unlinked, linked: linkedPositions } = await splitBrokerPositionsByCampaignLink(userA.id, [
      { accountId: "live-account", symbol: "WORK 260904P00023500", quantity: -1, marketValue: -19 },
    ]);
    expect(linkedPositions).toHaveLength(1);
    expect(unlinked).toHaveLength(0);
  });

  it("cannot be confirmed twice - a second confirm attempt is rejected", async () => {
    const account = await createTradingAccountForUser(userA.id, "Reconcile Test Account 2", "Manual", "10000", "10000", "PRIVATE");
    const position = await createOpenShortPutPosition(userA.id, "TOOL 260904P00016500", "TOOL");

    await confirmBrokerPositionAsCampaignForUser(
      userA.id,
      position.id,
      account.id,
      "TOOL",
      "2026-08-28",
      "2026-09-04",
      "16.5",
      "1",
      "0.68",
      "0",
      "",
      "PRIVATE",
    );

    await expect(
      confirmBrokerPositionAsCampaignForUser(userA.id, position.id, account.id, "TOOL", "2026-08-28", "2026-09-04", "16.5", "1", "0.68", "0", "", "PRIVATE"),
    ).rejects.toThrow(ValidationError);
  });

  it("skip never creates a campaign and stops the item from awaiting review again", async () => {
    const position = await createOpenShortPutPosition(userA.id, "SKIP 260904P00010000", "SKIP");
    await skipBrokerReconciliationForUser(userA.id, position.id);

    const campaignCount = await prisma.campaign.count({ where: { ownerId: userA.id, ticker: "SKIP" } });
    expect(campaignCount).toBe(0);

    const items = await getBrokerActivityAwaitingReviewForUser(userA.id);
    expect(items.some((entry) => entry.brokerRecordId === position.id)).toBe(false);
  });

  it("User B cannot see, confirm, or skip User A's broker activity awaiting review", async () => {
    const position = await createOpenShortPutPosition(userA.id, "PRIV 260904P00012000", "PRIV");

    const userBItems = await getBrokerActivityAwaitingReviewForUser(userB.id);
    expect(userBItems.some((entry) => entry.brokerRecordId === position.id)).toBe(false);

    const account = await createTradingAccountForUser(userB.id, "User B account", "Manual", "5000", "5000", "PRIVATE");
    await expect(
      confirmBrokerPositionAsCampaignForUser(userB.id, position.id, account.id, "PRIV", "2026-08-31", "2026-09-04", "12", "1", "0.2", "0", "", "PRIVATE"),
    ).rejects.toThrow(ValidationError);
    await expect(skipBrokerReconciliationForUser(userB.id, position.id)).rejects.toThrow(ValidationError);

    const untouched = await prisma.brokerRecord.findUnique({ where: { id: position.id } });
    expect(untouched?.linkedCampaignId).toBeNull();
    expect(untouched?.reconciliationDismissedAt).toBeNull();
  });
});
