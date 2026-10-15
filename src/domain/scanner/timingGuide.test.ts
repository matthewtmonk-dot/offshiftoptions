import { describe, expect, it } from "vitest";
import { scannerTimingGuide, technicalReadyHint } from "./timingGuide";

// All instants are written in UTC; the comment gives the America/New_York wall-clock time they mean.
const phase = (iso: string) => scannerTimingGuide(new Date(iso)).phase;

describe("scannerTimingGuide", () => {
  it("Saturday morning: Friday's data is still being prepared (caution), ready from noon ET", () => {
    expect(phase("2026-10-17T14:00:00Z")).toBe("WEEKEND_DATA_PREPARING"); // Sat 10:00 AM EDT
    expect(scannerTimingGuide(new Date("2026-10-17T14:00:00Z")).tone).toBe("caution");
    expect(phase("2026-10-17T16:00:00Z")).toBe("WEEKEND_RESEARCH"); // Sat 12:00 PM EDT
    expect(phase("2026-10-17T19:00:00Z")).toBe("WEEKEND_RESEARCH"); // Sat 3:00 PM EDT
  });

  it("Sunday is weekend research all day, and tells the user to confirm after Monday 10:30 AM", () => {
    expect(phase("2026-10-18T13:00:00Z")).toBe("WEEKEND_RESEARCH"); // Sun 9:00 AM EDT
    expect(scannerTimingGuide(new Date("2026-10-18T13:00:00Z")).detail).toContain("10:30 AM ET");
  });

  it("walks a normal Monday: pre-market -> opening settle -> entry window -> midday -> position check -> after close", () => {
    expect(phase("2026-10-19T12:00:00Z")).toBe("PREMARKET"); // 8:00 AM EDT
    expect(phase("2026-10-19T13:45:00Z")).toBe("OPENING_SETTLE"); // 9:45 AM
    expect(phase("2026-10-19T14:30:00Z")).toBe("ENTRY_WINDOW"); // 10:30 AM - boundary belongs to the entry window
    expect(phase("2026-10-19T15:00:00Z")).toBe("ENTRY_WINDOW"); // 11:00 AM
    expect(phase("2026-10-19T16:30:00Z")).toBe("MIDDAY"); // 12:30 PM - window is half-open
    expect(phase("2026-10-19T19:30:00Z")).toBe("POSITION_CHECK"); // 3:30 PM
    expect(phase("2026-10-19T20:00:00Z")).toBe("AFTER_CLOSE"); // 4:00 PM
  });

  it("Tuesday late morning is NOT the entry window (the guide is Monday-centric by design)", () => {
    expect(phase("2026-10-20T15:00:00Z")).toBe("MIDDAY"); // Tue 11:00 AM
    expect(scannerTimingGuide(new Date("2026-10-20T15:00:00Z")).headline).toMatch(/Mid-week/);
  });

  it("Friday: roll call in the afternoon, then points to Saturday afternoon for new research", () => {
    const afternoon = scannerTimingGuide(new Date("2026-10-23T19:30:00Z")); // Fri 3:30 PM EDT
    expect(afternoon.phase).toBe("POSITION_CHECK");
    expect(afternoon.headline).toMatch(/roll call/i);
    const evening = scannerTimingGuide(new Date("2026-10-23T21:00:00Z")); // Fri 5:00 PM EDT
    expect(evening.phase).toBe("AFTER_CLOSE");
    expect(evening.detail).toMatch(/Saturday/);
  });

  it("an NYSE holiday on a weekday reads as market closed (Thanksgiving 2026)", () => {
    expect(phase("2026-11-26T16:00:00Z")).toBe("MARKET_HOLIDAY"); // Thu Nov 26, 11:00 AM EST
  });

  it("is DST-safe: the same Eastern wall-clock time gives the same phase in summer and winter", () => {
    expect(phase("2026-10-19T14:45:00Z")).toBe("ENTRY_WINDOW"); // Mon 10:45 AM EDT (UTC-4)
    expect(phase("2026-12-07T15:45:00Z")).toBe("ENTRY_WINDOW"); // Mon 10:45 AM EST (UTC-5)
    expect(phase("2026-12-07T14:45:00Z")).toBe("OPENING_SETTLE"); // Mon 9:45 AM EST
  });

  it("never reads like an instruction to trade", () => {
    const samples = ["2026-10-17T19:00:00Z", "2026-10-19T12:00:00Z", "2026-10-19T15:00:00Z", "2026-10-23T19:30:00Z"];
    for (const iso of samples) {
      const text = JSON.stringify(scannerTimingGuide(new Date(iso))).toLowerCase();
      expect(text).not.toMatch(/\b(buy now|sell now|place (an )?order|you should (buy|sell))\b/);
    }
  });
});

describe("technicalReadyHint (when will fresh data be ready?)", () => {
  const hint = (iso: string) => technicalReadyHint(new Date(iso));

  it("the exact case from Matt's screenshot: a scan at 1:31 AM ET on a weekday points to the morning preparation", () => {
    const text = hint("2026-10-15T05:31:00Z"); // Thu 1:31 AM EDT
    expect(text).toMatch(/5:45 AM ET/);
    expect(text).toMatch(/9:15 AM ET/);
  });

  it("while preparation is running it says so, and gives the finish time", () => {
    expect(hint("2026-10-15T11:00:00Z")).toMatch(/being prepared right now.*9:15 AM ET/); // 7:00 AM EDT
  });

  it("Saturday: waits for noon ET, not 9:15", () => {
    expect(hint("2026-10-17T08:00:00Z")).toMatch(/5:45 AM ET today.*noon ET/); // Sat 4:00 AM EDT
    expect(hint("2026-10-17T14:00:00Z")).toMatch(/being prepared right now.*noon ET/); // Sat 10:00 AM EDT
  });

  it("after the window it does NOT promise data will arrive - it says the job may have failed", () => {
    expect(hint("2026-10-15T15:00:00Z")).toMatch(/may have failed/); // Thu 11:00 AM EDT
    expect(hint("2026-10-17T18:00:00Z")).toMatch(/may have failed/); // Sat 2:00 PM EDT
    expect(hint("2026-10-18T15:00:00Z")).toMatch(/may have failed/); // Sunday
  });

  it("is DST-safe", () => {
    expect(hint("2026-12-08T11:00:00Z")).toMatch(/being prepared right now/); // Tue 6:00 AM EST (UTC-5)
  });
});
