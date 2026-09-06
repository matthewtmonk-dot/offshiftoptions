import "server-only";

import { ALPHA_VANTAGE_BASE_URL } from "./config";

export type AlphaVantageFetch = typeof fetch;

export type AlphaVantageFetchResult = {
  payload: unknown;
  status: number;
  headers: Headers;
};

/**
 * Alpha Vantage signals rate limits/throttling and most error conditions via HTTP 200 with a
 * JSON body ("Note"/"Information"/"Error Message" keys), not via HTTP status codes - so this
 * wrapper deliberately does not throw on non-2xx-shaped-content the way schwabGetJson does.
 * Classification of the body happens in overview-diagnostic.ts. The API key is appended here
 * only, never logged, and never included in any thrown error.
 */
export async function fetchAlphaVantageJson({
  apiKey,
  searchParams,
  fetchFn = fetch,
  baseUrl = ALPHA_VANTAGE_BASE_URL,
}: {
  apiKey: string;
  searchParams: URLSearchParams;
  fetchFn?: AlphaVantageFetch;
  baseUrl?: string;
}): Promise<AlphaVantageFetchResult> {
  const url = new URL(baseUrl);
  for (const [key, value] of searchParams.entries()) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("apikey", apiKey);

  const response = await fetchFn(url, {
    headers: { Accept: "application/json" },
  });

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  return { payload, status: response.status, headers: response.headers };
}

export type AlphaVantageTextFetchResult = {
  text: string;
  status: number;
};

/**
 * A handful of Alpha Vantage endpoints (EARNINGS_CALENDAR) respond with CSV rather than JSON -
 * this fetches the raw response text without attempting to parse it as JSON. Alpha Vantage can
 * still signal throttling/errors on these endpoints via an HTTP 200 with a JSON body instead of
 * CSV, so callers must sniff the text (does it start with "{"?) before treating it as CSV - see
 * fetchAlphaVantageEarningsCalendar in earnings-calendar.ts.
 */
export async function fetchAlphaVantageText({
  apiKey,
  searchParams,
  fetchFn = fetch,
  baseUrl = ALPHA_VANTAGE_BASE_URL,
}: {
  apiKey: string;
  searchParams: URLSearchParams;
  fetchFn?: AlphaVantageFetch;
  baseUrl?: string;
}): Promise<AlphaVantageTextFetchResult> {
  const url = new URL(baseUrl);
  for (const [key, value] of searchParams.entries()) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("apikey", apiKey);

  const response = await fetchFn(url, {
    headers: { Accept: "text/csv" },
  });

  const text = await response.text();
  return { text, status: response.status };
}
