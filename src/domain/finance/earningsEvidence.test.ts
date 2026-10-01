import { describe, expect, it } from "vitest";
import {
  selectEarningsEvidenceFromRows,
  evaluateEarningsConflict,
  type EarningsCalendarRow,
  EARNINGS_CONFLICT_UI_LABELS,
} from "./earningsEvidence";

const FRESHNESS_WINDOW_MS = 20 * 60 * 60 * 1000; // mirrors EARNINGS_CALENDAR_REFRESH_INTERVAL_MS

const row = (ticker: string, reportDate: string, fetchedAt: string): EarningsCalendarRow => ({
  ticker,
  reportDate: new Date(reportDate),
  fetchedAt: new Date(fetchedAt),
});

describe("selectEarningsEvidenceFromRows", () => {
  it("reports NO_EVIDENCE for a ticker with no rows - never interpreted as CLEAR", () => {
    const result = selectEarningsEvidenceFromRows(["AAPL"], [], new Date("2026-09-29T12:00:00Z"), FRESHNESS_WINDOW_MS);
    expect(result.get("AAPL")).toEqual({ ticker: "AAPL", status: "NO_EVIDENCE", reportDate: null, observedAt: null, candidateReportDates: [] });
  });

  it("always includes every requested ticker, even with zero rows (unlike the legacy lookup)", () => {
    const result = selectEarningsEvidenceFromRows(["AAPL", "MSFT"], [], new Date(), FRESHNESS_WINDOW_MS);
    expect([...result.keys()].sort()).toEqual(["AAPL", "MSFT"]);
  });

  it("selects the single current row as SCHEDULED when fresh", () => {
    const now = new Date("2026-09-29T12:00:00Z");
    const rows = [row("AAPL", "2026-10-05", "2026-09-29T10:00:00Z")];
    const result = selectEarningsEvidenceFromRows(["AAPL"], rows, now, FRESHNESS_WINDOW_MS);
    expect(result.get("AAPL")).toEqual({
      ticker: "AAPL",
      status: "SCHEDULED",
      reportDate: new Date("2026-10-05"),
      observedAt: new Date("2026-09-29T10:00:00Z"),
      candidateReportDates: [new Date("2026-10-05")],
    });
  });

  it("picks the FRESHEST observed row, not the earliest report date, when a ticker has two rows from different observations", () => {
    // Simulates the exact bug this ticket fixes: an older refresh's now-superseded date A, plus a
    // newer refresh's current date B - freshest-fetchedAt wins, not earliest-reportDate.
    const now = new Date("2026-09-29T12:00:00Z");
    const rows = [
      row("AAPL", "2026-10-01", "2026-09-20T10:00:00Z"), // stale observation, earlier date (A)
      row("AAPL", "2026-10-15", "2026-09-29T09:00:00Z"), // freshest observation (B)
    ];
    const result = selectEarningsEvidenceFromRows(["AAPL"], rows, now, FRESHNESS_WINDOW_MS);
    expect(result.get("AAPL")?.status).toBe("SCHEDULED");
    expect(result.get("AAPL")?.reportDate).toEqual(new Date("2026-10-15"));
  });

  it("reports AMBIGUOUS when two future dates share the exact same freshest observation time", () => {
    const now = new Date("2026-09-29T12:00:00Z");
    const sharedFetchedAt = "2026-09-29T09:00:00Z";
    const rows = [row("AAPL", "2026-10-01", sharedFetchedAt), row("AAPL", "2026-10-15", sharedFetchedAt)];
    const result = selectEarningsEvidenceFromRows(["AAPL"], rows, now, FRESHNESS_WINDOW_MS);
    expect(result.get("AAPL")?.status).toBe("AMBIGUOUS");
    expect(result.get("AAPL")?.reportDate).toBeNull();
    expect(result.get("AAPL")?.candidateReportDates).toEqual([new Date("2026-10-01"), new Date("2026-10-15")]);
  });

  it("reports STALE when the single current row's observation is older than the freshness window", () => {
    const now = new Date("2026-09-29T12:00:00Z");
    const rows = [row("AAPL", "2026-10-05", "2026-09-20T10:00:00Z")]; // >20h old
    const result = selectEarningsEvidenceFromRows(["AAPL"], rows, now, FRESHNESS_WINDOW_MS);
    expect(result.get("AAPL")?.status).toBe("STALE");
    expect(result.get("AAPL")?.reportDate).toEqual(new Date("2026-10-05")); // still surfaced, just not trusted as current
  });

  it("preserves observedAt (fetchedAt) through the evidence lookup, distinct from reportDate", () => {
    const now = new Date("2026-09-29T12:00:00Z");
    const rows = [row("AAPL", "2026-10-05", "2026-09-29T08:30:00Z")];
    const result = selectEarningsEvidenceFromRows(["AAPL"], rows, now, FRESHNESS_WINDOW_MS);
    expect(result.get("AAPL")?.observedAt).toEqual(new Date("2026-09-29T08:30:00Z"));
    expect(result.get("AAPL")?.observedAt).not.toEqual(result.get("AAPL")?.reportDate);
  });

  it("deduplicates exact duplicate (ticker, reportDate, fetchedAt) rows before judging ambiguity - never a false AMBIGUOUS", () => {
    const now = new Date("2026-09-29T12:00:00Z");
    const sharedFetchedAt = "2026-09-29T09:00:00Z";
    const rows = [row("AAPL", "2026-10-05", sharedFetchedAt), row("AAPL", "2026-10-05", sharedFetchedAt)];
    const result = selectEarningsEvidenceFromRows(["AAPL"], rows, now, FRESHNESS_WINDOW_MS);
    expect(result.get("AAPL")?.status).toBe("SCHEDULED");
    expect(result.get("AAPL")?.reportDate).toEqual(new Date("2026-10-05"));
  });

  it("fails closed to STALE when the observation (fetchedAt) is itself in the future relative to the evaluation clock", () => {
    const now = new Date("2026-09-29T12:00:00Z");
    const rows = [row("AAPL", "2026-10-05", "2026-09-30T00:00:00Z")]; // fetchedAt is after `now`
    const result = selectEarningsEvidenceFromRows(["AAPL"], rows, now, FRESHNESS_WINDOW_MS);
    expect(result.get("AAPL")?.status).toBe("STALE");
  });

  it("fails closed to STALE when fetchedAt is an invalid Date", () => {
    const now = new Date("2026-09-29T12:00:00Z");
    const rows: EarningsCalendarRow[] = [{ ticker: "AAPL", reportDate: new Date("2026-10-05"), fetchedAt: new Date(NaN) }];
    const result = selectEarningsEvidenceFromRows(["AAPL"], rows, now, FRESHNESS_WINDOW_MS);
    // An invalid fetchedAt row is ignored entirely (as if it didn't exist), so AAPL has no usable
    // row left at all - genuinely NO_EVIDENCE, never silently treated as current.
    expect(result.get("AAPL")?.status).toBe("NO_EVIDENCE");
  });

  it("fails closed to STALE when `now` itself is an invalid Date", () => {
    const rows = [row("AAPL", "2026-10-05", "2026-09-29T09:00:00Z")];
    const result = selectEarningsEvidenceFromRows(["AAPL"], rows, new Date(NaN), FRESHNESS_WINDOW_MS);
    expect(result.get("AAPL")?.status).toBe("STALE");
  });

  it("fails closed to STALE when freshnessWindowMs is non-positive or non-finite", () => {
    const now = new Date("2026-09-29T12:00:01Z"); // 1 second after fetchedAt - would otherwise be fresh
    const rows = [row("AAPL", "2026-10-05", "2026-09-29T12:00:00Z")];
    expect(selectEarningsEvidenceFromRows(["AAPL"], rows, now, 0).get("AAPL")?.status).toBe("STALE");
    expect(selectEarningsEvidenceFromRows(["AAPL"], rows, now, -1).get("AAPL")?.status).toBe("STALE");
    expect(selectEarningsEvidenceFromRows(["AAPL"], rows, now, NaN).get("AAPL")?.status).toBe("STALE");
  });

  it("documents the exact freshness boundary: age strictly equal to the window still counts as current (SCHEDULED)", () => {
    const fetchedAt = new Date("2026-09-29T00:00:00Z");
    const now = new Date(fetchedAt.getTime() + FRESHNESS_WINDOW_MS); // age === window, exactly
    const rows = [{ ticker: "AAPL", reportDate: new Date("2026-10-05"), fetchedAt }];
    expect(selectEarningsEvidenceFromRows(["AAPL"], rows, now, FRESHNESS_WINDOW_MS).get("AAPL")?.status).toBe("SCHEDULED");
  });

  it("age one millisecond beyond the freshness window is STALE", () => {
    const fetchedAt = new Date("2026-09-29T00:00:00Z");
    const now = new Date(fetchedAt.getTime() + FRESHNESS_WINDOW_MS + 1);
    const rows = [{ ticker: "AAPL", reportDate: new Date("2026-10-05"), fetchedAt }];
    expect(selectEarningsEvidenceFromRows(["AAPL"], rows, now, FRESHNESS_WINDOW_MS).get("AAPL")?.status).toBe("STALE");
  });
});

describe("evaluateEarningsConflict", () => {
  const interval = { intervalStart: new Date("2026-10-01"), intervalEnd: new Date("2026-10-17") }; // e.g. entry -> expiration

  it("is UNKNOWN for NO_EVIDENCE - never upgraded to CLEAR", () => {
    const result = evaluateEarningsConflict({ evidence: { status: "NO_EVIDENCE", reportDate: null }, ...interval });
    expect(result).toBe("UNKNOWN");
  });

  it("is UNKNOWN for STALE evidence", () => {
    const result = evaluateEarningsConflict({ evidence: { status: "STALE", reportDate: new Date("2026-10-10") }, ...interval });
    expect(result).toBe("UNKNOWN");
  });

  it("is UNKNOWN for AMBIGUOUS evidence", () => {
    const result = evaluateEarningsConflict({ evidence: { status: "AMBIGUOUS", reportDate: null }, ...interval });
    expect(result).toBe("UNKNOWN");
  });

  it("is CONFLICT when a current scheduled report falls inside the holding interval", () => {
    const result = evaluateEarningsConflict({ evidence: { status: "SCHEDULED", reportDate: new Date("2026-10-10") }, ...interval });
    expect(result).toBe("CONFLICT");
  });

  it("is CLEAR when a current scheduled report falls after the holding interval and buffer", () => {
    const result = evaluateEarningsConflict({ evidence: { status: "SCHEDULED", reportDate: new Date("2026-11-01") }, ...interval });
    expect(result).toBe("CLEAR");
  });

  it("is CONFLICT, not CLEAR, when the report falls within the configured buffer beyond the interval end", () => {
    const result = evaluateEarningsConflict({
      evidence: { status: "SCHEDULED", reportDate: new Date("2026-10-19") }, // 2 days after intervalEnd
      bufferDays: 3,
      ...interval,
    });
    expect(result).toBe("CONFLICT");
  });

  it("is CONFLICT for a same-day report on the exact interval end (expiration), since timing is unknown", () => {
    const result = evaluateEarningsConflict({ evidence: { status: "SCHEDULED", reportDate: new Date("2026-10-17") }, ...interval });
    expect(result).toBe("CONFLICT");
  });

  it("is CONFLICT for a same-day report on the exact interval start, since timing is unknown", () => {
    const result = evaluateEarningsConflict({ evidence: { status: "SCHEDULED", reportDate: new Date("2026-10-01") }, ...interval });
    expect(result).toBe("CONFLICT");
  });

  it("is UNKNOWN - never CLEAR - when the only evidence predates the holding interval start", () => {
    // The ticket's own example: holding Oct 10-17, only evidence is an Oct 1 report. That data
    // point is already in the past relative to the window and says nothing trustworthy about the
    // actual next report during/after it.
    const result = evaluateEarningsConflict({
      evidence: { status: "SCHEDULED", reportDate: new Date("2026-10-01") },
      intervalStart: new Date("2026-10-10"),
      intervalEnd: new Date("2026-10-17"),
    });
    expect(result).toBe("UNKNOWN");
  });

  it("is CONFLICT, not UNKNOWN, when the report is before the buffered start but still inside the buffer window", () => {
    const result = evaluateEarningsConflict({
      evidence: { status: "SCHEDULED", reportDate: new Date("2026-09-29") }, // 2 days before intervalStart
      intervalStart: new Date("2026-10-01"),
      intervalEnd: new Date("2026-10-17"),
      bufferDays: 3,
    });
    expect(result).toBe("CONFLICT");
  });

  it("is UNKNOWN for an invalid report date even when status claims SCHEDULED", () => {
    const result = evaluateEarningsConflict({ evidence: { status: "SCHEDULED", reportDate: new Date(NaN) }, ...interval });
    expect(result).toBe("UNKNOWN");
  });

  it("is UNKNOWN for an invalid intervalStart", () => {
    const result = evaluateEarningsConflict({
      evidence: { status: "SCHEDULED", reportDate: new Date("2026-10-10") },
      intervalStart: new Date(NaN),
      intervalEnd: interval.intervalEnd,
    });
    expect(result).toBe("UNKNOWN");
  });

  it("is UNKNOWN for an invalid intervalEnd", () => {
    const result = evaluateEarningsConflict({
      evidence: { status: "SCHEDULED", reportDate: new Date("2026-10-10") },
      intervalStart: interval.intervalStart,
      intervalEnd: new Date(NaN),
    });
    expect(result).toBe("UNKNOWN");
  });

  it("is UNKNOWN for a reversed interval (end before start)", () => {
    const result = evaluateEarningsConflict({
      evidence: { status: "SCHEDULED", reportDate: new Date("2026-10-10") },
      intervalStart: new Date("2026-10-17"),
      intervalEnd: new Date("2026-10-01"),
    });
    expect(result).toBe("UNKNOWN");
  });

  it("is UNKNOWN for a negative buffer", () => {
    const result = evaluateEarningsConflict({ evidence: { status: "SCHEDULED", reportDate: new Date("2026-10-10") }, bufferDays: -1, ...interval });
    expect(result).toBe("UNKNOWN");
  });

  it("is UNKNOWN for a non-finite buffer", () => {
    const result = evaluateEarningsConflict({ evidence: { status: "SCHEDULED", reportDate: new Date("2026-10-10") }, bufferDays: NaN, ...interval });
    expect(result).toBe("UNKNOWN");
  });

  it("truncates a non-midnight report-date instant to its own calendar day before comparing - Oct 1 14:00 UTC still conflicts with an Oct 1 00:00 UTC holding start", () => {
    const result = evaluateEarningsConflict({
      evidence: { status: "SCHEDULED", reportDate: new Date("2026-10-01T14:00:00Z") },
      intervalStart: new Date("2026-10-01T00:00:00Z"),
      intervalEnd: new Date("2026-10-17T00:00:00Z"),
    });
    expect(result).toBe("CONFLICT");
  });

  it("truncates a non-midnight intervalEnd instant to its own calendar day before comparing", () => {
    const result = evaluateEarningsConflict({
      evidence: { status: "SCHEDULED", reportDate: new Date("2026-10-17T00:00:00Z") },
      intervalStart: new Date("2026-10-01T00:00:00Z"),
      intervalEnd: new Date("2026-10-17T23:30:00Z"), // same calendar day as the report, non-midnight
    });
    expect(result).toBe("CONFLICT");
  });
});

describe("EARNINGS_CONFLICT_UI_LABELS", () => {
  it("never uses the forbidden 'No earnings risk' phrasing, and uses the ticket's preferred CLEAR language", () => {
    expect(Object.values(EARNINGS_CONFLICT_UI_LABELS).join(" ")).not.toMatch(/no earnings risk/i);
    expect(EARNINGS_CONFLICT_UI_LABELS.CLEAR).toBe("Scheduled earnings outside holding period");
  });
});
