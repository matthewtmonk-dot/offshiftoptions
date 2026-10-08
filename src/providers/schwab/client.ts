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

/**
 * Codex blocker repair (B3B/B3C, scheduled-capture Phase 2A) - true for the native abort rejection
 * a `fetch` call throws when ITS OWN caller-supplied `AbortSignal` fires (`DOMException`/`Error`
 * with `name === "AbortError"`), as opposed to a genuine Schwab-side rejection (`SchwabApiError`,
 * a network failure, a malformed response, etc). Exists so a caller that deliberately cancels its
 * OWN bounded request (e.g. scheduled capture's own deadline) can tell "I gave up waiting" apart
 * from "Schwab actually rejected this" - the two must never be handled identically, since only the
 * latter is real evidence about the connection/credential itself (see tokens.ts's own use of this
 * to avoid marking a healthy connection EXPIRED just because one caller's own timeout fired).
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
