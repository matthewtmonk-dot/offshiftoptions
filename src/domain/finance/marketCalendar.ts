/**
 * A minimal, deterministic NYSE full-day-closure calendar - computed algorithmically per
 * calendar year (no network call, no external dependency, no fixed lookup table to maintain),
 * so it keeps working for any future year without upkeep. Covers the standard, currently
 * observed NYSE holidays: New Year's Day, MLK Day, Presidents Day, Good Friday, Memorial Day,
 * Juneteenth (observed from 2022 onward), Independence Day, Labor Day, Thanksgiving, and
 * Christmas - each with the standard Saturday-observe-Friday / Sunday-observe-Monday shift.
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

const holidayCache = new Map<number, Set<string>>();

function nyseHolidaysForYear(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) {
    return cached;
  }

  const holidays = new Set<string>();

  addObserved(holidays, year, 1, 1); // New Year's Day
  // If NEXT year's New Year's Day falls on a Saturday, NYSE observes it on Dec 31 of THIS year.
  if (new Date(Date.UTC(year + 1, 0, 1)).getUTCDay() === 6) {
    holidays.add(toKey(year, 12, 31));
  }

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
