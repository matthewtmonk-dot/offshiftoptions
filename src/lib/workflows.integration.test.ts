import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hash } from "bcryptjs";
import { summarizeCampaign } from "@/domain/finance/campaigns";
import { SCANNER_RULE_DEFINITIONS } from "@/domain/scanner/profile";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

maybeDescribe("database-backed Phase 1B workflows", () => {
  let prisma: typeof import("./prisma").prisma;
  let workflows: typeof import("./workflows");
  let matt: { id: string };
  let eric: { id: string };
  let rogueUserId: string | null = null;
  const createdWatchlistItems: string[] = [];
  const createdRecommendations: string[] = [];
  const createdNotifications: string[] = [];
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
    await prisma.notification.deleteMany({ where: { id: { in: createdNotifications } } });
    await prisma.recommendation.deleteMany({ where: { id: { in: createdRecommendations } } });
    await prisma.watchlistItem.deleteMany({ where: { id: { in: createdWatchlistItems } } });
    if (rogueUserId) {
      await prisma.user.deleteMany({ where: { id: rogueUserId } });
    }
    await prisma.$disconnect();
  });

  it("blocks direct read and mutation of another user's private watchlist item", async () => {
    const item = await workflows.createWatchlistItemForUser(matt.id, "TST1");
    createdWatchlistItems.push(item.id);
    await prisma.watchlistItem.update({ where: { id: item.id }, data: { visibility: "PRIVATE" } });

    await expect(workflows.getReadableWatchlistItemForUser(eric.id, item.id)).rejects.toThrow("not allowed");
    await expect(workflows.removeWatchlistItemForUser(eric.id, item.id)).rejects.toThrow("not allowed");

    const stillThere = await prisma.watchlistItem.findUnique({ where: { id: item.id } });
    expect(stillThere?.ownerId).toBe(matt.id);
  });

  it("allows shared watchlist read without allowing buddy mutation", async () => {
    const item = await workflows.createWatchlistItemForUser(matt.id, "TST2");
    createdWatchlistItems.push(item.id);
    await prisma.watchlistItem.update({ where: { id: item.id }, data: { visibility: "SHARED" } });

    await expect(workflows.getReadableWatchlistItemForUser(eric.id, item.id)).resolves.toMatchObject({ id: item.id });
    await expect(workflows.removeWatchlistItemForUser(eric.id, item.id)).rejects.toThrow("not allowed");
  });

  it("creates manual accounts and campaign entries with scanner snapshots", async () => {
    const account = await workflows.createTradingAccountForUser(
      matt.id,
      `Integration Account ${Date.now()}`,
      "Paper",
      "10000",
      "10050",
      "SHARED",
    );
    createdAccounts.push(account.id);

    const campaign = await workflows.createCampaignForUser(
      matt.id,
      account.id,
      "IONQ",
      "2026-08-28",
      "2026-09-18",
      "27",
      "1",
      "0.32",
      "0",
      "Integration campaign",
      "INHERIT",
    );
    createdCampaigns.push(campaign.id);

    expect(campaign).toMatchObject({ ownerId: matt.id, accountId: account.id, ticker: "IONQ", visibility: "INHERIT" });
    expect(campaign.events).toHaveLength(1);
    expect(campaign.events[0]).toMatchObject({ type: "SELL_PUT", contracts: 1 });
    expect(campaign.entrySnapshotJson).toMatchObject({ profileName: "My LST", scannerStatus: expect.any(String) });
  });

  it("enforces inherited, explicit shared, and explicit private campaign visibility", async () => {
    const account = await workflows.createTradingAccountForUser(
      matt.id,
      `Private Parent ${Date.now()}`,
      "Manual",
      "5000",
      "5000",
      "PRIVATE",
    );
    createdAccounts.push(account.id);

    const campaign = await workflows.createCampaignForUser(
      matt.id,
      account.id,
      "HOOD",
      "2026-08-28",
      "2026-09-18",
      "34",
      "1",
      "0.46",
      "0",
      "Visibility integration campaign",
      "INHERIT",
    );
    createdCampaigns.push(campaign.id);

    await expect(workflows.getReadableCampaignForUser(matt.id, campaign.id)).resolves.toMatchObject({ id: campaign.id });
    await expect(workflows.getReadableCampaignForUser(eric.id, campaign.id)).rejects.toThrow("not allowed");

    await prisma.campaign.update({ where: { id: campaign.id }, data: { visibility: "SHARED" } });
    await expect(workflows.getReadableCampaignForUser(eric.id, campaign.id)).resolves.toMatchObject({ id: campaign.id });

    await prisma.tradingAccount.update({ where: { id: account.id }, data: { visibility: "SHARED" } });
    await prisma.campaign.update({ where: { id: campaign.id }, data: { visibility: "PRIVATE" } });
    await expect(workflows.getReadableCampaignForUser(eric.id, campaign.id)).rejects.toThrow("not allowed");
  });

  it("blocks buddy campaign mutation and preserves both roll legs", async () => {
    const account = await workflows.createTradingAccountForUser(
      matt.id,
      `Roll Account ${Date.now()}`,
      "Manual",
      "7000",
      "7000",
      "SHARED",
    );
    createdAccounts.push(account.id);
    const campaign = await workflows.createCampaignForUser(
      matt.id,
      account.id,
      "AAP",
      "2026-08-21",
      "2026-09-04",
      "40",
      "1",
      "0.48",
      "0",
      "Roll integration campaign",
      "INHERIT",
    );
    createdCampaigns.push(campaign.id);

    await expect(
      workflows.rollCampaignPutForUser(eric.id, campaign.id, "2026-08-28", "0.71", "2026-09-11", "39", "1.02", "0", "Nope"),
    ).rejects.toThrow("not allowed");

    await workflows.rollCampaignPutForUser(
      matt.id,
      campaign.id,
      "2026-08-28",
      "0.71",
      "2026-09-11",
      "39",
      "1.02",
      "0",
      "Good roll",
    );

    const stored = await prisma.campaign.findUniqueOrThrow({
      where: { id: campaign.id },
      include: { events: { orderBy: [{ occurredAt: "asc" }, { sortOrder: "asc" }] } },
    });
    expect(stored.events.map((event) => event.type)).toEqual(["SELL_PUT", "ROLL_PUT_CLOSE", "ROLL_PUT_OPEN"]);
    expect(stored.events[1].groupKey).toBe(stored.events[2].groupKey);
    const summary = summarizeCampaign({ status: stored.status, events: stored.events });
    expect(summary.netRollPremium).toBe(31);
  });

  it("keeps every event of a full open->roll->close lifecycle - the append-only guarantee Research work depends on", async () => {
    // STO PUT, BTC PUT, STO NEW PUT, BTC NEW PUT: sell, roll (close+open), then close the
    // rolled-to put. All four events must remain queryable afterward - none overwritten or
    // deleted - proving CampaignEvent is a true append-only history before building Research
    // on top of it. See PROJECT_HANDOFF.md Research section.
    const account = await workflows.createTradingAccountForUser(
      matt.id,
      `Append-Only Account ${Date.now()}`,
      "Manual",
      "6000",
      "6000",
      "PRIVATE",
    );
    createdAccounts.push(account.id);
    const campaign = await workflows.createCampaignForUser(
      matt.id,
      account.id,
      "SOFI",
      "2026-08-05",
      "2026-08-14",
      "18",
      "1",
      "0.36",
      "0",
      "Append-only lifecycle test",
      "PRIVATE",
    );
    createdCampaigns.push(campaign.id);

    await workflows.rollCampaignPutForUser(matt.id, campaign.id, "2026-08-12", "0.52", "2026-08-21", "17.5", "0.88", "0", "Roll 1");

    const midRoll = await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id }, include: { events: true } });
    await workflows.closeCampaignPutForUser(matt.id, campaign.id, "2026-08-21", "0.21", "0", "Close the rolled-to put");

    const final = await prisma.campaign.findUniqueOrThrow({
      where: { id: campaign.id },
      include: { events: { orderBy: [{ occurredAt: "asc" }, { sortOrder: "asc" }] } },
    });

    expect(final.events.map((event) => event.type)).toEqual(["SELL_PUT", "ROLL_PUT_CLOSE", "ROLL_PUT_OPEN", "CLOSE_PUT"]);
    // Every event ID present after the roll is still present, unmodified, after the close -
    // the close only appended a new row, it never touched the prior three.
    for (const event of midRoll.events) {
      const stillThere = final.events.find((candidate) => candidate.id === event.id);
      expect(stillThere).toMatchObject({ type: event.type, premium: event.premium, strike: event.strike });
    }
    expect(final.status).toBe("CLOSED");
  });

  it("records assignment without closing the campaign result prematurely", async () => {
    const account = await workflows.createTradingAccountForUser(
      matt.id,
      `Assignment Account ${Date.now()}`,
      "Manual",
      "9000",
      "9000",
      "SHARED",
    );
    createdAccounts.push(account.id);
    const campaign = await workflows.createCampaignForUser(
      matt.id,
      account.id,
      "F",
      "2026-08-01",
      "2026-08-28",
      "11.5",
      "1",
      "0.22",
      "0",
      "Assignment integration campaign",
      "INHERIT",
    );
    createdCampaigns.push(campaign.id);

    const assigned = await workflows.assignCampaignPutForUser(matt.id, campaign.id, "2026-08-28", "", "0", "Assigned");
    expect(assigned).toMatchObject({ status: "ASSIGNED", strategy: "WHEEL" });
    expect(assigned?.events.map((event) => event.type)).toContain("ASSIGNMENT");

    const summary = summarizeCampaign({ status: assigned?.status ?? "ASSIGNED", events: assigned?.events ?? [] });
    expect(summary.sharesHeld).toBe(100);
    expect(summary.adjustedBasis).toBe(11.28);
    expect(summary.totalCampaignPL).toBeNull();
  });

  it("creates recommendation notifications and protects recipient-owned status", async () => {
    const before = await prisma.notification.count({ where: { recipientId: eric.id, readAt: null } });
    const recommendation = await workflows.createRecommendationForUser(
      matt.id,
      "CORZ",
      eric.id,
      "DB integration recommendation",
      ["Scanner looks good", "RSI"],
    );
    createdRecommendations.push(recommendation.id);

    const after = await prisma.notification.count({ where: { recipientId: eric.id, readAt: null } });
    expect(after).toBe(before + 1);

    await expect(
      workflows.updateRecommendationStatusForUser(matt.id, recommendation.id, "PASSED"),
    ).rejects.toThrow("not allowed");
    await expect(
      workflows.updateRecommendationStatusForUser(eric.id, recommendation.id, "PASSED"),
    ).resolves.toMatchObject({ status: "PASSED" });
  });

  it("protects chat membership and creates message notifications for members", async () => {
    const passwordHash = await hash("not-used", 4);
    const rogue = await prisma.user.create({
      data: {
        name: "Rogue Test User",
        email: `rogue-${Date.now()}@lst.local`,
        passwordHash,
      },
      select: { id: true },
    });
    rogueUserId = rogue.id;
    const conversation = await prisma.conversation.findFirstOrThrow({
      where: { members: { some: { userId: matt.id } } },
      select: { id: true },
    });

    await expect(
      workflows.sendChatMessageForUser(rogue.id, conversation.id, "Should not send"),
    ).rejects.toThrow("not a member");

    const before = await prisma.notification.count({ where: { recipientId: eric.id, readAt: null } });
    await expect(
      workflows.sendChatMessageForUser(matt.id, conversation.id, "DB integration chat message", "CORZ"),
    ).resolves.toMatchObject({ senderId: matt.id, ticker: "CORZ" });
    const after = await prisma.notification.count({ where: { recipientId: eric.id, readAt: null } });
    expect(after).toBe(before + 1);
  });

  it("scopes notification read updates to the recipient", async () => {
    const notification = await prisma.notification.create({
      data: {
        recipientId: matt.id,
        actorId: eric.id,
        type: "SYSTEM",
        title: "Integration notification",
        body: "Ownership test",
      },
    });
    createdNotifications.push(notification.id);

    await expect(workflows.markNotificationReadForUser(eric.id, notification.id)).resolves.toMatchObject({ count: 0 });
    await expect(workflows.markNotificationReadForUser(matt.id, notification.id)).resolves.toMatchObject({ count: 1 });
  });

  it("updates My LST scanner settings for one user without changing the buddy profile", async () => {
    const formData = new FormData();
    for (const definition of SCANNER_RULE_DEFINITIONS) {
      formData.set(`${definition.key}:enabled`, "on");
      if (Array.isArray(definition.defaultDesired)) {
        const [min, max] = definition.defaultDesired;
        formData.set(`${definition.key}:min`, String(definition.key === "price" ? 12 : min));
        formData.set(`${definition.key}:max`, String(definition.key === "price" ? 60 : max));
      } else if (definition.input.kind === "single") {
        formData.set(`${definition.key}:value`, String(definition.defaultDesired));
      }
    }

    await workflows.updateScannerSettingsForUser(matt.id, formData);
    const [mattPriceRule, ericPriceRule] = await Promise.all([
      prisma.scannerRule.findFirstOrThrow({
        where: { profile: { ownerId: matt.id, name: "My LST" }, key: "price" },
      }),
      prisma.scannerRule.findFirstOrThrow({
        where: { profile: { ownerId: eric.id, name: "My LST" }, key: "price" },
      }),
    ]);

    expect(mattPriceRule.valueJson).toMatchObject({ desired: [12, 60] });
    // LST Core default price band is $10-$50 - see src/domain/scanner/profile.ts.
    expect(ericPriceRule.valueJson).toMatchObject({ desired: [10, 50] });
  });
});
