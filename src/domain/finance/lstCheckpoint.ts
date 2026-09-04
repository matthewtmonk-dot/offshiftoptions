/**
 * Compact "Next LST Checkpoint" reminder for the Dashboard - a read-only timing aid, not a
 * trading rule. Uses the same dependency-free `Intl.DateTimeFormat`/`America/New_York` pattern
 * as `rollStatus.ts`'s Friday management checkpoint, so both stay DST-safe without a timezone
 * library. Deliberately does not claim 10:30 AM is a mandatory exact entry minute, or that
 * 3:30 PM is the Friday checkpoint - the schedule below is described as "around"/"roughly" per
 * the verified working schedule, and only ever surfaces a compact label, never an instruction
 * to place a trade (no order/automation behavior of any kind).
 */

export type LstCheckpointLabel =
  | "Entry review begins around 10:30 AM ET"
  | "Monday entry window · setups still must qualify"
  | "Next position check · 3:00 PM ET"
  | "Friday Roll Call · 3:00 PM ET"
  | "Next entry review · Monday 10:30 AM ET";

const MONDAY_ENTRY_WINDOW_START_MINUTES = 10 * 60 + 30;
const MONDAY_ENTRY_WINDOW_END_MINUTES = 12 * 60 + 30;
const MANAGEMENT_CHECKPOINT_MINUTES = 15 * 60;

function easternWeekdayAndMinutes(now: Date): { weekday: string; minutesSinceMidnight: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return { weekday, minutesSinceMidnight: hour * 60 + minute };
}

/**
 * Returns the single compact label for "what's next" per the verified working schedule:
 * Monday entry/setup review roughly 10:30 AM-12:30 PM ET, a Monday-Thursday position-management
 * check around 3:00 PM ET, and Friday's Roll Call/management checkpoint around 3:00 PM ET.
 */
export function getNextLstCheckpointLabel(now: Date = new Date()): LstCheckpointLabel {
  const { weekday, minutesSinceMidnight } = easternWeekdayAndMinutes(now);

  if (weekday === "Sat" || weekday === "Sun") {
    return "Next entry review · Monday 10:30 AM ET";
  }

  if (weekday === "Fri") {
    return minutesSinceMidnight >= MANAGEMENT_CHECKPOINT_MINUTES
      ? "Next entry review · Monday 10:30 AM ET"
      : "Friday Roll Call · 3:00 PM ET";
  }

  if (weekday === "Thu" && minutesSinceMidnight >= MANAGEMENT_CHECKPOINT_MINUTES) {
    return "Friday Roll Call · 3:00 PM ET";
  }

  if (weekday === "Mon") {
    if (minutesSinceMidnight < MONDAY_ENTRY_WINDOW_START_MINUTES) {
      return "Entry review begins around 10:30 AM ET";
    }
    if (minutesSinceMidnight < MONDAY_ENTRY_WINDOW_END_MINUTES) {
      return "Monday entry window · setups still must qualify";
    }
  }

  return "Next position check · 3:00 PM ET";
}
