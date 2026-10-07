import { Info } from "lucide-react";
import { classifyFreshnessStripState, type FreshnessStripState } from "@/domain/finance/presentationFreshness";
import { isLikelyWithinRegularSession } from "@/domain/finance/marketCalendar";
import type { PositionAssessmentDisplay } from "@/domain/finance/positionReviewAssessment";
import { formatEtCompactDateTime, formatEtTime } from "@/lib/format";

/**
 * LST "Attention-First Freshness" Phase 1 - the compact, top-of-page freshness strip for
 * Dashboard/Tracker. The ticket's own goal: the whole page communicates age ONCE, rather than
 * every row independently feeling like it "timed out." Pure presentation over an ALREADY-RESOLVED
 * set of displays (Dashboard/Tracker already compute these via resolvePositionAssessmentDisplaysForUser
 * for their own purposes) - this component triggers zero additional provider calls of its own, and
 * `isLikelyWithinRegularSession` is a pure calendar/clock estimate (see its own doc comment), never
 * a live session-evidence fetch.
 *
 * Deliberately restrained: one blue/neutral informational line, never red/scary merely because the
 * market is closed - closed-market framing is a normal, expected state for this app, not a
 * problem. Never implies a single universal timestamp when the underlying rows don't actually
 * share one (see classifyFreshnessStripState's own MIXED_SNAPSHOTS/MIXED_CURRENT states).
 */
export function FreshnessStrip({ displays, now }: { displays: readonly PositionAssessmentDisplay[]; now: Date }) {
  const marketOpen = isLikelyWithinRegularSession(now);
  const state = classifyFreshnessStripState(displays, now);
  const headline = freshnessStripHeadline(state, marketOpen, now);

  return (
    <div className="flex items-start gap-2 rounded-md border border-sky-400/30 bg-sky-400/5 px-3 py-1.5 text-xs text-sky-200">
      <Info aria-hidden size={13} className="mt-0.5 shrink-0" />
      <span>{headline}</span>
    </div>
  );
}

function freshnessStripHeadline(state: FreshnessStripState, marketOpen: boolean, now: Date): string {
  const marketLabel = marketOpen ? "Market open" : "Market closed";

  if (state.kind === "EMPTY") {
    return marketLabel;
  }
  if (state.kind === "ALL_CURRENT") {
    return `${marketLabel} · Current position assessment ${formatEtTime(now)}`;
  }
  if (state.kind === "MIXED_CURRENT") {
    return `${marketLabel} · Showing latest available snapshots`;
  }
  if (state.kind === "ALL_UNAVAILABLE") {
    return `${marketLabel} · No position assessments available`;
  }
  if (state.kind === "MIXED_SNAPSHOTS") {
    return `${marketLabel} · Showing latest available snapshots`;
  }
  // UNIFORM_SNAPSHOT
  const time = state.tier === "SNAPSHOT" ? formatEtTime(state.evaluatedAt) : formatEtCompactDateTime(state.evaluatedAt, now);
  if (marketOpen) {
    return `${marketLabel} · Latest snapshot ${time}`;
  }
  return `${marketLabel} · Showing last observed market snapshots from ${time}`;
}
