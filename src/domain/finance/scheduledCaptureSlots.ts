import { isNyseMarketDay, marketDate } from "./marketCalendar";
import { nyCalendarDateOf, nyMinuteOfDay, parseCalendarDateString, type CalendarDateString } from "./marketSession";

/**
 * LST "Bounded Scheduled Position Capture" Phase 2A - PURE, zero-I/O slot-due computation.
 * Deliberately conservative and deliberately simple: a fixed America/New_York cadence
 * (OPENING ~9:35 AM, BASELINE every 15 minutes, FINAL ~3:55 PM), gated only by
 * `isNyseMarketDay` - the same algorithmic, no-network NYSE full-day-closure calendar the rest of
 * this app already trusts for weekends/holidays (marketCalendar.ts). This module does NOT know
 * about NYSE early closes (no authoritative, zero-network early-close calendar exists in this
 * repo - see Phase 1's own Codex blocker repair B2, which hit the identical limitation for a
 * USER-FACING claim). That is an acceptable, DOCUMENTED limitation here specifically because
 * nothing in this module is itself a trust claim: a FINAL slot incorrectly considered "due" on an
 * early-close afternoon simply costs one bounded, cheap capture attempt whose own real,
 * provider-verified session evidence correctly resolves to CANNOT_ASSESS (session CLOSED) via the
 * existing, unmodified evaluator - never a fabricated assessment. The actual trust boundary stays
 * exactly where Phase 1/2A already established it: the real evaluator's own evidence, not this
 * scheduler's timing guess.
 *
 * Does not know about "the user's own trading day" in any other sense, does not call a database,
 * and never backdates: `dueAt` is always the slot's real, originally-targeted NY instant,
 * independent of when a caller actually gets around to processing it (a missed/late heartbeat
 * finds the SAME due slot with the SAME dueAt, never a fabricated later one).
 */

export type CaptureSlotKind = "OPENING" | "BASELINE" | "FINAL";

export type DueCaptureSlot = {
  slot: CaptureSlotKind;
  sessionDate: CalendarDateString;
  dueAt: Date;
};

/** 9:35 AM ET - five minutes after the regular session opens, giving the exchange/provider a
 * moment to stabilize before the first capture of the day. */
export const OPENING_SLOT_MINUTE_ET = 9 * 60 + 35;
/** 3:55 PM ET - five minutes before the regular session's ordinary 4:00 PM close. */
export const FINAL_SLOT_MINUTE_ET = 15 * 60 + 55;
export const BASELINE_INTERVAL_MINUTES = 15;

/** How far past a slot's own target minute a heartbeat still treats it as "due" - wide enough to
 * comfortably absorb the ticket's own 5-minute Hermes heartbeat cadence (plus normal scheduling
 * jitter) without ever missing a slot, narrow enough that a heartbeat which has been down for a
 * long stretch does not try to replay many hours of backlog at once (a slot older than this window
 * is simply left un-run for that day - not backdated, not silently skipped-and-forgotten: its row,
 * if any claim was ever attempted, keeps its real, original `dueAt`). */
export const SLOT_DUE_WINDOW_MINUTES = 10;

function targetMinutesForDay(): { slot: CaptureSlotKind; minute: number }[] {
  const targets: { slot: CaptureSlotKind; minute: number }[] = [{ slot: "OPENING", minute: OPENING_SLOT_MINUTE_ET }];
  for (let minute = OPENING_SLOT_MINUTE_ET + BASELINE_INTERVAL_MINUTES; minute < FINAL_SLOT_MINUTE_ET; minute += BASELINE_INTERVAL_MINUTES) {
    targets.push({ slot: "BASELINE", minute });
  }
  targets.push({ slot: "FINAL", minute: FINAL_SLOT_MINUTE_ET });
  return targets;
}

/**
 * Converts an America/New_York calendar date + minute-of-day back into the real UTC instant it
 * represents - DST-safe. Works by a one-step correction: guess the instant by treating the NY
 * wall-clock numbers as if they were UTC, read back what NY wall-clock time that guess ACTUALLY
 * corresponds to (via the same Intl-based nyMinuteOfDay this module already trusts), then shift by
 * the difference - which is exactly the real UTC offset for that date (a single whole-hour value
 * for America/New_York, so one correction always converges).
 */
function nyWallClockToInstant(sessionDate: CalendarDateString, minuteOfDay: number): Date {
  const { y, m, d } = parseCalendarDateString(sessionDate);
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const naiveUtc = new Date(Date.UTC(y, m - 1, d, hour, minute));
  const actualMinuteAtNaiveUtc = nyMinuteOfDay(naiveUtc);
  const deltaMinutes = minuteOfDay - actualMinuteAtNaiveUtc;
  return new Date(naiveUtc.getTime() + deltaMinutes * 60_000);
}

/**
 * The due slot(s) for `now`, if any. FINAL sits only 5 minutes after the last BASELINE target
 * (3:50 PM -> 3:55 PM), closer together than SLOT_DUE_WINDOW_MINUTES - so their due windows can
 * genuinely overlap for a few minutes. When more than one target minute is simultaneously within
 * its own due window, only the MOST RECENT (largest target minute) is returned: there is no value
 * in running two captures a few minutes apart for the same reason a heartbeat was briefly late,
 * and FINAL (the more urgent, end-of-day capture) naturally wins over a baseline it supersedes.
 * Empty on a non-NYSE-market day (weekend or algorithmically-known holiday) - zero slots, zero due
 * work, zero provider calls for that whole day.
 */
export function dueCaptureSlots(now: Date): DueCaptureSlot[] {
  if (!isNyseMarketDay(marketDate(now))) {
    return [];
  }
  const sessionDate = nyCalendarDateOf(now);
  const minuteNow = nyMinuteOfDay(now);

  const withinWindow = targetMinutesForDay().filter(({ minute }) => minuteNow >= minute && minuteNow < minute + SLOT_DUE_WINDOW_MINUTES);
  if (withinWindow.length === 0) {
    return [];
  }
  const mostRecent = withinWindow.reduce((latest, candidate) => (candidate.minute > latest.minute ? candidate : latest));
  return [{ slot: mostRecent.slot, sessionDate, dueAt: nyWallClockToInstant(sessionDate, mostRecent.minute) }];
}
