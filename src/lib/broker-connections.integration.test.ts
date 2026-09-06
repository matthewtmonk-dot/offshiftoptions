import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

maybeDescribe("broker connection ownership and provider routing", () => {
  let prisma: typeof import("./prisma").prisma;
  let encryptToken: typeof import("@/providers/schwab/crypto").encryptToken;
  let getValidSchwabAccessTokenForConnection: typeof import("@/providers/schwab/tokens").getValidSchwabAccessTokenForConnection;
  let resolveMarketDataProviderForUser: typeof import("./broker-connections").resolveMarketDataProviderForUser;
  let resolvePersonalBrokerProviderForUser: typeof import("./broker-connections").resolvePersonalBrokerProviderForUser;
  let getSchwabBrokerReadProviderForUser: typeof import("./broker-connections").getSchwabBrokerReadProviderForUser;
  let getSchwabOpenPositionsForUser: typeof import("./workflows").getSchwabOpenPositionsForUser;
  let getSchwabConnectionSummaryForUser: typeof import("./broker-connections").getSchwabConnectionSummaryForUser;
  let recordSchwabSyncDiagnostics: typeof import("./broker-connections").recordSchwabSyncDiagnostics;
  let userA: { id: string };
  let userB: { id: string };
  const userIds: string[] = [];

  beforeAll(async () => {
    process.env.SCHWAB_TOKEN_ENCRYPTION_KEY = `base64:${Buffer.alloc(32, 4).toString("base64")}`;
    prisma = (await import("./prisma")).prisma;
    encryptToken = (await import("@/providers/schwab/crypto")).encryptToken;
    getValidSchwabAccessTokenForConnection = (await import("@/providers/schwab/tokens")).getValidSchwabAccessTokenForConnection;
    resolveMarketDataProviderForUser = (await import("./broker-connections")).resolveMarketDataProviderForUser;
    resolvePersonalBrokerProviderForUser = (await import("./broker-connections")).resolvePersonalBrokerProviderForUser;
    getSchwabBrokerReadProviderForUser = (await import("./broker-connections")).getSchwabBrokerReadProviderForUser;
    getSchwabOpenPositionsForUser = (await import("./workflows")).getSchwabOpenPositionsForUser;
    ({ getSchwabConnectionSummaryForUser, recordSchwabSyncDiagnostics } = await import("./broker-connections"));

    const passwordHash = await hash("not-used", 4);
    const timestamp = Date.now();
    userA = await prisma.user.create({
      data: { name: "Provider User A", email: `provider-a-${timestamp}@lst.local`, passwordHash },
      select: { id: true },
    });
    userB = await prisma.user.create({
      data: { name: "Provider User B", email: `provider-b-${timestamp}@lst.local`, passwordHash },
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

  it("does not let one user read another user's broker token", async () => {
    const connection = await createConnection(userA.id, "User A token isolation");

    await expect(
      getValidSchwabAccessTokenForConnection(connection.id, { expectedUserId: userA.id }),
    ).resolves.toBe("access-token-user-a-token-isolation");
    await expect(
      getValidSchwabAccessTokenForConnection(connection.id, { expectedUserId: userB.id }),
    ).resolves.toBeNull();
  });

  it("routes market data to the authenticated user's own Schwab developer app connection", async () => {
    const credential = await createDeveloperCredential(userA.id, "user-a-app");
    const connection = await createConnection(userA.id, "User A market data", credential.id);

    await expect(resolveMarketDataProviderForUser(userA.id)).resolves.toMatchObject({
      source: "USER_SCHWAB",
      connectionId: connection.id,
      usesUserDeveloperApp: true,
    });

    await expect(resolveMarketDataProviderForUser(userB.id)).resolves.toMatchObject({
      provider: null,
      source: "UNAVAILABLE",
      reason: "NO_USER_CONNECTION",
      sharedFallback: "DISABLED_POLICY_NOT_VERIFIED",
    });
  });

  it("never uses another user's personal broker connection for balances, positions, or history", async () => {
    await createConnection(userA.id, "User A personal broker only");

    await expect(resolvePersonalBrokerProviderForUser(userA.id)).resolves.toMatchObject({ source: "USER_SCHWAB" });
    await expect(resolvePersonalBrokerProviderForUser(userB.id)).resolves.toMatchObject({
      provider: null,
      source: "UNAVAILABLE",
      reason: "NO_USER_CONNECTION",
    });
    await expect(getSchwabBrokerReadProviderForUser(userB.id)).resolves.toBeNull();
    await expect(getSchwabOpenPositionsForUser(userB.id)).resolves.toBeNull();
  });

  it("leaves User B's provider working when User A deletes their own connection", async () => {
    const userAConnection = await createConnection(userA.id, "User A disposable provider");
    const userBCredential = await createDeveloperCredential(userB.id, "user-b-app");
    const userBConnection = await createConnection(userB.id, "User B durable provider", userBCredential.id);

    await prisma.brokerConnection.delete({ where: { id: userAConnection.id } });

    await expect(resolveMarketDataProviderForUser(userB.id)).resolves.toMatchObject({
      source: "USER_SCHWAB",
      connectionId: userBConnection.id,
      usesUserDeveloperApp: true,
    });
    await expect(resolvePersonalBrokerProviderForUser(userB.id)).resolves.toMatchObject({
      source: "USER_SCHWAB",
      connectionId: userBConnection.id,
    });
  });

  it("persists and reads back sync diagnostics as aggregate counts only - no account/position/transaction content", async () => {
    const connection = await createConnection(userA.id, "Diagnostics round trip");

    await recordSchwabSyncDiagnostics(userA.id, {
      accountsSynced: 1,
      positionsReceived: 3,
      transactionsReceived: 3,
      brokerRecordsInserted: 6,
      duplicatesSkipped: 0,
      recordsUnresolved: 0,
      feeKnownCount: 2,
      feeUnknownCount: 1,
      campaignsCreated: 3,
      campaignsClosed: 0,
      campaignsRolled: 0,
      campaignsAssigned: 0,
      campaignsExpired: 3,
    });

    const summary = await getSchwabConnectionSummaryForUser(userA.id);
    expect(summary?.lastSyncDiagnostics).toEqual({
      accountsSynced: 1,
      positionsReceived: 3,
      transactionsReceived: 3,
      brokerRecordsInserted: 6,
      duplicatesSkipped: 0,
      recordsUnresolved: 0,
      feeKnownCount: 2,
      feeUnknownCount: 1,
      campaignsCreated: 3,
      campaignsClosed: 0,
      campaignsRolled: 0,
      campaignsAssigned: 0,
      campaignsExpired: 3,
    });

    // Nothing sensitive is present in the persisted metadata blob itself.
    const raw = await prisma.brokerConnection.findUnique({ where: { id: connection.id } });
    const serialized = JSON.stringify(raw?.metadata);
    expect(serialized).not.toContain("access-token");
    expect(serialized).not.toContain("refresh-token");
  });

  it("never mixes User B's sync diagnostics into User A's connection", async () => {
    const connectionA = await createConnection(userA.id, "Isolation diagnostics A");
    await createConnection(userB.id, "Isolation diagnostics B");

    await recordSchwabSyncDiagnostics(userA.id, {
      accountsSynced: 1,
      positionsReceived: 1,
      transactionsReceived: 1,
      brokerRecordsInserted: 1,
      duplicatesSkipped: 0,
      recordsUnresolved: 0,
      feeKnownCount: 1,
      feeUnknownCount: 0,
      campaignsCreated: 1,
      campaignsClosed: 0,
      campaignsRolled: 0,
      campaignsAssigned: 0,
      campaignsExpired: 0,
    });

    const userBSummary = await getSchwabConnectionSummaryForUser(userB.id);
    expect(userBSummary?.lastSyncDiagnostics).toBeNull();

    const stillRawA = await prisma.brokerConnection.findUnique({ where: { id: connectionA.id } });
    expect((stillRawA?.metadata as Record<string, unknown> | null)?.lastSyncDiagnostics).toBeTruthy();
  });

  async function createDeveloperCredential(userId: string, label: string) {
    return prisma.schwabDeveloperCredential.create({
      data: {
        userId,
        provider: "SCHWAB",
        label,
        clientIdCiphertext: encryptToken(`client-id-${label}`),
        clientSecretCiphertext: encryptToken(`client-secret-${label}`),
        redirectUri: "https://example.test/api/schwab/callback",
        status: "VALIDATED",
        marketDataEnabled: true,
        appKeyLast4: label.slice(-4),
        lastValidatedAt: new Date(),
      },
    });
  }

  async function createConnection(userId: string, label: string, developerCredentialId?: string) {
    const tokenSuffix = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return prisma.brokerConnection.create({
      data: {
        userId,
        provider: "SCHWAB",
        label,
        status: "CONNECTED",
        developerCredentialId,
        accessTokenCiphertext: encryptToken(`access-token-${tokenSuffix}`),
        refreshTokenCiphertext: encryptToken(`refresh-token-${tokenSuffix}`),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        metadata: {
          accountHashes: [{ hashValue: `${tokenSuffix}-account-hash`, accountNumberLast4: "9999" }],
          accountNumberLast4s: ["9999"],
          accountCount: 1,
        },
      },
    });
  }
});
