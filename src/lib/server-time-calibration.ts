/**
 * Dashboard V2 Phase 2 - Codex P2 (A, round 3). Pure, framework-free building blocks for the
 * client-side active-guidance expiry calculation. Extracted from the React hook (see
 * src/components/use-active-guidance-expired.ts) so the actual trust-sensitive math is directly
 * unit-testable in this repo's node-environment test runner (no React/DOM harness exists here -
 * see PROJECT_HANDOFF.md).
 *
 * The entire point of this module: a client's own `Date.now()` is NEVER trusted to establish how
 * much of a server-authorized active-guidance budget remains. A round-2 attempt
 * (`Math.max(evaluatedAtMs, Date.now())`) was found unsafe - it can still grant MORE remaining
 * validity than the server actually authorized whenever the client's wall clock reads earlier than
 * the true delivery delay (see computeRemainingMsFromCalibration's own doc comment for the exact
 * worked example). The fix replaces `Date.now()` as an authority entirely with a same-origin,
 * read-only server-time calibration (see src/app/api/time/route.ts) plus `performance.now()`
 * monotonic elapsed-time tracking after that calibration succeeds.
 */

export type ServerTimeCalibration = {
  /** The server's own reported clock reading, as epoch milliseconds. */
  serverNowMs: number;
  /** Wall-clock round-trip time for the calibration request itself, measured with
   * `performance.now()` (monotonic, immune to a wall-clock adjustment mid-request). */
  roundTripMs: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Performs exactly the calibration protocol the ticket specifies: `t0` before the request, fetch
 * the same-origin read-only time endpoint, `t1` after it resolves, `roundTripMs = t1 - t0`. Returns
 * `null` (never a guessed/partial value) for ANY failure: a rejected fetch, a non-OK response,
 * unparseable JSON, a missing/non-string `serverNow`, or a `serverNow` that doesn't parse to a
 * finite instant. The caller must treat `null` exactly like "cannot establish trusted server time
 * right now" - remain neutral, never fall back to the client's own `Date.now()`.
 */
export async function calibrateServerTime(fetchImpl: typeof fetch = fetch, endpoint = "/api/time"): Promise<ServerTimeCalibration | null> {
  const t0 = performance.now();
  let response: Response;
  try {
    response = await fetchImpl(endpoint, { cache: "no-store" });
  } catch {
    return null;
  }
  const t1 = performance.now();

  if (!response.ok) {
    return null;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }

  const serverNowRaw = isRecord(body) && typeof body.serverNow === "string" ? body.serverNow : null;
  if (serverNowRaw === null) {
    return null;
  }
  const serverNowMs = Date.parse(serverNowRaw);
  if (!Number.isFinite(serverNowMs)) {
    return null;
  }

  const roundTripMs = t1 - t0;
  if (!Number.isFinite(roundTripMs) || roundTripMs < 0) {
    return null;
  }

  return { serverNowMs, roundTripMs };
}

/**
 * The trust-sensitive budget calculation itself, exactly per the ticket's own protocol:
 *
 *   serverUpperBoundNow = serverNow + roundTripMs   (a conservative OVERESTIMATE of "now" - the
 *                                                     round trip can only make this later than the
 *                                                     server's real clock, never earlier; it is
 *                                                     acceptable for this to expire guidance a
 *                                                     little early, never acceptable to extend it)
 *   remainingMs = activeGuidanceDeadline - max(evaluatedAt, serverUpperBoundNow)
 *
 * Worked example from the ticket: evaluatedAt 12:00:00, deadline 12:02:00 (a 120s budget), but
 * actual hydration/calibration doesn't complete until ~12:00:30 (30s of real delivery delay) - the
 * TRUE remaining validity is 90s. A stray browser clock reading 12:00:10 must never grant 110s
 * remaining (round 2's exact defect) - this function never reads or accepts a browser wall-clock
 * value at all, so that failure mode cannot recur: `serverUpperBoundNow` here comes only from the
 * server's own reported time plus the measured (monotonic) round trip, capping remainingMs at (or
 * slightly below, from RTT overhead) the true ~90s figure.
 *
 * Returns `null` - never a guessed number - for a null calibration (failed/malformed upstream), a
 * non-finite deadline/evaluatedAt/serverNow/roundTrip, or a contradictory deadline that is not
 * strictly after its own evaluatedAt origin (a deadline can never legitimately precede or equal the
 * instant it was computed from). The caller must treat `null` as "stay neutral."
 */
export function computeRemainingMsFromCalibration(
  deadlineMs: number,
  evaluatedAtMs: number,
  calibration: ServerTimeCalibration | null,
): number | null {
  if (calibration === null) {
    return null;
  }
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(evaluatedAtMs) || deadlineMs <= evaluatedAtMs) {
    return null;
  }
  const { serverNowMs, roundTripMs } = calibration;
  if (!Number.isFinite(serverNowMs) || !Number.isFinite(roundTripMs)) {
    return null;
  }

  const serverUpperBoundNow = serverNowMs + roundTripMs;
  const remainingMs = deadlineMs - Math.max(evaluatedAtMs, serverUpperBoundNow);
  return Number.isFinite(remainingMs) ? remainingMs : null;
}

/**
 * Given an already-computed `remainingMs` budget (from `computeRemainingMsFromCalibration`, taken
 * at the moment calibration succeeded) and a `performance.now()`-based monotonic elapsed duration
 * since that moment, decides whether the advisory is expired. `null` (failed/invalid calibration)
 * always fails closed to expired - never guessed as "still active." No grace period: elapsed
 * exactly equal to the budget is already expired.
 */
export function isExpiredGivenRemainingMs(remainingMs: number | null, monotonicElapsedMs: number): boolean {
  if (remainingMs === null || !Number.isFinite(remainingMs)) {
    return true;
  }
  return monotonicElapsedMs >= remainingMs;
}
