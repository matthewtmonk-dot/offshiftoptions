"use client";

import { useEffect, useState } from "react";
import { calibrateServerTime, computeRemainingMsFromCalibration, isExpiredGivenRemainingMs } from "@/lib/server-time-calibration";

/**
 * Dashboard V2 Phase 2 - Codex P1 (B3) / Codex P2 (A, rounds 1-3). Shared by LivePositionReviewBadge
 * and LivePositionReviewEvidenceLine so the dominant badge and the secondary evidence text always
 * downgrade TOGETHER, from the exact same deadline, rather than drifting independently.
 *
 * `deadline` and `evaluatedAt` are both real, server-computed instants (see
 * PositionReviewExplanation.activeGuidanceDeadline/evaluatedAt) - `evaluatedAt` is the trusted
 * origin, `deadline` the trusted expiry, and `deadline - evaluatedAt` is the TOTAL validity budget
 * the server actually authorized.
 *
 * Codex P2 (A, round 3) - a round-2 attempt anchored the remaining-budget calculation at
 * `Math.max(evaluatedAtMs, Date.now())`: a client wall clock reading EARLIER than the true delivery
 * delay could still grant MORE remaining validity than the server actually authorized (see
 * server-time-calibration.ts's own doc comment for the exact worked example). The browser's
 * `Date.now()` is no longer used as an authority for remaining validity AT ALL. Instead:
 *
 * 1. This hook ALWAYS starts neutral/pending (`expired = true`) - there is no synchronous answer
 *    available at first render (calibration is inherently async), and the ticket is explicit that
 *    an advisory must never briefly flash active and then retract once calibration resolves it was
 *    already stale. Only a snapshot's own factual (non-live-guidance) data may still render.
 * 2. On mount (and whenever a fresh (deadline, evaluatedAt) pair replaces a prior one), this hook
 *    fetches this app's own same-origin, read-only server-time endpoint (see
 *    src/app/api/time/route.ts) and computes the remaining budget ONLY from that response plus the
 *    measured round-trip time - never from the browser's own clock (calibrateServerTime /
 *    computeRemainingMsFromCalibration in server-time-calibration.ts).
 * 3. On ANY calibration failure - a rejected fetch, a non-OK response, malformed JSON, a missing or
 *    non-finite server timestamp, or a contradictory (deadline <= evaluatedAt) input - this hook
 *    never guesses: it stays neutral/expired.
 * 4. After a successful calibration, every subsequent check uses ONLY `performance.now()` monotonic
 *    elapsed time from that calibration's own origin - never returning to Date.now(), and immune to
 *    a wall-clock adjustment mid-session.
 * 5. The single scheduled check fires exactly at the computed budget - no polling, no grace period
 *    past the real deadline.
 * 6. Tab-visibility resume never blindly restores a previously-active status (a backgrounded tab
 *    could have been asleep well past its real deadline) - it immediately downgrades to
 *    neutral/expired and requires a NEW successful calibration (itself same-origin/read-only, so
 *    this is safe even while otherwise "paused") before it can become active again; a failed
 *    recalibration on resume leaves it neutral.
 *
 * This hook's own scheduling/effect wiring is not directly unit-tested (this repo has no React/DOM
 * component-test harness - see PROJECT_HANDOFF.md); the pure, trust-sensitive math it calls into
 * (calibrateServerTime / computeRemainingMsFromCalibration / isExpiredGivenRemainingMs) is fully
 * covered by src/lib/server-time-calibration.test.ts.
 */
export function useActiveGuidanceExpired(deadline: Date | null, evaluatedAt: Date | null): boolean {
  const deadlineMs = deadline?.getTime() ?? null;
  const evaluatedAtMs = evaluatedAt?.getTime() ?? null;
  const [expired, setExpired] = useState(true);

  useEffect(() => {
    if (deadlineMs === null || evaluatedAtMs === null) {
      // No live advisory to expire - route through `check` (never a bare direct setState call in
      // the effect body) for consistency with the other branches below.
      const check = () => setExpired(false);
      check();
      return;
    }

    // Always re-enter neutral/pending for a fresh (deadline, evaluatedAt) pair - never carry over
    // the previous pair's resolved status while this pair's own calibration is still in flight.
    const resetToPending = () => setExpired(true);
    resetToPending();

    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const recalibrate = async () => {
      const calibration = await calibrateServerTime();
      if (cancelled) {
        return;
      }
      const remainingMs = computeRemainingMsFromCalibration(deadlineMs, evaluatedAtMs, calibration);
      if (remainingMs === null) {
        setExpired(true); // failed/malformed/invalid/contradictory - never guess, stay neutral
        return;
      }

      const originMonotonic = performance.now();
      const check = () => setExpired(isExpiredGivenRemainingMs(remainingMs, performance.now() - originMonotonic));
      check();

      if (remainingMs > 0) {
        timeout = setTimeout(check, remainingMs);
      }
    };

    void recalibrate();

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      // Codex P2 (A, round 3) - never blindly restore a previously-active status on resume.
      if (timeout) {
        clearTimeout(timeout);
      }
      setExpired(true);
      void recalibrate();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [deadlineMs, evaluatedAtMs]);

  return expired;
}
