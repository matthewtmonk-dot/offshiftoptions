import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

maybeDescribe("Schwab campaign auto-reconciliation", () => {
  let prisma: typeof import("./prisma").prisma;
  let createTradingAccountForUser: typeof import("./workflows").createTradingAccountForUser;
  let reconcileSchwabActivityForUser: typeof import("./campaign-reconciliation").reconcileSchwabActivityForUser;
  let getCampaignIdsWithUnknownFees: typeof import("./campaign-reconciliation").getCampaignIdsWithUnknownFees;
  let userA: { id: string };
  let userB: { id: string };
  const userIds: string[] = [];
  let fingerprintCounter = 0;

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    ({ createTradingAccountForUser } = await import("./workflows"));
    ({ reconcileSchwabActivityForUser, getCampaignIdsWithUnknownFees } = await import("./campaign-reconciliation"));

    const passwordHash = await hash("not-used", 4);
    const timestamp = Date.now();
    userA = await prisma.user.create({ data: { name: "Recon User A", email: `recon-a-${timestamp}@lst.local`, passwordHash } });
    userB = await prisma.user.create({ data: { name: "Recon User B", email: `recon-b-${timestamp}@lst.local`, passwordHash } });
    userIds.push(userA.id, userB.id);
  });

  afterAll(async () => {
    await prisma.brokerRecord.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.campaign.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.tradingAccount.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

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
      /** Omit for the default known-$0 fee (matches most fixtures); pass `null` explicitly to
       * simulate a Schwab fee this code couldn't resolve - never conflate the two. */
      fees?: number | null;
      amount?: number;
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
        fingerprint: `test-txn-fingerprint-${userId}-${fingerprintCounter}`,
        identityKey: `test-txn-identity-${userId}-${fingerprintCounter}`,
        symbol: overrides.symbol,
        underlyingSymbol: overrides.underlyingSymbol,
        action: overrides.action,
        occurredAt: overrides.occurredAt,
        quantity: overrides.quantity ?? 1,
        price: overrides.price ?? null,
        fees: overrides.fees === undefined ? 0 : overrides.fees,
        amount: overrides.amount ?? null,
        sources: ["SCHWAB_API"],
        metadata: {},
      },
    });
  }

  it("Friday expiration + option gone Saturday stays EXPIRATION PROCESSING, not a win - never 'Saturday means expired'", async () => {
    const account = await createTradingAccountForUser(userA.id, "Recon Account SAT", "Manual", "10000", "10000", "PRIVATE");
    await createTransaction(userA.id, account.id, {
      symbol: "SATX 260904P00023500",
      underlyingSymbol: "SATX",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-28T14:00:00Z"),
      price: 0.28,
    });

    // Sep 4, 2026 is a Friday; this sync happens Saturday, one day after expiration, with the
    // option already gone and no closing evidence - still not confirmed.
    const summary = await reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-09-05T18:00:00Z"));
    expect(summary.campaignsOpened).toBe(1);
    expect(summary.campaignsExpired).toBe(0);

    const campaign = await prisma.campaign.findFirst({ where: { ownerId: userA.id, accountId: account.id, ticker: "SATX" } });
    expect(campaign?.status).toBe("OPEN");
  });

  it("confirms PUT_EXPIRED once the next NY business day's sync still shows the option gone with no evidence, and keeps opening premium/fees separate", async () => {
    const account = await createTradingAccountForUser(userA.id, "Recon Account APLD", "Manual", "10000", "10000", "PRIVATE");
    await createTransaction(userA.id, account.id, {
      symbol: "APLD 260904P00023500",
      underlyingSymbol: "APLD",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-28T14:00:00Z"),
      price: 0.28,
      fees: 0.65,
    });

    // Saturday sync: still just processing, no premature close.
    const saturday = await reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-09-05T18:00:00Z"));
    expect(saturday.campaignsExpired).toBe(0);

    // Monday Sep 7 is Labor Day - NYSE closed - so this sync must NOT confirm expiration yet.
    const laborDay = await reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-09-07T18:00:00Z"));
    expect(laborDay.campaignsExpired).toBe(0);

    // Tuesday Sep 8 (the first NYSE market day after the Labor Day weekend): option still gone,
    // no BTC/assignment/stock evidence -> confirmed.
    const tuesday = await reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-09-08T18:00:00Z"));
    expect(tuesday.campaignsExpired).toBe(1);

    const campaign = await prisma.campaign.findFirst({ where: { ownerId: userA.id, accountId: account.id, ticker: "APLD" }, include: { events: true } });
    expect(campaign?.status).toBe("CLOSED");
    const opening = campaign?.events.find((event) => event.type === "SELL_PUT");
    const expiry = campaign?.events.find((event) => event.type === "PUT_EXPIRED");
    expect(Number(opening?.premium)).toBe(0.28);
    expect(Number(opening?.fees)).toBe(0.65); // fees tracked separately from premium, never blended in
    expect(Number(expiry?.premium)).toBe(0);
    expect(campaign?.events.some((event) => event.type === "CLOSE_PUT")).toBe(false);
  });

  it("does not close a campaign whose option Schwab still reports even on/after the business-day window - shows as processing, not a final win", async () => {
    const account = await createTradingAccountForUser(userA.id, "Recon Account STILL", "Manual", "10000", "10000", "PRIVATE");
    await createTransaction(userA.id, account.id, {
      symbol: "STIL 260904P00010000",
      underlyingSymbol: "STIL",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-28T14:00:00Z"),
      price: 0.3,
    });

    const summary = await reconcileSchwabActivityForUser(
      userA.id,
      account.id,
      [{ accountId: account.id, symbol: "STIL 260904P00010000", quantity: -1, marketValue: -5 }],
      new Date("2026-09-08T18:00:00Z"),
    );

    expect(summary.campaignsOpened).toBe(1);
    expect(summary.campaignsExpired).toBe(0);

    const campaign = await prisma.campaign.findFirst({ where: { ownerId: userA.id, accountId: account.id, ticker: "STIL" } });
    expect(campaign?.status).toBe("OPEN");
  });

  it("+100 acquired shares of the underlying blocks a false expired-win even after the business-day window", async () => {
    const account = await createTradingAccountForUser(userA.id, "Recon Account STOCK", "Manual", "10000", "10000", "PRIVATE");
    await createTransaction(userA.id, account.id, {
      symbol: "STCK 260904P00023500",
      underlyingSymbol: "STCK",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-28T14:00:00Z"),
      price: 0.28,
    });

    const summary = await reconcileSchwabActivityForUser(
      userA.id,
      account.id,
      [{ accountId: account.id, symbol: "STCK", assetType: "EQUITY", quantity: 100, marketValue: 2350 }],
      new Date("2026-09-08T18:00:00Z"),
    );

    expect(summary.campaignsExpired).toBe(0);
    const campaign = await prisma.campaign.findFirst({ where: { ownerId: userA.id, accountId: account.id, ticker: "STCK" } });
    expect(campaign?.status).toBe("OPEN");
  });

  it("running the sync twice while still in expiration processing (before the business-day window) stays idempotent - no premature campaign changes", async () => {
    const account = await createTradingAccountForUser(userA.id, "Recon Account PROC", "Manual", "10000", "10000", "PRIVATE");
    await createTransaction(userA.id, account.id, {
      symbol: "PROC 260904P00023500",
      underlyingSymbol: "PROC",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-28T14:00:00Z"),
      price: 0.28,
    });

    const saturday = new Date("2026-09-05T18:00:00Z");
    const first = await reconcileSchwabActivityForUser(userA.id, account.id, [], saturday);
    const second = await reconcileSchwabActivityForUser(userA.id, account.id, [], saturday);

    expect(first.campaignsOpened).toBe(1);
    expect(second.campaignsOpened).toBe(0); // already linked, not reopened
    expect(second.campaignsExpired).toBe(0);

    const campaigns = await prisma.campaign.findMany({ where: { ownerId: userA.id, accountId: account.id, ticker: "PROC" } });
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0].status).toBe("OPEN");
  });

  it("assignment discovered on the next business-day sync closes as ASSIGNED, never PUT_EXPIRED", async () => {
    const account = await createTradingAccountForUser(userA.id, "Recon Account ASSIGNLATE", "Manual", "10000", "10000", "PRIVATE");
    await createTransaction(userA.id, account.id, {
      symbol: "ASLT 260904P00030000",
      underlyingSymbol: "ASLT",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-28T14:00:00Z"),
      price: 0.6,
    });

    // Saturday: no evidence yet, option already gone from the positions feed - stays processing.
    const saturday = await reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-09-05T18:00:00Z"));
    expect(saturday.campaignsExpired).toBe(0);
    expect(saturday.campaignsAssigned).toBe(0);

    // Tuesday (the first NYSE market day after the Labor Day weekend): Schwab has now posted
    // the assignment transaction.
    await createTransaction(userA.id, account.id, {
      symbol: "ASLT 260904P00030000",
      underlyingSymbol: "ASLT",
      action: "Assignment",
      occurredAt: new Date("2026-09-04T21:00:00Z"),
      price: null,
    });
    const tuesday = await reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-09-08T18:00:00Z"));
    expect(tuesday.campaignsAssigned).toBe(1);
    expect(tuesday.campaignsExpired).toBe(0);

    const campaign = await prisma.campaign.findFirst({ where: { ownerId: userA.id, accountId: account.id, ticker: "ASLT" } });
    expect(campaign?.status).toBe("ASSIGNED");
  });

  it("closes on an explicit Buy to Close and never fabricates a $0 close as expiration once real evidence exists", async () => {
    const account = await createTradingAccountForUser(userA.id, "Recon Account BTC", "Manual", "10000", "10000", "PRIVATE");
    await createTransaction(userA.id, account.id, {
      symbol: "CLOZ 260904P00020000",
      underlyingSymbol: "CLOZ",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-28T14:00:00Z"),
      price: 0.5,
    });
    await createTransaction(userA.id, account.id, {
      symbol: "CLOZ 260904P00020000",
      underlyingSymbol: "CLOZ",
      action: "Buy to Close",
      occurredAt: new Date("2026-09-02T14:00:00Z"),
      price: 0.1,
    });

    const summary = await reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-09-05T13:00:00Z"));
    expect(summary.campaignsClosed).toBe(1);
    expect(summary.campaignsExpired).toBe(0);

    const campaign = await prisma.campaign.findFirst({ where: { ownerId: userA.id, accountId: account.id, ticker: "CLOZ" }, include: { events: true } });
    expect(campaign?.status).toBe("CLOSED");
    expect(campaign?.events.some((event) => event.type === "CLOSE_PUT")).toBe(true);
    expect(campaign?.events.some((event) => event.type === "PUT_EXPIRED")).toBe(false);
  });

  it("assignment prevents a false expired-win", async () => {
    const account = await createTradingAccountForUser(userA.id, "Recon Account ASSIGN", "Manual", "10000", "10000", "PRIVATE");
    await createTransaction(userA.id, account.id, {
      symbol: "ASGN 260904P00030000",
      underlyingSymbol: "ASGN",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-28T14:00:00Z"),
      price: 0.6,
    });
    await createTransaction(userA.id, account.id, {
      symbol: "ASGN 260904P00030000",
      underlyingSymbol: "ASGN",
      action: "Assignment",
      occurredAt: new Date("2026-09-04T21:00:00Z"),
      price: null,
    });

    const summary = await reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-09-05T13:00:00Z"));
    expect(summary.campaignsAssigned).toBe(1);
    expect(summary.campaignsExpired).toBe(0);

    const campaign = await prisma.campaign.findFirst({ where: { ownerId: userA.id, accountId: account.id, ticker: "ASGN" } });
    expect(campaign?.status).toBe("ASSIGNED");
  });

  it("running sync twice on the next business day (once confirmed) creates no duplicate campaign or event", async () => {
    const account = await createTradingAccountForUser(userA.id, "Recon Account DUPE", "Manual", "10000", "10000", "PRIVATE");
    await createTransaction(userA.id, account.id, {
      symbol: "DUPE 260904P00015000",
      underlyingSymbol: "DUPE",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-28T14:00:00Z"),
      price: 0.2,
    });

    const tuesday = new Date("2026-09-08T18:00:00Z"); // first NYSE market day after the Labor Day weekend
    await reconcileSchwabActivityForUser(userA.id, account.id, [], tuesday);
    const secondRun = await reconcileSchwabActivityForUser(userA.id, account.id, [], tuesday);

    expect(secondRun.campaignsOpened).toBe(0);
    expect(secondRun.campaignsExpired).toBe(0);

    const campaigns = await prisma.campaign.findMany({ where: { ownerId: userA.id, accountId: account.id, ticker: "DUPE" }, include: { events: true } });
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0].events.filter((event) => event.type === "PUT_EXPIRED")).toHaveLength(1);
  });

  it("a malformed/partial broker record (unparseable symbol, missing price) fails safe - no crash, no guessed campaign", async () => {
    const account = await createTradingAccountForUser(userA.id, "Recon Account MALFORMED", "Manual", "10000", "10000", "PRIVATE");
    await createTransaction(userA.id, account.id, {
      symbol: "not-a-valid-option-symbol",
      underlyingSymbol: "???",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-28T14:00:00Z"),
      price: null, // missing price - can't confidently open a campaign from this
    });

    await expect(reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-09-08T18:00:00Z"))).resolves.toMatchObject({
      campaignsOpened: 0,
    });

    const campaignCount = await prisma.campaign.count({ where: { ownerId: userA.id, accountId: account.id } });
    expect(campaignCount).toBe(0);
    // Left unlinked for the existing manual "awaiting review" flow rather than guessed at.
    const stillUnlinked = await prisma.brokerRecord.findFirst({ where: { userId: userA.id, symbol: "not-a-valid-option-symbol" } });
    expect(stillUnlinked?.linkedCampaignId).toBeNull();
  });

  it("Matt's three independent Sep 4 CSPs create three separate campaigns and all backfill as expired worthless once the confirmation window is satisfied", async () => {
    const account = await createTradingAccountForUser(userA.id, "Recon Account THREE", "Manual", "10000", "10000", "PRIVATE");
    await createTransaction(userA.id, account.id, { symbol: "APLD 260904P00023500", underlyingSymbol: "APLD", action: "Sell to Open", occurredAt: new Date("2026-08-28T14:00:00Z"), price: 0.28 });
    await createTransaction(userA.id, account.id, { symbol: "CORZ 260904P00016500", underlyingSymbol: "CORZ", action: "Sell to Open", occurredAt: new Date("2026-08-28T14:05:00Z"), price: 0.68 });
    await createTransaction(userA.id, account.id, { symbol: "RIOT 260904P00017500", underlyingSymbol: "RIOT", action: "Sell to Open", occurredAt: new Date("2026-08-28T14:10:00Z"), price: 0.28 });

    // Saturday: three campaigns open automatically, but expiration confirmation waits.
    const saturday = await reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-09-05T18:00:00Z"));
    expect(saturday.campaignsOpened).toBe(3);
    expect(saturday.campaignsExpired).toBe(0);

    // Monday Sep 7 is Labor Day - must NOT confirm yet even though it's a weekday.
    const laborDay = await reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-09-07T18:00:00Z"));
    expect(laborDay.campaignsExpired).toBe(0);

    // Tuesday Sep 8 (the first NYSE market day after the Labor Day weekend): confirmed sync
    // closes all three as expired worthless.
    const tuesday = await reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-09-08T18:00:00Z"));
    expect(tuesday.campaignsExpired).toBe(3);

    const campaigns = await prisma.campaign.findMany({ where: { ownerId: userA.id, accountId: account.id, ticker: { in: ["APLD", "CORZ", "RIOT"] } } });
    expect(campaigns).toHaveLength(3);
    expect(campaigns.every((campaign) => campaign.status === "CLOSED")).toBe(true);
  });

  it("an explicit $0 fee is KNOWN - the campaign is never flagged as having an unresolved fee", async () => {
    const account = await createTradingAccountForUser(userA.id, "Recon Account FEEZERO", "Manual", "10000", "10000", "PRIVATE");
    await createTransaction(userA.id, account.id, {
      symbol: "FEEZ 260904P00023500",
      underlyingSymbol: "FEEZ",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-28T14:00:00Z"),
      price: 0.28,
      fees: 0,
    });

    await reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-09-08T18:00:00Z"));
    const campaign = await prisma.campaign.findFirst({ where: { ownerId: userA.id, accountId: account.id, ticker: "FEEZ" } });
    const unknown = await getCampaignIdsWithUnknownFees([campaign!.id]);
    expect(unknown.has(campaign!.id)).toBe(false);
  });

  it("an explicit nonzero fee is captured and deducted, and the campaign is never flagged as unresolved", async () => {
    const account = await createTradingAccountForUser(userA.id, "Recon Account FEEKNOWN", "Manual", "10000", "10000", "PRIVATE");
    await createTransaction(userA.id, account.id, {
      symbol: "FEEK 260904P00023500",
      underlyingSymbol: "FEEK",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-28T14:00:00Z"),
      price: 0.28,
      fees: 0.65,
    });

    await reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-09-08T18:00:00Z"));
    const campaign = await prisma.campaign.findFirst({ where: { ownerId: userA.id, accountId: account.id, ticker: "FEEK" }, include: { events: true } });
    const opening = campaign?.events.find((event) => event.type === "SELL_PUT");
    expect(Number(opening?.fees)).toBe(0.65);
    const unknown = await getCampaignIdsWithUnknownFees([campaign!.id]);
    expect(unknown.has(campaign!.id)).toBe(false);
  });

  it("a missing/unparseable fee is flagged UNKNOWN, never silently converted to a fake known $0", async () => {
    const account = await createTradingAccountForUser(userA.id, "Recon Account FEEUNK", "Manual", "10000", "10000", "PRIVATE");
    await createTransaction(userA.id, account.id, {
      symbol: "FEEU 260904P00023500",
      underlyingSymbol: "FEEU",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-28T14:00:00Z"),
      price: 0.28,
      fees: null,
    });

    await reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-09-08T18:00:00Z"));
    const campaign = await prisma.campaign.findFirst({ where: { ownerId: userA.id, accountId: account.id, ticker: "FEEU" } });
    const unknown = await getCampaignIdsWithUnknownFees([campaign!.id]);
    expect(unknown.has(campaign!.id)).toBe(true);
  });

  it("a manually-created campaign (no linked BrokerRecord) is never flagged as having an unresolved fee", async () => {
    const account = await createTradingAccountForUser(userA.id, "Recon Account MANUALFEE", "Manual", "10000", "10000", "PRIVATE");
    const { createCampaignForUser } = await import("./workflows");
    const campaign = await createCampaignForUser(userA.id, account.id, "MANL", "2026-08-28", "2026-09-04", "20", "1", "0.5", "0", "", "PRIVATE");
    const unknown = await getCampaignIdsWithUnknownFees([campaign.id]);
    expect(unknown.has(campaign.id)).toBe(false);
  });

  it("keeps a same-day roll as one campaign, not a closed win followed by a new one", async () => {
    const account = await createTradingAccountForUser(userA.id, "Recon Account ROLL", "Manual", "10000", "10000", "PRIVATE");
    await createTransaction(userA.id, account.id, {
      symbol: "ROLL 260828P00018000",
      underlyingSymbol: "ROLL",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-14T14:00:00Z"),
      price: 0.36,
    });

    let summary = await reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-08-15T13:00:00Z"));
    expect(summary.campaignsOpened).toBe(1);

    await createTransaction(userA.id, account.id, {
      symbol: "ROLL 260828P00018000",
      underlyingSymbol: "ROLL",
      action: "Buy to Close",
      occurredAt: new Date("2026-08-27T14:00:00Z"),
      price: 0.52,
    });
    await createTransaction(userA.id, account.id, {
      symbol: "ROLL 260904P00017500",
      underlyingSymbol: "ROLL",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-27T14:01:00Z"),
      price: 0.88,
    });

    summary = await reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-08-28T13:00:00Z"));
    expect(summary.campaignsRolled).toBe(1);
    expect(summary.campaignsOpened).toBe(0);

    const campaigns = await prisma.campaign.findMany({ where: { ownerId: userA.id, accountId: account.id, ticker: "ROLL" }, include: { events: true } });
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0].status).toBe("OPEN");
    expect(campaigns[0].events.map((event) => event.type).sort()).toEqual(["ROLL_PUT_CLOSE", "ROLL_PUT_OPEN", "SELL_PUT"].sort());
  });

  it("User B's sync never reconciles or creates campaigns from User A's broker records", async () => {
    const accountA = await createTradingAccountForUser(userA.id, "Recon Account PRIVACY A", "Manual", "10000", "10000", "PRIVATE");
    await createTransaction(userA.id, accountA.id, {
      symbol: "PRIV 260904P00012000",
      underlyingSymbol: "PRIV",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-28T14:00:00Z"),
      price: 0.2,
    });

    const accountB = await createTradingAccountForUser(userB.id, "Recon Account PRIVACY B", "Manual", "10000", "10000", "PRIVATE");
    const summaryForB = await reconcileSchwabActivityForUser(userB.id, accountB.id, [], new Date("2026-09-05T13:00:00Z"));
    expect(summaryForB.campaignsOpened).toBe(0);

    const ericCampaigns = await prisma.campaign.count({ where: { ownerId: userB.id, ticker: "PRIV" } });
    expect(ericCampaigns).toBe(0);

    // Even calling reconciliation with User A's own account id, scoped to User B, must never
    // touch User A's data - accountId alone (never trusted from a client) is not ownership.
    const crossAccount = await reconcileSchwabActivityForUser(userB.id, accountA.id, [], new Date("2026-09-05T13:00:00Z"));
    expect(crossAccount.campaignsOpened).toBe(0);
    const stillUnlinked = await prisma.brokerRecord.findFirst({ where: { userId: userA.id, symbol: "PRIV 260904P00012000" } });
    expect(stillUnlinked?.linkedCampaignId).toBeNull();
  });
});
