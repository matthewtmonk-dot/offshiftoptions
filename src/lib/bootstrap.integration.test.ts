import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRODUCTION_USERS, runProductionBootstrap, type BootstrapUserSpec } from "./bootstrap";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

maybeDescribe("production bootstrap", () => {
  let prisma: typeof import("./prisma").prisma;
  const suffix = Date.now();
  const userA: BootstrapUserSpec = { name: "Bootstrap Test A", email: `bootstrap-a-${suffix}@lst.local` };
  const userB: BootstrapUserSpec = { name: "Bootstrap Test B", email: `bootstrap-b-${suffix}@lst.local` };
  const createdUserIds: string[] = [];
  let createdConversationId: string | null = null;

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
  });

  afterAll(async () => {
    if (createdConversationId) {
      await prisma.conversation.deleteMany({ where: { id: createdConversationId } });
    }
    if (createdUserIds.length) {
      // Cascades delete any watchlists/items/conversation memberships created for these test users.
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await prisma.$disconnect();
  });

  it("defaults to the real Phase 1 production emails", () => {
    expect(PRODUCTION_USERS.map((user) => user.email)).toEqual(["matt@lst.local", "eric@lst.local"]);
  });

  it("creates both users and a shared conversation on the first run", async () => {
    const summary = await runProductionBootstrap(prisma, {
      users: [userA, userB],
      password: "first-run-password",
    });

    expect(summary.users[0].created).toBe(true);
    expect(summary.users[1].created).toBe(true);
    expect(summary.conversationCreated).toBe(true);

    createdUserIds.push(summary.users[0].userId, summary.users[1].userId);
    createdConversationId = summary.conversationId;

    const [dbUserA, dbUserB] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { email: userA.email } }),
      prisma.user.findUniqueOrThrow({ where: { email: userB.email } }),
    ]);
    expect(dbUserA.name).toBe(userA.name);
    expect(dbUserB.name).toBe(userB.name);

    const memberCount = await prisma.conversationMember.count({
      where: { conversationId: summary.conversationId },
    });
    expect(memberCount).toBe(2);
  });

  it("does not duplicate users or the conversation, and does not change the existing password, on a second run", async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { email: userA.email } });

    const summary = await runProductionBootstrap(prisma, {
      users: [userA, userB],
      password: "second-run-different-password",
    });

    expect(summary.users[0].created).toBe(false);
    expect(summary.users[1].created).toBe(false);
    expect(summary.conversationCreated).toBe(false);
    expect(summary.conversationId).toBe(createdConversationId);

    const after = await prisma.user.findUniqueOrThrow({ where: { email: userA.email } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.name).toBe(before.name);

    const userCount = await prisma.user.count({ where: { email: { in: [userA.email, userB.email] } } });
    expect(userCount).toBe(2);

    const conversationCount = await prisma.conversation.count({
      where: {
        AND: [
          { members: { some: { userId: summary.users[0].userId } } },
          { members: { some: { userId: summary.users[1].userId } } },
        ],
      },
    });
    expect(conversationCount).toBe(1);
  });

  it("does not delete unrelated existing data on a repeat run", async () => {
    const watchlist = await prisma.watchlist.create({
      data: { ownerId: createdUserIds[0], name: "Bootstrap Test Watchlist", visibility: "PRIVATE" },
    });
    const item = await prisma.watchlistItem.create({
      data: {
        watchlistId: watchlist.id,
        ownerId: createdUserIds[0],
        ticker: "TSTB",
        status: "WATCHING",
        visibility: "PRIVATE",
      },
    });

    await runProductionBootstrap(prisma, { users: [userA, userB], password: "third-run-password" });

    const stillThere = await prisma.watchlistItem.findUnique({ where: { id: item.id } });
    expect(stillThere).not.toBeNull();
    expect(stillThere?.ticker).toBe("TSTB");
  });
});
