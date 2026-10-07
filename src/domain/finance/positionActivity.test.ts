import { describe, expect, it } from "vitest";
import { currentActivityLabel, historicalOriginLabel } from "./positionActivity";

describe("currentActivityLabel - relabels the campaign reducer's own currentStage, never a second interpretation", () => {
  it("short put open: Cash-secured put and Rolled put both map to SHORT PUT OPEN", () => {
    expect(currentActivityLabel("Cash-secured put")).toBe("SHORT PUT OPEN");
    expect(currentActivityLabel("Rolled put")).toBe("SHORT PUT OPEN");
  });

  it("assigned shares with no call maps to SHARES HELD, never left as a bare 'Assigned'", () => {
    expect(currentActivityLabel("Assigned shares")).toBe("SHARES HELD");
  });

  it("PATH scenario: assigned shares WITH an open covered call maps to COVERED CALL OPEN", () => {
    expect(currentActivityLabel("Covered call")).toBe("COVERED CALL OPEN");
  });

  it("past-expiration awaiting broker confirmation maps to SETTLEMENT PENDING", () => {
    expect(currentActivityLabel("Expiration processing")).toBe("SETTLEMENT PENDING");
  });

  it("a closed campaign maps to CLOSED", () => {
    expect(currentActivityLabel("Closed")).toBe("CLOSED");
  });

  it("the rare incomplete-terms fallback maps to REVIEW NEEDED, never silently to another label", () => {
    expect(currentActivityLabel("Review needed")).toBe("REVIEW NEEDED");
  });
});

describe("historicalOriginLabel - append-only event-history origin context only, never inferred from moneyness/price", () => {
  it("no assignment history at all returns null - an ordinary still-open short put has no origin worth a secondary label", () => {
    expect(historicalOriginLabel({ status: "OPEN", events: [{ type: "SELL_PUT" }] })).toBeNull();
  });

  it("assigned shares with no call closure yet reads 'Assigned from put'", () => {
    expect(historicalOriginLabel({ status: "ASSIGNED", events: [{ type: "SELL_PUT" }, { type: "ASSIGNMENT" }] })).toBe("Assigned from put");
  });

  it("PATH scenario: assigned + an open covered call still reads 'Assigned from put' (not yet called away)", () => {
    expect(
      historicalOriginLabel({ status: "ASSIGNED", events: [{ type: "SELL_PUT" }, { type: "ASSIGNMENT" }, { type: "SELL_COVERED_CALL" }] }),
    ).toBe("Assigned from put");
  });

  it("shares called away: CLOSED campaign with both an assignment and a later stock sale reads 'Called away'", () => {
    expect(
      historicalOriginLabel({
        status: "CLOSED",
        events: [{ type: "SELL_PUT" }, { type: "ASSIGNMENT" }, { type: "SELL_COVERED_CALL" }, { type: "STOCK_SALE" }],
      }),
    ).toBe("Called away");
  });

  it("a CLOSED campaign that never assigned shares at all (plain expired/closed put) returns null - never a fabricated origin", () => {
    expect(historicalOriginLabel({ status: "CLOSED", events: [{ type: "SELL_PUT" }, { type: "PUT_EXPIRED" }] })).toBeNull();
  });

  it("a CLOSED campaign with an assignment but no stock sale (e.g. still mid-history in a test fixture) stays 'Assigned from put', never guesses 'Called away' without real sale evidence", () => {
    expect(historicalOriginLabel({ status: "CLOSED", events: [{ type: "SELL_PUT" }, { type: "ASSIGNMENT" }] })).toBe("Assigned from put");
  });
});
