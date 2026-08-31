import { describe, expect, it } from "vitest";
import { schwabGetJson, SchwabApiError } from "./client";

describe("Schwab API client", () => {
  it("surfaces rate limits without leaking tokens", async () => {
    const fetchFn = async () =>
      new Response("{}", {
        status: 429,
        headers: { "retry-after": "60" },
      });

    await expect(
      schwabGetJson({
        accessToken: "secret-access-token",
        baseUrl: "https://api.schwabapi.com/marketdata/v1",
        path: "/quotes",
        fetchFn: fetchFn as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "SchwabApiError",
      status: 429,
      retryAfter: "60",
    } satisfies Partial<SchwabApiError>);
  });
});
