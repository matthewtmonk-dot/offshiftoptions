import { describe, expect, it } from "vitest";
import { SCHWAB_QUOTE_BATCH_SIZE, SchwabMarketDataProvider } from "./market-data";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

describe("SchwabMarketDataProvider.getQuotes (batch)", () => {
  it("chunks a symbol list larger than SCHWAB_QUOTE_BATCH_SIZE into multiple requests", async () => {
    const requestedSymbolLists: string[] = [];
    const totalSymbols = SCHWAB_QUOTE_BATCH_SIZE * 2 + 5; // forces exactly 3 chunks
    const symbols = Array.from({ length: totalSymbols }, (_, index) => `SYM${index}`);

    const fetchFn = (async (url: string | URL) => {
      const requestUrl = new URL(url);
      const requestedSymbols = requestUrl.searchParams.get("symbols")?.split(",") ?? [];
      requestedSymbolLists.push(requestedSymbols.join(","));
      const payload = Object.fromEntries(requestedSymbols.map((symbol) => [symbol, { quote: { lastPrice: 10 } }]));
      return jsonResponse(payload);
    }) as unknown as typeof fetch;

    const provider = new SchwabMarketDataProvider({ accessToken: "test-token", fetchFn });
    const result = await provider.getQuotes(symbols);

    expect(requestedSymbolLists).toHaveLength(3);
    expect(requestedSymbolLists[0].split(",")).toHaveLength(SCHWAB_QUOTE_BATCH_SIZE);
    expect(requestedSymbolLists[1].split(",")).toHaveLength(SCHWAB_QUOTE_BATCH_SIZE);
    expect(requestedSymbolLists[2].split(",")).toHaveLength(5);
    expect(result.size).toBe(totalSymbols);
  });

  it("one chunk's HTTP failure never drops the other chunks' symbols", async () => {
    let callIndex = 0;
    const symbols = Array.from({ length: SCHWAB_QUOTE_BATCH_SIZE + 1 }, (_, index) => `SYM${index}`);

    const fetchFn = (async (url: string | URL) => {
      callIndex += 1;
      if (callIndex === 1) {
        return jsonResponse({}, 500); // first chunk fails outright
      }
      const requestUrl = new URL(url);
      const requestedSymbols = requestUrl.searchParams.get("symbols")?.split(",") ?? [];
      const payload = Object.fromEntries(requestedSymbols.map((symbol) => [symbol, { quote: { lastPrice: 10 } }]));
      return jsonResponse(payload);
    }) as unknown as typeof fetch;

    const provider = new SchwabMarketDataProvider({ accessToken: "test-token", fetchFn });
    const result = await provider.getQuotes(symbols);

    // The failed chunk's symbol (SYM0, in the first batch of SCHWAB_QUOTE_BATCH_SIZE) is
    // absent; the second chunk's single symbol still comes back.
    expect(result.has("SYM0")).toBe(false);
    expect(result.has(`SYM${SCHWAB_QUOTE_BATCH_SIZE}`)).toBe(true);
  });

  it("rethrows when every chunk fails outright - a systemic problem, never a silent empty map", async () => {
    const symbols = Array.from({ length: SCHWAB_QUOTE_BATCH_SIZE + 1 }, (_, index) => `SYM${index}`);
    const fetchFn = (async () => jsonResponse({}, 503)) as unknown as typeof fetch;
    const provider = new SchwabMarketDataProvider({ accessToken: "test-token", fetchFn });

    await expect(provider.getQuotes(symbols)).rejects.toBeTruthy();
  });

  it("deduplicates repeated symbols before chunking", async () => {
    const requestedSymbolLists: string[] = [];
    const fetchFn = (async (url: string | URL) => {
      const requestUrl = new URL(url);
      const requestedSymbols = requestUrl.searchParams.get("symbols")?.split(",") ?? [];
      requestedSymbolLists.push(requestedSymbols.join(","));
      return jsonResponse({ RIOT: { quote: { lastPrice: 12 } } });
    }) as unknown as typeof fetch;

    const provider = new SchwabMarketDataProvider({ accessToken: "test-token", fetchFn });
    await provider.getQuotes(["riot", "RIOT", "Riot"]);

    expect(requestedSymbolLists).toEqual(["RIOT"]);
  });

  it("getQuote still works as a thin single-symbol wrapper (legacy callers unaffected)", async () => {
    const fetchFn = (async () => jsonResponse({ RIOT: { quote: { lastPrice: 12.34 } } })) as unknown as typeof fetch;
    const provider = new SchwabMarketDataProvider({ accessToken: "test-token", fetchFn });

    const quote = await provider.getQuote("riot");
    expect(quote.symbol).toBe("RIOT");
    expect(quote.price).toBe(12.34);
  });

  it("getQuote still throws when the single requested symbol has no usable price", async () => {
    const fetchFn = (async () => jsonResponse({})) as unknown as typeof fetch;
    const provider = new SchwabMarketDataProvider({ accessToken: "test-token", fetchFn });

    await expect(provider.getQuote("NOPRICE")).rejects.toThrow(/did not include a usable price/);
  });

  it("returns an empty map for an empty symbol list without making any request", async () => {
    let callCount = 0;
    const fetchFn = (async () => {
      callCount += 1;
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const provider = new SchwabMarketDataProvider({ accessToken: "test-token", fetchFn });
    const result = await provider.getQuotes([]);

    expect(result.size).toBe(0);
    expect(callCount).toBe(0);
  });

  it("caps in-flight quote chunk requests at a small, conservative bound - never fully sequential, never unbounded", async () => {
    // Enough symbols for 10 real chunks (SCHWAB_QUOTE_BATCH_SIZE each) - large enough that a
    // conservative concurrency cap is actually exercised, not accidentally satisfied by having
    // fewer chunks than the cap.
    const symbols = Array.from({ length: SCHWAB_QUOTE_BATCH_SIZE * 10 }, (_, index) => `SYM${index}`);
    let active = 0;
    let maxActive = 0;

    const fetchFn = (async (url: string | URL) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      const requestUrl = new URL(url);
      const requestedSymbols = requestUrl.searchParams.get("symbols")?.split(",") ?? [];
      return jsonResponse(Object.fromEntries(requestedSymbols.map((symbol) => [symbol, { quote: { lastPrice: 10 } }])));
    }) as unknown as typeof fetch;

    const provider = new SchwabMarketDataProvider({ accessToken: "test-token", fetchFn });
    await provider.getQuotes(symbols);

    expect(maxActive).toBeGreaterThan(1); // genuinely concurrent, never fully sequential
    expect(maxActive).toBeLessThanOrEqual(4); // bounded to the conservative cap, never unbounded
  });

  it("every chunk is represented exactly once in the result, regardless of completion order under real concurrency", async () => {
    const totalSymbols = SCHWAB_QUOTE_BATCH_SIZE * 6; // 6 real chunks
    const symbols = Array.from({ length: totalSymbols }, (_, index) => `SYM${index}`);
    let callIndex = 0;

    const fetchFn = (async (url: string | URL) => {
      const thisCall = callIndex++;
      // Deliberately vary delay so chunks complete OUT of request order - the earliest-issued
      // request finishes last, stress-testing that results are merged by real symbol key, never
      // by completion order or array position.
      await new Promise((resolve) => setTimeout(resolve, (6 - thisCall) * 3));
      const requestUrl = new URL(url);
      const requestedSymbols = requestUrl.searchParams.get("symbols")?.split(",") ?? [];
      return jsonResponse(Object.fromEntries(requestedSymbols.map((symbol) => [symbol, { quote: { lastPrice: 10 } }])));
    }) as unknown as typeof fetch;

    const provider = new SchwabMarketDataProvider({ accessToken: "test-token", fetchFn });
    const result = await provider.getQuotes(symbols);

    expect(result.size).toBe(totalSymbols); // every symbol from every chunk present exactly once
    expect(new Set(result.keys()).size).toBe(totalSymbols); // no duplicate/dropped keys
  });

  it("partial chunk failure stays isolated under real concurrent execution, not just sequential execution", async () => {
    const totalSymbols = SCHWAB_QUOTE_BATCH_SIZE * 5; // 5 real chunks
    const symbols = Array.from({ length: totalSymbols }, (_, index) => `SYM${index}`);
    let callIndex = 0;

    const fetchFn = (async (url: string | URL) => {
      const thisCall = callIndex++;
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (thisCall === 2) {
        return jsonResponse({}, 500); // the middle chunk fails outright
      }
      const requestUrl = new URL(url);
      const requestedSymbols = requestUrl.searchParams.get("symbols")?.split(",") ?? [];
      return jsonResponse(Object.fromEntries(requestedSymbols.map((symbol) => [symbol, { quote: { lastPrice: 10 } }])));
    }) as unknown as typeof fetch;

    const provider = new SchwabMarketDataProvider({ accessToken: "test-token", fetchFn });
    const result = await provider.getQuotes(symbols);

    // 4 of 5 chunks succeeded - exactly 4 chunks' worth of symbols present, never all-or-nothing.
    expect(result.size).toBe(totalSymbols - SCHWAB_QUOTE_BATCH_SIZE);
  });
});
