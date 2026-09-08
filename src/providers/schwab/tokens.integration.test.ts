import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// saveSchwabTokensForUser is the one function the OAuth callback route
// (src/app/api/schwab/callback/route.ts) calls to persist a successful authorization - whether
// this is a brand-new connect OR a Reconnect click after a token refresh failure. These tests
// prove the "reconnect must never duplicate a connection, and must never touch another user's
// connection" requirement directly at that persistence layer, without needing a real Schwab
// authorization code or live OAuth round trip.
const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

// discoverSchwabAccountNumbers (called internally by saveSchwabTokensForUser) catches any fetch
// failure and honestly reports "account discovery unavailable" - so a fetchFn that always rejects
// is a safe, real, already-supported code path for these tests, not a workaround.
const rejectingFetch = (async () => {
  throw new Error("not needed for this test - saveSchwabTokensForUser tolerates a failed account discovery call");
}) as unknown as typeof fetch;

function fakeTokenResponse(accessTokenSuffix: string) {
  return {
    access_token: `access-${accessTokenSuffix}`,
    refresh_token: `refresh-${accessTokenSuffix}`,
    token_type: "Bearer",
    expires_in: 1800,
  };
}

maybeDescribe("saveSchwabTokensForUser - reconnect safety", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let saveSchwabTokensForUser: typeof import("./tokens").saveSchwabTokensForUser;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    process.env.SCHWAB_TOKEN_ENCRYPTION_KEY = `base64:${Buffer.alloc(32, 7).toString("base64")}`;
    prisma = (await import("@/lib/prisma")).prisma;
    ({ saveSchwabTokensForUser } = await import("./tokens"));
  });

  afterAll(async () => {
    await prisma.brokerConnection.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  });

  async function createUser(label: string) {
    const passwordHash = await hash("not-used", 4);
    const user = await prisma.user.create({
      data: {
        name: `Reconnect ${label}`,
        email: `reconnect-${label.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2)}@lst.local`,
        passwordHash,
      },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    return user;
  }

  it("a brand-new user's first authorization creates exactly one CONNECTED BrokerConnection row", async () => {
    const user = await createUser("A");

    await saveSchwabTokensForUser(user.id, fakeTokenResponse("first"), rejectingFetch);

    const rows = await prisma.brokerConnection.findMany({ where: { userId: user.id, provider: "SCHWAB" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("CONNECTED");
  });

  it("reconnecting after a refresh failure (EXPIRED/REFRESH_FAILED) updates the SAME row - never creates a duplicate", async () => {
    const user = await createUser("B");

    const initial = await saveSchwabTokensForUser(user.id, fakeTokenResponse("initial"), rejectingFetch);
    await prisma.brokerConnection.update({
      where: { id: initial.id },
      data: {
        status: "EXPIRED",
        metadata: { lastRefreshFailureAt: new Date().toISOString(), lastRefreshFailureReason: "refresh_failed" },
      },
    });

    // This is exactly what the callback route does when the user clicks "Reconnect Schwab" -
    // the same saveSchwabTokensForUser call as a first-time connect, for the same userId.
    const reconnected = await saveSchwabTokensForUser(user.id, fakeTokenResponse("reconnected"), rejectingFetch);

    expect(reconnected.id).toBe(initial.id); // same row, not a new one
    expect(reconnected.status).toBe("CONNECTED"); // healed back to connected

    const rows = await prisma.brokerConnection.findMany({ where: { userId: user.id, provider: "SCHWAB" } });
    expect(rows).toHaveLength(1); // still exactly one row for this user
  });

  it("reconnecting an already-healthy CONNECTED connection also updates the same row, never duplicates it", async () => {
    const user = await createUser("C");

    const initial = await saveSchwabTokensForUser(user.id, fakeTokenResponse("healthy-1"), rejectingFetch);
    const reconnected = await saveSchwabTokensForUser(user.id, fakeTokenResponse("healthy-2"), rejectingFetch);

    expect(reconnected.id).toBe(initial.id);
    const rows = await prisma.brokerConnection.findMany({ where: { userId: user.id, provider: "SCHWAB" } });
    expect(rows).toHaveLength(1);
  });

  it("one user's reconnect never creates, updates, or reads another user's connection row", async () => {
    const matt = await createUser("Matt");
    const eric = await createUser("Eric");

    const mattInitial = await saveSchwabTokensForUser(matt.id, fakeTokenResponse("matt-initial"), rejectingFetch);
    const ericInitial = await saveSchwabTokensForUser(eric.id, fakeTokenResponse("eric-initial"), rejectingFetch);

    // Simulate Matt's refresh failing and Matt clicking Reconnect - Eric never connected again.
    await prisma.brokerConnection.update({ where: { id: mattInitial.id }, data: { status: "EXPIRED" } });
    const mattReconnected = await saveSchwabTokensForUser(matt.id, fakeTokenResponse("matt-reconnected"), rejectingFetch);

    expect(mattReconnected.id).toBe(mattInitial.id);

    const ericRow = await prisma.brokerConnection.findUniqueOrThrow({ where: { id: ericInitial.id } });
    expect(ericRow.status).toBe("CONNECTED"); // untouched by Matt's reconnect
    expect(ericRow.updatedAt.getTime()).toBe(ericInitial.updatedAt.getTime()); // never written to

    const mattRows = await prisma.brokerConnection.findMany({ where: { userId: matt.id, provider: "SCHWAB" } });
    const ericRows = await prisma.brokerConnection.findMany({ where: { userId: eric.id, provider: "SCHWAB" } });
    expect(mattRows).toHaveLength(1);
    expect(ericRows).toHaveLength(1);
  });
});
