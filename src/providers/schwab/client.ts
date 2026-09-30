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

export async function schwabGetJson<T>({
  accessToken,
  baseUrl,
  path,
  searchParams,
  fetchFn = fetch,
  signal,
}: {
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
}): Promise<T> {
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

  return (await response.json()) as T;
}
