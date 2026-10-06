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

// Codex blocker repair (B) - the exact reproduced bug: a page left open overnight must not freeze
// on "Last valid today" forever. These tests hold `evaluatedAt` FIXED and only advance `now` -
// exactly what useLiveReferenceTime does in the browser - proving the copy is a pure function of
// `now` and therefore responds correctly once `now` is actually live, never frozen at whatever
// instant the page happened to render at.
describe("lastValidTimingCopy - does not freeze as `now` advances (Codex blocker B)", () => {
  // Monday 2026-06-15, 3:59 PM ET - the ticket's own reproduction instant.
  const MONDAY_359_PM_EVALUATED_AT = new Date("2026-06-15T19:59:00.000Z");

  it("still today while `now` is later the same Monday", () => {
    const sameMondayLater = new Date("2026-06-15T23:00:00.000Z"); // 7:00 PM ET, same NY day
    expect(lastValidTimingCopy(MONDAY_359_PM_EVALUATED_AT, sameMondayLater)).toBe("Last valid today · 3:59 PM ET");
  });

  it("flips to 'Previous session' once `now` has advanced into Tuesday - the same evaluatedAt, a later `now`", () => {
    expect(lastValidTimingCopy(MONDAY_359_PM_EVALUATED_AT, TUESDAY_NOON)).toBe("Previous session · Last valid Jun 15, 3:59 PM ET");
  });

  it("Friday's close stays 'Previous session' (not frozen, not misclassified as older) across the weekend into Saturday", () => {
    const friday359pm = new Date("2026-06-12T19:59:00.000Z");
    const saturday = new Date("2026-06-13T18:00:00.000Z");
    expect(lastValidTimingCopy(friday359pm, saturday)).toBe("Previous session · Last valid Jun 12, 3:59 PM ET");
  });

  it("Friday's close stays 'Previous session' when `now` has advanced all the way to the following Monday", () => {
    const friday359pm = new Date("2026-06-12T19:59:00.000Z");
    expect(lastValidTimingCopy(friday359pm, MONDAY_NOON)).toBe("Previous session · Last valid Jun 12, 3:59 PM ET");
  });

  it("a holiday-adjacent close (Thursday before the observed Independence Day holiday) stays 'Previous session' once `now` reaches the next real trading day", () => {
    // Mirrors positionReviewAssessment.test.ts's own classifyLastValidTiming holiday fixture:
    // July 4, 2026 is a Saturday (observed Friday July 3 is the NYSE holiday); July 2 (Thursday)
    // is the last real trading day before the long weekend, July 6 (Monday) the next one.
    const thursdayBeforeHoliday359pm = new Date("2026-07-02T19:59:00.000Z");
    const mondayAfterHoliday = new Date("2026-07-06T16:00:00.000Z");
    expect(lastValidTimingCopy(thursdayBeforeHoliday359pm, mondayAfterHoliday)).toBe("Previous session · Last valid Jul 2, 3:59 PM ET");
  });

  it("eventually ages past 'Previous session' into the dateless OLDER tier as `now` keeps advancing, for the same fixed evaluatedAt", () => {
    const twoWeeksLater = new Date("2026-06-29T16:00:00.000Z");
    expect(lastValidTimingCopy(MONDAY_359_PM_EVALUATED_AT, twoWeeksLater)).toBe("Last valid Jun 15, 3:59 PM ET");
  });
});
