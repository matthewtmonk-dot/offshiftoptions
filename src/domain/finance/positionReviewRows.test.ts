import { describe, expect, it } from "vitest";
import type { PositionReviewResult } from "./positionReview";
import type { PositionAssessmentDisplay } from "./positionReviewAssessment";
import { currentRevisionKey, effectivePresentation, type EffectivePresentation } from "./presentationFreshness";
import {
  attachPositionAssessmentDisplays,
  attentionNowRows,
  isAttentionRow,
  partitionPositionReviewRows,
  sortPositionToReviewDisplayRows,
} from "./positionReviewRows";

function reviewFixture(overrides: Partial<PositionReviewResult> = {}): PositionReviewResult {
  return {
    action: "COMFORTABLE",
    lifecycle: "CURRENT_PUT",
    evidence: { position: "SCHWAB_CONFIRMED", quote: "ELIGIBLE", quoteIneligibleReason: null, session: "OPEN" },
    explanation: {
      reasonCodes: [], optionType: "PUT", strike: 25, stockPrice: 30, dollarDistance: 5, percentageDistance: 20,
      moneyness: "OTM", bufferPercent: 3, expiration: new Date("2026-10-02"), daysToExpiration: 10,
      quoteTradeTime: new Date("2026-06-15T16:00:00Z"), quoteAgeMs: 0, positionEvidenceAsOf: new Date("2026-06-15T16:00:00Z"),
      activeGuidanceDeadline: new Date("2026-06-15T16:02:00Z"), evaluatedAt: new Date("2026-06-15T16:00:00Z"),
    },
    priority: { group: 8, withinExpirationTodaySubgroup: null, expirationSortKey: "2026-10-02", ticker: "XYZ", accountId: "a1", campaignId: "c1" },
    ...overrides,
  };
}

function displayFixture(overrides: Partial<PositionReviewResult> = {}): PositionAssessmentDisplay {
  return { state: "CURRENT", current: reviewFixture(overrides), lastValid: null };
}

function row(campaignId: string) {
  return { campaignId, ownerId: "u1", accountId: "a1", ticker: "XYZ", status: "OPEN" as const, stage: "Cash-secured put" as const, legType: "PUT" as const, strike: 25, expiration: new Date("2026-10-02"), quantity: 1, quantityUnit: "contracts" as const };
}

describe("Phase 2B - attachPositionAssessmentDisplays / sortPositionToReviewDisplayRows", () => {
  it("attaches a matching display by campaign id, and null when none exists", () => {
    const displays = new Map([["c1", displayFixture()]]);
    const [attached1, attached2] = attachPositionAssessmentDisplays([row("c1"), row("c2")], displays);
    expect(attached1.display).toEqual(displayFixture());
    expect(attached2.display).toBeNull();
  });

  it("sorts by the shared evaluator's own priority order, never by input order", () => {
    const reviewRoll = displayFixture({ action: "REVIEW_ROLL", priority: { group: 4, withinExpirationTodaySubgroup: null, expirationSortKey: "2026-10-02", ticker: "AAA", accountId: "a1", campaignId: "c1" } });
    const comfortable = displayFixture({ priority: { group: 8, withinExpirationTodaySubgroup: null, expirationSortKey: "2026-10-02", ticker: "ZZZ", accountId: "a1", campaignId: "c2" } });
    const attached = attachPositionAssessmentDisplays([row("c2"), row("c1")], new Map([["c1", reviewRoll], ["c2", comfortable]]));
    expect(sortPositionToReviewDisplayRows(attached).map((r) => r.campaignId)).toEqual(["c1", "c2"]);
  });

  it("sorts a row with no evaluable display after every row that has one, rather than guessing a priority", () => {
    const attached = attachPositionAssessmentDisplays([row("c1"), row("c2")], new Map([["c1", displayFixture()]]));
    expect(sortPositionToReviewDisplayRows(attached).map((r) => r.campaignId)).toEqual(["c1", "c2"]);
  });
});

// Attention-First Freshness Phase 1 - "Attention Now" never promotes a row that doesn't
// genuinely need review right now: COMFORTABLE (current, no action) and historical (LAST_VALID)
// actions are both excluded, even though a LAST_VALID row can carry a WATCH/REVIEW_ROLL action of
// its own - that action is only confirmed-stale context, never a live attention item.
describe("attentionNowRows - the server-side, render-time-only candidate list", () => {
  function unavailableDisplay(reasonCodes: string[]): PositionAssessmentDisplay {
    return { state: "UNAVAILABLE", currentUnavailable: reviewFixture({ action: "CANNOT_ASSESS", explanation: { ...reviewFixture().explanation, reasonCodes } }) };
  }
  function lastValidDisplay(action: PositionReviewResult["action"]): PositionAssessmentDisplay {
    return {
      state: "LAST_VALID",
      currentUnavailable: reviewFixture({ action: "CANNOT_ASSESS", explanation: { ...reviewFixture().explanation, reasonCodes: ["MARKET_CLOSED"] } }),
      lastValid: {
        scope: { ownerId: "u1", accountId: "a1", campaignId: "c1", openingEventId: "e1" }, contextFingerprint: "fp",
        action: action === "CANNOT_ASSESS" ? "COMFORTABLE" : action, reasonCodes: [], evaluatedAt: new Date("2026-06-15T16:00:00Z"),
        nySessionDate: "2026-06-15", regularSessionStart: new Date("2026-06-15T13:30:00Z"), regularSessionEnd: new Date("2026-06-15T20:00:00Z"),
        underlyingPrice: 30, underlyingTradeTime: new Date("2026-06-15T16:00:00Z"), ticker: "XYZ", optionType: "PUT", strike: 25,
        expiration: new Date("2026-10-02"), contracts: 1, moneyness: "OTM", dollarDistance: 5, percentageDistance: 20,
        appliedRollBufferPercent: 3, positionEvidenceSource: "MANUAL_POSITION", brokerReceiptAt: null, evaluationPolicyVersion: 1,
      },
    };
  }

  it("excludes a CURRENT Comfortable row - current, no action needed is not an attention item", () => {
    const attached = attachPositionAssessmentDisplays([row("c1")], new Map([["c1", displayFixture({ action: "COMFORTABLE" })]]));
    expect(attentionNowRows(attached)).toHaveLength(0);
  });

  it("includes a CURRENT Watch/Review roll/Review call row", () => {
    for (const action of ["WATCH", "REVIEW_ROLL", "REVIEW_CALL"] as const) {
      const attached = attachPositionAssessmentDisplays([row("c1")], new Map([["c1", displayFixture({ action })]]));
      expect(attentionNowRows(attached).map((r) => r.campaignId)).toEqual(["c1"]);
    }
  });

  it("excludes a row with no display at all", () => {
    const attached = attachPositionAssessmentDisplays([row("c1")], new Map());
    expect(attentionNowRows(attached)).toHaveLength(0);
  });

  it("excludes a LAST_VALID row even when its own stored action is Watch/Review - historical action is context, never a live attention item", () => {
    const attached = [{ ...row("c1"), display: lastValidDisplay("WATCH") }];
    expect(attentionNowRows(attached)).toHaveLength(0);
  });

  it("excludes an UNAVAILABLE row carrying only a known transient/benign reason (market closed, quote momentarily unavailable)", () => {
    const attached = [{ ...row("c1"), display: unavailableDisplay(["MARKET_CLOSED"]) }];
    expect(attentionNowRows(attached)).toHaveLength(0);
  });

  // Weekend / Settlement Clarity - PAST_EXPIRATION_UNRESOLVED/EXPIRATION_SESSION_ENDED are routine
  // settlement waiting (isRoutineCannotAssessReason), NOT a contradiction - an expired-but-
  // unresolved put/covered call must never occupy an Attention Now slot on its own. This was the
  // actual Codex-found bug: these two reason codes are deliberately absent from the DIFFERENT,
  // stricter isKnownTransientFallbackReason allowlist (fallback-safety, not urgency), and this
  // function used to reuse THAT allowlist as a proxy for "is this a contradiction," incorrectly
  // promoting routine settlement-wait rows into Attention Now despite their own badge rendering
  // calm (cannotAssessPresentationTier).
  it("excludes an UNAVAILABLE row carrying only routine settlement-wait reasons (past-expiration unresolved, expiration session ended) - routine waiting alone is never Attention Now", () => {
    expect(attentionNowRows([{ ...row("c1"), display: unavailableDisplay(["PAST_EXPIRATION_UNRESOLVED"]) }])).toHaveLength(0);
    expect(attentionNowRows([{ ...row("c1"), display: unavailableDisplay(["EXPIRATION_SESSION_ENDED"]) }])).toHaveLength(0);
  });

  it("includes an UNAVAILABLE row carrying a genuine contradiction reason (e.g. a broker-evidenced position mismatch)", () => {
    const attached = [{ ...row("c1"), display: unavailableDisplay(["POSITION_MISMATCH_AMBIGUOUS"]) }];
    expect(attentionNowRows(attached).map((r) => r.campaignId)).toEqual(["c1"]);
  });

  it("includes an UNAVAILABLE row even when a routine settlement-wait reason is mixed with a genuine one - one real issue is never hidden by an accompanying routine one", () => {
    const attached = [{ ...row("c1"), display: unavailableDisplay(["PAST_EXPIRATION_UNRESOLVED", "ASSIGNED_SHARES_NO_CALL"]) }];
    expect(attentionNowRows(attached).map((r) => r.campaignId)).toEqual(["c1"]);
  });

  it("returns an empty list (never a guessed/placeholder item) when nothing needs attention - supports the Dashboard's own 'No new attention items' empty state", () => {
    const attached = attachPositionAssessmentDisplays([row("c1"), row("c2")], new Map([
      ["c1", displayFixture({ action: "COMFORTABLE" })],
      ["c2", lastValidDisplay("REVIEW_ROLL")],
    ]));
    expect(attentionNowRows(attached)).toEqual([]);
  });
});

describe("isAttentionRow - currentStillLive gates a CURRENT Watch/Review row, never a deadline-free UNAVAILABLE contradiction", () => {
  it("a CURRENT Watch row is attention-eligible only while currentStillLive is true", () => {
    expect(isAttentionRow(displayFixture({ action: "WATCH" }), true)).toBe(true);
    expect(isAttentionRow(displayFixture({ action: "WATCH" }), false)).toBe(false);
  });

  it("an UNAVAILABLE contradiction row ignores currentStillLive entirely - it has no deadline to expire", () => {
    const display: PositionAssessmentDisplay = { state: "UNAVAILABLE", currentUnavailable: reviewFixture({ action: "CANNOT_ASSESS", explanation: { ...reviewFixture().explanation, reasonCodes: ["POSITION_MISMATCH_AMBIGUOUS"] } }) };
    expect(isAttentionRow(display, false)).toBe(true);
    expect(isAttentionRow(display, true)).toBe(true);
  });

  it("null display is never attention-eligible", () => {
    expect(isAttentionRow(null, true)).toBe(false);
  });
});

/**
 * Compact position UX, final blocker repair - the Codex-found blocker: Attention Now (client-side,
 * deadline-aware) and Open Positions (server-computed once) previously derived from two
 * independent sources, so a row leaving Attention Now when its guidance deadline passed in the
 * browser was never added back to Open Positions until the next server render - it vanished from
 * BOTH sections. These tests drive partitionPositionReviewRows through the REAL client transition
 * mechanism (effectivePresentation/currentRevisionKey, presentationFreshness.ts - the exact pure
 * functions RowObserver/ClientPresentationProvider call in production), not a reimplemented
 * test-only stand-in, so the regression this proves is the actual production decision path.
 */
describe("partitionPositionReviewRows - the ONE live-membership split both Dashboard sections render from", () => {
  const now = new Date("2026-06-15T16:01:00Z");

  /** Simulates ClientPresentationProvider's own liveByRevision Map after a RowObserver has
   * reported a report for `display`, using the REAL effectivePresentation function - exactly what
   * RowObserver's effect computes and reports every render (client-freshness.tsx). */
  function liveReportFor(entryKey: string, display: PositionAssessmentDisplay, currentExpired: boolean): [string, EffectivePresentation] | null {
    const revisionKey = currentRevisionKey(entryKey, display);
    if (!revisionKey) return null;
    return [revisionKey, effectivePresentation(display, currentExpired, now)];
  }

  it("A in Attention Now, B in Open Positions, B never disturbed when A later expires", () => {
    const displayA = displayFixture({ action: "WATCH", priority: { group: 4, withinExpirationTodaySubgroup: null, expirationSortKey: "2026-10-02", ticker: "A", accountId: "a1", campaignId: "A" } });
    const displayB = displayFixture({ action: "COMFORTABLE", priority: { group: 8, withinExpirationTodaySubgroup: null, expirationSortKey: "2026-10-02", ticker: "B", accountId: "a1", campaignId: "B" } });
    const rows = sortPositionToReviewDisplayRows(
      attachPositionAssessmentDisplays([row("A"), row("B")], new Map([["A", displayA], ["B", displayB]])),
    );

    // INITIAL: calibration has confirmed A is genuinely still live (within its guidance deadline).
    const liveReportA = liveReportFor("A", displayA, false);
    expect(liveReportA).not.toBeNull();
    const initialLive = new Map([liveReportA!]);

    const initial = partitionPositionReviewRows(rows, initialLive, now);
    expect(initial.attention.map((r) => r.campaignId)).toEqual(["A"]);
    expect(initial.open.map((r) => r.campaignId)).toEqual(["B"]);

    // THEN: the real client freshness transition - A's own guidance deadline passes, and
    // RowObserver reports expired: true for the SAME revision (exactly what useActiveGuidanceExpired
    // flipping to true, or a tab-visibility resume, causes in production).
    const expiredReportA = liveReportFor("A", displayA, true);
    const liveAfterExpiry = new Map([expiredReportA!]);

    const after = partitionPositionReviewRows(rows, liveAfterExpiry, now);
    expect(after.attention.map((r) => r.campaignId)).toEqual([]);
    expect(after.open.map((r) => r.campaignId).sort()).toEqual(["A", "B"]);

    // The hard invariant: A is in exactly one bucket, at every point in time, never both, never
    // neither. B is undisturbed throughout.
    for (const partition of [initial, after]) {
      const attentionIds = new Set(partition.attention.map((r) => r.campaignId));
      const openIds = new Set(partition.open.map((r) => r.campaignId));
      for (const id of ["A", "B"]) {
        const inAttention = attentionIds.has(id);
        const inOpen = openIds.has(id);
        expect(inAttention && inOpen).toBe(false); // never both
        expect(inAttention || inOpen).toBe(true); // never neither
      }
    }
    expect(initial.open.map((r) => r.campaignId)).toEqual(["B"]);
    expect(after.open.some((r) => r.campaignId === "B")).toBe(true);
  });

  it("all-attention case: Open Positions empties out, then repopulates the instant one row expires - the empty state must track this exactly", () => {
    const displayA = displayFixture({ action: "WATCH", priority: { group: 4, withinExpirationTodaySubgroup: null, expirationSortKey: "2026-10-02", ticker: "A", accountId: "a1", campaignId: "A" } });
    const displayB = displayFixture({ action: "REVIEW_ROLL", priority: { group: 1, withinExpirationTodaySubgroup: null, expirationSortKey: "2026-10-02", ticker: "B", accountId: "a1", campaignId: "B" } });
    const rows = sortPositionToReviewDisplayRows(
      attachPositionAssessmentDisplays([row("A"), row("B")], new Map([["A", displayA], ["B", displayB]])),
    );

    const initialLive = new Map([liveReportFor("A", displayA, false)!, liveReportFor("B", displayB, false)!]);
    const initial = partitionPositionReviewRows(rows, initialLive, now);
    expect(initial.attention.map((r) => r.campaignId).sort()).toEqual(["A", "B"]);
    expect(initial.open).toEqual([]); // the empty-state condition

    const liveAfterAExpires = new Map([liveReportFor("A", displayA, true)!, liveReportFor("B", displayB, false)!]);
    const after = partitionPositionReviewRows(rows, liveAfterAExpires, now);
    expect(after.attention.map((r) => r.campaignId)).toEqual(["B"]);
    expect(after.open.map((r) => r.campaignId)).toEqual(["A"]); // empty state must now be gone
  });

  it("a row with no live report yet (before any observer has mounted/reported) falls back to the shared pending default - never crashes, never appears in both", () => {
    const displayA = displayFixture({ action: "WATCH" });
    const rows = attachPositionAssessmentDisplays([row("A")], new Map([["A", displayA]]));
    const { attention, open } = partitionPositionReviewRows(rows, new Map(), now);
    expect(attention).toEqual([]);
    expect(open.map((r) => r.campaignId)).toEqual(["A"]);
  });

  it("an UNAVAILABLE contradiction row has no deadline to expire and stays in Attention Now across any liveByRevision state", () => {
    const display: PositionAssessmentDisplay = { state: "UNAVAILABLE", currentUnavailable: reviewFixture({ action: "CANNOT_ASSESS", explanation: { ...reviewFixture().explanation, reasonCodes: ["POSITION_MISMATCH_AMBIGUOUS"] } }) };
    const rows = attachPositionAssessmentDisplays([row("A")], new Map([["A", display]]));
    expect(partitionPositionReviewRows(rows, new Map(), now).attention.map((r) => r.campaignId)).toEqual(["A"]);
  });

  it("preserves the input's priority order within each bucket, never re-sorting", () => {
    const highPriority = displayFixture({ action: "COMFORTABLE", priority: { group: 1, withinExpirationTodaySubgroup: null, expirationSortKey: "2026-10-02", ticker: "A", accountId: "a1", campaignId: "A" } });
    const lowPriority = displayFixture({ action: "COMFORTABLE", priority: { group: 8, withinExpirationTodaySubgroup: null, expirationSortKey: "2026-10-02", ticker: "B", accountId: "a1", campaignId: "B" } });
    const rows = sortPositionToReviewDisplayRows(
      attachPositionAssessmentDisplays([row("B"), row("A")], new Map([["A", highPriority], ["B", lowPriority]])),
    );
    expect(rows.map((r) => r.campaignId)).toEqual(["A", "B"]); // sorted by priority before partitioning
    expect(partitionPositionReviewRows(rows, new Map(), now).open.map((r) => r.campaignId)).toEqual(["A", "B"]);
  });
});
