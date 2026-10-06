import { describe, expect, it } from "vitest";
import { lastValidTimingCopy } from "./historical-assessment-badge";

// 2026-06-15 is a Monday (matches positionReviewAssessment.test.ts's own NY_DATE fixture).
const MONDAY_NOON = new Date("2026-06-15T16:00:00.000Z"); // 12:00 PM ET
const TUESDAY_NOON = new Date("2026-06-16T16:00:00.000Z"); // 12:00 PM ET
const OLDER_DATE = new Date("2026-06-02T15:57:00.000Z"); // Jun 2, 2026, 11:57 AM ET (a Tuesday)

describe("lastValidTimingCopy", () => {
  it("TODAY tier shows a bare time, no date", () => {
    const evaluatedAt = new Date("2026-06-15T15:57:00.000Z"); // 11:57 AM ET, before "now" (noon)
    expect(lastValidTimingCopy(evaluatedAt, MONDAY_NOON)).toBe("Last valid today · 11:57 AM ET");
  });

  it("PREVIOUS_SESSION tier shows 'Previous session · Last valid <date, time>'", () => {
    const evaluatedAt = new Date("2026-06-15T19:57:00.000Z"); // Monday 3:57 PM ET
    expect(lastValidTimingCopy(evaluatedAt, TUESDAY_NOON)).toBe("Previous session · Last valid Jun 15, 3:57 PM ET");
  });

  it("OLDER tier shows 'Last valid <date, time>' with no 'Previous session' prefix", () => {
    expect(lastValidTimingCopy(OLDER_DATE, TUESDAY_NOON)).toBe("Last valid Jun 2, 11:57 AM ET");
  });

  it("includes the year across a year boundary (delegates to formatEtCompactDateTime)", () => {
    const evaluatedAt = new Date("2025-12-31T20:00:00.000Z"); // Dec 31, 2025, 3:00 PM ET
    const now = new Date("2026-01-05T16:00:00.000Z");
    expect(lastValidTimingCopy(evaluatedAt, now)).toBe("Last valid Dec 31, 2025, 3:00 PM ET");
  });
});
