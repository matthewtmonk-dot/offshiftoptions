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

/**
 * Builds one TickerEarningsEvidence per requested ticker (always - even tickers with zero rows
 * get an explicit NO_EVIDENCE entry, unlike the legacy lookup which simply omits them) from a
 * flat list of already-future-filtered EarningsCalendarEntry rows.
 *
 * Selection rule per ticker: among that ticker's rows, the ones sharing the single MOST RECENT
 * `fetchedAt` are "the current observation" (freshest observation wins, never earliest report
 * date - this is what fixes "earliest stored future date is not necessarily the provider's
 * current next scheduled report"). Exactly one such row -> SCHEDULED/STALE depending on freshness
 * window. More than one -> AMBIGUOUS (two genuinely distinct future dates written by the very
 * same refresh - cannot be resolved without guessing).
 */
export function selectEarningsEvidenceFromRows(
  tickers: string[],
  rows: EarningsCalendarRow[],
  now: Date,
  freshnessWindowMs: number,
): Map<string, TickerEarningsEvidence> {
  const rowsByTicker = new Map<string, EarningsCalendarRow[]>();
  for (const row of rows) {
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

    if (freshestRows.length > 1) {
      result.set(ticker, {
        ticker,
        status: "AMBIGUOUS",
        reportDate: null,
        observedAt,
        candidateReportDates: freshestRows.map((row) => row.reportDate).sort((a, b) => a.getTime() - b.getTime()),
      });
      continue;
    }

    const isStale = now.getTime() - freshestObservedAtMs > freshnessWindowMs;
    const [selected] = freshestRows;
    result.set(ticker, {
      ticker,
      status: isStale ? "STALE" : "SCHEDULED",
      reportDate: selected.reportDate,
      observedAt,
      candidateReportDates: [selected.reportDate],
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
 * Pure CONFLICT/CLEAR/UNKNOWN evaluation for a single ticker's evidence against a holding
 * interval (e.g. [today, option expiration]) plus a configured buffer, in whole days applied to
 * both ends of the interval.
 *
 * UNKNOWN whenever the evidence itself isn't SCHEDULED (STALE/AMBIGUOUS/NO_EVIDENCE) - this
 * function never upgrades uncertain evidence into a PASS-equivalent CLEAR.
 *
 * Same-day conservatism falls out of the inclusive interval bounds automatically: a report dated
 * exactly on `intervalEnd` (e.g. the expiration date) always satisfies
 * `reportTime <= bufferedEnd`, so it is CONFLICT - because this evidence contract does not yet
 * capture Alpha Vantage's `timeOfTheDay` field, report timing relative to market open/close is
 * always unknown, and an unknown-timing same-day report must conservatively conflict rather than
 * assume it falls safely before or after the holding period.
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
  if (evidence.status !== "SCHEDULED" || !evidence.reportDate) {
    return "UNKNOWN";
  }

  const bufferMs = bufferDays * 24 * 60 * 60 * 1000;
  const bufferedStart = intervalStart.getTime() - bufferMs;
  const bufferedEnd = intervalEnd.getTime() + bufferMs;
  const reportTime = evidence.reportDate.getTime();

  return reportTime >= bufferedStart && reportTime <= bufferedEnd ? "CONFLICT" : "CLEAR";
}
