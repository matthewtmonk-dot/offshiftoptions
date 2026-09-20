import { describe, expect, it, vi } from "vitest";

const queryRawMock = vi.fn();
const getBuildInfoMock = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: { $queryRaw: (...args: unknown[]) => queryRawMock(...args) },
}));
vi.mock("@/lib/build-info", () => ({
  getBuildInfo: (...args: unknown[]) => getBuildInfoMock(...args),
}));

import { GET } from "./route";

describe("GET /api/health", () => {
  it("reports app/database ok exactly as before, plus a commit field, when the database query succeeds", async () => {
    queryRawMock.mockResolvedValue([{ "?column?": 1 }]);
    getBuildInfoMock.mockReturnValue({ commit: "123bcc5abcde", buildTime: "2026-09-19T18:00:00.000Z" });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.app).toBe("ok");
    expect(body.database).toBe("ok");
    expect(body.commit).toBe("123bcc5abcde");
    expect(body.buildTime).toBe("2026-09-19T18:00:00.000Z");
    expect(typeof body.latencyMs).toBe("number");
    expect(typeof body.checkedAt).toBe("string");
  });

  it("keeps existing database-error semantics unchanged - 503, database: 'error', no raw error detail - while still including commit", async () => {
    queryRawMock.mockRejectedValue(new Error("connection refused: real internal detail should never leak"));
    getBuildInfoMock.mockReturnValue({ commit: "123bcc5abcde", buildTime: "2026-09-19T18:00:00.000Z" });

    const response = await GET();
    const body = await response.json();
    const text = JSON.stringify(body);

    expect(response.status).toBe(503);
    expect(body.app).toBe("ok");
    expect(body.database).toBe("error");
    expect(body.commit).toBe("123bcc5abcde");
    expect(body.latencyMs).toBeUndefined();
    expect(text).not.toContain("connection refused");
    expect(text).not.toContain("real internal detail");
  });

  it("falls back to 'unknown' safely (never throws/crashes the endpoint) when the commit source is unavailable", async () => {
    queryRawMock.mockResolvedValue([{ "?column?": 1 }]);
    getBuildInfoMock.mockReturnValue({ commit: "unknown", buildTime: null });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.commit).toBe("unknown");
    expect(body.buildTime).toBeNull();
  });

  it("never leaks secrets, env values, or a raw environment dump through the response", async () => {
    process.env.OSO_TEST_SECRET_SENTINEL = "sk-should-never-appear-here";
    queryRawMock.mockResolvedValue([{ "?column?": 1 }]);
    getBuildInfoMock.mockReturnValue({ commit: "123bcc5abcde", buildTime: "2026-09-19T18:00:00.000Z" });

    const response = await GET();
    const body = await response.json();
    const text = JSON.stringify(body);

    expect(Object.keys(body).sort()).toEqual(["app", "buildTime", "checkedAt", "commit", "database", "latencyMs"].sort());
    expect(text).not.toContain("sk-should-never-appear-here");
    delete process.env.OSO_TEST_SECRET_SENTINEL;
  });
});
