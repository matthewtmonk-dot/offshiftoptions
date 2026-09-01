import type { MarketDataProvider } from "./types";

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

type CachePolicy = {
  quoteTtlMs?: number;
  priceHistoryTtlMs?: number;
  optionChainTtlMs?: number;
  instrumentTtlMs?: number;
  marketHoursTtlMs?: number;
  now?: () => number;
};

export class MarketDataProviderError extends Error {
  readonly providerKey: string;
  readonly cause: unknown;

  constructor(providerKey: string, cause: unknown) {
    super(`Market data provider failed: ${providerKey}`);
    this.name = "MarketDataProviderError";
    this.providerKey = providerKey;
    this.cause = cause;
  }
}

const cache = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

export function withMarketDataCache(
  provider: MarketDataProvider,
  providerKey: string,
  policy: CachePolicy = {},
): MarketDataProvider {
  const now = policy.now ?? Date.now;
  const ttl = {
    quote: policy.quoteTtlMs ?? 15_000,
    priceHistory: policy.priceHistoryTtlMs ?? 60 * 60_000,
    optionChain: policy.optionChainTtlMs ?? 30_000,
    instrument: policy.instrumentTtlMs ?? 24 * 60 * 60_000,
    marketHours: policy.marketHoursTtlMs ?? 5 * 60_000,
  };

  return {
    getQuote(symbol) {
      return cached(`${providerKey}:quote:${symbol.toUpperCase()}`, ttl.quote, now, () =>
        provider.getQuote(symbol),
      );
    },
    getPriceHistory(symbol, days) {
      return cached(`${providerKey}:history:${symbol.toUpperCase()}:${days}`, ttl.priceHistory, now, () =>
        provider.getPriceHistory(symbol, days),
      );
    },
    getOptionChain(symbol, expiration) {
      const expirationKey = expiration ? expiration.toISOString().slice(0, 10) : "all";
      return cached(`${providerKey}:chain:${symbol.toUpperCase()}:${expirationKey}`, ttl.optionChain, now, () =>
        provider.getOptionChain(symbol, expiration),
      );
    },
    getInstrument(symbol) {
      return cached(`${providerKey}:instrument:${symbol.toUpperCase()}`, ttl.instrument, now, () =>
        provider.getInstrument(symbol),
      );
    },
    getMarketHours(date) {
      return cached(`${providerKey}:hours:${date.toISOString().slice(0, 10)}`, ttl.marketHours, now, () =>
        provider.getMarketHours(date),
      );
    },
  };
}

export function clearMarketDataCacheForTests() {
  cache.clear();
  inFlight.clear();
}

async function cached<T>(
  key: string,
  ttlMs: number,
  now: () => number,
  load: () => Promise<T>,
): Promise<T> {
  const existing = cache.get(key);
  const currentTime = now();
  if (existing && existing.expiresAt > currentTime) {
    return existing.value as T;
  }

  const existingPromise = inFlight.get(key);
  if (existingPromise) {
    return existingPromise as Promise<T>;
  }

  const promise = load()
    .then((value) => {
      cache.set(key, { expiresAt: now() + ttlMs, value });
      return value;
    })
    .catch((error) => {
      throw new MarketDataProviderError(providerNameFromKey(key), error);
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}

function providerNameFromKey(key: string) {
  return key.split(":").slice(0, 3).join(":");
}
