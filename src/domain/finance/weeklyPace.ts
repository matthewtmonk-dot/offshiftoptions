/**
 * "Average return per week" - one simple, consistent measure used for a single position (campaign) and
 * for the whole account, so both read the same way:
 *
 *     weekly average % = (total return % so far) / (weeks elapsed)
 *
 * It is a plain average over the elapsed time, never compounded and never annualized. It deliberately
 * takes an already-computed total percent (from the authoritative reporting/campaign code) and only
 * divides by time - it does not recompute any gain, capital or return itself.
 *
 * Whether the result is "on track" is shown against the LST reference rate. That reference is a
 * display comparison only; it never feeds scanner scoring, readiness or any trade decision.
 */
export const WEEKLY_PACE_REFERENCE_PERCENT = 1;

export type WeeklyPace = {
  /** Total return over the whole period, in percent. */
  totalPercent: number;
  /** Average return per week, in percent. */
  weeklyPercent: number;
  /** Calendar days the return was earned over (always >= 1). */
  days: number;
  /** True when the period is too short for the average to mean much yet. */
  early: boolean;
};

export type WeeklyPaceTone = "good" | "warn" | "bad";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** `earlyBelowDays` - periods shorter than this are flagged `early` (a 4-day sample is not a trend). */
export function weeklyPaceFromPercent(totalPercent: number | null, days: number | null, earlyBelowDays = 7): WeeklyPace | null {
  if (totalPercent === null || days === null || !Number.isFinite(totalPercent) || !Number.isFinite(days) || days < 1) {
    return null;
  }
  return {
    totalPercent: round2(totalPercent),
    weeklyPercent: round2(totalPercent / (days / 7)),
    days,
    early: days < earlyBelowDays,
  };
}

/** For a position: money collected / money set aside. Needs a positive amount set aside. */
export function weeklyPaceFromGain(gain: number | null, capital: number | null, days: number | null, earlyBelowDays = 7): WeeklyPace | null {
  if (gain === null || capital === null || !Number.isFinite(gain) || !Number.isFinite(capital) || capital <= 0) {
    return null;
  }
  return weeklyPaceFromPercent((gain / capital) * 100, days, earlyBelowDays);
}

/** green at/above the reference rate, amber when positive but below it, red when negative. */
export function weeklyPaceTone(weeklyPercent: number): WeeklyPaceTone {
  if (weeklyPercent >= WEEKLY_PACE_REFERENCE_PERCENT) return "good";
  if (weeklyPercent >= 0) return "warn";
  return "bad";
}

export function formatWeeklyPercent(weeklyPercent: number): string {
  return `${weeklyPercent > 0 ? "+" : ""}${weeklyPercent.toFixed(2)}% / week`;
}

export function describePeriodDays(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}
