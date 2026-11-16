/**
 * "No earnings before" - a LOWER BOUND on a company's next earnings report, derived from its own SEC filings, for the
 * weeks when no announced date exists yet (the earnings calendar only lists dates companies have announced).
 *
 * The reasoning: a quarterly report (10-Q) or annual report (10-K) for the fiscal period ending on P contains that
 * period's results, so once it is filed those results are public. The NEXT earnings report covers the following fiscal
 * quarter, and results cannot be reported before that quarter has ended. A fiscal quarter is never shorter than 12 weeks
 * (most are 13; a few companies use 12/12/12/16-week years), so the next report cannot come before P + 84 days.
 *
 * This is a floor, never a date: the real report is normally weeks later. It is only ever used to PASS an earnings rule
 * (the floor itself already satisfies the rule); it can never FAIL one - a floor that is too close proves nothing, and
 * the rule stays UNKNOWN. Stale filing data is safe by construction: a newer filing can only move the floor later.
 *
 * Deliberately NOT derived from earnings press releases (8-K item 2.02): companies also file those for preliminary
 * results, weeks before the real report. Transition-period forms (10-QT/10-KT) and amendments are ignored.
 *
 * Known limits (documented, not handled): a company changing its fiscal year can have one short transition quarter;
 * foreign filers (20-F/6-K/40-F) have no 10-Q/10-K and get no floor.
 *
 * Pure: no fetching, no database. Dates are calendar dates at UTC midnight, like the rest of the earnings code.
 */

/** The shortest fiscal quarter in normal use: 12 weeks. */
export const MIN_FISCAL_QUARTER_DAYS = 84;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const REPORT_FORMS = new Set(["10-Q", "10-K"]);

export type ReportedPeriod = {
  form: "10-Q" | "10-K";
  /** Last day of the fiscal period the report covers. */
  periodEnd: Date;
  /** The day the report was filed with the SEC. */
  filedAt: Date;
};

export type EarningsFloor = {
  /** YYYY-MM-DD: the next earnings report cannot come before this date. */
  notBefore: string;
  /** Plain-language basis, shown to the user. */
  source: string;
};

function parseDateOnly(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? parsed : null;
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The most recent fiscal period for which a 10-Q or 10-K appears in an SEC "submissions" document
 * (data.sec.gov/submissions/CIK##########.json -> filings.recent, parallel arrays). Null when there is none, or the
 * document is not the expected shape. A filing dated after `today`, or one whose period ends on/after its own filing
 * date, is ignored as corrupt rather than trusted.
 */
export function latestReportedPeriod(submissions: unknown, today: Date): ReportedPeriod | null {
  const recent = (submissions as { filings?: { recent?: Record<string, unknown> } } | null)?.filings?.recent;
  if (!recent || typeof recent !== "object") return null;
  const forms = recent.form;
  const filed = recent.filingDate;
  const periods = recent.reportDate;
  if (!Array.isArray(forms) || !Array.isArray(filed) || !Array.isArray(periods)) return null;

  let best: ReportedPeriod | null = null;
  for (let index = 0; index < forms.length; index += 1) {
    const form = forms[index];
    if (typeof form !== "string" || !REPORT_FORMS.has(form)) continue;
    const periodEnd = parseDateOnly(periods[index]);
    const filedAt = parseDateOnly(filed[index]);
    if (!periodEnd || !filedAt) continue;
    if (filedAt.getTime() > today.getTime() || periodEnd.getTime() >= filedAt.getTime()) continue;
    if (!best || periodEnd.getTime() > best.periodEnd.getTime()) {
      best = { form: form as ReportedPeriod["form"], periodEnd, filedAt };
    }
  }
  return best;
}

/** The floor implied by a reported period: the earliest day the following fiscal quarter could end. */
export function earningsFloorFrom(period: ReportedPeriod): EarningsFloor {
  const notBefore = new Date(period.periodEnd.getTime() + MIN_FISCAL_QUARTER_DAYS * MS_PER_DAY);
  const kind = period.form === "10-K" ? "annual report (10-K)" : "quarterly report (10-Q)";
  return {
    notBefore: iso(notBefore),
    source: `SEC ${kind} for the period ended ${iso(period.periodEnd)} was filed ${iso(period.filedAt)}, so the next quarter's results cannot come before ${iso(notBefore)}.`,
  };
}

/** Whole calendar days from `today` to the floor (may be zero or negative when the floor has passed). */
export function daysUntilFloor(floor: EarningsFloor, today: Date): number | null {
  const date = parseDateOnly(floor.notBefore);
  if (!date) return null;
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((date.getTime() - todayUtc) / MS_PER_DAY);
}
