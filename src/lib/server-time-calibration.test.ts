import { afterEach, describe, expect, it, vi } from "vitest";
import { calibrateServerTime, computeRemainingMsFromCalibration, isExpiredGivenRemainingMs, type ServerTimeCalibration } from "./server-time-calibration";

/**
 * Codex P2 (A, round 3) - direct unit tests for the pure, trust-sensitive server-time-calibration
 * math the React hook (src/components/use-active-guidance-expired.ts) wraps. This repo has no
 * React/DOM component-test harness (see PROJECT_HANDOFF.md), so the hook's own scheduling/
 * visibility-resume/re-render wiring is not exercised here; every actual trust decision it makes is
 * covered below.
 *
 * Per the ticket's own explicit constraint: none of these tests assume browser wall time
 * (`Date.now()`) can establish trusted server time - `computeRemainingMsFromCalibration` never
 * accepts a client-clock reading as a parameter at all, only a server-reported instant plus a
 * measured (monotonic) round-trip time.
 */
describe("computeRemainingMsFromCalibration", () => {
  const EVALUATED_AT = new Date("2026-06-15T16:00:00.000Z").getTime(); // 12:00:00 ET-equivalent instant
  const DEADLINE = EVALUATED_AT + 120_000; // 12:02:00 - a 120-second budget

  it("the ticket's own worked example: ~30s of real delivery delay before calibration completes caps remaining validity at ~90s, never the full 120s", () => {
    // Calibration completes when the TRUE wall-clock instant is 12:00:30 (30s after evaluatedAt).
    // The server's own clock reports this accurately; round trip measured at 500ms.
    const calibration: ServerTimeCalibration = { serverNowMs: EVALUATED_AT + 30_000, roundTripMs: 500 };
    const remainingMs = computeRemainingMsFromCalibration(DEADLINE, EVALUATED_AT, calibration);
    // True remaining validity is exactly 90_000ms (120s budget - 30s elapsed). The RTT overestimate
    // may shave this down further but must NEVER exceed it.
    expect(remainingMs).not.toBeNull();
    expect(remainingMs!).toBeLessThanOrEqual(90_000);
    expect(remainingMs!).toBeGreaterThan(89_000); // the 500ms RTT is the only thing shaving it down
  });

  it("a stray browser clock reading 10s after evaluatedAt (round 2's exact false-positive input) is irrelevant - only the server-reported instant and measured RTT matter", () => {
    // This function's signature has no parameter for a client-clock reading at all - there is
    // nothing here for a "slow" or "fast" Date.now() to influence. Demonstrated by holding the
    // calibration fixed and confirming the result depends only on it, never on any wall-clock value.
    const calibration: ServerTimeCalibration = { serverNowMs: EVALUATED_AT + 30_000, roundTripMs: 500 };
    const remaining1 = computeRemainingMsFromCalibration(DEADLINE, EVALUATED_AT, calibration);
    const remaining2 = computeRemainingMsFromCalibration(DEADLINE, EVALUATED_AT, calibration);
    expect(remaining1).toBe(remaining2);
    expect(remaining1!).toBeLessThanOrEqual(90_000); // never the 110s a slow-clock-trusting formula would grant
  });

  it("a large round-trip time further shortens (never lengthens) the remaining validity", () => {
    const smallRtt = computeRemainingMsFromCalibration(DEADLINE, EVALUATED_AT, { serverNowMs: EVALUATED_AT + 30_000, roundTripMs: 100 });
    const largeRtt = computeRemainingMsFromCalibration(DEADLINE, EVALUATED_AT, { serverNowMs: EVALUATED_AT + 30_000, roundTripMs: 5_000 });
    expect(largeRtt!).toBeLessThan(smallRtt!);
    expect(largeRtt!).toBe(90_000 - 5_000);
  });

  it("is null (never a guessed number) for a null calibration", () => {
    expect(computeRemainingMsFromCalibration(DEADLINE, EVALUATED_AT, null)).toBeNull();
  });

  it("is null for a non-finite deadline, evaluatedAt, serverNowMs, or roundTripMs", () => {
    const calibration: ServerTimeCalibration = { serverNowMs: EVALUATED_AT, roundTripMs: 100 };
    expect(computeRemainingMsFromCalibration(Number.NaN, EVALUATED_AT, calibration)).toBeNull();
    expect(computeRemainingMsFromCalibration(DEADLINE, Number.NaN, calibration)).toBeNull();
    expect(computeRemainingMsFromCalibration(DEADLINE, EVALUATED_AT, { serverNowMs: Number.NaN, roundTripMs: 100 })).toBeNull();
    expect(computeRemainingMsFromCalibration(DEADLINE, EVALUATED_AT, { serverNowMs: EVALUATED_AT, roundTripMs: Number.NaN })).toBeNull();
  });

  it("is null for a contradictory deadline that does not strictly follow its own evaluatedAt origin", () => {
    const calibration: ServerTimeCalibration = { serverNowMs: EVALUATED_AT, roundTripMs: 0 };
    expect(computeRemainingMsFromCalibration(EVALUATED_AT, EVALUATED_AT, calibration)).toBeNull(); // deadline === evaluatedAt
    expect(computeRemainingMsFromCalibration(EVALUATED_AT - 1, EVALUATED_AT, calibration)).toBeNull(); // deadline before evaluatedAt
  });

  it("resolves to a non-positive number (never null) once the true deadline has already passed - the caller's own isExpiredGivenRemainingMs handles this as expired, not as a failed calibration", () => {
    const calibration: ServerTimeCalibration = { serverNowMs: DEADLINE + 5_000, roundTripMs: 0 };
    const remainingMs = computeRemainingMsFromCalibration(DEADLINE, EVALUATED_AT, calibration);
    expect(remainingMs).not.toBeNull();
    expect(remainingMs!).toBeLessThan(0);
  });
});

describe("isExpiredGivenRemainingMs", () => {
  it("fails closed to expired for a null (failed/invalid calibration) remaining budget", () => {
    expect(isExpiredGivenRemainingMs(null, 0)).toBe(true);
  });

  it("fails closed to expired for a non-finite remaining budget", () => {
    expect(isExpiredGivenRemainingMs(Number.NaN, 0)).toBe(true);
  });

  it("is exactly expired the instant monotonic elapsed time reaches the budget - no 250ms grace period", () => {
    expect(isExpiredGivenRemainingMs(90_000, 89_999)).toBe(false);
    expect(isExpiredGivenRemainingMs(90_000, 90_000)).toBe(true);
    expect(isExpiredGivenRemainingMs(90_000, 90_001)).toBe(true);
  });

  it("a zero or negative remaining budget (deadline already passed at calibration time) is immediately expired", () => {
    expect(isExpiredGivenRemainingMs(0, 0)).toBe(true);
    expect(isExpiredGivenRemainingMs(-5_000, 0)).toBe(true);
  });
});

describe("calibrateServerTime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockMonotonicClock(...values: number[]) {
    const spy = vi.spyOn(performance, "now");
    for (const value of values) spy.mockReturnValueOnce(value);
    return spy;
  }

  it("returns a calibration with the server's reported time and the measured round-trip time", async () => {
    mockMonotonicClock(1_000, 1_300); // 300ms round trip
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ serverNow: "2026-06-15T16:00:00.000Z" }), { status: 200 }));

    const calibration = await calibrateServerTime(fetchImpl as unknown as typeof fetch, "/api/time");

    expect(calibration).toEqual({ serverNowMs: new Date("2026-06-15T16:00:00.000Z").getTime(), roundTripMs: 300 });
    expect(fetchImpl).toHaveBeenCalledWith("/api/time", { cache: "no-store" });
  });

  it("is null (never guessed) when the request itself fails/rejects", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network error"));
    const calibration = await calibrateServerTime(fetchImpl as unknown as typeof fetch);
    expect(calibration).toBeNull();
  });

  it("is null when the response is a non-OK status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    const calibration = await calibrateServerTime(fetchImpl as unknown as typeof fetch);
    expect(calibration).toBeNull();
  });

  it("is null when the response body is not valid JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("not json", { status: 200 }));
    const calibration = await calibrateServerTime(fetchImpl as unknown as typeof fetch);
    expect(calibration).toBeNull();
  });

  it("is null when serverNow is missing entirely", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const calibration = await calibrateServerTime(fetchImpl as unknown as typeof fetch);
    expect(calibration).toBeNull();
  });

  it("is null when serverNow is not a string", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ serverNow: 12345 }), { status: 200 }));
    const calibration = await calibrateServerTime(fetchImpl as unknown as typeof fetch);
    expect(calibration).toBeNull();
  });

  it("is null when serverNow does not parse to a valid instant", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ serverNow: "not-a-date" }), { status: 200 }));
    const calibration = await calibrateServerTime(fetchImpl as unknown as typeof fetch);
    expect(calibration).toBeNull();
  });
});

describe("Codex P2 (A, round 3) - end-to-end budget math using a realistic calibrateServerTime result", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a malformed server response flows through as neutral (null remaining), never a guessed budget", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ serverNow: null }), { status: 200 }));
    const calibration = await calibrateServerTime(fetchImpl as unknown as typeof fetch);
    const remainingMs = computeRemainingMsFromCalibration(1_000, 0, calibration);
    expect(remainingMs).toBeNull();
    expect(isExpiredGivenRemainingMs(remainingMs, 0)).toBe(true);
  });

  it("a failed request flows through as neutral (null remaining), never a guessed budget", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
    const calibration = await calibrateServerTime(fetchImpl as unknown as typeof fetch);
    const remainingMs = computeRemainingMsFromCalibration(1_000, 0, calibration);
    expect(remainingMs).toBeNull();
    expect(isExpiredGivenRemainingMs(remainingMs, 0)).toBe(true);
  });
});
