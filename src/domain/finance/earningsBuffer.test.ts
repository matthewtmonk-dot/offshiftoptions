import { describe, expect, it } from "vitest";
import {
  DEFAULT_EARNINGS_BUFFER_SETTINGS,
  coveredCallEarningsNote,
  earningsGapAfterExpiry,
  earningsVerifyReason,
  evaluatePutEarningsBuffer,
  parseCalendarDate,
  putEarningsValues,
} from "./earningsBuffer";

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const verdict = (expiration: string, report: string, settings = DEFAULT_EARNINGS_BUFFER_SETTINGS) => evaluatePutEarningsBuffer(d(expiration), d(report), settings);

describe("earningsGapAfterExpiry", () => {
  it("counts earnings-free calendar days and full trading sessions strictly between expiration and the report", () => {
    // Fri Oct 30 2026 expiration -> Tue Nov 3 report: Sat, Sun, Mon between; only Monday is a session.
    expect(earningsGapAfterExpiry(d("2026-10-30"), d("2026-11-03"))).toEqual({ freeDaysAfterExpiry: 3, exitSessions: 1 });
    expect(earningsGapAfterExpiry(d("2026-10-30"), d("2026-10-30")).freeDaysAfterExpiry).toBe(-1);
    expect(earningsGapAfterExpiry(d("2026-10-30"), d("2026-10-28")).freeDaysAfterExpiry).toBe(-3);
    expect(earningsGapAfterExpiry(d("2026-10-30"), d("2026-10-31"))).toEqual({ freeDaysAfterExpiry: 0, exitSessions: 0 });
  });
  it("never reports a negative number of sessions", () => {
    expect(earningsGapAfterExpiry(d("2026-10-30"), d("2026-10-20")).exitSessions).toBe(0);
  });
});

describe("evaluatePutEarningsBuffer (4-calendar-day rule + a full session to exit)", () => {
  it("blocks earnings on or before expiration", () => {
    expect(verdict("2026-10-30", "2026-10-30")).toMatchObject({ status: "BLOCKED", reason: "ON_OR_BEFORE_EXPIRY" });
    expect(verdict("2026-10-30", "2026-10-29")).toMatchObject({ status: "BLOCKED", reason: "ON_OR_BEFORE_EXPIRY" });
  });
  it("blocks earnings within 3 calendar days after expiration (Sat, Sun, Mon after a Friday expiry)", () => {
    expect(verdict("2026-10-30", "2026-10-31")).toMatchObject({ status: "BLOCKED", reason: "WITHIN_BUFFER" });
    expect(verdict("2026-10-30", "2026-11-01")).toMatchObject({ status: "BLOCKED", reason: "WITHIN_BUFFER" });
    expect(verdict("2026-10-30", "2026-11-02")).toMatchObject({ status: "BLOCKED", reason: "WITHIN_BUFFER" });
  });
  it("allows earnings from the 4th day after expiration when there is a normal trading session to exit", () => {
    expect(verdict("2026-10-30", "2026-11-03")).toMatchObject({ status: "CLEAR" });
    expect(verdict("2026-10-30", "2026-11-05").status).toBe("CLEAR");
  });
  it("blocks when a market holiday removes the only exit session (Memorial Day)", () => {
    // Fri May 22 2026 expiry, Mon May 25 Memorial Day, Tue May 26 report: the calendar rule passes, sessions = 0.
    expect(earningsGapAfterExpiry(d("2026-05-22"), d("2026-05-26"))).toEqual({ freeDaysAfterExpiry: 3, exitSessions: 0 });
    expect(verdict("2026-05-22", "2026-05-26")).toMatchObject({ status: "BLOCKED", reason: "NO_EXIT_SESSION" });
    expect(verdict("2026-05-22", "2026-05-27").status).toBe("CLEAR");
  });
  it("blocks when Good Friday follows a Thursday expiration (Friday closed, weekend, Monday report)", () => {
    expect(verdict("2026-04-02", "2026-04-06")).toMatchObject({ status: "BLOCKED", reason: "NO_EXIT_SESSION" });
    expect(verdict("2026-04-02", "2026-04-07").status).toBe("CLEAR");
  });
  it("Labor Day: Friday expiry with a Tuesday report is blocked; a Wednesday report is clear", () => {
    expect(verdict("2026-09-04", "2026-09-08")).toMatchObject({ status: "BLOCKED", reason: "NO_EXIT_SESSION" });
    expect(verdict("2026-09-04", "2026-09-09").status).toBe("CLEAR");
  });
  it("both numbers are configurable", () => {
    expect(verdict("2026-10-30", "2026-11-03", { bufferDays: 5, minExitSessions: 1 })).toMatchObject({ status: "BLOCKED", reason: "WITHIN_BUFFER" });
    expect(verdict("2026-10-30", "2026-11-03", { bufferDays: 3, minExitSessions: 2 })).toMatchObject({ status: "BLOCKED", reason: "NO_EXIT_SESSION" });
    expect(verdict("2026-10-30", "2026-11-02", { bufferDays: 0, minExitSessions: 0 }).status).toBe("CLEAR");
  });
});

describe("putEarningsValues (what the Scanner rules compare)", () => {
  const expiration = d("2026-10-30");
  it("computes the gap only for a current (SCHEDULED) date", () => {
    expect(putEarningsValues({ expiration, reportDate: "2026-11-03", evidence: "SCHEDULED" })).toEqual({ earningsFreeDaysAfterExpiry: 3, earningsExitSessions: 1, earningsVerifyReason: null });
  });
  it("an unknown, stale or ambiguous date is never safe: null values (UNKNOWN) plus a verify reason", () => {
    for (const evidence of ["NO_EVIDENCE", "STALE", "AMBIGUOUS"] as const) {
      const result = putEarningsValues({ expiration, reportDate: evidence === "NO_EVIDENCE" ? null : "2026-12-01", evidence });
      expect(result.earningsFreeDaysAfterExpiry).toBeNull();
      expect(result.earningsExitSessions).toBeNull();
      expect(result.earningsVerifyReason).toBe(earningsVerifyReason(evidence));
      expect(result.earningsVerifyReason).toBeTruthy();
    }
  });
  it("a legacy caller that supplies a date but no evidence status keeps the date trusted and raises no flag", () => {
    const result = putEarningsValues({ expiration, reportDate: "2026-11-03", evidence: undefined });
    expect(result.earningsFreeDaysAfterExpiry).toBe(3);
    expect(result.earningsVerifyReason).toBeNull();
  });
  it("no expiration or an unparseable date leaves the values unknown", () => {
    expect(putEarningsValues({ expiration: null, reportDate: "2026-11-03", evidence: "SCHEDULED" }).earningsFreeDaysAfterExpiry).toBeNull();
    expect(putEarningsValues({ expiration, reportDate: "not a date", evidence: "SCHEDULED" }).earningsFreeDaysAfterExpiry).toBeNull();
  });
});

describe("coveredCallEarningsNote (informational only)", () => {
  it("reports whether earnings fall before the call's expiry without blocking anything", () => {
    expect(coveredCallEarningsNote({ reportDate: "2026-11-03", daysAway: 4, expiration: "2026-11-06", evidence: "SCHEDULED" })).toEqual({ reportDate: "2026-11-03", daysAway: 4, beforeExpiry: true, verifyReason: null });
    expect(coveredCallEarningsNote({ reportDate: "2026-11-09", daysAway: 10, expiration: "2026-11-06", evidence: "SCHEDULED" }).beforeExpiry).toBe(false);
  });
  it("an unknown or stale date asks for verification", () => {
    const note = coveredCallEarningsNote({ reportDate: null, daysAway: null, expiration: "2026-11-06", evidence: "NO_EVIDENCE" });
    expect(note.beforeExpiry).toBeNull();
    expect(note.verifyReason).toContain("not proof");
  });
});

describe("parseCalendarDate", () => {
  it("parses calendar dates and rejects junk", () => {
    expect(parseCalendarDate("2026-11-03")?.toISOString()).toBe("2026-11-03T00:00:00.000Z");
    expect(parseCalendarDate(null)).toBeNull();
    expect(parseCalendarDate("nope")).toBeNull();
  });
});
