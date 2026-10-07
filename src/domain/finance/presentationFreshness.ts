import { classifyLastValidTiming, type PositionAssessmentDisplay } from "./positionReviewAssessment";
import type { PositionReviewResult } from "./positionReview";

/**
 * LST "Attention-First Freshness" Phase 1 - a PRESENTATION-ONLY freshness taxonomy, derived
 * entirely from the already-approved CURRENT/LAST_VALID/UNAVAILABLE display model and the
 * already-approved classifyLastValidTiming tiering (positionReviewAssessment.ts). This module adds
 * zero new domain state, zero new trust/eligibility rules, and never re-derives "is this fallback
 * allowed" itself - it only relabels an ALREADY-DECIDED display for richer presentation.
 *
 * CURRENT      - display.state === "CURRENT" (the existing strict current-evidence rules already
 *                decided this; unaffected by anything here).
 * SNAPSHOT     - a LAST_VALID row whose stored evaluatedAt falls in classifyLastValidTiming's
 *                TODAY tier (same NYSE market day as `now`) - a same-session observation that no
 *                longer qualifies as live guidance, but is still useful context.
 * LAST_SESSION - a LAST_VALID row in the PREVIOUS_SESSION tier (the most recently completed NYSE
 *                market day) - clearly historical, still useful.
 * HISTORICAL   - a LAST_VALID row in the OLDER tier (anything classifyLastValidTiming could not
 *                justify as TODAY or PREVIOUS_SESSION) - the conservative fallback label for any
 *                session provenance this module can't confidently claim is fresher. Never invents
 *                an official close or a stronger label than the evidence supports.
 * UNAVAILABLE  - display.state === "UNAVAILABLE" (no safe usable observation exists at all).
 */
export type PresentationFreshnessTier = "CURRENT" | "SNAPSHOT" | "LAST_SESSION" | "HISTORICAL" | "UNAVAILABLE";

export function classifyPresentationFreshness(display: PositionAssessmentDisplay, now: Date): PresentationFreshnessTier {
  if (display.state === "CURRENT") {
    return "CURRENT";
  }
  if (display.state === "UNAVAILABLE") {
    return "UNAVAILABLE";
  }
  const tier = classifyLastValidTiming(display.lastValid.evaluatedAt, now);
  if (tier === "TODAY") return "SNAPSHOT";
  if (tier === "PREVIOUS_SESSION") return "LAST_SESSION";
  return "HISTORICAL";
}

/**
 * Codex blocker repair (B2) - "is the exchange's regular session actually open right now," derived
 * ONLY from already-fetched, provider-verified `PositionReviewResult.evidence.session` values
 * (never a pure calendar/clock guess - the prior `isLikelyWithinRegularSession` approach this
 * replaced could not know about an NYSE early close, e.g. 1:00 PM ET on the day after
 * Thanksgiving, and would have kept claiming "Market open" until 4:00 PM regardless). Every row on
 * one page render shares the SAME session-evidence fetch (resolvePositionReviewsForUser calls
 * getEquityMarketSessionEvidenceForUser exactly once per call, not per campaign - see
 * position-review.ts), so results normally agree; this still defends against disagreement rather
 * than assuming it. Returns "UNKNOWN" (never a guessed OPEN/CLOSED) whenever session evidence
 * wasn't available at all, or disagrees - the freshness strip then shows neutral, non-committal
 * wording instead of a definitive market-state claim it can't actually back up. Zero new provider
 * calls - this reads evidence the page's own existing resolution already fetched for other
 * purposes.
 */
export type MarketSessionClaim = "OPEN" | "CLOSED" | "UNKNOWN";

export function deriveMarketSessionClaim(results: readonly Pick<PositionReviewResult, "evidence">[]): MarketSessionClaim {
  if (results.length === 0) {
    return "UNKNOWN";
  }
  const states = new Set(results.map((result) => result.evidence.session));
  if (states.size !== 1) {
    return "UNKNOWN";
  }
  const only = [...states][0];
  if (only === "OPEN") return "OPEN";
  if (only === "CLOSED") return "CLOSED";
  return "UNKNOWN";
}

/**
 * Pure, string-free aggregate state for a page-level freshness strip (Dashboard/Tracker) - "what
 * should the ONE top-of-page sentence communicate about ALL visible positions' freshness at once,"
 * so individual rows stop feeling like they each independently "timed out." Deliberately returns
 * structured data, never copy text - see freshness-strip.tsx for the actual wording (same split as
 * classifyLastValidTiming/lastValidTimingCopy elsewhere in this feature).
 *
 * MIXED_SNAPSHOTS/MIXED_CURRENT exist specifically so a caller never implies one universal
 * timestamp when the underlying rows don't actually share one - "latest available snapshots"
 * wording, never a single fabricated time, whenever evaluatedAt instants differ by more than this
 * module's own small tolerance window. UNIFORM_CURRENT carries its OWN uniform evaluatedAt (drawn
 * from the rows' real `explanation.evaluatedAt` values, never the page's render-time `now` - Codex
 * blocker repair (B4): page-render time must never be labeled as assessment time).
 */
export type FreshnessStripState =
  | { kind: "EMPTY" }
  | { kind: "UNIFORM_CURRENT"; evaluatedAt: Date }
  | { kind: "MIXED_CURRENT" }
  | { kind: "UNIFORM_SNAPSHOT"; tier: Exclude<PresentationFreshnessTier, "CURRENT" | "UNAVAILABLE">; evaluatedAt: Date }
  | { kind: "MIXED_SNAPSHOTS" }
  | { kind: "ALL_UNAVAILABLE" };

/** Two evaluatedAt instants within this window are treated as "materially the same" timestamp for
 * the strip's single-time wording - a real gap (a different campaign's stored row from minutes
 * apart) correctly falls through to the honest "latest available snapshots" wording instead. */
const UNIFORM_TIMESTAMP_TOLERANCE_MS = 2 * 60_000;

/**
 * Codex blocker repair (B4) - deterministic, ORDER-INVARIANT selection of the one representative
 * instant for a cluster of "materially the same" timestamps: always the mathematical minimum
 * (earliest), never "whichever happened to be first in the input array" (Codex reproduced the
 * prior bug: reversing row order changed the displayed time for an identical underlying data set).
 * The earliest-of-the-cluster choice is also the conservative direction - it can only understate
 * freshness relative to the true latest member, never overstate it.
 */
function uniformEvaluatedAt(evaluatedAts: readonly Date[]): Date | null {
  if (evaluatedAts.length === 0) {
    return null;
  }
  const times = evaluatedAts.map((date) => date.getTime());
  const minMs = Math.min(...times);
  const maxMs = Math.max(...times);
  if (maxMs - minMs > UNIFORM_TIMESTAMP_TOLERANCE_MS) {
    return null;
  }
  return new Date(minMs);
}

/** One row's tier + the real evaluatedAt instant it was actually observed at (null for UNAVAILABLE,
 * which has no observation instant at all) - the shared, string-free input both the server-resolved
 * path (classifyFreshnessStripState) and the client's per-row expiry-aware path (see
 * client-freshness.tsx) aggregate through, so the two can never disagree about how to combine rows. */
export type FreshnessObservation = { tier: PresentationFreshnessTier; evaluatedAt: Date | null };

export function classifyFreshnessStripStateFromObservations(observations: readonly FreshnessObservation[]): FreshnessStripState {
  if (observations.length === 0) {
    return { kind: "EMPTY" };
  }
  const currentObservations = observations.filter((observation) => observation.tier === "CURRENT");
  if (currentObservations.length === observations.length) {
    const evaluatedAt = uniformEvaluatedAt(currentObservations.flatMap((observation) => (observation.evaluatedAt ? [observation.evaluatedAt] : [])));
    return evaluatedAt ? { kind: "UNIFORM_CURRENT", evaluatedAt } : { kind: "MIXED_CURRENT" };
  }
  if (currentObservations.length > 0) {
    return { kind: "MIXED_CURRENT" };
  }

  const knownObservations = observations.filter((observation) => observation.tier !== "UNAVAILABLE");
  if (knownObservations.length === 0) {
    return { kind: "ALL_UNAVAILABLE" };
  }
  const uniformTier = knownObservations.every((observation) => observation.tier === knownObservations[0].tier);
  const evaluatedAt = uniformTier
    ? uniformEvaluatedAt(knownObservations.flatMap((observation) => (observation.evaluatedAt ? [observation.evaluatedAt] : [])))
    : null;
  if (uniformTier && evaluatedAt) {
    return { kind: "UNIFORM_SNAPSHOT", tier: knownObservations[0].tier as Exclude<PresentationFreshnessTier, "CURRENT" | "UNAVAILABLE">, evaluatedAt };
  }
  return { kind: "MIXED_SNAPSHOTS" };
}

function observationFor(display: PositionAssessmentDisplay, now: Date): FreshnessObservation {
  const tier = classifyPresentationFreshness(display, now);
  const evaluatedAt = display.state === "CURRENT" ? display.current.explanation.evaluatedAt : display.state === "LAST_VALID" ? display.lastValid.evaluatedAt : null;
  return { tier, evaluatedAt };
}

export function classifyFreshnessStripState(displays: readonly PositionAssessmentDisplay[], now: Date): FreshnessStripState {
  return classifyFreshnessStripStateFromObservations(displays.map((display) => observationFor(display, now)));
}

function tierForLastValid(evaluatedAt: Date, now: Date): Exclude<PresentationFreshnessTier, "CURRENT" | "UNAVAILABLE"> {
  const tier = classifyLastValidTiming(evaluatedAt, now);
  if (tier === "TODAY") return "SNAPSHOT";
  if (tier === "PREVIOUS_SESSION") return "LAST_SESSION";
  return "HISTORICAL";
}

/**
 * Codex blocker repair (B1) - the ONE PURE function (no hooks, no React, fully unit-testable) that
 * decides "what should this row's presentation actually be right now, on the client," reusing the
 * EXACT same trusted current-guidance deadline the per-row badges already use
 * (useActiveGuidanceExpired, src/components/use-active-guidance-expired.ts) - `currentExpired` is
 * that hook's own boolean output, passed in rather than re-derived, so this module never
 * independently re-implements (or drifts from) the calibrated-deadline trust model. The thin
 * "use client" hook that actually calls useActiveGuidanceExpired lives in
 * src/components/client-freshness.tsx and does nothing but call this function - all the real
 * branching logic lives here so it can be tested directly without a component-render harness
 * (this repo has none - see PROJECT_HANDOFF.md).
 *
 * `stillLiveCurrent` is what the Dashboard's "Attention Now" membership check reads: true only
 * while this is a genuinely current, not-yet-expired CURRENT result. Once useActiveGuidanceExpired
 * reports expired (regardless of whether a durable historical fallback exists), this row is no
 * longer live-actionable guidance and must be removed from Attention Now - a stored historical
 * Watch/Review action is useful CONTEXT, never a live attention item (same rule the server-side
 * `attentionNowRows` already enforces for a true LAST_VALID display from the start).
 */
export type EffectivePresentation = { tier: PresentationFreshnessTier; evaluatedAt: Date | null; stillLiveCurrent: boolean };

export function effectivePresentation(display: PositionAssessmentDisplay, currentExpired: boolean, now: Date): EffectivePresentation {
  if (display.state === "UNAVAILABLE") {
    return { tier: "UNAVAILABLE", evaluatedAt: null, stillLiveCurrent: false };
  }
  if (display.state === "LAST_VALID") {
    return { tier: tierForLastValid(display.lastValid.evaluatedAt, now), evaluatedAt: display.lastValid.evaluatedAt, stillLiveCurrent: false };
  }
  // CURRENT
  if (!currentExpired) {
    return { tier: "CURRENT", evaluatedAt: display.current.explanation.evaluatedAt, stillLiveCurrent: true };
  }
  if (display.lastValid) {
    return { tier: tierForLastValid(display.lastValid.evaluatedAt, now), evaluatedAt: display.lastValid.evaluatedAt, stillLiveCurrent: false };
  }
  return { tier: "UNAVAILABLE", evaluatedAt: null, stillLiveCurrent: false };
}
