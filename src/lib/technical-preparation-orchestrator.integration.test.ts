import { hash } from "bcryptjs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { scannerRulesFromRecords } from "@/domain/scanner/profile";
import type { MarketDataProvider, MarketQuote, PriceCandle } from "@/providers/market-data/types";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

const TEST_SOURCE = "TEST_FIXTURE_TECHNICAL_ORCHESTRATOR";
const GATE_CONTROL_TICKERS = ["0GATECTRLOR0", "0GATECTRLOR1", "0GATECTRLOR2", "0GATECTRLOR3", "0GATECTRLOR4"];

const resolveMarketDataProviderForUserMock = vi.fn();
vi.mock("@/lib/broker-connections", () => ({
  resolveMarketDataProviderForUser: (...args: unknown[]) => resolveMarketDataProviderForUserMock(...args),
}));

/** Every userId in this set makes getTechnicalPreparationStatusForUser throw the given error
 * instead of running its real implementation - every other candidate still goes through the real
 * function unchanged. Lets the "stale candidate during selection" race (a user disappearing
 * between the connected-user query and its own status lookup) be reproduced deterministically,
 * without needing to win a real timing race against Postgres's own FK CASCADE (which makes the
 * "User gone, BrokerConnection still present" state otherwise unreachable outside a live race). */
const failingStatusLookupUserIds = new Map<string, unknown>();
vi.mock("./technical-indicator-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./technical-indicator-cache")>();
  return {
    ...actual,
    getTechnicalPreparationStatusForUser: async (userId: string, now?: Date) => {
      if (failingStatusLookupUserIds.has(userId)) {
        throw failingStatusLookupUserIds.get(userId);
      }
      return actual.getTechnicalPreparationStatusForUser(userId, now);
    },
  };
});

function staleCandidateError(): Error {
  return Object.assign(new Error("Foreign key constraint violated on the constraint: `ScannerProfile_ownerId_fkey`"), { code: "P2003" });
}

function syntheticTickers(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `ORCH${String(i).padStart(3, "0")}`);
}

function syntheticCandles(ticker: string, count = 80, endDate: Date = new Date()): PriceCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = 100 + i * 0.3 + (i % 5 === 0 ? -2 : 1);
    const date = new Date(endDate.getTime() - (count - 1 - i) * 24 * 60 * 60 * 1000);
    return { symbol: ticker, date, open: close - 0.5, high: close + 1, low: close - 1, close, volume: 1_000_000 };
  });
}

function fakeProvider(options: {
  quotes: Record<string, { price: number; volume: number }>;
  onGetQuotes?: (symbols: string[]) => void;
  onGetPriceHistory?: (ticker: string) => void;
  onGetOptionChain?: (ticker: string) => void;
}): MarketDataProvider {
  const quotesByTicker = new Map<string, MarketQuote>(
    Object.entries(options.quotes).map(([ticker, { price, volume }]) => [ticker, { symbol: ticker, price, volume, asOf: new Date() }]),
  );
  return {
    async getQuote(symbol) {
      const quote = quotesByTicker.get(symbol.toUpperCase());
      if (!quote) throw new Error(`no quote for ${symbol}`);
      return quote;
    },
    async getQuotes(symbols) {
      options.onGetQuotes?.(symbols);
      const result = new Map<string, MarketQuote>();
      for (const symbol of symbols) {
        const quote = quotesByTicker.get(symbol.toUpperCase());
        if (quote) result.set(symbol.toUpperCase(), quote);
      }
      return result;
    },
    async getPriceHistory(symbol) {
      options.onGetPriceHistory?.(symbol);
      return syntheticCandles(symbol);
    },
    async getOptionChain(symbol) {
      options.onGetOptionChain?.(symbol);
      return [];
    },
    async getInstrument(symbol) {
      return { symbol, description: symbol, assetType: "EQUITY" };
    },
    async getMarketHours() {
      return { isOpen: true };
    },
  };
}

// A real trading day, inside the morning preparation window (see
// technical-preparation-orchestrator.test.ts for the pure window-function tests) - Wed Sep 9 2026,
// 6:00 AM ET, before that day's own open.
const WITHIN_WINDOW_NOW = new Date("2026-09-09T10:00:00Z");
// Tue Sep 8 2026, 2:00 PM ET - inside the live regular session, well outside the morning window.
const OUTSIDE_WINDOW_NOW = new Date("2026-09-08T18:00:00Z");

maybeDescribe("Technical preparation orchestrator - bounded, fair, per-user isolated", () => {
  let prisma: typeof import("./prisma").prisma;
  let runTechnicalPreparationOrchestratorCycle: typeof import("./technical-preparation-orchestrator").runTechnicalPreparationOrchestratorCycle;
  let encryptToken: typeof import("@/providers/schwab/crypto").encryptToken;
  let matt: { id: string };
  let eric: { id: string };

  beforeAll(async () => {
    process.env.SCHWAB_TOKEN_ENCRYPTION_KEY = `base64:${Buffer.alloc(32, 9).toString("base64")}`;
    prisma = (await import("./prisma")).prisma;
    ({ runTechnicalPreparationOrchestratorCycle } = await import("./technical-preparation-orchestrator"));
    encryptToken = (await import("@/providers/schwab/crypto")).encryptToken;

    const passwordHash = await hash("not-used", 4);
    const timestamp = Date.now();
    matt = await prisma.user.create({ data: { name: "Matt Orchestrator", email: `matt-orch-${timestamp}@lst.local`, passwordHash } });
    eric = await prisma.user.create({ data: { name: "Eric Orchestrator", email: `eric-orch-${timestamp}@lst.local`, passwordHash } });
  });

  beforeEach(() => {
    // A safe, unconditional default for ANY candidate userId - including a stray BrokerConnection
    // row belonging to some OTHER concurrently-running test file's own fixture user, which the
    // orchestrator's real (deliberately global, unscoped) "all connected users" query can pick up
    // under Vitest's parallel-by-file execution against this one shared local dev database. Each
    // test below overrides this only for the specific userId(s) it actually cares about.
    resolveMarketDataProviderForUserMock.mockResolvedValue({
      provider: null,
      source: "UNAVAILABLE",
      label: "no mock configured for this user in this test",
      reason: "NO_USER_CONNECTION",
      sharedFallback: "DISABLED_POLICY_NOT_VERIFIED",
    });
  });

  afterEach(async () => {
    resolveMarketDataProviderForUserMock.mockReset();
    failingStatusLookupUserIds.clear();
    await prisma.technicalPreparationRun.deleteMany({ where: { userId: { in: [matt.id, eric.id] } } });
    await prisma.technicalIndicatorSnapshot.deleteMany({ where: { userId: { in: [matt.id, eric.id] } } });
    await prisma.optionableUniverseSymbol.deleteMany({ where: { source: TEST_SOURCE } });
    await prisma.brokerConnection.deleteMany({ where: { userId: { in: [matt.id, eric.id] } } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [matt.id, eric.id] } } });
    await prisma.$disconnect();
  });

  async function seedUniverse(tickers: string[]) {
    const now = new Date();
    await prisma.optionableUniverseSymbol.createMany({
      data: [...GATE_CONTROL_TICKERS, ...tickers].map((ticker) => ({ ticker, name: `${ticker} Corp`, source: TEST_SOURCE, lastSeenAt: now })),
      skipDuplicates: true,
    });
  }

  async function createPreparationRunWithPendingItems(userId: string, now: Date, tickers: string[]) {
    const [{ ensureMyLstScannerProfileForUser }, { computeQuoteStageRulesFingerprint, dateOnlyUtc }] = await Promise.all([
      import("./workflows"),
      import("./technical-indicator-cache"),
    ]);
    const profile = await ensureMyLstScannerProfileForUser(userId);
    const records = await prisma.scannerRule.findMany({ where: { profileId: profile.id }, orderBy: { sortOrder: "asc" } });
    const rulesFingerprint = computeQuoteStageRulesFingerprint(scannerRulesFromRecords(records));
    const run = await prisma.technicalPreparationRun.create({
      data: { userId, marketDate: dateOnlyUtc(now), rulesFingerprint, eligibleCount: tickers.length, status: "IN_PROGRESS" },
    });
    await prisma.technicalPreparationItem.createMany({
      data: tickers.map((ticker) => ({ runId: run.id, ticker, priority: 2, status: "PENDING" })),
    });
    return run;
  }

  /** Resolves ONLY `userId` to a real working provider - any other candidate (including a stray
   * BrokerConnection row belonging to some other concurrently-running test file's own fixture
   * user) safely resolves to UNAVAILABLE, so this test's assertions about "which user got
   * selected" can never be thrown off by cross-file noise under Vitest's parallel execution. */
  function mockProviderForOnly(userId: string, provider: MarketDataProvider) {
    resolveMarketDataProviderForUserMock.mockImplementation(async (candidateId: string) => {
      if (candidateId === userId) {
        return { provider, source: "USER_SCHWAB", label: "test", connectionId: "c1", usesUserDeveloperApp: false };
      }
      return { provider: null, source: "UNAVAILABLE", label: "unrecognized", reason: "NO_USER_CONNECTION", sharedFallback: "DISABLED_POLICY_NOT_VERIFIED" };
    });
  }

  async function createConnectedBrokerRow(userId: string, label: string) {
    await prisma.brokerConnection.create({
      data: {
        userId,
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

  it("is a safe no-op outside the preparation window - no user selection, no provider work", async () => {
    await createConnectedBrokerRow(matt.id, "matt-outside-window");
    await seedUniverse(syntheticTickers(5));

    const result = await runTechnicalPreparationOrchestratorCycle(OUTSIDE_WINDOW_NOW);
    expect(result.status).toBe("OUTSIDE_WINDOW");
    expect(resolveMarketDataProviderForUserMock).not.toHaveBeenCalled();
  });

  it("is a safe no-op when no connected user needs preparation", async () => {
    const result = await runTechnicalPreparationOrchestratorCycle(WITHIN_WINDOW_NOW, { probeUniverseSource: TEST_SOURCE });
    expect(result.status).toBe("NO_ELIGIBLE_USER");
  });

  it("processes at most MAX_SUB_BATCHES_PER_INVOCATION existing 25-symbol batches, never more, using the current authenticated user's own provider only", async () => {
    await createConnectedBrokerRow(matt.id, "matt-bounded");
    const tickers = syntheticTickers(200); // far more than one invocation's cap should ever touch
    await seedUniverse([]);
    await createPreparationRunWithPendingItems(matt.id, WITHIN_WINDOW_NOW, tickers);
    let getQuotesCallCount = 0;
    let historyCallCount = 0;
    const provider = fakeProvider({
      quotes: Object.fromEntries(tickers.map((t) => [t, { price: 20, volume: 1_000_000 }])),
      onGetQuotes: () => {
        getQuotesCallCount += 1;
      },
      onGetPriceHistory: () => {
        historyCallCount += 1;
      },
    });
    mockProviderForOnly(matt.id, provider);

    const result = await runTechnicalPreparationOrchestratorCycle(WITHIN_WINDOW_NOW, { probeUniverseSource: TEST_SOURCE });
    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("expected OK");
    expect(result.subBatchesProcessed).toBe(5); // MAX_SUB_BATCHES_PER_INVOCATION
    expect(result.historySymbolsProcessed).toBe(125); // 5 * 25 - Phase B only, never counts the gate's own probe
    // 125 real Phase B fetches + 5 one-time gate probe requests (checkDailyCandleAvailabilityGate,
    // spent once before continuing an existing run with no fresh READY proof yet) - never more
    // than that fixed overhead.
    expect(historyCallCount).toBe(130);
    expect(getQuotesCallCount).toBe(0); // existing run reused - no Phase A quote sweep
    expect(result.generationStatus).toBe("IN_PROGRESS"); // 200 eligible, only 125 done
    expect(result.remainingEligibleCount).toBe(75);
    expect(resolveMarketDataProviderForUserMock).toHaveBeenCalledWith(matt.id);
  });

  it("stops cleanly (no-op-like) once the generation is already fully COMPLETE, and never re-sweeps quotes", async () => {
    await createConnectedBrokerRow(matt.id, "matt-complete");
    const tickers = syntheticTickers(10);
    await seedUniverse(tickers);
    let getQuotesCallCount = 0;
    const provider = fakeProvider({
      quotes: Object.fromEntries(tickers.map((t) => [t, { price: 20, volume: 1_000_000 }])),
      onGetQuotes: () => {
        getQuotesCallCount += 1;
      },
    });
    mockProviderForOnly(matt.id, provider);

    const first = await runTechnicalPreparationOrchestratorCycle(WITHIN_WINDOW_NOW, { probeUniverseSource: TEST_SOURCE });
    expect(first.status).toBe("OK");
    if (first.status !== "OK") throw new Error("expected OK");
    expect(first.generationStatus).toBe("COMPLETE"); // only 10 eligible - done in one sub-batch
    expect(getQuotesCallCount).toBe(1);

    // A second invocation should find nothing left to do for Matt (COMPLETE) - safe no-op.
    const second = await runTechnicalPreparationOrchestratorCycle(WITHIN_WINDOW_NOW, { probeUniverseSource: TEST_SOURCE });
    expect(second.status).toBe("NO_ELIGIBLE_USER");
    expect(getQuotesCallCount).toBe(1); // still exactly one sweep across both invocations
  });

  it("repeated invocations reuse the same generation and make cumulative forward progress (spanning more than one invocation's own 5-sub-batch cap)", async () => {
    await createConnectedBrokerRow(matt.id, "matt-resume");
    const tickers = syntheticTickers(140); // > MAX_SUB_BATCHES_PER_INVOCATION (5) * TECHNICAL_REFRESH_BATCH_SIZE (25) = 125
    await seedUniverse(tickers);
    const provider = fakeProvider({ quotes: Object.fromEntries(tickers.map((t) => [t, { price: 20, volume: 1_000_000 }])) });
    mockProviderForOnly(matt.id, provider);

    const first = await runTechnicalPreparationOrchestratorCycle(WITHIN_WINDOW_NOW, { probeUniverseSource: TEST_SOURCE });
    if (first.status !== "OK") throw new Error("expected OK");
    expect(first.subBatchesProcessed).toBe(5); // hit the per-invocation cap
    expect(first.remainingEligibleCount).toBe(15); // 140 - 125
    expect(first.generationStatus).toBe("IN_PROGRESS");

    const second = await runTechnicalPreparationOrchestratorCycle(WITHIN_WINDOW_NOW, { probeUniverseSource: TEST_SOURCE });
    if (second.status !== "OK") throw new Error("expected OK");
    expect(second.remainingEligibleCount).toBe(0); // 15 - 15, done in the remaining single sub-batch
    expect(second.generationStatus).toBe("COMPLETE");
  });

  it("a rule change starts a new generation for the affected user - reported via a fresh quote sweep", async () => {
    await createConnectedBrokerRow(matt.id, "matt-rule-change");
    await seedUniverse(["ORCHRULE1"]);
    let getQuotesCallCount = 0;
    const provider = fakeProvider({ quotes: { ORCHRULE1: { price: 20, volume: 1_000_000 } }, onGetQuotes: () => (getQuotesCallCount += 1) });
    mockProviderForOnly(matt.id, provider);

    await runTechnicalPreparationOrchestratorCycle(WITHIN_WINDOW_NOW, { probeUniverseSource: TEST_SOURCE });
    expect(getQuotesCallCount).toBe(1);

    const { ensureMyLstScannerProfileForUser } = await import("./workflows");
    const profile = await ensureMyLstScannerProfileForUser(matt.id);
    await prisma.scannerRule.update({ where: { profileId_key: { profileId: profile.id, key: "price" } }, data: { valueJson: { desired: [5, 15] } } });

    await runTechnicalPreparationOrchestratorCycle(WITHIN_WINDOW_NOW, { probeUniverseSource: TEST_SOURCE });
    expect(getQuotesCallCount).toBe(2); // a genuinely new generation swept again

    await prisma.scannerRule.update({ where: { profileId_key: { profileId: profile.id, key: "price" } }, data: { valueJson: { desired: [10, 50] } } });
  });

  it("one user's provider failure is skipped safely within the invocation, and the other user's data is completely unaffected", async () => {
    await createConnectedBrokerRow(matt.id, "matt-failing");
    await createConnectedBrokerRow(eric.id, "eric-healthy");
    await seedUniverse(["ORCHFAIL1"]);

    resolveMarketDataProviderForUserMock.mockImplementation(async (userId: string) => {
      if (userId === matt.id) {
        return { provider: null, source: "UNAVAILABLE", label: "token dead", reason: "TOKEN_UNAVAILABLE", sharedFallback: "DISABLED_POLICY_NOT_VERIFIED" };
      }
      if (userId === eric.id) {
        return {
          provider: fakeProvider({ quotes: { ORCHFAIL1: { price: 20, volume: 1_000_000 } } }),
          source: "USER_SCHWAB",
          label: "test",
          connectionId: "c1",
          usesUserDeveloperApp: false,
        };
      }
      return { provider: null, source: "UNAVAILABLE", label: "unrecognized", reason: "NO_USER_CONNECTION", sharedFallback: "DISABLED_POLICY_NOT_VERIFIED" };
    });

    const result = await runTechnicalPreparationOrchestratorCycle(WITHIN_WINDOW_NOW, { probeUniverseSource: TEST_SOURCE });
    expect(result.status).toBe("OK");
    if (result.status !== "OK") throw new Error("expected OK");
    // Eric was selected instead - proven by his own run now existing while Matt has none.
    const mattRuns = await prisma.technicalPreparationRun.count({ where: { userId: matt.id } });
    const ericRuns = await prisma.technicalPreparationRun.count({ where: { userId: eric.id } });
    expect(mattRuns).toBe(0);
    expect(ericRuns).toBe(1);
  });

  it("an unexpected mid-cycle failure for the selected user is caught and reported as a clean status, never an unhandled crash - and never touches another user's data", async () => {
    await createConnectedBrokerRow(matt.id, "matt-mid-cycle-crash");
    await seedUniverse(["ORCHCRASH1"]);
    const crashingProvider: MarketDataProvider = {
      async getQuote(symbol) {
        return { symbol, price: 20, volume: 1_000_000, asOf: new Date() };
      },
      async getQuotes() {
        throw new Error("simulated unexpected failure mid-sweep");
      },
      // The global daily-candle-availability gate probes this same ticker via getPriceHistory
      // BEFORE Stage A's own getQuotes sweep - it must return a real, fresh candle so the gate
      // passes and the test actually reaches the intended getQuotes failure, not the gate itself.
      async getPriceHistory(symbol) {
        return syntheticCandles(symbol);
      },
      async getOptionChain() {
        return [];
      },
      async getInstrument(symbol) {
        return { symbol, description: symbol, assetType: "EQUITY" };
      },
      async getMarketHours() {
        return { isOpen: true };
      },
    };
    mockProviderForOnly(matt.id, crashingProvider);

    const result = await runTechnicalPreparationOrchestratorCycle(WITHIN_WINDOW_NOW, { probeUniverseSource: TEST_SOURCE });
    expect(result.status).toBe("USER_CYCLE_FAILED"); // never an unhandled throw out of the orchestrator

    const runCount = await prisma.technicalPreparationRun.count({ where: { userId: matt.id } });
    expect(runCount).toBe(0); // the failed sweep's own placeholder cleanup already guarantees this
  });

  it("a user with no connected broker row is never even considered a candidate", async () => {
    // Eric has no BrokerConnection row at all - not connected, not merely provider-unavailable.
    await createConnectedBrokerRow(matt.id, "matt-only-connection");
    await seedUniverse(["ORCHONLY1"]);
    const provider = fakeProvider({ quotes: { ORCHONLY1: { price: 20, volume: 1_000_000 } } });
    mockProviderForOnly(matt.id, provider);

    await runTechnicalPreparationOrchestratorCycle(WITHIN_WINDOW_NOW, { probeUniverseSource: TEST_SOURCE });
    expect(resolveMarketDataProviderForUserMock).toHaveBeenCalledTimes(1);
    expect(resolveMarketDataProviderForUserMock).toHaveBeenCalledWith(matt.id); // never called for Eric
  });

  it("fairness: a never-started user is selected over one who already has recent IN_PROGRESS work, so one user's ongoing generation can never starve another", async () => {
    await createConnectedBrokerRow(matt.id, "matt-already-started");
    const bigTickers = syntheticTickers(200); // large enough that one invocation cannot complete Matt
    await seedUniverse(bigTickers);
    mockProviderForOnly(matt.id, fakeProvider({ quotes: Object.fromEntries(bigTickers.map((t) => [t, { price: 20, volume: 1_000_000 }])) }));

    // First invocation: only Matt is connected - he gets a real, recently-touched IN_PROGRESS run.
    const first = await runTechnicalPreparationOrchestratorCycle(WITHIN_WINDOW_NOW, { probeUniverseSource: TEST_SOURCE });
    if (first.status !== "OK") throw new Error("expected OK");
    expect(first.generationStatus).toBe("IN_PROGRESS"); // 200 eligible, only 125 done - still needs more work

    // Now Eric connects too, but has never been touched at all (lastTouchedAt null - sorts first).
    await createConnectedBrokerRow(eric.id, "eric-never-started");
    resolveMarketDataProviderForUserMock.mockImplementation(async (candidateId: string) => {
      if (candidateId === matt.id || candidateId === eric.id) {
        return {
          provider: fakeProvider({ quotes: { ORCHFAIR1: { price: 20, volume: 1_000_000 } } }),
          source: "USER_SCHWAB",
          label: "test",
          connectionId: candidateId,
          usesUserDeveloperApp: false,
        };
      }
      return { provider: null, source: "UNAVAILABLE", label: "unrecognized", reason: "NO_USER_CONNECTION", sharedFallback: "DISABLED_POLICY_NOT_VERIFIED" };
    });
    await seedUniverse(["ORCHFAIR1"]);

    await runTechnicalPreparationOrchestratorCycle(WITHIN_WINDOW_NOW, { probeUniverseSource: TEST_SOURCE });

    // Eric - never touched before - was picked this time, not Matt (who still has 75 remaining
    // and would otherwise be the "obvious" continuation target).
    const ericRuns = await prisma.technicalPreparationRun.count({ where: { userId: eric.id } });
    expect(ericRuns).toBe(1);
    const mattRun = await prisma.technicalPreparationRun.findFirstOrThrow({ where: { userId: matt.id } });
    expect(mattRun.eligibleCount).toBe(200); // Matt's own generation untouched by this second invocation
  });

  it("never issues an option-chain request, and never touches the earnings/Alpha Vantage cache, during technical preparation", async () => {
    await createConnectedBrokerRow(matt.id, "matt-no-side-effects");
    await seedUniverse(["ORCHSIDE1"]);
    let optionChainCallCount = 0;
    const provider = fakeProvider({
      quotes: { ORCHSIDE1: { price: 20, volume: 1_000_000 } },
      onGetOptionChain: () => {
        optionChainCallCount += 1;
      },
    });
    mockProviderForOnly(matt.id, provider);

    const earningsCountBefore = await prisma.earningsCalendarEntry.count();
    await runTechnicalPreparationOrchestratorCycle(WITHIN_WINDOW_NOW, { probeUniverseSource: TEST_SOURCE });
    const earningsCountAfter = await prisma.earningsCalendarEntry.count();

    expect(optionChainCallCount).toBe(0);
    expect(earningsCountAfter).toBe(earningsCountBefore); // completely untouched
  });

  it("a candidate whose status lookup fails with a stale-record error (the known deleted-mid-selection edge) is skipped safely - another valid connected user is still selected and processed, with no crash and no cross-user provider use", async () => {
    // Matt is connected but his own status lookup throws exactly what the real race produces
    // (ensureMyLstScannerProfileForUser's ScannerProfile.create failing on a foreign key that no
    // longer resolves, because the user row disappeared between the connected-user query and this
    // per-candidate lookup) - Eric is a genuinely healthy, working candidate.
    await createConnectedBrokerRow(matt.id, "matt-stale-candidate");
    await createConnectedBrokerRow(eric.id, "eric-healthy-candidate");
    failingStatusLookupUserIds.set(matt.id, staleCandidateError());
    await seedUniverse(["ORCHSTALE1"]);
    mockProviderForOnly(eric.id, fakeProvider({ quotes: { ORCHSTALE1: { price: 20, volume: 1_000_000 } } }));

    const result = await runTechnicalPreparationOrchestratorCycle(WITHIN_WINDOW_NOW, { probeUniverseSource: TEST_SOURCE });

    expect(result.status).toBe("OK"); // never crashes/throws just because Matt's own lookup failed
    // Eric - the only genuinely eligible candidate - was the one actually processed.
    const ericRuns = await prisma.technicalPreparationRun.count({ where: { userId: eric.id } });
    expect(ericRuns).toBe(1);
    const mattRuns = await prisma.technicalPreparationRun.count({ where: { userId: matt.id } });
    expect(mattRuns).toBe(0); // Matt was never selected - skipped entirely during status collection
    // Matt's own (unavailable-by-default) provider was never even consulted - he was filtered out
    // before candidate ranking/selection ever reached the provider-resolution step.
    expect(resolveMarketDataProviderForUserMock).not.toHaveBeenCalledWith(matt.id);
    expect(resolveMarketDataProviderForUserMock).toHaveBeenCalledWith(eric.id);
  });

  it("a genuinely systemic status-lookup failure (not the known stale-record shape) is never silently swallowed - it still surfaces as a real failure rather than reporting a clean no-op", async () => {
    await createConnectedBrokerRow(matt.id, "matt-systemic-failure");
    // No `code` at all - a generic/unclassified error must never be mistaken for the narrow
    // stale-candidate case (P2003/P2025) and silently treated as "just skip this one."
    failingStatusLookupUserIds.set(matt.id, new Error("connection pool exhausted"));
    await seedUniverse(["ORCHSYS1"]);
    mockProviderForOnly(matt.id, fakeProvider({ quotes: { ORCHSYS1: { price: 20, volume: 1_000_000 } } }));

    await expect(runTechnicalPreparationOrchestratorCycle(WITHIN_WINDOW_NOW, { probeUniverseSource: TEST_SOURCE })).rejects.toThrow("connection pool exhausted");
  });

  describe("Saturday catch-up window (weekend scanner-readiness gap, see PROJECT_HANDOFF.md)", () => {
    // Sat Sep 12 2026, 8:00 AM ET = 12:00 UTC - inside the new Saturday catch-up window. The
    // required market date at this instant is Friday Sep 11 (proven directly against
    // previousNyseMarketDay in marketCalendar.test.ts) - never fabricated here, computed fresh.
    const SATURDAY_WINDOW_NOW = new Date("2026-09-12T12:00:00Z");

    function providerWithHistoryEndingOn(
      quotes: Record<string, { price: number; volume: number }>,
      endDate: Date,
      hooks: { onGetQuotes?: (symbols: string[]) => void; onGetPriceHistory?: (ticker: string) => void } = {},
    ): MarketDataProvider {
      const quotesByTicker = new Map<string, MarketQuote>(
        Object.entries(quotes).map(([ticker, { price, volume }]) => [ticker, { symbol: ticker, price, volume, asOf: new Date() }]),
      );
      return {
        async getQuote(symbol) {
          const quote = quotesByTicker.get(symbol.toUpperCase());
          if (!quote) throw new Error(`no quote for ${symbol}`);
          return quote;
        },
        async getQuotes(symbols) {
          hooks.onGetQuotes?.(symbols);
          const result = new Map<string, MarketQuote>();
          for (const symbol of symbols) {
            const quote = quotesByTicker.get(symbol.toUpperCase());
            if (quote) result.set(symbol.toUpperCase(), quote);
          }
          return result;
        },
        async getPriceHistory(symbol) {
          hooks.onGetPriceHistory?.(symbol);
          return syntheticCandles(symbol, 80, endDate);
        },
        async getOptionChain() {
          return [];
        },
        async getInstrument(symbol) {
          return { symbol, description: symbol, assetType: "EQUITY" };
        },
        async getMarketHours() {
          return { isOpen: true };
        },
      };
    }

    it("the window itself is open on Saturday morning (confirms the schedule addition, not just the pure unit test)", () => {
      // Redundant with technical-preparation-orchestrator.test.ts's own dedicated fixtures, but
      // worth asserting here too since this whole describe block depends on it being true.
      expect(SATURDAY_WINDOW_NOW.getUTCDay()).toBe(6); // Saturday
    });

    it("a not-ready gate on Saturday costs only the probe and creates no run - identical behavior to the weekday gate, using the real required date (Friday Sep 11)", async () => {
      await createConnectedBrokerRow(matt.id, "matt-saturday-not-ready");
      const tickers = ["ORCHSATSTALE0", "ORCHSATSTALE1", "ORCHSATSTALE2"];
      await seedUniverse(tickers);
      const { previousNyseMarketDay } = await import("@/domain/finance/marketCalendar");
      const requiredMarketDate = previousNyseMarketDay(SATURDAY_WINDOW_NOW); // Friday Sep 11
      expect(requiredMarketDate.toISOString().slice(0, 10)).toBe("2026-09-11");
      const laggedDate = previousNyseMarketDay(requiredMarketDate); // Thursday Sep 10 - one trading day short

      let getQuotesCallCount = 0;
      const provider = providerWithHistoryEndingOn(
        Object.fromEntries(tickers.map((t) => [t, { price: 20, volume: 1_000_000 }])),
        laggedDate,
        { onGetQuotes: () => (getQuotesCallCount += 1) },
      );
      mockProviderForOnly(matt.id, provider);

      const result = await runTechnicalPreparationOrchestratorCycle(SATURDAY_WINDOW_NOW, { probeUniverseSource: TEST_SOURCE });
      expect(result.status).toBe("DAILY_CANDLE_NOT_READY");
      expect(getQuotesCallCount).toBe(0); // Stage A's own bulk quote sweep never ran
      const runCount = await prisma.technicalPreparationRun.count({ where: { userId: matt.id } });
      expect(runCount).toBe(0);
    });

    it("a ready gate on Saturday runs normal price-only technical preparation for Friday - and Sunday's own live-scan-style read reuses that same fresh Friday snapshot with zero further preparation work", async () => {
      await createConnectedBrokerRow(matt.id, "matt-saturday-ready");
      const tickers = ["ORCHSATOK0", "ORCHSATOK1", "ORCHSATOK2"];
      await seedUniverse(tickers);
      const { previousNyseMarketDay } = await import("@/domain/finance/marketCalendar");
      const requiredMarketDate = previousNyseMarketDay(SATURDAY_WINDOW_NOW); // Friday Sep 11

      const provider = providerWithHistoryEndingOn(
        Object.fromEntries(tickers.map((t) => [t, { price: 20, volume: 1_000_000 }])),
        requiredMarketDate,
      );
      mockProviderForOnly(matt.id, provider);

      const result = await runTechnicalPreparationOrchestratorCycle(SATURDAY_WINDOW_NOW, { probeUniverseSource: TEST_SOURCE });
      expect(result.status).toBe("OK");
      if (result.status !== "OK") throw new Error("expected OK");
      expect(result.succeededCount).toBe(tickers.length);

      const snapshots = await prisma.technicalIndicatorSnapshot.findMany({ where: { userId: matt.id, ticker: { in: tickers } } });
      expect(snapshots).toHaveLength(tickers.length);
      for (const snapshot of snapshots) {
        expect(snapshot.status).toBe("READY");
        expect(snapshot.asOfDate?.toISOString().slice(0, 10)).toBe("2026-09-11");
      }

      // Sunday Sep 13, any time - the live scan's own read path (never the orchestrator, never a
      // provider call) sees Saturday's Friday-dated snapshot as fresh with zero further work.
      const { getTechnicalIndicatorSnapshotsForUser } = await import("./technical-indicator-cache");
      const sundayNow = new Date("2026-09-13T16:00:00Z");
      const sundayView = await getTechnicalIndicatorSnapshotsForUser(matt.id, tickers, sundayNow);
      for (const ticker of tickers) {
        expect(sundayView.get(ticker)?.state).toBe("READY");
      }

      // A second orchestrator invocation on the SAME Saturday (simulating a later 5-minute tick)
      // must not re-sweep Stage A or duplicate the run - it just finds the already-complete run.
      let secondCallGetQuotesCount = 0;
      const secondProvider = providerWithHistoryEndingOn(
        Object.fromEntries(tickers.map((t) => [t, { price: 20, volume: 1_000_000 }])),
        requiredMarketDate,
        { onGetQuotes: () => (secondCallGetQuotesCount += 1) },
      );
      mockProviderForOnly(matt.id, secondProvider);
      const later = new Date(SATURDAY_WINDOW_NOW.getTime() + 5 * 60 * 1000);
      const secondResult = await runTechnicalPreparationOrchestratorCycle(later, { probeUniverseSource: TEST_SOURCE });
      // Already COMPLETE for this generation - no eligible user needs further work.
      expect(secondResult.status).toBe("NO_ELIGIBLE_USER");
      expect(secondCallGetQuotesCount).toBe(0);
      const runCount = await prisma.technicalPreparationRun.count({ where: { userId: matt.id } });
      expect(runCount).toBe(1); // never duplicated
    });
  });
});
