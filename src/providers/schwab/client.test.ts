import { describe, expect, it, vi } from "vitest";
import { isAbortError, schwabGetJson, SchwabApiError } from "./client";

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

  describe("Post-Phase-2 UX follow-up (end-to-end abandonment repair) - AbortSignal threading", () => {
    it("passes an optional signal straight through to fetchFn, so a bounded manual refresh can actually cancel an outstanding request", async () => {
      const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
      const controller = new AbortController();

      await schwabGetJson({
        accessToken: "token",
        baseUrl: "https://api.schwabapi.com/marketdata/v1",
        path: "/quotes",
        fetchFn: fetchFn as unknown as typeof fetch,
        signal: controller.signal,
      });

      expect(fetchFn).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ signal: controller.signal }));
    });

    it("every existing caller that omits signal keeps its exact prior behavior (fetchFn receives signal: undefined, never a manufactured one)", async () => {
      const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));

      await schwabGetJson({
        accessToken: "token",
        baseUrl: "https://api.schwabapi.com/marketdata/v1",
        path: "/quotes",
        fetchFn: fetchFn as unknown as typeof fetch,
      });

      expect(fetchFn).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ signal: undefined }));
    });

    it("an already-aborted signal causes the request to reject (real fetch/AbortController behavior) rather than silently completing", async () => {
      const controller = new AbortController();
      controller.abort();

      const fetchFn = (async (_url: URL, init?: RequestInit) => {
        if (init?.signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      await expect(
        schwabGetJson({
          accessToken: "token",
          baseUrl: "https://api.schwabapi.com/marketdata/v1",
          path: "/quotes",
          fetchFn,
          signal: controller.signal,
        }),
      ).rejects.toThrow("Aborted");
    });
  });

  describe("isAbortError (Codex blocker repair B3B/B3C)", () => {
    it("recognizes a real AbortError/DOMException", () => {
      expect(isAbortError(new DOMException("Aborted", "AbortError"))).toBe(true);
    });

    it("rejects a SchwabApiError - a genuine provider rejection is never mistaken for a caller-initiated abort", () => {
      expect(isAbortError(new SchwabApiError("Schwab request failed.", 500))).toBe(false);
    });

    it("rejects a plain Error, a non-Error thrown value, and never throws itself", () => {
      expect(isAbortError(new Error("something else"))).toBe(false);
      expect(isAbortError("a plain string")).toBe(false);
      expect(isAbortError(null)).toBe(false);
      expect(isAbortError(undefined)).toBe(false);
    });
  });
});
