import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hash, compare } from "bcryptjs";
import { changePasswordForUser } from "./account";
import { ValidationError } from "./tickers";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

maybeDescribe("changePasswordForUser", () => {
  let prisma: typeof import("./prisma").prisma;
  const email = `account-test-${Date.now()}@lst.local`;
  const originalPassword = "OriginalPass1";
  let userId: string;
  let keptSessionTokenHash: string;
  let otherSessionTokenHash: string;

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    const passwordHash = await hash(originalPassword, 10);
    const user = await prisma.user.create({
      data: { name: "Account Test User", email, passwordHash },
    });
    userId = user.id;

    keptSessionTokenHash = "kept-session-hash";
    otherSessionTokenHash = "other-session-hash";
    await prisma.session.createMany({
      data: [
        { userId, tokenHash: keptSessionTokenHash, expiresAt: new Date(Date.now() + 86_400_000) },
        { userId, tokenHash: otherSessionTokenHash, expiresAt: new Date(Date.now() + 86_400_000) },
      ],
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("rejects an incorrect current password without changing anything", async () => {
    await expect(
      changePasswordForUser(userId, "wrong-password", "NewPassword1", "NewPassword1", keptSessionTokenHash),
    ).rejects.toThrow(ValidationError);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(await compare(originalPassword, user.passwordHash)).toBe(true);

    const sessionCount = await prisma.session.count({ where: { userId } });
    expect(sessionCount).toBe(2);
  });

  it("rejects a mismatched confirmation", async () => {
    await expect(
      changePasswordForUser(userId, originalPassword, "NewPassword1", "DoesNotMatch1", keptSessionTokenHash),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a weak new password", async () => {
    await expect(
      changePasswordForUser(userId, originalPassword, "short1", "short1", keptSessionTokenHash),
    ).rejects.toThrow(ValidationError);
  });

  it("changes the password and signs out every other session, keeping the current one", async () => {
    await changePasswordForUser(userId, originalPassword, "NewPassword1", "NewPassword1", keptSessionTokenHash);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(await compare("NewPassword1", user.passwordHash)).toBe(true);
    expect(await compare(originalPassword, user.passwordHash)).toBe(false);

    const remainingSessions = await prisma.session.findMany({ where: { userId } });
    expect(remainingSessions).toHaveLength(1);
    expect(remainingSessions[0].tokenHash).toBe(keptSessionTokenHash);
  });
});
