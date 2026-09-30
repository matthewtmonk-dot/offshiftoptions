import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshPositionEvidenceForUser } from "./workflows";
import { clearBrokerReadCacheForTests, clearBrokerReadCacheForUser, withBrokerReadCache } from "@/providers/broker-read/cache";
import { clearMarketDataCacheForTests, clearMarketDataCacheForUser } from "@/providers/market-data/cache";
import type { BrokerReadProvider } from "@/providers/broker-read/types";
import type { MarketDataProvider } from "@/providers/market-data/types";

/**
 * Post-Phase-2 UX follow-up ("Universal Refresh Status" - end-to-end abandonment repair) - a real,
 * integration-style reproduction of Codex's exact finding: a manual refresh generation whose
 * connection/token-resolution stage (NOT abort-aware - see refreshPositionEvidenceForUser's own doc
 * comment) is held pending past its own deadline must never, upon finally resolving, go on to clear
 * or publish evidence over a NEWER generation's already-fresher caches.
 *
 * Deliberately its own file, separate from workflows.test.ts's `vi.mock("./broker-connections", ...)`
 * setup: this test needs `clearSchwabBrokerReadCacheForUser`/`clearSchwabMarketDataCacheForUser` to
 * be the REAL cache-clearing functions (not bare spies) and the resolved providers to be wrapped by
 * the REAL `withBrokerReadCache`/`withMarketDataCache`, so the actual cache modules - not a mock -
 * are what proves the abandoned generation can never corrupt them.
 */
vi.mock("./broker-connections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./broker-connections")>();
  return {
    ...actual,
    getSchwabConnectionSummaryForUser: vi.fn(),
    getSchwabBrokerReadProviderForUser: vi.fn(),
    getSchwabMarketDataProviderForUser: vi.fn(),
    // REAL implementations - see this file's own doc comment above.
    clearSchwabBrokerReadCacheForUser: (userId: string) => clearBrokerReadCacheForUser(userId),
    clearSchwabMarketDataCacheForUser: (userId: string) => clearMarketDataCacheForUser(userId),
  };
});

vi.mock("./prisma", () => ({ prisma: { campaign: { findMany: vi.fn() } } }));
// "./live-quotes" is deliberately NOT mocked here - its real implementation calls
// getSchwabMarketDataProviderForUser (mocked above to return a REAL cache-wrapped fake provider),
// so getQuoteReviewEvidenceForUser/getEquityMarketSessionEvidenceForUser genuinely exercise the
// real market-data cache too.

function connectedSummary() {
  return {
    id: "connection-1",
    label: "Schwab",
    status: "CONNECTED",
    connected: true,
    expiresAt: null,
    updatedAt: new Date(),
    accountCount: 1,
    accountNumberLast4s: ["1234"],
    accountDiscoveryStatus: null,
    lastSuccessfulRefreshAt: null,
    lastRefreshFailureAt: null,
    lastRefreshFailureReason: null,
    lastAccountSyncAt: null,
    lastAccountSyncFailureAt: null,
    lastAccountSyncFailureReason: null,
  };
}

function fakeBrokerReadProvider(getAccountsSpy: () => Promise<unknown[]>): BrokerReadProvider {
  return {
    getAccounts: async () => (await getAccountsSpy()) as never,
    getAccount: async () => null,
    getPositions: async () => [],
    getTransactions: async () => ({ transactions: [], categories: { TRADE: { status: "OK", count: 0 }, RECEIVE_AND_DELIVER: { status: "OK", count: 0 }, DIVIDEND_OR_INTEREST: { status: "OK", count: 0 } } }),
    getOrders: async () => [],
  };
}

describe("Post-Phase-2 UX follow-up (end-to-end abandonment repair) - stale-generation cache reproduction (Codex's exact finding)", () => {
  beforeEach(() => {
    clearBrokerReadCacheForTests();
    clearMarketDataCacheForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    clearBrokerReadCacheForTests();
    clearMarketDataCacheForTests();
  });

  it("a generation whose connection lookup resolves AFTER its own abort can never clear/publish evidence over a newer generation's real result", async () => {
    const brokerConnections = await import("./broker-connections");
    const getSchwabConnectionSummaryForUser = vi.mocked(brokerConnections.getSchwabConnectionSummaryForUser);
    const getSchwabBrokerReadProviderForUser = vi.mocked(brokerConnections.getSchwabBrokerReadProviderForUser);
    const getSchwabMarketDataProviderForUser = vi.mocked(brokerConnections.getSchwabMarketDataProviderForUser);
    const { prisma } = await import("./prisma");
    vi.mocked(prisma.campaign.findMany).mockResolvedValue([]); // no active positions - isolates this test to the broker-evidence stage

    // Generation 1's connection lookup is held pending - this is the exact reproduction: the
    // connection/token-resolution stage is not abort-aware, so only refreshPositionEvidenceForUser's
    // own explicit `signal.throwIfAborted()` check (right after this resolves) can stop it.
    let resolveGen1Connection: ((value: ReturnType<typeof connectedSummary>) => void) | undefined;
    getSchwabConnectionSummaryForUser.mockImplementationOnce(
      () => new Promise((resolve) => { resolveGen1Connection = resolve as never; }),
    );
    // Every call after generation 1's (i.e. generation 2's) resolves immediately.
    getSchwabConnectionSummaryForUser.mockResolvedValue(connectedSummary() as never);

    let accountsCalls = 0;
    const brokerCacheKey = "schwab:user:matt:connection:test";
    const cachedBrokerProvider = withBrokerReadCache(
      fakeBrokerReadProvider(async () => {
        accountsCalls += 1;
        return [{ id: "acct-1", label: "Individual", accountValue: 10_000, cash: 500, liquidationValue: 10_000 }];
      }),
      brokerCacheKey,
    );
    getSchwabBrokerReadProviderForUser.mockResolvedValue(cachedBrokerProvider);
    getSchwabMarketDataProviderForUser.mockResolvedValue({
      getQuote: async () => { throw new Error("not used in this test"); },
    } as unknown as MarketDataProvider);

    // Generation 1 starts - immediately blocks on the connection lookup above. Its own signal is
    // aborted right away, simulating the guard having already declared TIMEOUT for it.
    const gen1Controller = new AbortController();
    const gen1Promise = refreshPositionEvidenceForUser("matt", gen1Controller.signal);
    gen1Controller.abort();

    // Generation 2 starts and runs to completion while generation 1 is still stuck.
    const gen2Controller = new AbortController();
    const gen2Result = await refreshPositionEvidenceForUser("matt", gen2Controller.signal);

    expect(gen2Result.ok).toBe(true);
    expect(accountsCalls).toBe(1); // generation 2's own real, single Schwab fetch

    // Release generation 1's long-pending connection lookup ONLY NOW, after generation 2 finished.
    resolveGen1Connection!(connectedSummary());
    const gen1Result = await gen1Promise;

    // Generation 1 must never have proceeded past its own connection lookup: no second cache clear,
    // no accounts fetch of its own, no altered result of any kind attributable to it.
    expect(accountsCalls).toBe(1); // still exactly one - generation 1 never called getAccounts at all
    expect(gen1Result.ok).toBe(false); // it can never report success for evidence it never fetched

    // Reading the cache again afterward must still serve generation 2's real, already-cached result -
    // never a second live fetch, and never anything generation 1 could have written (it wrote nothing).
    const afterBoth = await cachedBrokerProvider.getAccounts();
    expect(afterBoth).toEqual([{ id: "acct-1", label: "Individual", accountValue: 10_000, cash: 500, liquidationValue: 10_000 }]);
    expect(accountsCalls).toBe(1); // served from cache - generation 2's evidence is still there, untouched
  });
});
