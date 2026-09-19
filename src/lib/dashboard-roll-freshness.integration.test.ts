import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Regression coverage for the "Dashboard shows the pre-roll/expired campaign state while the
 * Tracker shows the current rolled contract" production bug (see PROJECT_HANDOFF.md). Root
 * cause: getCurrentOpenPut/summarizeCampaign's event ordering (compareEvents) only tie-broke on
 * (occurredAt, sortOrder) - a roll's ROLL_PUT_CLOSE/ROLL_PUT_OPEN pair sharing both of those
 * values relied on JS's stable sort preserving whatever order the caller's array/DB query
 * happened to return them in, which two structurally different Prisma queries (Dashboard's vs
 * the Tracker's) are not guaranteed to agree on for tied ORDER BY keys. That single
 * non-determinism explained every reported symptom at once: the campaign card's stage label
 * ("Expiration processing" instead of "Rolled put"), the awaiting-expiration count, the
 * duplicate raw Schwab card (buildTrackedPuts fed the stale pre-roll strike/expiration into
 * matchTrackedPut, which then couldn't find the live post-roll Schwab position), and the doubled
 * Secured CSP collateral. Fixed by giving compareEvents a fully deterministic tertiary/quaternary
 * tiebreak (createdAt, then id) in src/domain/finance/campaigns.ts.
 *
 * This fixture reproduces the real production lifecycle for both affected tickers - PATH-like
 * (STO old put, BTC old put, STO new put) and ONON-like (same shape) - alongside two genuinely
 * expired campaigns (CORZ-like, HL-like), and asserts the exact $7,550 / 2-awaiting-expiration
 * arithmetic the task's production report expects.
 */
const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

maybeDescribe("Dashboard post-roll state matches Tracker (no stale pre-roll display)", () => {
  let prisma: typeof import("./prisma").prisma;
  let getCurrentOpenPut: typeof import("@/domain/finance/campaigns").getCurrentOpenPut;
  let summarizeCampaign: typeof import("@/domain/finance/campaigns").summarizeCampaign;
  let getDashboardData: typeof import("./app-data").getDashboardData;
  let getTrackerPageData: typeof import("./app-data").getTrackerPageData;
  let getSchwabConnectionSummaryForUser: typeof import("./broker-connections").getSchwabConnectionSummaryForUser;
  let matchDashboardPositions: typeof import("@/domain/finance/trackerPositionMatch").matchDashboardPositions;
  let summarizeCspSecuredCapital: typeof import("@/domain/finance/brokerPositions").summarizeCspSecuredCapital;
  let summarizeAccountPerformance: typeof import("@/domain/finance/accountLedger").summarizeAccountPerformance;

  let userId: string;
  let accountId: string;
  const campaignIds: Record<"CORZ" | "HL" | "PATH" | "ONON", string> = { CORZ: "", HL: "", PATH: "", ONON: "" };
  let connectionId: string;
  let ledgerEntryId: string;

  // "Today" for this fixture: the two rolled campaigns' new legs (Sep 25) have not expired, but
  // their OLD pre-roll legs (Sep 18) - and CORZ/HL's still-Sep-18 legs - have.
  const asOf = new Date("2026-09-19T15:00:00Z");

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    ({ getCurrentOpenPut, summarizeCampaign } = await import("@/domain/finance/campaigns"));
    ({ getDashboardData, getTrackerPageData } = await import("./app-data"));
    ({ getSchwabConnectionSummaryForUser } = await import("./broker-connections"));
    ({ matchDashboardPositions } = await import("@/domain/finance/trackerPositionMatch"));
    ({ summarizeCspSecuredCapital } = await import("@/domain/finance/brokerPositions"));
    ({ summarizeAccountPerformance } = await import("@/domain/finance/accountLedger"));

    const passwordHash = await hash("x", 4);
    const timestamp = Date.now();
    const user = await prisma.user.create({ data: { name: "Roll Repro", email: `roll-repro-${timestamp}@lst.local`, passwordHash } });
    const account = await prisma.tradingAccount.create({
      data: { userId: user.id, name: "Roll Repro Account", accountType: "Manual", startingBalance: 10000, manualBalance: 10000, visibility: "PRIVATE" },
    });
    userId = user.id;
    accountId = account.id;

    // CORZ-like and HL-like: genuinely expired, single SELL_PUT, no roll - these two are
    // correctly "Expiration processing" both before and after the fix.
    const corz = await prisma.campaign.create({
      data: {
        ownerId: userId, accountId, ticker: "CORZ", strategy: "CASH_SECURED_PUT", status: "OPEN", visibility: "PRIVATE",
        openedAt: new Date("2026-09-04T14:00:00Z"),
        events: { create: [
          { type: "SELL_PUT", occurredAt: new Date("2026-09-04T14:00:00Z"), sortOrder: 0, optionType: "PUT", contracts: 1, strike: "16.50", expiration: new Date("2026-09-18T20:00:00Z"), premium: "0.29" },
        ] },
      },
    });
    const hl = await prisma.campaign.create({
      data: {
        ownerId: userId, accountId, ticker: "HL", strategy: "CASH_SECURED_PUT", status: "OPEN", visibility: "PRIVATE",
        openedAt: new Date("2026-09-04T14:00:00Z"),
        events: { create: [
          { type: "SELL_PUT", occurredAt: new Date("2026-09-04T14:00:00Z"), sortOrder: 0, optionType: "PUT", contracts: 1, strike: "18.00", expiration: new Date("2026-09-18T20:00:00Z"), premium: "0.25" },
        ] },
      },
    });

    // PATH-like and ONON-like: STO old put, BTC old put, STO new put - the exact roll shape from
    // the task's DO-NOT-TOUCH lifecycle rule ("old short put CLOSED + new short put OPENED").
    // ROLL_PUT_CLOSE/ROLL_PUT_OPEN deliberately share BOTH occurredAt and sortOrder, which is the
    // exact condition that exposed the pre-fix non-determinism.
    const path = await prisma.campaign.create({
      data: {
        ownerId: userId, accountId, ticker: "PATH", strategy: "CASH_SECURED_PUT", status: "OPEN", visibility: "PRIVATE",
        openedAt: new Date("2026-09-01T14:00:00Z"),
        events: { create: [
          { type: "SELL_PUT", occurredAt: new Date("2026-09-01T14:00:00Z"), sortOrder: 0, optionType: "PUT", contracts: 1, strike: "15.50", expiration: new Date("2026-09-18T20:00:00Z"), premium: "0.40" },
          { type: "ROLL_PUT_CLOSE", occurredAt: new Date("2026-09-15T14:00:00Z"), sortOrder: 1, groupKey: "roll-path-1", optionType: "PUT", contracts: 1, strike: "15.50", expiration: new Date("2026-09-18T20:00:00Z"), premium: "0.70", fees: 0 },
          { type: "ROLL_PUT_OPEN", occurredAt: new Date("2026-09-15T14:00:00Z"), sortOrder: 1, groupKey: "roll-path-1", optionType: "PUT", contracts: 1, strike: "14.00", expiration: new Date("2026-09-25T20:00:00Z"), premium: "1.02", fees: 0 },
        ] },
      },
    });
    const onon = await prisma.campaign.create({
      data: {
        ownerId: userId, accountId, ticker: "ONON", strategy: "CASH_SECURED_PUT", status: "OPEN", visibility: "PRIVATE",
        openedAt: new Date("2026-09-01T14:00:00Z"),
        events: { create: [
          { type: "SELL_PUT", occurredAt: new Date("2026-09-01T14:00:00Z"), sortOrder: 0, optionType: "PUT", contracts: 1, strike: "28.00", expiration: new Date("2026-09-18T20:00:00Z"), premium: "0.60" },
          { type: "ROLL_PUT_CLOSE", occurredAt: new Date("2026-09-15T14:00:00Z"), sortOrder: 1, groupKey: "roll-onon-1", optionType: "PUT", contracts: 1, strike: "28.00", expiration: new Date("2026-09-18T20:00:00Z"), premium: "0.90", fees: 0 },
          { type: "ROLL_PUT_OPEN", occurredAt: new Date("2026-09-15T14:00:00Z"), sortOrder: 1, groupKey: "roll-onon-1", optionType: "PUT", contracts: 1, strike: "27.00", expiration: new Date("2026-09-25T20:00:00Z"), premium: "1.45", fees: 0 },
        ] },
      },
    });

    campaignIds.CORZ = corz.id;
    campaignIds.HL = hl.id;
    campaignIds.PATH = path.id;
    campaignIds.ONON = onon.id;

    // Freshness fixture: an OLDER account-value snapshot (Sep 15) alongside a NEWER Brokerage
    // Sync connection timestamp (Sep 19) - the two genuinely different provenances behind
    // symptom #5. Neither should be conflated with or overwrite the other.
    const connection = await prisma.brokerConnection.create({
      data: {
        userId, provider: "SCHWAB", label: "Schwab", status: "CONNECTED",
        metadata: { lastAccountSyncAt: "2026-09-19T13:20:00.000Z" },
      },
    });
    connectionId = connection.id;
    const ledgerEntry = await prisma.accountLedgerEntry.create({
      data: {
        accountId, type: "BROKER_SNAPSHOT", occurredAt: new Date("2026-09-15T20:13:00.000Z"),
        accountValue: "25000", cash: "5000", source: "SCHWAB",
      },
    });
    ledgerEntryId = ledgerEntry.id;
  });

  afterAll(async () => {
    await prisma.accountLedgerEntry.delete({ where: { id: ledgerEntryId } });
    await prisma.brokerConnection.delete({ where: { id: connectionId } });
    for (const id of Object.values(campaignIds)) {
      await prisma.campaignEvent.deleteMany({ where: { campaignId: id } });
      await prisma.campaign.delete({ where: { id } });
    }
    await prisma.tradingAccount.delete({ where: { id: accountId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("test 1/2: getCurrentOpenPut returns the NEW rolled contract (strike/expiration) for PATH and ONON on the Dashboard's own query", async () => {
    const data = await getDashboardData(userId);
    const path = data.openCampaigns.find((c) => c.id === campaignIds.PATH)!;
    const onon = data.openCampaigns.find((c) => c.id === campaignIds.ONON)!;
    expect(getCurrentOpenPut(path.events)).toEqual({ strike: 14, contracts: 1, expiration: new Date("2026-09-25T20:00:00.000Z") });
    expect(getCurrentOpenPut(onon.events)).toEqual({ strike: 27, contracts: 1, expiration: new Date("2026-09-25T20:00:00.000Z") });
  });

  it("test 3: PATH/ONON are NOT labeled Expiration processing; CORZ/HL still are", async () => {
    const data = await getDashboardData(userId);
    const stageFor = (id: string) => summarizeCampaign({ status: "OPEN", events: data.openCampaigns.find((c) => c.id === id)!.events, asOf }).currentStage;
    expect(stageFor(campaignIds.PATH)).toBe("Rolled put");
    expect(stageFor(campaignIds.ONON)).toBe("Rolled put");
    expect(stageFor(campaignIds.CORZ)).toBe("Expiration processing");
    expect(stageFor(campaignIds.HL)).toBe("Expiration processing");
  });

  it("test 17: Tracker sees the identical current-open-put and stage as the Dashboard for every campaign (no page-specific drift)", async () => {
    const dashboardData = await getDashboardData(userId);
    const trackerData = await getTrackerPageData(userId, "mine");
    for (const id of Object.values(campaignIds)) {
      const dashboardCampaign = dashboardData.openCampaigns.find((c) => c.id === id)!;
      const trackerCampaign = trackerData.campaigns.find((c) => c.id === id)!;
      expect(getCurrentOpenPut(trackerCampaign.events)).toEqual(getCurrentOpenPut(dashboardCampaign.events));
      const dashboardStage = summarizeCampaign({ status: "OPEN", events: dashboardCampaign.events, asOf }).currentStage;
      const trackerStage = summarizeCampaign({ status: "OPEN", events: trackerCampaign.events, asOf }).currentStage;
      expect(trackerStage).toBe(dashboardStage);
    }
  });

  it("test 18/19: roll history still shows the closed OLD leg and opened NEW leg, and the campaign still has exactly Short 1 contract", async () => {
    const data = await getDashboardData(userId);
    const path = data.openCampaigns.find((c) => c.id === campaignIds.PATH)!;
    expect(path.events).toHaveLength(3);
    expect(path.events.map((e) => e.type).sort()).toEqual(["ROLL_PUT_CLOSE", "ROLL_PUT_OPEN", "SELL_PUT"].sort());
    const openPut = getCurrentOpenPut(path.events)!;
    expect(openPut.contracts).toBe(1);
  });

  it("test 4/5/6/7/8/9/10: full Dashboard aggregate arithmetic - $7,550 secured, 2 awaiting expiration, no duplicate broker cards, broker count stays the actual Schwab count", async () => {
    const data = await getDashboardData(userId);

    let campaignSecuredCapital = 0;
    let awaitingExpirationCount = 0;
    for (const campaign of data.openCampaigns) {
      const summary = summarizeCampaign({ status: campaign.status, events: campaign.events, asOf });
      // currentCollateralCommitted (the currently-open leg's own strike), not collateralCommitted
      // (a lifetime high-water mark) - PATH/ONON both rolled DOWN in this fixture, so using the
      // historical max would overstate Secured CSP even after the ordering fix.
      campaignSecuredCapital += summary.currentCollateralCommitted ?? summary.collateralCommitted ?? 0;
      if (summary.currentStage === "Expiration processing") awaitingExpirationCount += 1;
    }
    expect(data.openCampaigns).toHaveLength(4);
    expect(awaitingExpirationCount).toBe(2); // test 9/10: only CORZ+HL, not all 4

    // Live Schwab only still reports PATH's and ONON's NEW (post-roll) contracts - CORZ/HL have
    // already expired off Schwab's books, exactly like the production report.
    const trackedPuts = data.openCampaigns.flatMap((campaign) => {
      const openPut = getCurrentOpenPut(campaign.events);
      return openPut ? [{ id: campaign.id, ownerId: campaign.ownerId, accountId: campaign.accountId, ticker: campaign.ticker, status: campaign.status, ...openPut }] : [];
    });
    const account = { id: accountId, userId, externalAccountId: "SCHWAB-EXT-1" };
    const schwabPositions = [
      { accountId: "SCHWAB-EXT-1", symbol: "PATH  260925P00014000", quantity: -1, assetType: "OPTION" as const, putCall: "PUT" as const, strikePrice: 14, underlyingSymbol: "PATH", marketValue: -1400, linkedCampaignId: null as string | null },
      { accountId: "SCHWAB-EXT-1", symbol: "ONON  260925P00027000", quantity: -1, assetType: "OPTION" as const, putCall: "PUT" as const, strikePrice: 27, underlyingSymbol: "ONON", marketValue: -2700, linkedCampaignId: null as string | null },
    ];

    const matches = matchDashboardPositions(userId, schwabPositions, [account], trackedPuts);
    // test 4: exact match against the NEW contract for both.
    expect(matches.map((m) => m.disposition)).toEqual(["EXACT", "EXACT"]);
    expect(matches.map((m) => m.confirmedCampaignId).sort()).toEqual([campaignIds.ONON, campaignIds.PATH].sort());

    // test 5/6: nothing stays additive, so no duplicate raw card and no doubled collateral.
    const additive = matches.filter((m) => m.disposition === "AMBIGUOUS" || m.disposition === "NONE").map((m) => m.position);
    expect(additive).toHaveLength(0);
    const additiveCollateral = summarizeCspSecuredCapital(additive).total;

    // test 7: the exact production arithmetic - $7,550, never $11,650.
    expect(campaignSecuredCapital).toBe(7550);
    expect(campaignSecuredCapital + additiveCollateral).toBe(7550);
    const oldBuggyDoubleCounted = campaignSecuredCapital + summarizeCspSecuredCapital(schwabPositions).total;
    expect(oldBuggyDoubleCounted).toBe(11650); // documents the regression this fixes, not the fixed behavior

    // test 8: "Broker positions" is the actual Schwab position count (2), independent of the
    // 4-campaign count - dedup must never inflate or shrink this to match campaign count.
    expect(schwabPositions).toHaveLength(2);
  });

  it("test 13/14: an ambiguous or genuinely unmatched broker position stays separate and additive (never silently absorbed into a campaign)", async () => {
    const data = await getDashboardData(userId);
    const trackedPuts = data.openCampaigns.flatMap((campaign) => {
      const openPut = getCurrentOpenPut(campaign.events);
      return openPut ? [{ id: campaign.id, ownerId: campaign.ownerId, accountId: campaign.accountId, ticker: campaign.ticker, status: campaign.status, ...openPut }] : [];
    });
    const account = { id: accountId, userId, externalAccountId: "SCHWAB-EXT-1" };
    // A genuinely unrelated live position (no tracked campaign for it at all).
    const unrelated = { accountId: "SCHWAB-EXT-1", symbol: "SOFI  260925P00010000", quantity: -1, assetType: "OPTION" as const, putCall: "PUT" as const, strikePrice: 10, underlyingSymbol: "SOFI", linkedCampaignId: null as string | null };
    const matches = matchDashboardPositions(userId, [unrelated], [account], trackedPuts);
    expect(matches[0].disposition).toBe("NONE");
    expect(matches[0].confirmedCampaignId).toBeNull();
  });

  it("test 15/16: Dashboard's two freshness sources are honest and distinct - brokerage-activity-sync time never conflated with the account-balance-snapshot time", async () => {
    const connection = await getSchwabConnectionSummaryForUser(userId);
    expect(connection?.lastAccountSyncAt).toBe("2026-09-19T13:20:00.000Z");

    const [account] = await prisma.tradingAccount.findMany({
      where: { userId },
      include: { ledgerEntries: { orderBy: { occurredAt: "asc" } }, brokerRecords: true },
    });
    const performance = summarizeAccountPerformance({ ledgerEntries: account.ledgerEntries, brokerRecords: [], fallbackTradingPL: 0 });
    // Account Value/Cash's own true provenance (Sep 15) is preserved, not bumped to Sep 19 just
    // because a later Brokerage Sync ran without writing a fresh BROKER_SNAPSHOT.
    expect(performance.ledger.latestBrokerSnapshot?.asOf).toEqual(new Date("2026-09-15T20:13:00.000Z"));
    expect(performance.ledger.latestBrokerSnapshot?.accountValue).toBe(25000);

    // The two timestamps genuinely differ - proving Dashboard has something truthful to show for
    // each, rather than one silently standing in for the other.
    expect(connection!.lastAccountSyncAt).not.toBe(performance.ledger.latestBrokerSnapshot?.asOf.toISOString());
  });

  it("test 20: reading Dashboard/Tracker data never mutates the Brokerage Sync connection or ledger state", async () => {
    const before = await prisma.brokerConnection.findUniqueOrThrow({ where: { id: connectionId } });
    await getDashboardData(userId);
    await getTrackerPageData(userId, "mine");
    const after = await prisma.brokerConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.metadata).toEqual(before.metadata);
  });
});
