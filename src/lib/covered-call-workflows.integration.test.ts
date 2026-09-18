import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getCurrentOpenCall, summarizeCampaign } from "@/domain/finance/campaigns";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

/**
 * Covered Call Foundation, Phase 1 (see PROJECT_HANDOFF.md): manual sellCoveredCallForUser /
 * closeCoveredCallForUser / expireCoveredCallForUser / sellStockForUser workflows on top of an
 * already-ASSIGNED campaign. Uses the real seeded matt@lst.local/eric@lst.local users, exactly
 * like workflows.integration.test.ts's existing campaign lifecycle tests, so cross-user
 * authorization checks exercise the app's real privacy rules rather than a synthetic fixture.
 */
maybeDescribe("covered call foundation workflows", () => {
  let prisma: typeof import("./prisma").prisma;
  let workflows: typeof import("./workflows");
  let matt: { id: string };
  let eric: { id: string };
  const createdCampaigns: string[] = [];
  const createdAccounts: string[] = [];

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    workflows = await import("./workflows");
    matt = await prisma.user.findUniqueOrThrow({ where: { email: "matt@lst.local" }, select: { id: true } });
    eric = await prisma.user.findUniqueOrThrow({ where: { email: "eric@lst.local" }, select: { id: true } });
  });

  afterAll(async () => {
    await prisma.campaign.deleteMany({ where: { id: { in: createdCampaigns } } });
    await prisma.tradingAccount.deleteMany({ where: { id: { in: createdAccounts } } });
    await prisma.$disconnect();
  });

  /** Creates an ASSIGNED campaign with `contracts` * 100 shares held, ready for covered-call tests. */
  async function createAssignedCampaign(ticker: string, contracts: number, strike = "40") {
    const account = await workflows.createTradingAccountForUser(
      matt.id,
      `Covered Call Account ${ticker} ${Date.now()}`,
      "Manual",
      "10000",
      "10000",
      "PRIVATE",
    );
    createdAccounts.push(account.id);
    const campaign = await workflows.createCampaignForUser(
      matt.id,
      account.id,
      ticker,
      "2026-08-01",
      "2026-08-28",
      strike,
      String(contracts),
      "0.30",
      "0",
      "Covered call foundation test",
      "PRIVATE",
    );
    createdCampaigns.push(campaign.id);
    const assigned = await workflows.assignCampaignPutForUser(matt.id, campaign.id, "2026-08-28", "", "0", null);
    return assigned!;
  }

  it("test 1/5: sells a covered call against 100 assigned shares (1 contract)", async () => {
    const campaign = await createAssignedCampaign("CCF1", 1);

    const updated = await workflows.sellCoveredCallForUser(
      matt.id,
      campaign.id,
      "2026-09-01",
      "2026-09-11",
      "44",
      "1",
      "0.30",
      "0",
      "First call",
    );

    expect(updated?.status).toBe("ASSIGNED");
    expect(updated?.events.map((event) => event.type)).toEqual(["SELL_PUT", "ASSIGNMENT", "SELL_COVERED_CALL"]);
    const openCall = getCurrentOpenCall(updated!.events);
    expect(openCall).toEqual({ strike: 44, contracts: 1, expiration: new Date("2026-09-11") });
  });

  it("test 6: 200 shares (2 contracts assigned) permits selling 2 covered call contracts", async () => {
    const campaign = await createAssignedCampaign("CCF2", 2);

    const updated = await workflows.sellCoveredCallForUser(matt.id, campaign.id, "2026-09-01", "2026-09-11", "44", "2", "0.30", "0", null);
    expect(getCurrentOpenCall(updated!.events)).toMatchObject({ contracts: 2 });
  });

  it("test 3: cannot sell a covered call without any assigned shares", async () => {
    const account = await workflows.createTradingAccountForUser(matt.id, `No Shares Account ${Date.now()}`, "Manual", "5000", "5000", "PRIVATE");
    createdAccounts.push(account.id);
    const campaign = await workflows.createCampaignForUser(matt.id, account.id, "CCF3", "2026-08-01", "2026-09-18", "20", "1", "0.3", "0", null, "PRIVATE");
    createdCampaigns.push(campaign.id);

    await expect(
      workflows.sellCoveredCallForUser(matt.id, campaign.id, "2026-09-01", "2026-09-11", "22", "1", "0.3", "0", null),
    ).rejects.toThrow("Only a campaign holding assigned shares");
  });

  it("test 4: cannot sell more covered call contracts than assigned shares cover", async () => {
    const campaign = await createAssignedCampaign("CCF4", 1);

    await expect(
      workflows.sellCoveredCallForUser(matt.id, campaign.id, "2026-09-01", "2026-09-11", "44", "2", "0.30", "0", null),
    ).rejects.toThrow("supports at most 1");
  });

  it("test 2/7/8: closing a covered call records a debit, leaves shares held, and keeps the campaign ASSIGNED", async () => {
    const campaign = await createAssignedCampaign("CCF5", 1);
    await workflows.sellCoveredCallForUser(matt.id, campaign.id, "2026-09-01", "2026-09-11", "44", "1", "0.30", "0", null);

    const closed = await workflows.closeCoveredCallForUser(matt.id, campaign.id, "2026-09-08", "0.10", "0", "Bought back");
    expect(closed?.status).toBe("ASSIGNED");
    expect(closed?.events.map((event) => event.type)).toEqual(["SELL_PUT", "ASSIGNMENT", "SELL_COVERED_CALL", "CLOSE_COVERED_CALL"]);
    expect(getCurrentOpenCall(closed!.events)).toBeNull();

    const summary = summarizeCampaign({ status: closed!.status, events: closed!.events });
    expect(summary.sharesHeld).toBe(100);
    // Sold at 0.30/share, closed at 0.10/share -> net covered-call premium (0.30 - 0.10) * 100 = 20,
    // stacked on top of the original 0.30/share put premium already in netOptionPremium.
    expect(summary.netOptionPremium).toBe(30 + 20);
    // adjustedBasis is (stockCost - netOptionPremium) / sharesHeld = (4000 - 50) / 100.
    expect(summary.adjustedBasis).toBe(39.5);
  });

  it("test 19: closing an already-closed covered call is rejected, not silently duplicated", async () => {
    const campaign = await createAssignedCampaign("CCF6", 1);
    await workflows.sellCoveredCallForUser(matt.id, campaign.id, "2026-09-01", "2026-09-11", "44", "1", "0.30", "0", null);
    await workflows.closeCoveredCallForUser(matt.id, campaign.id, "2026-09-08", "0.10", "0", null);

    await expect(workflows.closeCoveredCallForUser(matt.id, campaign.id, "2026-09-09", "0.05", "0", null)).rejects.toThrow(
      "No open covered call",
    );
  });

  it("test 9/10: marking a covered call expired leaves shares held and keeps its premium", async () => {
    const campaign = await createAssignedCampaign("CCF7", 1);
    await workflows.sellCoveredCallForUser(matt.id, campaign.id, "2026-09-01", "2026-09-11", "44", "1", "0.30", "0", null);

    const expired = await workflows.expireCoveredCallForUser(matt.id, campaign.id, "2026-09-12", "0", "Expired worthless");
    expect(expired?.status).toBe("ASSIGNED");
    expect(getCurrentOpenCall(expired!.events)).toBeNull();

    const summary = summarizeCampaign({ status: expired!.status, events: expired!.events });
    expect(summary.sharesHeld).toBe(100);
    expect(summary.netOptionPremium).toBe(30 + 30); // put premium + full call premium, no debit
  });

  it("rejects marking a covered call expired before its expiration date has passed", async () => {
    const campaign = await createAssignedCampaign("CCF8", 1);
    await workflows.sellCoveredCallForUser(matt.id, campaign.id, "2026-09-01", "2026-09-11", "44", "1", "0.30", "0", null);

    await expect(workflows.expireCoveredCallForUser(matt.id, campaign.id, "2026-09-11", "0", null)).rejects.toThrow(
      "has not reached its expiration date",
    );
  });

  it("test 11/20: a second covered call can be sold after the first closes", async () => {
    const campaign = await createAssignedCampaign("CCF9", 1);
    await workflows.sellCoveredCallForUser(matt.id, campaign.id, "2026-09-01", "2026-09-11", "44", "1", "0.30", "0", null);
    await workflows.closeCoveredCallForUser(matt.id, campaign.id, "2026-09-08", "0.10", "0", null);

    const secondCall = await workflows.sellCoveredCallForUser(matt.id, campaign.id, "2026-09-09", "2026-09-25", "45", "1", "0.28", "0", null);
    expect(getCurrentOpenCall(secondCall!.events)).toEqual({ strike: 45, contracts: 1, expiration: new Date("2026-09-25") });
  });

  it("test 12/13: a full stock sale with no open call records proceeds and closes the campaign", async () => {
    const campaign = await createAssignedCampaign("CCF10", 1);

    const sold = await workflows.sellStockForUser(matt.id, campaign.id, "2026-09-15", "100", "43", "0", "Sold it all");
    expect(sold?.status).toBe("CLOSED");
    expect(sold?.closedAt).toEqual(new Date("2026-09-15"));

    const summary = summarizeCampaign({ status: sold!.status, events: sold!.events });
    expect(summary.sharesHeld).toBe(0);
    expect(summary.stockProceeds).toBe(4300);
  });

  it("test 14: a partial stock sale leaves the campaign ASSIGNED with the remaining shares held", async () => {
    const campaign = await createAssignedCampaign("CCF11", 2); // 200 shares

    const sold = await workflows.sellStockForUser(matt.id, campaign.id, "2026-09-15", "100", "41", "0", "Partial sale");
    expect(sold?.status).toBe("ASSIGNED");

    const summary = summarizeCampaign({ status: sold!.status, events: sold!.events });
    expect(summary.sharesHeld).toBe(100);
  });

  it("test 15: blocks a stock sale that would leave an open covered call uncovered", async () => {
    const campaign = await createAssignedCampaign("CCF12", 1); // 100 shares, 1 contract max
    await workflows.sellCoveredCallForUser(matt.id, campaign.id, "2026-09-01", "2026-09-11", "44", "1", "0.30", "0", null);

    // All 100 shares are covering the open call - selling any of them would leave it naked.
    await expect(workflows.sellStockForUser(matt.id, campaign.id, "2026-09-05", "100", "43", "0", null)).rejects.toThrow(
      "would leave only",
    );
  });

  it("test 16: allows a stock sale when enough shares remain to cover an open call (200 shares, 1 call over 100)", async () => {
    const campaign = await createAssignedCampaign("CCF13", 2); // 200 shares
    await workflows.sellCoveredCallForUser(matt.id, campaign.id, "2026-09-01", "2026-09-11", "44", "1", "0.30", "0", null);

    const sold = await workflows.sellStockForUser(matt.id, campaign.id, "2026-09-05", "100", "43", "0", "Sell the uncovered 100");
    expect(sold?.status).toBe("ASSIGNED");
    // The call opened before this sale must still be reported open afterward - getCurrentOpenCall
    // reduces the full event history, not just the last trade event (see campaigns.ts).
    expect(getCurrentOpenCall(sold!.events)).toMatchObject({ strike: 44, contracts: 1 });

    const summary = summarizeCampaign({ status: sold!.status, events: sold!.events });
    expect(summary.sharesHeld).toBe(100);
  });

  it("test 17/18: cross-user mutation and a guessed campaign ID are both rejected for every new workflow", async () => {
    const campaign = await createAssignedCampaign("CCF14", 1);
    await workflows.sellCoveredCallForUser(matt.id, campaign.id, "2026-09-01", "2026-09-11", "44", "1", "0.30", "0", null);

    await expect(
      workflows.sellCoveredCallForUser(eric.id, campaign.id, "2026-09-01", "2026-09-11", "44", "1", "0.30", "0", null),
    ).rejects.toThrow("not allowed");
    await expect(workflows.closeCoveredCallForUser(eric.id, campaign.id, "2026-09-08", "0.10", "0", null)).rejects.toThrow("not allowed");
    await expect(workflows.expireCoveredCallForUser(eric.id, campaign.id, "2026-09-12", "0", null)).rejects.toThrow("not allowed");
    await expect(workflows.sellStockForUser(eric.id, campaign.id, "2026-09-15", "100", "43", "0", null)).rejects.toThrow("not allowed");

    const bogusId = "nonexistent-campaign-id";
    await expect(workflows.sellCoveredCallForUser(matt.id, bogusId, "2026-09-01", "2026-09-11", "44", "1", "0.30", "0", null)).resolves.toBeNull();
    await expect(workflows.closeCoveredCallForUser(matt.id, bogusId, "2026-09-08", "0.10", "0", null)).resolves.toBeNull();
    await expect(workflows.expireCoveredCallForUser(matt.id, bogusId, "2026-09-12", "0", null)).resolves.toBeNull();
    await expect(workflows.sellStockForUser(matt.id, bogusId, "2026-09-15", "100", "43", "0", null)).resolves.toBeNull();

    // The campaign itself was never touched by any of the rejected/no-op calls above.
    const stillOpen = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id }, include: { events: true } });
    expect(stillOpen.status).toBe("ASSIGNED");
    expect(stillOpen.events).toHaveLength(3);
  });

  it("test 21/22: existing put-only campaign economics and stage labels are unaffected by the covered call additions", async () => {
    const account = await workflows.createTradingAccountForUser(matt.id, `Put Only Account ${Date.now()}`, "Manual", "8000", "8000", "PRIVATE");
    createdAccounts.push(account.id);
    const campaign = await workflows.createCampaignForUser(
      matt.id,
      account.id,
      "CCF15",
      "2026-08-01",
      "2026-08-14",
      "20",
      "1",
      "0.30",
      "0",
      null,
      "PRIVATE",
    );
    createdCampaigns.push(campaign.id);
    const closed = await workflows.closeCampaignPutForUser(matt.id, campaign.id, "2026-08-10", "0.10", "0", "Bought back early");

    const summary = summarizeCampaign({ status: closed!.status, events: closed!.events });
    expect(closed?.status).toBe("CLOSED");
    expect(summary.currentStage).toBe("Closed");
    expect(summary.realizedPL).toBe(20); // (0.30 - 0.10) * 100
    expect(summary.sharesHeld).toBe(0);
  });
});
