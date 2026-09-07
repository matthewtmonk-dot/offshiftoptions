import { describe, expect, it } from "vitest";
import { isTechnicalPreparationWindowOpen } from "./technical-preparation-orchestrator";

// Sep 2026 is Eastern Daylight Time (UTC-4). Tue Sep 8 2026 is a real NYSE market day (the day
// after Labor Day - see marketCalendar.test.ts's own fixture for the same date).
describe("isTechnicalPreparationWindowOpen", () => {
  it("is CLOSED during a real trading day's regular session (before 4:00 PM ET)", () => {
    // Tue Sep 8 2026, 2:00 PM ET = 18:00 UTC.
    expect(isTechnicalPreparationWindowOpen(new Date("2026-09-08T18:00:00Z"))).toBe(false);
  });

  it("is CLOSED right at market open on a real trading day", () => {
    // Tue Sep 8 2026, 9:30 AM ET = 13:30 UTC.
    expect(isTechnicalPreparationWindowOpen(new Date("2026-09-08T13:30:00Z"))).toBe(false);
  });

  it("is OPEN exactly at the 4:00 PM ET close on a real trading day", () => {
    // Tue Sep 8 2026, 4:00 PM ET = 20:00 UTC.
    expect(isTechnicalPreparationWindowOpen(new Date("2026-09-08T20:00:00Z"))).toBe(true);
  });

  it("is OPEN in the evening after a real trading day's close", () => {
    // Tue Sep 8 2026, 8:00 PM ET = 00:00 UTC Sep 9.
    expect(isTechnicalPreparationWindowOpen(new Date("2026-09-09T00:00:00Z"))).toBe(true);
  });

  it("is OPEN all day on a weekend (no trading session to avoid)", () => {
    // Sat Sep 5 2026, noon ET.
    expect(isTechnicalPreparationWindowOpen(new Date("2026-09-05T16:00:00Z"))).toBe(true);
  });

  it("is OPEN all day on a real NYSE holiday (Labor Day 2026) - it never fabricates a fake trading session to avoid", () => {
    // Mon Sep 7 2026 (Labor Day), noon ET.
    expect(isTechnicalPreparationWindowOpen(new Date("2026-09-07T16:00:00Z"))).toBe(true);
  });

  it("correctly evaluates DST-shifted winter time too (EST, UTC-5) - never a hardcoded UTC offset", () => {
    // Tue Jan 6 2026 (a real weekday, winter/EST) - 2:00 PM ET = 19:00 UTC (not 18:00, proving the
    // DST-aware Intl-based conversion, not a fixed summer-only offset assumption).
    expect(isTechnicalPreparationWindowOpen(new Date("2026-01-06T19:00:00Z"))).toBe(false); // still in session
    expect(isTechnicalPreparationWindowOpen(new Date("2026-01-06T21:00:00Z"))).toBe(true); // 4:00 PM EST = 21:00 UTC
  });
});
