import { describe, expect, it } from "vitest";
import {
  computeCoveredCallRollStatus,
  computeRollStatus,
  DEFAULT_ROLL_BUFFER_PERCENT,
  isCoveredCallRollGuidanceApplicable,
  isPastFridayManagementCheckpoint,
  isRollGuidanceApplicable,
} from "./rollStatus";
import { getCurrentOpenCall, summarizeCampaign, type CampaignEventInput } from "./campaigns";

describe("computeRollStatus", () => {
  it("returns GREEN/HOLD when comfortably above strike and outside the buffer", () => {
    const status = computeRollStatus({ currentPrice: 20.9, strike: 17.5, rollBufferPercent: 3 });
    expect(status?.color).toBe("GREEN");
    expect(status?.label).toBe("HOLD");
    expect(status?.distancePct).toBeCloseTo(19.43, 1);
    expect(status?.distanceText).toBe("+19.4% above strike");
    expect(status?.bufferNote).toBeNull();
    expect(status?.reason).toContain("outside your 3% Roll Buffer");
  });

  it("returns AMBER/NEAR STRIKE when above strike but inside the buffer", () => {
    // APLD example from the spec: strike 23.50, +1.8% above strike.
    const strike = 23.5;
    const currentPrice = strike * 1.018;
    const status = computeRollStatus({ currentPrice, strike, rollBufferPercent: 3 });
    expect(status?.color).toBe("AMBER");
    expect(status?.label).toBe("NEAR STRIKE");
    expect(status?.distancePct).toBeCloseTo(1.8, 1);
    expect(status?.bufferNote).toBe("Inside 3% Roll Buffer");
    expect(status?.reason).toBe("+1.8% above strike · inside your 3% Roll Buffer");
  });

  it("returns RED/ROLL CANDIDATE when below strike and before the Friday checkpoint", () => {
    // CORZ example from the spec: strike 16.50, -2.3% below strike.
    const strike = 16.5;
    const currentPrice = strike * 0.977;
    const wednesday = new Date("2026-09-02T18:00:00.000Z"); // a Wednesday, well before Friday 3pm ET
    const status = computeRollStatus({ currentPrice, strike, rollBufferPercent: 3, now: wednesday });
    expect(status?.color).toBe("RED");
    expect(status?.label).toBe("ROLL CANDIDATE");
    expect(status?.distancePct).toBeCloseTo(-2.3, 1);
    expect(status?.distanceText).toBe("-2.3% below strike");
    expect(status?.reason).toBe("-2.3% below strike · put is ITM");
  });

  it("relabels RED as ROLL (not ROLL CANDIDATE) at/after the Friday ~3pm ET management checkpoint", () => {
    const strike = 16.5;
    const currentPrice = strike * 0.977;
    // Friday 2026-09-04, 16:00 UTC = noon ET (before 3pm ET) - still ROLL CANDIDATE.
    const beforeCheckpoint = new Date("2026-09-04T16:00:00.000Z");
    expect(computeRollStatus({ currentPrice, strike, rollBufferPercent: 3, now: beforeCheckpoint })?.label).toBe("ROLL CANDIDATE");

    // Friday 2026-09-04, 20:00 UTC = 4pm ET (after 3pm ET, EDT in effect) - now ROLL.
    const atCheckpoint = new Date("2026-09-04T20:00:00.000Z");
    expect(computeRollStatus({ currentPrice, strike, rollBufferPercent: 3, now: atCheckpoint })?.label).toBe("ROLL");
  });

  it("treats the weekend as past the management checkpoint too", () => {
    const strike = 16.5;
    const currentPrice = strike * 0.977;
    const saturday = new Date("2026-09-05T18:00:00.000Z");
    expect(computeRollStatus({ currentPrice, strike, rollBufferPercent: 3, now: saturday })?.label).toBe("ROLL");
  });

  it("treats being exactly at the strike as RED (ITM boundary), never AMBER or GREEN", () => {
    const status = computeRollStatus({ currentPrice: 20, strike: 20, rollBufferPercent: 3 });
    expect(status?.color).toBe("RED");
    expect(status?.distancePct).toBe(0);
    expect(status?.distanceText).toBe("At strike");
  });

  it("treats being exactly at the buffer boundary as AMBER, not GREEN (strictly greater-than for GREEN)", () => {
    const strike = 100;
    const currentPrice = 103; // exactly +3.0% - equal to a 3% buffer
    const status = computeRollStatus({ currentPrice, strike, rollBufferPercent: 3 });
    expect(status?.color).toBe("AMBER");
    expect(status?.label).toBe("NEAR STRIKE");
  });

  it("respects a custom, non-default Roll Buffer - Matt and Eric may configure different thresholds", () => {
    const strike = 100;
    const currentPrice = 104; // +4%
    // With a 3% buffer this would be GREEN; with a wider 5% buffer it's still inside -> AMBER.
    expect(computeRollStatus({ currentPrice, strike, rollBufferPercent: 3 })?.color).toBe("GREEN");
    expect(computeRollStatus({ currentPrice, strike, rollBufferPercent: 5 })?.color).toBe("AMBER");
  });

  it("never returns RED merely because the position is short - only real moneyness matters", () => {
    // Comfortably OTM (above strike) must never be RED, regardless of buffer width.
    const status = computeRollStatus({ currentPrice: 50, strike: 10, rollBufferPercent: 3 });
    expect(status?.color).not.toBe("RED");
  });

  it("returns null for a non-finite or non-positive strike rather than dividing by zero", () => {
    expect(computeRollStatus({ currentPrice: 20, strike: 0, rollBufferPercent: 3 })).toBeNull();
    expect(computeRollStatus({ currentPrice: 20, strike: -5, rollBufferPercent: 3 })).toBeNull();
    expect(computeRollStatus({ currentPrice: Number.NaN, strike: 20, rollBufferPercent: 3 })).toBeNull();
  });

  it("uses the documented default of 3.0% when the caller passes it explicitly", () => {
    expect(DEFAULT_ROLL_BUFFER_PERCENT).toBe(3.0);
    const status = computeRollStatus({ currentPrice: 100.5, strike: 100, rollBufferPercent: DEFAULT_ROLL_BUFFER_PERCENT });
    expect(status?.color).toBe("AMBER");
  });
});

describe("isPastFridayManagementCheckpoint", () => {
  it("is false on a weekday before Friday", () => {
    expect(isPastFridayManagementCheckpoint(new Date("2026-09-01T18:00:00.000Z"))).toBe(false); // Tuesday
  });

  it("is false on Friday morning ET", () => {
    expect(isPastFridayManagementCheckpoint(new Date("2026-09-04T13:00:00.000Z"))).toBe(false); // 9am ET
  });

  it("is true on Friday at/after 3pm ET", () => {
    expect(isPastFridayManagementCheckpoint(new Date("2026-09-04T19:00:00.000Z"))).toBe(true); // 3pm ET (EDT, UTC-4)
  });

  it("is true on Saturday and Sunday", () => {
    expect(isPastFridayManagementCheckpoint(new Date("2026-09-05T12:00:00.000Z"))).toBe(true);
    expect(isPastFridayManagementCheckpoint(new Date("2026-09-06T12:00:00.000Z"))).toBe(true);
  });
});

describe("computeCoveredCallRollStatus", () => {
  it("test 1: stock well below call strike -> GREEN/HOLD", () => {
    const status = computeCoveredCallRollStatus({ currentPrice: 26, strike: 30, rollBufferPercent: 3 });
    expect(status?.color).toBe("GREEN");
    expect(status?.label).toBe("HOLD");
    expect(status?.distancePct).toBeCloseTo(-13.33, 1);
    expect(status?.distanceText).toBe("-13.3% below strike");
    expect(status?.bufferNote).toBeNull();
    expect(status?.reason).toContain("outside your 3% Roll Buffer");
  });

  it("test 2/6: stock approaching strike inside the roll buffer -> AMBER/NEAR STRIKE, and a wider buffer changes the result", () => {
    const status = computeCoveredCallRollStatus({ currentPrice: 29.4, strike: 30, rollBufferPercent: 3 });
    expect(status?.color).toBe("AMBER");
    expect(status?.label).toBe("NEAR STRIKE");
    expect(status?.distancePct).toBeCloseTo(-2.0, 1);
    expect(status?.distanceText).toBe("-2.0% below strike");
    expect(status?.bufferNote).toBe("Inside 3% Roll Buffer");

    // With a narrower 1% buffer, -2.0% is now outside the buffer -> HOLD instead.
    const narrower = computeCoveredCallRollStatus({ currentPrice: 29.4, strike: 30, rollBufferPercent: 1 });
    expect(narrower?.color).toBe("GREEN");
    expect(narrower?.label).toBe("HOLD");
  });

  it("test 3: stock above strike -> RED/ROLL CANDIDATE before the Friday checkpoint", () => {
    const wednesday = new Date("2026-09-02T18:00:00.000Z");
    const status = computeCoveredCallRollStatus({ currentPrice: 30.5, strike: 30, rollBufferPercent: 3, now: wednesday });
    expect(status?.color).toBe("RED");
    expect(status?.label).toBe("ROLL CANDIDATE");
    expect(status?.distancePct).toBeCloseTo(1.67, 1);
    expect(status?.distanceText).toBe("+1.7% above strike");
    expect(status?.reason).toBe("+1.7% above strike · call is ITM");
  });

  it("relabels RED as ROLL at/after the Friday ~3pm ET management checkpoint, same as puts", () => {
    const atCheckpoint = new Date("2026-09-04T20:00:00.000Z"); // Friday 4pm ET
    const status = computeCoveredCallRollStatus({ currentPrice: 30.5, strike: 30, rollBufferPercent: 3, now: atCheckpoint });
    expect(status?.label).toBe("ROLL");
  });

  it("test 4: directional logic is the OPPOSITE of the put side for the same raw price movement", () => {
    // Stock rising from below strike to above strike: dangerous for a call (HOLD -> ROLL
    // CANDIDATE), the exact opposite of what the same movement means for a put (which would go
    // HOLD -> ROLL CANDIDATE only when falling toward/through the strike, not rising through it).
    const strike = 30;
    const wednesday = new Date("2026-09-02T18:00:00.000Z");

    const putBelow = computeRollStatus({ currentPrice: 26, strike, rollBufferPercent: 3, now: wednesday });
    const putAbove = computeRollStatus({ currentPrice: 32, strike, rollBufferPercent: 3, now: wednesday });
    expect(putBelow?.color).toBe("RED"); // put: below strike is dangerous
    expect(putAbove?.color).toBe("GREEN"); // put: comfortably above strike is safe

    const callBelow = computeCoveredCallRollStatus({ currentPrice: 26, strike, rollBufferPercent: 3, now: wednesday });
    const callAbove = computeCoveredCallRollStatus({ currentPrice: 32, strike, rollBufferPercent: 3, now: wednesday });
    expect(callBelow?.color).toBe("GREEN"); // call: comfortably below strike is safe (opposite of put)
    expect(callAbove?.color).toBe("RED"); // call: above strike is dangerous (opposite of put)
  });

  it("test 5: treats being exactly at the strike as RED/ITM boundary, never AMBER or GREEN", () => {
    const status = computeCoveredCallRollStatus({ currentPrice: 30, strike: 30, rollBufferPercent: 3 });
    expect(status?.color).toBe("RED");
    expect(status?.distancePct).toBe(0);
    expect(status?.distanceText).toBe("At strike");
  });

  it("treats being exactly at the buffer boundary as AMBER, not GREEN (strictly less-than for GREEN)", () => {
    const status = computeCoveredCallRollStatus({ currentPrice: 97, strike: 100, rollBufferPercent: 3 }); // exactly -3.0%
    expect(status?.color).toBe("AMBER");
    expect(status?.label).toBe("NEAR STRIKE");
  });

  it("never returns RED merely because shares are held/covered - only real moneyness matters", () => {
    const status = computeCoveredCallRollStatus({ currentPrice: 10, strike: 50, rollBufferPercent: 3 });
    expect(status?.color).not.toBe("RED");
  });

  it("test 9: returns null for a non-finite or non-positive strike/price rather than fabricating a status", () => {
    expect(computeCoveredCallRollStatus({ currentPrice: 30, strike: 0, rollBufferPercent: 3 })).toBeNull();
    expect(computeCoveredCallRollStatus({ currentPrice: 30, strike: -5, rollBufferPercent: 3 })).toBeNull();
    expect(computeCoveredCallRollStatus({ currentPrice: Number.NaN, strike: 30, rollBufferPercent: 3 })).toBeNull();
  });

  it("reuses the same RollStatus/RollStatusLabel/RollStatusColor shape as puts - RollStatusBadge needs no changes", () => {
    const status = computeCoveredCallRollStatus({ currentPrice: 26, strike: 30, rollBufferPercent: 3 });
    expect(status).toMatchObject({
      color: expect.stringMatching(/^(GREEN|AMBER|RED)$/),
      label: expect.stringMatching(/^(HOLD|NEAR STRIKE|ROLL CANDIDATE|ROLL)$/),
      distancePct: expect.any(Number),
      distanceText: expect.any(String),
      reason: expect.any(String),
    });
  });
});

describe("isCoveredCallRollGuidanceApplicable", () => {
  it("test 7: stays applicable through expiration day itself (still trading)", () => {
    expect(isCoveredCallRollGuidanceApplicable(new Date("2026-09-18"), new Date("2026-09-18T14:00:00Z"))).toBe(true);
  });

  it("test 8: suppressed the calendar day after expiration", () => {
    expect(isCoveredCallRollGuidanceApplicable(new Date("2026-09-18"), new Date("2026-09-19T00:30:00Z"))).toBe(false);
  });

  it("stays applicable before expiration", () => {
    expect(isCoveredCallRollGuidanceApplicable(new Date("2026-09-18"), new Date("2026-09-10"))).toBe(true);
  });
});

describe("covered call Roll Status end to end with the event ledger", () => {
  const assigned: CampaignEventInput = { type: "ASSIGNMENT", occurredAt: "2026-08-28T20:00:00Z", strike: 30, shares: 100 };

  it("test 14: sequential covered calls - Roll Status uses the current open call's strike only, not an earlier closed one", () => {
    const events: CampaignEventInput[] = [
      assigned,
      { type: "SELL_COVERED_CALL", occurredAt: "2026-09-01T14:00:00Z", strike: 30, contracts: 1, premium: 0.3, expiration: "2026-09-11" },
      { type: "CLOSE_COVERED_CALL", occurredAt: "2026-09-08T14:00:00Z", strike: 30, contracts: 1, premium: 0.1, expiration: "2026-09-11" },
      { type: "SELL_COVERED_CALL", occurredAt: "2026-09-09T14:00:00Z", strike: 35, contracts: 1, premium: 0.28, expiration: "2026-09-25" },
    ];
    const openCall = getCurrentOpenCall(events);
    expect(openCall).toEqual({ strike: 35, contracts: 1, expiration: new Date("2026-09-25") });

    // Stock at 30.50 would have been ITM against the first ($30) call but is comfortably below
    // the actual current ($35) call.
    const status = computeCoveredCallRollStatus({ currentPrice: 30.5, strike: openCall!.strike, rollBufferPercent: 3 });
    expect(status?.color).toBe("GREEN");
    expect(status?.label).toBe("HOLD");
  });

  it("test 15: a closed/expired call produces no open call, so no active call Roll Status is computed at all", () => {
    const closedEvents: CampaignEventInput[] = [
      assigned,
      { type: "SELL_COVERED_CALL", occurredAt: "2026-09-01T14:00:00Z", strike: 30, contracts: 1, premium: 0.3, expiration: "2026-09-11" },
      { type: "CLOSE_COVERED_CALL", occurredAt: "2026-09-08T14:00:00Z", strike: 30, contracts: 1, premium: 0.1, expiration: "2026-09-11" },
    ];
    expect(getCurrentOpenCall(closedEvents)).toBeNull();

    const expiredEvents: CampaignEventInput[] = [
      assigned,
      { type: "SELL_COVERED_CALL", occurredAt: "2026-09-01T14:00:00Z", strike: 30, contracts: 1, premium: 0.3, expiration: "2026-09-11" },
      { type: "COVERED_CALL_EXPIRED", occurredAt: "2026-09-12T14:00:00Z", strike: 30, contracts: 1, premium: 0, expiration: "2026-09-11" },
    ];
    expect(getCurrentOpenCall(expiredEvents)).toBeNull();
    // With no open call, the Tracker never has a strike to pass to computeCoveredCallRollStatus -
    // there is nothing to assert a status for, which is itself the correct behavior.
  });
});

describe("isRollGuidanceApplicable", () => {
  it("allows roll guidance for a normal open cash-secured put", () => {
    expect(isRollGuidanceApplicable("Cash-secured put")).toBe(true);
  });

  it("allows roll guidance for other pre-expiration stages", () => {
    expect(isRollGuidanceApplicable("Rolled put")).toBe(true);
    expect(isRollGuidanceApplicable("Assigned shares")).toBe(true);
    expect(isRollGuidanceApplicable("Covered call")).toBe(true);
    expect(isRollGuidanceApplicable("Review needed")).toBe(true);
  });

  it("suppresses roll guidance once a campaign is in Expiration processing", () => {
    expect(isRollGuidanceApplicable("Expiration processing")).toBe(false);
  });

  it("end to end: a normal open CSP's own stage keeps roll guidance eligible, an expired-but-unconfirmed one's does not", () => {
    const stillOpen = summarizeCampaign({
      status: "OPEN",
      asOf: new Date("2026-09-04T14:00:00Z"),
      events: [{ type: "SELL_PUT", occurredAt: "2026-08-28T14:00:00Z", strike: 17.5, contracts: 1, premium: 0.28, expiration: "2026-09-04" }],
    });
    expect(stillOpen.currentStage).toBe("Cash-secured put");
    expect(isRollGuidanceApplicable(stillOpen.currentStage)).toBe(true);

    const awaitingConfirmation = summarizeCampaign({
      status: "OPEN",
      asOf: new Date("2026-09-05T13:00:00Z"),
      events: [{ type: "SELL_PUT", occurredAt: "2026-08-28T14:00:00Z", strike: 17.5, contracts: 1, premium: 0.28, expiration: "2026-09-04" }],
    });
    expect(awaitingConfirmation.currentStage).toBe("Expiration processing");
    expect(isRollGuidanceApplicable(awaitingConfirmation.currentStage)).toBe(false);
  });
});
