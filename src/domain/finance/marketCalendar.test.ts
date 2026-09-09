import { describe, expect, it } from "vitest";
import { isNyseMarketDay, nextNyseMarketDay, previousNyseMarketDay } from "./marketCalendar";

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

describe("previousNyseMarketDay", () => {
  it("Mon Sep 7 2026 (Labor Day) -> previous market day is Fri Sep 4 2026, skipping the weekend and the holiday itself", () => {
    expect(key(previousNyseMarketDay(utc(2026, 9, 7)))).toBe("2026-09-04");
  });

  it("Mon Jan 5 2026 -> previous market day is Fri Jan 2 2026, skipping a plain weekend", () => {
    expect(key(previousNyseMarketDay(utc(2026, 1, 5)))).toBe("2026-01-02");
  });

  it("is the exact inverse of nextNyseMarketDay across a holiday weekend", () => {
    const afterHoliday = nextNyseMarketDay(utc(2026, 9, 4));
    expect(key(previousNyseMarketDay(afterHoliday))).toBe("2026-09-04");
  });
});

describe("previousNyseMarketDay - real production timeline (2026-09-08/09 readiness investigation)", () => {
  // Real production sequence Matt reported: technical preparation ran manually at ~9:32 PM ET on
  // Tue Sep 8, 2026 (a real NYSE trading day); the live scan that later showed technicalReady=0
  // ran at ~1:36 AM ET on Wed Sep 9, 2026 - about 4 hours later, with no NYSE session in between.
  // September 2026 is EDT (UTC-4). These fixtures use explicit -04:00 offsets rather than
  // relying on the test runner's local timezone.
  const PREP_TIME_SEP8_932PM_ET = new Date("2026-09-08T21:32:00-04:00"); // = 2026-09-09T01:32:00Z
  const SCAN_TIME_SEP9_136AM_ET = new Date("2026-09-09T01:36:00-04:00"); // = 2026-09-09T05:36:00Z

  it("both real-world instants fall on the same UTC calendar date (Sep 9), despite being 'Sep 8 evening' and 'Sep 9 early morning' in America/New_York", () => {
    expect(PREP_TIME_SEP8_932PM_ET.toISOString().slice(0, 10)).toBe("2026-09-09");
    expect(SCAN_TIME_SEP9_136AM_ET.toISOString().slice(0, 10)).toBe("2026-09-09");
  });

  it("required market date (previousNyseMarketDay) at the Sep 8 9:32 PM ET prep run is Sep 8, 2026", () => {
    expect(key(previousNyseMarketDay(PREP_TIME_SEP8_932PM_ET))).toBe("2026-09-08");
  });

  it("required market date (previousNyseMarketDay) at the Sep 9 1:36 AM ET scan run is ALSO Sep 8, 2026 - identical to the prep run", () => {
    expect(key(previousNyseMarketDay(SCAN_TIME_SEP9_136AM_ET))).toBe("2026-09-08");
  });

  it("proves the 'a trading day elapsed' explanation does not hold for this exact ~4-hour window: the required freshness date never advances between the two real timestamps", () => {
    expect(key(previousNyseMarketDay(PREP_TIME_SEP8_932PM_ET))).toBe(key(previousNyseMarketDay(SCAN_TIME_SEP9_136AM_ET)));
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
