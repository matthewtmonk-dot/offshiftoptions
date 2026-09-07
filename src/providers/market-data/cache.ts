import type { MarketDataProvider, MarketQuote } from "./types";

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

/** The wrapper always implements getQuotes (see below), even when the underlying provider
 * doesn't - callers that go through withMarketDataCache can rely on it being present. */
export type CachedMarketDataProvider = MarketDataProvider & {
  getQuotes(symbols: string[]): Promise<Map<string, MarketQuote>>;
};

export function withMarketDataCache(
  provider: MarketDataProvider,
  providerKey: string,
  policy: CachePolicy = {},
): CachedMarketDataProvider {
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
    /**
     * Always exposed on the wrapped provider (unlike the underlying provider, where it's
     * optional) - reuses each symbol's individual quote cache entry when fresh, and fetches
     * only the cache misses, via the underlying provider's own getQuotes if it has one or via
     * one getQuote call per miss (each isolated - one bad symbol never drops the others) when
     * it doesn't. A batch fetch populates the exact same per-symbol cache keys getQuote reads,
     * so a later single getQuote() call for an already-batched symbol hits cache.
     */
    async getQuotes(symbols: string[]): Promise<Map<string, MarketQuote>> {
      const normalized = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))];
      const result = new Map<string, MarketQuote>();
      const currentTime = now();
      const missing: string[] = [];

      for (const symbol of normalized) {
        const existing = cache.get(`${providerKey}:quote:${symbol}`);
        if (existing && existing.expiresAt > currentTime) {
          result.set(symbol, existing.value as MarketQuote);
        } else {
          missing.push(symbol);
        }
      }

      if (missing.length > 0) {
        const fetched = provider.getQuotes ? await provider.getQuotes(missing) : await fetchQuotesOneAtATime(provider, missing);
        const fetchTime = now();
        for (const [symbol, quote] of fetched) {
          cache.set(`${providerKey}:quote:${symbol}`, { expiresAt: fetchTime + ttl.quote, value: quote });
          result.set(symbol, quote);
        }
      }

      return result;
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

/** Fallback for a provider that doesn't implement getQuotes - one getQuote call per symbol,
 * each isolated so a single bad/invalid symbol never drops the others from the result. If
 * EVERY symbol fails, that's a systemic problem (auth, outage), not a per-symbol one - rethrown
 * rather than silently returning an empty map, mirroring SchwabMarketDataProvider.getQuotes'
 * own all-chunks-failed behavior. */
async function fetchQuotesOneAtATime(provider: MarketDataProvider, symbols: string[]): Promise<Map<string, MarketQuote>> {
  const entries = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        return { symbol, quote: await provider.getQuote(symbol), error: null as unknown };
      } catch (error) {
        return { symbol, quote: null, error };
      }
    }),
  );

  const succeeded = entries.filter((entry): entry is { symbol: string; quote: MarketQuote; error: null } => entry.quote !== null);
  if (symbols.length > 0 && succeeded.length === 0) {
    throw entries[0].error;
  }

  return new Map(succeeded.map((entry) => [entry.symbol, entry.quote]));
}
