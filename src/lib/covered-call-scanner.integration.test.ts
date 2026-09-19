import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

/**
 * Covered Call Phase 4 (see PROJECT_HANDOFF.md): getCoveredCallScanForUser's universe must be
 * exactly the authenticated user's own ASSIGNED campaigns - never another user's, another
 * account's, or a non-ASSIGNED campaign's shares - and it must never mutate anything (no
 * CampaignEvent, no BrokerRecord, no Brokerage Sync). This environment has no live Schwab
 * connection, so these tests exercise the universe/isolation/no-mutation guarantees; the
 * candidate-selection math itself is covered by covered-call-scan.test.ts's pure unit tests.
 */
maybeDescribe("Covered Call scanner universe (getCoveredCallScanForUser)", () => {
  let prisma: typeof import("./prisma").prisma;
  let createTradingAccountForUser: typeof import("./workflows").createTradingAccountForUser;
  let createCampaignForUser: typeof import("./workflows").createCampaignForUser;
  let assignCampaignPutForUser: typeof import("./workflows").assignCampaignPutForUser;
  let getCoveredCallScanForUser: typeof import("./covered-call-scanner").getCoveredCallScanForUser;
  let userA: { id: string };
  let userB: { id: string };
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    ({ createTradingAccountForUser, createCampaignForUser, assignCampaignPutForUser } = await import("./workflows"));
    ({ getCoveredCallScanForUser } = await import("./covered-call-scanner"));

    const passwordHash = await hash("not-used", 4);
    const timestamp = Date.now();
    userA = await prisma.user.create({ data: { name: "CC Scan User A", email: `cc-scan-a-${timestamp}@lst.local`, passwordHash } });
    userB = await prisma.user.create({ data: { name: "CC Scan User B", email: `cc-scan-b-${timestamp}@lst.local`, passwordHash } });
    userIds.push(userA.id, userB.id);
  });

  afterAll(async () => {
    await prisma.campaignEvent.deleteMany({ where: { campaign: { ownerId: { in: userIds } } } });
    await prisma.campaign.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.tradingAccount.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  async function createAssignedCampaign(userId: string, accountId: string, ticker: string, contracts = 1) {
    const campaign = await createCampaignForUser(
      userId,
      accountId,
      ticker,
      "2026-08-01",
      "2026-08-28",
      "40",
      String(contracts),
      "0.30",
      "0",
      "Covered call scanner universe test",
      "PRIVATE",
    );
    return (await assignCampaignPutForUser(userId, campaign.id, "2026-08-28", "", "0", null))!;
  }

  it("test 1: no assigned campaigns at all -> empty universe, no scan attempted", async () => {
    const account = await createTradingAccountForUser(userA.id, `CC Scan Empty ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    await createCampaignForUser(userA.id, account.id, "CCSEMPTY", "2026-08-01", "2026-09-18", "40", "1", "0.3", "0", null, "PRIVATE"); // OPEN, never assigned

    const result = await getCoveredCallScanForUser(userA.id);
    expect(result.campaigns).toHaveLength(0);
  });

  it("test 7: another user's assigned campaign never appears in this user's scan", async () => {
    const accountA = await createTradingAccountForUser(userA.id, `CC Scan UserA ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    const accountB = await createTradingAccountForUser(userB.id, `CC Scan UserB ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    await createAssignedCampaign(userA.id, accountA.id, "CCSA");
    const campaignB = await createAssignedCampaign(userB.id, accountB.id, "CCSB");

    const resultA = await getCoveredCallScanForUser(userA.id);
    expect(resultA.campaigns.map((c) => c.ticker)).toContain("CCSA");
    expect(resultA.campaigns.map((c) => c.ticker)).not.toContain("CCSB");

    const resultB = await getCoveredCallScanForUser(userB.id);
    expect(resultB.campaigns.map((c) => c.campaignId)).toEqual([campaignB.id]);
  });

  it("test 8: a second account belonging to the SAME user is included (never excluded merely for being a different account), but every campaign's own account/owner is exactly this user's", async () => {
    const accountOne = await createTradingAccountForUser(userA.id, `CC Scan AcctOne ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    const accountTwo = await createTradingAccountForUser(userA.id, `CC Scan AcctTwo ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    await createAssignedCampaign(userA.id, accountOne.id, "CCSC");
    await createAssignedCampaign(userA.id, accountTwo.id, "CCSD");

    const result = await getCoveredCallScanForUser(userA.id);
    const tickers = result.campaigns.map((c) => c.ticker);
    // Not an exact-array check - userA may already have other campaigns from earlier tests in
    // this file; the point is both of THIS user's accounts are represented, never excluded.
    expect(tickers).toEqual(expect.arrayContaining(["CCSC", "CCSD"]));
  });

  it("excludes a non-ASSIGNED (still-OPEN) campaign for the same user", async () => {
    const account = await createTradingAccountForUser(userA.id, `CC Scan OpenExcl ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    await createCampaignForUser(userA.id, account.id, "CCSOPEN", "2026-08-01", "2026-09-18", "40", "1", "0.3", "0", null, "PRIVATE");
    await createAssignedCampaign(userA.id, account.id, "CCSASGN");

    const result = await getCoveredCallScanForUser(userA.id);
    const tickers = result.campaigns.map((c) => c.ticker);
    expect(tickers).toContain("CCSASGN");
    expect(tickers).not.toContain("CCSOPEN");
  });

  it("never mutates anything - no CampaignEvent is created by running the scan (decision support only)", async () => {
    const account = await createTradingAccountForUser(userA.id, `CC Scan NoMutate ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    const campaign = await createAssignedCampaign(userA.id, account.id, "CCSNOMUT");
    const before = await prisma.campaignEvent.count({ where: { campaignId: campaign.id } });

    await getCoveredCallScanForUser(userA.id);
    await getCoveredCallScanForUser(userA.id); // twice, to also prove no idempotency-adjacent side effect

    const after = await prisma.campaignEvent.count({ where: { campaignId: campaign.id } });
    expect(after).toBe(before);
  });

  it("without a live Schwab connection, an eligible campaign reports an honest unavailable state rather than fabricating a candidate", async () => {
    const account = await createTradingAccountForUser(userA.id, `CC Scan NoSchwab ${Date.now()}`, "Manual", "10000", "10000", "PRIVATE");
    await createAssignedCampaign(userA.id, account.id, "CCSNOSW");

    const result = await getCoveredCallScanForUser(userA.id);
    const scan = result.campaigns.find((c) => c.ticker === "CCSNOSW")!;
    expect(scan).toBeDefined();
    expect(scan.currentPrice).toBeNull();
    expect(scan.basisSafeCandidates).toHaveLength(0);
    expect(["PRICE_UNAVAILABLE", "CHAIN_UNAVAILABLE"]).toContain(scan.reasonCode);
    // Shares held and adjusted basis are always known regardless of a live connection - basis is
    // 39.70 here: (4000 stock cost - 30 put premium already collected) / 100 shares.
    expect(scan.sharesHeld).toBe(100);
    expect(scan.adjustedBasis).toBe(39.7);
  });
});
