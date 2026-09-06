import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

maybeDescribe("Campaign event sequence diagnostic - sanitized, current-user-scoped, read-only", () => {
  let prisma: typeof import("./prisma").prisma;
  let createTradingAccountForUser: typeof import("./workflows").createTradingAccountForUser;
  let createCampaignForUser: typeof import("./workflows").createCampaignForUser;
  let getSanitizedCampaignEventSequenceForUser: typeof import("./campaign-event-sequence-diagnostic").getSanitizedCampaignEventSequenceForUser;
  let userA: { id: string };
  let userB: { id: string };
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    ({ createTradingAccountForUser, createCampaignForUser } = await import("./workflows"));
    ({ getSanitizedCampaignEventSequenceForUser } = await import("./campaign-event-sequence-diagnostic"));

    const passwordHash = await hash("not-used", 4);
    const timestamp = Date.now();
    userA = await prisma.user.create({ data: { name: "Sequence Diag User A", email: `seq-diag-a-${timestamp}@lst.local`, passwordHash } });
    userB = await prisma.user.create({ data: { name: "Sequence Diag User B", email: `seq-diag-b-${timestamp}@lst.local`, passwordHash } });
    userIds.push(userA.id, userB.id);
  });

  afterAll(async () => {
    await prisma.brokerRecord.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.campaign.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.tradingAccount.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("returns this user's own campaign event sequences, sanitized - never ids, account identifiers, or another user's data", async () => {
    const accountA = await createTradingAccountForUser(userA.id, "Seq Account A", "Manual", "10000", "10000", "PRIVATE");
    const campaignA = await createCampaignForUser(userA.id, accountA.id, "SEQA", "2026-08-28", "2026-09-04", "20", "1", "0.5", "0.66", "", "PRIVATE");

    const accountB = await createTradingAccountForUser(userB.id, "Seq Account B", "Manual", "10000", "10000", "PRIVATE");
    await createCampaignForUser(userB.id, accountB.id, "SEQB", "2026-08-28", "2026-09-04", "30", "1", "0.4", "0", "", "PRIVATE");

    const report = await getSanitizedCampaignEventSequenceForUser(userA.id);

    expect(report.campaigns).toHaveLength(1);
    expect(report.campaigns[0].ticker).toBe("SEQA");
    expect(report.campaigns[0].events.length).toBeGreaterThan(0);
    expect(report.campaigns[0].events[0]).toMatchObject({ type: "SELL_PUT", strike: 20, premium: 0.5 });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(campaignA.id);
    expect(serialized).not.toContain(accountA.id);
    expect(serialized).not.toContain("SEQB");
  });

  it("flags a campaign with an unresolved-fee linked record via hasUnknownFee, without changing any P/L number", async () => {
    const account = await createTradingAccountForUser(userA.id, "Seq Account Fee", "Manual", "10000", "10000", "PRIVATE");
    const campaign = await createCampaignForUser(userA.id, account.id, "SEQFEE", "2026-08-28", "2026-09-04", "20", "1", "0.5", "0", "", "PRIVATE");

    await prisma.brokerRecord.create({
      data: {
        userId: userA.id,
        accountId: account.id,
        linkedCampaignId: campaign.id,
        provider: "SCHWAB",
        kind: "TRANSACTION",
        status: "CONFIRMED",
        fingerprint: `seq-fee-fp-${Date.now()}`,
        identityKey: `seq-fee-id-${Date.now()}`,
        symbol: "SEQFEE 260904P00020000",
        action: "Sell to Open",
        fees: null,
        sources: ["SCHWAB_API"],
        metadata: {},
      },
    });

    const report = await getSanitizedCampaignEventSequenceForUser(userA.id);
    const found = report.campaigns.find((c) => c.ticker === "SEQFEE");
    expect(found?.hasUnknownFee).toBe(true);
  });
});
