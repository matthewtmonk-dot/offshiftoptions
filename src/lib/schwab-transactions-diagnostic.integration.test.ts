import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

maybeDescribe("Schwab transactions/orders diagnostic - authorization, scoping, and safe failure", () => {
  let prisma: typeof import("./prisma").prisma;
  let encryptToken: typeof import("@/providers/schwab/crypto").encryptToken;
  let runSchwabTransactionsDiagnosticForUser: typeof import("./schwab-transactions-diagnostic").runSchwabTransactionsDiagnosticForUser;
  let userA: { id: string };
  let userB: { id: string };
  const userIds: string[] = [];

  // Every diagnostic run makes 9 calls (3 windows + 5 type tests + 1 orders call) against the
  // same fetchFn, so a single stub covers a full run unless a test needs per-call variation.
  const emptyOkFetchFn = (async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;

  beforeAll(async () => {
    process.env.SCHWAB_TOKEN_ENCRYPTION_KEY = `base64:${Buffer.alloc(32, 7).toString("base64")}`;
    prisma = (await import("./prisma")).prisma;
    encryptToken = (await import("@/providers/schwab/crypto")).encryptToken;
    runSchwabTransactionsDiagnosticForUser = (await import("./schwab-transactions-diagnostic")).runSchwabTransactionsDiagnosticForUser;

    const passwordHash = await hash("not-used", 4);
    const timestamp = Date.now();
    userA = await prisma.user.create({
      data: { name: "Transactions Diagnostic User A", email: `transactions-diag-a-${timestamp}@lst.local`, passwordHash },
      select: { id: true },
    });
    userB = await prisma.user.create({
      data: { name: "Transactions Diagnostic User B", email: `transactions-diag-b-${timestamp}@lst.local`, passwordHash },
      select: { id: true },
    });
    userIds.push(userA.id, userB.id);
  });

  afterAll(async () => {
    await prisma.brokerConnection.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("reports UNAVAILABLE with a safe message when the user has no Schwab connection at all", async () => {
    const result = await runSchwabTransactionsDiagnosticForUser(userB.id);
    expect(result).toMatchObject({
      status: "UNAVAILABLE",
      reason: "NO_USER_CONNECTION",
      message: "Connect Schwab in Account before running this read-only diagnostic.",
    });
    expect(JSON.stringify(result)).not.toMatch(/access[-_]?token|refresh[-_]?token/i);
  });

  it("only ever uses the requesting user's own connection - never a different user's", async () => {
    const connection = await createConnection(userA.id, "txn-diag-user-a");

    const forUserA = await runSchwabTransactionsDiagnosticForUser(userA.id, { fetchFn: emptyOkFetchFn });
    expect(forUserA.status).toBe("OK");

    const forUserB = await runSchwabTransactionsDiagnosticForUser(userB.id, { fetchFn: emptyOkFetchFn });
    expect(forUserB.status).toBe("UNAVAILABLE");
    if (forUserB.status === "UNAVAILABLE") {
      expect(forUserB.reason).toBe("NO_USER_CONNECTION");
    }

    await prisma.brokerConnection.delete({ where: { id: connection.id } });
  });

  it("returns a fully sanitized report on success: correct windows/type-tests/orders shape, honest empty distinct from malformed, no leaks", async () => {
    const connection = await createConnection(userA.id, "txn-diag-user-a-ok");

    let callIndex = 0;
    const mixedFetchFn = (async () => {
      callIndex += 1;
      // Calls 1-3 are the windows, 4-8 are the type tests, 9 is orders. The 5th call overall is
      // the DIVIDEND_OR_INTEREST type-test; return a malformed (non-array) body for it so the
      // report must distinguish "malformed" from an honest empty array reported elsewhere.
      if (callIndex === 5) {
        return new Response(JSON.stringify({ unexpected: "shape" }), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await runSchwabTransactionsDiagnosticForUser(userA.id, { fetchFn: mixedFetchFn });
    expect(result.status).toBe("OK");
    if (result.status !== "OK") {
      throw new Error("expected OK");
    }

    expect(result.report.windows).toHaveLength(3);
    expect(result.report.windows.map((w) => w.days)).toEqual([7, 30, 60]);
    expect(result.report.typeTests).toHaveLength(5);
    expect(result.report.orders.status).toBe("OK");

    const honestEmpty = result.report.windows[0];
    expect(honestEmpty).toMatchObject({ status: "OK", transactionCount: 0, malformedResponse: false });

    const malformedOne = result.report.typeTests.find((t) => "malformedResponse" in t && t.malformedResponse);
    expect(malformedOne).toBeDefined();
    expect(malformedOne).toMatchObject({ status: "OK", transactionCount: 0, malformedResponse: true });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("access-token-txn-diag-user-a-ok");
    expect(serialized).not.toContain("refresh-token-txn-diag-user-a-ok");
    expect(serialized).not.toMatch(/bearer|authorization:/i);
    expect(serialized).not.toMatch(/\baccount[-_]?hash\b/i);
    expect(serialized).not.toContain("txn-diag-user-a-ok-account-hash");
    expect(serialized).not.toContain("9999");

    await prisma.brokerConnection.delete({ where: { id: connection.id } });
  });

  it("reports a Schwab 401 per-call as a sanitized ERROR entry, never collapsing the whole run", async () => {
    const connection = await createConnection(userA.id, "txn-diag-user-a-401");
    const unauthorizedFetchFn = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;

    const result = await runSchwabTransactionsDiagnosticForUser(userA.id, { fetchFn: unauthorizedFetchFn });
    expect(result.status).toBe("OK");
    if (result.status !== "OK") {
      throw new Error("expected OK");
    }

    for (const window of result.report.windows) {
      expect(window.status).toBe("ERROR");
      if (window.status === "ERROR") {
        expect(window.httpStatus).toBe(401);
        expect(window.errorMessage).toBe("Schwab authorization is expired or unavailable. Reconnect Schwab, then try again.");
      }
    }
    expect(result.report.orders.status).toBe("ERROR");
    expect(JSON.stringify(result)).not.toMatch(/bearer|authorization:/i);

    await prisma.brokerConnection.delete({ where: { id: connection.id } });
  });

  it("reports a Schwab 429 per-call as a sanitized ERROR entry with the retry-after hint preserved on the http status only", async () => {
    const connection = await createConnection(userA.id, "txn-diag-user-a-429");
    const rateLimitedFetchFn = (async () => new Response("{}", { status: 429, headers: { "retry-after": "30" } })) as unknown as typeof fetch;

    const result = await runSchwabTransactionsDiagnosticForUser(userA.id, { fetchFn: rateLimitedFetchFn });
    expect(result.status).toBe("OK");
    if (result.status !== "OK") {
      throw new Error("expected OK");
    }

    expect(result.report.windows[0]).toMatchObject({
      status: "ERROR",
      httpStatus: 429,
      errorMessage: "Schwab rate limit reached. Try again after the provider cooldown.",
    });

    await prisma.brokerConnection.delete({ where: { id: connection.id } });
  });

  it("makes zero writes to BrokerRecord (or anything else) merely by running the diagnostic", async () => {
    const connection = await createConnection(userA.id, "txn-diag-user-a-no-writes");
    const brokerRecordCountBefore = await prisma.brokerRecord.count({ where: { userId: userA.id } });
    const brokerConnectionCountBefore = await prisma.brokerConnection.count({ where: { userId: userA.id } });

    await runSchwabTransactionsDiagnosticForUser(userA.id, { fetchFn: emptyOkFetchFn });

    expect(await prisma.brokerRecord.count({ where: { userId: userA.id } })).toBe(brokerRecordCountBefore);
    expect(await prisma.brokerConnection.count({ where: { userId: userA.id } })).toBe(brokerConnectionCountBefore);

    await prisma.brokerConnection.delete({ where: { id: connection.id } });
  });

  it("requests full ISO-8601 date-time windows and the documented type literals, never inventing new ones", async () => {
    const connection = await createConnection(userA.id, "txn-diag-user-a-requests");
    const capturedUrls: URL[] = [];
    const capturingFetchFn = (async (input: URL | string) => {
      capturedUrls.push(new URL(input.toString()));
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    const now = new Date("2026-09-05T12:00:00.000Z");
    const result = await runSchwabTransactionsDiagnosticForUser(userA.id, { fetchFn: capturingFetchFn, now });
    expect(result.status).toBe("OK");

    const transactionUrls = capturedUrls.filter((url) => url.pathname.endsWith("/transactions"));
    expect(transactionUrls).toHaveLength(8); // 3 windows + 5 type tests
    for (const url of transactionUrls) {
      expect(url.searchParams.get("startDate")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(url.searchParams.get("endDate")).toBe("2026-09-05T12:00:00.000Z");
    }

    const requestedTypes = transactionUrls.map((url) => url.searchParams.get("types"));
    expect(requestedTypes.slice(3)).toEqual([
      "TRADE",
      "DIVIDEND_OR_INTEREST",
      "RECEIVE_AND_DELIVER",
      "CASH_IN_OR_CASH_OUT",
      "TRADE,DIVIDEND_OR_INTEREST,RECEIVE_AND_DELIVER,CASH_IN_OR_CASH_OUT",
    ]);

    const ordersUrl = capturedUrls.find((url) => url.pathname.endsWith("/orders"));
    expect(ordersUrl).toBeDefined();
    expect(ordersUrl?.searchParams.get("fromEnteredTime")).toBe("2026-07-07T12:00:00.000Z");
    expect(ordersUrl?.searchParams.get("toEnteredTime")).toBe("2026-09-05T12:00:00.000Z");

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
