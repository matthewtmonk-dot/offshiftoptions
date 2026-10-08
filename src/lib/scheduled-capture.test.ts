import { describe, expect, it } from "vitest";
import { classifyCaptureOutcome, tallyPositionAssessmentDisplays } from "./scheduled-capture";
import type { PositionAssessmentDisplay } from "@/domain/finance/positionReviewAssessment";
import type { PositionReviewResult } from "@/domain/finance/positionReview";
import type { StoredLastValidAssessment } from "@/domain/finance/positionReviewAssessment";

function currentResult(overrides: Partial<PositionReviewResult> = {}): PositionReviewResult {
  return {
    action: "COMFORTABLE",
    lifecycle: "CURRENT_PUT",
    evidence: { position: "SCHWAB_CONFIRMED", quote: "ELIGIBLE", quoteIneligibleReason: null, session: "OPEN" },
    explanation: {
      reasonCodes: [], optionType: "PUT", strike: 25, stockPrice: 30, dollarDistance: 5, percentageDistance: 20,
      moneyness: "OTM", bufferPercent: 3, expiration: new Date("2026-12-18T00:00:00Z"), daysToExpiration: 10,
      quoteTradeTime: new Date("2026-10-08T14:00:00Z"), quoteAgeMs: 0, positionEvidenceAsOf: new Date("2026-10-08T14:00:00Z"),
      activeGuidanceDeadline: new Date("2026-10-08T14:02:00Z"), evaluatedAt: new Date("2026-10-08T14:00:00Z"),
    },
    priority: { group: 8, withinExpirationTodaySubgroup: null, expirationSortKey: "2026-12-18", ticker: "ZVER", accountId: "a", campaignId: "c" },
    ...overrides,
  };
}

function currentDisplay(action: PositionReviewResult["action"] = "COMFORTABLE"): PositionAssessmentDisplay {
  return { state: "CURRENT", current: currentResult({ action }), lastValid: null };
}
function unavailableDisplay(reasonCodes: string[]): PositionAssessmentDisplay {
  return { state: "UNAVAILABLE", currentUnavailable: currentResult({ action: "CANNOT_ASSESS", explanation: { ...currentResult().explanation, reasonCodes } }) };
}
function lastValidDisplay(reasonCodes: string[]): PositionAssessmentDisplay {
  const fallback = {} as StoredLastValidAssessment;
  return { state: "LAST_VALID", currentUnavailable: currentResult({ action: "CANNOT_ASSESS", explanation: { ...currentResult().explanation, reasonCodes } }), lastValid: fallback };
}

describe("tallyPositionAssessmentDisplays", () => {
  it("counts a CURRENT display as a persisted current assessment", () => {
    const tally = tallyPositionAssessmentDisplays([{ display: currentDisplay() }]);
    expect(tally).toEqual({ positionsExamined: 1, currentAssessmentsPersisted: 1, unavailableCount: 0, contradictionCount: 0 });
  });

  it("counts an UNAVAILABLE display with only a known transient reason as unavailable, NOT a contradiction", () => {
    const tally = tallyPositionAssessmentDisplays([{ display: unavailableDisplay(["MARKET_CLOSED"]) }]);
    expect(tally).toEqual({ positionsExamined: 1, currentAssessmentsPersisted: 0, unavailableCount: 1, contradictionCount: 0 });
  });

  it("counts an UNAVAILABLE display with a genuine contradiction reason as both unavailable AND a contradiction", () => {
    const tally = tallyPositionAssessmentDisplays([{ display: unavailableDisplay(["PAST_EXPIRATION_UNRESOLVED"]) }]);
    expect(tally).toEqual({ positionsExamined: 1, currentAssessmentsPersisted: 0, unavailableCount: 1, contradictionCount: 1 });
  });

  it("a mixed set tallies each category independently", () => {
    const tally = tallyPositionAssessmentDisplays([
      { display: currentDisplay("WATCH") },
      { display: currentDisplay("COMFORTABLE") },
      { display: unavailableDisplay(["MARKET_CLOSED"]) },
      { display: unavailableDisplay(["PAST_EXPIRATION_UNRESOLVED"]) },
    ]);
    expect(tally).toEqual({ positionsExamined: 4, currentAssessmentsPersisted: 2, unavailableCount: 2, contradictionCount: 1 });
  });

  it("an empty set produces all-zero counts, never a guessed non-zero value", () => {
    expect(tallyPositionAssessmentDisplays([])).toEqual({ positionsExamined: 0, currentAssessmentsPersisted: 0, unavailableCount: 0, contradictionCount: 0 });
  });
});

describe("classifyCaptureOutcome (Codex blocker repair B5)", () => {
  it("classifies zero relevant campaigns as legitimately nothing to capture, never an error", () => {
    expect(classifyCaptureOutcome([], false)).toBe("NO_CURRENT_LEGITIMATE");
  });

  it("classifies at least one CURRENT display as CURRENT_CAPTURED", () => {
    expect(classifyCaptureOutcome([{ display: currentDisplay() }], false)).toBe("CURRENT_CAPTURED");
  });

  it("classifies a verified LAST_VALID display as CURRENT_CAPTURED - a historical fallback is a real success", () => {
    expect(classifyCaptureOutcome([{ display: lastValidDisplay(["POSITION_BROKER_UNAVAILABLE"]) }], false)).toBe("CURRENT_CAPTURED");
  });

  it("classifies only benign/awaiting-confirmation reasons as NO_CURRENT_LEGITIMATE, not an error", () => {
    expect(classifyCaptureOutcome([{ display: unavailableDisplay(["POSITION_AWAITING_CONFIRMATION"]) }], false)).toBe("NO_CURRENT_LEGITIMATE");
    expect(classifyCaptureOutcome([{ display: unavailableDisplay(["QUOTE_STALE_TIMESTAMP"]) }], false)).toBe("NO_CURRENT_LEGITIMATE");
  });

  it("classifies a broker/quote/session provider reason as PROVIDER_UNAVAILABLE when auth is NOT expired", () => {
    expect(classifyCaptureOutcome([{ display: unavailableDisplay(["POSITION_BROKER_UNAVAILABLE"]) }], false)).toBe("PROVIDER_UNAVAILABLE");
    expect(classifyCaptureOutcome([{ display: unavailableDisplay(["QUOTE_EVIDENCE_UNAVAILABLE"]) }], false)).toBe("PROVIDER_UNAVAILABLE");
    expect(classifyCaptureOutcome([{ display: unavailableDisplay(["QUOTE_SESSION_EVIDENCE_UNAVAILABLE"]) }], false)).toBe("PROVIDER_UNAVAILABLE");
  });

  it("classifies the SAME broker/quote/session provider reason as AUTH_UNAVAILABLE when this owner's token refresh already failed", () => {
    expect(classifyCaptureOutcome([{ display: unavailableDisplay(["POSITION_BROKER_UNAVAILABLE"]) }], true)).toBe("AUTH_UNAVAILABLE");
  });

  it("classifies a MARKET_CLOSED-only reason as SESSION_CLOSED (defensive - B1's own gate should normally intercept this earlier)", () => {
    expect(classifyCaptureOutcome([{ display: unavailableDisplay(["MARKET_CLOSED"]) }], false)).toBe("SESSION_CLOSED");
  });

  it("classifies any genuinely unrecognized reason as CONTRADICTION_DETECTED - never silently downgraded", () => {
    expect(classifyCaptureOutcome([{ display: unavailableDisplay(["PAST_EXPIRATION_UNRESOLVED"]) }], false)).toBe("CONTRADICTION_DETECTED");
  });

  it("a contradiction wins even alongside an otherwise-successful CURRENT display in the same run", () => {
    const resolved = [{ display: currentDisplay() }, { display: unavailableDisplay(["PAST_EXPIRATION_UNRESOLVED"]) }];
    expect(classifyCaptureOutcome(resolved, false)).toBe("CONTRADICTION_DETECTED");
  });

  it("a CURRENT display wins over a merely benign/provider-unavailable sibling in the same run", () => {
    const resolved = [{ display: currentDisplay() }, { display: unavailableDisplay(["POSITION_BROKER_UNAVAILABLE"]) }];
    expect(classifyCaptureOutcome(resolved, false)).toBe("CURRENT_CAPTURED");
  });
});
