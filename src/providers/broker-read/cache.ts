import type {
  BrokerAccount,
  BrokerObservedOrder,
  BrokerPosition,
  BrokerReadProvider,
  BrokerTransaction,
} from "./types";

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

type BrokerReadCachePolicy = {
  accountTtlMs?: number;
  accountsTtlMs?: number;
  ordersTtlMs?: number;
  positionsTtlMs?: number;
  transactionsTtlMs?: number;
  now?: () => number;
};

export class BrokerReadProviderError extends Error {
  readonly providerKey: string;
  readonly cause: unknown;

  constructor(providerKey: string, cause: unknown) {
    super(`Broker read provider failed: ${providerKey}`);
    this.name = "BrokerReadProviderError";
    this.providerKey = providerKey;
    this.cause = cause;
  }
}

const cache = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();
const invalidationVersions = new Map<string, number>();

export function withBrokerReadCache(
  provider: BrokerReadProvider,
  providerKey: string,
  policy: BrokerReadCachePolicy = {},
): BrokerReadProvider {
  const now = policy.now ?? Date.now;
  const ttl = {
    account: policy.accountTtlMs ?? 15_000,
    accounts: policy.accountsTtlMs ?? 15_000,
    orders: policy.ordersTtlMs ?? 30_000,
    positions: policy.positionsTtlMs ?? 15_000,
    transactions: policy.transactionsTtlMs ?? 30_000,
  };

  return {
    getAccounts(): Promise<BrokerAccount[]> {
      return cached(`${providerKey}:accounts`, ttl.accounts, now, () => provider.getAccounts());
    },
    getAccount(accountId: string): Promise<BrokerAccount | null> {
      return cached(`${providerKey}:account:${accountId}`, ttl.account, now, () => provider.getAccount(accountId));
    },
    getPositions(accountId: string): Promise<BrokerPosition[]> {
      return cached(`${providerKey}:positions:${accountId}`, ttl.positions, now, () => provider.getPositions(accountId));
    },
    getTransactions(accountId: string, from: Date, to: Date): Promise<BrokerTransaction[]> {
      return cached(`${providerKey}:transactions:${accountId}:${from.toISOString()}:${to.toISOString()}`, ttl.transactions, now, () =>
        provider.getTransactions(accountId, from, to),
      );
    },
    getOrders(accountId: string, from: Date, to: Date): Promise<BrokerObservedOrder[]> {
      return cached(`${providerKey}:orders:${accountId}:${from.toISOString()}:${to.toISOString()}`, ttl.orders, now, () =>
        provider.getOrders(accountId, from, to),
      );
    },
  };
}

export function clearBrokerReadCacheForProvider(providerKey: string) {
  clearByPrefix(`${providerKey}:`);
}

export function clearBrokerReadCacheForUser(userId: string) {
  clearByPrefix(`schwab:user:${userId}:`);
}

export function clearBrokerReadCacheForTests() {
  cache.clear();
  inFlight.clear();
  invalidationVersions.clear();
}

async function cached<T>(key: string, ttlMs: number, now: () => number, load: () => Promise<T>): Promise<T> {
  const existing = cache.get(key);
  const currentTime = now();
  if (existing && existing.expiresAt > currentTime) {
    return existing.value as T;
  }

  const existingPromise = inFlight.get(key);
  if (existingPromise) {
    return existingPromise as Promise<T>;
  }

  const version = invalidationVersionForKey(key);
  const promise = load()
    .then((value) => {
      if (invalidationVersionForKey(key) === version) {
        cache.set(key, { expiresAt: now() + ttlMs, value });
      }
      return value;
    })
    .catch((error) => {
      throw new BrokerReadProviderError(providerNameFromKey(key), error);
    })
    .finally(() => {
      if (inFlight.get(key) === promise) {
        inFlight.delete(key);
      }
    });

  inFlight.set(key, promise);
  return promise;
}

function clearByPrefix(prefix: string) {
  invalidationVersions.set(prefix, (invalidationVersions.get(prefix) ?? 0) + 1);

  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
  for (const key of inFlight.keys()) {
    if (key.startsWith(prefix)) {
      inFlight.delete(key);
    }
  }
}

function invalidationVersionForKey(key: string) {
  let version = 0;
  for (const [prefix, prefixVersion] of invalidationVersions) {
    if (key.startsWith(prefix)) {
      version += prefixVersion;
    }
  }
  return version;
}

function providerNameFromKey(key: string) {
  return key.split(":").slice(0, 5).join(":");
}
