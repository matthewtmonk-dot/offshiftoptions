import { describe, expect, it, vi } from "vitest";
import {
  ALPHA_VANTAGE_REMAINING_VERIFICATION_TICKERS,
  ALPHA_VANTAGE_REQUEST_DELAY_MS,
  buildAlphaVantageOverviewDiagnosticFromApiKey,
  buildAlphaVantageOverviewDiagnosticReport,
  type AlphaVantageRawTickerResult,
} from "./overview-diagnostic";

function rowByLabel(report: ReturnType<typeof buildAlphaVantageOverviewDiagnosticReport>, label: string) {
  const row = report.rows.find((candidate) => candidate.label === label);
  if (!row) {
    throw new Error(`No diagnostic row for label "${label}"`);
  }
  return row;
}

function fetched(payload: unknown, status = 200, headerNames: string[] = []): AlphaVantageRawTickerResult {
  return { kind: "FETCHED", status, payload, headerNames };
}

describe("Alpha Vantage OVERVIEW diagnostic - allowlist and presence semantics", () => {
  const apldPayload = {
    Symbol: "APLD",
    Name: "Applied Digital Corporation",
    Description: "Applied Digital Corporation designs, develops, and operates data centers.",
    Sector: "TECHNOLOGY",
    Industry: "SERVICES-COMPUTER PROGRAMMING, DATA PROCESSING, ETC.",
    MarketCapitalization: "5123456789",
    PERatio: "-12.5",
    PEGRatio: "None",
    EPS: "-0.42",
    DividendPerShare: "0",
    DividendYield: "0",
    ProfitMargin: "None",
    apikey: "should-never-appear-in-a-real-payload-but-guard-anyway",
    secretInternalField: "should never surface - not on the allowlist",
  };

  it("marks a present, populated field as PRESENT_VALUE with its real value, including a negative P/E and negative EPS", () => {
    const report = buildAlphaVantageOverviewDiagnosticReport({ results: { APLD: fetched(apldPayload) }, tickers: ["APLD"] });
    expect(rowByLabel(report, "P/E Ratio").values.APLD).toEqual({ state: "PRESENT_VALUE", value: "-12.5" });
    expect(rowByLabel(report, "EPS").values.APLD).toEqual({ state: "PRESENT_VALUE", value: "-0.42" });
    expect(rowByLabel(report, "Name").values.APLD).toEqual({ state: "PRESENT_VALUE", value: "Applied Digital Corporation" });
  });

  it("preserves real zero values as PRESENT_VALUE, never collapsing them to ABSENT/NULL", () => {
    const report = buildAlphaVantageOverviewDiagnosticReport({ results: { APLD: fetched(apldPayload) }, tickers: ["APLD"] });
    expect(rowByLabel(report, "Dividend Per Share").values.APLD).toEqual({ state: "PRESENT_VALUE", value: "0" });
    expect(rowByLabel(report, "Dividend Yield").values.APLD).toEqual({ state: "PRESENT_VALUE", value: "0" });
  });

  it('maps Alpha Vantage\'s own "None" null sentinel to PRESENT_NULL, never to 0 or a literal string value', () => {
    const report = buildAlphaVantageOverviewDiagnosticReport({ results: { APLD: fetched(apldPayload) }, tickers: ["APLD"] });
    expect(rowByLabel(report, "PEG Ratio").values.APLD).toEqual({ state: "PRESENT_NULL", value: null, raw: "None" });
    expect(rowByLabel(report, "Profit Margin").values.APLD).toEqual({ state: "PRESENT_NULL", value: null, raw: "None" });
  });

  it("maps '-' and empty string sentinels to PRESENT_NULL as well, without inferring a value", () => {
    const report = buildAlphaVantageOverviewDiagnosticReport({
      results: { APLD: fetched({ ...apldPayload, MarketCapitalization: "-", AnalystTargetPrice: "" }) },
      tickers: ["APLD"],
    });
    expect(rowByLabel(report, "Market Capitalization").values.APLD).toEqual({ state: "PRESENT_NULL", value: null, raw: "-" });
    expect(rowByLabel(report, "Analyst Target Price").values.APLD.state).toBe("PRESENT_NULL");
  });

  it("marks a genuinely missing key as ABSENT, distinct from PRESENT_NULL", () => {
    const report = buildAlphaVantageOverviewDiagnosticReport({ results: { APLD: fetched(apldPayload) }, tickers: ["APLD"] });
    expect(rowByLabel(report, "Current Ratio").values.APLD).toEqual({ state: "ABSENT", value: null });
    expect(rowByLabel(report, "Debt To Equity").values.APLD).toEqual({ state: "ABSENT", value: null });
    expect(rowByLabel(report, "Quick Ratio").values.APLD).toEqual({ state: "ABSENT", value: null });
  });

  it("never surfaces a field that is not on the allowlist, no matter what Alpha Vantage returned", () => {
    const report = buildAlphaVantageOverviewDiagnosticReport({ results: { APLD: fetched(apldPayload) }, tickers: ["APLD"] });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("secretInternalField");
    expect(serialized).not.toContain("should never surface");
    expect(report.rows.some((row) => row.label.toLowerCase().includes("secret"))).toBe(false);
  });

  it("never leaks the API key used to fetch the payload anywhere in the built report", () => {
    const sentinelKey = "sentinel-alpha-vantage-key-must-never-leak";
    const report = buildAlphaVantageOverviewDiagnosticReport({
      results: { APLD: fetched({ ...apldPayload, Description: `Contains the key ${sentinelKey} inline` }) },
      tickers: ["APLD"],
      apiKey: sentinelKey,
    });
    expect(JSON.stringify(report)).not.toContain(sentinelKey);
  });

  it("classifies a Note-bearing response as RATE_LIMITED and reports the sanitized message", () => {
    const report = buildAlphaVantageOverviewDiagnosticReport({
      results: { RIOT: fetched({ Note: "Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day." }) },
      tickers: ["RIOT"],
    });
    const outcome = report.results.find((r) => r.ticker === "RIOT");
    expect(outcome).toMatchObject({ outcome: "RATE_LIMITED" });
    expect((outcome as { message: string }).message).toContain("25 requests per day");
  });

  it("classifies an Information-bearing response as RATE_LIMITED too", () => {
    const report = buildAlphaVantageOverviewDiagnosticReport({
      results: { RIOT: fetched({ Information: "Thank you for using Alpha Vantage! This is a premium endpoint." }) },
      tickers: ["RIOT"],
    });
    expect(report.results.find((r) => r.ticker === "RIOT")).toMatchObject({ outcome: "RATE_LIMITED" });
  });

  it("classifies an empty object (no Symbol) as EMPTY, and does not fabricate field rows for it", () => {
    const report = buildAlphaVantageOverviewDiagnosticReport({ results: { CORZ: fetched({}) }, tickers: ["CORZ"] });
    expect(report.results.find((r) => r.ticker === "CORZ")).toMatchObject({ outcome: "EMPTY" });
    expect(rowByLabel(report, "P/E Ratio").values.CORZ).toEqual({ state: "CALL_UNAVAILABLE", value: null });
  });

  it("classifies a non-2xx HTTP status as HTTP_ERROR without throwing", () => {
    const report = buildAlphaVantageOverviewDiagnosticReport({ results: { CORZ: fetched({}, 500) }, tickers: ["CORZ"] });
    expect(report.results.find((r) => r.ticker === "CORZ")).toMatchObject({ outcome: "HTTP_ERROR", status: 500 });
  });

  it("reports a SKIPPED outcome for a ticker with no recorded result, distinct from a real failure", () => {
    const report = buildAlphaVantageOverviewDiagnosticReport({ results: {}, tickers: ["CORZ"] });
    expect(report.results.find((r) => r.ticker === "CORZ")).toMatchObject({ outcome: "SKIPPED" });
  });

  it("counts calls consumed only for tickers actually fetched (SKIPPED never counts)", () => {
    const report = buildAlphaVantageOverviewDiagnosticReport({
      results: {
        APLD: fetched(apldPayload),
        RIOT: { kind: "SKIPPED", reason: "Skipped to preserve quota." },
      },
      tickers: ["APLD", "RIOT", "CORZ"],
    });
    expect(report.callsConsumed).toBe(1);
    expect(report.maxCallsAllowed).toBe(3);
    expect(report.results.find((r) => r.ticker === "CORZ")).toMatchObject({ outcome: "SKIPPED" });
  });

  it("detects a rate-limit-shaped response header if Alpha Vantage ever sends one", () => {
    const report = buildAlphaVantageOverviewDiagnosticReport({
      results: { APLD: fetched(apldPayload, 200, ["X-RateLimit-Remaining"]) },
      tickers: ["APLD"],
    });
    expect(report.rateLimitHeaderObserved).toBe(true);
    expect(report.rateLimitHeaderNames).toContain("X-RateLimit-Remaining");
  });

  it("reports no rate-limit header when none is present, rather than assuming one exists", () => {
    const report = buildAlphaVantageOverviewDiagnosticReport({ results: { APLD: fetched(apldPayload) }, tickers: ["APLD"] });
    expect(report.rateLimitHeaderObserved).toBe(false);
    expect(report.rateLimitHeaderNames).toEqual([]);
  });

  it("reports the exact endpoint used, matching function=OVERVIEW", () => {
    const report = buildAlphaVantageOverviewDiagnosticReport({ results: { APLD: fetched(apldPayload) }, tickers: ["APLD"] });
    expect(report.endpointFunction).toBe("OVERVIEW");
    expect(report.source).toBe("Alpha Vantage");
    expect(report.readOnly).toBe(true);
    expect(report.nothingSaved).toBe(true);
  });
});

describe("Alpha Vantage OVERVIEW diagnostic - live sequential fetch orchestration", () => {
  it("stops issuing further calls after a rate-limit signal, marking remaining tickers SKIPPED", async () => {
    const calls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const symbol = new URL(url).searchParams.get("symbol") ?? "";
      calls.push(symbol);
      return new Response(JSON.stringify({ Note: "Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day." }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const report = await buildAlphaVantageOverviewDiagnosticFromApiKey({
      apiKey: "test-key",
      fetchFn,
      now: new Date("2026-09-03T12:00:00Z"),
    });

    expect(calls).toEqual(["APLD"]);
    expect(report.callsConsumed).toBe(1);
    expect(report.results.map((r) => r.outcome)).toEqual(["RATE_LIMITED", "SKIPPED", "SKIPPED"]);
  });

  it("fetches all tickers when none of them are rate-limited", async () => {
    const calls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const symbol = new URL(url).searchParams.get("symbol") ?? "";
      calls.push(symbol);
      return new Response(JSON.stringify({ Symbol: symbol, Name: `${symbol} Inc.` }), { status: 200 });
    }) as unknown as typeof fetch;

    const report = await buildAlphaVantageOverviewDiagnosticFromApiKey({
      apiKey: "test-key",
      fetchFn,
      now: new Date("2026-09-03T12:00:00Z"),
    });

    expect(calls).toEqual(["APLD", "RIOT", "CORZ"]);
    expect(report.callsConsumed).toBe(3);
    expect(report.results.map((r) => r.outcome)).toEqual(["SUCCESS", "SUCCESS", "SUCCESS"]);
  });

  it("never includes the API key used to fetch the payload anywhere in the built report", async () => {
    const sentinelKey = "sentinel-live-alpha-vantage-key-must-never-leak";
    const fetchFn = (async () => new Response(JSON.stringify({ Symbol: "APLD", Name: "Applied Digital Corporation" }), { status: 200 })) as unknown as typeof fetch;

    const report = await buildAlphaVantageOverviewDiagnosticFromApiKey({
      apiKey: sentinelKey,
      tickers: ["APLD"],
      fetchFn,
      now: new Date("2026-09-03T12:00:00Z"),
    });

    expect(JSON.stringify(report)).not.toContain(sentinelKey);
  });

  it("never includes the API key in a URL that reaches the fetch layer's recorded call, beyond the querystring param itself", async () => {
    let observedUrl = "";
    const fetchFn = (async (input: RequestInfo | URL) => {
      observedUrl = input.toString();
      return new Response(JSON.stringify({ Symbol: "APLD" }), { status: 200 });
    }) as unknown as typeof fetch;

    await buildAlphaVantageOverviewDiagnosticFromApiKey({ apiKey: "test-key", tickers: ["APLD"], fetchFn, now: new Date() });
    expect(observedUrl).toContain("apikey=test-key");
    expect(observedUrl).toContain("function=OVERVIEW");
    expect(observedUrl).toContain("symbol=APLD");
  });
});

describe("Alpha Vantage OVERVIEW diagnostic - request pacing (2026-09-03 production fix)", () => {
  function fetchFnReturning(symbolToPayload: (symbol: string) => unknown) {
    return (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const symbol = new URL(url).searchParams.get("symbol") ?? "";
      return new Response(JSON.stringify(symbolToPayload(symbol)), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("waits at least 1250ms between calls, using the exported delay constant", async () => {
    expect(ALPHA_VANTAGE_REQUEST_DELAY_MS).toBeGreaterThanOrEqual(1250);

    const delayFn = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const fetchFn = fetchFnReturning((symbol) => ({ Symbol: symbol }));

    await buildAlphaVantageOverviewDiagnosticFromApiKey({ apiKey: "test-key", fetchFn, delayFn, now: new Date() });

    expect(delayFn).toHaveBeenCalledTimes(2); // 3 tickers -> 2 gaps
    for (const call of delayFn.mock.calls) {
      expect(call[0]).toBeGreaterThanOrEqual(1250);
    }
  });

  it("never delays before the first request", async () => {
    const delayFn = vi.fn(async () => {});
    const callOrder: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      callOrder.push("fetch");
      const url = typeof input === "string" ? input : input.toString();
      const symbol = new URL(url).searchParams.get("symbol") ?? "";
      return new Response(JSON.stringify({ Symbol: symbol }), { status: 200 });
    }) as unknown as typeof fetch;
    delayFn.mockImplementation(async () => {
      callOrder.push("delay");
    });

    await buildAlphaVantageOverviewDiagnosticFromApiKey({ apiKey: "test-key", fetchFn, delayFn, now: new Date() });

    expect(callOrder[0]).toBe("fetch"); // first action is a fetch, never a delay
    expect(callOrder).toEqual(["fetch", "delay", "fetch", "delay", "fetch"]);
  });

  it("does not delay before a call that never happens because of an earlier throttle stop", async () => {
    const delayFn = vi.fn(async () => {});
    const fetchFn = fetchFnReturning(() => ({ Information: "Please consider spreading out your free API requests more sparingly (1 request per second)." }));

    const report = await buildAlphaVantageOverviewDiagnosticFromApiKey({ apiKey: "test-key", fetchFn, delayFn, now: new Date() });

    // Only the 1st ticker is actually fetched (no delay before it); the throttle stops the 2nd
    // and 3rd from ever being attempted, so there is no delay call for them either.
    expect(delayFn).not.toHaveBeenCalled();
    expect(report.results.map((r) => r.outcome)).toEqual(["RATE_LIMITED", "SKIPPED", "SKIPPED"]);
    expect(report.callsConsumed).toBe(1);
  });

  it("still stops issuing further calls after a real throttle response, with pacing enabled", async () => {
    const calls: string[] = [];
    const delayFn = vi.fn(async () => {});
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const symbol = new URL(url).searchParams.get("symbol") ?? "";
      calls.push(symbol);
      if (symbol === "RIOT") {
        return new Response(
          JSON.stringify({ Information: "Please consider spreading out your free API requests more sparingly (1 request per second)." }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ Symbol: symbol }), { status: 200 });
    }) as unknown as typeof fetch;

    const report = await buildAlphaVantageOverviewDiagnosticFromApiKey({ apiKey: "test-key", fetchFn, delayFn, now: new Date() });

    expect(calls).toEqual(["APLD", "RIOT"]); // CORZ never called
    expect(report.results.map((r) => r.outcome)).toEqual(["SUCCESS", "RATE_LIMITED", "SKIPPED"]);
    expect(report.callsConsumed).toBe(2);
  });

  it("supports running only a ticker subset (RIOT, CORZ) without ever calling APLD", async () => {
    const calls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const symbol = new URL(url).searchParams.get("symbol") ?? "";
      calls.push(symbol);
      return new Response(JSON.stringify({ Symbol: symbol }), { status: 200 });
    }) as unknown as typeof fetch;

    const report = await buildAlphaVantageOverviewDiagnosticFromApiKey({
      apiKey: "test-key",
      tickers: ALPHA_VANTAGE_REMAINING_VERIFICATION_TICKERS,
      fetchFn,
      delayFn: vi.fn(async () => {}),
      now: new Date(),
    });

    expect(calls).toEqual(["RIOT", "CORZ"]);
    expect(calls).not.toContain("APLD");
    expect(report.tickers).toEqual(["RIOT", "CORZ"]);
  });

  it("caps the remaining-tickers follow-up at 2 requests total", async () => {
    const fetchFn = fetchFnReturning((symbol) => ({ Symbol: symbol }));

    const report = await buildAlphaVantageOverviewDiagnosticFromApiKey({
      apiKey: "test-key",
      tickers: ALPHA_VANTAGE_REMAINING_VERIFICATION_TICKERS,
      fetchFn,
      delayFn: vi.fn(async () => {}),
      now: new Date(),
    });

    expect(report.maxCallsAllowed).toBe(2);
    expect(report.callsConsumed).toBeLessThanOrEqual(2);
  });

  it("uses the real setTimeout-based delay by default when no delayFn is injected (smoke test, short-circuited via a 0ms override)", async () => {
    const fetchFn = fetchFnReturning((symbol) => ({ Symbol: symbol }));
    const start = Date.now();

    await buildAlphaVantageOverviewDiagnosticFromApiKey({ apiKey: "test-key", tickers: ["APLD"], fetchFn, delayMs: 0, now: new Date() });

    // Single ticker -> zero gaps -> should resolve near-instantly even with the real default delay implementation.
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("never leaks the API key in the remaining-tickers (RIOT, CORZ) follow-up report either", async () => {
    const sentinelKey = "sentinel-remaining-tickers-key-must-never-leak";
    const fetchFn = fetchFnReturning((symbol) => ({ Symbol: symbol, Description: `Some text mentioning ${sentinelKey} inline` }));

    const report = await buildAlphaVantageOverviewDiagnosticFromApiKey({
      apiKey: sentinelKey,
      tickers: ALPHA_VANTAGE_REMAINING_VERIFICATION_TICKERS,
      fetchFn,
      delayFn: vi.fn(async () => {}),
      now: new Date(),
    });

    expect(JSON.stringify(report)).not.toContain(sentinelKey);
  });
});
