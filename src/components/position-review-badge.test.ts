import { describe, expect, it } from "vitest";
import { actionLabelFor, cannotAssessPresentationTier, moneynessDistanceLabel } from "./position-review-badge";

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
