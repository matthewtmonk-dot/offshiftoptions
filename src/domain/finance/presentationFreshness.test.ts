import { describe, expect, it } from "vitest";
import { classifyFreshnessStripState, classifyPresentationFreshness } from "./presentationFreshness";
import type { PositionAssessmentDisplay, StoredLastValidAssessment } from "./positionReviewAssessment";
import type { PositionReviewResult } from "./positionReview";

// 2026-06-15 is a Monday (matches positionReviewAssessment.test.ts's own NY_DATE fixture).
const MONDAY_NOON = new Date("2026-06-15T16:00:00.000Z");
const TUESDAY_NOON = new Date("2026-06-16T16:00:00.000Z");
const MONDAY_359PM = new Date("2026-06-15T19:59:00.000Z");
const FRIDAY_359PM = new Date("2026-06-12T19:59:00.000Z");
const SATURDAY = new Date("2026-06-13T18:00:00.000Z");
const TWO_WEEKS_LATER = new Date("2026-06-29T16:00:00.000Z");
// Mirrors positionReviewAssessment.test.ts's holiday fixture: July 4, 2026 is a Saturday (observed
// Friday July 3 is the NYSE holiday); July 2 (Thursday) is the last real trading day before the
// long weekend, July 6 (Monday) the next one.
const THURSDAY_BEFORE_HOLIDAY_359PM = new Date("2026-07-02T19:59:00.000Z");
const MONDAY_AFTER_HOLIDAY = new Date("2026-07-06T16:00:00.000Z");

function currentResult(overrides: Partial<PositionReviewResult> = {}): PositionReviewResult {
  return {
    action: "COMFORTABLE",
    lifecycle: "CURRENT_PUT",
    evidence: { position: "SCHWAB_CONFIRMED", quote: "ELIGIBLE", quoteIneligibleReason: null, session: "OPEN" },
    explanation: {
      reasonCodes: [], optionType: "PUT", strike: 25, stockPrice: 30, dollarDistance: 5, percentageDistance: 20,
      moneyness: "OTM", bufferPercent: 3, expiration: new Date("2026-12-18T00:00:00Z"), daysToExpiration: 10,
      quoteTradeTime: MONDAY_NOON, quoteAgeMs: 0, positionEvidenceAsOf: MONDAY_NOON,
      activeGuidanceDeadline: new Date(MONDAY_NOON.getTime() + 120_000), evaluatedAt: MONDAY_NOON,
    },
    priority: { group: 8, withinExpirationTodaySubgroup: null, expirationSortKey: "2026-12-18", ticker: "ZVER", accountId: "a", campaignId: "c" },
    ...overrides,
  };
}

function storedAssessment(evaluatedAt: Date, overrides: Partial<StoredLastValidAssessment> = {}): StoredLastValidAssessment {
  return {
    scope: { ownerId: "o", accountId: "a", campaignId: "c", openingEventId: "e" },
    contextFingerprint: "fp",
    action: "COMFORTABLE",
    reasonCodes: [],
    evaluatedAt,
    nySessionDate: "2026-06-15",
    regularSessionStart: new Date("2026-06-15T13:30:00Z"),
    regularSessionEnd: new Date("2026-06-15T20:00:00Z"),
    underlyingPrice: 30,
    underlyingTradeTime: evaluatedAt,
    ticker: "ZVER",
    optionType: "PUT",
    strike: 25,
    expiration: new Date("2026-12-18T00:00:00Z"),
    contracts: 1,
    moneyness: "OTM",
    dollarDistance: 5,
    percentageDistance: 20,
    appliedRollBufferPercent: 3,
    positionEvidenceSource: "MANUAL_POSITION",
    brokerReceiptAt: null,
    evaluationPolicyVersion: 1,
    ...overrides,
  };
}

function currentDisplay(): PositionAssessmentDisplay {
  return { state: "CURRENT", current: currentResult(), lastValid: null };
}
function lastValidDisplay(evaluatedAt: Date): PositionAssessmentDisplay {
  return { state: "LAST_VALID", currentUnavailable: currentResult({ action: "CANNOT_ASSESS" }), lastValid: storedAssessment(evaluatedAt) };
}
function unavailableDisplay(): PositionAssessmentDisplay {
  return { state: "UNAVAILABLE", currentUnavailable: currentResult({ action: "CANNOT_ASSESS" }) };
}

describe("classifyPresentationFreshness", () => {
  it("CURRENT display always classifies as CURRENT regardless of now", () => {
    expect(classifyPresentationFreshness(currentDisplay(), MONDAY_NOON)).toBe("CURRENT");
    expect(classifyPresentationFreshness(currentDisplay(), TWO_WEEKS_LATER)).toBe("CURRENT");
  });

  it("UNAVAILABLE display always classifies as UNAVAILABLE", () => {
    expect(classifyPresentationFreshness(unavailableDisplay(), MONDAY_NOON)).toBe("UNAVAILABLE");
  });

  it("LAST_VALID with a same-session evaluatedAt classifies as SNAPSHOT", () => {
    const evaluatedAt = new Date("2026-06-15T15:57:00.000Z"); // 11:57 AM ET, same Monday as now
    expect(classifyPresentationFreshness(lastValidDisplay(evaluatedAt), MONDAY_NOON)).toBe("SNAPSHOT");
  });

  it("LAST_VALID from the most recently completed NYSE session classifies as LAST_SESSION", () => {
    expect(classifyPresentationFreshness(lastValidDisplay(MONDAY_359PM), TUESDAY_NOON)).toBe("LAST_SESSION");
  });

  it("LAST_VALID older than the previous session classifies as HISTORICAL", () => {
    expect(classifyPresentationFreshness(lastValidDisplay(MONDAY_359PM), TWO_WEEKS_LATER)).toBe("HISTORICAL");
  });

  it("weekend: Friday's close stays LAST_SESSION across Saturday", () => {
    expect(classifyPresentationFreshness(lastValidDisplay(FRIDAY_359PM), SATURDAY)).toBe("LAST_SESSION");
  });

  it("weekend: Friday's close stays LAST_SESSION into the following Monday", () => {
    expect(classifyPresentationFreshness(lastValidDisplay(FRIDAY_359PM), MONDAY_NOON)).toBe("LAST_SESSION");
  });

  it("NYSE holiday: a Thursday-before-holiday close stays LAST_SESSION once `now` reaches the next real trading day", () => {
    expect(classifyPresentationFreshness(lastValidDisplay(THURSDAY_BEFORE_HOLIDAY_359PM), MONDAY_AFTER_HOLIDAY)).toBe("LAST_SESSION");
  });

  it("falls back to HISTORICAL (never a stronger label) for an unparseable/future evaluatedAt", () => {
    const future = new Date(MONDAY_NOON.getTime() + 999_999_999);
    expect(classifyPresentationFreshness(lastValidDisplay(future), MONDAY_NOON)).toBe("HISTORICAL");
  });

  it("NY day rollover: a late-evening evaluatedAt whose UTC calendar date is already the next day still classifies via its real NY calendar day, not raw UTC date", () => {
    // Monday 2026-06-15, 11:00 PM ET = 2026-06-16T03:00:00Z - the UTC calendar date is already
    // Tuesday the 16th, but the real NY calendar day is still Monday the 15th. Naively reading the
    // raw UTC date would wrongly match "now"'s own Tuesday-the-16th day (TODAY/SNAPSHOT); the real
    // NY-timezone conversion correctly resolves it as the previous session instead.
    const mondayLateEveningEt = new Date("2026-06-16T03:00:00.000Z");
    expect(classifyPresentationFreshness(lastValidDisplay(mondayLateEveningEt), TUESDAY_NOON)).toBe("LAST_SESSION");
  });
});

describe("classifyFreshnessStripState", () => {
  it("EMPTY when there are no displays at all", () => {
    expect(classifyFreshnessStripState([], MONDAY_NOON)).toEqual({ kind: "EMPTY" });
  });

  it("ALL_CURRENT when every display is CURRENT", () => {
    expect(classifyFreshnessStripState([currentDisplay(), currentDisplay()], MONDAY_NOON)).toEqual({ kind: "ALL_CURRENT" });
  });

  it("MIXED_CURRENT when some but not all displays are CURRENT", () => {
    expect(classifyFreshnessStripState([currentDisplay(), lastValidDisplay(MONDAY_359PM)], TUESDAY_NOON)).toEqual({ kind: "MIXED_CURRENT" });
  });

  it("ALL_UNAVAILABLE when nothing is CURRENT or LAST_VALID", () => {
    expect(classifyFreshnessStripState([unavailableDisplay(), unavailableDisplay()], MONDAY_NOON)).toEqual({ kind: "ALL_UNAVAILABLE" });
  });

  it("UNIFORM_SNAPSHOT when every LAST_VALID row shares the same tier and a near-identical evaluatedAt", () => {
    const t1 = new Date("2026-06-15T19:55:00.000Z");
    const t2 = new Date("2026-06-15T19:56:00.000Z"); // 1 minute apart - within tolerance
    const result = classifyFreshnessStripState([lastValidDisplay(t1), lastValidDisplay(t2)], TUESDAY_NOON);
    expect(result.kind).toBe("UNIFORM_SNAPSHOT");
    if (result.kind === "UNIFORM_SNAPSHOT") {
      expect(result.tier).toBe("LAST_SESSION");
      expect(result.evaluatedAt).toEqual(t1);
    }
  });

  it("MIXED_SNAPSHOTS when LAST_VALID rows' evaluatedAt instants differ materially - never implies one universal timestamp", () => {
    const t1 = new Date("2026-06-15T14:00:00.000Z");
    const t2 = new Date("2026-06-15T19:55:00.000Z"); // hours apart
    expect(classifyFreshnessStripState([lastValidDisplay(t1), lastValidDisplay(t2)], MONDAY_NOON)).toEqual({ kind: "MIXED_SNAPSHOTS" });
  });

  it("MIXED_SNAPSHOTS when LAST_VALID rows land in different timing tiers even if close in wall-clock time", () => {
    // One row evaluated today (SNAPSHOT), one from the previous session (LAST_SESSION) - never
    // merged into a single uniform label even if their raw ms-distance happens to be irrelevant.
    const today = new Date("2026-06-16T15:00:00.000Z");
    const previousSession = MONDAY_359PM;
    expect(classifyFreshnessStripState([lastValidDisplay(today), lastValidDisplay(previousSession)], TUESDAY_NOON).kind).toBe("MIXED_SNAPSHOTS");
  });
});
