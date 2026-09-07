import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runCycleMock = vi.fn();
vi.mock("@/lib/technical-preparation-orchestrator", () => ({
  runTechnicalPreparationOrchestratorCycle: (...args: unknown[]) => runCycleMock(...args),
}));

import { POST } from "./route";

function requestWithHeaders(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/internal/scanner-technical/process", { method: "POST", headers });
}

describe("POST /api/internal/scanner-technical/process", () => {
  const ORIGINAL_SECRET = process.env.OSO_CRON_SECRET;

  beforeEach(() => {
    runCycleMock.mockReset();
    runCycleMock.mockResolvedValue({ status: "NO_ELIGIBLE_USER" });
    process.env.OSO_CRON_SECRET = "sentinel-scanner-technical-secret";
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) {
      delete process.env.OSO_CRON_SECRET;
    } else {
      process.env.OSO_CRON_SECRET = ORIGINAL_SECRET;
    }
  });

  it("returns 401 and runs zero orchestration work when the secret header is missing", async () => {
    const response = await POST(requestWithHeaders({}));
    expect(response.status).toBe(401);
    expect(runCycleMock).not.toHaveBeenCalled();
  });

  it("returns 401 and runs zero orchestration work when the secret is wrong", async () => {
    const response = await POST(requestWithHeaders({ authorization: "Bearer wrong-secret" }));
    expect(response.status).toBe(401);
    expect(runCycleMock).not.toHaveBeenCalled();
  });

  it("returns 401 when OSO_CRON_SECRET is not configured on the server at all", async () => {
    delete process.env.OSO_CRON_SECRET;
    const response = await POST(requestWithHeaders({ authorization: "Bearer anything" }));
    expect(response.status).toBe(401);
    expect(runCycleMock).not.toHaveBeenCalled();
  });

  it("also accepts the secret via the X-OSO-Cron-Secret header", async () => {
    const response = await POST(requestWithHeaders({ "x-oso-cron-secret": "sentinel-scanner-technical-secret" }));
    expect(response.status).toBe(200);
    expect(runCycleMock).toHaveBeenCalledTimes(1);
  });

  it("calls the orchestrator with no arguments - it can never be told which user to target", async () => {
    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-scanner-technical-secret" }));
    expect(response.status).toBe(200);
    expect(runCycleMock).toHaveBeenCalledWith();
  });

  it("passes through an OUTSIDE_WINDOW result as a clean 200, never an error", async () => {
    runCycleMock.mockResolvedValue({ status: "OUTSIDE_WINDOW" });
    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-scanner-technical-secret" }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "OUTSIDE_WINDOW" });
  });

  it("passes through a real OK result's aggregate fields - never a symbol list, account data, or token", async () => {
    runCycleMock.mockResolvedValue({
      status: "OK",
      userProcessed: true,
      generationStatus: "IN_PROGRESS",
      subBatchesProcessed: 5,
      historySymbolsProcessed: 125,
      succeededCount: 125,
      failedCount: 0,
      remainingEligibleCount: 1911,
      elapsedMs: 13000,
    });
    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-scanner-technical-secret" }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "OK", subBatchesProcessed: 5, historySymbolsProcessed: 125, remainingEligibleCount: 1911 });
  });

  it("never exposes the configured secret anywhere in the response", async () => {
    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-scanner-technical-secret" }));
    const text = await response.text();
    expect(text).not.toContain("sentinel-scanner-technical-secret");
  });

  it("sanitizes an unexpected orchestrator failure rather than leaking the raw error", async () => {
    runCycleMock.mockRejectedValue(new Error("real internal stack trace or provider detail should never surface"));
    const response = await POST(requestWithHeaders({ authorization: "Bearer sentinel-scanner-technical-secret" }));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("stack trace");
  });
});
