import { describe, expect, it } from "vitest";
import type { CampaignCurrentStage } from "./campaigns";
import type { PositionReviewResult } from "./positionReview";
import type { PositionAssessmentDisplay } from "./positionReviewAssessment";
import { activityTone, currentActivityLabel, historicalOriginLabel, isAwaitingSettlement } from "./positionActivity";

const asOf = new Date("2026-10-10T12:00:00Z");
const futureExpiration = new Date("2026-10-23");
const pastExpiration = new Date("2026-10-09");
const todayExpiration = new Date("2026-10-10");

function reviewFixture(overrides: Partial<PositionReviewResult> = {}): PositionReviewResult {
  return {
    action: "COMFORTABLE",
    lifecycle: "CURRENT_PUT",
    evidence: { position: "SCHWAB_CONFIRMED", quote: "ELIGIBLE", quoteIneligibleReason: null, session: "OPEN" },
    explanation: {
      reasonCodes: [], optionType: "PUT", strike: 25, stockPrice: 30, dollarDistance: 5, percentageDistance: 20,
      moneyness: "OTM", bufferPercent: 3, expiration: todayExpiration, daysToExpiration: 0,
      quoteTradeTime: asOf, quoteAgeMs: 0, positionEvidenceAsOf: asOf,
      activeGuidanceDeadline: asOf, evaluatedAt: asOf,
    },
    priority: { group: 8, withinExpirationTodaySubgroup: null, expirationSortKey: "2026-10-10", ticker: "XYZ", accountId: "a1", campaignId: "c1" },
    ...overrides,
  };
}

// Weekend / Settlement Clarity, blocker repair (B1) - the REAL authoritative evidence shape the
// live evaluator (positionReview.ts) actually produces: a live, still-trading session reads
// CURRENT; the SAME calendar day after the expiration session has definitively ended reads
// UNAVAILABLE with lifecycle EXPIRATION_SESSION_ENDED - never waiting for isPastExpiration's own
// calendar-day-after check to catch up.
function liveSessionDisplay(optionType: "PUT" | "CALL"): PositionAssessmentDisplay {
  return { state: "CURRENT", current: reviewFixture({ action: "WATCH", explanation: { ...reviewFixture().explanation, optionType } }), lastValid: null };
}
function sessionEndedDisplay(optionType: "PUT" | "CALL"): PositionAssessmentDisplay {
  return {
    state: "UNAVAILABLE",
    currentUnavailable: reviewFixture({
      action: "CANNOT_ASSESS",
      lifecycle: "EXPIRATION_SESSION_ENDED",
      explanation: { ...reviewFixture().explanation, optionType, reasonCodes: ["EXPIRATION_SESSION_ENDED"] },
    }),
  };
}

describe("currentActivityLabel - relabels the campaign reducer's own currentStage, never a second interpretation", () => {
  it("short put open: Cash-secured put and Rolled put both map to SHORT PUT OPEN", () => {
    expect(currentActivityLabel("Cash-secured put", futureExpiration, asOf, null)).toBe("SHORT PUT OPEN");
    expect(currentActivityLabel("Rolled put", futureExpiration, asOf, null)).toBe("SHORT PUT OPEN");
  });

  it("assigned shares with no call maps to SHARES HELD, never left as a bare 'Assigned'", () => {
    expect(currentActivityLabel("Assigned shares", null, asOf, null)).toBe("SHARES HELD");
  });

  it("PATH scenario: assigned shares WITH an open covered call maps to COVERED CALL OPEN while the call's own expiration is still in the future", () => {
    expect(currentActivityLabel("Covered call", futureExpiration, asOf, null)).toBe("COVERED CALL OPEN");
  });

  it("past-expiration awaiting broker confirmation maps to SETTLEMENT PENDING", () => {
    expect(currentActivityLabel("Expiration processing", pastExpiration, asOf, null)).toBe("SETTLEMENT PENDING");
  });

  // Weekend / Settlement Clarity - currentStage alone never flags an expired COVERED CALL
  // (it always reports "Covered call" for an ASSIGNED campaign with an open call, regardless of
  // that call's own expiration - see rollStatus.ts's isCoveredCallRollGuidanceApplicable for the
  // established precedent this mirrors), so this function checks the call's own expiration
  // directly, exactly like it would for a put via the "Expiration processing" stage.
  it("PATH scenario, post-expiration: an expired-unresolved covered call maps to SETTLEMENT PENDING, never left looking still-active", () => {
    expect(currentActivityLabel("Covered call", pastExpiration, asOf, null)).toBe("SETTLEMENT PENDING");
  });

  it("a covered call with no known expiration (incomplete data) is never guessed into SETTLEMENT PENDING - stays COVERED CALL OPEN", () => {
    expect(currentActivityLabel("Covered call", null, asOf, null)).toBe("COVERED CALL OPEN");
  });

  it("expiration day itself is not yet past (calendar-only, no live display) - a covered call expiring today still reads COVERED CALL OPEN", () => {
    expect(currentActivityLabel("Covered call", todayExpiration, asOf, null)).toBe("COVERED CALL OPEN");
  });

  it("a closed campaign maps to CLOSED", () => {
    expect(currentActivityLabel("Closed", null, asOf, null)).toBe("CLOSED");
  });

  it("the rare incomplete-terms fallback maps to REVIEW NEEDED, never silently to another label", () => {
    expect(currentActivityLabel("Review needed", null, asOf, null)).toBe("REVIEW NEEDED");
  });

  /**
   * Weekend / Settlement Clarity, blocker repair (B1) - Codex found that isPastExpiration alone
   * (calendar-date based) cannot detect "today's expiration session has already ended" - only the
   * day AFTER. The live evaluator already has authoritative session evidence for this; these cases
   * prove currentActivityLabel actually consults it (via `display`) rather than only the calendar.
   */
  describe("B1: same-day expiration, before vs. after the authoritative session end", () => {
    it("A. PUT, same expiration date, live session evidence -> SHORT PUT OPEN (active)", () => {
      expect(currentActivityLabel("Cash-secured put", todayExpiration, asOf, liveSessionDisplay("PUT"))).toBe("SHORT PUT OPEN");
    });

    it("B. PUT, same expiration date, EXPIRATION_SESSION_ENDED evidence -> SETTLEMENT PENDING", () => {
      expect(currentActivityLabel("Cash-secured put", todayExpiration, asOf, sessionEndedDisplay("PUT"))).toBe("SETTLEMENT PENDING");
    });

    it("A. COVERED CALL, same expiration date, live session evidence -> COVERED CALL OPEN (active)", () => {
      expect(currentActivityLabel("Covered call", todayExpiration, asOf, liveSessionDisplay("CALL"))).toBe("COVERED CALL OPEN");
    });

    it("B. COVERED CALL, same expiration date, session-ended evidence -> SETTLEMENT PENDING", () => {
      expect(currentActivityLabel("Covered call", todayExpiration, asOf, sessionEndedDisplay("CALL"))).toBe("SETTLEMENT PENDING");
    });

    it("the day-after case is still correctly SETTLEMENT PENDING even with no display available at all (calendar fallback)", () => {
      expect(currentActivityLabel("Expiration processing", pastExpiration, asOf, null)).toBe("SETTLEMENT PENDING");
      expect(currentActivityLabel("Covered call", pastExpiration, asOf, null)).toBe("SETTLEMENT PENDING");
    });

    it("a future-dated option is never flagged SETTLEMENT PENDING merely because SOME display is present", () => {
      expect(currentActivityLabel("Cash-secured put", futureExpiration, asOf, liveSessionDisplay("PUT"))).toBe("SHORT PUT OPEN");
    });

    it("does NOT hard-code a 4:00 PM (or any other) clock test - it only ever trusts the evaluator's own lifecycle, never re-derives session timing itself", () => {
      // A display whose lifecycle is NOT expiration-related must never be treated as session-ended,
      // regardless of what time `asOf` carries - proves there is no independent clock comparison.
      const midnightAsOf = new Date("2026-10-10T23:59:00Z");
      const ordinaryCurrent: PositionAssessmentDisplay = { state: "CURRENT", current: reviewFixture({ action: "COMFORTABLE" }), lastValid: null };
      expect(currentActivityLabel("Cash-secured put", todayExpiration, midnightAsOf, ordinaryCurrent)).toBe("SHORT PUT OPEN");
    });
  });
});

// Weekend / Settlement Clarity - the Dashboard/Tracker ticket's own three required scenarios,
// expressed directly against the shared predicate both pages' Active/Awaiting Settlement grouping
// is built from.
describe("isAwaitingSettlement", () => {
  it("1. a future-dated short put is ACTIVE NOW, not awaiting settlement", () => {
    expect(isAwaitingSettlement("Cash-secured put", futureExpiration, asOf, null)).toBe(false);
  });

  it("2. an expired-unresolved put is AWAITING SETTLEMENT", () => {
    expect(isAwaitingSettlement("Expiration processing", pastExpiration, asOf, null)).toBe(true);
  });

  it("3. an expired-unresolved covered call (assigned shares still in play) is AWAITING SETTLEMENT, exactly like an expired put", () => {
    expect(isAwaitingSettlement("Covered call", pastExpiration, asOf, null)).toBe(true);
  });

  it("shares held with no call, and a genuinely open covered call, are both active - not every ASSIGNED campaign is settling", () => {
    expect(isAwaitingSettlement("Assigned shares", null, asOf, null)).toBe(false);
    expect(isAwaitingSettlement("Covered call", futureExpiration, asOf, null)).toBe(false);
  });

  it("B1: a same-day, session-ended put is AWAITING SETTLEMENT via the live display, not just the calendar", () => {
    expect(isAwaitingSettlement("Cash-secured put", todayExpiration, asOf, sessionEndedDisplay("PUT"))).toBe(true);
    expect(isAwaitingSettlement("Cash-secured put", todayExpiration, asOf, liveSessionDisplay("PUT"))).toBe(false);
  });

  // 6. No campaign disappears from all Dashboard/Tracker groups - every stage this function can
  // ever receive from a real open/assigned campaign resolves to exactly true or false (never
  // throws, never undefined), so a row built from isAwaitingSettlement(row) and
  // !isAwaitingSettlement(row) can never land in neither group nor both.
  it("6. every real open/assigned stage resolves to a definite boolean - a row can never vanish from both Active and Awaiting Settlement", () => {
    const openStages: CampaignCurrentStage[] = ["Cash-secured put", "Rolled put", "Expiration processing", "Assigned shares", "Covered call", "Review needed"];
    for (const stage of openStages) {
      for (const expiration of [null, pastExpiration, futureExpiration, todayExpiration]) {
        for (const display of [null, liveSessionDisplay("PUT"), sessionEndedDisplay("PUT")]) {
          const settling = isAwaitingSettlement(stage, expiration, asOf, display);
          expect(typeof settling).toBe("boolean");
          // A row is awaiting settlement or it is active - never both, never neither, by
          // construction (the predicate and its negation always partition any boolean exhaustively).
          expect(settling === true || settling === false).toBe(true);
        }
      }
    }
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
