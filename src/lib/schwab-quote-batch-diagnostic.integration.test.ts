import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

function fakeQuotesResponse(symbols: string[]) {
  const body: Record<string, unknown> = {};
  for (const symbol of new Set(symbols)) {
    body[symbol] = { quote: { lastPrice: 20, totalVolume: 1_000_000 }, assetMainType: "EQUITY" };
  }
  return body;
}

maybeDescribe("Schwab quote batch-size diagnostic - market data only, never touches account/position data", () => {
  let prisma: typeof import("./prisma").prisma;
  let encryptToken: typeof import("@/providers/schwab/crypto").encryptToken;
  let runSchwabQuoteBatchDiagnosticForUser: typeof import("./schwab-quote-batch-diagnostic").runSchwabQuoteBatchDiagnosticForUser;
  let user: { id: string };

  beforeAll(async () => {
    process.env.SCHWAB_TOKEN_ENCRYPTION_KEY = `base64:${Buffer.alloc(32, 7).toString("base64")}`;
    prisma = (await import("./prisma")).prisma;
    encryptToken = (await import("@/providers/schwab/crypto")).encryptToken;
    ({ runSchwabQuoteBatchDiagnosticForUser } = await import("./schwab-quote-batch-diagnostic"));

    const passwordHash = await hash("not-used", 4);
    user = await prisma.user.create({
      data: { name: "Batch Diagnostic User", email: `batch-diagnostic-${Date.now()}@lst.local`, passwordHash },
    });
  });

  afterAll(async () => {
    await prisma.brokerConnection.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  });

  it("returns UNAVAILABLE (NO_USER_CONNECTION) when the user has no connected Schwab account", async () => {
    const result = await runSchwabQuoteBatchDiagnosticForUser(user.id);
    expect(result.status).toBe("UNAVAILABLE");
    if (result.status !== "UNAVAILABLE") throw new Error("expected UNAVAILABLE");
    expect(result.reason).toBe("NO_USER_CONNECTION");
  });

  it("tests every size in order and reports SUCCESS with sanitized counts - never the raw payload or the access token", async () => {
    await prisma.brokerConnection.create({
      data: {
        userId: user.id,
        provider: "SCHWAB",
        label: "Batch diagnostic connection",
        status: "CONNECTED",
        accessTokenCiphertext: encryptToken("access-token-batch-diagnostic-secret"),
        refreshTokenCiphertext: encryptToken("refresh-token-batch-diagnostic-secret"),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        metadata: {},
      },
    });

    let requestCount = 0;
    const fetchFn = (async (input: unknown) => {
      requestCount += 1;
      const url = input as URL;
      const symbols = url.searchParams.get("symbols")?.split(",") ?? [];
      return new Response(JSON.stringify(fakeQuotesResponse(symbols)), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await runSchwabQuoteBatchDiagnosticForUser(user.id, { fetchFn });
    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("expected OK");
    expect(result.accountDataTouched).toBe(false);
    expect(result.nothingSaved).toBe(true);
    expect(requestCount).toBe(4); // one real HTTP call per size (5, 25, 50, 100) - never chunked
    expect(result.results.map((r) => r.requestedCount)).toEqual([5, 25, 50, 100]);
    expect(result.largestVerifiedBatchSize).toBe(100);
    for (const outcome of result.results) {
      expect(outcome.outcome).toBe("SUCCESS");
      expect(outcome.symbolsReturnedCount).toBe(outcome.distinctSymbolsRequested);
      expect(outcome.missingCount).toBe(0);
    }
    // Sanitized: never the raw token or a raw provider payload anywhere in the result.
    expect(JSON.stringify(result)).not.toContain("batch-diagnostic-secret");
  });

  it("stops at the first failed size and never attempts a larger one", async () => {
    await prisma.brokerConnection.deleteMany({ where: { userId: user.id } });
    await prisma.brokerConnection.create({
      data: {
        userId: user.id,
        provider: "SCHWAB",
        label: "Batch diagnostic connection (failure case)",
        status: "CONNECTED",
        accessTokenCiphertext: encryptToken("access-token-batch-diagnostic-failure"),
        refreshTokenCiphertext: encryptToken("refresh-token-batch-diagnostic-failure"),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        metadata: {},
      },
    });

    let requestCount = 0;
    const fetchFn = (async (input: unknown) => {
      requestCount += 1;
      const url = input as URL;
      const symbols = url.searchParams.get("symbols")?.split(",") ?? [];
      if (symbols.length > 5) {
        return new Response("", { status: 500 });
      }
      return new Response(JSON.stringify(fakeQuotesResponse(symbols)), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await runSchwabQuoteBatchDiagnosticForUser(user.id, { fetchFn });
    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("expected OK");
    expect(requestCount).toBe(2); // size 5 (success), then size 25 (failure) - never reaches 50 or 100
    expect(result.results.map((r) => r.outcome)).toEqual(["SUCCESS", "HTTP_ERROR"]);
    expect(result.largestVerifiedBatchSize).toBe(5);
  });
});
