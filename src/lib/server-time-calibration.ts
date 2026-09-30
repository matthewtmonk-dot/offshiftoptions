/**
 * Dashboard V2 Phase 2 - Codex P2 (A, rounds 3-4). Pure, framework-free building blocks for the
 * client-side active-guidance expiry calculation. Extracted from the React hook (see
 * src/components/use-active-guidance-expired.ts) so the actual trust-sensitive math is directly
 * unit-testable in this repo's node-environment test runner (no React/DOM harness exists here -
 * see PROJECT_HANDOFF.md).
 *
 * The entire point of this module: a client's own `Date.now()` is NEVER trusted to establish how
 * much of a server-authorized active-guidance budget remains. A round-2 attempt
 * (`Math.max(evaluatedAtMs, Date.now())`) was found unsafe - it can still grant MORE remaining
 * validity than the server actually authorized whenever the client's wall clock reads earlier than
 * the true delivery delay. Round 3 replaced `Date.now()` with a same-origin, read-only server-time
 * calibration (see src/app/api/time/route.ts) plus `performance.now()` monotonic tracking - but
 * round 3's OWN measurement window ended right after `fetch()` resolved, BEFORE the response body
 * was actually read/parsed/validated, so a slow/large response body's delivery time was silently
 * excluded from the measured round trip (see calibrateServerTime's own doc comment for the exact
 * reproduction). Round 4 fixes this by measuring only once the ENTIRE calibration - headers, body
 * bytes, JSON parse, and field validation - has actually completed, and by anchoring expiry to a
 * single fixed monotonic instant (`computeExpiresAtMonotonic`) rather than a "remaining ms" value
 * that could otherwise be re-applied against a fresh, later `performance.now()` origin and
 * effectively restart the budget.
 */

export type ServerTimeCalibration = {
  /** The server's own reported clock reading, as epoch milliseconds. */
  serverNowMs: number;
  /** The FULL measured round-trip time for the calibration request - from immediately before the
   * request was issued to immediately after its response body was fully read, parsed, AND
   * validated (never just "the request resolved"). Measured with `performance.now()` (monotonic,
   * immune to a wall-clock adjustment mid-request). */
  roundTripMs: number;
  /** The `performance.now()` monotonic instant at which this calibration's measurement actually
   * completed (the same instant `roundTripMs` is measured up to). Callers anchor expiry to this
   * exact instant plus the computed remaining budget - never to a fresh `performance.now()` read
   * taken later, once the calibration result is merely being applied. */
  measurementCompletedAtMonotonic: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Performs the calibration protocol: `t0` before the request, fetch the same-origin read-only time
 * endpoint, read+parse+validate its JSON body, and ONLY THEN take `t1` - so `roundTripMs = t1 - t0`
 * reflects the full real time this calibration took, including response-body delivery/parsing
 * delay.
 *
 * Codex P2 (A, round 4) - a prior version measured `t1` immediately after `fetch()` resolved (i.e.
 * once response HEADERS arrived), before `await response.json()`. Reproduced exactly: headers
 * arrive after 100ms, but the response body doesn't finish streaming/parsing for another 30
 * seconds - the old code measured a 100ms round trip when ~30.1 real seconds had actually elapsed,
 * which could extend an active-guidance advisory nearly 30 seconds past its true, server-authorized
 * deadline. `t1` is now taken only after the body has been fully read, JSON-parsed, and its
 * `serverNow` field validated as a real, finite instant - the LAST thing this function does before
 * returning a successful calibration.
 *
 * Returns `null` (never a guessed/partial value) for ANY failure: a rejected fetch, a non-OK
 * response, unparseable JSON, a missing/non-string `serverNow`, or a `serverNow` that doesn't parse
 * to a finite instant. The caller must treat `null` exactly like "cannot establish trusted server
 * time right now" - remain neutral, never fall back to the client's own `Date.now()`.
 */
export async function calibrateServerTime(fetchImpl: typeof fetch = fetch, endpoint = "/api/time"): Promise<ServerTimeCalibration | null> {
  const t0 = performance.now();
  let response: Response;
  try {
    response = await fetchImpl(endpoint, { cache: "no-store" });
  } catch {
    return null;
  }

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

  // Codex P2 (A, round 4) - measured only now, after headers, body bytes, JSON parsing, AND
  // `serverNow` validation have all genuinely completed - never right after `fetch()` alone
  // resolves. This is the one change that fixes the missing response-body-delay defect.
  const t1 = performance.now();
  const roundTripMs = t1 - t0;
  if (!Number.isFinite(roundTripMs) || roundTripMs < 0) {
    return null;
  }

  return { serverNowMs, roundTripMs, measurementCompletedAtMonotonic: t1 };
}

/**
 * The trust-sensitive budget calculation itself:
 *
 *   serverUpperBoundNow = serverNow + roundTripMs   (a conservative OVERESTIMATE of "now" - the
 *                                                     round trip can only make this later than the
 *                                                     server's real clock, never earlier; it is
 *                                                     acceptable for this to expire guidance a
 *                                                     little early, never acceptable to extend it)
 *   remainingMs = activeGuidanceDeadline - max(evaluatedAt, serverUpperBoundNow)
 *
 * This is the remaining budget AS OF the exact instant `calibration.measurementCompletedAtMonotonic`
 * represents - not "remaining from whenever this function happens to be called." Callers that need
 * an absolute expiry instant (almost always the right choice - see `computeExpiresAtMonotonic`)
 * should prefer that function instead of re-deriving one from this raw number later.
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
 * Codex P2 (A, round 4) - converts a calibration into a single FIXED monotonic instant
 * (`performance.now()`-comparable) at which the advisory expires: exactly
 * `calibration.measurementCompletedAtMonotonic + remainingMsAtMeasurement`. This is the anchor
 * every expiry check and scheduled timer must compare against.
 *
 * This exists to close a second round-3 defect: computing a "remaining ms" value once and then
 * later starting a FRESH monotonic origin (a new `performance.now()` read taken whenever the hook
 * gets around to applying the result) silently re-grants however much time had already elapsed
 * between calibration completing and the result being applied - effectively restarting the budget.
 * Anchoring to one fixed absolute instant instead means any amount of application delay simply
 * shortens the time remaining until that instant, exactly as it should - the instant itself never
 * moves.
 *
 * Returns `null` (never a guessed instant) whenever the underlying remaining-budget calculation
 * would, or when `measurementCompletedAtMonotonic` itself is not finite.
 */
export function computeExpiresAtMonotonic(
  deadlineMs: number,
  evaluatedAtMs: number,
  calibration: ServerTimeCalibration | null,
): number | null {
  const remainingMs = computeRemainingMsFromCalibration(deadlineMs, evaluatedAtMs, calibration);
  if (remainingMs === null || calibration === null || !Number.isFinite(calibration.measurementCompletedAtMonotonic)) {
    return null;
  }
  const expiresAtMonotonic = calibration.measurementCompletedAtMonotonic + remainingMs;
  return Number.isFinite(expiresAtMonotonic) ? expiresAtMonotonic : null;
}

/**
 * Given a fixed expiry instant from `computeExpiresAtMonotonic` and the current `performance.now()`
 * reading, decides whether the advisory is expired. `null` (failed/invalid calibration) always
 * fails closed to expired - never guessed as "still active." No grace period: `nowMonotonic`
 * exactly equal to `expiresAtMonotonic` is already expired.
 */
export function isExpiredAtMonotonic(expiresAtMonotonic: number | null, nowMonotonic: number): boolean {
  if (expiresAtMonotonic === null || !Number.isFinite(expiresAtMonotonic)) {
    return true;
  }
  return nowMonotonic >= expiresAtMonotonic;
}

/**
 * Codex P2 (A, round 4) - a simple monotonically-increasing token for invalidating superseded async
 * work, extracted as its own tiny, directly-testable primitive so the invalidation LOGIC (not React's
 * own effect/render scheduling, which this repo has no harness for) has real regression coverage.
 *
 * Fixes the second round-4 defect: a calibration request still pending when a NEWER one starts (e.g.
 * a tab-visibility resume firing a fresh calibration while the original request was still in flight)
 * could otherwise resolve LATER and overwrite the newer, already-settled state - including
 * reactivating guidance a newer, failed calibration had already correctly neutralized. Every
 * calibration attempt (and any timer it schedules) is stamped with the generation active when it
 * STARTED (`bumpGeneration`'s return value); its result is applied only if `isCurrentGeneration`
 * still says so once it resolves/fires. See src/components/use-active-guidance-expired.ts for the
 * real usage: a new calibration, a visibility change that neutralizes guidance, a fresh (deadline,
 * evaluatedAt) pair, and effect cleanup all call `bumpGeneration` to invalidate anything in flight.
 */
export type Generation = { current: number };

export function createGeneration(): Generation {
  return { current: 0 };
}

/** Advances to a new generation and returns it - the caller stamps this value onto whatever work it
 * is about to start (a calibration request, a scheduled timer). */
export function bumpGeneration(generation: Generation): number {
  generation.current += 1;
  return generation.current;
}

/** Whether `myGeneration` (a value previously returned by `bumpGeneration`) is still the current one
 * - `false` means the work it was stamped on has been superseded and its result/callback must be
 * ignored outright, no matter what it resolved to. */
export function isCurrentGeneration(generation: Generation, myGeneration: number): boolean {
  return generation.current === myGeneration;
}
