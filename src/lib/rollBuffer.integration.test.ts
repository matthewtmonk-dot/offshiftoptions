import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ValidationError } from "./tickers";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

maybeDescribe("Roll Buffer % preference persistence and isolation", () => {
  let prisma: typeof import("./prisma").prisma;
  let updateRollBufferPercentForUser: typeof import("./workflows").updateRollBufferPercentForUser;
  let userA: { id: string };
  let userB: { id: string };
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    updateRollBufferPercentForUser = (await import("./workflows")).updateRollBufferPercentForUser;

    const passwordHash = await hash("not-used", 4);
    const timestamp = Date.now();
    userA = await prisma.user.create({
      data: { name: "Roll Buffer User A", email: `roll-buffer-a-${timestamp}@lst.local`, passwordHash, settings: { create: {} } },
      select: { id: true },
    });
    userB = await prisma.user.create({
      data: { name: "Roll Buffer User B", email: `roll-buffer-b-${timestamp}@lst.local`, passwordHash, settings: { create: {} } },
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

  it("defaults a freshly-created user's settings to 3.0%", async () => {
    const settings = await prisma.userSettings.findUniqueOrThrow({ where: { userId: userA.id } });
    expect(Number(settings.rollBufferPercent)).toBe(3);
  });

  it("persists a chosen Roll Buffer to the database", async () => {
    await updateRollBufferPercentForUser(userA.id, 4.5);

    const settings = await prisma.userSettings.findUniqueOrThrow({ where: { userId: userA.id } });
    expect(Number(settings.rollBufferPercent)).toBe(4.5);
  });

  it("does not let changing User A's Roll Buffer affect User B's - Matt and Eric may choose different thresholds", async () => {
    await updateRollBufferPercentForUser(userA.id, 5);

    const settingsA = await prisma.userSettings.findUniqueOrThrow({ where: { userId: userA.id } });
    const settingsB = await prisma.userSettings.findUniqueOrThrow({ where: { userId: userB.id } });
    expect(Number(settingsA.rollBufferPercent)).toBe(5);
    expect(Number(settingsB.rollBufferPercent)).toBe(3);
  });

  it("upserts settings for a user who has none yet", async () => {
    const passwordHash = await hash("not-used", 4);
    const userC = await prisma.user.create({
      data: { name: "Roll Buffer User C", email: `roll-buffer-c-${Date.now()}@lst.local`, passwordHash },
      select: { id: true },
    });
    userIds.push(userC.id);

    await updateRollBufferPercentForUser(userC.id, 2.5);

    const settings = await prisma.userSettings.findUniqueOrThrow({ where: { userId: userC.id } });
    expect(Number(settings.rollBufferPercent)).toBe(2.5);
  });

  it("rejects an out-of-range value and leaves the stored preference unchanged", async () => {
    await updateRollBufferPercentForUser(userA.id, 5);
    await expect(updateRollBufferPercentForUser(userA.id, 0)).rejects.toThrow(ValidationError);
    await expect(updateRollBufferPercentForUser(userA.id, 100)).rejects.toThrow(ValidationError);
    await expect(updateRollBufferPercentForUser(userA.id, Number.NaN)).rejects.toThrow(ValidationError);

    const settings = await prisma.userSettings.findUniqueOrThrow({ where: { userId: userA.id } });
    expect(Number(settings.rollBufferPercent)).toBe(5);
  });
});
