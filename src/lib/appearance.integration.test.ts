import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// updateAppearanceForUser also syncs a non-sensitive cookie for logged-out rendering, which
// requires Next's request-scoped `cookies()`. Outside an actual request (as here) that throws,
// so it's stubbed for this test - the DB write under test doesn't depend on it.
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    set: () => {},
  }),
}));

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

maybeDescribe("appearance preference persistence and isolation", () => {
  let prisma: typeof import("./prisma").prisma;
  let updateAppearanceForUser: typeof import("./appearance").updateAppearanceForUser;
  let userA: { id: string };
  let userB: { id: string };
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    updateAppearanceForUser = (await import("./appearance")).updateAppearanceForUser;

    const passwordHash = await hash("not-used", 4);
    const timestamp = Date.now();
    userA = await prisma.user.create({
      data: {
        name: "Appearance User A",
        email: `appearance-a-${timestamp}@lst.local`,
        passwordHash,
        settings: { create: {} },
      },
      select: { id: true },
    });
    userB = await prisma.user.create({
      data: {
        name: "Appearance User B",
        email: `appearance-b-${timestamp}@lst.local`,
        passwordHash,
        settings: { create: {} },
      },
      select: { id: true },
    });
    userIds.push(userA.id, userB.id);
  });

  afterAll(async () => {
    if (userIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await prisma.$disconnect();
  });

  it("defaults a freshly-created user's settings to SYSTEM", async () => {
    const settings = await prisma.userSettings.findUniqueOrThrow({ where: { userId: userA.id } });
    expect(settings.appearance).toBe("SYSTEM");
  });

  it("persists a chosen appearance to the database", async () => {
    await updateAppearanceForUser(userA.id, "DARK");

    const settings = await prisma.userSettings.findUniqueOrThrow({ where: { userId: userA.id } });
    expect(settings.appearance).toBe("DARK");
  });

  it("does not let changing User A's appearance affect User B's", async () => {
    await updateAppearanceForUser(userA.id, "LIGHT");

    const settingsA = await prisma.userSettings.findUniqueOrThrow({ where: { userId: userA.id } });
    const settingsB = await prisma.userSettings.findUniqueOrThrow({ where: { userId: userB.id } });
    expect(settingsA.appearance).toBe("LIGHT");
    expect(settingsB.appearance).toBe("SYSTEM");
  });

  it("upserts settings for a user who has none yet", async () => {
    const passwordHash = await hash("not-used", 4);
    const userC = await prisma.user.create({
      data: { name: "Appearance User C", email: `appearance-c-${Date.now()}@lst.local`, passwordHash },
      select: { id: true },
    });
    userIds.push(userC.id);

    await updateAppearanceForUser(userC.id, "DARK");

    const settings = await prisma.userSettings.findUniqueOrThrow({ where: { userId: userC.id } });
    expect(settings.appearance).toBe("DARK");
  });
});
