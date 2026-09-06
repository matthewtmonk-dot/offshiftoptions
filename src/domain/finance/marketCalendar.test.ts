import { describe, expect, it } from "vitest";
import { isNyseMarketDay, nextNyseMarketDay } from "./marketCalendar";

function utc(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month - 1, day));
}

function key(date: Date) {
  return date.toISOString().slice(0, 10);
}

describe("nextNyseMarketDay", () => {
  it("Sep 4 2026 (Friday) expiration -> next market day is Tue Sep 8 2026, skipping the Labor Day weekend", () => {
    // Sep 5/6 = weekend, Sep 7 = Labor Day (1st Monday of September).
    expect(key(nextNyseMarketDay(utc(2026, 9, 4)))).toBe("2026-09-08");
  });

  it("skips a plain weekend with no holiday involved", () => {
    // Fri Jan 2 2026 -> next market day Mon Jan 5 2026.
    expect(key(nextNyseMarketDay(utc(2026, 1, 2)))).toBe("2026-01-05");
  });
});

describe("isNyseMarketDay - named holidays", () => {
  it("Labor Day 2026 (Mon Sep 7) is closed", () => {
    expect(isNyseMarketDay(utc(2026, 9, 7))).toBe(false);
  });

  it("New Year's Day 2026 (Thu Jan 1) is closed", () => {
    expect(isNyseMarketDay(utc(2026, 1, 1))).toBe(false);
  });

  it("MLK Day 2026 (3rd Monday of January = Jan 19) is closed", () => {
    expect(isNyseMarketDay(utc(2026, 1, 19))).toBe(false);
  });

  it("Presidents Day 2026 (3rd Monday of February = Feb 16) is closed", () => {
    expect(isNyseMarketDay(utc(2026, 2, 16))).toBe(false);
  });

  it("Good Friday 2026 (Apr 3, two days before Easter Sunday Apr 5) is closed", () => {
    expect(isNyseMarketDay(utc(2026, 4, 3))).toBe(false);
    expect(isNyseMarketDay(utc(2026, 4, 2))).toBe(true); // the Thursday before is a normal trading day
  });

  it("Memorial Day 2026 (last Monday of May = May 25) is closed", () => {
    expect(isNyseMarketDay(utc(2026, 5, 25))).toBe(false);
  });

  it("Juneteenth 2026 (Fri Jun 19) is closed", () => {
    expect(isNyseMarketDay(utc(2026, 6, 19))).toBe(false);
  });

  it("Juneteenth is not retroactively closed before NYSE began observing it in 2022", () => {
    // Jun 19, 2020 was a Friday; NYSE was open (observance started 2022).
    expect(isNyseMarketDay(utc(2020, 6, 19))).toBe(true);
  });

  it("Independence Day 2026 (Sat Jul 4) is observed Friday Jul 3", () => {
    expect(isNyseMarketDay(utc(2026, 7, 4))).toBe(false); // weekend anyway
    expect(isNyseMarketDay(utc(2026, 7, 3))).toBe(false); // observed
  });

  it("Thanksgiving 2026 (4th Thursday of November = Nov 26) is closed", () => {
    expect(isNyseMarketDay(utc(2026, 11, 26))).toBe(false);
  });

  it("Christmas 2026 (Fri Dec 25) is closed", () => {
    expect(isNyseMarketDay(utc(2026, 12, 25))).toBe(false);
  });

  it("Christmas 2027 (Sat Dec 25) is observed Friday Dec 24", () => {
    expect(isNyseMarketDay(utc(2027, 12, 24))).toBe(false);
  });

  it("New Year's Day 2022 (Sat Jan 1) was observed Friday Dec 31 2021 - the cross-year-boundary case", () => {
    expect(isNyseMarketDay(utc(2021, 12, 31))).toBe(false);
  });

  it("an ordinary midweek trading day is open", () => {
    expect(isNyseMarketDay(utc(2026, 3, 11))).toBe(true);
  });
});
