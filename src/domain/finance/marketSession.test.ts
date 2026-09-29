import { describe, expect, it } from "vitest";
import type { EquityMarketSessionEvidence } from "@/providers/market-data/types";
import {
  daysBetweenCalendarDates,
  daysToExpiration,
  expirationCalendarDate,
  isWithinRegularSession,
  nyCalendarDateOf,
  regularSessionCloseInstant,
  regularSessionIntervalContaining,
} from "./marketSession";

function ordinaryDaySessionEvidence(nyDate: string, offset = "-04:00"): EquityMarketSessionEvidence {
  return {
    status: "AVAILABLE",
    requestedDate: nyDate,
    returnedDate: nyDate,
    marketType: "EQUITY",
    product: "EQ",
    isOpen: true,
    regularMarketIntervals: [{ start: new Date(`${nyDate}T09:30:00${offset}`), end: new Date(`${nyDate}T16:00:00${offset}`) }],
  };
}

function earlyCloseSessionEvidence(nyDate: string, offset = "-05:00"): EquityMarketSessionEvidence {
  return {
    status: "AVAILABLE",
    requestedDate: nyDate,
    returnedDate: nyDate,
    marketType: "EQUITY",
    product: "EQ",
    isOpen: true,
    regularMarketIntervals: [{ start: new Date(`${nyDate}T09:30:00${offset}`), end: new Date(`${nyDate}T13:00:00${offset}`) }],
  };
}

describe("nyCalendarDateOf", () => {
  it("returns the NY wall-clock date, not the UTC date, near the UTC midnight boundary", () => {
    // 2026-03-10T02:30:00Z is still 2026-03-09 21:30 in New York (EST, UTC-5 before DST starts).
    expect(nyCalendarDateOf(new Date("2026-03-10T02:30:00Z"))).toBe("2026-03-09");
  });

  it("reflects the DST-shifted offset correctly on both sides of a spring-forward transition", () => {
    // 2026-03-08 is the DST transition Sunday; 07:00Z on 2026-03-09 is 03:00 EDT (UTC-4).
    expect(nyCalendarDateOf(new Date("2026-03-09T07:00:00Z"))).toBe("2026-03-09");
    // Before the transition, 07:00Z on 2026-03-01 is 02:00 EST (UTC-5) - still the same NY date.
    expect(nyCalendarDateOf(new Date("2026-03-01T07:00:00Z"))).toBe("2026-03-01");
  });

  it("returns the requested NY date for an ordinary midday instant", () => {
    expect(nyCalendarDateOf(new Date("2026-06-15T18:00:00Z"))).toBe("2026-06-15");
  });
});

describe("expirationCalendarDate", () => {
  it("reads the stored UTC-midnight date back via UTC components, never shifting to the prior evening", () => {
    expect(expirationCalendarDate(new Date("2026-10-02T00:00:00.000Z"))).toBe("2026-10-02");
  });
});

describe("daysBetweenCalendarDates / daysToExpiration", () => {
  it("returns 0 for the same calendar date", () => {
    expect(daysBetweenCalendarDates("2026-10-02", "2026-10-02")).toBe(0);
  });

  it("returns 1 for the very next calendar date", () => {
    expect(daysBetweenCalendarDates("2026-10-02", "2026-10-03")).toBe(1);
  });

  it("counts weekend days like any other day (no business-day skipping)", () => {
    // 2026-10-02 is a Friday; 2026-10-05 is the following Monday - 3 calendar days apart.
    expect(daysBetweenCalendarDates("2026-10-02", "2026-10-05")).toBe(3);
  });

  it("is negative once the target date is in the past relative to the origin date", () => {
    expect(daysBetweenCalendarDates("2026-10-02", "2026-09-30")).toBe(-2);
  });

  it("daysToExpiration treats today as 0 and tomorrow as 1 in NY time", () => {
    const now = new Date("2026-10-02T18:00:00Z"); // 2:00 PM ET
    expect(daysToExpiration(new Date("2026-10-02T00:00:00Z"), now)).toBe(0);
    expect(daysToExpiration(new Date("2026-10-03T00:00:00Z"), now)).toBe(1);
  });

  it("daysToExpiration is negative for an already-past stored expiration", () => {
    const now = new Date("2026-10-02T18:00:00Z");
    expect(daysToExpiration(new Date("2026-09-25T00:00:00Z"), now)).toBe(-7);
  });
});

describe("regularSessionIntervalContaining / isWithinRegularSession", () => {
  it("finds the containing interval for an ordinary 9:30-16:00 session", () => {
    const evidence = ordinaryDaySessionEvidence("2026-06-15");
    const noon = new Date("2026-06-15T16:00:00Z"); // 12:00 PM ET
    expect(isWithinRegularSession(evidence, noon)).toBe(true);
    expect(regularSessionIntervalContaining(evidence, noon)).not.toBeNull();
  });

  it("treats the interval start as inclusive (half-open)", () => {
    const evidence = ordinaryDaySessionEvidence("2026-06-15");
    const openInstant = new Date("2026-06-15T09:30:00-04:00");
    expect(isWithinRegularSession(evidence, openInstant)).toBe(true);
  });

  it("treats the interval end as exclusive (half-open) - the closing instant itself is outside the session", () => {
    const evidence = ordinaryDaySessionEvidence("2026-06-15");
    const closeInstant = new Date("2026-06-15T16:00:00-04:00");
    expect(isWithinRegularSession(evidence, closeInstant)).toBe(false);
  });

  it("respects an early-close session's shortened end boundary", () => {
    const evidence = earlyCloseSessionEvidence("2026-11-27");
    const at1259 = new Date("2026-11-27T12:59:00-05:00");
    const at1300 = new Date("2026-11-27T13:00:00-05:00");
    expect(isWithinRegularSession(evidence, at1259)).toBe(true);
    expect(isWithinRegularSession(evidence, at1300)).toBe(false);
  });

  it("returns false for any instant when evidence is UNAVAILABLE", () => {
    const evidence: EquityMarketSessionEvidence = { status: "UNAVAILABLE", reason: "provider error" };
    expect(isWithinRegularSession(evidence, new Date("2026-06-15T16:00:00Z"))).toBe(false);
    expect(regularSessionIntervalContaining(evidence, new Date("2026-06-15T16:00:00Z"))).toBeNull();
  });

  it("returns false for a weekend/holiday day with no regular-market intervals at all", () => {
    const evidence: EquityMarketSessionEvidence = {
      status: "AVAILABLE",
      requestedDate: "2026-06-13",
      returnedDate: "2026-06-13",
      marketType: "EQUITY",
      product: "EQ",
      isOpen: false,
      regularMarketIntervals: [],
    };
    expect(isWithinRegularSession(evidence, new Date("2026-06-13T16:00:00Z"))).toBe(false);
  });

  it("returns false for an instant before the session opens (premarket)", () => {
    const evidence = ordinaryDaySessionEvidence("2026-06-15");
    const premarket = new Date("2026-06-15T08:00:00-04:00");
    expect(isWithinRegularSession(evidence, premarket)).toBe(false);
  });

  it("returns false for an instant after the session closes (after-hours)", () => {
    const evidence = ordinaryDaySessionEvidence("2026-06-15");
    const afterHours = new Date("2026-06-15T20:00:00-04:00");
    expect(isWithinRegularSession(evidence, afterHours)).toBe(false);
  });
});

describe("regularSessionCloseInstant", () => {
  it("returns the single interval's end for an ordinary day", () => {
    const evidence = ordinaryDaySessionEvidence("2026-06-15");
    expect(regularSessionCloseInstant(evidence)?.toISOString()).toBe(new Date("2026-06-15T16:00:00-04:00").toISOString());
  });

  it("returns the latest end instant across multiple regular-market intervals", () => {
    const evidence: EquityMarketSessionEvidence = {
      status: "AVAILABLE",
      requestedDate: "2026-06-15",
      returnedDate: "2026-06-15",
      marketType: "EQUITY",
      product: "EQ",
      isOpen: true,
      regularMarketIntervals: [
        { start: new Date("2026-06-15T09:30:00-04:00"), end: new Date("2026-06-15T12:00:00-04:00") },
        { start: new Date("2026-06-15T12:00:00-04:00"), end: new Date("2026-06-15T16:00:00-04:00") },
      ],
    };
    expect(regularSessionCloseInstant(evidence)?.toISOString()).toBe(new Date("2026-06-15T16:00:00-04:00").toISOString());
  });

  it("returns null when evidence is UNAVAILABLE", () => {
    expect(regularSessionCloseInstant({ status: "UNAVAILABLE", reason: "provider error" })).toBeNull();
  });

  it("returns null when evidence is AVAILABLE but reports no regular-market intervals (a genuine holiday)", () => {
    const evidence: EquityMarketSessionEvidence = {
      status: "AVAILABLE",
      requestedDate: "2026-12-25",
      returnedDate: "2026-12-25",
      marketType: "EQUITY",
      product: "EQ",
      isOpen: false,
      regularMarketIntervals: [],
    };
    expect(regularSessionCloseInstant(evidence)).toBeNull();
  });
});
