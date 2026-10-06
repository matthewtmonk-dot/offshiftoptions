import { describe, expect, it } from "vitest";
import { formatEtCompactDateTime, formatEtDateTime, shortCalendarDate } from "./format";

describe("shortCalendarDate", () => {
  it("preserves the stored calendar date for a UTC-midnight date-only value, regardless of the runtime's local timezone", () => {
    // The exact real bug: a bare "2026-09-04" trade/expiration date parses to
    // 2026-09-04T00:00:00.000Z (see parseDateInput). Formatting that through a timezone-aware
    // formatter (this deployment's runtime default is America/New_York) would show "Sep 3, 8:00
    // PM" instead of "Sep 4" - shortCalendarDate must always show the stored calendar date.
    expect(shortCalendarDate("2026-09-04T00:00:00.000Z")).toBe("Sep 4, 2026");
    expect(shortCalendarDate("2026-08-24T00:00:00.000Z")).toBe("Aug 24, 2026");
    expect(shortCalendarDate("2026-08-28T00:00:00.000Z")).toBe("Aug 28, 2026");
  });

  it("accepts a Date object with the same UTC-preserving behavior", () => {
    expect(shortCalendarDate(new Date("2026-09-04T00:00:00.000Z"))).toBe("Sep 4, 2026");
  });

  it("handles a year boundary correctly", () => {
    expect(shortCalendarDate("2026-01-01T00:00:00.000Z")).toBe("Jan 1, 2026");
    expect(shortCalendarDate("2025-12-31T00:00:00.000Z")).toBe("Dec 31, 2025");
  });
});

/**
 * Post-Phase-2 UX follow-up - the exact live production bug: Account Value's "As of ..." detail
 * used `shortDateTime`, which has no explicit `timeZone` and therefore renders in whatever timezone
 * the runtime process happens to be in - in production, a genuine UTC instant showed 4 hours AHEAD
 * of the correct ET time (e.g. 14:28 UTC rendered as "2:28 PM" instead of the correct "10:28 AM
 * EDT"). `formatEtDateTime` always pins to America/New_York regardless of the runtime's own
 * timezone, so this suite never relies on (or needs to mock) the test runner's local timezone.
 */
describe("formatEtDateTime", () => {
  it("Codex UX fix - a UTC instant during EDT (summer) displays 4 hours earlier, labeled ET", () => {
    // 14:28 UTC on 2026-09-30 (EDT, UTC-4) is 10:28 AM ET - the exact reproduction from live
    // production smoke testing (header/position prices correctly showed "10:28 AM ET/EDT", but
    // Account Value showed "2:28 PM" - the raw, unconverted UTC time).
    expect(formatEtDateTime("2026-09-30T14:28:00.000Z")).toBe("Sep 30, 2026, 10:28 AM ET");
  });

  it("accepts a Date object with the same EDT-conversion behavior", () => {
    expect(formatEtDateTime(new Date("2026-09-30T14:28:00.000Z"))).toBe("Sep 30, 2026, 10:28 AM ET");
  });

  it("a UTC instant during EST (winter) displays 5 hours earlier, still labeled ET (never EST)", () => {
    // 14:28 UTC on 2026-01-15 (EST, UTC-5) is 9:28 AM ET.
    expect(formatEtDateTime("2026-01-15T14:28:00.000Z")).toBe("Jan 15, 2026, 9:28 AM ET");
  });

  it("a UTC instant can cross into the previous ET calendar day - the date component converts too, never just the time", () => {
    // 2:15 AM UTC on 2026-09-30 is 10:15 PM ET on 2026-09-29 (EDT, UTC-4).
    expect(formatEtDateTime("2026-09-30T02:15:00.000Z")).toBe("Sep 29, 2026, 10:15 PM ET");
  });
});

describe("formatEtCompactDateTime", () => {
  it("omits the year when the value and reference instant fall in the same NY-calendar year", () => {
    // 2026-10-05T19:57:00.000Z is 3:57 PM ET (EDT, UTC-4) on 2026-10-05 - matches the ticket's own
    // "Oct 5, 3:57 PM ET" copy example exactly.
    expect(formatEtCompactDateTime("2026-10-05T19:57:00.000Z", new Date("2026-10-05T20:00:00.000Z"))).toBe("Oct 5, 3:57 PM ET");
  });

  it("includes the year when the value and reference instant fall in different NY-calendar years", () => {
    expect(formatEtCompactDateTime("2025-12-31T20:00:00.000Z", new Date("2026-01-02T16:00:00.000Z"))).toBe("Dec 31, 2025, 3:00 PM ET");
  });

  it("compares NY-calendar years, not raw UTC years - a late-December EST instant stays in the prior year even though its UTC timestamp already reads January", () => {
    // 2027-01-01T04:30:00.000Z is 11:30 PM ET on 2026-12-31 (EST, UTC-5) - both inputs' raw UTC
    // year is 2027, so a naive getUTCFullYear() comparison would wrongly call this "same year"
    // and omit it; the correct NY-calendar read puts the value in 2026 and the reference in 2027.
    expect(formatEtCompactDateTime("2027-01-01T04:30:00.000Z", new Date("2027-01-01T06:00:00.000Z"))).toBe("Dec 31, 2026, 11:30 PM ET");
  });
});
