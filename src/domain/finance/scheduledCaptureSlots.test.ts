import { describe, expect, it } from "vitest";
import { dueCaptureSlots, FINAL_SLOT_MINUTE_ET, OPENING_SLOT_MINUTE_ET } from "./scheduledCaptureSlots";

// 2026-10-07 is a Wednesday, an ordinary NYSE trading day in EDT (UTC-4, DST active - DST ends
// 2026-11-01). 2026-11-02 is a Monday in EST (UTC-5, after the fall-back transition).
const WEDNESDAY_EDT = "2026-10-07";
const MONDAY_EST = "2026-11-02";

function et(dateStr: string, hour: number, minute: number, offsetHours: number): Date {
  // Builds a UTC instant for a given ET wall-clock time using an EXPLICITLY supplied offset
  // (-4 EDT / -5 EST) - independent of the module under test's own DST conversion, so these tests
  // don't just check the function against itself.
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, hour - offsetHours, minute));
}

describe("dueCaptureSlots - weekday/weekend/holiday gating", () => {
  it("OPENING is due at exactly 9:35 AM ET on an ordinary trading day", () => {
    const now = et(WEDNESDAY_EDT, 9, 35, -4);
    const due = dueCaptureSlots(now);
    expect(due).toHaveLength(1);
    expect(due[0]!.slot).toBe("OPENING");
    expect(due[0]!.sessionDate).toBe(WEDNESDAY_EDT);
  });

  it("nothing is due one minute before the OPENING target", () => {
    const now = et(WEDNESDAY_EDT, 9, 34, -4);
    expect(dueCaptureSlots(now)).toHaveLength(0);
  });

  it("OPENING is still due up to (but not including) the end of its 10-minute window", () => {
    const now = et(WEDNESDAY_EDT, 9, 44, -4); // 9 minutes after 9:35
    const due = dueCaptureSlots(now);
    expect(due).toHaveLength(1);
    expect(due[0]!.slot).toBe("OPENING");
  });

  it("OPENING is no longer due once its 10-minute window has fully elapsed", () => {
    const now = et(WEDNESDAY_EDT, 9, 45, -4); // exactly 10 minutes after 9:35
    const due = dueCaptureSlots(now);
    expect(due.some((d) => d.slot === "OPENING")).toBe(false);
  });

  it("the first BASELINE slot (9:50 AM ET) is due at its own window, not before", () => {
    expect(dueCaptureSlots(et(WEDNESDAY_EDT, 9, 49, -4)).some((d) => d.slot === "BASELINE")).toBe(false);
    const due = dueCaptureSlots(et(WEDNESDAY_EDT, 9, 50, -4));
    expect(due).toHaveLength(1);
    expect(due[0]!.slot).toBe("BASELINE");
  });

  it("FINAL is due at exactly 3:55 PM ET", () => {
    const due = dueCaptureSlots(et(WEDNESDAY_EDT, 15, 55, -4));
    expect(due).toHaveLength(1);
    expect(due[0]!.slot).toBe("FINAL");
  });

  // FINAL's own target (3:55 PM) is only 5 minutes after the last BASELINE target (3:50 PM) -
  // closer together than the 10-minute due window, so their windows genuinely overlap for a few
  // minutes. Only the more recent (more urgent) one should ever be reported due at once.
  it("when FINAL's window overlaps the last BASELINE's still-open window, only FINAL (the more recent target) is reported due - never both", () => {
    const due = dueCaptureSlots(et(WEDNESDAY_EDT, 15, 55, -4)); // exactly FINAL's target, last BASELINE's window [15:50, 16:00) is also still open
    expect(due).toHaveLength(1);
    expect(due[0]!.slot).toBe("FINAL");
  });

  it("nothing is due well after the FINAL window (e.g. 5:00 PM ET)", () => {
    expect(dueCaptureSlots(et(WEDNESDAY_EDT, 17, 0, -4))).toHaveLength(0);
  });

  it("nothing is due well before the OPENING window (e.g. 6:00 AM ET)", () => {
    expect(dueCaptureSlots(et(WEDNESDAY_EDT, 6, 0, -4))).toHaveLength(0);
  });

  it("weekend: zero slots due on a Saturday, no matter the time of day", () => {
    expect(dueCaptureSlots(et("2026-10-10", 10, 0, -4))).toHaveLength(0); // Saturday
    expect(dueCaptureSlots(et("2026-10-11", 10, 0, -4))).toHaveLength(0); // Sunday
  });

  it("NYSE holiday: zero slots due on Labor Day (first Monday of September)", () => {
    expect(dueCaptureSlots(et("2026-09-07", 10, 0, -4))).toHaveLength(0);
  });
});

describe("dueCaptureSlots - DST correctness", () => {
  it("OPENING's dueAt resolves to the correct UTC instant in EDT (UTC-4, October)", () => {
    const due = dueCaptureSlots(et(WEDNESDAY_EDT, 9, 35, -4));
    expect(due[0]!.dueAt).toEqual(et(WEDNESDAY_EDT, 9, 35, -4));
    expect(due[0]!.dueAt.toISOString()).toBe("2026-10-07T13:35:00.000Z");
  });

  it("OPENING's dueAt resolves to the correct UTC instant in EST (UTC-5, after the fall-back transition)", () => {
    const due = dueCaptureSlots(et(MONDAY_EST, 9, 35, -5));
    expect(due[0]!.dueAt).toEqual(et(MONDAY_EST, 9, 35, -5));
    expect(due[0]!.dueAt.toISOString()).toBe("2026-11-02T14:35:00.000Z");
  });

  it("FINAL's dueAt is correct across the DST boundary too", () => {
    const edtFinal = dueCaptureSlots(et(WEDNESDAY_EDT, 15, 55, -4));
    expect(edtFinal[0]!.dueAt.toISOString()).toBe("2026-10-07T19:55:00.000Z");
    const estFinal = dueCaptureSlots(et(MONDAY_EST, 15, 55, -5));
    expect(estFinal[0]!.dueAt.toISOString()).toBe("2026-11-02T20:55:00.000Z");
  });
});

describe("dueCaptureSlots - missed slot is never backdated", () => {
  it("the same slot's dueAt is IDENTICAL regardless of exactly when within its due window the heartbeat actually checks", () => {
    const earlyCheck = dueCaptureSlots(et(WEDNESDAY_EDT, 9, 35, -4));
    const lateCheck = dueCaptureSlots(et(WEDNESDAY_EDT, 9, 43, -4)); // 8 minutes later, same window
    expect(earlyCheck[0]!.dueAt).toEqual(lateCheck[0]!.dueAt);
    // dueAt always reflects the slot's ORIGINAL target instant (9:35), never the later check time.
    expect(earlyCheck[0]!.dueAt.toISOString()).toBe("2026-10-07T13:35:00.000Z");
    expect(lateCheck[0]!.dueAt.toISOString()).toBe("2026-10-07T13:35:00.000Z");
  });

  it("a slot whose window has fully elapsed (a long-missed heartbeat) simply stops being reported as due - never silently reinterpreted as due 'now'", () => {
    const longAfter = dueCaptureSlots(et(WEDNESDAY_EDT, 11, 0, -4)); // over an hour after OPENING
    expect(longAfter.some((d) => d.slot === "OPENING")).toBe(false);
  });
});

describe("dueCaptureSlots - slot boundary constants are internally consistent", () => {
  it("OPENING and FINAL constants match the documented 9:35 AM / 3:55 PM ET targets", () => {
    expect(OPENING_SLOT_MINUTE_ET).toBe(9 * 60 + 35);
    expect(FINAL_SLOT_MINUTE_ET).toBe(15 * 60 + 55);
  });

  it("no two distinct slots ever share the exact same target minute (OPENING/BASELINE/FINAL never collide)", () => {
    // Sweep every minute of a trading day and collect which slot kind(s) are reported due at the
    // instant each one STARTS being due - each starting minute should produce exactly one slot.
    const seenStartMinutes = new Set<number>();
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      const hour = Math.floor(minute / 60);
      const min = minute % 60;
      const due = dueCaptureSlots(et(WEDNESDAY_EDT, hour, min, -4));
      if (due.length > 0 && !seenStartMinutes.has(minute - 1)) {
        // first minute this particular due set appeared - record it once
        expect(due).toHaveLength(1);
      }
      if (due.length > 0) seenStartMinutes.add(minute);
    }
  });
});
