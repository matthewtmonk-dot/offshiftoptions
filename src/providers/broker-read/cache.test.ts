import { beforeEach, describe, expect, it } from "vitest";
import type {
  BrokerAccount,
  BrokerObservedOrder,
  BrokerPosition,
  BrokerReadProvider,
  BrokerTransaction,
} from "./types";
import {
  BrokerReadProviderError,
  clearBrokerReadCacheForTests,
  clearBrokerReadCacheForUser,
  withBrokerReadCache,
} from "./cache";

describe("withBrokerReadCache", () => {
  beforeEach(() => {
    clearBrokerReadCacheForTests();
  });

  it("dedupes in-flight account reads and reuses fresh broker snapshots briefly", async () => {
    let now = 1_000;
    const fake = fakeBrokerReadProvider("A");
    const provider = withBrokerReadCache(fake.provider, "schwab:user:user-a:connection:conn-a", {
      accountsTtlMs: 1_000,
      now: () => now,
    });

    const [first, second] = await Promise.all([provider.getAccounts(), provider.getAccounts()]);
    expect(first).toEqual(second);
    expect(fake.calls.accounts).toBe(1);

    await provider.getAccounts();
    expect(fake.calls.accounts).toBe(1);

    now += 1_001;
    await provider.getAccounts();
    expect(fake.calls.accounts).toBe(2);
  });

  it("keeps Schwab broker cache entries isolated by authenticated user and connection", async () => {
    const userA = fakeBrokerReadProvider("A");
    const userB = fakeBrokerReadProvider("B");
    const cachedA = withBrokerReadCache(userA.provider, "schwab:user:user-a:connection:conn-a");
    const cachedB = withBrokerReadCache(userB.provider, "schwab:user:user-b:connection:conn-b");

    await cachedA.getAccounts();
    await cachedB.getAccounts();
    await cachedA.getAccounts();
    await cachedB.getAccounts();

    expect(userA.calls.accounts).toBe(1);
    expect(userB.calls.accounts).toBe(1);
    await expect(cachedA.getAccount("account-A")).resolves.toMatchObject({ label: "Account A" });
    await expect(cachedB.getAccount("account-B")).resolves.toMatchObject({ label: "Account B" });
  });

  it("clears only the requested user's broker cache for disconnects and forced refreshes", async () => {
    const userA = fakeBrokerReadProvider("A");
    const userB = fakeBrokerReadProvider("B");
    const cachedA = withBrokerReadCache(userA.provider, "schwab:user:user-a:connection:conn-a");
    const cachedB = withBrokerReadCache(userB.provider, "schwab:user:user-b:connection:conn-b");

    await cachedA.getAccounts();
    await cachedB.getAccounts();
    clearBrokerReadCacheForUser("user-a");
    await cachedA.getAccounts();
    await cachedB.getAccounts();

    expect(userA.calls.accounts).toBe(2);
    expect(userB.calls.accounts).toBe(1);
  });

  it("does not re-cache an in-flight response after that user's cache is cleared", async () => {
    let resolveAccounts: ((value: BrokerAccount[]) => void) | undefined;
    const account: BrokerAccount = {
      id: "account-A",
      label: "Account A",
      accountValue: 100_000,
      cash: 12_500,
    };
    const calls = { accounts: 0 };
    const provider = withBrokerReadCache(
      {
        ...fakeBrokerReadProvider("A").provider,
        getAccounts: async () => {
          calls.accounts += 1;
          return new Promise<BrokerAccount[]>((resolve) => {
            resolveAccounts = resolve;
          });
        },
      },
      "schwab:user:user-a:connection:conn-a",
    );

    const pending = provider.getAccounts();
    clearBrokerReadCacheForUser("user-a");
    resolveAccounts!([account]);
    await expect(pending).resolves.toEqual([account]);

    const fresh = provider.getAccounts();
    resolveAccounts!([account]);
    await expect(fresh).resolves.toEqual([account]);
    expect(calls.accounts).toBe(2);
  });

  it("does not let stale in-flight cleanup remove a newer in-flight request", async () => {
    const account: BrokerAccount = {
      id: "account-A",
      label: "Account A",
      accountValue: 100_000,
      cash: 12_500,
    };
    const resolvers: Array<(value: BrokerAccount[]) => void> = [];
    const calls = { accounts: 0 };
    const provider = withBrokerReadCache(
      {
        ...fakeBrokerReadProvider("A").provider,
        getAccounts: async () => {
          calls.accounts += 1;
          return new Promise<BrokerAccount[]>((resolve) => {
            resolvers.push(resolve);
          });
        },
      },
      "schwab:user:user-a:connection:conn-a",
    );

    const stale = provider.getAccounts();
    clearBrokerReadCacheForUser("user-a");
    const current = provider.getAccounts();

    resolvers[0]!([account]);
    await expect(stale).resolves.toEqual([account]);

    const alsoCurrent = provider.getAccounts();
    expect(calls.accounts).toBe(2);

    resolvers[1]!([account]);
    await expect(Promise.all([current, alsoCurrent])).resolves.toEqual([[account], [account]]);
    expect(calls.accounts).toBe(2);
  });

  it("does not turn a failed Schwab broker request into a cached empty response", async () => {
    let fail = true;
    const fake = fakeBrokerReadProvider("A", () => fail);
    const provider = withBrokerReadCache(fake.provider, "schwab:user:user-a:connection:conn-a");

    await expect(provider.getAccounts()).rejects.toBeInstanceOf(BrokerReadProviderError);
    fail = false;
    await expect(provider.getAccounts()).resolves.toEqual([
      { id: "account-A", label: "Account A", accountValue: 100_000, cash: 12_500 },
    ]);
    expect(fake.calls.accounts).toBe(2);
  });
});

function fakeBrokerReadProvider(label: string, shouldFail: () => boolean = () => false) {
  const account: BrokerAccount = {
    id: `account-${label}`,
    label: `Account ${label}`,
    accountValue: 100_000,
    cash: 12_500,
  };
  const position: BrokerPosition = {
    accountId: account.id,
    symbol: `${label} 260116P00100000`,
    quantity: -1,
    marketValue: -200,
    assetType: "OPTION",
    putCall: "PUT",
    strikePrice: 100,
    underlyingSymbol: label,
  };
  const transaction: BrokerTransaction = {
    id: `transaction-${label}`,
    accountId: account.id,
    symbol: label,
    amount: 100,
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    description: "Sell to Open",
  };
  const order: BrokerObservedOrder = {
    id: `order-${label}`,
    accountId: account.id,
    symbol: label,
    status: "FILLED",
    enteredAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const calls = { account: 0, accounts: 0, orders: 0, positions: 0, transactions: 0 };
  const maybeFail = async <T>(value: T) => {
    if (shouldFail()) {
      throw new Error("broker unavailable");
    }
    return value;
  };
  const provider: BrokerReadProvider = {
    getAccounts: async () => {
      calls.accounts += 1;
      return maybeFail([account]);
    },
    getAccount: async () => {
      calls.account += 1;
      return maybeFail(account);
    },
    getPositions: async () => {
      calls.positions += 1;
      return maybeFail([position]);
    },
    getTransactions: async () => {
      calls.transactions += 1;
      return maybeFail([transaction]);
    },
    getOrders: async () => {
      calls.orders += 1;
      return maybeFail([order]);
    },
  };

  return { calls, provider };
}
