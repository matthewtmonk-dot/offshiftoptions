import { describe, expect, it } from "vitest";
import { eventTime } from "./event-time";

describe("event timestamps", () => {
  it("uses the Eastern calendar day when UTC has already crossed midnight", () => {
    expect(eventTime(new Date("2026-09-16T00:30:00Z"), new Date("2026-09-16T02:00:00Z"))).toEqual({
      label: "Today, 8:30 PM EDT", full: "Sep 15, 2026, 8:30 PM EDT",
    });
  });
  it("keeps an older event dated even when the page is checked again", () => {
    expect(eventTime(new Date("2026-09-15T12:00:00Z"), new Date("2026-09-17T12:00:00Z")).label).toBe("Sep 15, 2026, 8:00 AM EDT");
  });
  it("distinguishes repeated daylight-saving hours", () => {
    const now = new Date("2026-11-01T12:00:00Z");
    expect(eventTime(new Date("2026-11-01T05:30:00Z"), now).label).toBe("Today, 1:30 AM EDT");
    expect(eventTime(new Date("2026-11-01T06:30:00Z"), now).label).toBe("Today, 1:30 AM EST");
  });
});
