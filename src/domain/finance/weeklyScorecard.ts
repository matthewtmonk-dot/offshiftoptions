import { optionLegValue, type CampaignEventInput } from "./campaigns";

/**
 * Building blocks for the Tracker's Performance "Account scorecard". Two ideas, kept deliberately simple:
 *
 *  1. Option income in a time window = credits received minus buy-backs paid, minus fees, for option
 *     trades dated inside that window (rolls count: the close is a debit and the new sale a credit).
 *     This is CASH FLOW, not realized profit - it is the same "option cash flow" the Tracker already shows.
 *  2. Capital-weighted average weekly return across positions = total cash collected / total
 *     (money set aside x weeks it was set aside). A big position counts for more than a small one,
 *     so it answers "on the money I put out there, what do I average per week?".
 *
 * Neither recomputes accounting the campaign/reporting code already owns; both only combine its outputs.
 */

const CREDIT_EVENTS = new Set(["SELL_PUT", "ROLL_PUT_OPEN", "SELL_COVERED_CALL"]);
const DEBIT_EVENTS = new Set(["CLOSE_PUT", "ROLL_PUT_CLOSE", "CLOSE_COVERED_CALL"]);

function finiteOrZero(value: unknown): number {
  const n = typeof value === "number" ? value : value === null || value === undefined ? 0 : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Net option cash flow (credits - debits - fees) for events dated within [start, end], inclusive. */
export function netOptionCashFlowBetween(events: CampaignEventInput[], start: Date, end: Date): number {
  let total = 0;
  for (const event of events) {
    const isCredit = CREDIT_EVENTS.has(event.type);
    const isDebit = DEBIT_EVENTS.has(event.type);
    if (!isCredit && !isDebit) continue;
    const at = new Date(event.occurredAt).getTime();
    if (!(at >= start.getTime() && at <= end.getTime())) continue;
    const leg = optionLegValue(event);
    if (leg === null) continue;
    total += (isCredit ? leg : -leg) - finiteOrZero(event.fees);
  }
  return round2(total);
}

const MS_PER_DAY = 86_400_000;

function utcDay(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

/**
 * How many days a position's money was actually set aside, for the weekly-return math.
 *
 * An OPEN campaign whose current put has already expired is only "settlement pending" - Schwab hasn't confirmed
 * whether it expired worthless or was assigned. Counting the days AFTER expiration would keep diluting the
 * weekly return with time the put was no longer working (e.g. a put that expired in July would still be
 * accruing weeks in October). So the clock stops at the put's expiration date. Once the outcome is recorded
 * (assignment, covered call, close) the campaign is no longer OPEN-with-an-expired-put and its normal age applies.
 */
export function capitalDaysAtWork(input: {
  status: "OPEN" | "ASSIGNED" | "CLOSED";
  daysActive: number | null;
  openedAt: Date | null;
  /** Expiration of the currently open put, if there is one. */
  openPutExpiration: Date | null;
  asOf: Date;
}): number | null {
  const { status, daysActive, openedAt, openPutExpiration, asOf } = input;
  if (daysActive === null) return null;
  if (status !== "OPEN" || openPutExpiration === null || openedAt === null) return daysActive;
  if (utcDay(asOf) <= utcDay(openPutExpiration)) return daysActive;
  const throughExpiration = Math.max(1, Math.ceil((utcDay(openPutExpiration) - utcDay(openedAt)) / MS_PER_DAY));
  return Math.min(daysActive, throughExpiration);
}

export type CapitalWeightedReturn = {
  /** Average return per week on the money set aside, in percent. */
  weeklyPercent: number;
  /** Total cash collected across the counted positions. */
  totalGain: number;
  /** Positions that had enough information to count. */
  counted: number;
  /** Total calendar days spanned by the counted positions (for the "early read" flag). */
  longestDays: number;
};

/** `gain` and `capital` must already be the authoritative per-position figures; rows missing either are skipped. */
export function capitalWeightedWeeklyReturn(
  rows: { gain: number | null; capital: number | null; days: number | null }[],
): CapitalWeightedReturn | null {
  let totalGain = 0;
  let capitalWeeks = 0;
  let counted = 0;
  let longestDays = 0;
  for (const row of rows) {
    if (row.gain === null || row.capital === null || row.days === null) continue;
    if (!Number.isFinite(row.gain) || !Number.isFinite(row.capital) || !Number.isFinite(row.days)) continue;
    if (row.capital <= 0 || row.days < 1) continue;
    totalGain += row.gain;
    capitalWeeks += row.capital * (row.days / 7);
    counted += 1;
    longestDays = Math.max(longestDays, row.days);
  }
  if (counted === 0 || capitalWeeks <= 0) return null;
  return {
    weeklyPercent: round2((totalGain / capitalWeeks) * 100),
    totalGain: round2(totalGain),
    counted,
    longestDays,
  };
}
