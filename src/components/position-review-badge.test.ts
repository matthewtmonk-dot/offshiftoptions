import { describe, expect, it } from "vitest";
import { isAttentionRow } from "@/domain/finance/positionReviewRows";
import type { PositionAssessmentDisplay } from "@/domain/finance/positionReviewAssessment";
import { actionLabelFor, cannotAssessPresentationTier, expirationWaitLabel, moneynessDistanceLabel } from "./position-review-badge";

describe("actionLabelFor", () => {
  it("labels the four persistable actions", () => {
    expect(actionLabelFor("COMFORTABLE", [])).toBe("Comfortable");
    expect(actionLabelFor("REVIEW_ROLL", [])).toBe("Review roll");
    expect(actionLabelFor("REVIEW_CALL", [])).toBe("Review call");
    expect(actionLabelFor("WATCH", [])).toBe("Watch");
  });

  it("appends the expires-today qualifier only when the reasonCodes passed in actually carry it", () => {
    expect(actionLabelFor("WATCH", ["EXPIRES_TODAY"])).toBe("Watch · expires today");
    expect(actionLabelFor("WATCH", ["WITHIN_ROLL_BUFFER"])).toBe("Watch");
  });

  it("labels CANNOT_ASSESS", () => {
    expect(actionLabelFor("CANNOT_ASSESS", [])).toBe("Cannot assess");
  });
});

describe("cannotAssessPresentationTier (compact position UX) - deliberately separate from the trust-sensitive isKnownTransientFallbackReason allowlist", () => {
  it("settlement pending scenario: EXPIRATION_SESSION_ENDED (the ticket's own 'awaiting confirmation' example) is CALM, not a loud attention state", () => {
    expect(cannotAssessPresentationTier(["EXPIRATION_SESSION_ENDED"])).toBe("calm");
  });

  it("routine market/quote unavailability is CALM", () => {
    expect(cannotAssessPresentationTier(["MARKET_CLOSED"])).toBe("calm");
    expect(cannotAssessPresentationTier(["QUOTE_UNAVAILABLE"])).toBe("calm");
    expect(cannotAssessPresentationTier(["QUOTE_EVIDENCE_UNAVAILABLE"])).toBe("calm");
    expect(cannotAssessPresentationTier(["PAST_EXPIRATION_UNRESOLVED"])).toBe("calm");
  });

  it("unavailable assessment scenario: a genuine broker-evidenced mismatch is ATTENTION, not silently calmed", () => {
    expect(cannotAssessPresentationTier(["POSITION_MISMATCH_AMBIGUOUS"])).toBe("attention");
    expect(cannotAssessPresentationTier(["POSITION_INSUFFICIENT_SHARE_COVERAGE"])).toBe("attention");
  });

  it("incomplete/missing terms are ATTENTION - a real data problem, not routine waiting", () => {
    expect(cannotAssessPresentationTier(["INCOMPLETE_TERMS"])).toBe("attention");
    expect(cannotAssessPresentationTier(["MISSING_CONTRACTS"])).toBe("attention");
  });

  it("a mix of calm and non-calm reasons is ATTENTION overall - one real issue is never hidden by an accompanying routine one", () => {
    expect(cannotAssessPresentationTier(["MARKET_CLOSED", "ASSIGNED_SHARES_NO_CALL"])).toBe("attention");
  });

  it("no reason codes at all defaults to ATTENTION - never silently calm an unrecognized/empty state", () => {
    expect(cannotAssessPresentationTier([])).toBe("attention");
  });

  it("an unrecognized reason code defaults to ATTENTION, never calm by accident", () => {
    expect(cannotAssessPresentationTier(["SOME_FUTURE_REASON_THIS_TEST_DOES_NOT_KNOW_ABOUT"])).toBe("attention");
  });
});

// Weekend / Settlement Clarity - never claims an outcome (called away, shares retained, expired
// worthless), only that confirmation is still pending, and is option-type-aware so an expired
// covered call reads differently from an expired put (the call also leaves assigned shares in
// play, not just the option contract itself).
describe("expirationWaitLabel", () => {
  it("a PUT past expiration reads 'Awaiting Schwab expiration confirmation'", () => {
    expect(expirationWaitLabel("PAST_EXPIRATION_UNRESOLVED", "PUT")).toBe("Awaiting Schwab expiration confirmation");
  });

  it("a CALL past expiration (covered call + assigned shares) reads the share/call settlement wording, never 'called away' or any outcome claim", () => {
    const label = expirationWaitLabel("PAST_EXPIRATION_UNRESOLVED", "CALL");
    expect(label).toBe("Awaiting covered-call/share settlement confirmation");
    expect(label).not.toMatch(/called away|retained|worthless|expired OTM/i);
  });

  it("the intraday 'session just ended' variant keeps the same option-type split, with its own prefix", () => {
    expect(expirationWaitLabel("EXPIRATION_SESSION_ENDED", "PUT")).toBe("Expiration session ended - awaiting Schwab expiration confirmation");
    expect(expirationWaitLabel("EXPIRATION_SESSION_ENDED", "CALL")).toBe("Expiration session ended - awaiting covered-call/share settlement confirmation");
  });

  it("an unknown/null option type falls back to the put-style wording rather than guessing", () => {
    expect(expirationWaitLabel("PAST_EXPIRATION_UNRESOLVED", null)).toBe("Awaiting Schwab expiration confirmation");
  });
});

describe("moneynessDistanceLabel", () => {
  it("returns 'At strike' for ATM regardless of distance values", () => {
    expect(moneynessDistanceLabel({ moneyness: "ATM", dollarDistance: 0, percentageDistance: 0 })).toBe("At strike");
  });

  it("formats OTM/ITM distance as '<moneyness> by $X.XX / Y.Y%'", () => {
    expect(moneynessDistanceLabel({ moneyness: "OTM", dollarDistance: 5, percentageDistance: 20 })).toBe("OTM by $5.00 / 20.0%");
    expect(moneynessDistanceLabel({ moneyness: "ITM", dollarDistance: 1.256, percentageDistance: 3.21 })).toBe("ITM by $1.26 / 3.2%");
  });

  it("returns null when moneyness or either distance is missing", () => {
    expect(moneynessDistanceLabel({ moneyness: null, dollarDistance: 5, percentageDistance: 20 })).toBeNull();
    expect(moneynessDistanceLabel({ moneyness: "OTM", dollarDistance: null, percentageDistance: 20 })).toBeNull();
    expect(moneynessDistanceLabel({ moneyness: "OTM", dollarDistance: 5, percentageDistance: null })).toBeNull();
  });
});

/**
 * Weekend / Settlement Clarity - the actual Codex-found bug: the per-row badge (via
 * cannotAssessPresentationTier) and Dashboard's Attention Now list membership (via isAttentionRow)
 * used to consult two DIFFERENT allowlists for "is this reasonCode routine," so a row could render
 * calm (no badge) while still occupying an Attention Now slot. Both now share ONE allowlist
 * (isRoutineCannotAssessReason, positionReviewAssessment.ts) - this test proves it by construction,
 * across every reasonCode either module's own test fixtures reference, rather than trusting the two
 * call sites to never drift apart again silently.
 */
describe("cannotAssessPresentationTier and isAttentionRow never disagree (the actual Codex blocker fix)", () => {
  function unavailableDisplayFor(reasonCodes: string[]): PositionAssessmentDisplay {
    return {
      state: "UNAVAILABLE",
      currentUnavailable: {
        action: "CANNOT_ASSESS",
        lifecycle: "EXPIRATION_PENDING",
        evidence: { position: "MANUAL_POSITION", quote: "NOT_APPLICABLE", quoteIneligibleReason: null, session: "CLOSED" },
        explanation: {
          reasonCodes, optionType: "PUT", strike: 25, stockPrice: null, dollarDistance: null, percentageDistance: null,
          moneyness: null, bufferPercent: 3, expiration: new Date("2026-10-09"), daysToExpiration: -1,
          quoteTradeTime: null, quoteAgeMs: null, positionEvidenceAsOf: null, activeGuidanceDeadline: null,
          evaluatedAt: new Date("2026-10-10"),
        },
        priority: { group: 7, withinExpirationTodaySubgroup: null, expirationSortKey: "2026-10-09", ticker: "XYZ", accountId: "a1", campaignId: "c1" },
      },
    };
  }

  const reasonCodeScenarios: Array<[string, string[]]> = [
    ["routine: past-expiration unresolved alone", ["PAST_EXPIRATION_UNRESOLVED"]],
    ["routine: expiration session ended alone", ["EXPIRATION_SESSION_ENDED"]],
    ["routine: market closed alone", ["MARKET_CLOSED"]],
    ["routine: a QUOTE_-prefixed code alone", ["QUOTE_EVIDENCE_UNAVAILABLE"]],
    ["non-routine: assigned shares, no call", ["ASSIGNED_SHARES_NO_CALL"]],
    ["non-routine: a broker-evidenced position mismatch", ["POSITION_MISMATCH_AMBIGUOUS"]],
    ["non-routine: incomplete terms", ["INCOMPLETE_TERMS"]],
    ["non-routine: mixed routine + non-routine", ["MARKET_CLOSED", "ASSIGNED_SHARES_NO_CALL"]],
    ["non-routine: an unrecognized code", ["SOME_FUTURE_REASON_THIS_TEST_DOES_NOT_KNOW_ABOUT"]],
  ];

  it.each(reasonCodeScenarios)("%s", (_label, reasonCodes) => {
    const tier = cannotAssessPresentationTier(reasonCodes);
    const attention = isAttentionRow(unavailableDisplayFor(reasonCodes), true);
    // calm <=> excluded from Attention Now; attention <=> included - the two must always agree.
    expect(attention).toBe(tier === "attention");
  });
});
