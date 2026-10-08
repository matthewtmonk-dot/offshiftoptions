import { describe, expect, it } from "vitest";
import { categorizeError, isTransientErrorCategory, tallyPositionAssessmentDisplays } from "./scheduled-capture";
import type { PositionAssessmentDisplay } from "@/domain/finance/positionReviewAssessment";
import type { PositionReviewResult } from "@/domain/finance/positionReview";

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

describe("categorizeError / isTransientErrorCategory", () => {
  it("categorizes an AbortError as PROVIDER_UNAVAILABLE (transient)", () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    expect(categorizeError(error)).toBe("PROVIDER_UNAVAILABLE");
    expect(isTransientErrorCategory(categorizeError(error))).toBe(true);
  });

  it("categorizes a network/fetch/429 message as PROVIDER_UNAVAILABLE (transient)", () => {
    expect(categorizeError(new Error("fetch failed: ECONNRESET"))).toBe("PROVIDER_UNAVAILABLE");
    expect(categorizeError(new Error("received 429 Too Many Requests"))).toBe("PROVIDER_UNAVAILABLE");
    expect(isTransientErrorCategory("PROVIDER_UNAVAILABLE")).toBe(true);
  });

  it("categorizes an auth/token message as AUTH_UNAVAILABLE (never retried automatically)", () => {
    expect(categorizeError(new Error("token refresh failed: unauthorized"))).toBe("AUTH_UNAVAILABLE");
    expect(isTransientErrorCategory("AUTH_UNAVAILABLE")).toBe(false);
  });

  it("categorizes an unrecognized error as UNKNOWN (never retried automatically)", () => {
    expect(categorizeError(new Error("something genuinely unexpected"))).toBe("UNKNOWN");
    expect(isTransientErrorCategory("UNKNOWN")).toBe(false);
  });

  it("categorizes a non-Error thrown value as UNKNOWN, never throws itself", () => {
    expect(categorizeError("a plain string")).toBe("UNKNOWN");
    expect(categorizeError(null)).toBe("UNKNOWN");
    expect(categorizeError(undefined)).toBe("UNKNOWN");
  });
});
