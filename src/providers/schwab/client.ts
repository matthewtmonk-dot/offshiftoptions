import "server-only";

export type SchwabFetch = typeof fetch;

export class SchwabApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfter?: string | null,
  ) {
    super(message);
    this.name = "SchwabApiError";
  }
}

type SchwabRequestOptions = {
  accessToken: string;
  baseUrl: string;
  path: string;
  searchParams?: URLSearchParams;
  fetchFn?: SchwabFetch;
  /** Post-Phase-2 UX follow-up ("Universal Refresh Status" - end-to-end abandonment repair) -
   * optional and purely additive: every existing caller that omits it keeps its exact prior
   * behavior (an `undefined` signal is a no-op for `fetch`). Only the manual "Refresh status"
   * control's own bounded-operation path (see refresh-guard.ts) passes one, so a timed-out
   * generation's outstanding HTTP request actually aborts instead of running to completion in the
   * background and later publishing stale evidence. */
  signal?: AbortSignal;
};

/**
 * The one shared request-building/error-classification path for every Schwab GET - factored out
 * of schwabGetJson (Trade Prep strict-evidence foundation) so a caller that needs the raw
 * `Response` itself (e.g. to read the HTTP `Date` header as pure transport evidence - see
 * StrictOptionChainTransportEvidence) can reuse the exact same URL-building, auth-header, and
 * error-classification behavior instead of duplicating it. `schwabGetJson` below is unchanged in
 * behavior/signature - it is now a thin wrapper over this function.
 */
export async function schwabFetchResponse({ accessToken, baseUrl, path, searchParams, fetchFn = fetch, signal }: SchwabRequestOptions): Promise<Response> {
  const url = new URL(`${baseUrl}${path}`);
  if (searchParams) {
    for (const [key, value] of searchParams.entries()) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetchFn(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    signal,
  });

  if (!response.ok) {
    throw new SchwabApiError(
      response.status === 429
        ? "Schwab rate limit reached."
        : response.status === 401
          ? "Schwab authorization is expired or unavailable."
          : "Schwab request failed.",
      response.status,
      response.headers.get("retry-after"),
    );
  }

  return response;
}

export async function schwabGetJson<T>(options: SchwabRequestOptions): Promise<T> {
  const response = await schwabFetchResponse(options);
  return (await response.json()) as T;
}
