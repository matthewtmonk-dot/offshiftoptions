import { describe, expect, it } from "vitest";
import { fetchSchwabAccountActivity } from "./workflows";
import type { BrokerReadProvider } from "@/providers/broker-read/types";

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
