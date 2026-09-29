"use client";

import { useEffect, useState } from "react";

/**
 * Dashboard V2 Phase 2 - Codex P1 (B3). Shared by LivePositionReviewBadge and
 * LivePositionReviewEvidenceLine so the dominant badge and the secondary evidence text always
 * downgrade TOGETHER, from the exact same deadline, rather than drifting independently (e.g. a
 * badge that's already gone neutral sitting next to evidence text that still claims "Schwab
 * confirmed"). `deadline` is always a real, server-computed instant (see
 * PositionReviewExplanation.activeGuidanceDeadline) - this hook only ever measures the viewer's
 * OWN clock against that deadline, never substitutes client time for it, and never extends
 * eligibility past it (a clock running fast can only make this resolve EXPIRED sooner, never
 * later; a clock running slow only delays detection until the next check - it can never grant
 * extra live time beyond the real deadline once any check actually runs).
 */
export function useActiveGuidanceExpired(deadline: Date | null): boolean {
  const deadlineMs = deadline?.getTime() ?? null;
  const [expired, setExpired] = useState(() => isPastDeadline(deadlineMs));

  useEffect(() => {
    // isPastDeadline(null) is always false, so this same check covers both "no deadline at all"
    // and "deadline present" uniformly - never a separate direct setState branch.
    const check = () => setExpired(isPastDeadline(deadlineMs));
    check();

    if (deadlineMs === null) {
      return;
    }

    // Schedule exactly at the real deadline (plus a small buffer for clock granularity) rather
    // than polling on a fixed interval - a five-second poll can let a five-second-old expiry sit
    // on screen looking current for up to five more seconds. A non-positive delay (the deadline
    // has already passed by the time this effect runs) fires on the next tick immediately.
    const delayMs = Math.max(0, deadlineMs - Date.now()) + 250;
    const timeout = setTimeout(check, delayMs);

    // A hidden/backgrounded tab can suspend timers far longer than the deadline itself - re-check
    // immediately on resume rather than trusting a timer that may not have fired while hidden.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearTimeout(timeout);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [deadlineMs]);

  return expired;
}

/** Exported for direct unit testing - this repo has no React/DOM component-test harness (see
 * PROJECT_HANDOFF.md), so the hook's own scheduling/re-render behavior is not exercised by an
 * automated test; this pure decision function (the actual expiry rule) is. */
export function isPastDeadline(deadlineMs: number | null): boolean {
  if (deadlineMs === null) {
    return false;
  }
  // A deadline that has somehow ended up NaN (should never happen from a real server-computed
  // Date, but this hook must still fail closed rather than treat NaN comparisons - always false -
  // as "never expires").
  if (!Number.isFinite(deadlineMs)) {
    return true;
  }
  return Date.now() >= deadlineMs;
}
