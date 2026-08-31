import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

maybeDescribe("broker connection ownership", () => {
  let prisma: typeof import("./prisma").prisma;
  let encryptToken: typeof import("@/providers/schwab/crypto").encryptToken;
  let getValidSchwabAccessTokenForConnection: typeof import("@/providers/schwab/tokens").getValidSchwabAccessTokenForConnection;
  let connectionId: string | null = null;

  beforeAll(async () => {
    process.env.SCHWAB_TOKEN_ENCRYPTION_KEY = `base64:${Buffer.alloc(32, 4).toString("base64")}`;
    prisma = (await import("./prisma")).prisma;
    encryptToken = (await import("@/providers/schwab/crypto")).encryptToken;
    getValidSchwabAccessTokenForConnection = (await import("@/providers/schwab/tokens")).getValidSchwabAccessTokenForConnection;
  });

  afterAll(async () => {
    if (connectionId) {
      await prisma.brokerConnection.deleteMany({ where: { id: connectionId } });
    }
    await prisma.$disconnect();
  });

  it("does not let one user read another user's broker token", async () => {
    const [matt, eric] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { email: "matt@lst.local" }, select: { id: true } }),
      prisma.user.findUniqueOrThrow({ where: { email: "eric@lst.local" }, select: { id: true } }),
    ]);
    const connection = await prisma.brokerConnection.create({
      data: {
        userId: matt.id,
        provider: "SCHWAB",
        label: "Charles Schwab integration test",
        status: "CONNECTED",
        accessTokenCiphertext: encryptToken("matt-access-token"),
        refreshTokenCiphertext: encryptToken("matt-refresh-token"),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });
    connectionId = connection.id;

    await expect(
      getValidSchwabAccessTokenForConnection(connection.id, { expectedUserId: matt.id }),
    ).resolves.toBe("matt-access-token");
    await expect(
      getValidSchwabAccessTokenForConnection(connection.id, { expectedUserId: eric.id }),
    ).resolves.toBeNull();
  });
});
