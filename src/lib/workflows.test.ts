import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildLiveScanFailureMessage,
  buildSchwabRecordsToPersist,
  clearRefreshPositionEvidenceGuardsForTests,
  fetchSchwabAccountActivity,
  refreshPositionEvidenceForUser,
  refreshPositionEvidenceForUserGuarded,
} from "./workflows";
import type { BrokerReadProvider, BrokerTransaction } from "@/providers/broker-read/types";
import { SchwabApiError } from "@/providers/schwab/client";

vi.mock("./broker-connections", async (importOriginal) => {
  // Only the 4 functions refreshPositionEvidenceForUser itself calls are mocked - every other
  // export (categorizeSchwabSyncError, etc.) keeps its REAL implementation, since
  // fetchSchwabAccountActivity's own existing tests below depend on it genuinely categorizing errors.
  const actual = await importOriginal<typeof import("./broker-connections")>();
  return {
    ...actual,
    clearSchwabBrokerReadCacheForUser: vi.fn(),
    clearSchwabMarketDataCacheForUser: vi.fn(),
    getSchwabBrokerReadProviderForUser: vi.fn(),
    getSchwabConnectionSummaryForUser: vi.fn(),
  };
});

vi.mock("./prisma", () => ({ prisma: { campaign: { findMany: vi.fn() } } }));
vi.mock("./live-quotes", () => ({ getQuoteReviewEvidenceForUser: vi.fn(), getEquityMarketSessionEvidenceForUser: vi.fn() }));

describe("buildLiveScanFailureMessage", () => {
  it("reports LIVE DATA UNAVAILABLE when nothing was persisted before the failure", () => {
    const message = buildLiveScanFailureMessage("EVALUATE", false, 0);
    expect(message).toContain("LIVE DATA UNAVAILABLE");
    expect(message).toContain("stage: EVALUATE");
    expect(message).not.toContain("saved");
  });

  it("honestly reports that results were saved when a later stage fails after persistence - never implying the whole scan produced nothing", () => {
    const message = buildLiveScanFailureMessage("BUILD_RESPONSE", true, 137);
    expect(message).toContain("saved 137 results");
    expect(message).toContain("stage: BUILD_RESPONSE");
    expect(message).not.toContain("LIVE DATA UNAVAILABLE");
  });

  it("uses singular 'result' for exactly one persisted row", () => {
    const message = buildLiveScanFailureMessage("FUNDAMENTALS_SYNC", true, 1);
    expect(message).toContain("saved 1 result ");
    expect(message).not.toContain("1 results");
  });

  it("never includes a raw error, stack trace, token, or provider payload - only a fixed-vocabulary stage name and a count", () => {
    const message = buildLiveScanFailureMessage("PERSIST_RESULTS", true, 42);
    expect(message).not.toMatch(/at \S+\.(ts|js):\d+/); // no stack-trace-shaped text
    expect(message).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/); // no token/base64-shaped blob
  });
});

function fakeProvider(overrides: Partial<BrokerReadProvider> = {}): BrokerReadProvider {
  return {
    getAccounts: async () => [],
    getAccount: async () => null,
    getPositions: async () => [],
    getTransactions: async () => ({
      transactions: [],
      categories: {
        TRADE: { status: "OK", count: 0 },
        RECEIVE_AND_DELIVER: { status: "OK", count: 0 },
        DIVIDEND_OR_INTEREST: { status: "OK", count: 0 },
      },
    }),
    getOrders: async () => {
      throw new Error("getOrders should never be called by the Schwab sync path");
    },
    ...overrides,
  };
}

describe("fetchSchwabAccountActivity", () => {
  it("a transactions failure does not erase successfully fetched positions", async () => {
    const provider = fakeProvider({
      getPositions: async () => [{ accountId: "acct-1", symbol: "APLD", quantity: -1, marketValue: -28 }],
      getTransactions: async () => {
        throw new Error("Schwab request failed.");
      },
    });

    const result = await fetchSchwabAccountActivity(provider, "acct-1", new Date("2026-08-01"), new Date("2026-08-31"));

    expect(result.positionsStatus).toBe("OK");
    expect(result.positions).toHaveLength(1);
    expect(result.transactions).toEqual([]);
    expect(result.transactionCategories).toBeNull();
    expect(result.evidence.transactions.status).toBe("FAILED");
    expect(result.evidence.positions.status).toBe("COMPLETE");
  });

  it("a positions failure does not erase successfully fetched transactions", async () => {
    const provider = fakeProvider({
      getPositions: async () => {
        throw new Error("Schwab request failed.");
      },
      getTransactions: async () => ({
        transactions: [
          { id: "t1", accountId: "acct-1", amount: 28, occurredAt: new Date("2026-08-28"), description: "Sell to Open" },
        ],
        categories: {
          TRADE: { status: "OK", count: 1 },
          RECEIVE_AND_DELIVER: { status: "OK", count: 0 },
          DIVIDEND_OR_INTEREST: { status: "OK", count: 0 },
        },
      }),
    });

    const result = await fetchSchwabAccountActivity(provider, "acct-1", new Date("2026-08-01"), new Date("2026-08-31"));

    expect(result.positionsStatus).toBe("ERROR");
    expect(result.positions).toEqual([]);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactionCategories?.TRADE).toEqual({ status: "OK", count: 1 });
  });

  it("one failed transaction category does not erase another successful category (via getTransactions' own result)", async () => {
    const provider = fakeProvider({
      getTransactions: async () => ({
        transactions: [
          { id: "t1", accountId: "acct-1", amount: 28, occurredAt: new Date("2026-08-28"), description: "Sell to Open" },
        ],
        categories: {
          TRADE: { status: "OK", count: 1 },
          RECEIVE_AND_DELIVER: { status: "OK", count: 0 },
          DIVIDEND_OR_INTEREST: { status: "ERROR" },
        },
      }),
    });

    const result = await fetchSchwabAccountActivity(provider, "acct-1", new Date("2026-08-01"), new Date("2026-08-31"));

    expect(result.transactions).toHaveLength(1);
    expect(result.transactionCategories?.TRADE).toEqual({ status: "OK", count: 1 });
    expect(result.transactionCategories?.DIVIDEND_OR_INTEREST).toEqual({ status: "ERROR" });
    expect(result.evidence.transactions.status).toBe("PARTIAL");
  });

  it("records a safe, sanitized error category for a positions failure - never a raw provider message", async () => {
    const provider = fakeProvider({
      getPositions: async () => {
        throw new SchwabApiError("Schwab authorization is expired or unavailable.", 401);
      },
    });

    const result = await fetchSchwabAccountActivity(provider, "acct-1", new Date("2026-08-01"), new Date("2026-08-31"));

    expect(result.positionsStatus).toBe("ERROR");
    expect(result.positionsErrorCode).toBe("unauthorized");
    expect(result.transactionsErrorCode).toBeNull();
  });

  it("records a safe, sanitized error category for a total transactions failure - never a raw provider message", async () => {
    const provider = fakeProvider({
      getTransactions: async () => {
        throw new SchwabApiError("Schwab rate limit reached.", 429);
      },
    });

    const result = await fetchSchwabAccountActivity(provider, "acct-1", new Date("2026-08-01"), new Date("2026-08-31"));

    expect(result.transactionCategories).toBeNull();
    expect(result.transactionsErrorCode).toBe("rate_limited");
    expect(result.positionsErrorCode).toBeNull();
  });

  it("categorizes an unrecognized 4xx SchwabApiError as provider_rejected", async () => {
    const provider = fakeProvider({
      getPositions: async () => {
        throw new SchwabApiError("Schwab request failed.", 400);
      },
    });

    const result = await fetchSchwabAccountActivity(provider, "acct-1", new Date("2026-08-01"), new Date("2026-08-31"));

    expect(result.positionsErrorCode).toBe("provider_rejected");
  });

  it("categorizes a non-SchwabApiError failure as network_or_unexpected rather than fabricating a more specific code", async () => {
    const provider = fakeProvider({
      getPositions: async () => {
        throw new Error("socket hang up");
      },
    });

    const result = await fetchSchwabAccountActivity(provider, "acct-1", new Date("2026-08-01"), new Date("2026-08-31"));

    expect(result.positionsErrorCode).toBe("network_or_unexpected");
  });

  it("an honest empty success is distinguishable from a failure - both can show 0 received, but only one is an error", async () => {
    const emptySuccessProvider = fakeProvider(); // default fake: 0 positions, 0 transactions, no throw
    const emptySuccess = await fetchSchwabAccountActivity(emptySuccessProvider, "acct-1", new Date("2026-08-01"), new Date("2026-08-31"));
    expect(emptySuccess.positions).toHaveLength(0);
    expect(emptySuccess.positionsStatus).toBe("OK");
    expect(emptySuccess.positionsErrorCode).toBeNull();
    expect(emptySuccess.evidence.positions).toEqual({ status: "COMPLETE", data: [] });
    expect(emptySuccess.evidence.transactions.status).toBe("COMPLETE");

    const failedProvider = fakeProvider({
      getPositions: async () => {
        throw new SchwabApiError("Schwab request failed.", 500);
      },
    });
    const failed = await fetchSchwabAccountActivity(failedProvider, "acct-1", new Date("2026-08-01"), new Date("2026-08-31"));
    expect(failed.positions).toHaveLength(0); // same observable count as the honest empty success above
    expect(failed.positionsStatus).toBe("ERROR"); // but the status makes the difference explicit
    expect(failed.positionsErrorCode).toBe("provider_unavailable");
    expect(failed.evidence.positions).toEqual({ status: "FAILED", data: [] });
  });

  it("never calls getOrders() - Orders stays diagnostic-only, not part of the sync path", async () => {
    let ordersCalled = false;
    const provider = fakeProvider({
      getOrders: async () => {
        ordersCalled = true;
        return [];
      },
    });

    await fetchSchwabAccountActivity(provider, "acct-1", new Date("2026-08-01"), new Date("2026-08-31"));

    expect(ordersCalled).toBe(false);
  });
});

describe("buildSchwabRecordsToPersist", () => {
  it("merges the same real-world activity when it surfaces under two different transaction categories, instead of persisting it twice", () => {
    // Transactions are now fetched via three independent category requests (TRADE /
    // RECEIVE_AND_DELIVER / DIVIDEND_OR_INTEREST). A single real activity - e.g. an
    // assignment, which touches both an option leg and a delivery leg - can legitimately be
    // echoed under more than one category. Both share the same account/date/symbol/description/
    // amount, so they must fingerprint identically and merge into one record, not two.
    const shared = {
      accountId: "acct-1",
      occurredAt: new Date("2026-09-04T21:00:00Z"),
      symbol: "APLD 260904P00023500",
      description: "Option Assignment",
      amount: 0,
    };
    const fromTradeCategory: BrokerTransaction = { id: "activity-1", ...shared, action: "Assignment" };
    const fromReceiveAndDeliverCategory: BrokerTransaction = { id: "activity-1-echo", ...shared, action: null };

    const records = buildSchwabRecordsToPersist([], [fromTradeCategory, fromReceiveAndDeliverCategory], new Date("2026-09-05"));

    expect(records).toHaveLength(1);
    expect(records[0].kind).toBe("TRANSACTION");
  });

  it("does not merge two genuinely different transactions", () => {
    const first: BrokerTransaction = {
      id: "activity-1",
      accountId: "acct-1",
      occurredAt: new Date("2026-08-24T13:30:00Z"),
      symbol: "CORZ 260904P00016500",
      description: "Sell to Open",
      amount: 26,
      action: "Sell to Open",
    };
    const second: BrokerTransaction = {
      id: "activity-2",
      accountId: "acct-1",
      occurredAt: new Date("2026-08-28T13:32:00Z"),
      symbol: "CORZ 260904P00016500",
      description: "Buy to Close",
      amount: -23,
      action: "Buy to Close",
    };

    const records = buildSchwabRecordsToPersist([], [first, second], new Date("2026-09-05"));

    expect(records).toHaveLength(2);
  });
});

describe("Post-Phase-2 UX follow-up (correctness repair) - refreshPositionEvidenceForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRefreshPositionEvidenceGuardsForTests();
  });

  async function mocks() {
    const brokerConnections = await import("./broker-connections");
    const { prisma } = await import("./prisma");
    const liveQuotes = await import("./live-quotes");
    return {
      getSchwabConnectionSummaryForUser: vi.mocked(brokerConnections.getSchwabConnectionSummaryForUser),
      clearSchwabBrokerReadCacheForUser: vi.mocked(brokerConnections.clearSchwabBrokerReadCacheForUser),
      clearSchwabMarketDataCacheForUser: vi.mocked(brokerConnections.clearSchwabMarketDataCacheForUser),
      getSchwabBrokerReadProviderForUser: vi.mocked(brokerConnections.getSchwabBrokerReadProviderForUser),
      campaignFindMany: vi.mocked(prisma.campaign.findMany),
      getQuoteReviewEvidenceForUser: vi.mocked(liveQuotes.getQuoteReviewEvidenceForUser),
      getEquityMarketSessionEvidenceForUser: vi.mocked(liveQuotes.getEquityMarketSessionEvidenceForUser),
    };
  }

  function connectedSummary(overrides: Partial<Awaited<ReturnType<typeof import("./broker-connections").getSchwabConnectionSummaryForUser>>> = {}) {
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
      ...overrides,
    };
  }

  function fakeReadProvider(overrides: Partial<BrokerReadProvider> = {}): BrokerReadProvider {
    return {
      getAccounts: async () => [],
      getAccount: async () => null,
      getPositions: async () => [],
      getTransactions: async () => ({
        transactions: [],
        categories: { TRADE: { status: "OK", count: 0 }, RECEIVE_AND_DELIVER: { status: "OK", count: 0 }, DIVIDEND_OR_INTEREST: { status: "OK", count: 0 } },
      }),
      getOrders: async () => [],
      ...overrides,
    };
  }

  // A single OPEN cash-secured-put campaign, ticker UPST - the exact minimal shape that requires
  // review evidence (position-review-scope.ts's resolveRelevantCampaignLegs would give it a real
  // "PUT" leg, so UPST ends up in tickersNeedingReviewQuotes).
  function openPutCampaign(overrides: Partial<{ id: string; ticker: string }> = {}) {
    return {
      id: overrides.id ?? "campaign-1",
      ownerId: "matt",
      accountId: "account-1",
      ticker: overrides.ticker ?? "UPST",
      status: "OPEN",
      events: [
        {
          type: "SELL_PUT",
          occurredAt: new Date("2026-05-01T00:00:00.000Z"),
          optionType: "PUT",
          contracts: 1,
          strike: 25,
          expiration: new Date("2026-10-02T00:00:00.000Z"),
          premium: 1,
        },
      ],
    };
  }

  function connectedWithNoCampaigns(m: Awaited<ReturnType<typeof mocks>>) {
    m.getSchwabConnectionSummaryForUser.mockResolvedValue(connectedSummary() as never);
    m.getSchwabBrokerReadProviderForUser.mockResolvedValue(fakeReadProvider());
    m.campaignFindMany.mockResolvedValue([]);
  }

  it("is NO_CONNECTION when the user has no Schwab connection at all", async () => {
    const m = await mocks();
    m.getSchwabConnectionSummaryForUser.mockResolvedValue(null);

    const result = await refreshPositionEvidenceForUser("matt");

    expect(result).toEqual({ ok: false, reason: "NO_CONNECTION" });
    // Never even attempts to clear caches or fetch positions when there's nothing to refresh.
    expect(m.clearSchwabBrokerReadCacheForUser).not.toHaveBeenCalled();
  });

  it("is NO_CONNECTION when a connection row exists but is not itself connected", async () => {
    const m = await mocks();
    m.getSchwabConnectionSummaryForUser.mockResolvedValue(connectedSummary({ connected: false, status: "DISCONNECTED" }) as never);

    const result = await refreshPositionEvidenceForUser("matt");

    expect(result).toEqual({ ok: false, reason: "NO_CONNECTION" });
  });

  it("is BROKER_REFRESH_FAILED when the connection exists but the live positions fetch fails", async () => {
    const m = await mocks();
    m.getSchwabConnectionSummaryForUser.mockResolvedValue(connectedSummary() as never);
    m.getSchwabBrokerReadProviderForUser.mockResolvedValue(fakeReadProvider({ getAccounts: async () => { throw new Error("Schwab unavailable"); } }));

    const result = await refreshPositionEvidenceForUser("matt");

    expect(result).toEqual({ ok: false, reason: "BROKER_REFRESH_FAILED" });
  });

  it("succeeds (no active positions needing review) and returns only a timestamp - never a campaign/position/transaction count of any kind", async () => {
    const m = await mocks();
    connectedWithNoCampaigns(m);

    const result = await refreshPositionEvidenceForUser("matt");

    expect(result.ok).toBe(true);
    expect(result).toEqual({ ok: true, refreshedAt: expect.any(String) });
    expect(Object.keys(result)).toEqual(["ok", "refreshedAt"]); // no campaignsUpdated/positions/etc.
  });

  describe("Fix #1 - success genuinely requires fresh quote/session evidence, not just positions", () => {
    it("gets fresh broker positions as part of a successful refresh", async () => {
      const m = await mocks();
      const getAccounts = vi.fn(async () => [{ id: "acct-1", label: "Individual", accountValue: 10_000, cash: 500, liquidationValue: 10_000 }]);
      m.getSchwabConnectionSummaryForUser.mockResolvedValue(connectedSummary() as never);
      m.getSchwabBrokerReadProviderForUser.mockResolvedValue(fakeReadProvider({ getAccounts }));
      m.campaignFindMany.mockResolvedValue([]);

      const result = await refreshPositionEvidenceForUser("matt");

      expect(getAccounts).toHaveBeenCalled();
      expect(result.ok).toBe(true);
    });

    it("gets required current quote evidence for the active owner-scoped ticker before reporting success", async () => {
      const m = await mocks();
      m.getSchwabConnectionSummaryForUser.mockResolvedValue(connectedSummary() as never);
      m.getSchwabBrokerReadProviderForUser.mockResolvedValue(fakeReadProvider());
      m.campaignFindMany.mockResolvedValue([openPutCampaign()] as never);
      m.getQuoteReviewEvidenceForUser.mockResolvedValue(new Map([["UPST", { status: "AVAILABLE" }]]) as never);
      m.getEquityMarketSessionEvidenceForUser.mockResolvedValue({ status: "AVAILABLE" } as never);

      const result = await refreshPositionEvidenceForUser("matt");

      expect(m.getQuoteReviewEvidenceForUser).toHaveBeenCalledWith("matt", ["UPST"]);
      expect(result.ok).toBe(true);
    });

    it("gets required session evidence for today's NY date before reporting success", async () => {
      const m = await mocks();
      m.getSchwabConnectionSummaryForUser.mockResolvedValue(connectedSummary() as never);
      m.getSchwabBrokerReadProviderForUser.mockResolvedValue(fakeReadProvider());
      m.campaignFindMany.mockResolvedValue([openPutCampaign()] as never);
      m.getQuoteReviewEvidenceForUser.mockResolvedValue(new Map([["UPST", { status: "AVAILABLE" }]]) as never);
      m.getEquityMarketSessionEvidenceForUser.mockResolvedValue({ status: "AVAILABLE" } as never);

      await refreshPositionEvidenceForUser("matt");

      expect(m.getEquityMarketSessionEvidenceForUser).toHaveBeenCalledWith("matt", expect.any(String));
    });

    it("success is not returned before quote/session retrieval finishes - both are awaited, not fired-and-forgotten", async () => {
      const m = await mocks();
      m.getSchwabConnectionSummaryForUser.mockResolvedValue(connectedSummary() as never);
      m.getSchwabBrokerReadProviderForUser.mockResolvedValue(fakeReadProvider());
      m.campaignFindMany.mockResolvedValue([openPutCampaign()] as never);

      let quoteResolved = false;
      m.getQuoteReviewEvidenceForUser.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => {
              quoteResolved = true;
              resolve(new Map([["UPST", { status: "AVAILABLE" }]]) as never);
            }, 5),
          ),
      );
      m.getEquityMarketSessionEvidenceForUser.mockResolvedValue({ status: "AVAILABLE" } as never);

      const result = await refreshPositionEvidenceForUser("matt");

      expect(quoteResolved).toBe(true); // the quote fetch had genuinely completed by the time this resolved
      expect(result.ok).toBe(true);
    });

    it("a quote failure prevents overall success / a false 'Last checked'", async () => {
      const m = await mocks();
      m.getSchwabConnectionSummaryForUser.mockResolvedValue(connectedSummary() as never);
      m.getSchwabBrokerReadProviderForUser.mockResolvedValue(fakeReadProvider());
      m.campaignFindMany.mockResolvedValue([openPutCampaign()] as never);
      m.getQuoteReviewEvidenceForUser.mockResolvedValue(new Map([["UPST", { status: "UNAVAILABLE", reason: "Schwab quote request failed." }]]) as never);
      m.getEquityMarketSessionEvidenceForUser.mockResolvedValue({ status: "AVAILABLE" } as never);

      const result = await refreshPositionEvidenceForUser("matt");

      expect(result).toEqual({ ok: false, reason: "MARKET_DATA_REFRESH_FAILED" });
    });

    it("a session failure prevents a false success where session evidence is required", async () => {
      const m = await mocks();
      m.getSchwabConnectionSummaryForUser.mockResolvedValue(connectedSummary() as never);
      m.getSchwabBrokerReadProviderForUser.mockResolvedValue(fakeReadProvider());
      m.campaignFindMany.mockResolvedValue([openPutCampaign()] as never);
      m.getQuoteReviewEvidenceForUser.mockResolvedValue(new Map([["UPST", { status: "AVAILABLE" }]]) as never);
      m.getEquityMarketSessionEvidenceForUser.mockResolvedValue({ status: "UNAVAILABLE", reason: "Schwab market-session request failed." } as never);

      const result = await refreshPositionEvidenceForUser("matt");

      expect(result).toEqual({ ok: false, reason: "MARKET_DATA_REFRESH_FAILED" });
    });
  });

  describe("Fix #2/#3 - the forced fresh broker/market-data reads are never bypassed-and-discarded", () => {
    it("never passes bypassCache to getSchwabBrokerReadProviderForUser - the cache is cleared first instead, so the SAME cache is populated with the fresh result", async () => {
      const m = await mocks();
      connectedWithNoCampaigns(m);

      await refreshPositionEvidenceForUser("matt");

      expect(m.clearSchwabBrokerReadCacheForUser).toHaveBeenCalledWith("matt");
      // getSchwabBrokerReadProviderForUser is called via getSchwabOpenPositionsForUser with NO
      // bypassCache option - the mock captures whatever options were actually passed.
      const callArgs = m.getSchwabBrokerReadProviderForUser.mock.calls.at(-1);
      expect(callArgs?.[1]?.bypassCache).not.toBe(true);
    });

    it("clears the market-data cache before fetching quote/session evidence, so that fresh result populates the SAME cache Dashboard/Tracker read from", async () => {
      const m = await mocks();
      m.getSchwabConnectionSummaryForUser.mockResolvedValue(connectedSummary() as never);
      m.getSchwabBrokerReadProviderForUser.mockResolvedValue(fakeReadProvider());
      m.campaignFindMany.mockResolvedValue([openPutCampaign()] as never);
      m.getQuoteReviewEvidenceForUser.mockResolvedValue(new Map([["UPST", { status: "AVAILABLE" }]]) as never);
      m.getEquityMarketSessionEvidenceForUser.mockResolvedValue({ status: "AVAILABLE" } as never);

      await refreshPositionEvidenceForUser("matt");

      expect(m.clearSchwabMarketDataCacheForUser).toHaveBeenCalledWith("matt");
    });
  });

  it("clears the cache for THIS user's own scoped key, never a hardcoded or shared key", async () => {
    const m = await mocks();
    connectedWithNoCampaigns(m);

    await refreshPositionEvidenceForUser("eric");

    expect(m.clearSchwabBrokerReadCacheForUser).toHaveBeenCalledWith("eric");
    expect(m.clearSchwabMarketDataCacheForUser).toHaveBeenCalledWith("eric");
    expect(m.getSchwabConnectionSummaryForUser).toHaveBeenCalledWith("eric");
    expect(m.campaignFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ ownerId: "eric" }) }));
  });

  it("Matt and Eric refreshing independently never cross-contaminate - each call is scoped to its own userId only", async () => {
    const m = await mocks();
    connectedWithNoCampaigns(m);

    await refreshPositionEvidenceForUser("matt");
    await refreshPositionEvidenceForUser("eric");

    expect(m.clearSchwabBrokerReadCacheForUser).toHaveBeenNthCalledWith(1, "matt");
    expect(m.clearSchwabBrokerReadCacheForUser).toHaveBeenNthCalledWith(2, "eric");
    expect(m.clearSchwabMarketDataCacheForUser).toHaveBeenNthCalledWith(1, "matt");
    expect(m.clearSchwabMarketDataCacheForUser).toHaveBeenNthCalledWith(2, "eric");
  });

  it("never fetches transactions, orders, or anything beyond accounts/positions - a successful refresh cannot import history", async () => {
    const m = await mocks();
    m.getSchwabConnectionSummaryForUser.mockResolvedValue(connectedSummary() as never);
    const provider = fakeReadProvider({
      getTransactions: async () => {
        throw new Error("refreshPositionEvidenceForUser must never fetch transactions");
      },
      getOrders: async () => {
        throw new Error("refreshPositionEvidenceForUser must never fetch orders");
      },
    });
    m.getSchwabBrokerReadProviderForUser.mockResolvedValue(provider);
    m.campaignFindMany.mockResolvedValue([]);

    const result = await refreshPositionEvidenceForUser("matt");

    expect(result.ok).toBe(true);
  });

  describe("Failure resilience - an unexpected throw anywhere in the pipeline resolves to a typed failure, never an unhandled rejection", () => {
    it("a provider-resolver throw resolves to BROKER_REFRESH_FAILED", async () => {
      const m = await mocks();
      m.getSchwabConnectionSummaryForUser.mockResolvedValue(connectedSummary() as never);
      m.getSchwabBrokerReadProviderForUser.mockRejectedValue(new Error("resolver exploded"));

      await expect(refreshPositionEvidenceForUser("matt")).resolves.toEqual({ ok: false, reason: "BROKER_REFRESH_FAILED" });
    });

    it("an accounts-fetch throw resolves to BROKER_REFRESH_FAILED", async () => {
      const m = await mocks();
      m.getSchwabConnectionSummaryForUser.mockResolvedValue(connectedSummary() as never);
      m.getSchwabBrokerReadProviderForUser.mockResolvedValue(fakeReadProvider({ getAccounts: async () => { throw new Error("boom"); } }));

      await expect(refreshPositionEvidenceForUser("matt")).resolves.toEqual({ ok: false, reason: "BROKER_REFRESH_FAILED" });
    });

    it("a positions-fetch throw resolves to BROKER_REFRESH_FAILED", async () => {
      const m = await mocks();
      m.getSchwabConnectionSummaryForUser.mockResolvedValue(connectedSummary() as never);
      m.getSchwabBrokerReadProviderForUser.mockResolvedValue(
        fakeReadProvider({ getAccounts: async () => [{ id: "acct-1", label: "Individual", accountValue: 1, cash: 1, liquidationValue: 1 }], getPositions: async () => { throw new Error("boom"); } }),
      );

      await expect(refreshPositionEvidenceForUser("matt")).resolves.toEqual({ ok: false, reason: "BROKER_REFRESH_FAILED" });
    });

    it("a quote-fetch throw resolves to a typed failure, never an unhandled rejection", async () => {
      const m = await mocks();
      m.getSchwabConnectionSummaryForUser.mockResolvedValue(connectedSummary() as never);
      m.getSchwabBrokerReadProviderForUser.mockResolvedValue(fakeReadProvider());
      m.campaignFindMany.mockResolvedValue([openPutCampaign()] as never);
      m.getQuoteReviewEvidenceForUser.mockRejectedValue(new Error("quote provider exploded"));
      m.getEquityMarketSessionEvidenceForUser.mockResolvedValue({ status: "AVAILABLE" } as never);

      await expect(refreshPositionEvidenceForUser("matt")).resolves.toEqual({ ok: false, reason: "BROKER_REFRESH_FAILED" });
    });

    it("a session-fetch throw resolves to a typed failure, never an unhandled rejection", async () => {
      const m = await mocks();
      m.getSchwabConnectionSummaryForUser.mockResolvedValue(connectedSummary() as never);
      m.getSchwabBrokerReadProviderForUser.mockResolvedValue(fakeReadProvider());
      m.campaignFindMany.mockResolvedValue([openPutCampaign()] as never);
      m.getQuoteReviewEvidenceForUser.mockResolvedValue(new Map([["UPST", { status: "AVAILABLE" }]]) as never);
      m.getEquityMarketSessionEvidenceForUser.mockRejectedValue(new Error("session provider exploded"));

      await expect(refreshPositionEvidenceForUser("matt")).resolves.toEqual({ ok: false, reason: "BROKER_REFRESH_FAILED" });
    });
  });
});

describe("Post-Phase-2 UX follow-up (correctness repair) - refreshPositionEvidenceForUserGuarded (per-user in-flight + cooldown)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRefreshPositionEvidenceGuardsForTests();
  });

  async function mocks() {
    const brokerConnections = await import("./broker-connections");
    const { prisma } = await import("./prisma");
    return {
      getSchwabConnectionSummaryForUser: vi.mocked(brokerConnections.getSchwabConnectionSummaryForUser),
      getSchwabBrokerReadProviderForUser: vi.mocked(brokerConnections.getSchwabBrokerReadProviderForUser),
      campaignFindMany: vi.mocked(prisma.campaign.findMany),
    };
  }

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

  function fakeReadProvider(overrides: Partial<BrokerReadProvider> = {}): BrokerReadProvider {
    return {
      getAccounts: async () => [],
      getAccount: async () => null,
      getPositions: async () => [],
      getTransactions: async () => ({ transactions: [], categories: { TRADE: { status: "OK", count: 0 }, RECEIVE_AND_DELIVER: { status: "OK", count: 0 }, DIVIDEND_OR_INTEREST: { status: "OK", count: 0 } } }),
      getOrders: async () => [],
      ...overrides,
    };
  }

  it("two simultaneous Matt refreshes coalesce into ONE provider operation and both callers receive a coherent result", async () => {
    const m = await mocks();
    let accountsCalls = 0;
    let resolveAccounts: ((value: Awaited<ReturnType<BrokerReadProvider["getAccounts"]>>) => void) | undefined;
    m.getSchwabConnectionSummaryForUser.mockResolvedValue(connectedSummary() as never);
    m.getSchwabBrokerReadProviderForUser.mockResolvedValue(
      fakeReadProvider({
        getAccounts: () =>
          new Promise((resolve) => {
            accountsCalls += 1;
            resolveAccounts = resolve;
          }),
      }),
    );
    m.campaignFindMany.mockResolvedValue([]);

    const first = refreshPositionEvidenceForUserGuarded("matt");
    const second = refreshPositionEvidenceForUserGuarded("matt");
    // getAccounts() is only actually invoked after a few awaited steps inside
    // refreshPositionEvidenceForUser (connection lookup, cache clears) - wait for it before resolving.
    while (!resolveAccounts) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    resolveAccounts([]);

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(accountsCalls).toBe(1); // exactly one underlying Schwab operation
    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    expect(firstResult.availableAgainAt).toBe(secondResult.availableAgainAt); // coherent, shared result
  });

  it("Matt and Eric refresh independently - Eric's refresh is never coalesced with or blocked by Matt's", async () => {
    const m = await mocks();
    const mattAccounts = vi.fn(async () => []);
    const ericAccounts = vi.fn(async () => []);
    m.getSchwabConnectionSummaryForUser.mockResolvedValue(connectedSummary() as never);
    m.getSchwabBrokerReadProviderForUser.mockImplementation(async (userId) =>
      fakeReadProvider({ getAccounts: userId === "matt" ? mattAccounts : ericAccounts }),
    );
    m.campaignFindMany.mockResolvedValue([]);

    const [mattResult, ericResult] = await Promise.all([
      refreshPositionEvidenceForUserGuarded("matt"),
      refreshPositionEvidenceForUserGuarded("eric"),
    ]);

    expect(mattAccounts).toHaveBeenCalledTimes(1);
    expect(ericAccounts).toHaveBeenCalledTimes(1);
    expect(mattResult.ok).toBe(true);
    expect(ericResult.ok).toBe(true);
  });

  it("a request within Matt's 15-second cooldown reuses the prior result and never triggers another Schwab fetch - Eric remains unaffected", async () => {
    const m = await mocks();
    const mattAccounts = vi.fn(async () => []);
    m.getSchwabConnectionSummaryForUser.mockResolvedValue(connectedSummary() as never);
    m.getSchwabBrokerReadProviderForUser.mockResolvedValue(fakeReadProvider({ getAccounts: mattAccounts }));
    m.campaignFindMany.mockResolvedValue([]);

    await refreshPositionEvidenceForUserGuarded("matt");
    const second = await refreshPositionEvidenceForUserGuarded("matt"); // immediately after - well within cooldown

    expect(mattAccounts).toHaveBeenCalledTimes(1); // no second Schwab fetch
    expect(second.ok).toBe(true);
    expect(second.availableAgainAt).toEqual(expect.any(String));

    // Eric is completely unaffected by Matt's in-progress cooldown.
    const ericAccounts = vi.fn(async () => []);
    m.getSchwabBrokerReadProviderForUser.mockResolvedValueOnce(fakeReadProvider({ getAccounts: ericAccounts }));
    await refreshPositionEvidenceForUserGuarded("eric");
    expect(ericAccounts).toHaveBeenCalledTimes(1);
  });

  it("the component's/action's error handling has something to hold onto: even a failed refresh returns a cooldown timestamp", async () => {
    const m = await mocks();
    m.getSchwabConnectionSummaryForUser.mockResolvedValue(null);

    const result = await refreshPositionEvidenceForUserGuarded("matt");

    expect(result.ok).toBe(false);
    expect(result.availableAgainAt).toEqual(expect.any(String));
  });
});
