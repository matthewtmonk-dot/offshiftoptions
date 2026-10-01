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
});

describe("EARNINGS_CONFLICT_UI_LABELS", () => {
  it("never uses the forbidden 'No earnings risk' phrasing, and uses the ticket's preferred CLEAR language", () => {
    expect(Object.values(EARNINGS_CONFLICT_UI_LABELS).join(" ")).not.toMatch(/no earnings risk/i);
    expect(EARNINGS_CONFLICT_UI_LABELS.CLEAR).toBe("Scheduled earnings outside holding period");
  });
});
