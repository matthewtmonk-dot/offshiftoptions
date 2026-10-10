import { describe, expect, it } from "vitest";
import { activityTone, currentActivityLabel, historicalOriginLabel } from "./positionActivity";

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

describe("activityTone (compact position UX) - color keyed on the activity label, never the coarser campaign.status", () => {
  it("normal short put open: ordinary active state is BLUE (info), never amber/urgent", () => {
    expect(activityTone("SHORT PUT OPEN")).toBe("info");
  });

  it("PATH scenario: covered call open is BLUE, same as an ordinary open put - holding a covered call is not itself urgent", () => {
    expect(activityTone("COVERED CALL OPEN")).toBe("info");
  });

  it("shares held (assigned, no call yet) is BLUE - an ordinary active state, not a warning", () => {
    expect(activityTone("SHARES HELD")).toBe("info");
  });

  it("settlement pending genuinely needs a look and is AMBER (warn), never calm blue and never alarming red", () => {
    expect(activityTone("SETTLEMENT PENDING")).toBe("warn");
  });

  it("review needed is AMBER, matching settlement pending's own urgency tier", () => {
    expect(activityTone("REVIEW NEEDED")).toBe("warn");
  });

  it("closed is neutral by itself - callers use the campaign's own P/L-colored tone instead for a closed campaign's real financial outcome", () => {
    expect(activityTone("CLOSED")).toBe("neutral");
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

  // Codex blocker repair (B3) - "Called away" claimed call-assignment causation this app cannot
  // actually prove (STOCK_SALE is the same event a plain manual sale creates). It is never shown
  // any more - a closed, assigned-then-sold campaign now reads the honest, fully-provable "Shares
  // sold" instead, with no claim about WHY the shares left.
  it("a CLOSED campaign with both an assignment and a later stock sale reads the factual 'Shares sold' - never the unprovable 'Called away'", () => {
    const result = historicalOriginLabel({
      status: "CLOSED",
      events: [{ type: "SELL_PUT" }, { type: "ASSIGNMENT" }, { type: "SELL_COVERED_CALL" }, { type: "STOCK_SALE" }],
    });
    expect(result).toBe("Shares sold");
    expect(result).not.toBe("Called away");
  });

  it("manual-sale scenario: assigned shares later sold manually (no covered call ever involved) still reads 'Shares sold', never 'Called away' - proves the label makes no claim about cause", () => {
    const result = historicalOriginLabel({ status: "CLOSED", events: [{ type: "SELL_PUT" }, { type: "ASSIGNMENT" }, { type: "STOCK_SALE" }] });
    expect(result).toBe("Shares sold");
    expect(result).not.toBe("Called away");
  });

  it("a CLOSED campaign that never assigned shares at all (plain expired/closed put) returns null - never a fabricated origin", () => {
    expect(historicalOriginLabel({ status: "CLOSED", events: [{ type: "SELL_PUT" }, { type: "PUT_EXPIRED" }] })).toBeNull();
  });

  it("a CLOSED campaign with an assignment but no stock sale (e.g. still mid-history in a test fixture) stays 'Assigned from put' - the only fact actually proven", () => {
    expect(historicalOriginLabel({ status: "CLOSED", events: [{ type: "SELL_PUT" }, { type: "ASSIGNMENT" }] })).toBe("Assigned from put");
  });

  it("'Called away' is never returned for ANY input this app can construct today - no event type exists anywhere in this schema that proves call assignment", () => {
    const allPossibleEventTypes: { type: string }[] = [
      { type: "SELL_PUT" }, { type: "CLOSE_PUT" }, { type: "ROLL_PUT_CLOSE" }, { type: "ROLL_PUT_OPEN" }, { type: "ASSIGNMENT" },
      { type: "SELL_COVERED_CALL" }, { type: "CLOSE_COVERED_CALL" }, { type: "COVERED_CALL_EXPIRED" }, { type: "PUT_EXPIRED" },
      { type: "STOCK_SALE" }, { type: "NOTE" },
    ];
    for (const status of ["OPEN", "ASSIGNED", "CLOSED"] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(historicalOriginLabel({ status, events: allPossibleEventTypes as any })).not.toBe("Called away");
    }
  });
});
