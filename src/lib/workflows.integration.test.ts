import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hash } from "bcryptjs";
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

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    workflows = await import("./workflows");
    matt = await prisma.user.findUniqueOrThrow({ where: { email: "matt@lst.local" }, select: { id: true } });
    eric = await prisma.user.findUniqueOrThrow({ where: { email: "eric@lst.local" }, select: { id: true } });
  });

  afterAll(async () => {
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
    expect(ericPriceRule.valueJson).toMatchObject({ desired: [10, 80] });
  });
});
