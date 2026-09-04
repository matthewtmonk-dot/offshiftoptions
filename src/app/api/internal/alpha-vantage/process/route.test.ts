import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const processQueuesMock = vi.fn();

vi.mock("@/lib/alpha-vantage-fundamentals", () => ({
  processAlphaVantageQueues: (...args: unknown[]) => processQueuesMock(...args),
}));

function requestWithHeaders(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/internal/alpha-vantage/process", { method: "POST", headers });
}

type FakeOutcome = { ticker: string; endpoint: "OVERVIEW" | "BALANCE_SHEET"; outcome: string; message?: string };

type FakeSummary = {
  outcomes: FakeOutcome[];
  callsConsumed: number;
  stoppedReason: "COMPLETE" | "BUDGET_EXHAUSTED" | "RATE_LIMITED" | "LOCK_UNAVAILABLE" | "NO_API_KEY";
  usage: { dateKey: string; autoCount: number; manualCount: number; totalCount: number; autoRemaining: number; totalRemaining: number };
};

function fakeSummary(overrides: Partial<FakeSummary> = {}): FakeSummary {
  return {
    outcomes: [],
    callsConsumed: 0,
    stoppedReason: "COMPLETE",
    usage: { dateKey: "2026-01-01", autoCount: 0, manualCount: 0, totalCount: 0, autoRemaining: 22, totalRemaining: 25 },
    ...overrides,
  };
}

describe("POST /api/internal/alpha-vantage/process", () => {
  const ORIGINAL_SECRET = process.env.OSO_CRON_SECRET;

  beforeEach(() => {
    processQueuesMock.mockReset();
    processQueuesMock.mockResolvedValue(fakeSummary());
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
    expect(processQueuesMock).not.toHaveBeenCalled();
  });

  it("returns 401 and makes zero provider calls when the secret is wrong", async () => {
    const response = await POST(requestWithHeaders({ authorization: "Bearer wrong-secret" }));
    expect(response.status).toBe(401);
    expect(processQueuesMock).not.toHaveBeenCalled();
  });

  it("returns 401 when OSO_CRON_SECRET is not configured on the server at all", async () => {
    delete process.env.OSO_CRON_SECRET;
    const response = await POST(requestWithHeaders({ authorization: "Bearer anything" }));
    expect(response.status).toBe(401);
    expect(processQueuesMock).not.toHaveBeenCalled();
  });

  it("calls the unified queue processor exactly once, with no arguments, when the secret is correct", async () => {
    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-route-cron-secret" }));
    expect(response.status).toBe(200);
    expect(processQueuesMock).toHaveBeenCalledTimes(1);
    expect(processQueuesMock).toHaveBeenCalledWith();
  });

  it("also accepts the secret via the X-OSO-Cron-Secret header", async () => {
    const response = await POST(requestWithHeaders({ "x-oso-cron-secret": "sentinel-route-cron-secret" }));
    expect(response.status).toBe(200);
    expect(processQueuesMock).toHaveBeenCalledTimes(1);
  });

  it("reports an empty/complete queue as a compact success, never as an error", async () => {
    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-route-cron-secret" }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ processed: 0, callsUsed: 0, reason: "queue_empty" });
    expect(body.overview).toMatchObject({ processed: 0 });
    expect(body.balanceSheet).toMatchObject({ processed: 0 });
  });

  it("reports a budget-exhausted stop reason without treating it as an error", async () => {
    processQueuesMock.mockResolvedValue(
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

  it("splits the combined outcome list into per-endpoint processed counts", async () => {
    processQueuesMock.mockResolvedValue(
      fakeSummary({
        callsConsumed: 5,
        outcomes: [
          { ticker: "APLD", endpoint: "OVERVIEW", outcome: "SUCCESS" },
          { ticker: "APLD", endpoint: "BALANCE_SHEET", outcome: "SUCCESS" },
          { ticker: "RIOT", endpoint: "BALANCE_SHEET", outcome: "SUCCESS" },
          { ticker: "CORZ", endpoint: "BALANCE_SHEET", outcome: "SUCCESS" },
          { ticker: "IONQ", endpoint: "OVERVIEW", outcome: "SUCCESS" },
        ],
      }),
    );
    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-route-cron-secret" }));
    const body = await response.json();
    expect(body).toMatchObject({ processed: 5, callsUsed: 5 });
    expect(body.overview).toMatchObject({ processed: 2 });
    expect(body.balanceSheet).toMatchObject({ processed: 3 });
  });

  it("never exposes the configured secret anywhere in the response, even on success", async () => {
    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-route-cron-secret" }));
    const text = await response.text();
    expect(text).not.toContain("sentinel-route-cron-secret");
  });

  it("never returns raw ticker/outcome detail from the queue - only aggregate counts", async () => {
    processQueuesMock.mockResolvedValue(
      fakeSummary({
        outcomes: [
          { ticker: "AAPL", endpoint: "OVERVIEW", outcome: "SUCCESS" },
          { ticker: "MSFT", endpoint: "BALANCE_SHEET", outcome: "RATE_LIMITED", message: "Please spread out requests" },
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
    processQueuesMock.mockRejectedValue(new Error("real internal stack trace or provider detail should never surface"));
    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-route-cron-secret" }));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("stack trace");
    expect(JSON.stringify(body)).not.toContain("provider detail");
  });
});
