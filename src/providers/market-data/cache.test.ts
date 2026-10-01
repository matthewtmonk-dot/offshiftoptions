import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MarketDataProvider, MarketQuote, PriceCandle } from "./types";
import { clearMarketDataCacheForTests, clearMarketDataCacheForUser, MarketDataProviderError, withMarketDataCache } from "./cache";

function quote(symbol: string, price: number): MarketQuote {
  return { symbol, price, asOf: new Date("2026-08-31T12:00:00.000Z") };
}

function candle(symbol: string): PriceCandle {
  return {
    symbol,
    date: new Date("2026-08-31T00:00:00.000Z"),
    open: 10,
    high: 11,
    low: 9,
    close: 10.5,
    volume: 1000,
  };
}

function provider(overrides: Partial<MarketDataProvider> = {}): MarketDataProvider {
  return {
    getQuote: vi.fn(async (symbol: string) => quote(symbol, 12.34)),
    getPriceHistory: vi.fn(async (symbol: string) => [candle(symbol)]),
    getOptionChain: vi.fn(async () => []),
    getInstrument: vi.fn(async (symbol: string) => ({ symbol, description: "Test instrument", assetType: "EQUITY" })),
    getMarketHours: vi.fn(async () => ({ isOpen: true })),
    ...overrides,
  };
}

describe("withMarketDataCache", () => {
  beforeEach(() => {
    clearMarketDataCacheForTests();
  });

  it("reuses repeated quote requests for the same provider key", async () => {
    const inner = provider();
    const cached = withMarketDataCache(inner, "schwab:user:user-a:connection:one", { quoteTtlMs: 30_000 });

    await expect(cached.getQuote("lsto")).resolves.toMatchObject({ price: 12.34 });
    await expect(cached.getQuote("LSTO")).resolves.toMatchObject({ price: 12.34 });

    expect(inner.getQuote).toHaveBeenCalledTimes(1);
  });

  it("does not share cache entries across provider keys", async () => {
    const first = provider({ getQuote: vi.fn(async (symbol: string) => quote(symbol, 10)) });
    const second = provider({ getQuote: vi.fn(async (symbol: string) => quote(symbol, 20)) });

    const firstCached = withMarketDataCache(first, "schwab:user:user-a:connection:one");
    const secondCached = withMarketDataCache(second, "schwab:user:user-b:connection:two");

    await expect(firstCached.getQuote("LSTO")).resolves.toMatchObject({ price: 10 });
    await expect(secondCached.getQuote("LSTO")).resolves.toMatchObject({ price: 20 });

    expect(first.getQuote).toHaveBeenCalledTimes(1);
    expect(second.getQuote).toHaveBeenCalledTimes(1);
  });

  describe("Codex UX follow-up - clearMarketDataCacheForUser (universal 'Refresh status' control)", () => {
    it("clears only the named user's own cached entries, never another user's", async () => {
      const userA = provider({ getQuote: vi.fn(async (symbol: string) => quote(symbol, 10)) });
      const userB = provider({ getQuote: vi.fn(async (symbol: string) => quote(symbol, 20)) });
      const cachedA = withMarketDataCache(userA, "schwab:user:user-a:connection:one");
      const cachedB = withMarketDataCache(userB, "schwab:user:user-b:connection:two");

      await cachedA.getQuote("LSTO");
      await cachedB.getQuote("LSTO");
      clearMarketDataCacheForUser("user-a");
      await cachedA.getQuote("LSTO");
      await cachedB.getQuote("LSTO");

      expect(userA.getQuote).toHaveBeenCalledTimes(2); // re-fetched after its own cache was cleared
      expect(userB.getQuote).toHaveBeenCalledTimes(1); // untouched by user-a's refresh
    });

    it("does not re-cache an in-flight response after that user's cache is cleared", async () => {
      let resolveQuote: ((value: MarketQuote) => void) | undefined;
      const calls = { quote: 0 };
      const inner = provider({
        getQuote: vi.fn(
          (symbol: string) =>
            new Promise<MarketQuote>((resolve) => {
              calls.quote += 1;
              resolveQuote = resolve;
            }).then((value) => {
              void symbol;
              return value;
            }),
        ),
      });
      const cached = withMarketDataCache(inner, "schwab:user:user-a:connection:one");

      const pending = cached.getQuote("LSTO");
      clearMarketDataCacheForUser("user-a");
      resolveQuote!(quote("LSTO", 10));
      await expect(pending).resolves.toMatchObject({ price: 10 });

      const fresh = cached.getQuote("LSTO");
      resolveQuote!(quote("LSTO", 10));
      await expect(fresh).resolves.toMatchObject({ price: 10 });
      expect(calls.quote).toBe(2); // the second call proves the first response was never re-cached
    });
  });

  it("coalesces simultaneous price-history requests within one provider", async () => {
    const historyGate: { resolve?: (candles: PriceCandle[]) => void } = {};
    const inner = provider({
      getPriceHistory: vi.fn(
        (symbol: string) =>
          new Promise<PriceCandle[]>((resolve) => {
            historyGate.resolve = resolve;
          }).then(() => [candle(symbol)]),
      ),
    });
    const cached = withMarketDataCache(inner, "schwab:user:user-a:connection:one");

    const first = cached.getPriceHistory("LSTO", 30);
    const second = cached.getPriceHistory("lsto", 30);
    expect(historyGate.resolve).toBeDefined();
    historyGate.resolve?.([candle("LSTO")]);

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(inner.getPriceHistory).toHaveBeenCalledTimes(1);
  });

  it("wraps failures with the provider identity but no credentials", async () => {
    const inner = provider({
      getQuote: vi.fn(async () => {
        throw new Error("rate limited");
      }),
    });
    const cached = withMarketDataCache(inner, "schwab:user:user-a:connection:one");

    await expect(cached.getQuote("LSTO")).rejects.toMatchObject({
      name: "MarketDataProviderError",
      providerKey: "schwab:user:user-a",
    } satisfies Partial<MarketDataProviderError>);
  });

  describe("getQuotes (always exposed on the wrapper, even when the underlying provider lacks it)", () => {
    it("uses the underlying provider's native getQuotes when available", async () => {
      const nativeGetQuotes = vi.fn(async (symbols: string[]) => new Map(symbols.map((symbol) => [symbol, quote(symbol, 42)])));
      const inner = provider({ getQuotes: nativeGetQuotes });
      const cached = withMarketDataCache(inner, "schwab:user:user-a:connection:one");

      const result = await cached.getQuotes(["AAA", "BBB"]);
      expect(result.get("AAA")?.price).toBe(42);
      expect(result.get("BBB")?.price).toBe(42);
      expect(nativeGetQuotes).toHaveBeenCalledTimes(1);
      expect(inner.getQuote).not.toHaveBeenCalled();
    });

    it("falls back to one getQuote call per symbol when the underlying provider has no getQuotes", async () => {
      const inner = provider(); // no getQuotes override - default has none
      const cached = withMarketDataCache(inner, "schwab:user:user-a:connection:one");

      const result = await cached.getQuotes(["AAA", "BBB"]);
      expect(result.get("AAA")?.price).toBe(12.34);
      expect(result.get("BBB")?.price).toBe(12.34);
      expect(inner.getQuote).toHaveBeenCalledTimes(2);
    });

    it("in the fallback path, one bad symbol never drops the others", async () => {
      const inner = provider({
        getQuote: vi.fn(async (symbol: string) => {
          if (symbol === "BAD") {
            throw new Error("invalid symbol");
          }
          return quote(symbol, 10);
        }),
      });
      const cached = withMarketDataCache(inner, "schwab:user:user-a:connection:one");

      const result = await cached.getQuotes(["GOOD", "BAD"]);
      expect(result.has("GOOD")).toBe(true);
      expect(result.has("BAD")).toBe(false);
    });

    it("reuses an already-cached single quote instead of re-fetching it in a batch", async () => {
      const nativeGetQuotes = vi.fn(async (symbols: string[]) => new Map(symbols.map((symbol) => [symbol, quote(symbol, 99)])));
      const inner = provider({ getQuotes: nativeGetQuotes });
      const cached = withMarketDataCache(inner, "schwab:user:user-a:connection:one", { quoteTtlMs: 30_000 });

      await cached.getQuote("AAA"); // populates the per-symbol cache via getQuote
      const result = await cached.getQuotes(["AAA", "BBB"]);

      expect(result.get("AAA")?.price).toBe(12.34); // from the earlier getQuote call, not re-fetched
      expect(result.get("BBB")?.price).toBe(99);
      expect(nativeGetQuotes).toHaveBeenCalledWith(["BBB"]); // AAA already cached, never requested again
    });

    it("a batch-fetched quote populates the cache so a later single getQuote() call reuses it", async () => {
      const nativeGetQuotes = vi.fn(async (symbols: string[]) => new Map(symbols.map((symbol) => [symbol, quote(symbol, 55)])));
      const inner = provider({ getQuotes: nativeGetQuotes });
      const cached = withMarketDataCache(inner, "schwab:user:user-a:connection:one", { quoteTtlMs: 30_000 });

      await cached.getQuotes(["AAA"]);
      await expect(cached.getQuote("AAA")).resolves.toMatchObject({ price: 55 });
      expect(inner.getQuote).not.toHaveBeenCalled();
    });
  });

  describe("getOptionChain request narrowing", () => {
    it("never serves one expiration window's cached chain to a request for a different window", async () => {
      const inner = provider();
      const cached = withMarketDataCache(inner, "schwab:user:user-a:connection:one");
      const week = { fromDate: new Date("2026-09-17T00:00:00Z"), toDate: new Date("2026-09-29T00:00:00Z"), contractType: "PUT" as const };

      await cached.getOptionChain("NKE", week);
      await cached.getOptionChain("NKE", week); // identical window - cache hit
      await cached.getOptionChain("NKE", { ...week, toDate: new Date("2026-10-30T00:00:00Z") }); // wider window
      await cached.getOptionChain("NKE", { ...week, contractType: "ALL" }); // both contract types
      await cached.getOptionChain("NKE"); // fully un-narrowed

      // Only the exact repeat was served from cache; every different narrowing refetched.
      expect(inner.getOptionChain).toHaveBeenCalledTimes(4);
    });

    it("passes the narrowing straight through to the underlying provider", async () => {
      const inner = provider();
      const cached = withMarketDataCache(inner, "schwab:user:user-a:connection:one");
      const request = { fromDate: new Date("2026-09-17T00:00:00Z"), toDate: new Date("2026-09-29T00:00:00Z"), contractType: "PUT" as const };

      await cached.getOptionChain("NKE", request);

      expect(inner.getOptionChain).toHaveBeenCalledWith("NKE", request);
    });
  });

  describe("getQuoteReviewEvidence (Dashboard V2 Phase 2)", () => {
    function reviewEvidence(price: number, tradeTime: Date) {
      return {
        status: "AVAILABLE" as const,
        requestedSymbol: "SPY",
        returnedSymbol: "SPY",
        assetMainType: "EQUITY",
        realtime: true,
        price,
        tradeTime,
        requestStartedAt: tradeTime,
        responseReceivedAt: tradeTime,
      };
    }

    it("resolves to UNAVAILABLE, never throws, when the underlying provider does not implement it", async () => {
      const inner = provider(); // no getQuoteReviewEvidence override
      const cached = withMarketDataCache(inner, "schwab:user:user-a:connection:one");

      await expect(cached.getQuoteReviewEvidence("SPY")).resolves.toEqual({ status: "UNAVAILABLE", reason: expect.any(String) });
    });

    it("caches a fetched evidence object and serves the identical object on a hit - never renewing its timestamps", async () => {
      const evidence = reviewEvidence(500, new Date("2026-06-15T16:00:00Z"));
      const getQuoteReviewEvidence = vi.fn(async () => evidence);
      const inner = provider({ getQuoteReviewEvidence });
      const cached = withMarketDataCache(inner, "schwab:user:user-a:connection:one", { quoteReviewEvidenceTtlMs: 30_000 });

      const first = await cached.getQuoteReviewEvidence("spy");
      const second = await cached.getQuoteReviewEvidence("SPY");

      expect(getQuoteReviewEvidence).toHaveBeenCalledTimes(1);
      expect(second).toBe(first); // same object reference - a cache hit can't drift the evidence
      if (second.status === "AVAILABLE") {
        expect(second.tradeTime.getTime()).toBe(new Date("2026-06-15T16:00:00Z").getTime());
      }
    });

    it("does not share cache entries across provider keys", async () => {
      const firstEvidence = reviewEvidence(500, new Date("2026-06-15T16:00:00Z"));
      const secondEvidence = reviewEvidence(600, new Date("2026-06-15T16:00:00Z"));
      const firstProvider = provider({ getQuoteReviewEvidence: vi.fn(async () => firstEvidence) });
      const secondProvider = provider({ getQuoteReviewEvidence: vi.fn(async () => secondEvidence) });

      const firstCached = withMarketDataCache(firstProvider, "schwab:user:user-a:connection:one");
      const secondCached = withMarketDataCache(secondProvider, "schwab:user:user-b:connection:two");

      await expect(firstCached.getQuoteReviewEvidence("SPY")).resolves.toMatchObject({ price: 500 });
      await expect(secondCached.getQuoteReviewEvidence("SPY")).resolves.toMatchObject({ price: 600 });
    });
  });

  describe("getEquityMarketSessionEvidence (Dashboard V2 Phase 2)", () => {
    function sessionEvidence(nyDate: string) {
      return {
        status: "AVAILABLE" as const,
        requestedDate: nyDate,
        returnedDate: nyDate,
        marketType: "EQUITY",
        product: "EQ",
        isOpen: true,
        regularMarketIntervals: [{ start: new Date(`${nyDate}T09:30:00-04:00`), end: new Date(`${nyDate}T16:00:00-04:00`) }],
      };
    }

    it("resolves to UNAVAILABLE, never throws, when the underlying provider does not implement it", async () => {
      const inner = provider();
      const cached = withMarketDataCache(inner, "schwab:user:user-a:connection:one");

      await expect(cached.getEquityMarketSessionEvidence("2026-06-15")).resolves.toEqual({
        status: "UNAVAILABLE",
        reason: expect.any(String),
      });
    });

    it("caches per requested NY date and serves the identical object on a hit", async () => {
      const evidence = sessionEvidence("2026-06-15");
      const getEquityMarketSessionEvidence = vi.fn(async () => evidence);
      const inner = provider({ getEquityMarketSessionEvidence });
      const cached = withMarketDataCache(inner, "schwab:user:user-a:connection:one");

      const first = await cached.getEquityMarketSessionEvidence("2026-06-15");
      const second = await cached.getEquityMarketSessionEvidence("2026-06-15");
      await cached.getEquityMarketSessionEvidence("2026-06-16"); // a different date must refetch

      expect(getEquityMarketSessionEvidence).toHaveBeenCalledTimes(2);
      expect(second).toBe(first);
    });
  });

  describe("getStrictOptionChainSnapshot (Trade Prep strict evidence foundation)", () => {
    function strictSnapshot(quoteTimeInLong: number) {
      return {
        status: "AVAILABLE" as const,
        envelope: { status: "SUCCESS", rootSymbol: "SPY", isDelayed: false },
        request: { requestedUnderlying: "SPY", fromDate: null, toDate: null, contractType: "PUT" as const },
        contracts: [
          {
            location: { expirationMapKey: "2026-10-16:16", strikeMapKey: "655.0", originatingMap: "PUT" as const },
            identity: { providerSymbol: "SPY   261016P00655000", putCall: "PUT", strikePrice: 655, expirationDate: new Date("2026-10-16T20:00:00.000Z"), optionRoot: "SPY" },
            quote: { bid: 1.2, ask: 1.3, quoteTimeInLong },
            terms: { multiplier: 100, nonStandard: false, mini: false, optionDeliverablesList: [{ symbol: "SPY", assetType: "STOCK", deliverableUnits: 100, currencyType: "USD" }], settlementType: "P", deliverableNote: null },
            ruleInputs: { openInterest: 312, totalVolume: 0, delta: -0.015 },
          },
        ],
        transport: { provider: "SCHWAB" as const, requestStartedAt: new Date(quoteTimeInLong), responseReceivedAt: new Date(quoteTimeInLong), httpDateHeader: null, evidencePolicyVersion: "v1" },
      };
    }

    it("resolves to UNAVAILABLE, never throws, when the underlying provider does not implement it", async () => {
      const inner = provider(); // no getStrictOptionChainSnapshot override
      const cached = withMarketDataCache(inner, "schwab:user:user-a:connection:one");

      const result = await cached.getStrictOptionChainSnapshot("SPY");
      expect(result.status).toBe("UNAVAILABLE");
    });

    it("caches a fetched snapshot and serves the identical object on a hit - never renewing quoteTimeInLong/transport timestamps", async () => {
      const snapshot = strictSnapshot(1_700_000_000_000);
      const getStrictOptionChainSnapshot = vi.fn(async () => snapshot);
      const inner = provider({ getStrictOptionChainSnapshot });
      const cached = withMarketDataCache(inner, "schwab:user:user-a:connection:one", { strictOptionChainTtlMs: 30_000 });

      const first = await cached.getStrictOptionChainSnapshot("spy");
      const second = await cached.getStrictOptionChainSnapshot("SPY");

      expect(getStrictOptionChainSnapshot).toHaveBeenCalledTimes(1);
      expect(second).toBe(first); // same object reference - a cache hit can never renew/regenerate evidence
      if (second.status === "AVAILABLE") {
        expect(second.contracts[0]!.quote.quoteTimeInLong).toBe(1_700_000_000_000);
      }
    });

    it("isolates the strict cache key by request window/contract type, same as the legacy getOptionChain key", async () => {
      const getStrictOptionChainSnapshot = vi.fn(async () => strictSnapshot(1_700_000_000_000));
      const cached = withMarketDataCache(provider({ getStrictOptionChainSnapshot }), "schwab:user:user-a:connection:one");

      await cached.getStrictOptionChainSnapshot("SPY", { contractType: "PUT" });
      await cached.getStrictOptionChainSnapshot("SPY", { contractType: "CALL" });

      expect(getStrictOptionChainSnapshot).toHaveBeenCalledTimes(2);
    });

    it("never shares cache state with the legacy getOptionChain path - fetching one never satisfies the other", async () => {
      const getOptionChain = vi.fn(async () => []);
      const getStrictOptionChainSnapshot = vi.fn(async () => strictSnapshot(1_700_000_000_000));
      const cached = withMarketDataCache(provider({ getOptionChain, getStrictOptionChainSnapshot }), "schwab:user:user-a:connection:one");

      await cached.getOptionChain("SPY");
      await cached.getStrictOptionChainSnapshot("SPY");

      expect(getOptionChain).toHaveBeenCalledTimes(1);
      expect(getStrictOptionChainSnapshot).toHaveBeenCalledTimes(1); // not served from the legacy chain's cache entry
    });

    it("forwards the caller's own signal down to the underlying provider call", async () => {
      const getStrictOptionChainSnapshot = vi.fn(async () => strictSnapshot(1_700_000_000_000));
      const cached = withMarketDataCache(provider({ getStrictOptionChainSnapshot }), "schwab:user:user-a:connection:one");
      const controller = new AbortController();

      await cached.getStrictOptionChainSnapshot("SPY", undefined, controller.signal);

      expect(getStrictOptionChainSnapshot).toHaveBeenCalledWith("SPY", undefined, controller.signal);
    });

    it("never publishes a result to cache when the caller's own signal is already aborted, even if the provider call resolved anyway", async () => {
      const cached = withMarketDataCache(provider({ getStrictOptionChainSnapshot: async () => strictSnapshot(1_700_000_000_000) }), "schwab:user:user-a:connection:one");
      const controller = new AbortController();
      controller.abort();

      await expect(cached.getStrictOptionChainSnapshot("SPY", undefined, controller.signal)).rejects.toThrow(MarketDataProviderError);

      let secondCallHappened = false;
      const freshCached = withMarketDataCache(
        provider({
          getStrictOptionChainSnapshot: async () => {
            secondCallHappened = true;
            return strictSnapshot(1_700_000_000_000);
          },
        }),
        "schwab:user:user-a:connection:one",
      );
      await freshCached.getStrictOptionChainSnapshot("SPY");
      expect(secondCallHappened).toBe(true); // proves nothing was cached by the aborted call above
    });
  });

  describe("Post-Phase-2 UX follow-up (end-to-end abandonment repair) - cache publication fencing", () => {
    function reviewEvidence() {
      return {
        status: "AVAILABLE" as const,
        requestedSymbol: "UPST",
        returnedSymbol: "UPST",
        assetMainType: "EQUITY",
        realtime: true,
        price: 30,
        tradeTime: new Date("2026-06-15T16:00:00.000Z"),
        requestStartedAt: new Date("2026-06-15T16:00:00.000Z"),
        responseReceivedAt: new Date("2026-06-15T16:00:00.000Z"),
      };
    }

    it("forwards the caller's own signal down to the underlying provider call", async () => {
      const getQuoteReviewEvidence = vi.fn(async () => reviewEvidence());
      const cached = withMarketDataCache(provider({ getQuoteReviewEvidence }), "schwab:user:user-a:connection:one");
      const controller = new AbortController();

      await cached.getQuoteReviewEvidence("UPST", controller.signal);

      expect(getQuoteReviewEvidence).toHaveBeenCalledWith("UPST", controller.signal);
    });

    it("defense in depth - never publishes a result to cache when the caller's own signal is already aborted, even if the underlying provider call resolved anyway (the narrow abort-vs-completion race)", async () => {
      const cached = withMarketDataCache(provider({ getQuoteReviewEvidence: async () => reviewEvidence() }), "schwab:user:user-a:connection:one");
      const controller = new AbortController();
      controller.abort();

      await expect(cached.getQuoteReviewEvidence("UPST", controller.signal)).rejects.toThrow(MarketDataProviderError);

      // A subsequent, non-aborted call must genuinely re-fetch - proving nothing was cached above.
      let secondCallHappened = false;
      const freshCached = withMarketDataCache(
        provider({
          getQuoteReviewEvidence: async () => {
            secondCallHappened = true;
            return reviewEvidence();
          },
        }),
        "schwab:user:user-a:connection:one",
      );
      await freshCached.getQuoteReviewEvidence("UPST");
      expect(secondCallHappened).toBe(true);
    });

    it("a normal (non-aborted) call still publishes to cache as usual - the abort guard is additive, never a regression for ordinary callers", async () => {
      const getQuoteReviewEvidence = vi.fn(async () => reviewEvidence());
      const cached = withMarketDataCache(provider({ getQuoteReviewEvidence }), "schwab:user:user-a:connection:one", { quoteReviewEvidenceTtlMs: 30_000 });

      await cached.getQuoteReviewEvidence("UPST");
      await cached.getQuoteReviewEvidence("UPST", new AbortController().signal);

      expect(getQuoteReviewEvidence).toHaveBeenCalledTimes(1); // second call served from cache
    });
  });
});
