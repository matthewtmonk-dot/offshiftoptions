import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

maybeDescribe("Schwab fundamentals diagnostic - authorization, scoping, and safe failure", () => {
  let prisma: typeof import("./prisma").prisma;
  let encryptToken: typeof import("@/providers/schwab/crypto").encryptToken;
  let runSchwabFundamentalsDiagnosticForUser: typeof import("./schwab-fundamentals-diagnostic").runSchwabFundamentalsDiagnosticForUser;
  let userA: { id: string };
  let userB: { id: string };
  const userIds: string[] = [];

  const okFetchFn = (async () =>
    new Response(
      JSON.stringify({
        APLD: { reference: { description: "Applied Digital Corporation" }, fundamental: { peRatio: 18.4 }, quote: { lastPrice: 12.34 }, regular: {} },
        RIOT: { reference: {}, fundamental: {}, quote: { mark: 9.1 }, regular: {} },
        CORZ: { reference: {}, fundamental: {}, quote: {}, regular: {} },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;

  beforeAll(async () => {
    process.env.SCHWAB_TOKEN_ENCRYPTION_KEY = `base64:${Buffer.alloc(32, 7).toString("base64")}`;
    prisma = (await import("./prisma")).prisma;
    encryptToken = (await import("@/providers/schwab/crypto")).encryptToken;
    runSchwabFundamentalsDiagnosticForUser = (await import("./schwab-fundamentals-diagnostic")).runSchwabFundamentalsDiagnosticForUser;

    const passwordHash = await hash("not-used", 4);
    const timestamp = Date.now();
    userA = await prisma.user.create({
      data: { name: "Fundamentals Diagnostic User A", email: `fundamentals-diag-a-${timestamp}@lst.local`, passwordHash },
      select: { id: true },
    });
    userB = await prisma.user.create({
      data: { name: "Fundamentals Diagnostic User B", email: `fundamentals-diag-b-${timestamp}@lst.local`, passwordHash },
      select: { id: true },
    });
    userIds.push(userA.id, userB.id);
  });

  afterAll(async () => {
    await prisma.brokerConnection.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.watchlistItem.deleteMany({ where: { ownerId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("reports UNAVAILABLE with a safe message when the user has no Schwab connection at all", async () => {
    const result = await runSchwabFundamentalsDiagnosticForUser(userB.id);
    expect(result).toMatchObject({
      status: "UNAVAILABLE",
      reason: "NO_USER_CONNECTION",
      message: "Connect Schwab in Account before running this read-only diagnostic.",
    });
    expect(JSON.stringify(result)).not.toMatch(/access[-_]?token|refresh[-_]?token/i);
  });

  it("only ever uses the requesting user's own connection - never a different user's", async () => {
    const connection = await createConnection(userA.id, "diag-user-a");

    const forUserA = await runSchwabFundamentalsDiagnosticForUser(userA.id, { fetchFn: okFetchFn });
    expect(forUserA.status).toBe("OK");

    // User B has no connection of their own; passing User B's id must never fall through to
    // User A's connection just because one exists in the database.
    const forUserB = await runSchwabFundamentalsDiagnosticForUser(userB.id, { fetchFn: okFetchFn });
    expect(forUserB.status).toBe("UNAVAILABLE");
    if (forUserB.status === "UNAVAILABLE") {
      expect(forUserB.reason).toBe("NO_USER_CONNECTION");
    }

    await prisma.brokerConnection.delete({ where: { id: connection.id } });
  });

  it("returns a strictly allowlisted, non-raw report on success and never leaks the token", async () => {
    const connection = await createConnection(userA.id, "diag-user-a-ok");

    const result = await runSchwabFundamentalsDiagnosticForUser(userA.id, { fetchFn: okFetchFn });
    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect(result.report.rows.length).toBeGreaterThan(0);
      expect(result.report.quoteRequest.symbols).toEqual(["APLD", "RIOT", "CORZ"]);
    }

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("access-token-diag-user-a-ok");
    expect(serialized).not.toContain("refresh-token-diag-user-a-ok");
    expect(serialized).not.toMatch(/authorization/i);
    expect(serialized).not.toMatch(/\baccount[-_]?hash\b/i);
    expect(serialized).not.toContain("9999"); // seeded fake account-number-last-4 in metadata

    await prisma.brokerConnection.delete({ where: { id: connection.id } });
  });

  it("sanitizes a Schwab 401 into a safe reconnect message, never the raw response", async () => {
    const connection = await createConnection(userA.id, "diag-user-a-401");
    const unauthorizedFetchFn = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;

    const result = await runSchwabFundamentalsDiagnosticForUser(userA.id, { fetchFn: unauthorizedFetchFn });
    expect(result.status).toBe("ERROR");
    if (result.status === "ERROR") {
      expect(result.message).toBe("Schwab authorization is expired or unavailable. Reconnect Schwab, then try again.");
      expect(result.statusCode).toBe(401);
    }
    expect(JSON.stringify(result)).not.toMatch(/bearer|authorization:/i);

    await prisma.brokerConnection.delete({ where: { id: connection.id } });
  });

  it("sanitizes a Schwab 429 into a safe rate-limit message with only the retry-after hint", async () => {
    const connection = await createConnection(userA.id, "diag-user-a-429");
    const rateLimitedFetchFn = (async () => new Response("{}", { status: 429, headers: { "retry-after": "30" } })) as unknown as typeof fetch;

    const result = await runSchwabFundamentalsDiagnosticForUser(userA.id, { fetchFn: rateLimitedFetchFn });
    expect(result.status).toBe("ERROR");
    if (result.status === "ERROR") {
      expect(result.message).toBe("Schwab rate limit reached. Try again after the provider cooldown.");
      expect(result.statusCode).toBe(429);
      expect(result.retryAfter).toBe("30");
    }

    await prisma.brokerConnection.delete({ where: { id: connection.id } });
  });

  it("makes zero writes to Research/Scanner/BrokerRecord/Campaign data", async () => {
    const connection = await createConnection(userA.id, "diag-user-a-no-writes");
    const watchlistCountBefore = await prisma.watchlistItem.count({ where: { ownerId: userA.id } });
    const campaignCountBefore = await prisma.campaign.count({ where: { ownerId: userA.id } });
    const brokerRecordCountBefore = await prisma.brokerRecord.count({ where: { userId: userA.id } });

    await runSchwabFundamentalsDiagnosticForUser(userA.id, { fetchFn: okFetchFn });

    expect(await prisma.watchlistItem.count({ where: { ownerId: userA.id } })).toBe(watchlistCountBefore);
    expect(await prisma.campaign.count({ where: { ownerId: userA.id } })).toBe(campaignCountBefore);
    expect(await prisma.brokerRecord.count({ where: { userId: userA.id } })).toBe(brokerRecordCountBefore);

    await prisma.brokerConnection.delete({ where: { id: connection.id } });
  });

  async function createConnection(userId: string, label: string) {
    const tokenSuffix = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return prisma.brokerConnection.create({
      data: {
        userId,
        provider: "SCHWAB",
        label,
        status: "CONNECTED",
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
