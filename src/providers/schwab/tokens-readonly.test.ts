import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ findFirst: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { brokerConnection: db } }));
vi.mock("./crypto", () => ({ decryptToken: vi.fn(() => "TOKEN"), encryptToken: vi.fn() }));
import { getValidSchwabAccessTokenForConnection } from "./tokens";

describe("read-only existing Schwab token", () => {
  beforeEach(() => vi.clearAllMocks());
  const connection = { id: "connection", userId: "owner", status: "CONNECTED", accessTokenCiphertext: "encrypted", refreshTokenCiphertext: "encrypted-refresh" };
  it.each([null, new Date(0), new Date(Date.now() + 10000)])("refuses refresh without HTTP or DB mutation (%s)", async expiresAt => {
    db.findFirst.mockResolvedValue({ ...connection, expiresAt });
    const fetchFn = vi.fn<typeof fetch>();
    expect(await getValidSchwabAccessTokenForConnection("connection", { expectedUserId: "owner", allowRefresh: false, fetchFn })).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
  it("uses a fresh token only for its owner", async () => {
    db.findFirst.mockResolvedValue({ ...connection, expiresAt: new Date(Date.now() + 600000) });
    expect(await getValidSchwabAccessTokenForConnection("connection", { expectedUserId: "owner", allowRefresh: false })).toBe("TOKEN");
    expect(await getValidSchwabAccessTokenForConnection("connection", { expectedUserId: "other", allowRefresh: false })).toBeNull();
    expect(db.update).not.toHaveBeenCalled();
  });
});
