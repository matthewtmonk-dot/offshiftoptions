import type { EquityMarketSessionEvidence, MarketDataProvider, MarketQuote, QuoteReviewEvidence } from "./types";

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
  /** Dashboard V2 Phase 2 - deliberately much shorter than quoteTtlMs: this evidence feeds a
   * 120-second-freshness colored advisory, so serving a stale cache entry for too long would
   * itself become a freshness problem. A cache HIT still returns the exact same evidence object
   * with its original tradeTime/requestStartedAt/responseReceivedAt untouched - it never renews
   * freshness, it only avoids re-fetching within this short window. */
  quoteReviewEvidenceTtlMs?: number;
  /** Session evidence for a given NY calendar date is effectively immutable once Schwab reports
   * it, so this can share marketHoursTtlMs's own conservative default rather than needing its own. */
  equityMarketSessionEvidenceTtlMs?: number;
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
const invalidationVersions = new Map<string, number>();

/** The wrapper always implements getQuotes, getQuoteReviewEvidence, and
 * getEquityMarketSessionEvidence (see below), even when the underlying provider doesn't -
 * callers that go through withMarketDataCache can rely on all three being present. A provider
 * that omits the latter two simply always resolves to UNAVAILABLE evidence for them - never a
 * guess, and never a thrown error. */
export type CachedMarketDataProvider = MarketDataProvider & {
  getQuotes(symbols: string[]): Promise<Map<string, MarketQuote>>;
  getQuoteReviewEvidence(symbol: string): Promise<QuoteReviewEvidence>;
  getEquityMarketSessionEvidence(nyDate: string): Promise<EquityMarketSessionEvidence>;
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
    quoteReviewEvidence: policy.quoteReviewEvidenceTtlMs ?? 5_000,
    equityMarketSessionEvidence: policy.equityMarketSessionEvidenceTtlMs ?? 5 * 60_000,
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
    getOptionChain(symbol, request) {
      // Every narrowing dimension is part of the key: a cached response for one date window or
      // contract type must never be served to a request asking for a different (especially a
      // wider) one - that would silently hide contracts the caller actually asked for.
      const windowKey = [
        request?.fromDate ? request.fromDate.toISOString().slice(0, 10) : "any",
        request?.toDate ? request.toDate.toISOString().slice(0, 10) : "any",
        request?.contractType ?? "ALL",
      ].join(":");
      return cached(`${providerKey}:chain:${symbol.toUpperCase()}:${windowKey}`, ttl.optionChain, now, () =>
        provider.getOptionChain(symbol, request),
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
    /**
     * Dashboard V2 Phase 2. A provider that doesn't implement the underlying capability resolves
     * to UNAVAILABLE directly - never cached (there's nothing to cache), never thrown - so
     * positionReview always gets a definite answer. A cache HIT returns the exact same
     * QuoteReviewEvidence object `cached()` already stored - its tradeTime/requestStartedAt/
     * responseReceivedAt are never touched or re-derived on a hit.
     */
    getQuoteReviewEvidence(symbol) {
      if (!provider.getQuoteReviewEvidence) {
        return Promise.resolve({ status: "UNAVAILABLE", reason: "Provider does not support review-evidence quotes." });
      }
      return cached(`${providerKey}:reviewEvidence:${symbol.toUpperCase()}`, ttl.quoteReviewEvidence, now, () =>
        provider.getQuoteReviewEvidence!(symbol),
      );
    },
    /** Dashboard V2 Phase 2 - same UNAVAILABLE-when-unsupported contract as getQuoteReviewEvidence
     * above; a cache hit returns the same evidence object, preserving its original interval
     * instants untouched. */
    getEquityMarketSessionEvidence(nyDate) {
      if (!provider.getEquityMarketSessionEvidence) {
        return Promise.resolve({ status: "UNAVAILABLE", reason: "Provider does not support equity market-session evidence." });
      }
      return cached(`${providerKey}:marketSession:${nyDate}`, ttl.equityMarketSessionEvidence, now, () =>
        provider.getEquityMarketSessionEvidence!(nyDate),
      );
    },
  };
}

export function clearMarketDataCacheForTests() {
  cache.clear();
  inFlight.clear();
  invalidationVersions.clear();
}

/**
 * Post-Phase-2 UX follow-up (universal "Refresh status" control) - clears every cache entry for
 * one user's own market-data connection(s), keyed by the SAME `schwab:user:${userId}:...`
 * providerKey prefix `resolveMarketDataProviderForUser` already uses (see broker-connections.ts) -
 * never a cross-user key, so Matt's refresh can never clear or otherwise affect Eric's cached
 * evidence. Mirrors `clearBrokerReadCacheForUser`'s exact prefix-clear + invalidation-version
 * approach (providers/broker-read/cache.ts) so an in-flight fetch that started BEFORE this call
 * can never repopulate the cache with a value fetched before the user's own refresh click.
 */
export function clearMarketDataCacheForUser(userId: string) {
  const prefix = `schwab:user:${userId}:`;
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

function invalidationVersionForKey(key: string): number {
  let version = 0;
  for (const [prefix, prefixVersion] of invalidationVersions) {
    if (key.startsWith(prefix)) {
      version += prefixVersion;
    }
  }
  return version;
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

  const version = invalidationVersionForKey(key);
  const promise = load()
    .then((value) => {
      // Codex UX follow-up - a fetch that was already in flight when clearMarketDataCacheForUser
      // ran must never repopulate the cache with a value effectively fetched before that clear.
      if (invalidationVersionForKey(key) === version) {
        cache.set(key, { expiresAt: now() + ttlMs, value });
      }
      return value;
    })
    .catch((error) => {
      throw new MarketDataProviderError(providerNameFromKey(key), error);
    })
    .finally(() => {
      if (inFlight.get(key) === promise) {
        inFlight.delete(key);
      }
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
