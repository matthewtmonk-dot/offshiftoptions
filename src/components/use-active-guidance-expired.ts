"use client";

import { useEffect, useRef, useState } from "react";
import {
  bumpGeneration,
  calibrateServerTime,
  computeExpiresAtMonotonic,
  createGeneration,
  isCurrentGeneration,
  isExpiredAtMonotonic,
} from "@/lib/server-time-calibration";

/**
 * Dashboard V2 Phase 2 - Codex P1 (B3) / Codex P2 (A, rounds 1-4). Shared by LivePositionAssessmentBadge
 * and LivePositionAssessmentEvidenceLine (Phase 2B rename) so the dominant badge and the secondary evidence text always
 * downgrade TOGETHER, from the exact same deadline, rather than drifting independently.
 *
 * `deadline` and `evaluatedAt` are both real, server-computed instants (see
 * PositionReviewExplanation.activeGuidanceDeadline/evaluatedAt) - `evaluatedAt` is the trusted
 * origin, `deadline` the trusted expiry, and `deadline - evaluatedAt` is the TOTAL validity budget
 * the server actually authorized.
 *
 * Codex P2 (A, round 3) removed the browser's `Date.now()` as an authority entirely, replacing it
 * with a same-origin, read-only server-time calibration (`calibrateServerTime`, `/api/time`) plus
 * `performance.now()` monotonic tracking. Codex P2 (A, round 4) fixed two further defects in that
 * calibration model:
 *
 * 1. **Stale calibration/timer reactivation.** A calibration request that was still pending when a
 *    NEWER one started (e.g. a tab-visibility resume firing a fresh calibration while the original
 *    one was still in flight) could resolve LATER and overwrite the newer, already-settled state -
 *    including reactivating guidance a newer, failed calibration had already correctly neutralized.
 *    Fixed with an explicit generation counter (`generationRef`): every calibration attempt is
 *    stamped with the generation active when it STARTED, and its result (success or failure) is
 *    applied only if that generation is still the current one when it resolves. A scheduled expiry
 *    timer is guarded by the same check. Visibility changes, a new calibration starting, an
 *    effect-dependency change (a fresh review/deadline replacing this one), and effect cleanup all
 *    advance the generation counter, invalidating anything still in flight from before.
 * 2. **Restarting the budget on late application.** Computing a "remaining ms" value once and then
 *    starting a FRESH `performance.now()` origin whenever the hook got around to applying it would
 *    silently re-grant however much time had already elapsed between calibration completing and the
 *    result being applied. Fixed by anchoring to a single fixed absolute monotonic instant
 *    (`computeExpiresAtMonotonic`, `src/lib/server-time-calibration.ts`) - every check and every
 *    scheduled timeout compares against that same fixed instant, so any amount of processing/
 *    application delay only shortens the time remaining until it, never restarts a fresh countdown.
 *
 * Overall behavior, preserved and extended:
 *
 * 1. This hook ALWAYS starts neutral/pending (`expired = true`) - there is no synchronous answer
 *    available at first render, and an advisory must never briefly flash active and then retract
 *    once calibration resolves it was already stale. Only a snapshot's own factual (non-live-
 *    guidance) data may still render.
 * 2. On mount (and whenever a fresh (deadline, evaluatedAt) pair replaces a prior one), this hook
 *    fetches this app's own same-origin, read-only server-time endpoint (see
 *    src/app/api/time/route.ts) and computes the remaining budget ONLY from that response plus the
 *    measured round-trip time (now including full response-body delivery/parsing time) - never from
 *    the browser's own clock.
 * 3. On ANY calibration failure - a rejected fetch, a non-OK response, malformed JSON, a missing or
 *    non-finite server timestamp, or a contradictory (deadline <= evaluatedAt) input - this hook
 *    never guesses: it stays neutral/expired.
 * 4. After a successful, still-current-generation calibration, every subsequent check compares
 *    `performance.now()` against the ONE fixed `expiresAtMonotonic` instant computed at calibration
 *    time - never a fresh remaining-budget countdown, never a return to Date.now().
 * 5. The single scheduled check fires exactly at the computed deadline instant - no polling, no
 *    grace period past it.
 * 6. Tab-visibility resume never blindly restores a previously-active status (a backgrounded tab
 *    could have been asleep well past its real deadline) - it immediately downgrades to
 *    neutral/expired, invalidates any prior generation, and requires a NEW successful, current-
 *    generation calibration (itself same-origin/read-only, so this is safe even while otherwise
 *    "paused") before it can become active again; a failed recalibration on resume leaves it
 *    neutral. Tab-visibility HIDE also immediately invalidates any in-flight calibration/timer.
 *
 * This hook's own scheduling/effect wiring is not directly unit-tested (this repo has no React/DOM
 * component-test harness - see PROJECT_HANDOFF.md); the pure, trust-sensitive math it calls into
 * (calibrateServerTime / computeExpiresAtMonotonic / isExpiredAtMonotonic) is fully covered by
 * src/lib/server-time-calibration.test.ts.
 */
export function useActiveGuidanceExpired(deadline: Date | null, evaluatedAt: Date | null): boolean {
  const deadlineMs = deadline?.getTime() ?? null;
  const evaluatedAtMs = evaluatedAt?.getTime() ?? null;
  const [expired, setExpired] = useState(true);
  // Codex P2 (A, round 4) - identifies the current "epoch" of calibration/timer work (see
  // createGeneration/bumpGeneration/isCurrentGeneration in server-time-calibration.ts). Any in-
  // flight async result or scheduled callback stamped with a superseded generation is ignored.
  const generationRef = useRef(createGeneration());

  useEffect(() => {
    // Captured once per effect run - `generationRef.current` is a stable Generation object created
    // exactly once (see useRef above) and only ever mutated in place, never reassigned, but a local
    // binding keeps the cleanup below independent of ref-access-timing concerns.
    const generation = generationRef.current;

    if (deadlineMs === null || evaluatedAtMs === null) {
      bumpGeneration(generation); // invalidate anything still in flight from a prior (deadline, evaluatedAt) pair
      const check = () => setExpired(false);
      check();
      return;
    }

    const resetToPending = () => setExpired(true);
    resetToPending();

    let timeout: ReturnType<typeof setTimeout> | undefined;

    const clearScheduledTimer = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
    };

    const startCalibration = () => {
      clearScheduledTimer();
      const myGeneration = bumpGeneration(generation);

      void (async () => {
        const calibration = await calibrateServerTime();
        // Codex P2 (A, round 4) - a superseded calibration request must never reactivate guidance,
        // overwrite newer (possibly failed) state, or schedule a timer - no matter when it resolves.
        if (!isCurrentGeneration(generation, myGeneration)) {
          return;
        }

        const expiresAtMonotonic = computeExpiresAtMonotonic(deadlineMs, evaluatedAtMs, calibration);
        if (expiresAtMonotonic === null) {
          setExpired(true); // failed/malformed/invalid/contradictory - never guess, stay neutral
          return;
        }

        const check = () => {
          if (!isCurrentGeneration(generation, myGeneration)) {
            return; // a timer whose generation is no longer current must never mutate state
          }
          setExpired(isExpiredAtMonotonic(expiresAtMonotonic, performance.now()));
        };
        check();

        // Recomputed from a fresh `performance.now()` read purely to schedule the timeout at the
        // right delay - the comparison target itself (`expiresAtMonotonic`) never moves, so any
        // delay already spent between measurement and this point only shortens this delay, never
        // restarts a fresh full-budget countdown.
        const delayMs = expiresAtMonotonic - performance.now();
        if (delayMs > 0) {
          timeout = setTimeout(check, delayMs);
        }
      })();
    };

    startCalibration();

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // Codex P2 (A, round 4) - never blindly restore a previously-active status on resume:
        // remain neutral and require a brand-new, current-generation calibration.
        setExpired(true);
        startCalibration();
      } else {
        // Hidden - immediately neutral, and invalidate any in-flight calibration/scheduled timer so
        // neither can mutate state once the tab is no longer visible.
        clearScheduledTimer();
        bumpGeneration(generation);
        setExpired(true);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      bumpGeneration(generation); // invalidate any in-flight calibration/timer on cleanup
      clearScheduledTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [deadlineMs, evaluatedAtMs]);

  return expired;
}
