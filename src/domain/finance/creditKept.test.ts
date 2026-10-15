import { describe, expect, it } from "vitest";
import { summarizeOpenPutCreditKept, type CreditKeptCampaignInput } from "./creditKept";
import type { LinkedPositionRecordInput } from "./currentPositionMark";

// Wed Oct 14 2026, 6:00 PM ET - a real NYSE trading day, after the close.
const NOW = new Date("2026-10-14T22:00:00Z");
const OBSERVED = new Date("2026-10-14T19:55:00Z"); // 3:55 PM ET snapshot

function corz(premiumPerShare: number, overrides: Partial<CreditKeptCampaignInput> = {}): CreditKeptCampaignInput {
  return {
    status: "OPEN",
    accountId: "acct-1",
    ticker: "CORZ",
    events: [{ type: "SELL_PUT", optionType: "PUT", occurredAt: "2026-10-09", strike: 14.5, contracts: 1, premium: premiumPerShare, expiration: "2026-10-16" }],
    ...overrides,
  };
}

function position(amount: number, overrides: Partial<LinkedPositionRecordInput> = {}): LinkedPositionRecordInput {
  return {
    accountId: "acct-1",
    symbol: "CORZ  261016P00014500",
    underlyingSymbol: "CORZ",
    quantity: -1,
    amount,
    observedAt: OBSERVED,
    metadata: null, // no verified pricing time -> an honest broker snapshot
    ...overrides,
  };
}

const run = (campaign: CreditKeptCampaignInput, linkedRecords: LinkedPositionRecordInput[], feesFullyKnown = true) =>
  summarizeOpenPutCreditKept({ campaign, linkedRecords, optionMark: null, feesFullyKnown, now: NOW });

describe("summarizeOpenPutCreditKept", () => {
  it("the real CORZ case: sold at $0.18, now marked $0.19 -> costs $1 more than collected (-5.6%), flagged provisional", () => {
    const result = run(corz(0.18), [position(-19)])!;
    expect(result.netCredit).toBe(18);
    expect(result.costToClose).toBe(19);
    expect(result.keptAmount).toBe(-1);
    expect(result.keptPercent).toBe(-5.6);
    // No verified pricing time -> a snapshot, never presented as confirmed.
    expect(result.provisional).toBe(true);
    expect(result.verifiedPricingTime).toBe(false);
  });

  it("a put that has mostly decayed keeps most of its credit", () => {
    const result = run(corz(0.5), [position(-10)])!;
    expect(result.keptAmount).toBe(40);
    expect(result.keptPercent).toBe(80);
  });

  it("a verified pricing time with known fees is the only way to be non-provisional", () => {
    const verified = position(-10, { metadata: { valuationAsOf: OBSERVED.toISOString() } });
    expect(run(corz(0.5), [verified], true)!.provisional).toBe(false);
    expect(run(corz(0.5), [verified], false)!.provisional).toBe(true); // fees unresolved
  });

  it("returns null - never a guess - when there is no mark at all", () => {
    expect(run(corz(0.5), [])).toBeNull();
  });

  it("returns null when the broker position is a different size than the campaign's leg", () => {
    expect(run(corz(0.5), [position(-20, { quantity: -2 })])).toBeNull();
  });

  it("returns null when the broker position is a different contract (strike) than the open leg", () => {
    expect(run(corz(0.5), [position(-10, { symbol: "CORZ  261016P00015000" })])).toBeNull();
  });

  it("returns null when the broker position belongs to a different account", () => {
    expect(run(corz(0.5), [position(-10, { accountId: "acct-OTHER" })])).toBeNull();
  });

  it("returns null for anything that isn't an OPEN short put campaign (no validated covered-call mark path)", () => {
    expect(run(corz(0.5, { status: "ASSIGNED" }), [position(-10)])).toBeNull();
  });

  it("returns null when there is no credit to be a percentage of", () => {
    expect(run(corz(0), [position(-10)])).toBeNull();
  });

  it("returns null for an observation too old to trust as current", () => {
    const stale = position(-10, { observedAt: new Date("2026-10-01T19:55:00Z") });
    expect(run(corz(0.5), [stale])).toBeNull();
  });
});
