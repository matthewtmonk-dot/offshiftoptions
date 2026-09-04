import { describe, expect, it } from "vitest";
import { getNextLstCheckpointLabel } from "./lstCheckpoint";

// All dates below are Sept 2026, EDT (UTC-4) in effect for the America/New_York checks.

describe("getNextLstCheckpointLabel", () => {
  it("shows the Monday entry-review-begins message before 10:30 AM ET on Monday", () => {
    // Monday 2026-09-07, 13:00 UTC = 9:00 AM ET.
    expect(getNextLstCheckpointLabel(new Date("2026-09-07T13:00:00.000Z"))).toBe(
      "Entry review begins around 10:30 AM ET",
    );
  });

  it("shows the Monday entry window from 10:30 AM to just before 12:30 PM ET", () => {
    // Monday 14:30 UTC = 10:30 AM ET (boundary, inclusive).
    expect(getNextLstCheckpointLabel(new Date("2026-09-07T14:30:00.000Z"))).toBe(
      "Monday entry window · setups still must qualify",
    );
    // Monday 16:29 UTC = 12:29 PM ET (still inside the window).
    expect(getNextLstCheckpointLabel(new Date("2026-09-07T16:29:00.000Z"))).toBe(
      "Monday entry window · setups still must qualify",
    );
  });

  it("shows the next-position-check message from 12:30 PM ET Monday through the rest of Mon-Thu", () => {
    // Monday 16:30 UTC = 12:30 PM ET (boundary - window has ended).
    expect(getNextLstCheckpointLabel(new Date("2026-09-07T16:30:00.000Z"))).toBe(
      "Next position check · 3:00 PM ET",
    );
    // Tuesday 2026-09-08, any time of day.
    expect(getNextLstCheckpointLabel(new Date("2026-09-08T11:00:00.000Z"))).toBe(
      "Next position check · 3:00 PM ET",
    );
    expect(getNextLstCheckpointLabel(new Date("2026-09-08T23:00:00.000Z"))).toBe(
      "Next position check · 3:00 PM ET",
    );
    // Wednesday 2026-09-09.
    expect(getNextLstCheckpointLabel(new Date("2026-09-09T15:00:00.000Z"))).toBe(
      "Next position check · 3:00 PM ET",
    );
    // Thursday 2026-09-10, before 3pm ET (18:59 UTC = 2:59 PM ET).
    expect(getNextLstCheckpointLabel(new Date("2026-09-10T18:59:00.000Z"))).toBe(
      "Next position check · 3:00 PM ET",
    );
  });

  it("switches to the Friday Roll Call message once Thursday's 3pm ET checkpoint has passed", () => {
    // Thursday 19:00 UTC = 3:00 PM ET (boundary).
    expect(getNextLstCheckpointLabel(new Date("2026-09-10T19:00:00.000Z"))).toBe(
      "Friday Roll Call · 3:00 PM ET",
    );
    // Thursday 23:00 UTC = 7:00 PM ET (still Thursday evening).
    expect(getNextLstCheckpointLabel(new Date("2026-09-10T23:00:00.000Z"))).toBe(
      "Friday Roll Call · 3:00 PM ET",
    );
  });

  it("shows the Friday Roll Call message all of Friday before 3pm ET", () => {
    // Friday 2026-09-11, 12:00 UTC = 8:00 AM ET.
    expect(getNextLstCheckpointLabel(new Date("2026-09-11T12:00:00.000Z"))).toBe(
      "Friday Roll Call · 3:00 PM ET",
    );
    // Friday 18:59 UTC = 2:59 PM ET.
    expect(getNextLstCheckpointLabel(new Date("2026-09-11T18:59:00.000Z"))).toBe(
      "Friday Roll Call · 3:00 PM ET",
    );
  });

  it("shows the next-Monday-entry-review message at/after Friday 3pm ET and through the weekend", () => {
    // Friday 19:00 UTC = 3:00 PM ET (boundary).
    expect(getNextLstCheckpointLabel(new Date("2026-09-11T19:00:00.000Z"))).toBe(
      "Next entry review · Monday 10:30 AM ET",
    );
    // Saturday.
    expect(getNextLstCheckpointLabel(new Date("2026-09-12T15:00:00.000Z"))).toBe(
      "Next entry review · Monday 10:30 AM ET",
    );
    // Sunday.
    expect(getNextLstCheckpointLabel(new Date("2026-09-13T15:00:00.000Z"))).toBe(
      "Next entry review · Monday 10:30 AM ET",
    );
  });

  it("is DST-safe across the America/New_York EDT/EST boundary (November 2026)", () => {
    // 2026-11-01 is a Sunday; DST ends 2026-11-01 at 2am local (falls back to EST, UTC-5).
    // A Monday after the fallback: 2026-11-02, 15:29 UTC = 10:29 AM EST - still before window.
    expect(getNextLstCheckpointLabel(new Date("2026-11-02T15:29:00.000Z"))).toBe(
      "Entry review begins around 10:30 AM ET",
    );
    // 2026-11-02, 15:30 UTC = 10:30 AM EST - window begins.
    expect(getNextLstCheckpointLabel(new Date("2026-11-02T15:30:00.000Z"))).toBe(
      "Monday entry window · setups still must qualify",
    );
  });
});
