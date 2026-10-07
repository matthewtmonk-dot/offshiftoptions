import { describe, expect, it } from "vitest";
import { classifyMarkFreshness, isNyseMarketDay, isRecentRetrieval, nextNyseMarketDay, previousNyseMarketDay } from "./marketCalendar";

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

describe("previousNyseMarketDay - weekend scanner readiness (Fri Sep 11 / Sat Sep 12 / Sun Sep 13 / Mon Sep 14, 2026)", () => {
  // Real Saturday Sep 12, 2026 comparison against an external scanner - see PROJECT_HANDOFF.md's
  // weekend-coverage investigation. Confirms, with the EXISTING unmodified previousNyseMarketDay,
  // that the required technical market date is already correct across the whole weekend - the
  // real bug is a SCHEDULING gap (no invocation ever runs Sat/Sun to write Sep 11 data), never a
  // calendar-math bug. September 2026 is EDT (UTC-4).
  it("Friday Sep 11 morning (before that day's own close) requires Thursday Sep 10", () => {
    expect(key(previousNyseMarketDay(new Date("2026-09-11T06:00:00-04:00")))).toBe("2026-09-10");
  });

  it("Friday Sep 11 after close (evening) requires Friday Sep 11 itself", () => {
    expect(key(previousNyseMarketDay(new Date("2026-09-11T21:00:00-04:00")))).toBe("2026-09-11");
  });

  it("Saturday Sep 12 (any time of day) requires Friday Sep 11", () => {
    expect(key(previousNyseMarketDay(new Date("2026-09-12T08:00:00-04:00")))).toBe("2026-09-11");
  });

  it("Sunday Sep 13 (any time of day) STILL requires Friday Sep 11 - the required date does not advance again until Monday's own close", () => {
    expect(key(previousNyseMarketDay(new Date("2026-09-13T12:00:00-04:00")))).toBe("2026-09-11");
  });

  it("Monday Sep 14 premarket (before that day's own close) STILL requires Friday Sep 11 - the weekend never produces a new required date on its own", () => {
    expect(key(previousNyseMarketDay(new Date("2026-09-14T06:00:00-04:00")))).toBe("2026-09-11");
  });

  it("Saturday and Sunday are themselves never NYSE market days - confirms why the existing weekday-only preparation window has no opportunity to run over the weekend", () => {
    expect(isNyseMarketDay(new Date("2026-09-12T12:00:00-04:00"))).toBe(false);
    expect(isNyseMarketDay(new Date("2026-09-13T12:00:00-04:00"))).toBe(false);
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

  it("Saturday New Year's Day is not observed on year-end Friday", () => {
    expect(isNyseMarketDay(utc(2021, 12, 31))).toBe(true);
    expect(isNyseMarketDay(utc(2027, 12, 31))).toBe(true);
  });

  it("an ordinary midweek trading day is open", () => {
    expect(isNyseMarketDay(utc(2026, 3, 11))).toBe(true);
  });
});

describe("classifyMarkFreshness (Ticket 5)", () => {
  const session = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 20));
  // Reuses the Labor Day weekend anchors already established above: Fri Sep 4 2026 is a market
  // day, Sat/Sun Sep 5-6 are weekend, Mon Sep 7 is Labor Day (closed), Tue Sep 8 is the next
  // market day after the long weekend.

  it("MISSING when there is no timestamp at all", () => {
    expect(classifyMarkFreshness(null, session(2026, 9, 8))).toBe("MISSING");
  });

  it("CURRENT_SESSION when captured today and today is a market day", () => {
    expect(classifyMarkFreshness(session(2026, 9, 8), session(2026, 9, 8))).toBe("CURRENT_SESSION");
  });

  it("LAST_SESSION on a weekend, showing Friday's data - never described as live", () => {
    expect(classifyMarkFreshness(session(2026, 9, 4), session(2026, 9, 5))).toBe("LAST_SESSION"); // Saturday, Friday's mark
    expect(classifyMarkFreshness(session(2026, 9, 4), session(2026, 9, 6))).toBe("LAST_SESSION"); // Sunday, Friday's mark
  });

  it("LAST_SESSION on a market holiday, showing the last real session before it", () => {
    expect(classifyMarkFreshness(session(2026, 9, 4), session(2026, 9, 7))).toBe("LAST_SESSION"); // Labor Day, Friday's mark
  });

  it("LAST_SESSION on a market day whose own fresh data hasn't arrived yet, correctly skipping the holiday weekend gap", () => {
    // Tue Sep 8 is a market day; its immediately preceding session is Fri Sep 4 (Labor Day
    // weekend in between), not literally "yesterday."
    expect(classifyMarkFreshness(session(2026, 9, 4), session(2026, 9, 8))).toBe("LAST_SESSION");
  });

  it("STALE once a mark is two or more sessions behind", () => {
    // Wed Sep 9's immediately preceding session is Tue Sep 8 - a mark from Fri Sep 4 is now two
    // sessions old (Sep 4 -> Sep 8 -> Sep 9) and no longer trustworthy as current.
    expect(classifyMarkFreshness(session(2026, 9, 4), session(2026, 9, 9))).toBe("STALE");
  });

  it("rejects future-dated evidence", () => {
    expect(classifyMarkFreshness(session(2026, 9, 9), session(2026, 9, 8))).toBe("STALE");
  });

  it("a non-market-day price timestamp does not prove session provenance", () => {
    expect(classifyMarkFreshness(session(2026, 9, 7), session(2026, 9, 8))).toBe("MISSING"); // Labor Day itself as the asOf date
  });
});

describe("market-date boundaries for valuation timestamps", () => {
  it("Sunday evening ET is not Monday's session even after UTC midnight", () => {
    const now = new Date("2026-09-20T21:00:00-04:00");
    expect(classifyMarkFreshness(new Date("2026-09-18T16:00:00-04:00"), now)).toBe("LAST_SESSION");
    expect(classifyMarkFreshness(now, now)).toBe("MISSING");
  });
  it("UTC midnight does not advance Tuesday evening to Wednesday's session", () => {
    expect(classifyMarkFreshness(new Date("2026-09-21T16:00:00-04:00"), new Date("2026-09-22T21:00:00-04:00"))).toBe("LAST_SESSION");
  });
  it("preserves the last session over a DST weekend", () => {
    expect(classifyMarkFreshness(new Date("2026-10-30T16:00:00-04:00"), new Date("2026-11-01T23:00:00-05:00"))).toBe("LAST_SESSION");
  });
  it("rejects future times within the same date and invalid timestamps", () => {
    const now = new Date("2026-09-21T15:00:00Z");
    expect(classifyMarkFreshness(new Date("2026-09-21T16:00:00Z"), now)).toBe("STALE");
    expect(classifyMarkFreshness(new Date("invalid"), now)).toBe("MISSING");
  });
  it("uses Dec 31 as the valid previous session after a Saturday New Year", () => {
    expect(classifyMarkFreshness(new Date("2027-12-31T21:00:00Z"), new Date("2028-01-03T14:00:00Z"))).toBe("LAST_SESSION");
  });
});

describe("isRecentRetrieval (broker-snapshot retrieval recency, separate from pricing-session freshness)", () => {
  it("accepts a recent weekday retrieval", () => {
    const now = new Date("2026-09-08T20:00:00Z"); // Tuesday, a real trading day
    expect(isRecentRetrieval(now, now)).toBe(true);
  });

  it("accepts a recent weekend retrieval, even though classifyMarkFreshness would call the same instant MISSING", () => {
    const sunday = new Date("2026-09-06T15:00:00Z"); // Sunday - no trading session that day at all
    expect(isRecentRetrieval(sunday, sunday)).toBe(true);
    expect(classifyMarkFreshness(sunday, sunday)).toBe("MISSING"); // confirms the two policies genuinely differ
  });

  it("accepts a Friday retrieval reused over the following weekend", () => {
    const friday = new Date("2026-09-04T20:00:00Z");
    const sunday = new Date("2026-09-06T15:00:00Z");
    expect(isRecentRetrieval(friday, sunday)).toBe(true);
  });

  it("does not treat a fresher weekend retrieval as less acceptable than an older weekday one", () => {
    const friday = new Date("2026-09-04T20:00:00Z");
    const sunday = new Date("2026-09-06T15:00:00Z");
    expect(isRecentRetrieval(sunday, sunday)).toBe(true);
    expect(isRecentRetrieval(friday, sunday)).toBe(true);
  });

  it("rejects a genuinely old retrieval (2+ trading sessions behind), matching classifyMarkFreshness's STALE boundary", () => {
    const now = new Date("2026-09-09T15:00:00Z"); // Wednesday
    const stale = new Date("2026-09-04T20:00:00Z"); // Friday - 2 sessions behind (Fri -> Tue -> Wed)
    expect(isRecentRetrieval(stale, now)).toBe(false);
  });

  it("rejects a future retrieval and invalid timestamps", () => {
    const now = new Date("2026-09-08T20:00:00Z");
    expect(isRecentRetrieval(new Date("2026-09-09T00:00:00Z"), now)).toBe(false);
    expect(isRecentRetrieval(new Date("invalid"), now)).toBe(false);
    expect(isRecentRetrieval(null, now)).toBe(false);
  });

  it("never returns or implies a market-session label - it is a plain boolean", () => {
    const now = new Date("2026-09-08T20:00:00Z");
    expect(typeof isRecentRetrieval(now, now)).toBe("boolean");
  });
});
