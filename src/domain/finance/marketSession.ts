import type { EquityMarketSessionEvidence, EquityRegularSessionInterval } from "@/providers/market-data/types";

/**
 * Dashboard V2 Phase 2 - pure market-session domain helpers. No Schwab-shape parsing lives here
 * (see src/providers/schwab/normalizers.ts's normalizeSchwabEquityMarketSessionEvidence for that)
 * - this module only works with the already-validated EquityMarketSessionEvidence type, plus the
 * NY-calendar-date arithmetic every part of Phase 2 needs (review "today," DTE, expiration-day
 * state). Never a database write, never a network call, never an AI/scoring decision.
 */

/** "YYYY-MM-DD" calendar-date string, explicitly scoped to one timezone convention per call site -
 * either the America/New_York wall-clock date (nyCalendarDateOf) or a stored UTC-midnight
 * calendar-date label (expirationCalendarDate) - the two are never interchanged. */
export type CalendarDateString = string;

/** The America/New_York wall-clock calendar date for a given instant - "review today," never the
 * UTC date, which can differ from NY's date near midnight UTC. */
export function nyCalendarDateOf(instant: Date): CalendarDateString {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

const nyWallClockFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** The America/New_York wall-clock minute-of-day (0-1439) for a given instant - DST-safe (via
 * Intl, never a fixed UTC-offset assumption, matching this file's own nyCalendarDateOf and
 * technical-preparation-orchestrator.ts's identical nyDateTimeParts convention). Purely a wall-
 * clock reading - never itself a claim about whether the market is open (that requires real,
 * provider-verified EquityMarketSessionEvidence, which this function does not fetch or consult). */
export function nyMinuteOfDay(instant: Date): number {
  const parts = nyWallClockFormatter.formatToParts(instant);
  const hour = Number(parts.find((part) => part.type === "hour")!.value) % 24;
  const minute = Number(parts.find((part) => part.type === "minute")!.value);
  return hour * 60 + minute;
}

/**
 * A stored expiration/occurredAt Date's own calendar-date LABEL, read via UTC components - never
 * converted through any timezone. Matches this project's own established convention (see
 * format.ts's shortCalendarDate doc comment): a bare "YYYY-MM-DD" always parses to UTC midnight,
 * so reading it back through UTC components (not a local/NY wall clock) is the only way to
 * recover the exact calendar date that was actually stored, regardless of the runtime's timezone.
 * The ticket's own instruction: "Do not timezone-convert midnight UTC into the prior evening."
 */
export function expirationCalendarDate(expiration: Date): CalendarDateString {
  return expiration.toISOString().slice(0, 10);
}

export function parseCalendarDateString(value: CalendarDateString): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) throw new RangeError(`Expected a YYYY-MM-DD calendar date, got "${value}".`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

/** Pure calendar-day difference (toStr - fromStr), never a business-day count - weekends and
 * holidays count exactly like any other day. today=0, tomorrow=1, per the ticket's own contract. */
export function daysBetweenCalendarDates(fromStr: CalendarDateString, toStr: CalendarDateString): number {
  const from = parseCalendarDateString(fromStr);
  const to = parseCalendarDateString(toStr);
  const fromUtc = Date.UTC(from.y, from.m - 1, from.d);
  const toUtc = Date.UTC(to.y, to.m - 1, to.d);
  return Math.round((toUtc - fromUtc) / 86_400_000);
}

/** Days-to-expiration as of `now` (America/New_York "today") - today=0, tomorrow=1, including
 * weekends. Negative once the stored expiration calendar date is already in the past. */
export function daysToExpiration(expiration: Date, now: Date = new Date()): number {
  return daysBetweenCalendarDates(nyCalendarDateOf(now), expirationCalendarDate(expiration));
}

/** Regular-session MEMBERSHIP is half-open: start <= instant < end (the ticket's own exact
 * convention) - never inclusive of the closing instant itself. */
export function regularSessionIntervalContaining(
  evidence: EquityMarketSessionEvidence,
  instant: Date,
): EquityRegularSessionInterval | null {
  if (evidence.status !== "AVAILABLE") return null;
  const t = instant.getTime();
  return evidence.regularMarketIntervals.find((interval) => interval.start.getTime() <= t && t < interval.end.getTime()) ?? null;
}

/** Whether `instant` falls inside ANY validated regularMarket interval for this evidence. Does
 * NOT by itself mean "the market is open right now" in a broader sense - only that this specific
 * instant is within a regular trading interval this evidence actually reported. */
export function isWithinRegularSession(evidence: EquityMarketSessionEvidence, instant: Date): boolean {
  return regularSessionIntervalContaining(evidence, instant) !== null;
}

/** The latest regularMarket interval's own end instant - "when did today's regular session
 * close," used for the Phase-2-specific "Expiration session ended" state. Null when evidence is
 * unavailable or reports no regular-session intervals at all (e.g. a genuine market holiday). */
export function regularSessionCloseInstant(evidence: EquityMarketSessionEvidence): Date | null {
  if (evidence.status !== "AVAILABLE" || evidence.regularMarketIntervals.length === 0) return null;
  return evidence.regularMarketIntervals.reduce((latest, interval) => (interval.end.getTime() > latest.getTime() ? interval.end : latest), evidence.regularMarketIntervals[0]!.end);
}
