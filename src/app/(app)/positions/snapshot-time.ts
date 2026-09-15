/** Explicit ET timestamps are stable across server timezone and the viewer's device. */
export function snapshotTime(value: Date | string | null | undefined): string {
  const date = value ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return "Not recorded";
  return date.toLocaleString("en-US", {
    timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
}
