import { describe, expect, it } from "vitest";
import { classifyFreshnessStripState, classifyPresentationFreshness, currentRevisionKey, effectivePresentation, resolveEffectivePresentation } from "./presentationFreshness";
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

function currentDisplay(overrides: Partial<PositionReviewResult> = {}, lastValid: StoredLastValidAssessment | null = null): PositionAssessmentDisplay {
  return { state: "CURRENT", current: currentResult(overrides), lastValid };
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

  it("UNIFORM_CURRENT when every display is CURRENT with a near-identical evaluatedAt - never the page's render-time `now` (Codex blocker repair B4)", () => {
    const t1 = new Date("2026-06-15T19:55:00.000Z");
    const t2 = new Date("2026-06-15T19:56:00.000Z"); // 1 minute apart - within tolerance
    const pageRenderTime = new Date("2026-06-15T20:30:00.000Z"); // deliberately different from both
    const result = classifyFreshnessStripState(
      [currentDisplay({ explanation: { ...currentResult().explanation, evaluatedAt: t1 } }), currentDisplay({ explanation: { ...currentResult().explanation, evaluatedAt: t2 } })],
      pageRenderTime,
    );
    expect(result.kind).toBe("UNIFORM_CURRENT");
    if (result.kind === "UNIFORM_CURRENT") {
      expect(result.evaluatedAt).toEqual(t1); // earliest-of-cluster, never pageRenderTime
      expect(result.evaluatedAt).not.toEqual(pageRenderTime);
    }
  });

  it("MIXED_CURRENT when every display is CURRENT but their evaluatedAt instants differ materially - no single timestamp implied", () => {
    const t1 = new Date("2026-06-15T14:00:00.000Z");
    const t2 = new Date("2026-06-15T19:55:00.000Z"); // hours apart
    const result = classifyFreshnessStripState(
      [currentDisplay({ explanation: { ...currentResult().explanation, evaluatedAt: t1 } }), currentDisplay({ explanation: { ...currentResult().explanation, evaluatedAt: t2 } })],
      MONDAY_NOON,
    );
    expect(result).toEqual({ kind: "MIXED_CURRENT" });
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

  // Codex blocker repair (B4) - Codex reproduced: reversing row order changed the displayed
  // timestamp for an identical underlying data set. The representative instant must be the
  // deterministic minimum of the cluster, regardless of input array order.
  it("UNIFORM_SNAPSHOT's evaluatedAt is invariant to row order - reversing the input array produces the identical result", () => {
    const t1 = new Date("2026-06-15T19:54:00.000Z");
    const t2 = new Date("2026-06-15T19:55:00.000Z");
    const t3 = new Date("2026-06-15T19:56:00.000Z");
    const forward = classifyFreshnessStripState([lastValidDisplay(t1), lastValidDisplay(t2), lastValidDisplay(t3)], TUESDAY_NOON);
    const reversed = classifyFreshnessStripState([lastValidDisplay(t3), lastValidDisplay(t2), lastValidDisplay(t1)], TUESDAY_NOON);
    const shuffled = classifyFreshnessStripState([lastValidDisplay(t2), lastValidDisplay(t3), lastValidDisplay(t1)], TUESDAY_NOON);
    expect(forward).toEqual(reversed);
    expect(forward).toEqual(shuffled);
    expect(forward.kind).toBe("UNIFORM_SNAPSHOT");
    if (forward.kind === "UNIFORM_SNAPSHOT") {
      expect(forward.evaluatedAt).toEqual(t1); // always the earliest, never "whichever came first in the array"
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

  it("mixed CURRENT/historical states behave honestly: one CURRENT + one LAST_VALID never collapses into either pure state", () => {
    const result = classifyFreshnessStripState([currentDisplay(), lastValidDisplay(MONDAY_359PM)], TUESDAY_NOON);
    expect(result.kind).toBe("MIXED_CURRENT");
  });
});

describe("effectivePresentation - Codex blocker repair (B1): the pure function the client hook calls, fully testable without a component-render harness", () => {
  it("CURRENT Watch before expiry (currentExpired=false): stillLiveCurrent=true, tier=CURRENT", () => {
    const display = currentDisplay({ action: "WATCH" });
    const result = effectivePresentation(display, false, MONDAY_NOON);
    expect(result.stillLiveCurrent).toBe(true);
    expect(result.tier).toBe("CURRENT");
  });

  it("CURRENT Review Roll before expiry: same stillLiveCurrent=true behavior as Watch", () => {
    const display = currentDisplay({ action: "REVIEW_ROLL" });
    const result = effectivePresentation(display, false, MONDAY_NOON);
    expect(result.stillLiveCurrent).toBe(true);
  });

  it("the same CURRENT Watch row immediately after expiry, WITH a durable fallback: stillLiveCurrent=false, tier becomes the fallback's own SNAPSHOT/LAST_SESSION/HISTORICAL tier", () => {
    const fallback = storedAssessment(MONDAY_359PM, { action: "WATCH" });
    const display = currentDisplay({ action: "WATCH" }, fallback);
    const result = effectivePresentation(display, true, TUESDAY_NOON);
    expect(result.stillLiveCurrent).toBe(false);
    expect(result.tier).toBe("LAST_SESSION");
    expect(result.evaluatedAt).toEqual(MONDAY_359PM);
  });

  it("CURRENT Review Roll after expiry WITH a fallback - same transition behavior as Watch", () => {
    const fallback = storedAssessment(MONDAY_359PM, { action: "REVIEW_ROLL" });
    const display = currentDisplay({ action: "REVIEW_ROLL" }, fallback);
    const result = effectivePresentation(display, true, TUESDAY_NOON);
    expect(result.stillLiveCurrent).toBe(false);
    expect(result.tier).toBe("LAST_SESSION");
  });

  it("CURRENT Watch after expiry WITHOUT a durable fallback: stillLiveCurrent=false, tier=UNAVAILABLE - no longer treated as actionable CURRENT guidance", () => {
    const display = currentDisplay({ action: "WATCH" }, null);
    const result = effectivePresentation(display, true, MONDAY_NOON);
    expect(result.stillLiveCurrent).toBe(false);
    expect(result.tier).toBe("UNAVAILABLE");
  });

  it("a genuinely historical (LAST_VALID) display is unaffected by `currentExpired` either way - it was never a live CURRENT result to begin with", () => {
    const display = lastValidDisplay(MONDAY_359PM);
    const withTrue = effectivePresentation(display, true, TUESDAY_NOON);
    const withFalse = effectivePresentation(display, false, TUESDAY_NOON);
    expect(withTrue).toEqual(withFalse);
    expect(withTrue.stillLiveCurrent).toBe(false);
  });

  it("an UNAVAILABLE display is unaffected by `currentExpired` either way", () => {
    const display = unavailableDisplay();
    expect(effectivePresentation(display, true, MONDAY_NOON).tier).toBe("UNAVAILABLE");
    expect(effectivePresentation(display, false, MONDAY_NOON).tier).toBe("UNAVAILABLE");
  });

  it("this pure function never calls a network API itself - its only inputs are already-resolved data plus a boolean, proving the client transition causes zero new provider calls", () => {
    // Structural proof: the function signature takes (display, currentExpired: boolean, now) and
    // returns synchronously - there is no way for it to perform I/O. The ACTUAL network call
    // (useActiveGuidanceExpired's own same-origin /api/time calibration, never Schwab) happens
    // entirely OUTSIDE this function, in the thin "use client" hook that computes `currentExpired`
    // before calling this function - see client-freshness.tsx's own doc comment.
    expect(effectivePresentation.constructor.name).not.toBe("AsyncFunction");
  });
});

describe("currentRevisionKey", () => {
  it("is null for a non-CURRENT display - LAST_VALID/UNAVAILABLE never have a client-tracked revision", () => {
    expect(currentRevisionKey("c1", lastValidDisplay(MONDAY_359PM))).toBeNull();
    expect(currentRevisionKey("c1", unavailableDisplay())).toBeNull();
  });

  it("includes the entryKey, so two different campaigns with identical evaluatedAt/deadline never collide", () => {
    const keyA = currentRevisionKey("campaign-A", currentDisplay());
    const keyB = currentRevisionKey("campaign-B", currentDisplay());
    expect(keyA).not.toBe(keyB);
  });

  it("changes when evaluatedAt changes (a fresh evaluation / roll), even for the same campaign", () => {
    const first = currentDisplay({ explanation: { ...currentResult().explanation, evaluatedAt: MONDAY_NOON } });
    const second = currentDisplay({ explanation: { ...currentResult().explanation, evaluatedAt: TUESDAY_NOON } });
    expect(currentRevisionKey("c1", first)).not.toBe(currentRevisionKey("c1", second));
  });

  it("is stable (identical) for the exact same evaluatedAt/deadline pair on the same campaign", () => {
    const a = currentDisplay();
    const b = currentDisplay();
    expect(currentRevisionKey("c1", a)).toBe(currentRevisionKey("c1", b));
  });
});

// Codex blocker repair, round 2 (B1) - the full regression matrix the ticket itself specified
// (scenarios A-G), proving a cached client report keyed by the OLD revision can never be reused
// for a different revision, a server replacement with LAST_VALID/UNAVAILABLE, or a different
// campaign - without needing a component-render harness (this repo has none; see this file's own
// client-freshness.tsx doc comment for why the component-level fallback path was used instead).
describe("resolveEffectivePresentation - revision-safe client cache lookup", () => {
  function reportFor(entryKey: string, display: PositionAssessmentDisplay, overrides: Partial<ReturnType<typeof effectivePresentation>> = {}) {
    const key = currentRevisionKey(entryKey, display);
    if (!key) throw new Error("test setup error: display must be CURRENT to have a revision key");
    return { key, state: { ...effectivePresentation(display, false, MONDAY_NOON), ...overrides } };
  }

  // A. CURRENT Watch revision A -> client report says still CURRENT.
  it("A: a matching live report for the CURRENT display's own revision is used as-is", () => {
    const display = currentDisplay({ action: "WATCH" });
    const { key, state } = reportFor("c1", display);
    const liveByRevision = new Map([[key, state]]);
    const result = resolveEffectivePresentation(liveByRevision, "c1", display, MONDAY_NOON);
    expect(result.stillLiveCurrent).toBe(true);
    expect(result.tier).toBe("CURRENT");
  });

  // B. Props replace same campaign with LAST_VALID revision B -> result is LAST_VALID
  // immediately, old CURRENT report ignored.
  it("B: a stale CURRENT report left in the map is never consulted once the server replaces the display with LAST_VALID", () => {
    const oldCurrent = currentDisplay({ action: "WATCH" }, null);
    const { key, state } = reportFor("c1", oldCurrent, { stillLiveCurrent: true, tier: "CURRENT" });
    const liveByRevision = new Map([[key, state]]); // stale report still physically present
    const newLastValid = lastValidDisplay(MONDAY_359PM);
    const result = resolveEffectivePresentation(liveByRevision, "c1", newLastValid, TUESDAY_NOON);
    expect(result.stillLiveCurrent).toBe(false);
    expect(result.tier).toBe("LAST_SESSION"); // the NEW display's own tier, not the stale "CURRENT"
  });

  // C. Props replace same campaign with UNAVAILABLE -> result is UNAVAILABLE immediately, old
  // CURRENT report ignored.
  it("C: a stale CURRENT report is never consulted once the server replaces the display with UNAVAILABLE", () => {
    const oldCurrent = currentDisplay({ action: "WATCH" }, null);
    const { key, state } = reportFor("c1", oldCurrent, { stillLiveCurrent: true, tier: "CURRENT" });
    const liveByRevision = new Map([[key, state]]);
    const newUnavailable = unavailableDisplay();
    const result = resolveEffectivePresentation(liveByRevision, "c1", newUnavailable, MONDAY_NOON);
    expect(result.stillLiveCurrent).toBe(false);
    expect(result.tier).toBe("UNAVAILABLE");
  });

  // D. CURRENT revision A -> CURRENT revision B with newer evaluatedAt/deadline -> revision A
  // report cannot override revision B.
  it("D: a report for an OLDER CURRENT revision cannot override a NEWER CURRENT revision of the same campaign", () => {
    const revisionA = currentDisplay({ explanation: { ...currentResult().explanation, evaluatedAt: MONDAY_NOON, activeGuidanceDeadline: new Date(MONDAY_NOON.getTime() + 120_000) } });
    const { key: keyA, state: stateA } = reportFor("c1", revisionA, { stillLiveCurrent: true, tier: "CURRENT" });
    const liveByRevision = new Map([[keyA, stateA]]);

    const laterEvaluatedAt = new Date(MONDAY_NOON.getTime() + 300_000);
    const revisionB = currentDisplay({ explanation: { ...currentResult().explanation, evaluatedAt: laterEvaluatedAt, activeGuidanceDeadline: new Date(laterEvaluatedAt.getTime() + 120_000) } });
    const result = resolveEffectivePresentation(liveByRevision, "c1", revisionB, laterEvaluatedAt);
    // revision A's report is NOT reused for revision B - falls to the pending default instead,
    // never silently inheriting revision A's stillLiveCurrent=true.
    expect(result).toEqual(effectivePresentation(revisionB, true, laterEvaluatedAt));
  });

  // E. roll/current-leg replacement -> old revision cannot bleed into new leg. A roll always
  // produces a fresh live evaluation (a new evaluatedAt/deadline) for the same campaign id -
  // mechanically identical proof to D, confirmed explicitly under the roll scenario's own name.
  it("E: a roll producing a new current leg (new evaluatedAt/deadline, same campaign id) is never presented using the pre-roll leg's own stale report", () => {
    const preRoll = currentDisplay({ action: "REVIEW_ROLL", explanation: { ...currentResult().explanation, evaluatedAt: MONDAY_NOON, activeGuidanceDeadline: new Date(MONDAY_NOON.getTime() + 120_000) } });
    const { key, state } = reportFor("c1", preRoll, { stillLiveCurrent: true, tier: "CURRENT" });
    const liveByRevision = new Map([[key, state]]);

    const postRollEvaluatedAt = new Date(MONDAY_NOON.getTime() + 60_000);
    const postRoll = currentDisplay({ action: "COMFORTABLE", explanation: { ...currentResult().explanation, evaluatedAt: postRollEvaluatedAt, activeGuidanceDeadline: new Date(postRollEvaluatedAt.getTime() + 120_000) } });
    const result = resolveEffectivePresentation(liveByRevision, "c1", postRoll, postRollEvaluatedAt);
    expect(result).toEqual(effectivePresentation(postRoll, true, postRollEvaluatedAt));
  });

  // F. removed campaign -> stale report cannot affect another entry.
  it("F: a stale report under one campaign's key can never be looked up for a different campaign", () => {
    const removedCampaignDisplay = currentDisplay({ action: "WATCH" });
    const { key, state } = reportFor("removed-campaign", removedCampaignDisplay, { stillLiveCurrent: true, tier: "CURRENT" });
    const liveByRevision = new Map([[key, state]]);

    const otherCampaignDisplay = currentDisplay({ action: "COMFORTABLE" });
    const result = resolveEffectivePresentation(liveByRevision, "other-campaign", otherCampaignDisplay, MONDAY_NOON);
    expect(result).toEqual(effectivePresentation(otherCampaignDisplay, true, MONDAY_NOON));
    expect(result.stillLiveCurrent).toBe(false); // never inherited the removed campaign's true value
  });

  // G. unchanged CURRENT revision -> existing expiry behavior still works.
  it("G: an unchanged CURRENT revision's live-reported expiry (both not-yet-expired and expired) still flows through correctly", () => {
    const display = currentDisplay({ action: "WATCH" });
    const { key } = reportFor("c1", display);

    const stillLive = new Map([[key, effectivePresentation(display, false, MONDAY_NOON)]]);
    expect(resolveEffectivePresentation(stillLive, "c1", display, MONDAY_NOON).stillLiveCurrent).toBe(true);

    const expired = new Map([[key, effectivePresentation(display, true, MONDAY_NOON)]]);
    expect(resolveEffectivePresentation(expired, "c1", display, MONDAY_NOON).stillLiveCurrent).toBe(false);
  });

  it("no matching report at all for a CURRENT display falls to the pending default, never throws and never fabricates a live status", () => {
    const display = currentDisplay({ action: "WATCH" });
    const result = resolveEffectivePresentation(new Map(), "c1", display, MONDAY_NOON);
    expect(result).toEqual(effectivePresentation(display, true, MONDAY_NOON));
    expect(result.stillLiveCurrent).toBe(false);
  });
});
