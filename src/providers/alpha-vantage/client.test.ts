import { describe, expect, it } from "vitest";
import { fetchAlphaVantageJson, fetchAlphaVantageText } from "./client";

function capturingFetch(responseText: string, status = 200) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: url as URL, init });
    return new Response(responseText, { status });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("fetchAlphaVantageText", () => {
  it("sends no restrictive Accept: text/csv header - a plain, unrestricted request (no init object at all)", async () => {
    const { fetchFn, calls } = capturingFetch("symbol,reportDate\nAAPL,2026-09-07\n");
    await fetchAlphaVantageText({ apiKey: "test-key", searchParams: new URLSearchParams({ function: "EARNINGS_CALENDAR" }), fetchFn });

    expect(calls).toHaveLength(1);
    // The fix: call fetchFn(url) with no second argument at all - not merely a differently-valued
    // Accept header, since any explicit Accept could reproduce the same content-negotiation risk.
    expect(calls[0].init).toBeUndefined();
  });

  it("still returns a successful CSV response body and status unchanged", async () => {
    const csv = "symbol,reportDate\nAAPL,2026-09-07\n";
    const { fetchFn } = capturingFetch(csv);
    const result = await fetchAlphaVantageText({ apiKey: "test-key", searchParams: new URLSearchParams(), fetchFn });
    expect(result.status).toBe(200);
    expect(result.text).toBe(csv);
  });

  it("still returns a JSON throttle body verbatim as text - classification happens in the caller", async () => {
    const jsonBody = JSON.stringify({ Information: "Please consider spreading out your free API requests." });
    const { fetchFn } = capturingFetch(jsonBody);
    const result = await fetchAlphaVantageText({ apiKey: "test-key", searchParams: new URLSearchParams(), fetchFn });
    expect(result.status).toBe(200);
    expect(result.text).toBe(jsonBody);
  });

  it("still returns a non-2xx status unchanged (e.g. what used to surface as 406)", async () => {
    const { fetchFn } = capturingFetch("", 406);
    const result = await fetchAlphaVantageText({ apiKey: "test-key", searchParams: new URLSearchParams(), fetchFn });
    expect(result.status).toBe(406);
  });

  it("sends the API key only as a URL query parameter, never in a header, and it never leaks into the returned result", async () => {
    const sentinelKey = "sentinel-client-text-key-must-never-leak";
    const { fetchFn, calls } = capturingFetch("symbol,reportDate\nAAPL,2026-09-07\n");
    const result = await fetchAlphaVantageText({ apiKey: sentinelKey, searchParams: new URLSearchParams({ function: "EARNINGS_CALENDAR" }), fetchFn });

    expect(calls[0].url.searchParams.get("apikey")).toBe(sentinelKey); // only place it's allowed to appear
    expect(calls[0].init).toBeUndefined(); // no headers object at all - nowhere for the key to leak into
    expect(JSON.stringify(result)).not.toContain(sentinelKey);
  });
});

describe("fetchAlphaVantageJson", () => {
  it("still sends Accept: application/json - unchanged by this fix", async () => {
    const { fetchFn, calls } = capturingFetch(JSON.stringify({ ok: true }));
    await fetchAlphaVantageJson({ apiKey: "test-key", searchParams: new URLSearchParams({ function: "OVERVIEW" }), fetchFn });

    const headers = new Headers(calls[0].init?.headers as HeadersInit);
    expect(headers.get("Accept")).toBe("application/json");
  });

  it("still parses a successful JSON body unchanged", async () => {
    const { fetchFn } = capturingFetch(JSON.stringify({ Symbol: "AAPL" }));
    const result = await fetchAlphaVantageJson({ apiKey: "test-key", searchParams: new URLSearchParams(), fetchFn });
    expect(result.payload).toEqual({ Symbol: "AAPL" });
    expect(result.status).toBe(200);
  });
});
