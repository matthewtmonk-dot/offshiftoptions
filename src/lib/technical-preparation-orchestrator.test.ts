import { describe, expect, it } from "vitest";
import { isTechnicalPreparationWindowOpen } from "./technical-preparation-orchestrator";

// Sep 2026 is Eastern Daylight Time (UTC-4). Tue Sep 8 2026 is a real NYSE market day (the day
// after Labor Day - see marketCalendar.test.ts's own fixture for the same date); Thu Sep 10 2026
// is also a real NYSE market day.
describe("isTechnicalPreparationWindowOpen - morning-before-open window (moved from evening-after-close, see PROJECT_HANDOFF.md)", () => {
  it("is CLOSED before the 5:45 AM ET window start on a real trading day", () => {
    // Thu Sep 10 2026, 5:44 AM ET = 09:44 UTC.
    expect(isTechnicalPreparationWindowOpen(new Date("2026-09-10T09:44:00Z"))).toBe(false);
  });

  it("is OPEN exactly at the 5:45 AM ET window start on an EDT trading day", () => {
    // Thu Sep 10 2026, 5:45 AM EDT = 09:45 UTC.
    expect(isTechnicalPreparationWindowOpen(new Date("2026-09-10T09:45:00Z"))).toBe(true);
  });

  it("is OPEN exactly at the 9:15 AM ET window end (inclusive) on an EDT trading day", () => {
    // Thu Sep 10 2026, 9:15 AM EDT = 13:15 UTC.
    expect(isTechnicalPreparationWindowOpen(new Date("2026-09-10T13:15:00Z"))).toBe(true);
  });

  it("is CLOSED just after the 9:15 AM ET window end, including the rest of the regular session and evening", () => {
    // Thu Sep 10 2026, 9:20 AM EDT = 13:20 UTC.
    expect(isTechnicalPreparationWindowOpen(new Date("2026-09-10T13:20:00Z"))).toBe(false);
    // Thu Sep 10 2026, 2:00 PM EDT (mid-session) = 18:00 UTC.
    expect(isTechnicalPreparationWindowOpen(new Date("2026-09-10T18:00:00Z"))).toBe(false);
    // Thu Sep 10 2026, 8:00 PM EDT (evening) = 00:00 UTC Sep 11.
    expect(isTechnicalPreparationWindowOpen(new Date("2026-09-11T00:00:00Z"))).toBe(false);
  });

  it("is CLOSED all day on a Sunday - there is no open to prepare for, and Saturday's own catch-up run (if successful) already covers Sunday's freshness requirement", () => {
    // Sun Sep 6 2026, 6:00 AM ET = 10:00 UTC, and again at noon.
    expect(isTechnicalPreparationWindowOpen(new Date("2026-09-06T10:00:00Z"))).toBe(false);
    expect(isTechnicalPreparationWindowOpen(new Date("2026-09-06T16:00:00Z"))).toBe(false);
  });

  describe("Saturday catch-up window (weekend scanner-readiness gap, see PROJECT_HANDOFF.md)", () => {
    it("is CLOSED before the 5:45 AM ET Saturday window start", () => {
      // Sat Sep 5 2026, 5:44 AM EDT = 09:44 UTC.
      expect(isTechnicalPreparationWindowOpen(new Date("2026-09-05T09:44:00Z"))).toBe(false);
    });

    it("is OPEN exactly at the 5:45 AM ET Saturday window start", () => {
      // Sat Sep 5 2026, 5:45 AM EDT = 09:45 UTC.
      expect(isTechnicalPreparationWindowOpen(new Date("2026-09-05T09:45:00Z"))).toBe(true);
    });

    it("is OPEN through the middle of the Saturday catch-up window (wider than the weekday one - no market open to race against)", () => {
      // Sat Sep 5 2026, 9:30 AM EDT = 13:30 UTC - already past the weekday window's own 9:15 AM
      // end, but still well inside Saturday's wider allowance.
      expect(isTechnicalPreparationWindowOpen(new Date("2026-09-05T13:30:00Z"))).toBe(true);
    });

    it("is OPEN exactly at the 12:00 PM ET Saturday window end (inclusive)", () => {
      // Sat Sep 5 2026, 12:00 PM EDT = 16:00 UTC.
      expect(isTechnicalPreparationWindowOpen(new Date("2026-09-05T16:00:00Z"))).toBe(true);
    });

    it("is CLOSED just after the Saturday window end, and for the rest of the day", () => {
      // Sat Sep 5 2026, 12:05 PM EDT = 16:05 UTC.
      expect(isTechnicalPreparationWindowOpen(new Date("2026-09-05T16:05:00Z"))).toBe(false);
      // Sat Sep 5 2026, 8:00 PM EDT = 00:00 UTC Sep 6.
      expect(isTechnicalPreparationWindowOpen(new Date("2026-09-06T00:00:00Z"))).toBe(false);
    });

    it("correctly evaluates the Saturday window under EST (winter) too - never a hardcoded UTC offset", () => {
      // Sat Jan 3 2026 (winter, EST, UTC-5) - 5:45 AM EST = 10:45 UTC, 12:00 PM EST = 17:00 UTC.
      expect(isTechnicalPreparationWindowOpen(new Date("2026-01-03T10:44:00Z"))).toBe(false);
      expect(isTechnicalPreparationWindowOpen(new Date("2026-01-03T10:45:00Z"))).toBe(true);
      expect(isTechnicalPreparationWindowOpen(new Date("2026-01-03T17:00:00Z"))).toBe(true);
      expect(isTechnicalPreparationWindowOpen(new Date("2026-01-03T17:05:00Z"))).toBe(false);
    });
  });

  it("is CLOSED all day on a real NYSE holiday (Labor Day 2026) - it never fabricates a fake trading session to prepare for", () => {
    // Mon Sep 7 2026 (Labor Day), 6:00 AM ET = 10:00 UTC.
    expect(isTechnicalPreparationWindowOpen(new Date("2026-09-07T10:00:00Z"))).toBe(false);
  });

  it("correctly evaluates DST-shifted winter time too (EST, UTC-5) - never a hardcoded UTC offset", () => {
    // Tue Jan 6 2026 (a real weekday, winter/EST) - 4:00 AM ET = 09:00 UTC (not 08:00, proving the
    // DST-aware Intl-based conversion, not a fixed summer-only offset assumption).
    expect(isTechnicalPreparationWindowOpen(new Date("2026-01-06T10:44:00Z"))).toBe(false); // before window start
    expect(isTechnicalPreparationWindowOpen(new Date("2026-01-06T10:45:00Z"))).toBe(true); // 5:45 AM EST = 10:45 UTC
    expect(isTechnicalPreparationWindowOpen(new Date("2026-01-06T14:15:00Z"))).toBe(true); // 9:15 AM EST = 14:15 UTC
    expect(isTechnicalPreparationWindowOpen(new Date("2026-01-06T14:20:00Z"))).toBe(false); // just past window end
  });

  it("Tuesday after Labor Day morning is inside the window (the required market date resolution itself is previousNyseMarketDay's job, not this window function's)", () => {
    // Tue Sep 8 2026, 6:00 AM ET = 10:00 UTC - the morning after the long weekend, before that
    // day's own open. This window function only decides "is it currently appropriate to run a
    // cycle" - which prior trading day is actually required is resolved separately by
    // previousNyseMarketDay(now) inside refreshTechnicalIndicatorCacheBatchForUser.
    expect(isTechnicalPreparationWindowOpen(new Date("2026-09-08T10:00:00Z"))).toBe(true);
  });
});
