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
  let getSchwabConnectionHealthForUser: typeof import("./broker-connections").getSchwabConnectionHealthForUser;
  let recordSchwabSyncDiagnostics: typeof import("./broker-connections").recordSchwabSyncDiagnostics;
  let saveSchwabDeveloperCredentialForUser: typeof import("@/providers/schwab/developer-credentials").saveSchwabDeveloperCredentialForUser;
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
    ({ getSchwabConnectionSummaryForUser, getSchwabConnectionHealthForUser, recordSchwabSyncDiagnostics } = await import("./broker-connections"));
    ({ saveSchwabDeveloperCredentialForUser } = await import("@/providers/schwab/developer-credentials"));

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
      positionsSourceStatus: "OK",
      positionsErrorCode: null,
      transactionsReceived: 3,
      tradeTransactionsReceived: 2,
      tradeSourceStatus: "OK",
      receiveAndDeliverReceived: 1,
      receiveAndDeliverSourceStatus: "OK",
      dividendOrInterestReceived: 0,
      dividendOrInterestSourceStatus: "ERROR",
      transactionsErrorCode: null,
      brokerRecordsInserted: 6,
      duplicatesSkipped: 0,
      recordsUnresolved: 0,
      feeKnownCount: 2,
      feeUnknownCount: 1,
      persistenceStatus: "OK",
      persistenceErrorCode: null,
      campaignsCreated: 3,
      campaignsClosed: 0,
      campaignsRolled: 0,
      campaignsAssigned: 0,
      campaignsExpired: 3,
      reconciliationStatus: "OK",
      reconciliationErrorCode: null,
    });

    const summary = await getSchwabConnectionSummaryForUser(userA.id);
    expect(summary?.lastSyncDiagnostics).toEqual({
      accountsSynced: 1,
      positionsReceived: 3,
      positionsSourceStatus: "OK",
      positionsErrorCode: null,
      transactionsReceived: 3,
      tradeTransactionsReceived: 2,
      tradeSourceStatus: "OK",
      receiveAndDeliverReceived: 1,
      receiveAndDeliverSourceStatus: "OK",
      dividendOrInterestReceived: 0,
      dividendOrInterestSourceStatus: "ERROR",
      transactionsErrorCode: null,
      brokerRecordsInserted: 6,
      duplicatesSkipped: 0,
      recordsUnresolved: 0,
      feeKnownCount: 2,
      feeUnknownCount: 1,
      persistenceStatus: "OK",
      persistenceErrorCode: null,
      campaignsCreated: 3,
      campaignsClosed: 0,
      campaignsRolled: 0,
      campaignsAssigned: 0,
      campaignsExpired: 3,
      reconciliationStatus: "OK",
      reconciliationErrorCode: null,
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
      positionsSourceStatus: "OK",
      positionsErrorCode: null,
      transactionsReceived: 1,
      tradeTransactionsReceived: 1,
      tradeSourceStatus: "OK",
      receiveAndDeliverReceived: 0,
      receiveAndDeliverSourceStatus: "OK",
      dividendOrInterestReceived: 0,
      dividendOrInterestSourceStatus: "OK",
      transactionsErrorCode: null,
      brokerRecordsInserted: 1,
      duplicatesSkipped: 0,
      recordsUnresolved: 0,
      feeKnownCount: 1,
      feeUnknownCount: 0,
      persistenceStatus: "OK",
      persistenceErrorCode: null,
      campaignsCreated: 1,
      campaignsClosed: 0,
      campaignsRolled: 0,
      campaignsAssigned: 0,
      campaignsExpired: 0,
      reconciliationStatus: "OK",
      reconciliationErrorCode: null,
    });

    const userBSummary = await getSchwabConnectionSummaryForUser(userB.id);
    expect(userBSummary?.lastSyncDiagnostics).toBeNull();

    const stillRawA = await prisma.brokerConnection.findUnique({ where: { id: connectionA.id } });
    expect((stillRawA?.metadata as Record<string, unknown> | null)?.lastSyncDiagnostics).toBeTruthy();
  });

  it("Matt sees only Matt's connection health, Eric sees only Eric's", async () => {
    await createConnection(userA.id, "Matt health isolation", undefined, { metadata: { accountCount: 2 } });
    await createConnection(userB.id, "Eric health isolation", undefined, { metadata: { accountCount: 5 } });

    const mattHealth = await getSchwabConnectionHealthForUser(userA.id);
    const ericHealth = await getSchwabConnectionHealthForUser(userB.id);

    expect(mattHealth.accountDiscovery.accountsLinked).toBe(2);
    expect(ericHealth.accountDiscovery.accountsLinked).toBe(5);
  });

  it("reports USER_CONFIGURED for an existing connection that used the user's own developer app", async () => {
    const freshUser = await createFreshUser("Existing Connection User Configured");
    const credential = await createDeveloperCredential(freshUser.id, "matt-user-app");
    await createConnection(freshUser.id, "Matt user-app connection", credential.id);

    const health = await getSchwabConnectionHealthForUser(freshUser.id);
    expect(health.credentialSource).toBe("USER_CONFIGURED");
  });

  it("reports SERVER_ENV for an existing connection that used the shared server app", async () => {
    await createConnection(userA.id, "Matt server-env connection");

    const health = await getSchwabConnectionHealthForUser(userA.id);
    expect(health.credentialSource).toBe("SERVER_ENV");
  });

  it("prospectively reports USER_CONFIGURED before connecting, when the user has already saved their own developer app", async () => {
    const freshUser = await createFreshUser("Prospective User Configured");
    await saveSchwabDeveloperCredentialForUser(freshUser.id, "prospective-client-id", "prospective-client-secret", "https://example.test/api/schwab/callback");

    const health = await getSchwabConnectionHealthForUser(freshUser.id);
    expect(health.credentialSource).toBe("USER_CONFIGURED");
  });

  it("prospectively reports NONE or SERVER_ENV (never a guess) before connecting, with no saved developer app", async () => {
    const freshUser = await createFreshUser("Prospective None Or Server Env");
    const { getSchwabConfigStatus } = await import("@/providers/schwab/config");
    const originalEnv = { ...process.env };
    try {
      delete process.env.SCHWAB_CLIENT_ID;
      delete process.env.SCHWAB_CLIENT_SECRET;
      delete process.env.SCHWAB_REDIRECT_URI;
      expect(getSchwabConfigStatus().configured).toBe(false);

      const noneHealth = await getSchwabConnectionHealthForUser(freshUser.id);
      expect(noneHealth.credentialSource).toBe("NONE");

      process.env.SCHWAB_CLIENT_ID = "server-env-client-id";
      process.env.SCHWAB_CLIENT_SECRET = "server-env-client-secret";
      process.env.SCHWAB_REDIRECT_URI = "https://example.test/api/schwab/callback";
      expect(getSchwabConfigStatus().configured).toBe(true);

      const serverEnvHealth = await getSchwabConnectionHealthForUser(freshUser.id);
      expect(serverEnvHealth.credentialSource).toBe("SERVER_ENV");
    } finally {
      process.env = originalEnv;
    }
  });

  it("derives OAuth status from stored connection state - CONNECTED, NOT_CONNECTED, TOKEN_EXPIRED, REFRESH_FAILED", async () => {
    const neverConnectedUser = await createFreshUser("OAuth Status Never Connected");
    await expect(getSchwabConnectionHealthForUser(neverConnectedUser.id)).resolves.toMatchObject({ oauthStatus: "NOT_CONNECTED" });

    const connectedUser = await createFreshUser("OAuth Status Connected");
    await createConnection(connectedUser.id, "OAuth status connected");
    await expect(getSchwabConnectionHealthForUser(connectedUser.id)).resolves.toMatchObject({ oauthStatus: "CONNECTED" });

    const tokenExpiredUser = await createFreshUser("OAuth Status Token Expired");
    await createConnection(tokenExpiredUser.id, "OAuth status token expired", undefined, { expiresAt: new Date(Date.now() - 60_000) });
    await expect(getSchwabConnectionHealthForUser(tokenExpiredUser.id)).resolves.toMatchObject({ oauthStatus: "TOKEN_EXPIRED" });

    const disconnectedUser = await createFreshUser("OAuth Status Disconnected");
    await createConnection(disconnectedUser.id, "OAuth status disconnected", undefined, { status: "DISCONNECTED" });
    await expect(getSchwabConnectionHealthForUser(disconnectedUser.id)).resolves.toMatchObject({ oauthStatus: "NOT_CONNECTED" });

    const refreshFailedUser = await createFreshUser("OAuth Status Refresh Failed");
    await createConnection(refreshFailedUser.id, "OAuth status refresh failed", undefined, { status: "EXPIRED" });
    await expect(getSchwabConnectionHealthForUser(refreshFailedUser.id)).resolves.toMatchObject({ oauthStatus: "REFRESH_FAILED" });
  });

  it("account discovery failure never claims '0 accounts returned' - it reports ERROR, distinct from an honest zero", async () => {
    await createConnection(userA.id, "Discovery failed", undefined, { metadata: { accountDiscoveryStatus: "UNAVAILABLE", accountCount: 0 } });
    const failedHealth = await getSchwabConnectionHealthForUser(userA.id);
    expect(failedHealth.accountDiscovery.status).toBe("ERROR");
    expect(failedHealth.accountDiscovery.accountsLinked).toBe(0);

    await createConnection(userB.id, "Discovery honest zero", undefined, { metadata: { accountDiscoveryStatus: "OK", accountCount: 0 } });
    const honestZeroHealth = await getSchwabConnectionHealthForUser(userB.id);
    expect(honestZeroHealth.accountDiscovery.status).toBe("OK");
    expect(honestZeroHealth.accountDiscovery.accountsLinked).toBe(0);
  });

  it("a positions failure does not erase successful transaction diagnostics in the same sync", async () => {
    await createConnection(userA.id, "Positions failed transactions ok");
    await recordSchwabSyncDiagnostics(userA.id, {
      accountsSynced: 1,
      positionsReceived: 0,
      positionsSourceStatus: "ERROR",
      positionsErrorCode: "unauthorized",
      transactionsReceived: 4,
      tradeTransactionsReceived: 4,
      tradeSourceStatus: "OK",
      receiveAndDeliverReceived: 0,
      receiveAndDeliverSourceStatus: "OK",
      dividendOrInterestReceived: 0,
      dividendOrInterestSourceStatus: "OK",
      transactionsErrorCode: null,
      brokerRecordsInserted: 4,
      duplicatesSkipped: 0,
      recordsUnresolved: 0,
      feeKnownCount: 4,
      feeUnknownCount: 0,
      persistenceStatus: "OK",
      persistenceErrorCode: null,
      campaignsCreated: 2,
      campaignsClosed: 0,
      campaignsRolled: 0,
      campaignsAssigned: 0,
      campaignsExpired: 0,
      reconciliationStatus: "OK",
      reconciliationErrorCode: null,
    });

    const health = await getSchwabConnectionHealthForUser(userA.id);
    expect(health.sync?.positionsSourceStatus).toBe("ERROR");
    expect(health.sync?.positionsErrorCode).toBe("unauthorized");
    expect(health.sync?.tradeSourceStatus).toBe("OK");
    expect(health.sync?.tradeTransactionsReceived).toBe(4);
    expect(health.sync?.brokerRecordsInserted).toBe(4);
  });

  it("a transaction/sync failure never erases the account-discovery result already recorded on the connection", async () => {
    await createConnection(userA.id, "Transactions failed discovery ok", undefined, { metadata: { accountDiscoveryStatus: "OK", accountCount: 3 } });
    await recordSchwabSyncDiagnostics(userA.id, {
      accountsSynced: 1,
      positionsReceived: 2,
      positionsSourceStatus: "OK",
      positionsErrorCode: null,
      transactionsReceived: 0,
      tradeTransactionsReceived: 0,
      tradeSourceStatus: "ERROR",
      receiveAndDeliverReceived: 0,
      receiveAndDeliverSourceStatus: "ERROR",
      dividendOrInterestReceived: 0,
      dividendOrInterestSourceStatus: "ERROR",
      transactionsErrorCode: "provider_unavailable",
      brokerRecordsInserted: 0,
      duplicatesSkipped: 0,
      recordsUnresolved: 0,
      feeKnownCount: 0,
      feeUnknownCount: 0,
      persistenceStatus: "OK",
      persistenceErrorCode: null,
      campaignsCreated: 0,
      campaignsClosed: 0,
      campaignsRolled: 0,
      campaignsAssigned: 0,
      campaignsExpired: 0,
      reconciliationStatus: "OK",
      reconciliationErrorCode: null,
    });

    const health = await getSchwabConnectionHealthForUser(userA.id);
    expect(health.sync?.tradeSourceStatus).toBe("ERROR");
    expect(health.sync?.transactionsErrorCode).toBe("provider_unavailable");
    // Account discovery lives on the connection itself, set once at OAuth time - a later sync
    // failure must never retroactively erase or downgrade it.
    expect(health.accountDiscovery.status).toBe("OK");
    expect(health.accountDiscovery.accountsLinked).toBe(3);
  });

  it("never exposes tokens, secrets, or raw provider content in the connection health object", async () => {
    const freshUser = await createFreshUser("Secret Scan User");
    const credential = await createDeveloperCredential(freshUser.id, "secret-scan-app");
    await createConnection(freshUser.id, "Secret scan connection", credential.id);
    await recordSchwabSyncDiagnostics(freshUser.id, {
      accountsSynced: 1,
      positionsReceived: 1,
      positionsSourceStatus: "ERROR",
      positionsErrorCode: "unauthorized",
      transactionsReceived: 0,
      tradeTransactionsReceived: 0,
      tradeSourceStatus: "OK",
      receiveAndDeliverReceived: 0,
      receiveAndDeliverSourceStatus: "OK",
      dividendOrInterestReceived: 0,
      dividendOrInterestSourceStatus: "OK",
      transactionsErrorCode: null,
      brokerRecordsInserted: 0,
      duplicatesSkipped: 0,
      recordsUnresolved: 0,
      feeKnownCount: 0,
      feeUnknownCount: 0,
      persistenceStatus: "OK",
      persistenceErrorCode: null,
      campaignsCreated: 0,
      campaignsClosed: 0,
      campaignsRolled: 0,
      campaignsAssigned: 0,
      campaignsExpired: 0,
      reconciliationStatus: "OK",
      reconciliationErrorCode: null,
    });

    const health = await getSchwabConnectionHealthForUser(freshUser.id);
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain("access-token");
    expect(serialized).not.toContain("refresh-token");
    expect(serialized).not.toContain("client-id-secret-scan-app");
    expect(serialized).not.toContain("client-secret-secret-scan-app");
    expect(serialized).not.toContain("account-hash");
    expect(serialized).not.toContain("9999");
  });

  async function createFreshUser(label: string) {
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const freshUser = await prisma.user.create({
      data: { name: label, email: `${slug}-${Date.now()}-${Math.random().toString(36).slice(2)}@lst.local`, passwordHash: await hash("not-used", 4) },
    });
    userIds.push(freshUser.id);
    return freshUser;
  }

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

  async function createConnection(
    userId: string,
    label: string,
    developerCredentialId?: string,
    overrides: { status?: "CONNECTED" | "DISCONNECTED" | "EXPIRED"; expiresAt?: Date; metadata?: Record<string, unknown> } = {},
  ) {
    const tokenSuffix = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return prisma.brokerConnection.create({
      data: {
        userId,
        provider: "SCHWAB",
        label,
        status: overrides.status ?? "CONNECTED",
        developerCredentialId,
        accessTokenCiphertext: encryptToken(`access-token-${tokenSuffix}`),
        refreshTokenCiphertext: encryptToken(`refresh-token-${tokenSuffix}`),
        expiresAt: overrides.expiresAt ?? new Date(Date.now() + 10 * 60 * 1000),
        metadata: {
          accountHashes: [{ hashValue: `${tokenSuffix}-account-hash`, accountNumberLast4: "9999" }],
          accountNumberLast4s: ["9999"],
          accountCount: 1,
          accountDiscoveryStatus: "OK",
          ...overrides.metadata,
        },
      },
    });
  }
});
