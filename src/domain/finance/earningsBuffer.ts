import { isNyseMarketDay } from "./marketCalendar";

/**
 * Earnings vs a NEW cash-secured put: could assignment leave us holding shares into earnings with no real chance to sell?
 *
 * The scheduled earnings date is all Alpha Vantage gives us - never the announcement time (before the open or after the
 * close) and never whether the date is confirmed. So the rule is deliberately conservative: the market reaction is
 * assumed to be able to happen at the OPEN of the report date. Two independent conditions must both hold:
 *
 *  1. Calendar buffer: at least `bufferDays` earnings-free CALENDAR days strictly between expiration and the report date
 *     (default 3, so earnings are allowed no sooner than the 4th day after expiration). Earnings on or before the
 *     expiration date always fail.
 *  2. Exit sessions: at least `minExitSessions` FULL NYSE trading sessions strictly between expiration and the report date
 *     (default 1) - the sessions in which shares assigned at expiration could actually be sold. Weekends and NYSE holidays
 *     do not count, so Friday expiration + Monday holiday + Tuesday report = 0 sessions = blocked.
 *
 * Dates here are calendar dates (UTC midnight), the same convention as option expirations and the earnings cache.
 */
export type EarningsBufferSettings = { bufferDays: number; minExitSessions: number };

export const DEFAULT_EARNINGS_BUFFER_SETTINGS: EarningsBufferSettings = { bufferDays: 3, minExitSessions: 1 };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function utcMidnight(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Parses a YYYY-MM-DD (or full ISO) string to a UTC calendar date; null when it is not a real date. */
export function parseCalendarDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isFinite(parsed.getTime()) ? new Date(utcMidnight(parsed)) : null;
}

export type EarningsGap = {
  /** Whole calendar days strictly between expiration and the report date. A report on the expiration day is -1, the day
   * before is -2, and so on (any negative value means earnings come on or before expiration). */
  freeDaysAfterExpiry: number;
  /** Full NYSE trading sessions strictly between expiration and the report date (0 when none, never negative). */
  exitSessions: number;
};

/** The two numbers the Scanner rules compare against. Pure; knows nothing about thresholds. */
export function earningsGapAfterExpiry(expiration: Date, reportDate: Date): EarningsGap {
  const exp = utcMidnight(expiration);
  const report = utcMidnight(reportDate);
  const freeDaysAfterExpiry = Math.round((report - exp) / MS_PER_DAY) - 1;

  let exitSessions = 0;
  for (let day = exp + MS_PER_DAY; day < report; day += MS_PER_DAY) {
    if (isNyseMarketDay(new Date(day))) exitSessions += 1;
  }
  return { freeDaysAfterExpiry, exitSessions };
}

export type PutEarningsVerdict =
  | { status: "CLEAR"; message: string }
  | { status: "BLOCKED"; reason: "ON_OR_BEFORE_EXPIRY" | "WITHIN_BUFFER" | "NO_EXIT_SESSION"; message: string };

/** Plain-language verdict for a put at a given expiration against a known report date. */
export function evaluatePutEarningsBuffer(
  expiration: Date,
  reportDate: Date,
  settings: EarningsBufferSettings = DEFAULT_EARNINGS_BUFFER_SETTINGS,
): PutEarningsVerdict {
  const { freeDaysAfterExpiry, exitSessions } = earningsGapAfterExpiry(expiration, reportDate);
  if (freeDaysAfterExpiry < 0) {
    return { status: "BLOCKED", reason: "ON_OR_BEFORE_EXPIRY", message: "Earnings fall on or before expiration." };
  }
  if (freeDaysAfterExpiry < settings.bufferDays) {
    return { status: "BLOCKED", reason: "WITHIN_BUFFER", message: `Earnings fall only ${freeDaysAfterExpiry + 1} day${freeDaysAfterExpiry + 1 === 1 ? "" : "s"} after expiration (needs more than ${settings.bufferDays}).` };
  }
  if (exitSessions < settings.minExitSessions) {
    return {
      status: "BLOCKED",
      reason: "NO_EXIT_SESSION",
      message: `Only ${exitSessions} full trading session${exitSessions === 1 ? "" : "s"} between expiration and earnings (needs ${settings.minExitSessions}) - assigned shares could not be sold first.`,
    };
  }
  return { status: "CLEAR", message: `${freeDaysAfterExpiry + 1} days and ${exitSessions} trading session${exitSessions === 1 ? "" : "s"} after expiration.` };
}

/** How much the earnings DATE itself can be trusted (mirrors earningsEvidence.ts's status names), plus NOT_BEFORE: no
 * announced date, but the company's own SEC filings prove the next report cannot come before a known day
 * (see earningsFloor.ts). */
export type EarningsEvidenceState = "SCHEDULED" | "STALE" | "AMBIGUOUS" | "NO_EVIDENCE" | "NOT_BEFORE";

/** Shown when a "no earnings before" floor exists but is too close to this trade to prove anything. */
export function earningsFloorVerifyReason(notBefore: string): string {
  return `No announced earnings date. SEC filings only rule out earnings before ${notBefore}, which is too close to clear this trade - confirm before trading.`;
}

/**
 * Why the earnings date needs to be checked by a person, or null when the cached date is current and unique.
 * An absent, out-of-date or conflicting date is NEVER read as "no earnings" - it is a flag to verify.
 */
export function earningsVerifyReason(state: EarningsEvidenceState | null | undefined): string | null {
  switch (state) {
    case "STALE":
      return "The earnings date on file is out of date - confirm it before trading.";
    case "AMBIGUOUS":
      return "Conflicting earnings dates are on file - confirm the real one before trading.";
    case "NO_EVIDENCE":
      return "No upcoming earnings date on file. That is not proof there is none - confirm before trading.";
    default:
      return null;
  }
}

/**
 * The option-stage values for one put: gap numbers ONLY when the earnings date is current (SCHEDULED) and the
 * expiration is known. Anything else leaves them null, which the rules engine reads as UNKNOWN - never PASS.
 */
export function putEarningsValues(input: {
  expiration: Date | null;
  reportDate: string | null;
  evidence: EarningsEvidenceState | null | undefined;
  /** NOT_BEFORE only: the "no earnings before" floor date (YYYY-MM-DD). */
  notBefore?: string | null;
  /** NOT_BEFORE only: what each earnings rule requires (null = that rule is switched off). The floor is a LOWER BOUND
   * on the real date, so its gap numbers are minimums: they are returned only when they already satisfy every enabled
   * rule (then the real date satisfies them too). Otherwise they stay null - UNKNOWN, never a FAIL, never a guess. */
  floorMinimums?: { freeDaysAfterExpiry: number | null; exitSessions: number | null };
}): { earningsFreeDaysAfterExpiry: number | null; earningsExitSessions: number | null; earningsVerifyReason: string | null } {
  if (input.evidence === "NOT_BEFORE") {
    const floor = parseCalendarDate(input.notBefore);
    const unresolved = {
      earningsFreeDaysAfterExpiry: null,
      earningsExitSessions: null,
      earningsVerifyReason: input.notBefore ? earningsFloorVerifyReason(input.notBefore) : earningsVerifyReason("NO_EVIDENCE"),
    };
    if (!input.expiration || !floor || !input.floorMinimums) return unresolved;
    const floorGap = earningsGapAfterExpiry(input.expiration, floor);
    const { freeDaysAfterExpiry: minFreeDays, exitSessions: minSessions } = input.floorMinimums;
    const clears =
      floorGap.freeDaysAfterExpiry >= 0 &&
      (minFreeDays === null || floorGap.freeDaysAfterExpiry >= minFreeDays) &&
      (minSessions === null || floorGap.exitSessions >= minSessions);
    return clears
      ? { earningsFreeDaysAfterExpiry: floorGap.freeDaysAfterExpiry, earningsExitSessions: floorGap.exitSessions, earningsVerifyReason: null }
      : unresolved;
  }
  const verify = earningsVerifyReason(input.evidence);
  const report = parseCalendarDate(input.reportDate);
  // `evidence` omitted entirely means a legacy/demo caller that never supplied evidence: treat a present date as current.
  const dateIsTrusted = input.evidence === undefined || input.evidence === null || input.evidence === "SCHEDULED";
  if (!input.expiration || !report || !dateIsTrusted) {
    return { earningsFreeDaysAfterExpiry: null, earningsExitSessions: null, earningsVerifyReason: verify };
  }
  const gap = earningsGapAfterExpiry(input.expiration, report);
  return { earningsFreeDaysAfterExpiry: gap.freeDaysAfterExpiry, earningsExitSessions: gap.exitSessions, earningsVerifyReason: null };
}

/** Covered calls on shares already owned may deliberately go through earnings: informational only, never blocks. */
export type CoveredCallEarningsNote = {
  reportDate: string | null;
  daysAway: number | null;
  /** True/false once both the date and the call's expiration are known; null otherwise. */
  beforeExpiry: boolean | null;
  verifyReason: string | null;
};

export function coveredCallEarningsNote(input: {
  reportDate: string | null;
  daysAway: number | null;
  expiration: string | null;
  evidence: EarningsEvidenceState | null | undefined;
}): CoveredCallEarningsNote {
  const report = parseCalendarDate(input.reportDate);
  const expiration = parseCalendarDate(input.expiration);
  return {
    reportDate: input.reportDate,
    daysAway: input.daysAway,
    beforeExpiry: report && expiration ? utcMidnight(report) <= utcMidnight(expiration) : null,
    verifyReason: earningsVerifyReason(input.evidence),
  };
}
