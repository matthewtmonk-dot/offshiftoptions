import { beforeEach, describe, expect, it, vi } from "vitest";
import { needsRefresh, tokenExpiresAt } from "./tokens";

describe("Schwab token lifecycle helpers", () => {
  it("refreshes one minute before expiration", () => {
    const now = new Date("2026-08-31T12:00:00Z");

    expect(needsRefresh({ expiresAt: new Date("2026-08-31T12:00:30Z") }, now)).toBe(true);
    expect(needsRefresh({ expiresAt: new Date("2026-08-31T12:05:00Z") }, now)).toBe(false);
    expect(needsRefresh({ expiresAt: null }, now)).toBe(true);
  });

  it("uses the Schwab expires_in field when present", () => {
    const now = new Date("2026-08-31T12:00:00Z");

    expect(tokenExpiresAt({ expires_in: 1800 }, now)).toEqual(new Date("2026-08-31T12:30:00Z"));
    expect(tokenExpiresAt({}, now)).toEqual(new Date("2026-08-31T12:30:00Z"));
  });
});

/**
 * Codex blocker repair (B3B/B3C, scheduled-capture Phase 2A round 2) - PROVES the actual signal
 * reaches the real token-refresh fetch (never merely asserting a wrapper "received a signal"),
 * and proves a caller-initiated abort of ITS OWN refresh attempt never corrupts the shared
 * `BrokerConnection.status` (the bug that would otherwise mark a healthy connection EXPIRED just
 * because a scheduled capture's own 45s deadline fired mid-refresh). Mocks only the modules that
 * would otherwise require a real database/real crypto key (prisma, crypto, developer-credentials)
 * - the fetch call itself is a real fake-fetch function that inspects the real `RequestInit` it
 * receives, exactly like client.test.ts's own established AbortSignal-proof pattern.
 */
const mocks = vi.hoisted(() => ({
  db: { brokerConnection: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() } },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.db }));
vi.mock("./crypto", () => ({
  decryptToken: (ciphertext: string) => ciphertext.replace("ciphertext:", ""),
  encryptToken: (plaintext: string) => `ciphertext:${plaintext}`,
}));
vi.mock("./developer-credentials", () => ({
  resolveSchwabOAuthConfigForConnection: async () => ({
    config: { clientId: "test-client-id", clientSecret: "test-client-secret", redirectUri: "https://example.com/callback" },
  }),
}));

describe("refreshSchwabConnectionAccessToken - real signal propagation (Codex blocker repair B3B/B3C)", () => {
  const CONNECTION = {
    id: "conn-1",
    userId: "owner-1",
    refreshTokenCiphertext: "ciphertext:refresh-token-value",
    metadata: null,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.db.brokerConnection.findFirst.mockResolvedValue(CONNECTION);
    mocks.db.brokerConnection.findUnique.mockResolvedValue({ metadata: null });
    mocks.db.brokerConnection.update.mockResolvedValue({ accessTokenCiphertext: "ciphertext:new-access-token" });
    mocks.db.brokerConnection.updateMany.mockResolvedValue({ count: 1 });
  });

  it("passes the caller-supplied signal all the way to the real fetch call for the token POST", async () => {
    const { refreshSchwabConnectionAccessToken } = await import("./tokens");
    const controller = new AbortController();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ access_token: "new-token" }), { status: 200 }));

    await refreshSchwabConnectionAccessToken("conn-1", fetchFn as unknown as typeof fetch, controller.signal);

    expect(fetchFn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ signal: controller.signal }));
  });

  it("an ALREADY-aborted signal causes the token fetch itself to reject (real AbortController behavior, not a mocked wrapper)", async () => {
    const { refreshSchwabConnectionAccessToken } = await import("./tokens");
    const controller = new AbortController();
    controller.abort();
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return new Response(JSON.stringify({ access_token: "new-token" }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(refreshSchwabConnectionAccessToken("conn-1", fetchFn, controller.signal)).rejects.toThrow();
  });

  it("Codex blocker repair (B3B) - an abort of THIS caller's own refresh attempt is REthrown, never swallowed into a null return, and NEVER marks the connection EXPIRED", async () => {
    const { refreshSchwabConnectionAccessToken } = await import("./tokens");
    const controller = new AbortController();
    controller.abort();
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return new Response(JSON.stringify({ access_token: "new-token" }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(refreshSchwabConnectionAccessToken("conn-1", fetchFn, controller.signal)).rejects.toThrow();
    // markConnectionExpired (which writes status: EXPIRED via updateMany) is NEVER called for this
    // caller-initiated abort - a genuine Schwab rejection (SchwabApiError) is the only thing that
    // should ever do that.
    expect(mocks.db.brokerConnection.updateMany).not.toHaveBeenCalled();
  });

  it("a genuine Schwab-side rejection (no signal involved) still marks the connection EXPIRED exactly as before - the abort-safety fix is narrowly scoped to aborts only", async () => {
    const { refreshSchwabConnectionAccessToken } = await import("./tokens");
    const fetchFn = vi.fn(async () => new Response("unauthorized", { status: 401 }));

    const result = await refreshSchwabConnectionAccessToken("conn-1", fetchFn as unknown as typeof fetch);

    expect(result).toBeNull();
    expect(mocks.db.brokerConnection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "EXPIRED" }) }),
    );
  });

  it("every existing caller that omits signal keeps its exact prior behavior (fetchFn receives signal: undefined)", async () => {
    const { refreshSchwabConnectionAccessToken } = await import("./tokens");
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ access_token: "new-token" }), { status: 200 }));

    await refreshSchwabConnectionAccessToken("conn-1", fetchFn as unknown as typeof fetch);

    expect(fetchFn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ signal: undefined }));
  });
});
