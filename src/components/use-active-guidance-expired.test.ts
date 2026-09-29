import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPastDeadline } from "./use-active-guidance-expired";

/**
 * Codex P1 (B3) - direct unit tests for the pure expiry decision `useActiveGuidanceExpired`
 * itself wraps. This repo has no React/DOM component-test harness (no testing-library, no jsdom
 * environment - see vitest.config.mts's plain "node" environment and every other component in
 * this codebase, none of which have direct render tests), so the hook's own scheduling/re-render
 * behavior is not exercised here; this is the actual decision rule the hook uses on every check.
 */
describe("isPastDeadline", () => {
  const NOW = new Date("2026-06-15T16:00:00.000Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is false when there is no deadline at all (nothing to expire)", () => {
    expect(isPastDeadline(null)).toBe(false);
  });

  it("is false strictly before the deadline", () => {
    expect(isPastDeadline(NOW + 1)).toBe(false);
  });

  it("is true exactly AT the deadline (never lingers past the real instant)", () => {
    expect(isPastDeadline(NOW)).toBe(true);
  });

  it("is true after the deadline", () => {
    expect(isPastDeadline(NOW - 1)).toBe(true);
  });

  it("fails closed (expired) for a non-finite deadline rather than treating it as 'never expires'", () => {
    expect(isPastDeadline(Number.NaN)).toBe(true);
  });

  it("a client clock running fast can only resolve expired SOONER, never grant extra live time", () => {
    vi.setSystemTime(NOW + 10_000); // client clock ahead of the real deadline
    expect(isPastDeadline(NOW)).toBe(true);
  });

  it("a client clock running slow only delays detection - it never extends eligibility once checked at/after the real deadline", () => {
    vi.setSystemTime(NOW); // client clock behind where wall-clock time "really" is
    expect(isPastDeadline(NOW - 5_000)).toBe(true); // the real deadline already passed
  });
});
