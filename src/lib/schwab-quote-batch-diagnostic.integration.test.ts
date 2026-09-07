import { hash } from "bcryptjs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

const TEST_SOURCE = "TEST_FIXTURE_BATCH_DIAGNOSTIC";

function fakeQuotesResponse(symbols: string[]) {
  const body: Record<string, unknown> = {};
  for (const symbol of new Set(symbols)) {
    body[symbol] = { quote: { lastPrice: 20, totalVolume: 1_000_000 }, assetMainType: "EQUITY" };
  }
  return body;
}

/** Real distinct tickers (never real Cboe/OCC/production data), zero-padded so ORDER BY ticker
 * ASC yields a stable, predictable sequence (SYM000, SYM001, ...). */
function syntheticTickers(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `SYM${String(i).padStart(3, "0")}`);
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

  afterEach(async () => {
    await prisma.optionableUniverseSymbol.deleteMany({ where: { source: TEST_SOURCE } });
    await prisma.brokerConnection.deleteMany({ where: { userId: user.id } });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  });

  async function createConnection(label: string) {
    await prisma.brokerConnection.create({
      data: {
        userId: user.id,
        provider: "SCHWAB",
        label,
        status: "CONNECTED",
        accessTokenCiphertext: encryptToken(`access-token-${label}`),
        refreshTokenCiphertext: encryptToken(`refresh-token-${label}`),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        metadata: {},
      },
    });
  }

  async function seedUniverse(tickers: string[]) {
    const now = new Date();
    await prisma.optionableUniverseSymbol.createMany({
      data: tickers.map((ticker) => ({ ticker, name: `${ticker} Corp`, source: TEST_SOURCE, lastSeenAt: now })),
    });
  }

  function capturingFetchFn() {
    const requestedSymbolsPerCall: string[][] = [];
    const fetchFn = (async (input: unknown) => {
      const url = input as URL;
      const symbols = url.searchParams.get("symbols")?.split(",") ?? [];
      requestedSymbolsPerCall.push(symbols);
      return new Response(JSON.stringify(fakeQuotesResponse(symbols)), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchFn, requestedSymbolsPerCall };
  }

  it("returns UNAVAILABLE (NO_USER_CONNECTION) when the user has no connected Schwab account", async () => {
    const result = await runSchwabQuoteBatchDiagnosticForUser(user.id);
    expect(result.status).toBe("UNAVAILABLE");
    if (result.status !== "UNAVAILABLE") throw new Error("expected UNAVAILABLE");
    expect(result.reason).toBe("NO_USER_CONNECTION");
  });

  it("with a real 100+ symbol public universe, each size's outbound request contains exactly that many DISTINCT symbols - 25, 50, and 100 are never silently capped at a smaller pool", async () => {
    await createConnection("full-universe");
    await seedUniverse(syntheticTickers(150));
    const { fetchFn, requestedSymbolsPerCall } = capturingFetchFn();

    const result = await runSchwabQuoteBatchDiagnosticForUser(user.id, { fetchFn, universeSource: TEST_SOURCE });
    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("expected OK");

    expect(requestedSymbolsPerCall).toHaveLength(4); // exactly one outbound HTTP call per size - never chunked
    expect(requestedSymbolsPerCall[0]).toHaveLength(5);
    expect(new Set(requestedSymbolsPerCall[0]).size).toBe(5);
    expect(requestedSymbolsPerCall[1]).toHaveLength(25);
    expect(new Set(requestedSymbolsPerCall[1]).size).toBe(25);
    expect(requestedSymbolsPerCall[2]).toHaveLength(50);
    expect(new Set(requestedSymbolsPerCall[2]).size).toBe(50);
    expect(requestedSymbolsPerCall[3]).toHaveLength(100);
    expect(new Set(requestedSymbolsPerCall[3]).size).toBe(100);

    expect(result.results.map((r) => r.requestedDistinct)).toEqual([5, 25, 50, 100]);
    expect(result.largestVerifiedRequestSize).toBe(100);
    for (const outcome of result.results) {
      expect(outcome.outcome).toBe("SUCCESS");
      if (outcome.outcome !== "SUCCESS") throw new Error("expected SUCCESS");
      expect(outcome.requestAccepted).toBe(true);
      expect(outcome.returnedDistinct).toBe(outcome.requestedDistinct);
      expect(outcome.missingCount).toBe(0);
    }
  });

  it("uses a deterministic ORDER BY ticker ASC selection - the 25-symbol batch is a strict prefix of the 100-symbol batch, so repeated runs are comparable", async () => {
    await createConnection("deterministic-order");
    await seedUniverse(syntheticTickers(120));
    const { fetchFn, requestedSymbolsPerCall } = capturingFetchFn();

    await runSchwabQuoteBatchDiagnosticForUser(user.id, { fetchFn, universeSource: TEST_SOURCE });
    const [size5, size25, , size100] = requestedSymbolsPerCall;
    expect(size100.slice(0, 5)).toEqual(size5);
    expect(size100.slice(0, 25)).toEqual(size25);
    expect(size5).toEqual(["SYM000", "SYM001", "SYM002", "SYM003", "SYM004"]);
  });

  it("a duplicate/case-variant row in the source universe never silently reduces the effective distinct count without being noticed - it produces NOT_TESTED instead of a falsely-smaller batch", async () => {
    await createConnection("duplicate-source-rows");
    // 98 genuinely distinct tickers, plus 2 rows that normalize (trim/uppercase) to duplicates of
    // two of those - 100 raw rows, but only 98 truly distinct after normalization.
    const base = syntheticTickers(98);
    await seedUniverse([...base, "sym000", " SYM001 "]);
    const { fetchFn, requestedSymbolsPerCall } = capturingFetchFn();

    const result = await runSchwabQuoteBatchDiagnosticForUser(user.id, { fetchFn, universeSource: TEST_SOURCE });
    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("expected OK");

    // 5/25/50 still fully testable (98 distinct >= 50).
    expect(requestedSymbolsPerCall).toHaveLength(3);
    expect(new Set(requestedSymbolsPerCall[2]).size).toBe(50);

    // 100 was never actually testable (only 98 distinct exist) - reported honestly, not as a
    // fake "100 verified" built from fewer real distinct symbols.
    const size100Result = result.results.at(-1);
    expect(size100Result?.outcome).toBe("NOT_TESTED");
    if (size100Result?.outcome !== "NOT_TESTED") throw new Error("expected NOT_TESTED");
    expect(size100Result.availableDistinct).toBe(98);
    expect(result.largestVerifiedRequestSize).toBe(50);
  });

  it("reports NOT_TESTED (never a fake SUCCESS) when the public universe has too few distinct symbols for a size, and stops there", async () => {
    await createConnection("insufficient-universe");
    await seedUniverse(syntheticTickers(30)); // enough for 5 and 25, not enough for 50 or 100
    const { fetchFn, requestedSymbolsPerCall } = capturingFetchFn();

    const result = await runSchwabQuoteBatchDiagnosticForUser(user.id, { fetchFn, universeSource: TEST_SOURCE });
    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("expected OK");

    expect(requestedSymbolsPerCall).toHaveLength(2); // only 5 and 25 ever made a real HTTP call
    expect(result.results.map((r) => r.outcome)).toEqual(["SUCCESS", "SUCCESS", "NOT_TESTED"]);
    const notTested = result.results.at(-1);
    if (notTested?.outcome !== "NOT_TESTED") throw new Error("expected NOT_TESTED");
    expect(notTested.requestedDistinct).toBe(50);
    expect(notTested.availableDistinct).toBe(30);
    expect(result.largestVerifiedRequestSize).toBe(25);
  });

  it("missing quotes for some requested symbols never masquerade as a request failure - the request is still SUCCESS/accepted", async () => {
    await createConnection("partial-quotes");
    await seedUniverse(syntheticTickers(10));
    const fetchFn = (async (input: unknown) => {
      const url = input as URL;
      const symbols = url.searchParams.get("symbols")?.split(",") ?? [];
      // Schwab accepts the request but only has quote data for the first 3 of 5 symbols.
      return new Response(JSON.stringify(fakeQuotesResponse(symbols.slice(0, 3))), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await runSchwabQuoteBatchDiagnosticForUser(user.id, { fetchFn, universeSource: TEST_SOURCE });
    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("expected OK");
    const size5 = result.results[0];
    expect(size5.outcome).toBe("SUCCESS");
    if (size5.outcome !== "SUCCESS") throw new Error("expected SUCCESS");
    expect(size5.requestAccepted).toBe(true);
    expect(size5.returnedDistinct).toBe(3);
    expect(size5.missingCount).toBe(2); // honestly surfaced, but never treated as a failed request
  });

  it("an outright API rejection stops all larger sizes from being tested, and largest verified size reflects only genuinely accepted requests", async () => {
    await createConnection("api-rejection");
    await seedUniverse(syntheticTickers(150));
    const { fetchFn, requestedSymbolsPerCall } = (() => {
      const requestedSymbolsPerCall: string[][] = [];
      const fetchFn = (async (input: unknown) => {
        const url = input as URL;
        const symbols = url.searchParams.get("symbols")?.split(",") ?? [];
        requestedSymbolsPerCall.push(symbols);
        if (symbols.length > 5) {
          return new Response("", { status: 500 });
        }
        return new Response(JSON.stringify(fakeQuotesResponse(symbols)), { status: 200 });
      }) as unknown as typeof fetch;
      return { fetchFn, requestedSymbolsPerCall };
    })();

    const result = await runSchwabQuoteBatchDiagnosticForUser(user.id, { fetchFn, universeSource: TEST_SOURCE });
    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("expected OK");
    expect(requestedSymbolsPerCall).toHaveLength(2); // size 5 (accepted), then size 25 (rejected) - never reaches 50 or 100
    expect(result.results.map((r) => r.outcome)).toEqual(["SUCCESS", "HTTP_ERROR"]);
    const rejected = result.results[1];
    if (rejected.outcome !== "HTTP_ERROR") throw new Error("expected HTTP_ERROR");
    expect(rejected.requestAccepted).toBe(false);
    expect(rejected.httpStatus).toBe(500);
    expect(result.largestVerifiedRequestSize).toBe(5);
  });

  it("never lets private user data (Research/Watchlist) enter symbol selection - only the public OptionableUniverseSymbol cache is queried", async () => {
    await createConnection("private-data-isolation");
    await seedUniverse(syntheticTickers(10));
    // Real-shaped private data using a ticker that would stand out immediately if it leaked in.
    const watchlist = await prisma.watchlist.create({ data: { ownerId: user.id, name: "Isolation Test Watchlist", visibility: "PRIVATE" } });
    await prisma.watchlistItem.create({
      data: { watchlistId: watchlist.id, ownerId: user.id, ticker: "PRIVATEW", status: "WATCHING", visibility: "PRIVATE" },
    });

    const { fetchFn, requestedSymbolsPerCall } = capturingFetchFn();
    await runSchwabQuoteBatchDiagnosticForUser(user.id, { fetchFn, universeSource: TEST_SOURCE });

    const allRequestedSymbols = requestedSymbolsPerCall.flat();
    expect(allRequestedSymbols).not.toContain("PRIVATEW");

    await prisma.watchlistItem.deleteMany({ where: { ownerId: user.id } });
    await prisma.watchlist.deleteMany({ where: { ownerId: user.id } });
  });

  it("never leaks the access token or a raw provider payload in the sanitized result", async () => {
    await createConnection("secret-check");
    await seedUniverse(syntheticTickers(10));
    const { fetchFn } = capturingFetchFn();

    const result = await runSchwabQuoteBatchDiagnosticForUser(user.id, { fetchFn, universeSource: TEST_SOURCE });
    expect(JSON.stringify(result)).not.toContain("access-token-secret-check");
  });
});
