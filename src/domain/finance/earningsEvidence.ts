/**
 * Pure earnings-evidence model for the future Trade Prep CONFLICT/CLEAR/UNKNOWN contract. Nothing
 * here calls Alpha Vantage or Prisma - it only reasons over already-fetched EarningsCalendarEntry
 * rows (ticker/reportDate/fetchedAt), handed in by the impure caller (see
 * getEarningsEvidenceLookup in lib/earnings-calendar-cache.ts). Kept separate from that impure
 * caller so every non-trivial decision here (which row is "current," what counts as stale, how a
 * holding interval intersects a report date) is directly unit-testable without a database.
 *
 * This module does NOT change the existing Scanner-facing `getEarningsCalendarLookup` /
 * `TickerEarningsLookup` contract in earnings-calendar-cache.ts - that stays exactly as it was for
 * production-approved Scanner behavior. This is a strictly additive evidence layer for Trade Prep.
 */

/**
 * - SCHEDULED: the most recently observed response for this ticker identified exactly one future
 *   report date, and that observation is still within the freshness window - safe to treat as
 *   "the provider's current next scheduled report."
 * - STALE: a single future report date was identified, but the observation is older than the
 *   freshness window - too old to trust as current.
 * - AMBIGUOUS: more than one future report date shares the SAME most-recent observation time for
 *   this ticker (e.g. two genuinely distinct rows written by the same refresh) - there is no
 *   principled way to pick "the" next report, so this is reported rather than guessed.
 * - NO_EVIDENCE: no future-dated row exists for this ticker at all. This is NOT proof the ticker
 *   has no upcoming report - EARNINGS_CALENDAR only lists companies reporting within its horizon,
 *   so absence is structurally ambiguous (see the ticket's own "absence is not proof" rule).
 */
export type EarningsEvidenceStatus = "SCHEDULED" | "STALE" | "AMBIGUOUS" | "NO_EVIDENCE";

export type TickerEarningsEvidence = {
  ticker: string;
  status: EarningsEvidenceStatus;
  /** The selected next report date, only when status is SCHEDULED or STALE. Null for AMBIGUOUS
   * (no single date can be selected) and NO_EVIDENCE. */
  reportDate: Date | null;
  /**
   * When our application observed the SELECTED row(s) in a successful provider response - never
   * the provider's own report-revision time (Alpha Vantage does not supply one). Null only when
   * status is NO_EVIDENCE. For AMBIGUOUS, this is the shared observation time of the competing
   * candidate rows.
   */
  observedAt: Date | null;
  /** All future report dates that shared the freshest observation time for this ticker. Length 1
   * for SCHEDULED/STALE (same as `reportDate`), length >1 only for AMBIGUOUS, empty for
   * NO_EVIDENCE. Exposed for transparency/debugging, not required by the conflict evaluator. */
  candidateReportDates: Date[];
};

export type EarningsCalendarRow = { ticker: string; reportDate: Date; fetchedAt: Date };

function isValidDate(date: Date): boolean {
  return date instanceof Date && Number.isFinite(date.getTime());
}

/**
 * Builds one TickerEarningsEvidence per requested ticker (always - even tickers with zero rows
 * get an explicit NO_EVIDENCE entry, unlike the legacy lookup which simply omits them) from a
 * flat list of already-future-filtered EarningsCalendarEntry rows.
 *
 * Selection rule per ticker: among that ticker's rows, the ones sharing the single MOST RECENT
 * `fetchedAt` are "the current observation" (freshest observation wins, never earliest report
 * date - this is what fixes "earliest stored future date is not necessarily the provider's
 * current next scheduled report"). Exact duplicate (reportDate) rows sharing that freshest
 * `fetchedAt` are collapsed before judging ambiguity, so a duplicated identical input row can
 * never manufacture a false AMBIGUOUS. Exactly one distinct date remaining -> SCHEDULED/STALE
 * depending on freshness. More than one distinct date -> AMBIGUOUS (two genuinely distinct future
 * dates written by the very same refresh - cannot be resolved without guessing).
 *
 * Fail-closed on observation time: a row whose `fetchedAt` is itself in the future relative to
 * `now` (or either Date is otherwise invalid/non-finite), or an invalid/non-positive
 * `freshnessWindowMs`, can never be treated as "fresh enough to be current" - such evidence is
 * reported STALE rather than SCHEDULED, per this contract's explicit fail-closed observation-time
 * policy (a corrupted or clock-skewed write must never silently qualify as trustworthy-current
 * evidence). A row with a structurally invalid `reportDate`/`fetchedAt` (NaN time) is ignored
 * entirely, as if it didn't exist, rather than being allowed to corrupt freshest-row selection.
 */
export function selectEarningsEvidenceFromRows(
  tickers: string[],
  rows: EarningsCalendarRow[],
  now: Date,
  freshnessWindowMs: number,
): Map<string, TickerEarningsEvidence> {
  const nowMs = isValidDate(now) ? now.getTime() : NaN;
  const hasValidFreshnessWindow = Number.isFinite(freshnessWindowMs) && freshnessWindowMs > 0;

  const rowsByTicker = new Map<string, EarningsCalendarRow[]>();
  for (const row of rows) {
    if (!isValidDate(row.reportDate) || !isValidDate(row.fetchedAt)) {
      continue; // structurally invalid row - ignored entirely rather than corrupting selection
    }
    const existing = rowsByTicker.get(row.ticker);
    if (existing) {
      existing.push(row);
    } else {
      rowsByTicker.set(row.ticker, [row]);
    }
  }

  const result = new Map<string, TickerEarningsEvidence>();
  for (const ticker of tickers) {
    const tickerRows = rowsByTicker.get(ticker) ?? [];
    if (tickerRows.length === 0) {
      result.set(ticker, { ticker, status: "NO_EVIDENCE", reportDate: null, observedAt: null, candidateReportDates: [] });
      continue;
    }

    const freshestObservedAtMs = Math.max(...tickerRows.map((row) => row.fetchedAt.getTime()));
    const freshestRows = tickerRows.filter((row) => row.fetchedAt.getTime() === freshestObservedAtMs);
    const observedAt = new Date(freshestObservedAtMs);

    // Deduplicate exact duplicate report dates sharing the freshest observation BEFORE judging
    // ambiguity (requirement: duplicated identical input rows must never create a false AMBIGUOUS).
    const distinctDates = [...new Map(freshestRows.map((row) => [row.reportDate.getTime(), row.reportDate])).values()];

    if (distinctDates.length > 1) {
      result.set(ticker, {
        ticker,
        status: "AMBIGUOUS",
        reportDate: null,
        observedAt,
        candidateReportDates: distinctDates.sort((a, b) => a.getTime() - b.getTime()),
      });
      continue;
    }

    // Fail-closed: an invalid evaluation clock, a non-positive/invalid freshness window, or an
    // observation that is itself in the future (clock skew or a corrupted write) can never
    // qualify as "fresh enough to be current" - never upgraded to SCHEDULED.
    const isFutureObservation = !Number.isFinite(nowMs) || freshestObservedAtMs > nowMs;
    const isStale = !hasValidFreshnessWindow || isFutureObservation || nowMs - freshestObservedAtMs > freshnessWindowMs;

    const [selectedDate] = distinctDates;
    result.set(ticker, {
      ticker,
      status: isStale ? "STALE" : "SCHEDULED",
      reportDate: selectedDate,
      observedAt,
      candidateReportDates: [selectedDate],
    });
  }

  return result;
}

export type EarningsConflictResult = "CONFLICT" | "CLEAR" | "UNKNOWN";

/**
 * Preferred UI-facing language for future Trade Prep surfaces (not wired into any UI yet - this
 * ticket is evidence-foundation only). Deliberately never "No earnings risk," which overclaims
 * certainty the evidence doesn't support.
 */
export const EARNINGS_CONFLICT_UI_LABELS: Record<EarningsConflictResult, string> = {
  CONFLICT: "Earnings scheduled within holding period",
  CLEAR: "Scheduled earnings outside holding period",
  UNKNOWN: "Earnings schedule unknown",
};

/**
 * Truncates an instant to its own UTC calendar day (strips any time-of-day component). This is
 * NOT a timezone conversion (contrast `marketCalendar.ts`'s `marketDate`, which re-derives the
 * America/New_York calendar day of a genuine live instant) - `reportDate`/`intervalStart`/
 * `intervalEnd` here are already date-only financial concepts (an earnings report date, a holding
 * start, an option expiration), conventionally represented at UTC midnight throughout this
 * codebase (see EarningsCalendarEntry.reportDate's own `@db.Date` column and
 * parseIsoDateOnly). Re-running an already-date-only value through an NY-timezone conversion
 * would itself introduce an off-by-one-day bug (e.g. UTC-midnight "Oct 5" is still "Oct 4" in
 * America/New_York). This truncation instead guards the boundary against a sloppy caller passing
 * a non-midnight instant (e.g. "Oct 1 14:00 UTC") - it is normalized to "Oct 1" before any
 * comparison, so it still correctly conflicts with an "Oct 1 00:00 UTC" holding date, exactly as
 * required: a report dated Oct 1 must conflict with an Oct 1 holding date regardless of what
 * time-of-day an input timestamp happens to carry.
 */
function toCalendarDateUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Pure CONFLICT/CLEAR/UNKNOWN evaluation for a single ticker's evidence against a holding
 * interval (e.g. [today, option expiration]) plus a configured buffer, in whole days applied to
 * both ends of the interval. All date inputs are normalized to UTC calendar days before any
 * comparison (see toCalendarDateUtc) - this is a date-only contract, never an instant comparison.
 *
 * - CONFLICT: the evidence's report date falls within [intervalStart - buffer, intervalEnd +
 *   buffer], inclusive on both ends. Same-day conservatism falls out of this automatically: a
 *   report dated exactly on `intervalStart` or `intervalEnd` always satisfies the inclusive
 *   bounds, so it is CONFLICT - because this evidence contract does not yet capture Alpha
 *   Vantage's `timeOfTheDay` field, report timing relative to market open/close is always
 *   unknown, and an unknown-timing same-day report must conservatively conflict rather than
 *   assume it falls safely before or after the holding period.
 * - CLEAR: ONLY when the report date is strictly AFTER the buffered interval end - i.e. current
 *   coherent evidence affirmatively establishes the next report as beyond the holding period. A
 *   report date BEFORE the buffered interval start does NOT prove CLEAR - that evidence point is
 *   already in the past relative to the window being evaluated, so it says nothing trustworthy
 *   about what the actual next report (which this single data point does not capture) might be
 *   during or after the interval. That case is UNKNOWN, never CLEAR.
 * - UNKNOWN: everything else - evidence that isn't SCHEDULED (STALE/AMBIGUOUS/NO_EVIDENCE), an
 *   invalid/missing report date, an invalid interval (non-finite start/end, end before start), or
 *   an invalid/negative buffer. This function never upgrades uncertain evidence or an unusable
 *   interval into a PASS-equivalent CLEAR.
 */
export function evaluateEarningsConflict({
  evidence,
  intervalStart,
  intervalEnd,
  bufferDays = 0,
}: {
  evidence: Pick<TickerEarningsEvidence, "status" | "reportDate">;
  intervalStart: Date;
  intervalEnd: Date;
  bufferDays?: number;
}): EarningsConflictResult {
  if (evidence.status !== "SCHEDULED" || !evidence.reportDate || !isValidDate(evidence.reportDate)) {
    return "UNKNOWN";
  }
  if (!isValidDate(intervalStart) || !isValidDate(intervalEnd)) {
    return "UNKNOWN";
  }
  if (!Number.isFinite(bufferDays) || bufferDays < 0) {
    return "UNKNOWN";
  }

  const start = toCalendarDateUtc(intervalStart);
  const end = toCalendarDateUtc(intervalEnd);
  if (end.getTime() < start.getTime()) {
    return "UNKNOWN"; // reversed interval - not a usable holding period
  }

  const bufferMs = bufferDays * 24 * 60 * 60 * 1000;
  const bufferedStart = start.getTime() - bufferMs;
  const bufferedEnd = end.getTime() + bufferMs;
  const reportTime = toCalendarDateUtc(evidence.reportDate).getTime();

  if (reportTime < bufferedStart) {
    return "UNKNOWN"; // evidence predates the holding window - doesn't establish the actual next report during/after it
  }
  if (reportTime <= bufferedEnd) {
    return "CONFLICT";
  }
  return "CLEAR";
}
