import { describe, expect, it } from "vitest";
import { capitalDaysAtWork, capitalWeightedWeeklyReturn, netOptionCashFlowBetween } from "./weeklyScorecard";
import type { CampaignEventInput } from "./campaigns";

const ev = (type: CampaignEventInput["type"], day: string, premium: number, extra: Partial<CampaignEventInput> = {}): CampaignEventInput => ({
  type,
  occurredAt: new Date(`${day}T00:00:00Z`),
  contracts: 1,
  premium,
  ...extra,
});

describe("netOptionCashFlowBetween", () => {
  const events = [
    ev("SELL_PUT", "2026-10-12", 0.18, { fees: 0.66 }), // +18.00 - 0.66
    ev("ROLL_PUT_CLOSE", "2026-10-15", 1.77), // -177.00
    ev("ROLL_PUT_OPEN", "2026-10-15", 1.93), // +193.00
    ev("SELL_PUT", "2026-10-05", 0.5), // outside the window
    ev("NOTE", "2026-10-13", 9), // not an option cash event
  ];
  it("sums credits minus buy-backs minus fees inside the window only", () => {
    expect(netOptionCashFlowBetween(events, new Date("2026-10-12T00:00:00Z"), new Date("2026-10-16T23:59:59Z"))).toBe(33.34);
  });
  it("is zero for an empty window", () => {
    expect(netOptionCashFlowBetween(events, new Date("2026-11-01T00:00:00Z"), new Date("2026-11-07T00:00:00Z"))).toBe(0);
  });
  it("includes rolls as a debit plus a credit", () => {
    expect(netOptionCashFlowBetween(events, new Date("2026-10-15T00:00:00Z"), new Date("2026-10-15T00:00:00Z"))).toBe(16);
  });
});

describe("capitalWeightedWeeklyReturn", () => {
  it("weights by money set aside and time: $100 on $1,000 for 7d and $50 on $5,000 for 7d", () => {
    // (150) / ((1000 + 5000) * 1 week) = 2.5%
    const result = capitalWeightedWeeklyReturn([
      { gain: 100, capital: 1000, days: 7 },
      { gain: 50, capital: 5000, days: 7 },
    ]);
    expect(result?.weeklyPercent).toBe(2.5);
    expect(result?.counted).toBe(2);
  });
  it("skips rows without capital or days, and returns null when nothing counts", () => {
    expect(capitalWeightedWeeklyReturn([{ gain: 5, capital: null, days: 7 }, { gain: null, capital: 100, days: 7 }])).toBeNull();
    expect(capitalWeightedWeeklyReturn([])).toBeNull();
    expect(capitalWeightedWeeklyReturn([{ gain: 5, capital: 0, days: 7 }])).toBeNull();
  });
  it("a losing position pulls the average down", () => {
    expect(capitalWeightedWeeklyReturn([{ gain: -20, capital: 1000, days: 14 }])?.weeklyPercent).toBe(-1);
  });
});

describe("capitalDaysAtWork", () => {
  const openedAt = new Date("2026-07-01T00:00:00Z");
  const expiration = new Date("2026-07-24T00:00:00Z");
  const asOf = new Date("2026-10-17T12:00:00Z");
  const base = { status: "OPEN", daysActive: 108, openedAt, openPutExpiration: expiration, asOf } as const;

  it("stops the clock at the expiration of an OPEN campaign whose put already expired", () => {
    // Jul 1 -> Jul 24 = 23 days at work, not the 108 days to today.
    expect(capitalDaysAtWork(base)).toBe(23);
  });
  it("keeps the normal age while the put is still live, including on its expiration day", () => {
    expect(capitalDaysAtWork({ ...base, daysActive: 10, asOf: new Date("2026-07-11T12:00:00Z") })).toBe(10);
    expect(capitalDaysAtWork({ ...base, daysActive: 23, asOf: new Date("2026-07-24T20:00:00Z") })).toBe(23);
  });
  it("never lengthens a campaign and never drops below one day", () => {
    expect(capitalDaysAtWork({ ...base, daysActive: 5 })).toBe(5);
    expect(capitalDaysAtWork({ ...base, openedAt: new Date("2026-07-24T00:00:00Z"), daysActive: 108 })).toBe(1);
  });
  it("leaves assigned and closed campaigns alone - the money kept working as shares / the age is final", () => {
    expect(capitalDaysAtWork({ ...base, status: "ASSIGNED" })).toBe(108);
    expect(capitalDaysAtWork({ ...base, status: "CLOSED" })).toBe(108);
  });
  it("passes through unknowns instead of guessing", () => {
    expect(capitalDaysAtWork({ ...base, daysActive: null })).toBeNull();
    expect(capitalDaysAtWork({ ...base, openPutExpiration: null })).toBe(108);
    expect(capitalDaysAtWork({ ...base, openedAt: null })).toBe(108);
  });
});
