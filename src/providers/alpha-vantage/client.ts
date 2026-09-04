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
