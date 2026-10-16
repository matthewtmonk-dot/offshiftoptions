import { describe, expect, it } from "vitest";
import {
  describePeriodDays,
  formatWeeklyPercent,
  weeklyPaceFromGain,
  weeklyPaceFromPercent,
  weeklyPaceTone,
} from "./weeklyPace";

describe("weeklyPaceFromPercent", () => {
  it("divides the total percent by elapsed weeks (plain average, not compounded)", () => {
    expect(weeklyPaceFromPercent(4, 14)).toEqual({ totalPercent: 4, weeklyPercent: 2, days: 14, early: false });
    expect(weeklyPaceFromPercent(3, 21)?.weeklyPercent).toBe(1);
  });
  it("flags a period under the threshold as early", () => {
    expect(weeklyPaceFromPercent(2, 4)?.early).toBe(true);
    expect(weeklyPaceFromPercent(2, 7)?.early).toBe(false);
    expect(weeklyPaceFromPercent(2, 10, 14)?.early).toBe(true);
  });
  it("is unavailable for missing or non-positive inputs", () => {
    expect(weeklyPaceFromPercent(null, 7)).toBeNull();
    expect(weeklyPaceFromPercent(2, null)).toBeNull();
    expect(weeklyPaceFromPercent(2, 0)).toBeNull();
    expect(weeklyPaceFromPercent(Number.NaN, 7)).toBeNull();
  });
  it("keeps a negative return negative", () => {
    expect(weeklyPaceFromPercent(-3, 14)?.weeklyPercent).toBe(-1.5);
  });
});

describe("weeklyPaceFromGain", () => {
  it("CORZ-style example: $34.02 collected on $1,450 secured over 4 days", () => {
    const pace = weeklyPaceFromGain(34.02, 1450, 4);
    expect(pace?.totalPercent).toBe(2.35);
    expect(pace?.weeklyPercent).toBe(4.11);
    expect(pace?.early).toBe(true);
  });
  it("needs positive capital set aside", () => {
    expect(weeklyPaceFromGain(10, 0, 7)).toBeNull();
    expect(weeklyPaceFromGain(10, null, 7)).toBeNull();
    expect(weeklyPaceFromGain(null, 100, 7)).toBeNull();
  });
});

describe("tone and formatting", () => {
  it("green at or above the reference, amber between zero and it, red below zero", () => {
    expect(weeklyPaceTone(1)).toBe("good");
    expect(weeklyPaceTone(0.4)).toBe("warn");
    expect(weeklyPaceTone(0)).toBe("warn");
    expect(weeklyPaceTone(-0.1)).toBe("bad");
  });
  it("formats with sign and unit", () => {
    expect(formatWeeklyPercent(1.234)).toBe("+1.23% / week");
    expect(formatWeeklyPercent(-0.5)).toBe("-0.50% / week");
    expect(describePeriodDays(1)).toBe("1 day");
    expect(describePeriodDays(9)).toBe("9 days");
  });
});
