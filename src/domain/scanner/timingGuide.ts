import { isNyseMarketDay } from "@/domain/finance/marketCalendar";

/**
 * Scanner "when should I use this?" guide - a pure, read-only TIMING AID, never a trade
 * instruction. It maps the current America/New_York day/time onto the app's own verified working
 * schedule (see lstCheckpoint.ts: Monday entry window ~10:30 AM-12:30 PM ET, Mon-Thu position check
 * ~3:00 PM ET, Friday Roll Call ~3:00 PM ET) and onto how the scanner's own data actually behaves:
 *
 *  - RSI / Bollinger values come from the previous COMPLETED daily candle, prepared by a scheduled
 *    job (weekday mornings 5:45-9:15 AM ET; Saturday catch-up 5:45 AM-12:00 PM ET, which is what makes
 *    Friday's close available for weekend research).
 *  - Option prices on a weekend/holiday are the last close's quotes: fine for building a shortlist,
 *    but premiums reset when the market reopens, so entries are confirmed with a fresh scan after
 *    the opening volatility settles.
 *
 * DST-safe: uses Intl with America/New_York, never a fixed UTC offset.
 */
export type ScannerTimingPhase =
  | "WEEKEND_DATA_PREPARING"
  | "WEEKEND_RESEARCH"
  | "PREMARKET"
  | "OPENING_SETTLE"
  | "ENTRY_WINDOW"
  | "MIDDAY"
  | "POSITION_CHECK"
  | "AFTER_CLOSE"
  | "MARKET_HOLIDAY";

export type ScannerTimingGuide = {
  phase: ScannerTimingPhase;
  headline: string;
  detail: string;
  /** "caution" when running the scanner right now is likely to show unsettled or incomplete data. */
  tone: "info" | "caution";
};

const MARKET_OPEN_MINUTES = 9 * 60 + 30;
const SETTLE_END_MINUTES = 10 * 60 + 30;
const ENTRY_WINDOW_END_MINUTES = 12 * 60 + 30;
const POSITION_CHECK_MINUTES = 15 * 60;
const MARKET_CLOSE_MINUTES = 16 * 60;
const SATURDAY_DATA_READY_MINUTES = 12 * 60;

function easternParts(now: Date): { weekday: string; minutes: number; dateUtc: Date } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    weekday: get("weekday"),
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
    dateUtc: new Date(Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")))),
  };
}

export function scannerTimingGuide(now: Date = new Date()): ScannerTimingGuide {
  const { weekday, minutes, dateUtc } = easternParts(now);
  const weekend = weekday === "Sat" || weekday === "Sun";

  if (weekday === "Sat" && minutes < SATURDAY_DATA_READY_MINUTES) {
    return {
      phase: "WEEKEND_DATA_PREPARING",
      headline: "Friday's data is still being prepared",
      detail: "Fresh RSI and Bollinger values for Friday's close finish by about noon ET on Saturday. Wait until then, or later this weekend, for a complete scan.",
      tone: "caution",
    };
  }
  if (weekend) {
    return {
      phase: "WEEKEND_RESEARCH",
      headline: "Good time to build your Monday shortlist",
      detail: "RSI and Bollinger reflect Friday's close. Run the scan, price the candidates' options, and save the ones you like to Research. Weekend option prices are Friday's close and move at Monday's open, so confirm with a fresh scan after 10:30 AM ET before entering anything.",
      tone: "info",
    };
  }
  if (!isNyseMarketDay(dateUtc)) {
    return {
      phase: "MARKET_HOLIDAY",
      headline: "Market closed today",
      detail: "Prices shown are from the last session. Use today to research, and confirm with a fresh scan on the next trading day after 10:30 AM ET.",
      tone: "info",
    };
  }
  if (minutes < MARKET_OPEN_MINUTES) {
    return {
      phase: "PREMARKET",
      headline: "Pre-market - research only",
      detail: "Fresh RSI and Bollinger are ready by about 9:15 AM ET. Option prices aren't reliable until after the open, so treat anything you see now as a shortlist, not an entry.",
      tone: "caution",
    };
  }
  if (minutes < SETTLE_END_MINUTES) {
    return {
      phase: "OPENING_SETTLE",
      headline: "Let the open settle",
      detail: "Option spreads are widest and prices swing hardest in the first hour. Wait until about 10:30 AM ET before judging premiums.",
      tone: "caution",
    };
  }
  if (weekday === "Mon" && minutes < ENTRY_WINDOW_END_MINUTES) {
    return {
      phase: "ENTRY_WINDOW",
      headline: "Monday entry window - best time to confirm",
      detail: "Run a fresh scan now. Only candidates that still PASS with current option prices are worth acting on; anything that dropped out has changed since the weekend.",
      tone: "info",
    };
  }
  if (minutes < POSITION_CHECK_MINUTES) {
    return {
      phase: "MIDDAY",
      headline: weekday === "Mon" ? "Past the main entry window" : "Mid-week - scanner is for fill-in ideas",
      detail: "Most of the weekly setup work happens Saturday to Monday morning. Midweek, spend your time on open positions - the Dashboard's 3:00 PM ET check is the main one.",
      tone: "info",
    };
  }
  if (minutes < MARKET_CLOSE_MINUTES) {
    return {
      phase: "POSITION_CHECK",
      headline: weekday === "Fri" ? "Friday roll call - manage positions first" : "Position check time",
      detail: weekday === "Fri"
        ? "Review expiring positions on the Dashboard before anything else. New-entry research can wait until Saturday afternoon, after Friday's close data is ready."
        : "Review open positions on the Dashboard. The scanner is secondary right now.",
      tone: "info",
    };
  }
  return {
    phase: "AFTER_CLOSE",
    headline: weekday === "Fri" ? "Week is done - research starts Saturday afternoon" : "Market closed",
    detail: weekday === "Fri"
      ? "RSI and Bollinger for today's close are prepared overnight and finish by about noon ET Saturday. Run your weekend scan then."
      : "RSI and Bollinger update with tomorrow morning's data preparation (done by about 9:15 AM ET). Option prices shown are from today's close.",
    tone: "info",
  };
}

const PREP_START_MINUTES = 5 * 60 + 45;
const PREP_WEEKDAY_USUAL_END_MINUTES = 9 * 60 + 15;
const PREP_WEEKDAY_END_MINUTES = 11 * 60 + 30;
const PREP_SATURDAY_END_MINUTES = 12 * 60;

/**
 * One plain sentence for the "technical data is not current" warning: WHEN fresh RSI / Bollinger
 * values will be ready, matching the scheduled preparation job's real windows (weekday mornings
 * 5:45 AM-11:30 AM ET - usually finished by about 9:15 - Saturday 5:45 AM-12:00 PM ET). If the window has already passed and the data is
 * still stale, it says so plainly instead of promising it will arrive.
 */
export function technicalReadyHint(now: Date = new Date()): string {
  const { weekday, minutes, dateUtc } = easternParts(now);
  const marketDay = isNyseMarketDay(dateUtc);

  if (weekday === "Sat") {
    if (minutes < PREP_START_MINUTES) return "Friday's data starts preparing at 5:45 AM ET today and finishes by about noon ET. Run the scan again after that.";
    if (minutes <= PREP_SATURDAY_END_MINUTES) return "Friday's data is being prepared right now and finishes by about noon ET. Run the scan again then.";
  } else if (marketDay) {
    if (minutes < PREP_START_MINUTES) return "Yesterday's close is prepared starting at 5:45 AM ET and is usually done by about 9:15 AM ET. Run the scan again after that.";
    if (minutes <= PREP_WEEKDAY_USUAL_END_MINUTES) return "Yesterday's close is being prepared right now and is usually done by about 9:15 AM ET. Run the scan again then.";
    if (minutes <= PREP_WEEKDAY_END_MINUTES) return "Yesterday's close is still being prepared (it can run until about 11:30 AM ET if the data was published late). Run the scan again in a few minutes.";
  }
  return "The scheduled preparation window for this data has already passed. Press Prepare data now to fill it in yourself.";
}
