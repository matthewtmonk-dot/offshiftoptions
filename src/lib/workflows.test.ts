import { describe, expect, it } from "vitest";
import { buildLiveScanFailureMessage, buildSchwabRecordsToPersist, fetchSchwabAccountActivity } from "./workflows";
import type { BrokerReadProvider, BrokerTransaction } from "@/providers/broker-read/types";
import { SchwabApiError } from "@/providers/schwab/client";

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

    const failedProvider = fakeProvider({
      getPositions: async () => {
        throw new SchwabApiError("Schwab request failed.", 500);
      },
    });
    const failed = await fetchSchwabAccountActivity(failedProvider, "acct-1", new Date("2026-08-01"), new Date("2026-08-31"));
    expect(failed.positions).toHaveLength(0); // same observable count as the honest empty success above
    expect(failed.positionsStatus).toBe("ERROR"); // but the status makes the difference explicit
    expect(failed.positionsErrorCode).toBe("provider_unavailable");
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
