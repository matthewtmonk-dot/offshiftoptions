import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const processQueueMock = vi.fn();

vi.mock("@/lib/alpha-vantage-fundamentals", () => ({
  processAlphaVantageFundamentalsQueue: (...args: unknown[]) => processQueueMock(...args),
}));

function requestWithHeaders(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/internal/alpha-vantage/process", { method: "POST", headers });
}

function fakeSummary(overrides: Partial<Parameters<typeof processQueueMock>[0]> = {}) {
  return {
    outcomes: [],
    callsConsumed: 0,
    stoppedReason: "COMPLETE" as const,
    usage: { dateKey: "2026-01-01", autoCount: 0, manualCount: 0, totalCount: 0, autoRemaining: 22, totalRemaining: 25 },
    ...overrides,
  };
}

describe("POST /api/internal/alpha-vantage/process", () => {
  const ORIGINAL_SECRET = process.env.OSO_CRON_SECRET;

  beforeEach(() => {
    processQueueMock.mockReset();
    process.env.OSO_CRON_SECRET = "sentinel-route-cron-secret";
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) {
      delete process.env.OSO_CRON_SECRET;
    } else {
      process.env.OSO_CRON_SECRET = ORIGINAL_SECRET;
    }
  });

  it("returns 401 and makes zero provider calls when the secret header is missing", async () => {
    const response = await POST(requestWithHeaders({}));
    expect(response.status).toBe(401);
    expect(processQueueMock).not.toHaveBeenCalled();
  });

  it("returns 401 and makes zero provider calls when the secret is wrong", async () => {
    const response = await POST(requestWithHeaders({ authorization: "Bearer wrong-secret" }));
    expect(response.status).toBe(401);
    expect(processQueueMock).not.toHaveBeenCalled();
  });

  it("returns 401 when OSO_CRON_SECRET is not configured on the server at all", async () => {
    delete process.env.OSO_CRON_SECRET;
    const response = await POST(requestWithHeaders({ authorization: "Bearer anything" }));
    expect(response.status).toBe(401);
    expect(processQueueMock).not.toHaveBeenCalled();
  });

  it("calls the existing queue processor exactly once, with no arguments, when the secret is correct", async () => {
    processQueueMock.mockResolvedValue(fakeSummary());
    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-route-cron-secret" }));
    expect(response.status).toBe(200);
    expect(processQueueMock).toHaveBeenCalledTimes(1);
    expect(processQueueMock).toHaveBeenCalledWith();
  });

  it("also accepts the secret via the X-OSO-Cron-Secret header", async () => {
    processQueueMock.mockResolvedValue(fakeSummary());
    const response = await POST(requestWithHeaders({ "x-oso-cron-secret": "sentinel-route-cron-secret" }));
    expect(response.status).toBe(200);
    expect(processQueueMock).toHaveBeenCalledTimes(1);
  });

  it("reports an empty/complete queue as a compact success, never as an error", async () => {
    processQueueMock.mockResolvedValue(fakeSummary());
    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-route-cron-secret" }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ processed: 0, callsUsed: 0, reason: "queue_empty" });
  });

  it("reports a budget-exhausted stop reason without treating it as an error", async () => {
    processQueueMock.mockResolvedValue(
      fakeSummary({
        callsConsumed: 22,
        stoppedReason: "BUDGET_EXHAUSTED",
        usage: { dateKey: "2026-01-01", autoCount: 22, manualCount: 0, totalCount: 22, autoRemaining: 0, totalRemaining: 3 },
      }),
    );
    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-route-cron-secret" }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ processed: 22, callsUsed: 22, reason: "budget_exhausted" });
  });

  it("never exposes the configured secret anywhere in the response, even on success", async () => {
    processQueueMock.mockResolvedValue(fakeSummary());
    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-route-cron-secret" }));
    const text = await response.text();
    expect(text).not.toContain("sentinel-route-cron-secret");
  });

  it("never returns raw ticker/outcome detail from the queue - only aggregate counts", async () => {
    processQueueMock.mockResolvedValue(
      fakeSummary({
        outcomes: [
          { ticker: "AAPL", outcome: "SUCCESS" },
          { ticker: "MSFT", outcome: "RATE_LIMITED", message: "Please spread out requests" },
        ],
        callsConsumed: 2,
        stoppedReason: "RATE_LIMITED",
        usage: { dateKey: "2026-01-01", autoCount: 2, manualCount: 0, totalCount: 2, autoRemaining: 20, totalRemaining: 23 },
      }),
    );
    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-route-cron-secret" }));
    const body = await response.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("AAPL");
    expect(serialized).not.toContain("MSFT");
    expect(serialized).not.toContain("Please spread out requests");
    expect(body).toMatchObject({ processed: 2, callsUsed: 2, reason: "provider_throttled" });
  });

  it("sanitizes an unexpected queue-processor failure rather than leaking the raw error", async () => {
    processQueueMock.mockRejectedValue(new Error("real internal stack trace or provider detail should never surface"));
    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-route-cron-secret" }));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("stack trace");
    expect(JSON.stringify(body)).not.toContain("provider detail");
  });
});
