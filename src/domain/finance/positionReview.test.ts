import { describe, expect, it } from "vitest";
import type { EquityMarketSessionEvidence, QuoteReviewEvidence } from "@/providers/market-data/types";
import {
  comparePositionReviewPriority,
  evaluatePositionReview,
  sortPositionReviews,
  type PositionReviewInput,
  type PositionReviewLeg,
  type PositionReviewResult,
} from "./positionReview";

const NY_DATE = "2026-06-15";
const NOON = new Date(`${NY_DATE}T16:00:00Z`); // 12:00 PM ET
const SESSION_OPEN = new Date(`${NY_DATE}T09:30:00-04:00`);
const SESSION_CLOSE = new Date(`${NY_DATE}T16:00:00-04:00`);

function ordinarySession(overrides: Partial<Extract<EquityMarketSessionEvidence, { status: "AVAILABLE" }>> = {}): EquityMarketSessionEvidence {
  return {
    status: "AVAILABLE",
    requestedDate: NY_DATE,
    returnedDate: NY_DATE,
    marketType: "EQUITY",
    product: "EQ",
    isOpen: true,
    regularMarketIntervals: [{ start: SESSION_OPEN, end: SESSION_CLOSE }],
    ...overrides,
  };
}

function quote(price: number, tradeTime: Date = NOON): QuoteReviewEvidence {
  return {
    status: "AVAILABLE",
    requestedSymbol: "UPST",
    returnedSymbol: "UPST",
    assetMainType: "EQUITY",
    realtime: true,
    price,
    tradeTime,
    requestStartedAt: tradeTime,
    responseReceivedAt: tradeTime,
  };
}

function baseInput(overrides: Partial<PositionReviewInput> = {}): PositionReviewInput {
  return {
    campaignId: "campaign-1",
    accountId: "account-1",
    ticker: "UPST",
    leg: { kind: "PUT", strike: 25, expiration: new Date("2026-10-02T00:00:00.000Z") },
    lifecycleStage: "Cash-secured put",
    rollBufferPercent: 3,
    position: { state: "SCHWAB_CONFIRMED", asOf: NOON },
    quote: quote(26),
    session: ordinarySession(),
    now: NOON,
    ...overrides,
  };
}

describe("evaluatePositionReview - PUT moneyness boundaries", () => {
  it("is COMFORTABLE when favorable distance is well outside the buffer (OTM)", () => {
    const result = evaluatePositionReview(baseInput({ leg: { kind: "PUT", strike: 25, expiration: new Date("2026-10-02T00:00:00.000Z") }, quote: quote(30) }));
    expect(result.action).toBe("COMFORTABLE");
    expect(result.explanation.moneyness).toBe("OTM");
  });

  it("is WATCH at the exact buffer boundary (favorable distance === buffer%)", () => {
    // strike 25, buffer 3% -> favorable distance exactly 3% means stock = 25 * 1.03 = 25.75
    const result = evaluatePositionReview(baseInput({ quote: quote(25.75) }));
    expect(result.action).toBe("WATCH");
    expect(result.explanation.reasonCodes).toContain("WITHIN_ROLL_BUFFER");
  });

  it("is WATCH strictly within the buffer", () => {
    const result = evaluatePositionReview(baseInput({ quote: quote(25.3) }));
    expect(result.action).toBe("WATCH");
  });

  it("is REVIEW_ROLL exactly at the strike (ATM)", () => {
    const result = evaluatePositionReview(baseInput({ quote: quote(25) }));
    expect(result.action).toBe("REVIEW_ROLL");
    expect(result.explanation.moneyness).toBe("ATM");
  });

  it("is REVIEW_ROLL when ITM", () => {
    const result = evaluatePositionReview(baseInput({ quote: quote(24.5) }));
    expect(result.action).toBe("REVIEW_ROLL");
    expect(result.explanation.moneyness).toBe("ITM");
    expect(result.explanation.dollarDistance).toBeCloseTo(0.5, 5);
  });

  it("classifies moneyness from the exact unrounded difference, before display rounding", () => {
    // strike 25, stock 25.001 -> technically OTM by a fraction of a cent, must not round to ATM.
    const result = evaluatePositionReview(baseInput({ quote: quote(25.001) }));
    expect(result.explanation.moneyness).toBe("OTM");
  });
});

describe("evaluatePositionReview - CALL moneyness boundaries", () => {
  const callLeg: PositionReviewLeg = { kind: "CALL", strike: 30, expiration: new Date("2026-10-02T00:00:00.000Z") };
  const callInput = (overrides: Partial<PositionReviewInput> = {}) =>
    baseInput({ leg: callLeg, lifecycleStage: "Covered call", ...overrides });

  it("is COMFORTABLE when the stock is well below the strike (OTM for a call)", () => {
    const result = evaluatePositionReview(callInput({ quote: quote(27) }));
    expect(result.action).toBe("COMFORTABLE");
    expect(result.explanation.moneyness).toBe("OTM");
  });

  it("is WATCH at the exact buffer boundary approaching from below", () => {
    // strike 30, buffer 3% -> favorable distance exactly 3% means stock = 30 * 0.97 = 29.1
    const result = evaluatePositionReview(callInput({ quote: quote(29.1) }));
    expect(result.action).toBe("WATCH");
  });

  it("is WATCH strictly within the buffer", () => {
    const result = evaluatePositionReview(callInput({ quote: quote(29.5) }));
    expect(result.action).toBe("WATCH");
  });

  it("is REVIEW_CALL exactly at the strike (ATM)", () => {
    const result = evaluatePositionReview(callInput({ quote: quote(30) }));
    expect(result.action).toBe("REVIEW_CALL");
    expect(result.explanation.moneyness).toBe("ATM");
  });

  it("is REVIEW_CALL when ITM (stock above strike)", () => {
    const result = evaluatePositionReview(callInput({ quote: quote(30.5) }));
    expect(result.action).toBe("REVIEW_CALL");
    expect(result.explanation.moneyness).toBe("ITM");
  });
});

describe("evaluatePositionReview - roll buffer configuration", () => {
  it("uses a custom buffer instead of the 3% default", () => {
    // strike 25, stock 26 -> favorable distance 4%. With a 5% buffer this is WATCH; with the
    // default 3% buffer (see the first describe block) an equivalent distance would be COMFORTABLE.
    const result = evaluatePositionReview(baseInput({ rollBufferPercent: 5, quote: quote(26) }));
    expect(result.action).toBe("WATCH");
    expect(result.explanation.bufferPercent).toBe(5);
  });

  it.each([0, -1, 30, Number.NaN, Number.POSITIVE_INFINITY])("falls back to the default 3%% buffer for an invalid configured value (%s)", (invalid) => {
    const result = evaluatePositionReview(baseInput({ rollBufferPercent: invalid, quote: quote(25.3) }));
    expect(result.explanation.bufferPercent).toBe(3);
    expect(result.action).toBe("WATCH"); // 25.3 is within the default 3% buffer of strike 25
  });
});

describe("evaluatePositionReview - expiration/date contract", () => {
  it("downgrades an otherwise-comfortable position to WATCH when it expires today and the session is still open", () => {
    const result = evaluatePositionReview(
      baseInput({ leg: { kind: "PUT", strike: 25, expiration: new Date(`${NY_DATE}T00:00:00.000Z`) }, quote: quote(30) }),
    );
    expect(result.action).toBe("WATCH");
    expect(result.explanation.reasonCodes).toContain("EXPIRES_TODAY");
    expect(result.explanation.daysToExpiration).toBe(0);
    expect(result.priority.group).toBe(2);
  });

  it("is EXPIRATION_SESSION_ENDED / CANNOT_ASSESS once the regular session has closed on the expiration date", () => {
    const afterClose = new Date(`${NY_DATE}T16:00:01-04:00`);
    const result = evaluatePositionReview(
      baseInput({ leg: { kind: "PUT", strike: 25, expiration: new Date(`${NY_DATE}T00:00:00.000Z`) }, quote: quote(30, afterClose), now: afterClose }),
    );
    expect(result.lifecycle).toBe("EXPIRATION_SESSION_ENDED");
    expect(result.action).toBe("CANNOT_ASSESS");
    expect(result.priority.group).toBe(1);
  });

  it("is EXPIRATION_PENDING / CANNOT_ASSESS for an already-past, unresolved expiration", () => {
    const result = evaluatePositionReview(
      baseInput({ leg: { kind: "PUT", strike: 25, expiration: new Date("2026-06-10T00:00:00.000Z") } }),
    );
    expect(result.lifecycle).toBe("EXPIRATION_PENDING");
    expect(result.action).toBe("CANNOT_ASSESS");
    expect(result.explanation.reasonCodes).toContain("PAST_EXPIRATION_UNRESOLVED");
    expect(result.priority.group).toBe(1);
  });

  it("does not treat expiration-pending/session-ended as expired-worthless, assigned, or closed - action is CANNOT_ASSESS, never a colored verdict", () => {
    const result = evaluatePositionReview(
      baseInput({ leg: { kind: "PUT", strike: 25, expiration: new Date("2026-06-10T00:00:00.000Z") } }),
    );
    expect(["COMFORTABLE", "WATCH", "REVIEW_ROLL", "REVIEW_CALL"]).not.toContain(result.action);
  });

  it("EXPIRATION_UNKNOWN (missing expiration) is CANNOT_ASSESS in priority group 3", () => {
    const result = evaluatePositionReview(baseInput({ leg: { kind: "PUT", strike: 25, expiration: null } }));
    expect(result.action).toBe("CANNOT_ASSESS");
    expect(result.explanation.reasonCodes).toContain("EXPIRATION_UNKNOWN");
    expect(result.priority.group).toBe(3);
  });
});

describe("evaluatePositionReview - quote evidence", () => {
  it("is CANNOT_ASSESS with UNAVAILABLE quote evidence for a stale quote (> 120s)", () => {
    const staleTrade = new Date(NOON.getTime() - 121_000);
    const result = evaluatePositionReview(baseInput({ quote: quote(30, staleTrade) }));
    expect(result.action).toBe("CANNOT_ASSESS");
    expect(result.evidence.quote).toBe("UNAVAILABLE");
    expect(result.evidence.quoteIneligibleReason).toBe("STALE_TIMESTAMP");
  });

  it("is CANNOT_ASSESS with UNAVAILABLE quote evidence when the quote itself is UNAVAILABLE", () => {
    const result = evaluatePositionReview(baseInput({ quote: { status: "UNAVAILABLE", reason: "provider error" } }));
    expect(result.action).toBe("CANNOT_ASSESS");
    expect(result.evidence.quote).toBe("UNAVAILABLE");
  });

  it("is CANNOT_ASSESS with MARKET_CLOSED quote evidence outside the regular session, in priority group 7 (contextual, not a hard failure)", () => {
    const afterHours = new Date(`${NY_DATE}T20:00:00-04:00`);
    const result = evaluatePositionReview(
      baseInput({ quote: quote(30, afterHours), now: afterHours, position: { state: "SCHWAB_CONFIRMED", asOf: afterHours } }),
    );
    expect(result.action).toBe("CANNOT_ASSESS");
    expect(result.evidence.quote).toBe("MARKET_CLOSED");
    expect(result.evidence.session).toBe("CLOSED");
    expect(result.priority.group).toBe(7);
  });
});

describe("evaluatePositionReview - broker position evidence", () => {
  it("is SCHWAB_CONFIRMED and evaluates normally at the exact 5-minute freshness boundary", () => {
    const asOf = new Date(NOON.getTime() - 5 * 60_000);
    const result = evaluatePositionReview(baseInput({ position: { state: "SCHWAB_CONFIRMED", asOf }, quote: quote(30) }));
    expect(result.evidence.position).toBe("SCHWAB_CONFIRMED");
    expect(result.action).toBe("COMFORTABLE");
  });

  it("downgrades to AWAITING_CONFIRMATION one millisecond past the 5-minute freshness boundary", () => {
    const asOf = new Date(NOON.getTime() - 5 * 60_000 - 1);
    const result = evaluatePositionReview(baseInput({ position: { state: "SCHWAB_CONFIRMED", asOf } }));
    expect(result.evidence.position).toBe("AWAITING_CONFIRMATION");
    expect(result.action).toBe("CANNOT_ASSESS");
    expect(result.explanation.reasonCodes).toContain("POSITION_AWAITING_CONFIRMATION");
  });

  it("downgrades to AWAITING_CONFIRMATION for a future broker read-receipt timestamp (fails closed, never extends freshness)", () => {
    const asOf = new Date(NOON.getTime() + 60_000);
    const result = evaluatePositionReview(baseInput({ position: { state: "SCHWAB_CONFIRMED", asOf } }));
    expect(result.evidence.position).toBe("AWAITING_CONFIRMATION");
  });

  it("downgrades to AWAITING_CONFIRMATION for an invalid (NaN) broker read-receipt timestamp (Codex P1 B1)", () => {
    const result = evaluatePositionReview(baseInput({ position: { state: "SCHWAB_CONFIRMED", asOf: new Date(Number.NaN) } }));
    expect(result.evidence.position).toBe("AWAITING_CONFIRMATION");
  });

  it("is CANNOT_ASSESS for an ambiguous broker match", () => {
    const result = evaluatePositionReview(baseInput({ position: { state: "POSITION_MISMATCH_AMBIGUOUS" } }));
    expect(result.action).toBe("CANNOT_ASSESS");
    expect(result.evidence.position).toBe("POSITION_MISMATCH_AMBIGUOUS");
  });

  it("is CANNOT_ASSESS for a broker outage", () => {
    const result = evaluatePositionReview(baseInput({ position: { state: "BROKER_UNAVAILABLE" } }));
    expect(result.action).toBe("CANNOT_ASSESS");
    expect(result.evidence.position).toBe("BROKER_UNAVAILABLE");
  });

  it("allows a MANUAL_POSITION to be evaluated normally, bypassing the Schwab-freshness requirement", () => {
    const result = evaluatePositionReview(baseInput({ position: { state: "MANUAL_POSITION" }, quote: quote(30) }));
    expect(result.evidence.position).toBe("MANUAL_POSITION");
    expect(result.action).toBe("COMFORTABLE");
  });
});

describe("evaluatePositionReview - assigned shares and covered calls", () => {
  it("is ASSIGNED_SHARES / CANNOT_ASSESS (\"review next step\") when there is no open call", () => {
    const result = evaluatePositionReview(baseInput({ leg: { kind: "NONE" }, lifecycleStage: "Assigned shares" }));
    expect(result.lifecycle).toBe("ASSIGNED_SHARES");
    expect(result.action).toBe("CANNOT_ASSESS");
    expect(result.explanation.reasonCodes).toContain("ASSIGNED_SHARES_NO_CALL");
    expect(result.priority.group).toBe(7);
    expect(result.explanation.optionType).toBeNull();
  });

  it("evaluates an open covered call on assigned shares under the same shared CALL rules", () => {
    const result = evaluatePositionReview(
      baseInput({ leg: { kind: "CALL", strike: 30, expiration: new Date("2026-10-02T00:00:00.000Z") }, lifecycleStage: "Covered call", quote: quote(30.5) }),
    );
    expect(result.lifecycle).toBe("COVERED_CALL");
    expect(result.action).toBe("REVIEW_CALL");
  });
});

describe("evaluatePositionReview - rolled positions use the current leg only", () => {
  it("evaluates a rolled put's CURRENT leg normally - lifecycle label does not change the moneyness/action rules", () => {
    const result = evaluatePositionReview(
      baseInput({ leg: { kind: "PUT", strike: 20, expiration: new Date("2026-10-02T00:00:00.000Z") }, lifecycleStage: "Rolled put", quote: quote(25) }),
    );
    expect(result.lifecycle).toBe("ROLLED_PUT");
    expect(result.action).toBe("COMFORTABLE");
  });
});

describe("evaluatePositionReview - incomplete terms", () => {
  it("is CANNOT_ASSESS when strike is missing", () => {
    const result = evaluatePositionReview(baseInput({ leg: { kind: "PUT", strike: null, expiration: new Date("2026-10-02T00:00:00.000Z") } }));
    expect(result.action).toBe("CANNOT_ASSESS");
    expect(result.explanation.reasonCodes).toContain("INCOMPLETE_TERMS");
  });
});

describe("evaluatePositionReview - purity", () => {
  it("Dashboard and Tracker calling with identical input get an identical result", () => {
    const input = baseInput({ quote: quote(30) });
    const first = evaluatePositionReview(input);
    const second = evaluatePositionReview(input);
    expect(second).toEqual(first);
  });
});

describe("Codex P1 (B3) - activeGuidanceDeadline", () => {
  it("is the quote's own 120s freshness deadline when it is the earliest of the three components", () => {
    // position.asOf and quote.tradeTime are both exactly NOON here (baseInput's own defaults), so
    // the quote deadline (NOON+120s) arrives well before the broker deadline (NOON+5min) or the
    // session close (16:00 ET, hours away).
    const result = evaluatePositionReview(baseInput({ quote: quote(30) }));
    expect(result.explanation.activeGuidanceDeadline?.getTime()).toBe(NOON.getTime() + 120_000);
  });

  it("is the broker read-receipt's 5-minute deadline when the position evidence is the older (and therefore earlier-expiring) one", () => {
    const positionAsOf = new Date(NOON.getTime() - 4 * 60_000); // 4 minutes old - still fresh (<=5min)
    const result = evaluatePositionReview(baseInput({ position: { state: "SCHWAB_CONFIRMED", asOf: positionAsOf }, quote: quote(30, NOON) }));
    expect(result.explanation.activeGuidanceDeadline?.getTime()).toBe(positionAsOf.getTime() + 5 * 60_000);
  });

  it("is the validated regular-session close instant when the session is about to end before either freshness window would", () => {
    const almostClose = new Date(SESSION_CLOSE.getTime() - 30_000);
    const result = evaluatePositionReview(
      baseInput({ position: { state: "SCHWAB_CONFIRMED", asOf: almostClose }, quote: quote(30, almostClose), now: almostClose }),
    );
    expect(result.explanation.activeGuidanceDeadline?.getTime()).toBe(SESSION_CLOSE.getTime());
  });

  it("is null for a CANNOT_ASSESS row - there is no live advisory to expire", () => {
    const result = evaluatePositionReview(baseInput({ position: { state: "BROKER_UNAVAILABLE" } }));
    expect(result.action).toBe("CANNOT_ASSESS");
    expect(result.explanation.activeGuidanceDeadline).toBeNull();
  });

  it("is null when the quote itself is ineligible, even though the action still resolves to CANNOT_ASSESS", () => {
    const result = evaluatePositionReview(baseInput({ quote: { status: "UNAVAILABLE", reason: "provider error" } }));
    expect(result.explanation.activeGuidanceDeadline).toBeNull();
  });

  it("is still computed for a WATCH row (a live advisory, not just COMFORTABLE/REVIEW)", () => {
    const result = evaluatePositionReview(baseInput({ quote: quote(25.3) })); // within the default 3% buffer
    expect(result.action).toBe("WATCH");
    expect(result.explanation.activeGuidanceDeadline).not.toBeNull();
  });

  it("omits the broker-freshness component entirely for a MANUAL_POSITION (no broker read to expire)", () => {
    const result = evaluatePositionReview(baseInput({ position: { state: "MANUAL_POSITION" }, quote: quote(30) }));
    // Only the quote deadline and session close remain - quote wins since it's much sooner.
    expect(result.explanation.activeGuidanceDeadline?.getTime()).toBe(NOON.getTime() + 120_000);
  });
});

describe("deterministic priority ordering", () => {
  function resultWithGroup(overrides: Partial<PositionReviewInput>): PositionReviewResult {
    return evaluatePositionReview(baseInput(overrides));
  }

  it("orders strictly by the 8 priority groups, independent of input array order", () => {
    const pastExpiration = resultWithGroup({ leg: { kind: "PUT", strike: 25, expiration: new Date("2026-06-01T00:00:00.000Z") }, ticker: "A" });
    const expiresToday = resultWithGroup({ leg: { kind: "PUT", strike: 25, expiration: new Date(`${NY_DATE}T00:00:00.000Z`) }, quote: quote(30), ticker: "B" });
    const reviewRoll = resultWithGroup({ quote: quote(24), ticker: "C" });
    const assignedNoCall = resultWithGroup({ leg: { kind: "NONE" }, lifecycleStage: "Assigned shares", ticker: "D" });
    const watch = resultWithGroup({ quote: quote(25.3), ticker: "E" });
    const comfortable = resultWithGroup({ quote: quote(30), ticker: "F" });

    const expectedOrder = [pastExpiration, expiresToday, reviewRoll, watch, assignedNoCall, comfortable];
    const shuffled = [comfortable, watch, assignedNoCall, reviewRoll, expiresToday, pastExpiration];

    expect(sortPositionReviews(shuffled)).toEqual(expectedOrder);
    // Sorting is independent of the initial order - a different shuffle yields the same output.
    expect(sortPositionReviews([reviewRoll, pastExpiration, comfortable, expiresToday, watch, assignedNoCall])).toEqual(expectedOrder);
  });

  it("within the expires-today group, orders review-red before evidence-failure before watch", () => {
    const todayExpiration = new Date(`${NY_DATE}T00:00:00.000Z`);
    const reviewRedToday = resultWithGroup({ leg: { kind: "PUT", strike: 25, expiration: todayExpiration }, quote: quote(24), ticker: "A" });
    const cannotAssessToday = resultWithGroup({ leg: { kind: "PUT", strike: 25, expiration: todayExpiration }, position: { state: "BROKER_UNAVAILABLE" }, ticker: "B" });
    const watchToday = resultWithGroup({ leg: { kind: "PUT", strike: 25, expiration: todayExpiration }, quote: quote(30), ticker: "C" });

    const sorted = sortPositionReviews([watchToday, cannotAssessToday, reviewRedToday]);
    expect(sorted).toEqual([reviewRedToday, cannotAssessToday, watchToday]);
  });

  it("within other groups, orders by earliest expiration, then ticker, then account, then campaign", () => {
    const later = resultWithGroup({ leg: { kind: "PUT", strike: 25, expiration: new Date("2026-11-01T00:00:00.000Z") }, quote: quote(30), ticker: "AAA" });
    const earlier = resultWithGroup({ leg: { kind: "PUT", strike: 25, expiration: new Date("2026-09-01T00:00:00.000Z") }, quote: quote(30), ticker: "ZZZ" });
    const sameExpirationLowerTicker = resultWithGroup({
      leg: { kind: "PUT", strike: 25, expiration: new Date("2026-09-01T00:00:00.000Z") },
      quote: quote(30),
      ticker: "AAA",
    });

    const sorted = sortPositionReviews([later, sameExpirationLowerTicker, earlier]);
    expect(sorted).toEqual([sameExpirationLowerTicker, earlier, later]);
  });

  it("comparePositionReviewPriority is a valid standalone comparator (matches sortPositionReviews' own ordering)", () => {
    const a = resultWithGroup({ quote: quote(30), ticker: "A" });
    const b = resultWithGroup({ quote: quote(24), ticker: "B" });
    expect(comparePositionReviewPriority(b, a)).toBeLessThan(0); // review-roll (b) sorts before comfortable (a)
    expect(comparePositionReviewPriority(a, b)).toBeGreaterThan(0);
  });
});
