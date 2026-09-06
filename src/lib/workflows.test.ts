import { describe, expect, it } from "vitest";
import { buildSchwabRecordsToPersist, fetchSchwabAccountActivity } from "./workflows";
import type { BrokerReadProvider, BrokerTransaction } from "@/providers/broker-read/types";

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
