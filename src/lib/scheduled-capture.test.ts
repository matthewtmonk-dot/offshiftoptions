import { describe, expect, it } from "vitest";
import { classifyCaptureOutcome, describeScheduledCaptureStatus, tallyPositionAssessmentDisplays, type LatestScheduledCaptureStatus } from "./scheduled-capture";
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

  it("Codex blocker repair (B4, round 2): a LAST_VALID display NEVER counts as CURRENT_CAPTURED - a historical fallback is valuable for financial presentation but is not an operationally successful scheduled capture", () => {
    expect(classifyCaptureOutcome([{ display: lastValidDisplay(["POSITION_BROKER_UNAVAILABLE"]) }], false)).toBe("PROVIDER_UNAVAILABLE");
  });

  it("Codex blocker repair (B4, round 2): LAST_VALID + auth-expired classifies as AUTH_UNAVAILABLE, not CURRENT_CAPTURED", () => {
    expect(classifyCaptureOutcome([{ display: lastValidDisplay(["POSITION_BROKER_UNAVAILABLE"]) }], true)).toBe("AUTH_UNAVAILABLE");
  });

  it("Codex blocker repair (B4, round 2): a real CURRENT display alongside ONLY LAST_VALID siblings still allows CURRENT_CAPTURED", () => {
    const resolved = [{ display: currentDisplay() }, { display: lastValidDisplay(["POSITION_BROKER_UNAVAILABLE"]) }];
    expect(classifyCaptureOutcome(resolved, false)).toBe("CURRENT_CAPTURED");
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

describe("describeScheduledCaptureStatus (Codex blocker repair B2/B4/B5 UI wording)", () => {
  const AT = new Date("2026-10-08T14:00:00Z");

  function known(status: "SUCCEEDED" | "FAILED" | "DEFERRED" | "ABANDONED", resultCategory: string | null): LatestScheduledCaptureStatus {
    return { known: true, status, resultCategory, at: AT, slot: "OPENING" };
  }

  it("never known -> neutral 'no runs yet'", () => {
    expect(describeScheduledCaptureStatus({ known: false })).toEqual({ label: "No runs yet.", tone: "neutral" });
  });

  it("CURRENT_CAPTURED -> the ONLY healthy tone", () => {
    expect(describeScheduledCaptureStatus(known("SUCCEEDED", "CURRENT_CAPTURED")).tone).toBe("healthy");
  });

  it("every other SUCCEEDED resultCategory is neutral, never healthy", () => {
    expect(describeScheduledCaptureStatus(known("SUCCEEDED", "NO_CURRENT_LEGITIMATE")).tone).toBe("neutral");
    expect(describeScheduledCaptureStatus(known("SUCCEEDED", "SESSION_CLOSED")).tone).toBe("neutral");
  });

  it("CONTRADICTION_DETECTED is attention, never healthy", () => {
    expect(describeScheduledCaptureStatus(known("SUCCEEDED", "CONTRADICTION_DETECTED")).tone).toBe("attention");
  });

  it("Codex blocker repair (B1, round 2) - SESSION_UNAVAILABLE is attention, distinct wording from PROVIDER_UNAVAILABLE", () => {
    const sessionUnavailable = describeScheduledCaptureStatus(known("FAILED", "SESSION_UNAVAILABLE"));
    const providerUnavailable = describeScheduledCaptureStatus(known("FAILED", "PROVIDER_UNAVAILABLE"));
    expect(sessionUnavailable.tone).toBe("attention");
    expect(providerUnavailable.tone).toBe("attention");
    expect(sessionUnavailable.label).not.toBe(providerUnavailable.label);
  });

  it("AUTH_UNAVAILABLE is attention and mentions reconnecting", () => {
    const result = describeScheduledCaptureStatus(known("FAILED", "AUTH_UNAVAILABLE"));
    expect(result.tone).toBe("attention");
    expect(result.label.toLowerCase()).toContain("reconnect");
  });

  it("Codex blocker repair (B3/B4, round 2) - TIMEOUT is attention and never claims Healthy, even though a historical fallback may exist", () => {
    const result = describeScheduledCaptureStatus(known("FAILED", "TIMEOUT"));
    expect(result.tone).toBe("attention");
    expect(result.label.toLowerCase()).toContain("timeout");
    expect(result.label).not.toContain("Healthy");
  });

  it("Codex blocker repair (B2, round 2) - BUDGET_BLOCKED is attention and textually distinct from ordinary DEFERRED", () => {
    const blocked = describeScheduledCaptureStatus(known("FAILED", "BUDGET_BLOCKED"));
    const deferred = describeScheduledCaptureStatus(known("DEFERRED", "BUDGET_DEFERRED"));
    expect(blocked.tone).toBe("attention");
    expect(deferred.tone).toBe("neutral");
    expect(blocked.label).not.toBe(deferred.label);
    expect(blocked.label.toLowerCase()).toContain("budget");
    expect(deferred.label.toLowerCase()).toContain("deferred");
  });

  it("UNKNOWN_ERROR is attention", () => {
    expect(describeScheduledCaptureStatus(known("FAILED", "UNKNOWN_ERROR")).tone).toBe("attention");
  });

  it("ABANDONED is attention regardless of resultCategory", () => {
    expect(describeScheduledCaptureStatus(known("ABANDONED", "ABANDONED_STALE")).tone).toBe("attention");
  });

  it("no status/category combination ever produces the literal word 'Healthy' except CURRENT_CAPTURED", () => {
    const categories = [
      "NO_CURRENT_LEGITIMATE", "SESSION_CLOSED", "CONTRADICTION_DETECTED", "PROVIDER_UNAVAILABLE",
      "SESSION_UNAVAILABLE", "AUTH_UNAVAILABLE", "TIMEOUT", "UNKNOWN_ERROR", "BUDGET_BLOCKED",
    ];
    for (const category of categories) {
      expect(describeScheduledCaptureStatus(known("FAILED", category)).label).not.toContain("Healthy");
      expect(describeScheduledCaptureStatus(known("SUCCEEDED", category)).label).not.toContain("Healthy");
    }
  });
});
