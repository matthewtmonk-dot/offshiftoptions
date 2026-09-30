import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bumpGeneration,
  calibrateServerTime,
  computeExpiresAtMonotonic,
  computeRemainingMsFromCalibration,
  createGeneration,
  isCurrentGeneration,
  isExpiredAtMonotonic,
  type ServerTimeCalibration,
} from "./server-time-calibration";

/**
 * Codex P2 (A, rounds 3-4) - direct unit tests for the pure, trust-sensitive server-time-calibration
 * math the React hook (src/components/use-active-guidance-expired.ts) wraps. This repo has no
 * React/DOM component-test harness (see PROJECT_HANDOFF.md), so the hook's own scheduling/
 * generation/visibility-resume wiring is not exercised here; every actual trust decision it makes is
 * covered below.
 *
 * Per the ticket's own explicit constraint: none of these tests assume browser wall time
 * (`Date.now()`) can establish trusted server time - none of these functions accept a client-clock
 * reading as a parameter at all, only a server-reported instant plus measured monotonic timing.
 */
describe("computeRemainingMsFromCalibration", () => {
  const EVALUATED_AT = new Date("2026-06-15T16:00:00.000Z").getTime(); // 12:00:00 ET-equivalent instant
  const DEADLINE = EVALUATED_AT + 120_000; // 12:02:00 - a 120-second budget

  function calibration(overrides: Partial<ServerTimeCalibration> = {}): ServerTimeCalibration {
    return { serverNowMs: EVALUATED_AT + 30_000, roundTripMs: 500, measurementCompletedAtMonotonic: 1_000, ...overrides };
  }

  it("the ticket's own worked example: ~30s of real delivery delay before calibration completes caps remaining validity at ~90s, never the full 120s", () => {
    const remainingMs = computeRemainingMsFromCalibration(DEADLINE, EVALUATED_AT, calibration());
    expect(remainingMs).not.toBeNull();
    expect(remainingMs!).toBeLessThanOrEqual(90_000);
    expect(remainingMs!).toBeGreaterThan(89_000);
  });

  it("a large round-trip time further shortens (never lengthens) the remaining validity", () => {
    const smallRtt = computeRemainingMsFromCalibration(DEADLINE, EVALUATED_AT, calibration({ roundTripMs: 100 }));
    const largeRtt = computeRemainingMsFromCalibration(DEADLINE, EVALUATED_AT, calibration({ roundTripMs: 5_000 }));
    expect(largeRtt!).toBeLessThan(smallRtt!);
    expect(largeRtt!).toBe(90_000 - 5_000);
  });

  it("is null (never a guessed number) for a null calibration", () => {
    expect(computeRemainingMsFromCalibration(DEADLINE, EVALUATED_AT, null)).toBeNull();
  });

  it("is null for a non-finite deadline, evaluatedAt, serverNowMs, or roundTripMs", () => {
    expect(computeRemainingMsFromCalibration(Number.NaN, EVALUATED_AT, calibration())).toBeNull();
    expect(computeRemainingMsFromCalibration(DEADLINE, Number.NaN, calibration())).toBeNull();
    expect(computeRemainingMsFromCalibration(DEADLINE, EVALUATED_AT, calibration({ serverNowMs: Number.NaN }))).toBeNull();
    expect(computeRemainingMsFromCalibration(DEADLINE, EVALUATED_AT, calibration({ roundTripMs: Number.NaN }))).toBeNull();
  });

  it("is null for a contradictory deadline that does not strictly follow its own evaluatedAt origin", () => {
    expect(computeRemainingMsFromCalibration(EVALUATED_AT, EVALUATED_AT, calibration({ serverNowMs: EVALUATED_AT, roundTripMs: 0 }))).toBeNull();
    expect(computeRemainingMsFromCalibration(EVALUATED_AT - 1, EVALUATED_AT, calibration({ serverNowMs: EVALUATED_AT, roundTripMs: 0 }))).toBeNull();
  });

  it("resolves to a non-positive number (never null) once the true deadline has already passed", () => {
    const remainingMs = computeRemainingMsFromCalibration(DEADLINE, EVALUATED_AT, calibration({ serverNowMs: DEADLINE + 5_000, roundTripMs: 0 }));
    expect(remainingMs).not.toBeNull();
    expect(remainingMs!).toBeLessThan(0);
  });
});

describe("Codex P2 (A, round 4) - calibrateServerTime measures through full response-body parsing/validation, not just headers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockMonotonicClock(...values: number[]) {
    const spy = vi.spyOn(performance, "now");
    for (const value of values) spy.mockReturnValueOnce(value);
    return spy;
  }

  /**
   * Discriminates old (buggy) from new (fixed) `calibrateServerTime` behavior by CONTENT, not call
   * count: `performance.now()` returns 0 while headers are "in flight" and only flips to 30_100
   * once the response BODY has actually been read/parsed - a `t1` read any earlier than that (the
   * exact round-3 defect: measuring right after `fetch()` resolves, before `response.json()`) would
   * observe 0, not 30_100, regardless of how many times the function happens to call it.
   */
  function fetchWithSlowBody(): typeof fetch {
    let bodyDelivered = false;
    vi.spyOn(performance, "now").mockImplementation(() => (bodyDelivered ? 30_100 : 0));
    return vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => {
        bodyDelivered = true; // the response body has now actually arrived and been read
        return { serverNow: "2026-06-15T16:00:00.000Z" };
      },
    })) as unknown as typeof fetch;
  }

  it("TEST 1 - a response whose HEADERS resolve quickly but whose BODY takes far longer measures the FULL elapsed time, never just the header delay", async () => {
    const fetchImpl = fetchWithSlowBody();

    const calibration = await calibrateServerTime(fetchImpl, "/api/time");

    expect(calibration).not.toBeNull();
    // Proves `t1` was read only AFTER the body actually arrived (`performance.now()` had already
    // flipped to 30_100 by then) - a `t1` read right after `fetch()` alone resolves (the old, buggy
    // behavior) would have observed 0 here instead, producing a 0ms round trip.
    expect(calibration!.roundTripMs).toBe(30_100);
    expect(calibration!.measurementCompletedAtMonotonic).toBe(30_100);
  });

  it("the full-response-timing fix applied to the budget: a slow body delivery correctly consumes the true elapsed time from the remaining budget, and it is never regained later", async () => {
    const EVALUATED_AT = new Date("2026-06-15T16:00:00.000Z").getTime(); // 12:00:00
    const DEADLINE = EVALUATED_AT + 120_000; // 12:02:00

    const fetchImpl = fetchWithSlowBody(); // 30.1 real seconds elapsed by the time calibration completes

    const calibration = await calibrateServerTime(fetchImpl);
    const remainingMs = computeRemainingMsFromCalibration(DEADLINE, EVALUATED_AT, calibration);

    // True remaining budget is 120s - 30.1s ~= 89.9s - it must NOT read as ~120s (the old, headers
    // -only measurement's ~0ms round trip), which would wrongly extend guidance by ~30 real seconds.
    expect(remainingMs).not.toBeNull();
    expect(remainingMs!).toBeLessThanOrEqual(90_000);
    expect(remainingMs!).toBeGreaterThan(89_000);
  });

  it("returns a calibration with the server's reported time and the measured (full) round-trip time", async () => {
    mockMonotonicClock(1_000, 1_300);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ serverNow: "2026-06-15T16:00:00.000Z" }), { status: 200 }));

    const calibration = await calibrateServerTime(fetchImpl as unknown as typeof fetch, "/api/time");

    expect(calibration).toEqual({ serverNowMs: new Date("2026-06-15T16:00:00.000Z").getTime(), roundTripMs: 300, measurementCompletedAtMonotonic: 1_300 });
    expect(fetchImpl).toHaveBeenCalledWith("/api/time", { cache: "no-store" });
  });

  it("is null (never guessed) when the request itself fails/rejects", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network error"));
    expect(await calibrateServerTime(fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it("is null when the response is a non-OK status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    expect(await calibrateServerTime(fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it("is null when the response body is not valid JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("not json", { status: 200 }));
    expect(await calibrateServerTime(fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it("is null when serverNow is missing, non-string, or unparseable", async () => {
    expect(await calibrateServerTime(vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch)).toBeNull();
    expect(await calibrateServerTime(vi.fn().mockResolvedValue(new Response(JSON.stringify({ serverNow: 12345 }), { status: 200 })) as unknown as typeof fetch)).toBeNull();
    expect(await calibrateServerTime(vi.fn().mockResolvedValue(new Response(JSON.stringify({ serverNow: "not-a-date" }), { status: 200 })) as unknown as typeof fetch)).toBeNull();
  });
});

describe("computeExpiresAtMonotonic / isExpiredAtMonotonic", () => {
  const EVALUATED_AT = new Date("2026-06-15T16:00:00.000Z").getTime();
  const DEADLINE = EVALUATED_AT + 120_000;

  it("anchors expiry to measurementCompletedAtMonotonic + remainingMs, a single fixed instant", () => {
    const calibration: ServerTimeCalibration = { serverNowMs: EVALUATED_AT + 30_000, roundTripMs: 500, measurementCompletedAtMonotonic: 5_000 };
    const expiresAt = computeExpiresAtMonotonic(DEADLINE, EVALUATED_AT, calibration);
    expect(expiresAt).not.toBeNull();
    // remainingMs ~= 89,500 (120,000 - 30,500); anchored at monotonic 5,000 -> ~94,500.
    expect(expiresAt!).toBeCloseTo(5_000 + 89_500, 0);
  });

  it("is null for a null calibration or any input computeRemainingMsFromCalibration itself rejects", () => {
    expect(computeExpiresAtMonotonic(DEADLINE, EVALUATED_AT, null)).toBeNull();
    expect(computeExpiresAtMonotonic(EVALUATED_AT, EVALUATED_AT, { serverNowMs: EVALUATED_AT, roundTripMs: 0, measurementCompletedAtMonotonic: 0 })).toBeNull();
  });

  it("is null when measurementCompletedAtMonotonic itself is not finite", () => {
    const calibration: ServerTimeCalibration = { serverNowMs: EVALUATED_AT, roundTripMs: 0, measurementCompletedAtMonotonic: Number.NaN };
    expect(computeExpiresAtMonotonic(DEADLINE, EVALUATED_AT, calibration)).toBeNull();
  });

  it("TEST 2 (apply delay) - expiry stays anchored to the fixed instant regardless of how much later it is checked, never restarting the full remaining budget", () => {
    const calibration: ServerTimeCalibration = { serverNowMs: EVALUATED_AT, roundTripMs: 0, measurementCompletedAtMonotonic: 1_000 };
    // remainingMs = 120,000 (deadline - evaluatedAt, since serverUpperBoundNow === evaluatedAt here)
    const expiresAt = computeExpiresAtMonotonic(DEADLINE, EVALUATED_AT, calibration)!;
    expect(expiresAt).toBe(1_000 + 120_000);

    // The hook applies this result much later (e.g. 50,000ms of monotonic time after measurement
    // completed) - the fixed expiry instant must be completely unaffected by that application delay.
    const checkedAtElapsedApplication = isExpiredAtMonotonic(expiresAt, 1_000 + 50_000);
    expect(checkedAtElapsedApplication).toBe(false); // still well before the fixed expiry instant

    // Checking again right at the fixed instant is expired; one ms before is not - no grace period,
    // and no re-derived "50,000ms of remaining budget from here" that a restarted countdown would
    // have wrongly produced.
    expect(isExpiredAtMonotonic(expiresAt, expiresAt - 1)).toBe(false);
    expect(isExpiredAtMonotonic(expiresAt, expiresAt)).toBe(true);
  });

  it("fails closed to expired for a null or non-finite expiry instant", () => {
    expect(isExpiredAtMonotonic(null, 0)).toBe(true);
    expect(isExpiredAtMonotonic(Number.NaN, 0)).toBe(true);
  });

  it("a zero or negative remaining budget at measurement time produces an expiry instant already in the past - immediately expired at any later check", () => {
    const calibration: ServerTimeCalibration = { serverNowMs: DEADLINE + 5_000, roundTripMs: 0, measurementCompletedAtMonotonic: 1_000 };
    const expiresAt = computeExpiresAtMonotonic(DEADLINE, EVALUATED_AT, calibration)!;
    expect(expiresAt).toBeLessThan(1_000);
    expect(isExpiredAtMonotonic(expiresAt, 1_000)).toBe(true);
  });
});

/**
 * Codex P2 (A, round 4) - regression coverage for the second blocker: a calibration request (or the
 * timer it eventually schedules) that is superseded by a NEWER one starting must never apply its
 * result, no matter when it resolves/fires. This is the exact mechanism
 * src/components/use-active-guidance-expired.ts uses (bumpGeneration on every new calibration
 * attempt, on a neutralizing visibility change, and on effect cleanup; isCurrentGeneration guards
 * every place a resolved calibration or a fired timer callback would otherwise mutate state). The
 * hook's own React effect/timer scheduling is not itself exercised here (no React/DOM harness exists
 * in this repo), but the actual invalidation LOGIC it relies on is fully covered below.
 */
describe("Codex P2 (A, round 4) - generation guard: superseded calibrations/timers can never reactivate guidance", () => {
  it("TEST 3 - out-of-order requests: an older generation resolving AFTER a newer one has already failed must still be ignored (state stays neutral)", () => {
    const generation = createGeneration();
    const gen1 = bumpGeneration(generation); // generation 1 starts, calibration request in flight

    // A newer calibration starts before generation 1's request resolves (e.g. a visibility resume).
    const gen2 = bumpGeneration(generation); // generation 2
    expect(isCurrentGeneration(generation, gen2)).toBe(true);

    // Generation 2's calibration fails - this IS the current generation, so its (neutral) result applies.
    expect(isCurrentGeneration(generation, gen2)).toBe(true);

    // Generation 1's request finally resolves (successfully, even) - it must be ignored outright,
    // since it is no longer the current generation.
    expect(isCurrentGeneration(generation, gen1)).toBe(false);
  });

  it("TEST 4 - newer success: generation 2 succeeds, generation 1 resolves afterward - generation 2's state remains authoritative", () => {
    const generation = createGeneration();
    const gen1 = bumpGeneration(generation);
    const gen2 = bumpGeneration(generation); // supersedes gen1 before it resolves

    // Generation 2 succeeds and IS current - its result is applied.
    expect(isCurrentGeneration(generation, gen2)).toBe(true);

    // Generation 1 resolves afterward - still not current, still ignored, regardless of outcome.
    expect(isCurrentGeneration(generation, gen1)).toBe(false);
    // Generation 2 remains the sole authoritative generation.
    expect(isCurrentGeneration(generation, gen2)).toBe(true);
  });

  it("TEST 5 - visibility: hiding invalidates the active generation; becoming visible again starts a strictly newer one that alone may reactivate", () => {
    const generation = createGeneration();
    const activeGen = bumpGeneration(generation); // an active calibration/timer from before the tab was hidden
    expect(isCurrentGeneration(generation, activeGen)).toBe(true);

    // Tab hidden - immediately invalidates whatever generation was active (no calibration/timer from
    // before hiding may mutate state again, even if it was still in flight).
    bumpGeneration(generation);
    expect(isCurrentGeneration(generation, activeGen)).toBe(false);

    // Tab visible again - a brand-new generation starts; only it may ever reactivate guidance.
    const resumedGen = bumpGeneration(generation);
    expect(resumedGen).not.toBe(activeGen);
    expect(isCurrentGeneration(generation, resumedGen)).toBe(true);
    // The pre-hide generation's own (now very stale) request/timer remains permanently superseded.
    expect(isCurrentGeneration(generation, activeGen)).toBe(false);
  });

  it("TEST 6 - timer invalidation: a scheduled expiry callback stamped with an old generation must not mutate state once a newer generation exists", () => {
    const generation = createGeneration();
    const oldGen = bumpGeneration(generation); // a timer scheduled under this generation

    // A newer calibration starts (e.g. a fresh review/deadline, or a visibility resume) before the
    // old timer ever fires.
    bumpGeneration(generation);

    // The old timer's callback would check its own stamped generation before calling setState -
    // exactly like use-active-guidance-expired.ts's own `check()` closure does.
    const oldTimerCallbackShouldApply = isCurrentGeneration(generation, oldGen);
    expect(oldTimerCallbackShouldApply).toBe(false);
  });
});
