import { classifyLastValidTiming, type PositionAssessmentDisplay } from "./positionReviewAssessment";

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
 * Pure, string-free aggregate state for a page-level freshness strip (Dashboard/Tracker) - "what
 * should the ONE top-of-page sentence communicate about ALL visible positions' freshness at once,"
 * so individual rows stop feeling like they each independently "timed out." Deliberately returns
 * structured data, never copy text - see freshness-strip.tsx for the actual wording (same split as
 * classifyLastValidTiming/lastValidTimingCopy elsewhere in this feature).
 *
 * MIXED_SNAPSHOTS/MIXED_CURRENT exist specifically so a caller never implies one universal
 * timestamp when the underlying rows don't actually share one - "latest available snapshots"
 * wording, never a single fabricated time, whenever evaluatedAt instants differ by more than this
 * module's own small tolerance window.
 */
export type FreshnessStripState =
  | { kind: "EMPTY" }
  | { kind: "ALL_CURRENT" }
  | { kind: "MIXED_CURRENT" }
  | { kind: "UNIFORM_SNAPSHOT"; tier: Exclude<PresentationFreshnessTier, "CURRENT" | "UNAVAILABLE">; evaluatedAt: Date }
  | { kind: "MIXED_SNAPSHOTS" }
  | { kind: "ALL_UNAVAILABLE" };

/** Two evaluatedAt instants within this window are treated as "materially the same" timestamp for
 * the strip's single-time wording - a real gap (a different campaign's stored row from minutes
 * apart) correctly falls through to the honest "latest available snapshots" wording instead. */
const UNIFORM_TIMESTAMP_TOLERANCE_MS = 2 * 60_000;

export function classifyFreshnessStripState(displays: readonly PositionAssessmentDisplay[], now: Date): FreshnessStripState {
  if (displays.length === 0) {
    return { kind: "EMPTY" };
  }
  const tiers = displays.map((display) => classifyPresentationFreshness(display, now));
  const currentCount = tiers.filter((tier) => tier === "CURRENT").length;
  if (currentCount === displays.length) {
    return { kind: "ALL_CURRENT" };
  }
  if (currentCount > 0) {
    return { kind: "MIXED_CURRENT" };
  }

  const lastValidDisplays = displays.filter((display): display is Extract<PositionAssessmentDisplay, { state: "LAST_VALID" }> => display.state === "LAST_VALID");
  if (lastValidDisplays.length === 0) {
    return { kind: "ALL_UNAVAILABLE" };
  }

  const lastValidTiers = lastValidDisplays.map((display) => classifyPresentationFreshness(display, now)) as Exclude<PresentationFreshnessTier, "CURRENT" | "UNAVAILABLE">[];
  const uniformTier = lastValidTiers.every((tier) => tier === lastValidTiers[0]);
  const times = lastValidDisplays.map((display) => display.lastValid.evaluatedAt.getTime());
  const uniformTimestamp = Math.max(...times) - Math.min(...times) <= UNIFORM_TIMESTAMP_TOLERANCE_MS;

  if (uniformTier && uniformTimestamp) {
    return { kind: "UNIFORM_SNAPSHOT", tier: lastValidTiers[0], evaluatedAt: lastValidDisplays[0].lastValid.evaluatedAt };
  }
  return { kind: "MIXED_SNAPSHOTS" };
}
