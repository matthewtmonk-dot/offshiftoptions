import { describe, expect, it } from "vitest";
import { schwabConnectionNotice } from "./schwab-connection-notice";

const now = new Date("2026-10-30T15:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

describe("schwabConnectionNotice", () => {
  it("never nags someone who has not connected, or who disconnected on purpose", () => {
    expect(schwabConnectionNotice({ status: null, connectedAt: null, now })).toBeNull();
    expect(schwabConnectionNotice({ status: "DISCONNECTED", connectedAt: daysAgo(30), now })).toBeNull();
  });
  it("EXPIRED (a refresh failed) is an expired notice", () => {
    expect(schwabConnectionNotice({ status: "EXPIRED", connectedAt: daysAgo(9), now })?.level).toBe("expired");
  });
  it("a healthy, recent connection shows nothing", () => {
    expect(schwabConnectionNotice({ status: "CONNECTED", connectedAt: daysAgo(1), now })).toBeNull();
    expect(schwabConnectionNotice({ status: "CONNECTED", connectedAt: daysAgo(4.9), now })).toBeNull();
  });
  it("warns in the last two days before the 7-day limit", () => {
    const notice = schwabConnectionNotice({ status: "CONNECTED", connectedAt: daysAgo(5.5), now });
    expect(notice).toMatchObject({ level: "soon", daysLeft: 2 });
    expect(schwabConnectionNotice({ status: "CONNECTED", connectedAt: daysAgo(6.5), now })).toMatchObject({ level: "soon", daysLeft: 1 });
  });
  it("says it has run out once 7 days have passed, even if the app hasn't noticed yet", () => {
    expect(schwabConnectionNotice({ status: "CONNECTED", connectedAt: daysAgo(7.1), now })?.level).toBe("expired");
  });
  it("shows nothing when the authorization time is unknown or unreadable", () => {
    expect(schwabConnectionNotice({ status: "CONNECTED", connectedAt: null, now })).toBeNull();
    expect(schwabConnectionNotice({ status: "CONNECTED", connectedAt: "not a date", now })).toBeNull();
  });
});
