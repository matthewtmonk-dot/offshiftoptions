import { normalizeTicker } from "./tickers";

export function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    return Number(value);
  }

  if (value && typeof value === "object") {
    const candidate = value as { toNumber?: () => number; toString?: () => string };
    if (typeof candidate.toNumber === "function") {
      return candidate.toNumber();
    }
    if (typeof candidate.toString === "function") {
      return Number(candidate.toString());
    }
  }

  return Number(value ?? 0);
}

export function money(value: unknown, digits = 2) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(toNumber(value));
}

export function percent(value: unknown, digits = 2) {
  return `${toNumber(value).toFixed(digits)}%`;
}

export function shortDate(value: Date | string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

export function shortDateTime(value: Date | string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

/**
 * For date-only financial concepts (trade date, option expiration, campaign opened/closed date)
 * that are stored as a UTC-midnight instant with no real time-of-day meaning - see
 * parseDateInput in workflows.ts, where a bare "YYYY-MM-DD" always parses to UTC midnight per
 * the ECMAScript Date spec. Formatting that through shortDate/shortDateTime (which use the
 * runtime's local timezone) shifts the displayed calendar day backward by one whenever the
 * local zone is behind UTC - confirmed live: this deployment's runtime default timezone is
 * America/New_York, so 2026-09-04T00:00:00.000Z rendered that way shows "Sep 3, 8:00 PM"
 * instead of "Sep 4". Reading the date back using UTC components preserves the calendar date
 * exactly, regardless of the runtime's local timezone. Never use this for a value with genuine
 * time-of-day meaning (a real trade execution timestamp, a sync time, a notification's
 * created-at) - those should keep using shortDate/shortDateTime.
 */
export function shortCalendarDate(value: Date | string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

/**
 * Dashboard V2 Phase 2 - a genuine time-of-day instant (e.g. a quote's own trade time), always
 * rendered in America/New_York regardless of the runtime's local timezone, since that's the
 * timezone every review-price/session-evidence rule in this app is defined against. Deliberately
 * a plain "ET" suffix rather than Intl's EST/EDT distinction - the ticket's own display examples
 * use exactly this level of precision ("Price as of 3:58 PM ET").
 */
export function formatEtTime(value: Date | string) {
  const formatted = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(new Date(value));
  return `${formatted} ET`;
}

export function upperTicker(value: FormDataEntryValue | null) {
  return normalizeTicker(value);
}
