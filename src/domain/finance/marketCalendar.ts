/**
 * A minimal, deterministic NYSE full-day-closure calendar - computed algorithmically per
 * calendar year (no network call, no external dependency, no fixed lookup table to maintain),
 * so it keeps working for any future year without upkeep. Covers the standard, currently
 * observed NYSE holidays: New Year's Day, MLK Day, Presidents Day, Good Friday, Memorial Day,
 * Juneteenth (observed from 2022 onward), Independence Day, Labor Day, Thanksgiving, and
 * Christmas, including the New Year Saturday exception (the prior Friday remains open).
 *
 * Known, documented limitation: extraordinary one-off market closures (a national day of
 * mourning, a weather/system closure, etc.) are NOT modeled here - there is no reliable
 * algorithmic way to predict those, and this deliberately does not guess.
 */

export function isNyseMarketDay(date: Date): boolean {
  const weekday = date.getUTCDay(); // 0=Sun..6=Sat
  if (weekday === 0 || weekday === 6) {
    return false;
  }
  return !nyseHolidaysForYear(date.getUTCFullYear()).has(dateKeyOf(date));
}

/** The first NYSE market day strictly after `date` (skips weekends and NYSE holidays). */
export function nextNyseMarketDay(date: Date): Date {
  let candidate = addDaysUtc(date, 1);
  while (!isNyseMarketDay(candidate)) {
    candidate = addDaysUtc(candidate, 1);
  }
  return candidate;
}

/** The last NYSE market day strictly BEFORE `date` (skips weekends and NYSE holidays) - the
 * symmetric counterpart to nextNyseMarketDay, used to determine "the most recent trading day
 * whose close has already happened" for daily-candle-based data freshness checks (see
 * technical-indicator-cache.ts). */
export function previousNyseMarketDay(date: Date): Date {
  let candidate = addDaysUtc(date, -1);
  while (!isNyseMarketDay(candidate)) {
    candidate = addDaysUtc(candidate, -1);
  }
  return candidate;
}

export type MarkFreshness =
  /** Captured on today's calendar date, AND today is an NYSE market day. Safe to describe as
   * "today's" data - never claims a specific intraday time, since a snapshot's own timestamp is
   * the only intraday precision this policy uses (see the file-level note on why no finer-grained
   * "is the market open right now" check exists here). */
  | "CURRENT_SESSION"
  /** Captured on the most recent NYSE market day strictly before `now` - the honest "last known"
   * answer while markets are closed (weekend/holiday) or before today's own data has arrived.
   * Must be labeled "as of last session," never presented as a live/executable quote. */
  | "LAST_SESSION"
  /** Older than the last completed session - two or more trading days behind `now`. No longer
   * trustworthy as a current valuation input. */
  | "STALE"
  /** No timestamp at all - cannot be trusted as current by construction. */
  | "MISSING";

/** Session-level freshness of a VERIFIED valuation timestamp, never a retrieval timestamp.
 * Both instants use America/New_York calendar dates; expiration comparisons elsewhere stay UTC.
 * This does not assert intraday/live precision. A non-session valuation date is not evidence of
 * a market session, and an invalid/future timestamp is unusable rather than clamped to today.
 */
export function classifyMarkFreshness(asOf: Date | null, now: Date): MarkFreshness {
  if (!asOf || !Number.isFinite(asOf.getTime()) || !Number.isFinite(now.getTime())) return "MISSING";
  if (asOf.getTime() > now.getTime()) return "STALE";
  const today = marketDate(now);
  const valuationDay = marketDate(asOf);
  if (!isNyseMarketDay(valuationDay)) return "MISSING";
  if (isNyseMarketDay(today) && valuationDay.getTime() === today.getTime()) return "CURRENT_SESSION";
  return valuationDay.getTime() === previousNyseMarketDay(today).getTime() ? "LAST_SESSION" : "STALE";
}

/** Retrieval recency for an UNVERIFIED broker snapshot - deliberately separate from
 * classifyMarkFreshness, which answers a different question (was this priced during a real
 * market session). A retrieval can happen on any calendar day, including a weekend or holiday,
 * and a fresh weekend/holiday retrieval must not be rejected merely because that calendar day
 * itself never traded - `classifyMarkFreshness` would otherwise classify it MISSING regardless of
 * how recent it is. The acceptance window is the most recently completed-or-current session's
 * calendar day plus the session immediately before it (the same two-session conservatism
 * `classifyMarkFreshness` uses for CURRENT_SESSION/LAST_SESSION), but membership in the window is
 * judged by real elapsed calendar days, not by requiring the retrieval's own day to have traded.
 * This never returns or implies a session label - callers must not present a true result as
 * CURRENT_SESSION/LAST_SESSION.
 */
export function isRecentRetrieval(observedAt: Date | null, now: Date): boolean {
  if (!observedAt || !Number.isFinite(observedAt.getTime()) || !Number.isFinite(now.getTime())) return false;
  if (observedAt.getTime() > now.getTime()) return false;
  const today = marketDate(now);
  const retrievalDay = marketDate(observedAt);
  const referenceSessionDay = isNyseMarketDay(today) ? today : previousNyseMarketDay(today);
  const windowStart = previousNyseMarketDay(referenceSessionDay);
  return retrievalDay.getTime() >= windowStart.getTime() && retrievalDay.getTime() <= today.getTime();
}

const marketDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});

function marketDate(instant: Date): Date {
  const parts = marketDateFormatter.formatToParts(instant);
  const value = (type: string) => Number(parts.find((part) => part.type === type)!.value);
  return new Date(Date.UTC(value("year"), value("month") - 1, value("day")));
}

const holidayCache = new Map<number, Set<string>>();

function nyseHolidaysForYear(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) {
    return cached;
  }

  const holidays = new Set<string>();

  // NYSE does not observe Saturday New Year's Day on the prior year-end Friday.
  if (new Date(Date.UTC(year, 0, 1)).getUTCDay() !== 6) addObserved(holidays, year, 1, 1);

  addDate(holidays, nthWeekdayOfMonth(year, 1, 1, 3)); // MLK Day: 3rd Monday of January
  addDate(holidays, nthWeekdayOfMonth(year, 2, 1, 3)); // Presidents Day: 3rd Monday of February
  addDate(holidays, addDaysUtc(easterSunday(year), -2)); // Good Friday: 2 days before Easter Sunday
  addDate(holidays, lastWeekdayOfMonth(year, 5, 1)); // Memorial Day: last Monday of May
  if (year >= 2022) {
    addObserved(holidays, year, 6, 19); // Juneteenth (NYSE began observing in 2022)
  }
  addObserved(holidays, year, 7, 4); // Independence Day
  addDate(holidays, nthWeekdayOfMonth(year, 9, 1, 1)); // Labor Day: 1st Monday of September
  addDate(holidays, nthWeekdayOfMonth(year, 11, 4, 4)); // Thanksgiving: 4th Thursday of November
  addObserved(holidays, year, 12, 25); // Christmas

  holidayCache.set(year, holidays);
  return holidays;
}

function toKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dateKeyOf(date: Date): string {
  return toKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function addDate(holidays: Set<string>, date: Date) {
  holidays.add(dateKeyOf(date));
}

function addDaysUtc(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

/** Adds `month/day` to the set, shifted to the preceding Friday if it falls on a Saturday, or
 * the following Monday if it falls on a Sunday - the standard NYSE observed-holiday rule. */
function addObserved(holidays: Set<string>, year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay();
  if (weekday === 6) {
    addDate(holidays, addDaysUtc(date, -1));
  } else if (weekday === 0) {
    addDate(holidays, addDaysUtc(date, 1));
  } else {
    addDate(holidays, date);
  }
}

/** The `n`-th occurrence of `weekday` (0=Sun..6=Sat) in `month` of `year`. */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month - 1, 1 + offset + (n - 1) * 7));
}

/** The last occurrence of `weekday` (0=Sun..6=Sat) in `month` of `year`. */
function lastWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)); // day 0 of next month = last day of this one
  const offset = (lastDayOfMonth.getUTCDay() - weekday + 7) % 7;
  return addDaysUtc(lastDayOfMonth, -offset);
}

/** Easter Sunday (Gregorian) via the Meeus/Jones/Butcher algorithm. */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}
