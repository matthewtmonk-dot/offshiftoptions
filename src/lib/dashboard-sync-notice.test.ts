import { describe, expect, it } from "vitest";
import { dashboardSyncNotice } from "./dashboard-sync-notice";

const now = new Date("2026-11-11T18:40:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

describe("dashboardSyncNotice", () => {
  it("shows nothing when the last capture was healthy and the sync is recent", () => {
    expect(dashboardSyncNotice({ capture: { label: "Healthy - last successful current capture", tone: "healthy", at: now }, lastAccountSyncAt: daysAgo(1), now })).toBeNull();
  });

  it("shows nothing for a neutral capture result (market closed, nothing to check)", () => {
    expect(dashboardSyncNotice({ capture: { label: "No current assessment captured - market closed at last check", tone: "neutral", at: now }, lastAccountSyncAt: daysAgo(2), now })).toBeNull();
  });

  it("repeats the Account page's own label when the last capture needs attention", () => {
    const notice = dashboardSyncNotice({
      capture: { label: "Connection attention needed - evidence contradiction found", tone: "attention", at: now },
      lastAccountSyncAt: daysAgo(2),
      now,
    });
    expect(notice).toEqual({
      title: "Position check needs attention: Connection attention needed - evidence contradiction found",
      detail: "Last Brokerage Sync was 2 days ago. Run Brokerage Sync on the Account page, then press Refresh status.",
    });
  });

  it("warns when the sync is three or more days old even with no capture problem", () => {
    expect(dashboardSyncNotice({ capture: null, lastAccountSyncAt: daysAgo(2.9), now })).toBeNull();
    expect(dashboardSyncNotice({ capture: null, lastAccountSyncAt: daysAgo(3), now })?.title).toBe("Last Brokerage Sync was 3 days ago");
  });

  it("warns when a connected brokerage has never synced, and stays quiet with no connection at all", () => {
    expect(dashboardSyncNotice({ capture: null, lastAccountSyncAt: null, now })?.title).toBe("Brokerage Sync has never run");
    expect(dashboardSyncNotice({ capture: { label: "x", tone: "attention", at: now }, lastAccountSyncAt: undefined, now })).toBeNull();
  });

  it("uses singular wording for one day and 'today' for the same day", () => {
    const attention = { label: "Connection attention needed - last attempt failed", tone: "attention" as const, at: now };
    expect(dashboardSyncNotice({ capture: attention, lastAccountSyncAt: daysAgo(1), now })?.detail).toMatch(/^Last Brokerage Sync was 1 day ago\./);
    expect(dashboardSyncNotice({ capture: attention, lastAccountSyncAt: daysAgo(0.2), now })?.detail).toMatch(/^Last Brokerage Sync was today\./);
  });
});
