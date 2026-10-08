import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runHeartbeatMock = vi.fn();
vi.mock("@/lib/scheduled-capture", () => ({
  runScheduledCaptureHeartbeat: (...args: unknown[]) => runHeartbeatMock(...args),
}));

import { POST } from "./route";

function requestWithHeaders(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/internal/scheduled-capture", { method: "POST", headers });
}

describe("POST /api/internal/scheduled-capture", () => {
  const ORIGINAL_SECRET = process.env.OSO_SCHEDULED_CAPTURE_SECRET;
  const ORIGINAL_CRON_SECRET = process.env.OSO_CRON_SECRET;

  beforeEach(() => {
    runHeartbeatMock.mockReset();
    runHeartbeatMock.mockResolvedValue({ status: "ok", due: 0, processed: 0, deferred: 0, skipped: 0, failed: 0 });
    process.env.OSO_SCHEDULED_CAPTURE_SECRET = "sentinel-scheduled-capture-secret";
    // Codex blocker repair (B6) - the OLD shared secret is deliberately left configured too, so
    // the "no fallback" tests below prove it is REJECTED by this endpoint, not merely untested.
    process.env.OSO_CRON_SECRET = "sentinel-shared-cron-secret";
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) {
      delete process.env.OSO_SCHEDULED_CAPTURE_SECRET;
    } else {
      process.env.OSO_SCHEDULED_CAPTURE_SECRET = ORIGINAL_SECRET;
    }
    if (ORIGINAL_CRON_SECRET === undefined) {
      delete process.env.OSO_CRON_SECRET;
    } else {
      process.env.OSO_CRON_SECRET = ORIGINAL_CRON_SECRET;
    }
  });

  it("returns 401 and runs zero capture work when the secret header is missing", async () => {
    const response = await POST(requestWithHeaders({}));
    expect(response.status).toBe(401);
    expect(runHeartbeatMock).not.toHaveBeenCalled();
  });

  it("returns 401 and runs zero capture work when the secret is wrong", async () => {
    const response = await POST(requestWithHeaders({ authorization: "Bearer wrong-secret" }));
    expect(response.status).toBe(401);
    expect(runHeartbeatMock).not.toHaveBeenCalled();
  });

  it("returns 401 when OSO_SCHEDULED_CAPTURE_SECRET is not configured on the server at all", async () => {
    delete process.env.OSO_SCHEDULED_CAPTURE_SECRET;
    const response = await POST(requestWithHeaders({ authorization: "Bearer anything" }));
    expect(response.status).toBe(401);
    expect(runHeartbeatMock).not.toHaveBeenCalled();
  });

  it("Codex blocker repair (B6) - rejects the OLD shared OSO_CRON_SECRET - there is no fallback", async () => {
    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-shared-cron-secret" }));
    expect(response.status).toBe(401);
    expect(runHeartbeatMock).not.toHaveBeenCalled();
  });

  it("also accepts the secret via the X-OSO-Scheduled-Capture-Secret header", async () => {
    const response = await POST(requestWithHeaders({ "x-oso-scheduled-capture-secret": "sentinel-scheduled-capture-secret" }));
    expect(response.status).toBe(200);
    expect(runHeartbeatMock).toHaveBeenCalledTimes(1);
  });

  it("rejects the correct secret sent via the OLD X-OSO-Cron-Secret header name", async () => {
    const response = await POST(requestWithHeaders({ "x-oso-cron-secret": "sentinel-scheduled-capture-secret" }));
    expect(response.status).toBe(401);
    expect(runHeartbeatMock).not.toHaveBeenCalled();
  });

  it("calls the heartbeat with no arguments - it can never be told which user/account to target", async () => {
    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-scheduled-capture-secret" }));
    expect(response.status).toBe(200);
    expect(runHeartbeatMock).toHaveBeenCalledWith();
  });

  it("passes through a 'nothing due' result as a clean 200 with zero counts", async () => {
    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-scheduled-capture-secret" }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok", due: 0, processed: 0, deferred: 0, skipped: 0, failed: 0 });
  });

  it("passes through a real processed result's aggregate counts - never brokerage/account/symbol data", async () => {
    runHeartbeatMock.mockResolvedValue({ status: "ok", due: 2, processed: 1, deferred: 1, skipped: 0, failed: 0 });
    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-scheduled-capture-secret" }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok", due: 2, processed: 1, deferred: 1, skipped: 0, failed: 0 });
  });

  it("never exposes the configured secret anywhere in the response", async () => {
    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-scheduled-capture-secret" }));
    const text = await response.text();
    expect(text).not.toContain("sentinel-scheduled-capture-secret");
  });

  it("sanitizes an unexpected heartbeat failure rather than leaking the raw error", async () => {
    runHeartbeatMock.mockRejectedValue(new Error("real internal stack trace or provider detail should never surface"));
    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-scheduled-capture-secret" }));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("stack trace");
  });
});
