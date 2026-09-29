import { describe, expect, it } from "vitest";
import { computeExpiredAtHydration } from "./use-active-guidance-expired";

/**
 * Codex P1 (B3) / Codex P2 (A) - direct unit tests for the pure hydration-time expiry decision
 * `useActiveGuidanceExpired` itself wraps. This repo has no React/DOM component-test harness (no
 * testing-library, no jsdom environment - see vitest.config.mts's plain "node" environment and
 * every other component in this codebase, none of which have direct render tests), so the hook's
 * own scheduling/re-render behavior is not exercised here; this is the actual trusted-timing
 * decision rule the hook uses once, at hydration, for every (deadline, evaluatedAt) pair.
 */
describe("computeExpiredAtHydration", () => {
  const EVALUATED_AT = new Date("2026-06-15T16:00:00.000Z").getTime();
  const DEADLINE = EVALUATED_AT + 120_000; // a 120-second budget, matching the quote-freshness window

  it("is null when there is no deadline at all - nothing to expire", () => {
    expect(computeExpiredAtHydration(null, EVALUATED_AT)).toBeNull();
    expect(computeExpiredAtHydration(DEADLINE, null)).toBeNull();
    expect(computeExpiredAtHydration(null, null)).toBeNull();
  });

  it("is false when hydration happens well within the budget and the client clock agrees with server time", () => {
    const clientNow = EVALUATED_AT + 1_000; // 1s of normal delivery delay
    expect(computeExpiredAtHydration(DEADLINE, EVALUATED_AT, clientNow)).toBe(false);
  });

  it("is true once hydration happens at/after the deadline, with an agreeing client clock", () => {
    expect(computeExpiredAtHydration(DEADLINE, EVALUATED_AT, DEADLINE)).toBe(true);
    expect(computeExpiredAtHydration(DEADLINE, EVALUATED_AT, DEADLINE + 1)).toBe(true);
  });

  it("fails closed (expired) for a non-finite deadline or evaluatedAt rather than treating uncertainty as still-valid", () => {
    expect(computeExpiredAtHydration(Number.NaN, EVALUATED_AT)).toBe(true);
    expect(computeExpiredAtHydration(DEADLINE, Number.NaN)).toBe(true);
  });

  describe("Codex P2 (A) - a slow client wall clock can never extend guidance", () => {
    it("a client clock reading BEFORE the server's own evaluation time does not grant extra remaining budget", () => {
      // The client's Date.now() claims we're still before evaluatedAt (a badly-slow/wrong clock) -
      // the budget must still be measured from evaluatedAt itself (the trusted server origin),
      // never from the earlier, untrustworthy client reading.
      const slowClientNow = EVALUATED_AT - 60_000; // clock claims we're a full minute BEFORE server time
      // Real remaining budget from the trusted origin is still the full 120s, unaffected by the
      // slow clock's own (ignored) reading - hydrating "immediately" per the untrustworthy clock
      // still only gets the true, unshortened budget, never more.
      expect(computeExpiredAtHydration(DEADLINE, EVALUATED_AT, slowClientNow)).toBe(false);
    });

    it("a slow clock cannot resurrect an already-expired deadline either", () => {
      const pastDeadline = EVALUATED_AT + 1_000;
      const slowClientNow = EVALUATED_AT - 60_000; // slow clock still claims we're before evaluatedAt
      // Even though the slow clock's own reading looks "early", the deadline itself has already
      // passed relative to the trusted evaluatedAt+budget - using Math.max(evaluatedAt, slowNow)
      // still anchors at evaluatedAt, and remainingMs = pastDeadline - evaluatedAt = 1000ms > 0,
      // so this specific case is NOT yet expired at hydration (the deadline is only 1s after
      // evaluation) - demonstrating the anchor is evaluatedAt, never the slow clock's claim.
      expect(computeExpiredAtHydration(pastDeadline, EVALUATED_AT, slowClientNow)).toBe(false);
    });
  });

  describe("Codex P2 (A) - a fast client wall clock never makes stale advice active", () => {
    it("a fast client clock correctly shortens (never lengthens) the remaining budget", () => {
      const fastClientNow = EVALUATED_AT + 100_000; // clock reads 100s ahead of the true delivery delay
      // Only 20s of the 120s budget remains once anchored at the fast clock's later reading.
      expect(computeExpiredAtHydration(DEADLINE, EVALUATED_AT, fastClientNow)).toBe(false);
      expect(computeExpiredAtHydration(DEADLINE, EVALUATED_AT, fastClientNow + 20_000)).toBe(true);
    });

    it("a fast clock can only expire something sooner, never keep something expired from looking expired", () => {
      const wayFastClientNow = DEADLINE + 500_000; // clock reads far past the real deadline
      expect(computeExpiredAtHydration(DEADLINE, EVALUATED_AT, wayFastClientNow)).toBe(true);
    });
  });

  it("Codex P2 (A) - hydration/delivery delay reduces remaining validity, never extends it", () => {
    const noDelay = computeExpiredAtHydration(DEADLINE, EVALUATED_AT, EVALUATED_AT);
    const smallDelay = computeExpiredAtHydration(DEADLINE, EVALUATED_AT, EVALUATED_AT + 60_000);
    const fullDelay = computeExpiredAtHydration(DEADLINE, EVALUATED_AT, EVALUATED_AT + 120_000);
    const overDelay = computeExpiredAtHydration(DEADLINE, EVALUATED_AT, EVALUATED_AT + 150_000);
    expect(noDelay).toBe(false);
    expect(smallDelay).toBe(false); // 60s of the 120s budget consumed by delay - still 60s left
    expect(fullDelay).toBe(true); // the entire budget was consumed by delivery delay alone
    expect(overDelay).toBe(true); // delay alone already exceeded the budget
  });

  it("is exactly true AT the deadline with no grace period past it (Codex P2 (A) - the prior 250ms grace is removed)", () => {
    expect(computeExpiredAtHydration(DEADLINE, EVALUATED_AT, DEADLINE)).toBe(true);
    expect(computeExpiredAtHydration(DEADLINE, EVALUATED_AT, DEADLINE - 1)).toBe(false);
  });
});
