import { describe, expect, it } from "vitest";
import { shortCalendarDate } from "./format";

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
