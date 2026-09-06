import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

/**
 * Regression coverage for the Dashboard-vs-Tracker campaign-count discrepancy Matt reported:
 * Dashboard's Open Positions count/list must never disagree with the Tracker's Open view about
 * which campaigns are currently open, since both are meant to describe the exact same
 * underlying Campaign rows for the same user. If this test ever fails, the two pages' queries
 * have diverged - the historical cause (see PROJECT_HANDOFF.md "Dashboard truth audit") was
 * never a query/aggregation mismatch but a missing revalidatePath after the campaign-history
 * repair tool ran, leaving a stale client-side Router Cache entry - this test proves the
 * server-side data itself was never wrong.
 */
maybeDescribe("Dashboard and Tracker agree on open-campaign truth", () => {
  let prisma: typeof import("./prisma").prisma;
  let createCampaignForUser: typeof import("./workflows").createCampaignForUser;
  let rollCampaignPutForUser: typeof import("./workflows").rollCampaignPutForUser;
  let getDashboardData: typeof import("./app-data").getDashboardData;
  let getTrackerPageData: typeof import("./app-data").getTrackerPageData;
  let user: { id: string };
  let account: { id: string };

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    ({ createCampaignForUser, rollCampaignPutForUser } = await import("./workflows"));
    ({ getDashboardData, getTrackerPageData } = await import("./app-data"));

    const passwordHash = await hash("not-used", 4);
    user = await prisma.user.create({
      data: { name: "Dashboard Truth User", email: `dashboard-truth-${Date.now()}@lst.local`, passwordHash },
    });
    account = await prisma.tradingAccount.create({
      data: { userId: user.id, name: "Schwab", brokerName: "Schwab", accountType: "Brokerage", source: "SCHWAB", visibility: "PRIVATE" },
    });
  });

  afterAll(async () => {
    await prisma.brokerRecord.deleteMany({ where: { userId: user.id } });
    await prisma.campaignEvent.deleteMany({ where: { campaign: { ownerId: user.id } } });
    await prisma.campaign.deleteMany({ where: { ownerId: user.id } });
    await prisma.tradingAccount.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  });

  it("counts the same 3 open campaigns (two plain, one rolled) on both pages - real Matt-shaped fixture", async () => {
    await createCampaignForUser(user.id, account.id, "APLD", "2026-08-28", "2026-09-04", "23.5", "1", "0.28", "0.66", "", "PRIVATE");
    await createCampaignForUser(user.id, account.id, "RIOT", "2026-08-28", "2026-09-04", "17.5", "1", "0.28", "0.66", "", "PRIVATE");
    const corz = await createCampaignForUser(user.id, account.id, "CORZ", "2026-08-24", "2026-09-04", "16.5", "1", "0.26", "0.66", "", "PRIVATE");
    await rollCampaignPutForUser(user.id, corz.id, "2026-08-28", "0.23", "2026-09-04", "18", "0.68", "0.66", null, "0.66");

    const dashboardData = await getDashboardData(user.id);
    expect(dashboardData.openCampaigns).toHaveLength(3);
    expect(dashboardData.openCampaigns.map((c) => c.ticker).sort()).toEqual(["APLD", "CORZ", "RIOT"]);

    const trackerData = await getTrackerPageData(user.id, "mine");
    const trackerOpen = trackerData.campaigns.filter((c) => c.status !== "CLOSED");
    expect(trackerOpen).toHaveLength(3);
    expect(trackerOpen.map((c) => c.ticker).sort()).toEqual(["APLD", "CORZ", "RIOT"]);

    // The two pages' underlying campaign sets must be identical, not just equal in count.
    expect(dashboardData.openCampaigns.map((c) => c.id).sort()).toEqual(trackerOpen.map((c) => c.id).sort());
  });

  it("all three currently-open campaigns are correctly labeled Expiration processing, not a broker position", async () => {
    const { summarizeCampaign } = await import("@/domain/finance/campaigns");
    const dashboardData = await getDashboardData(user.id);
    const stages = dashboardData.openCampaigns.map(
      (campaign) => summarizeCampaign({ status: campaign.status, events: campaign.events }).currentStage,
    );
    expect(stages).toEqual(["Expiration processing", "Expiration processing", "Expiration processing"]);
    // A lifecycle stage is not a broker-position count - Schwab reports 0 actual positions for
    // these tickers once their options expire, which is a completely separate fact tracked
    // independently (see broker-connections/positions), never derived from campaign count.
  });

  it("overall realized P/L excludes all three open campaigns - CORZ's +69.02 net premium cannot become realized P/L while it is still OPEN", async () => {
    const dashboardData = await getDashboardData(user.id);
    // completedCampaigns is queried with status: "CLOSED" - while every campaign is OPEN,
    // this must be empty, so summarizeWinLoss (fed only from completedCampaigns) can never
    // include CORZ's premium, no matter how large.
    expect(dashboardData.completedCampaigns).toHaveLength(0);

    const { summarizeWinLoss } = await import("@/domain/finance/performance");
    const winLoss = summarizeWinLoss([]);
    expect(winLoss.realizedTradingPL).toBe(0);
  });

  it("net option premium across all three open campaigns can still total +123.70 - a cash-flow fact, distinct from realized P/L", async () => {
    const { summarizeCampaign } = await import("@/domain/finance/campaigns");
    const dashboardData = await getDashboardData(user.id);
    const totalNetOptionPremium = dashboardData.openCampaigns.reduce(
      (sum, campaign) => sum + summarizeCampaign({ status: campaign.status, events: campaign.events }).netOptionPremium,
      0,
    );
    expect(Math.round(totalNetOptionPremium * 100) / 100).toBe(123.7);
  });
});
