import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hash } from "bcryptjs";
import { AuthorizationError } from "./privacy";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

maybeDescribe("Research (Watchlist->Research) privacy, isolation, and personal-rule fields", () => {
  let prisma: typeof import("./prisma").prisma;
  let workflows: typeof import("./workflows");
  let userA: { id: string };
  let userB: { id: string };
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    workflows = await import("./workflows");

    const passwordHash = await hash("not-used", 4);
    const timestamp = Date.now();
    userA = await prisma.user.create({
      data: { name: "Research User A", email: `research-a-${timestamp}@lst.local`, passwordHash },
      select: { id: true },
    });
    userB = await prisma.user.create({
      data: { name: "Research User B", email: `research-b-${timestamp}@lst.local`, passwordHash },
      select: { id: true },
    });
    userIds.push(userA.id, userB.id);
  });

  afterAll(async () => {
    await prisma.watchlistItem.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.watchlist.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("creates a new research item PRIVATE by default with no legacy 'watchlist' visibility leak", async () => {
    const item = await workflows.setResearchStatusForUser(userA.id, "ZZZA", "WATCH");
    expect(item.visibility).toBe("PRIVATE");
    expect(item.researchStatus).toBe("WATCH");
  });

  it("does not let User B read User A's private research item", async () => {
    const item = await workflows.setResearchStatusForUser(userA.id, "ZZZB", "LIKE");
    await expect(workflows.getReadableWatchlistItemForUser(userB.id, item.id)).rejects.toThrow(AuthorizationError);
    // Reading your own item always works regardless of visibility.
    await expect(workflows.getReadableWatchlistItemForUser(userA.id, item.id)).resolves.toMatchObject({ id: item.id });
  });

  it("does not let User B mutate (status, details, or removal) User A's research item", async () => {
    const item = await workflows.setResearchStatusForUser(userA.id, "ZZZC", "WATCH");

    const formData = new FormData();
    formData.set("companyName", "Should not apply");
    await expect(workflows.updateResearchDetailsForUser(userB.id, item.id, formData)).rejects.toThrow(AuthorizationError);
    await expect(workflows.toggleWatchlistItemVisibilityForUser(userB.id, item.id)).rejects.toThrow(AuthorizationError);

    const untouched = await prisma.watchlistItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(untouched.companyName).toBeNull();

    await expect(workflows.removeWatchlistItemForUser(userB.id, item.id)).rejects.toThrow(AuthorizationError);
    await expect(prisma.watchlistItem.findUnique({ where: { id: item.id } })).resolves.not.toBeNull();
  });

  it("lets User B LIKE a ticker that User A has marked NEVER_TRADE, with zero interference", async () => {
    await workflows.setResearchStatusForUser(userA.id, "ZZZD", "NEVER_TRADE");
    const bItem = await workflows.setResearchStatusForUser(userB.id, "ZZZD", "LIKE");

    expect(bItem.researchStatus).toBe("LIKE");
    const aItem = await prisma.watchlistItem.findFirst({ where: { ownerId: userA.id, ticker: "ZZZD" } });
    expect(aItem?.researchStatus).toBe("NEVER_TRADE");
  });

  it("preserves disagreement instead of merging - both users' own view of the same ticker stay independent", async () => {
    await workflows.setResearchStatusForUser(userA.id, "ZZZE", "LIKE");
    await workflows.setResearchStatusForUser(userB.id, "ZZZE", "NEVER_TRADE");

    const rows = await prisma.watchlistItem.findMany({ where: { ticker: "ZZZE", ownerId: { in: userIds } } });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.ownerId === userA.id)?.researchStatus).toBe("LIKE");
    expect(rows.find((row) => row.ownerId === userB.id)?.researchStatus).toBe("NEVER_TRADE");
  });

  it("an exclusion can be undone (status change), never a hard delete of the research history", async () => {
    const excluded = await workflows.setResearchStatusForUser(userA.id, "ZZZF", "NEVER_TRADE");
    const restored = await workflows.setResearchStatusForUser(userA.id, "ZZZF", "NEUTRAL");
    expect(restored.id).toBe(excluded.id);
    expect(restored.researchStatus).toBe("NEUTRAL");
  });

  it("persists would-own/monthly-only/roll-friendliness/manual grade fields exactly as entered", async () => {
    const item = await workflows.setResearchStatusForUser(userA.id, "ZZZG", "LIKE");
    const formData = new FormData();
    formData.set("companyName", "Zzz Corp");
    formData.set("whatItDoes", "Makes widgets.");
    formData.set("wouldOwn", "CONDITIONAL");
    formData.set("wouldOwnMaxPrice", "42.50");
    formData.set("monthlyPutsOnly", "on");
    formData.set("rollFriendliness", "DIFFICULT");
    formData.set("rollFriendlinessNote", "Wide spreads on rolls.");
    formData.set("manualSchwabGrade", "B");
    formData.set("manualLsegRating", "Buy");
    formData.set("manualLsegScore", "7.2");
    formData.set("manualLsegTarget", "50");

    const updated = await workflows.updateResearchDetailsForUser(userA.id, item.id, formData);
    expect(updated).toMatchObject({
      companyName: "Zzz Corp",
      whatItDoes: "Makes widgets.",
      wouldOwn: "CONDITIONAL",
      monthlyPutsOnly: true,
      rollFriendliness: "DIFFICULT",
      rollFriendlinessNote: "Wide spreads on rolls.",
      manualSchwabGrade: "B",
      manualLsegRating: "Buy",
      manualLsegScore: "7.2",
      manualLsegTarget: "50",
    });
    expect(Number(updated?.wouldOwnMaxPrice)).toBe(42.5);
  });

  it("clears wouldOwnMaxPrice when wouldOwn is not CONDITIONAL, rather than leaving a stale price", async () => {
    const item = await workflows.setResearchStatusForUser(userA.id, "ZZZH", "LIKE");
    const first = new FormData();
    first.set("wouldOwn", "CONDITIONAL");
    first.set("wouldOwnMaxPrice", "20");
    await workflows.updateResearchDetailsForUser(userA.id, item.id, first);

    const second = new FormData();
    second.set("wouldOwn", "YES");
    const updated = await workflows.updateResearchDetailsForUser(userA.id, item.id, second);
    expect(updated?.wouldOwnMaxPrice).toBeNull();
  });

  it("a quick status change never wipes previously-saved research details", async () => {
    const item = await workflows.setResearchStatusForUser(userA.id, "ZZZI", "LIKE");
    const formData = new FormData();
    formData.set("companyName", "Should survive");
    await workflows.updateResearchDetailsForUser(userA.id, item.id, formData);

    const restatused = await workflows.setResearchStatusForUser(userA.id, "ZZZI", "AVOID");
    expect(restatused.researchStatus).toBe("AVOID");
    expect(restatused.companyName).toBe("Should survive");
  });

  it("includes LIKE/WATCH/NEUTRAL research tickers in the scanner universe union, but excludes AVOID/NEVER_TRADE", async () => {
    await workflows.setResearchStatusForUser(userA.id, "ZZZLIKE", "LIKE");
    await workflows.setResearchStatusForUser(userA.id, "ZZZWATCH", "WATCH");
    await workflows.setResearchStatusForUser(userA.id, "ZZZNEUTRAL", "NEUTRAL");
    await workflows.setResearchStatusForUser(userA.id, "ZZZAVOID", "AVOID");
    await workflows.setResearchStatusForUser(userA.id, "ZZZNEVER", "NEVER_TRADE");

    const universe = await workflows.getResearchUniverseTickersForUser(userA.id);
    expect(universe).toEqual(expect.arrayContaining(["ZZZLIKE", "ZZZWATCH", "ZZZNEUTRAL"]));
    expect(universe).not.toContain("ZZZAVOID");
    expect(universe).not.toContain("ZZZNEVER");
  });

  it("rejects an invalid research status rather than silently accepting it", async () => {
    await expect(workflows.setResearchStatusForUser(userA.id, "ZZZJ", "BOGUS")).rejects.toThrow("Invalid research status");
  });
});
