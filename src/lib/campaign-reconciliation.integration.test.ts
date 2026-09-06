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

    // REGRESSION: the rolled-to leg (expiring Sep 4) later reaches its own real expiration-
    // removal evidence. This must stay "expiration processing" through the weekend/Labor Day
    // and only ever transition via PUT_EXPIRED - never a second, spurious CLOSE_PUT.
    await createTransaction(userA.id, account.id, {
      symbol: "ROLL 260904P00017500",
      underlyingSymbol: "ROLL",
      action: "Removed - Expiration",
      occurredAt: new Date("2026-09-04T21:00:00Z"),
      price: 0,
      fees: null,
    });

    const saturday = await reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-09-05T18:00:00Z"));
    expect(saturday.campaignsClosed).toBe(0);
    expect(saturday.campaignsExpired).toBe(0);
    const stillOpen = await prisma.campaign.findFirst({ where: { ownerId: userA.id, accountId: account.id, ticker: "ROLL" } });
    expect(stillOpen?.status).toBe("OPEN");

    const laborDay = await reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-09-07T18:00:00Z"));
    expect(laborDay.campaignsClosed).toBe(0);
    expect(laborDay.campaignsExpired).toBe(0);

    const tuesday = await reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-09-08T18:00:00Z"));
    expect(tuesday.campaignsClosed).toBe(0);
    expect(tuesday.campaignsExpired).toBe(1);

    const finalCampaign = await prisma.campaign.findFirst({
      where: { ownerId: userA.id, accountId: account.id, ticker: "ROLL" },
      include: { events: true },
    });
    expect(finalCampaign?.status).toBe("CLOSED");
    expect(finalCampaign?.events.map((event) => event.type).sort()).toEqual(["PUT_EXPIRED", "ROLL_PUT_CLOSE", "ROLL_PUT_OPEN", "SELL_PUT"].sort());
    expect(finalCampaign?.events.filter((event) => event.type === "CLOSE_PUT")).toHaveLength(0);
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

  it("real diagnostic-derived fixture: APLD/RIOT open independently, CORZ's same-day BTC+STO reconciles as one roll, and gross premium matches the real domain calculation", async () => {
    const account = await createTradingAccountForUser(userA.id, "Recon Account REALSYNC", "Manual", "10000", "10000", "PRIVATE");

    await createTransaction(userA.id, account.id, {
      symbol: "APLD 260904P00023500",
      underlyingSymbol: "APLD",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-31T14:02:00Z"),
      price: 0.28,
    });
    await createTransaction(userA.id, account.id, {
      symbol: "RIOT 260904P00017500",
      underlyingSymbol: "RIOT",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-31T14:13:00Z"),
      price: 0.28,
      fees: null, // Schwab didn't report a fee for this one - must stay flagged unknown, never $0
    });
    await createTransaction(userA.id, account.id, {
      symbol: "CORZ 260904P00016500",
      underlyingSymbol: "CORZ",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-24T13:30:00Z"),
      price: 0.26,
    });
    await createTransaction(userA.id, account.id, {
      symbol: "CORZ 260904P00016500",
      underlyingSymbol: "CORZ",
      action: "Buy to Close",
      occurredAt: new Date("2026-08-28T13:32:00Z"),
      price: 0.23,
    });
    await createTransaction(userA.id, account.id, {
      symbol: "CORZ 260918P00018000",
      underlyingSymbol: "CORZ",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-28T13:32:00Z"),
      price: 0.68,
    });

    const summary = await reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-08-31T18:00:00Z"));
    expect(summary.campaignsOpened).toBe(3); // APLD, RIOT, and CORZ's original opening leg
    expect(summary.campaignsRolled).toBe(1); // CORZ's BTC+STO pair rolls that same campaign, not a fresh one

    const campaigns = await prisma.campaign.findMany({
      where: { ownerId: userA.id, accountId: account.id, ticker: { in: ["APLD", "RIOT", "CORZ"] } },
      include: { events: true },
    });
    expect(campaigns).toHaveLength(3); // one CORZ campaign, never two

    const { summarizeCampaign } = await import("@/domain/finance/campaigns");
    const corz = campaigns.find((c) => c.ticker === "CORZ")!;
    const apld = campaigns.find((c) => c.ticker === "APLD")!;
    const riot = campaigns.find((c) => c.ticker === "RIOT")!;

    expect(corz.events.map((e) => e.type).sort()).toEqual(["ROLL_PUT_CLOSE", "ROLL_PUT_OPEN", "SELL_PUT"].sort());
    // +0.26 STO, -0.23 BTC, +0.68 STO -> $71 gross before fees - computed by the real
    // summarizeCampaign(), never hand-computed or hardcoded into production code.
    expect(summarizeCampaign({ events: corz.events, status: corz.status }).netOptionPremium).toBe(71);
    expect(summarizeCampaign({ events: apld.events, status: apld.status }).netOptionPremium).toBe(28);
    expect(summarizeCampaign({ events: riot.events, status: riot.status }).netOptionPremium).toBe(28);

    // RIOT's unresolved fee stays flagged unknown - never silently treated as a confirmed $0.
    const unknownFeeCampaigns = await getCampaignIdsWithUnknownFees([apld.id, riot.id, corz.id]);
    expect(unknownFeeCampaigns.has(riot.id)).toBe(true);
    expect(unknownFeeCampaigns.has(apld.id)).toBe(false);
    expect(unknownFeeCampaigns.has(corz.id)).toBe(false);

    // Idempotent: re-running reconciliation against the same synced data creates nothing new.
    const secondRun = await reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-08-31T18:00:00Z"));
    expect(secondRun.campaignsOpened).toBe(0);
    expect(secondRun.campaignsRolled).toBe(0);
    const campaignsAfterSecondRun = await prisma.campaign.findMany({
      where: { ownerId: userA.id, accountId: account.id, ticker: { in: ["APLD", "RIOT", "CORZ"] } },
      include: { events: true },
    });
    expect(campaignsAfterSecondRun).toHaveLength(3);
    expect(campaignsAfterSecondRun.find((c) => c.ticker === "CORZ")!.events).toHaveLength(3);
  });

  it("fee-math plausibility check: IF each real trade's fee turns out to be $0.66 (Matt's screenshots suggest ~$0.65 commission + $0.01 reg fee), net trading P/L across all three campaigns is $123.70 - not asserted as confirmed production fact, only as a check against the real domain math once real fee fields are confirmed", async () => {
    const account = await createTradingAccountForUser(userA.id, "Recon Account FEEMATH", "Manual", "10000", "10000", "PRIVATE");
    const plausibleFee = 0.66;

    await createTransaction(userA.id, account.id, {
      symbol: "APLD 260904P00023500",
      underlyingSymbol: "APLD",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-31T14:02:00Z"),
      price: 0.28,
      fees: plausibleFee,
    });
    await createTransaction(userA.id, account.id, {
      symbol: "RIOT 260904P00017500",
      underlyingSymbol: "RIOT",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-31T14:13:00Z"),
      price: 0.28,
      fees: plausibleFee,
    });
    await createTransaction(userA.id, account.id, {
      symbol: "CORZ 260904P00016500",
      underlyingSymbol: "CORZ",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-24T13:30:00Z"),
      price: 0.26,
      fees: plausibleFee,
    });
    await createTransaction(userA.id, account.id, {
      symbol: "CORZ 260904P00016500",
      underlyingSymbol: "CORZ",
      action: "Buy to Close",
      occurredAt: new Date("2026-08-28T13:32:00Z"),
      price: 0.23,
      fees: plausibleFee,
    });
    await createTransaction(userA.id, account.id, {
      symbol: "CORZ 260918P00018000",
      underlyingSymbol: "CORZ",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-28T13:32:00Z"),
      price: 0.68,
      fees: plausibleFee,
    });

    await reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-08-31T18:00:00Z"));

    const campaigns = await prisma.campaign.findMany({
      where: { ownerId: userA.id, accountId: account.id, ticker: { in: ["APLD", "RIOT", "CORZ"] } },
      include: { events: true },
    });
    expect(campaigns).toHaveLength(3);

    // REGRESSION: each real transaction's own fee must attribute to its own event - the Aug 28
    // BTC's $0.66 fee to ROLL_PUT_CLOSE, and the Aug 28 STO's own $0.66 fee to ROLL_PUT_OPEN -
    // never the whole $1.32 combined onto one event and $0 on the other.
    const corz = campaigns.find((c) => c.ticker === "CORZ")!;
    const rollClose = corz.events.find((e) => e.type === "ROLL_PUT_CLOSE")!;
    const rollOpen = corz.events.find((e) => e.type === "ROLL_PUT_OPEN")!;
    const sellPut = corz.events.find((e) => e.type === "SELL_PUT")!;
    expect(Number(rollClose.fees)).toBe(0.66);
    expect(Number(rollOpen.fees)).toBe(0.66);
    expect(Number(sellPut.fees)).toBe(0.66);
    const corzTotalFees = Number(sellPut.fees) + Number(rollClose.fees) + Number(rollOpen.fees);
    expect(Math.round(corzTotalFees * 100) / 100).toBe(1.98); // total unaffected by the per-event split

    const { summarizeCampaign } = await import("@/domain/finance/campaigns");
    // $26 - $23 + $68 - $1.98 fees = $69.02, computed entirely by the real domain function.
    const corzRealizedPL = summarizeCampaign({ events: corz.events, status: corz.status }).realizedPL ?? 0;
    expect(Math.round(corzRealizedPL * 100) / 100).toBe(69.02);

    const totalNetPL = campaigns.reduce((sum, campaign) => sum + (summarizeCampaign({ events: campaign.events, status: campaign.status }).realizedPL ?? 0), 0);
    // $127 gross - (5 trades x $0.66) = $123.70 net, computed entirely by the real domain
    // function - never hardcoded here or in production code.
    expect(Math.round(totalNetPL * 100) / 100).toBe(123.7);
  });

  it("a second user's identical-looking Schwab activity never affects the first user's campaigns", async () => {
    const accountA = await createTradingAccountForUser(userA.id, "Recon Account ISOREAL A", "Manual", "10000", "10000", "PRIVATE");
    await createTransaction(userA.id, accountA.id, {
      symbol: "ISOR 260904P00020000",
      underlyingSymbol: "ISOR",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-31T14:00:00Z"),
      price: 0.3,
    });

    const accountB = await createTradingAccountForUser(userB.id, "Recon Account ISOREAL B", "Manual", "10000", "10000", "PRIVATE");
    await createTransaction(userB.id, accountB.id, {
      symbol: "ISOR 260904P00020000",
      underlyingSymbol: "ISOR",
      action: "Sell to Open",
      occurredAt: new Date("2026-08-31T14:00:00Z"),
      price: 0.3,
    });

    await reconcileSchwabActivityForUser(userA.id, accountA.id, [], new Date("2026-08-31T18:00:00Z"));
    await reconcileSchwabActivityForUser(userB.id, accountB.id, [], new Date("2026-08-31T18:00:00Z"));

    const campaignsA = await prisma.campaign.findMany({ where: { ownerId: userA.id, ticker: "ISOR" } });
    const campaignsB = await prisma.campaign.findMany({ where: { ownerId: userB.id, ticker: "ISOR" } });
    expect(campaignsA).toHaveLength(1);
    expect(campaignsB).toHaveLength(1);
    expect(campaignsA[0].id).not.toBe(campaignsB[0].id);

    const brokerRecordA = await prisma.brokerRecord.findFirst({ where: { userId: userA.id, symbol: "ISOR 260904P00020000" } });
    const brokerRecordB = await prisma.brokerRecord.findFirst({ where: { userId: userB.id, symbol: "ISOR 260904P00020000" } });
    expect(brokerRecordA?.linkedCampaignId).toBe(campaignsA[0].id);
    expect(brokerRecordB?.linkedCampaignId).toBe(campaignsB[0].id);
  });

  it("full pipeline (real raw Schwab shape -> semantic OPTION selection -> positionEffect normalization -> persist -> reconcile) works identically for a second user with entirely different tickers - proves nothing is Matt/ticker/account-specific", async () => {
    const { SchwabBrokerReadProvider } = await import("@/providers/schwab/broker-read");
    const { normalizeSchwabApiTransaction } = await import("@/providers/schwab/csv");
    const { persistNormalizedBrokerRecordsForUser } = await import("./broker-import");

    const account = await createTradingAccountForUser(userB.id, "Recon Account ERIC", "Manual", "10000", "10000", "PRIVATE");

    // Same real production shape Diagnostic D found for Matt (4 CURRENCY legs then the OPTION
    // leg at index 4, no `instruction` field) - but a different user, different ticker, different
    // account hash entirely, to prove the pipeline hardcodes nothing.
    const rawTransactions = [
      {
        activityId: "eric-nvda-sto",
        netAmount: 45,
        time: "2026-08-31T14:00:00Z",
        type: "TRADE",
        transferItems: [
          { instrument: { symbol: "CURRENCY_USD", assetType: "CURRENCY" }, cost: 0.65, feeType: "COMMISSION" },
          { instrument: { symbol: "CURRENCY_USD", assetType: "CURRENCY" }, amount: 45 },
          { instrument: { symbol: "CURRENCY_USD", assetType: "CURRENCY" }, cost: 0.01, feeType: "REG_FEE" },
          { instrument: { symbol: "CURRENCY_USD", assetType: "CURRENCY" }, amount: 0 },
          {
            positionEffect: "OPENING",
            amount: -1,
            price: 0.45,
            instrument: {
              symbol: "NVDA 260904P00090000",
              assetType: "OPTION",
              type: "VANILLA",
              putCall: "PUT",
              strikePrice: 90,
              underlyingSymbol: "NVDA",
              optionExpirationDate: "2026-09-04",
            },
          },
        ],
      },
    ];

    const provider = new SchwabBrokerReadProvider({
      accessToken: "eric-test-token",
      accountNumbers: [{ accountNumberLast4: "4242", hashValue: "eric-account-hash" }],
      fetchFn: (async () => new Response(JSON.stringify(rawTransactions), { status: 200 })) as unknown as typeof fetch,
    });

    const { transactions } = await provider.getTransactions("eric-account-hash", new Date("2026-08-01"), new Date("2026-09-30"));
    expect(transactions[0]).toMatchObject({ symbol: "NVDA 260904P00090000", action: "Sell to Open", price: 0.45, fees: 0.66 });

    const records = transactions.map((transaction) => normalizeSchwabApiTransaction(transaction));
    await persistNormalizedBrokerRecordsForUser(userB.id, account.id, records);

    const summary = await reconcileSchwabActivityForUser(userB.id, account.id, [], new Date("2026-08-31T18:00:00Z"));
    expect(summary.campaignsOpened).toBe(1);

    const campaign = await prisma.campaign.findFirst({
      where: { ownerId: userB.id, accountId: account.id, ticker: "NVDA" },
      include: { events: true },
    });
    expect(campaign?.status).toBe("OPEN");

    const { summarizeCampaign } = await import("@/domain/finance/campaigns");
    // Gross premium is $45 (0.45 x 1 contract x 100); netOptionPremium is lower because the
    // $0.66 fee summed from the separate cash/fee transfer items is correctly attributed too.
    expect(summarizeCampaign({ events: campaign!.events, status: campaign!.status }).totalPremiumReceived).toBe(45);

    // Matt's own campaigns from the earlier tests in this file must remain completely
    // unaffected by anything computed for this second, entirely independent user/ticker.
    const mattNvdaCampaigns = await prisma.campaign.count({ where: { ownerId: userA.id, ticker: "NVDA" } });
    expect(mattNvdaCampaigns).toBe(0);
  });

  it("REGRESSION - a real expiration-removal transaction (positionEffect=CLOSING on its option leg, exactly like Schwab's real records) must NOT close or win the campaign early - full real-shape pipeline stays OPEN through Labor Day weekend, then correctly expires on the first qualifying NYSE sync", async () => {
    const { SchwabBrokerReadProvider } = await import("@/providers/schwab/broker-read");
    const { normalizeSchwabApiTransaction } = await import("@/providers/schwab/csv");
    const { persistNormalizedBrokerRecordsForUser } = await import("./broker-import");

    const account = await createTradingAccountForUser(userA.id, "Recon Account EXPFIX", "Manual", "10000", "10000", "PRIVATE");

    const stoTransaction = {
      activityId: "expfix-sto",
      netAmount: 28,
      time: "2026-08-31T14:02:00Z",
      type: "TRADE",
      transferItems: [
        { instrument: { symbol: "CURRENCY_USD", assetType: "CURRENCY" }, cost: 0.65, feeType: "COMMISSION" },
        { instrument: { symbol: "CURRENCY_USD", assetType: "CURRENCY" }, amount: 28 },
        { instrument: { symbol: "CURRENCY_USD", assetType: "CURRENCY" }, cost: 0.01, feeType: "REG_FEE" },
        { instrument: { symbol: "CURRENCY_USD", assetType: "CURRENCY" }, amount: 0 },
        {
          positionEffect: "OPENING",
          amount: -1,
          price: 0.28,
          instrument: {
            symbol: "EXPX 260904P00023500",
            assetType: "OPTION",
            type: "VANILLA",
            putCall: "PUT",
            strikePrice: 23.5,
            underlyingSymbol: "EXPX",
            optionExpirationDate: "2026-09-04",
          },
        },
      ],
    };
    // The exact real shape that caused the bug: the option leg ALSO administratively closes on
    // Schwab's books (positionEffect=CLOSING, a real nonzero amount), even though this is only
    // expiration/removal evidence, not a genuine buy-back.
    const removalTransaction = {
      activityId: "expfix-removed",
      netAmount: 0,
      time: "2026-09-04T21:00:00Z",
      type: "RECEIVE_AND_DELIVER",
      description: "Removed due to Expiration PUT EXPX CORP $23.5 EXP 09/04/26",
      transferItems: [
        {
          positionEffect: "CLOSING",
          amount: 1,
          price: 0,
          instrument: {
            symbol: "EXPX 260904P00023500",
            assetType: "OPTION",
            type: "VANILLA",
            putCall: "PUT",
            strikePrice: 23.5,
            underlyingSymbol: "EXPX",
            optionExpirationDate: "2026-09-04",
          },
        },
      ],
    };

    const provider = new SchwabBrokerReadProvider({
      accessToken: "expfix-token",
      accountNumbers: [{ accountNumberLast4: "1111", hashValue: "expfix-hash" }],
      fetchFn: (async (input: URL | string) => {
        const url = new URL(input.toString());
        const types = url.searchParams.get("types");
        if (types === "TRADE") {
          return new Response(JSON.stringify([stoTransaction]), { status: 200 });
        }
        if (types === "RECEIVE_AND_DELIVER") {
          return new Response(JSON.stringify([removalTransaction]), { status: 200 });
        }
        return new Response("[]", { status: 200 });
      }) as unknown as typeof fetch,
    });

    const { transactions } = await provider.getTransactions("expfix-hash", new Date("2026-08-01"), new Date("2026-09-30"));
    const removalRecord = transactions.find((t) => t.id === "expfix-removed");
    expect(removalRecord?.action).toBe("Removed - Expiration");
    expect(removalRecord?.action).not.toBe("Buy to Close");

    const records = transactions.map((transaction) => normalizeSchwabApiTransaction(transaction));
    await persistNormalizedBrokerRecordsForUser(userA.id, account.id, records);

    // Saturday sync (before the Sep 8 NYSE confirmation window) - must NOT close or expire.
    const saturday = await reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-09-05T18:00:00Z"));
    expect(saturday.campaignsOpened).toBe(1);
    expect(saturday.campaignsClosed).toBe(0);
    expect(saturday.campaignsExpired).toBe(0);

    const campaignBefore = await prisma.campaign.findFirst({ where: { ownerId: userA.id, accountId: account.id, ticker: "EXPX" } });
    expect(campaignBefore?.status).toBe("OPEN");

    // Monday Sep 7 is Labor Day - still must not confirm.
    const laborDay = await reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-09-07T18:00:00Z"));
    expect(laborDay.campaignsClosed).toBe(0);
    expect(laborDay.campaignsExpired).toBe(0);

    // Tuesday Sep 8 (the first NYSE market day after the Labor Day weekend) - now safe to
    // confirm expired worthless, via PUT_EXPIRED, never via the CLOSE path.
    const tuesday = await reconcileSchwabActivityForUser(userA.id, account.id, [], new Date("2026-09-08T18:00:00Z"));
    expect(tuesday.campaignsClosed).toBe(0);
    expect(tuesday.campaignsExpired).toBe(1);

    const campaignAfter = await prisma.campaign.findFirst({
      where: { ownerId: userA.id, accountId: account.id, ticker: "EXPX" },
      include: { events: true },
    });
    expect(campaignAfter?.status).toBe("CLOSED");
    expect(campaignAfter?.events.map((event) => event.type).sort()).toEqual(["PUT_EXPIRED", "SELL_PUT"].sort());
    expect(campaignAfter?.events.some((event) => event.type === "CLOSE_PUT")).toBe(false);

    // The genuine removal record has fees: null (Schwab reported none) - it must never poison
    // this campaign's fee-known status, because it's non-economic evidence and (correctly)
    // never gets linked to the campaign at all - only the real STO's known $0.66 fee is linked.
    const unknownFeeCampaigns = await getCampaignIdsWithUnknownFees([campaignAfter!.id]);
    expect(unknownFeeCampaigns.has(campaignAfter!.id)).toBe(false);
    const removalRow = await prisma.brokerRecord.findFirst({ where: { userId: userA.id, accountId: account.id, action: "Removed - Expiration" } });
    expect(removalRow?.linkedCampaignId).toBeNull();
    expect(removalRow?.fees).toBeNull();

    await prisma.brokerRecord.deleteMany({ where: { accountId: account.id } });
  });
});
