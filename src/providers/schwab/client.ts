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
}: {
  accessToken: string;
  baseUrl: string;
  path: string;
  searchParams?: URLSearchParams;
  fetchFn?: SchwabFetch;
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
