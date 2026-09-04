import { describe, expect, it } from "vitest";
import { computeRollStatus, DEFAULT_ROLL_BUFFER_PERCENT, isPastFridayManagementCheckpoint } from "./rollStatus";

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
