import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refreshOccMock = vi.fn();
const occCacheStatusMock = vi.fn();
const refreshEarningsMock = vi.fn();
const earningsCacheStatusMock = vi.fn();

vi.mock("@/lib/occ-optionable-universe-refresh", () => ({
  OCC_OPTIONABLE_UNIVERSE_SOURCE: "OCC",
  refreshOccOptionableUniverse: (...args: unknown[]) => refreshOccMock(...args),
}));
vi.mock("@/lib/optionable-universe-cache", () => ({
  getOptionableUniverseCacheStatus: (...args: unknown[]) => occCacheStatusMock(...args),
}));
vi.mock("@/lib/earnings-calendar-cache", () => ({
  refreshEarningsCalendarCache: (...args: unknown[]) => refreshEarningsMock(...args),
  getEarningsCalendarCacheStatus: (...args: unknown[]) => earningsCacheStatusMock(...args),
}));

import { POST } from "./route";

function requestWithHeaders(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/internal/scanner-reference/refresh", { method: "POST", headers });
}

function emptyOccCacheStatus() {
  return { lastSuccessfulRefreshBySource: new Map(), totalSymbolCount: 0 };
}

function occCacheStatusWith(count: number, lastSeenAt: Date) {
  return { lastSuccessfulRefreshBySource: new Map([["OCC", { symbolCount: count, lastSeenAt }]]), totalSymbolCount: count };
}

describe("POST /api/internal/scanner-reference/refresh", () => {
  const ORIGINAL_SECRET = process.env.OSO_CRON_SECRET;

  beforeEach(() => {
    refreshOccMock.mockReset();
    occCacheStatusMock.mockReset();
    refreshEarningsMock.mockReset();
    earningsCacheStatusMock.mockReset();
    occCacheStatusMock.mockResolvedValue(emptyOccCacheStatus());
    earningsCacheStatusMock.mockResolvedValue({ lastSuccessfulRefreshAt: null, entryCount: 0, isStale: true });
    process.env.OSO_CRON_SECRET = "sentinel-scanner-reference-secret";
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) {
      delete process.env.OSO_CRON_SECRET;
    } else {
      process.env.OSO_CRON_SECRET = ORIGINAL_SECRET;
    }
  });

  it("returns 401 and refreshes nothing when the secret header is missing", async () => {
    const response = await POST(requestWithHeaders({}));
    expect(response.status).toBe(401);
    expect(refreshOccMock).not.toHaveBeenCalled();
    expect(refreshEarningsMock).not.toHaveBeenCalled();
  });

  it("returns 401 and refreshes nothing when the secret is wrong", async () => {
    const response = await POST(requestWithHeaders({ authorization: "Bearer wrong-secret" }));
    expect(response.status).toBe(401);
    expect(refreshOccMock).not.toHaveBeenCalled();
    expect(refreshEarningsMock).not.toHaveBeenCalled();
  });

  it("returns 401 when OSO_CRON_SECRET is not configured on the server at all", async () => {
    delete process.env.OSO_CRON_SECRET;
    const response = await POST(requestWithHeaders({ authorization: "Bearer anything" }));
    expect(response.status).toBe(401);
    expect(refreshOccMock).not.toHaveBeenCalled();
  });

  it("also accepts the secret via the X-OSO-Cron-Secret header", async () => {
    refreshOccMock.mockResolvedValue({ status: "EMPTY", message: "no fetch configured in this test" });
    refreshEarningsMock.mockResolvedValue({ status: "ALREADY_FRESH", cache: { lastSuccessfulRefreshAt: new Date(), entryCount: 10, isStale: false } });
    const response = await POST(requestWithHeaders({ "x-oso-cron-secret": "sentinel-scanner-reference-secret" }));
    expect(response.status).toBe(200);
    expect(refreshOccMock).toHaveBeenCalledTimes(1);
    expect(refreshEarningsMock).toHaveBeenCalledTimes(1);
  });

  it("reports OCC success with raw/normalized/current counts and last refresh time - never a symbol list", async () => {
    const lastSeenAt = new Date("2026-09-07T12:00:00Z");
    refreshOccMock.mockResolvedValue({
      status: "SUCCESS",
      source: "OCC",
      rawRowCount: 6354,
      excludedRowCount: 0,
      upsertedCount: 6071,
      removedCount: 3,
    });
    occCacheStatusMock.mockResolvedValue(occCacheStatusWith(6071, lastSeenAt));
    refreshEarningsMock.mockResolvedValue({ status: "ALREADY_FRESH", cache: { lastSuccessfulRefreshAt: new Date(), entryCount: 10, isStale: false } });

    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-scanner-reference-secret" }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.occ).toMatchObject({
      status: "SUCCESS",
      rawRows: 6354,
      normalizedSymbols: 6071,
      upsertedCount: 6071,
      removedCount: 3,
      currentCount: 6071,
      lastSuccessfulRefreshAt: lastSeenAt.toISOString(),
    });
    expect(JSON.stringify(body)).not.toContain("AAPL");
  });

  it("reports an OCC COUNT_TOO_LOW rejection honestly without treating it as a hard error", async () => {
    refreshOccMock.mockResolvedValue({ status: "COUNT_TOO_LOW", message: "too few rows", actualCount: 5, minimumExpectedCount: 1000 });
    refreshEarningsMock.mockResolvedValue({ status: "NO_API_KEY" });

    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-scanner-reference-secret" }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.occ.status).toBe("COUNT_TOO_LOW");
  });

  it("reports whether an Alpha Vantage call was actually used - not used when already fresh or no key", async () => {
    refreshOccMock.mockResolvedValue({ status: "EMPTY", message: "unused in this test" });

    refreshEarningsMock.mockResolvedValue({ status: "ALREADY_FRESH", cache: { lastSuccessfulRefreshAt: new Date(), entryCount: 42, isStale: false } });
    earningsCacheStatusMock.mockResolvedValue({ lastSuccessfulRefreshAt: new Date("2026-09-07T00:00:00Z"), entryCount: 42, isStale: false });
    let response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-scanner-reference-secret" }));
    let body = await response.json();
    expect(body.earnings).toMatchObject({ status: "ALREADY_FRESH", alphaVantageCallUsed: false, fresh: true, entryCount: 42 });

    refreshEarningsMock.mockResolvedValue({ status: "NO_API_KEY" });
    earningsCacheStatusMock.mockResolvedValue({ lastSuccessfulRefreshAt: null, entryCount: 0, isStale: true });
    response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-scanner-reference-secret" }));
    body = await response.json();
    expect(body.earnings).toMatchObject({ status: "NO_API_KEY", alphaVantageCallUsed: false, fresh: false });
  });

  it("reports an Alpha Vantage call as used on both a successful refresh and a failed fetch (the reservation was still consumed)", async () => {
    refreshOccMock.mockResolvedValue({ status: "EMPTY", message: "unused in this test" });

    refreshEarningsMock.mockResolvedValue({ status: "SUCCESS", entryCount: 1400, prunedCount: 2, usage: {} });
    earningsCacheStatusMock.mockResolvedValue({ lastSuccessfulRefreshAt: new Date(), entryCount: 1400, isStale: false });
    let response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-scanner-reference-secret" }));
    let body = await response.json();
    expect(body.earnings).toMatchObject({ status: "SUCCESS", alphaVantageCallUsed: true, fresh: true });

    refreshEarningsMock.mockResolvedValue({ status: "FETCH_FAILED", outcome: "HTTP_ERROR" });
    earningsCacheStatusMock.mockResolvedValue({ lastSuccessfulRefreshAt: null, entryCount: 0, isStale: true });
    response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-scanner-reference-secret" }));
    body = await response.json();
    expect(body.earnings).toMatchObject({ status: "FETCH_FAILED", alphaVantageCallUsed: true, fresh: false });
  });

  it("never exposes the configured secret anywhere in the response", async () => {
    refreshOccMock.mockResolvedValue({ status: "EMPTY", message: "unused" });
    refreshEarningsMock.mockResolvedValue({ status: "NO_API_KEY" });
    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-scanner-reference-secret" }));
    const text = await response.text();
    expect(text).not.toContain("sentinel-scanner-reference-secret");
  });

  it("sanitizes an unexpected OCC refresh failure rather than leaking the raw error, and still runs the earnings refresh independently", async () => {
    refreshOccMock.mockRejectedValue(new Error("real internal stack trace or fetch detail should never surface"));
    occCacheStatusMock.mockResolvedValue(emptyOccCacheStatus());
    refreshEarningsMock.mockResolvedValue({ status: "ALREADY_FRESH", cache: { lastSuccessfulRefreshAt: new Date(), entryCount: 10, isStale: false } });

    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-scanner-reference-secret" }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.occ).toMatchObject({ status: "ERROR" });
    expect(JSON.stringify(body)).not.toContain("stack trace");
    expect(body.earnings.status).toBe("ALREADY_FRESH"); // earnings refresh still ran despite OCC's failure
  });
});
