import { describe, expect, it } from "vitest";
import { isTechnicalPreparationWindowOpen } from "./technical-preparation-orchestrator";

// Sep 2026 is Eastern Daylight Time (UTC-4). Tue Sep 8 2026 is a real NYSE market day (the day
// after Labor Day - see marketCalendar.test.ts's own fixture for the same date); Wed Sep 9 2026
// is also a real NYSE market day.
describe("isTechnicalPreparationWindowOpen - morning-before-open window (moved from evening-after-close, see PROJECT_HANDOFF.md)", () => {
  it("is CLOSED before the 5:00 AM ET window start on a real trading day", () => {
    // Wed Sep 9 2026, 4:00 AM ET = 08:00 UTC.
    expect(isTechnicalPreparationWindowOpen(new Date("2026-09-09T08:00:00Z"))).toBe(false);
  });

  it("is OPEN exactly at the 5:00 AM ET window start on a real trading day", () => {
    // Wed Sep 9 2026, 5:00 AM ET = 09:00 UTC.
    expect(isTechnicalPreparationWindowOpen(new Date("2026-09-09T09:00:00Z"))).toBe(true);
  });

  it("is OPEN exactly at the 9:15 AM ET window end (inclusive) on a real trading day", () => {
    // Wed Sep 9 2026, 9:15 AM ET = 13:15 UTC.
    expect(isTechnicalPreparationWindowOpen(new Date("2026-09-09T13:15:00Z"))).toBe(true);
  });

  it("is CLOSED just after the 9:15 AM ET window end, including the rest of the regular session and evening", () => {
    // Wed Sep 9 2026, 9:16 AM ET = 13:16 UTC.
    expect(isTechnicalPreparationWindowOpen(new Date("2026-09-09T13:16:00Z"))).toBe(false);
    // Wed Sep 9 2026, 2:00 PM ET (mid-session) = 18:00 UTC.
    expect(isTechnicalPreparationWindowOpen(new Date("2026-09-09T18:00:00Z"))).toBe(false);
    // Wed Sep 9 2026, 8:00 PM ET (evening) = 00:00 UTC Sep 10.
    expect(isTechnicalPreparationWindowOpen(new Date("2026-09-10T00:00:00Z"))).toBe(false);
  });

  it("is CLOSED all day on a weekend - there is no open to prepare for", () => {
    // Sat Sep 5 2026, 6:00 AM ET = 10:00 UTC (inside what would be the weekday window).
    expect(isTechnicalPreparationWindowOpen(new Date("2026-09-05T10:00:00Z"))).toBe(false);
  });

  it("is CLOSED all day on a real NYSE holiday (Labor Day 2026) - it never fabricates a fake trading session to prepare for", () => {
    // Mon Sep 7 2026 (Labor Day), 6:00 AM ET = 10:00 UTC.
    expect(isTechnicalPreparationWindowOpen(new Date("2026-09-07T10:00:00Z"))).toBe(false);
  });

  it("correctly evaluates DST-shifted winter time too (EST, UTC-5) - never a hardcoded UTC offset", () => {
    // Tue Jan 6 2026 (a real weekday, winter/EST) - 4:00 AM ET = 09:00 UTC (not 08:00, proving the
    // DST-aware Intl-based conversion, not a fixed summer-only offset assumption).
    expect(isTechnicalPreparationWindowOpen(new Date("2026-01-06T09:00:00Z"))).toBe(false); // before window start
    expect(isTechnicalPreparationWindowOpen(new Date("2026-01-06T10:00:00Z"))).toBe(true); // 5:00 AM EST = 10:00 UTC
    expect(isTechnicalPreparationWindowOpen(new Date("2026-01-06T14:15:00Z"))).toBe(true); // 9:15 AM EST = 14:15 UTC
    expect(isTechnicalPreparationWindowOpen(new Date("2026-01-06T14:16:00Z"))).toBe(false); // just past window end
  });

  it("Tuesday after Labor Day morning is inside the window (the required market date resolution itself is previousNyseMarketDay's job, not this window function's)", () => {
    // Tue Sep 8 2026, 6:00 AM ET = 10:00 UTC - the morning after the long weekend, before that
    // day's own open. This window function only decides "is it currently appropriate to run a
    // cycle" - which prior trading day is actually required is resolved separately by
    // previousNyseMarketDay(now) inside refreshTechnicalIndicatorCacheBatchForUser.
    expect(isTechnicalPreparationWindowOpen(new Date("2026-09-08T10:00:00Z"))).toBe(true);
  });
});
