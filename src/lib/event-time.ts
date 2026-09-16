const timezone = "America/New_York";
const day = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
const clock = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const date = new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric", year: "numeric" });

/** Genuine event instants only, not date-only contract expirations. */
export function eventTime(value: Date, asOf: Date = new Date()) {
  const full = `${date.format(value)}, ${clock.format(value)}`;
  return { label: day.format(value) === day.format(asOf) ? `Today, ${clock.format(value)}` : full, full };
}
