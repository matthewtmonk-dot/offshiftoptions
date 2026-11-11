/**
 * One plain line at the top of the Dashboard when the brokerage data behind it needs attention. Pure (no server
 * imports) so it is unit-tested; the Dashboard passes in what it already reads.
 *
 * Why: the Account page already reports that the last automatic position capture hit a problem (for example
 * "evidence contradiction found"), and how old the last Brokerage Sync is - but the Dashboard only said
 * "Current position status unavailable", so the cause was two clicks away. This repeats the SAME label the Account
 * page shows (`describeScheduledCaptureStatus`), never a second interpretation of it.
 *
 * It does not cover an expired Schwab sign-in: `SchwabConnectionBanner` in the signed-in layout already does.
 */

export const STALE_SYNC_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export type DashboardSyncNotice = { title: string; detail: string };

export function dashboardSyncNotice(input: {
  /** Output of describeScheduledCaptureStatus for the latest concluded capture, or null when none is known. */
  capture: { label: string; tone: "healthy" | "neutral" | "attention"; at: Date } | null;
  /** BrokerConnection.lastAccountSyncAt; null = never synced; undefined = no brokerage connection at all. */
  lastAccountSyncAt: Date | null | undefined;
  now: Date;
}): DashboardSyncNotice | null {
  const { capture, lastAccountSyncAt, now } = input;
  // No brokerage connection (manual/demo accounts): nothing to be out of date with.
  if (lastAccountSyncAt === undefined) return null;

  const syncAgeDays = lastAccountSyncAt ? Math.floor((now.getTime() - lastAccountSyncAt.getTime()) / DAY_MS) : null;
  const syncAgeText =
    lastAccountSyncAt === null
      ? "Brokerage Sync has never run"
      : syncAgeDays === 0
        ? "Last Brokerage Sync was today"
        : `Last Brokerage Sync was ${syncAgeDays} day${syncAgeDays === 1 ? "" : "s"} ago`;

  if (capture && capture.tone === "attention") {
    return {
      title: `Position check needs attention: ${capture.label}`,
      detail: `${syncAgeText}. Run Brokerage Sync on the Account page, then press Refresh status.`,
    };
  }
  if (lastAccountSyncAt === null || (syncAgeDays !== null && syncAgeDays >= STALE_SYNC_DAYS)) {
    return {
      title: `${syncAgeText}`,
      detail: "Balances, positions and results below may be out of date. Run Brokerage Sync on the Account page.",
    };
  }
  return null;
}
