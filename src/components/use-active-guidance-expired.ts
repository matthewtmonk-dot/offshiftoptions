"use client";

import { useEffect, useState } from "react";

/**
 * Dashboard V2 Phase 2 - Codex P1 (B3) / Codex P2 (A). Shared by LivePositionReviewBadge and
 * LivePositionReviewEvidenceLine so the dominant badge and the secondary evidence text always
 * downgrade TOGETHER, from the exact same deadline, rather than drifting independently.
 *
 * `deadline` and `evaluatedAt` are both real, server-computed instants (see
 * PositionReviewExplanation.activeGuidanceDeadline/evaluatedAt) - `evaluatedAt` is the trusted
 * origin, `deadline` the trusted expiry, and `deadline - evaluatedAt` is the TOTAL validity budget
 * the server actually authorized. This hook never compares `deadline` directly against a fresh
 * `Date.now()` read on every check - that would let a slow/manipulated client wall clock make an
 * already-expired advisory look current indefinitely (Codex P2 (A)'s exact finding). Instead:
 *
 * 1. At the moment this hook first sees a given (deadline, evaluatedAt) pair (mount, or a fresh
 *    evaluation replacing a prior one), `Date.now()` is read EXACTLY ONCE, only to conservatively
 *    estimate delivery/hydration delay: `Math.max(evaluatedAtMs, Date.now())` can only ever be
 *    >= evaluatedAtMs, so the computed remaining budget (`deadlineMs - that`) can only ever be
 *    <= `deadlineMs - evaluatedAtMs` - the client can shorten the budget (a slow OR fast clock, or
 *    real delivery delay, all reduce or leave it unchanged) but can never extend it.
 * 2. Every check AFTER that one-time read uses only `performance.now()` - a monotonic clock immune
 *    to wall-clock adjustments while the page stays open (a user/OS changing the system clock
 *    mid-session cannot resurrect or extend an advisory this way, unlike a repeated `Date.now()`
 *    comparison would).
 * 3. The single scheduled check fires exactly at the computed budget - no polling, no grace period
 *    past the real deadline.
 * 4. Tab-visibility resume re-runs the SAME monotonic comparison (never a fresh Date.now() read),
 *    so a background tab that missed its timer still resolves conservatively on resume.
 *
 * Uncertainty fails closed: a non-finite deadline/evaluatedAt resolves immediately expired.
 */
export function useActiveGuidanceExpired(deadline: Date | null, evaluatedAt: Date | null): boolean {
  const deadlineMs = deadline?.getTime() ?? null;
  const evaluatedAtMs = evaluatedAt?.getTime() ?? null;
  const [expired, setExpired] = useState(() => computeExpiredAtHydration(deadlineMs, evaluatedAtMs) ?? false);

  useEffect(() => {
    if (deadlineMs === null || evaluatedAtMs === null) {
      // No live advisory to expire - route through `check` (never a bare direct setState call in
      // the effect body) for consistency with the other branches below.
      const check = () => setExpired(false);
      check();
      return;
    }

    if (!Number.isFinite(deadlineMs) || !Number.isFinite(evaluatedAtMs)) {
      // Fail closed on a corrupted trusted timestamp - never treat uncertainty as "still valid".
      const check = () => setExpired(true);
      check();
      return;
    }

    // The ONE, single Date.now() read for this (deadline, evaluatedAt) pair - see the doc comment
    // above for why this can only ever shorten, never extend, the computed budget.
    const remainingMs = deadlineMs - Math.max(evaluatedAtMs, Date.now());
    const hydrationMonotonic = performance.now();
    const deadlineMonotonic = hydrationMonotonic + remainingMs;

    const check = () => setExpired(performance.now() >= deadlineMonotonic);
    check();

    if (remainingMs <= 0) {
      return; // already past budget at hydration - check() above already set expired, nothing to schedule
    }

    const timeout = setTimeout(check, remainingMs);
    // A hidden/backgrounded tab can suspend timers - re-check on resume using the SAME monotonic
    // comparison (never a fresh Date.now() read).
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearTimeout(timeout);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [deadlineMs, evaluatedAtMs]);

  return expired;
}

/** Exported for direct unit testing - this repo has no React/DOM component-test harness (see
 * PROJECT_HANDOFF.md), so the hook's own scheduling/re-render behavior is not exercised by an
 * automated test; this pure decision function (the hydration-time expiry rule) is. Returns `null`
 * when there is no deadline at all (nothing to expire) so a caller can distinguish "definitely not
 * expired" from "not applicable." */
export function computeExpiredAtHydration(deadlineMs: number | null, evaluatedAtMs: number | null, clientNowMs: number = Date.now()): boolean | null {
  if (deadlineMs === null || evaluatedAtMs === null) {
    return null;
  }
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(evaluatedAtMs)) {
    return true;
  }
  const remainingMs = deadlineMs - Math.max(evaluatedAtMs, clientNowMs);
  return remainingMs <= 0;
}
