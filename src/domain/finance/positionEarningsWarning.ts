import { marketDate } from "./marketCalendar";
import type { TickerEarningsEvidence } from "./earningsEvidence";

/**
 * Earnings warning for a position that is already open (new puts are screened by earningsBuffer.ts; position
 * review itself has no earnings logic). Pure and date-only: the report date and the option expiration are UTC-midnight
 * calendar dates, "today" is the New York market date. Alpha Vantage gives only the date, never the time of day, so a
 * report dated on the expiration day counts as before expiry (it may hit at the open).
 *
 *  - BEFORE_EXPIRY: an open put/call whose expiration falls on or after the next report date.
 *  - SHARES_SOON:   assigned shares with no call open and a report within SHARES_EARNINGS_WINDOW_DAYS.
 *  - UNKNOWN:       the report date is missing, stale or ambiguous - say so instead of implying "no earnings".
 *  - NONE:          the evidence puts the next report after expiry (or further out than the window for bare shares).
 */
export const SHARES_EARNINGS_WINDOW_DAYS = 7;

export type PositionEarningsLevel = "BEFORE_EXPIRY" | "SHARES_SOON" | "UNKNOWN" | "NONE";

/** Plain data only (strings and numbers) so it can be handed to client components. */
export type PositionEarningsWarning = {
  level: PositionEarningsLevel;
  /** YYYY-MM-DD, only when a single trustworthy date is known. */
  reportDate: string | null;
  /** Whole calendar days from today (NY) to the report; 0 = today. */
  daysAway: number | null;
  message: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function calendarDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function whenLabel(daysAway: number): string {
  if (daysAway === 0) return "today (timing unknown - assume before the open)";
  if (daysAway === 1) return "tomorrow";
  return `in ${daysAway} days`;
}

export function evaluatePositionEarningsWarning({
  legType,
  expiration,
  evidence,
  now,
}: {
  /** The open option leg, or null for assigned shares with no call open. */
  legType: "PUT" | "CALL" | null;
  expiration: Date | null;
  evidence: Pick<TickerEarningsEvidence, "status" | "reportDate"> | null | undefined;
  now: Date;
}): PositionEarningsWarning {
  const today = calendarDay(marketDate(now));
  const reportDate = evidence?.status === "SCHEDULED" ? evidence.reportDate : null;
  if (!reportDate || !Number.isFinite(reportDate.getTime()) || calendarDay(reportDate) < today) {
    return {
      level: "UNKNOWN",
      reportDate: null,
      daysAway: null,
      message: "Next earnings date not confirmed - check it before relying on this position.",
    };
  }

  const report = calendarDay(reportDate);
  const daysAway = Math.round((report - today) / DAY_MS);
  const iso = new Date(report).toISOString().slice(0, 10);
  const when = whenLabel(daysAway);

  if (legType && expiration && Number.isFinite(expiration.getTime())) {
    if (report <= calendarDay(expiration)) {
      return {
        level: "BEFORE_EXPIRY",
        reportDate: iso,
        daysAway,
        message:
          legType === "PUT"
            ? `Earnings ${iso} (${when}), before this put expires. A big move on the report can push the stock through your strike.`
            : `Earnings ${iso} (${when}), before this call expires. Your shares stay exposed to the move; the call only cushions a drop by its premium.`,
      };
    }
    return { level: "NONE", reportDate: iso, daysAway, message: "" };
  }

  if (daysAway <= SHARES_EARNINGS_WINDOW_DAYS) {
    return {
      level: "SHARES_SOON",
      reportDate: iso,
      daysAway,
      message: `Earnings ${iso} (${when}). You hold these shares through the report, and no call is open.`,
    };
  }
  return { level: "NONE", reportDate: iso, daysAway, message: "" };
}

/** What a position row shows: the warning, plus a roll caution when the position review is suggesting a roll. */
export type PositionEarningsNote = { warning: PositionEarningsWarning; rollCaution: string | null };

/** A roll moves the position out to the next weekly expiration. */
const ROLL_EXTENSION_DAYS = 7;

/**
 * Earnings check for a suggested roll. A roll is a new trade on a later expiration, so it gets the same test as a new
 * put: if the next report falls on or before the new (about one week later) expiration, the roll carries earnings
 * risk. The app never places the roll (that is done by hand in thinkorswim), so this only advises.
 */
export function rollEarningsCaution(warning: PositionEarningsWarning, currentExpiration: Date | null): string | null {
  if (warning.level === "UNKNOWN") return "Confirm the earnings date before rolling.";
  if (!warning.reportDate) return null;
  if (warning.level === "BEFORE_EXPIRY" || warning.level === "SHARES_SOON") {
    return `Don't roll into earnings (${warning.reportDate}). A later expiration would still sit across the report.`;
  }
  if (currentExpiration && Number.isFinite(currentExpiration.getTime())) {
    const rolledExpiration = calendarDay(currentExpiration) + ROLL_EXTENSION_DAYS * DAY_MS;
    if (calendarDay(new Date(`${warning.reportDate}T00:00:00Z`)) <= rolledExpiration) {
      return `Rolling out a week would reach the ${warning.reportDate} earnings report. Treat the roll as a new trade and check the earnings gap first.`;
    }
  }
  return null;
}

export function buildPositionEarningsNote({
  legType,
  expiration,
  evidence,
  now,
  rollSuggested,
}: {
  legType: "PUT" | "CALL" | null;
  expiration: Date | null;
  evidence: Pick<TickerEarningsEvidence, "status" | "reportDate"> | null | undefined;
  now: Date;
  rollSuggested: boolean;
}): PositionEarningsNote {
  const warning = evaluatePositionEarningsWarning({ legType, expiration, evidence, now });
  return { warning, rollCaution: rollSuggested ? rollEarningsCaution(warning, expiration) : null };
}
