"use client";

import { Badge } from "@/components/ui";
import type { PositionAssessmentDisplay } from "@/domain/finance/positionReviewAssessment";
import { PositionReviewActionBadge, PositionReviewEvidenceLine } from "@/components/position-review-badge";
import { HistoricalAssessmentBadge, HistoricalAssessmentEvidenceLine } from "@/components/historical-assessment-badge";
import { useActiveGuidanceExpired } from "@/components/use-active-guidance-expired";

/**
 * Phase 2B (Last Valid Position Assessment) - renders the full CURRENT/LAST_VALID/UNAVAILABLE
 * display model, superseding the old `PositionReviewResult`-only LivePositionReviewBadge/
 * LivePositionReviewEvidenceLine (renamed - the prop contract changed fundamentally, and only
 * Dashboard/Tracker ever imported them).
 *
 * UNAVAILABLE and LAST_VALID render exactly what the server already decided - the same
 * Cannot-assess / historical presentation regardless of how the row got there. CURRENT keeps the
 * original Dashboard V2 Phase 2 client-side expiry behavior unchanged (same useActiveGuidanceExpired
 * hook, same trust-sensitive server-time-calibrated deadline, same "never extend via a manipulated
 * client clock" guarantee) - the only change is what happens AFTER it expires: previously always a
 * neutral "Refresh to check current status" badge, now a transition to the SAME historical
 * rendering `display.current.lastValid` provides (per Phase 2A's own contract, that payload is only
 * ever populated from an actually-verified durable row, never fabricated client-side), falling back
 * to the original neutral badge only when no verified fallback exists.
 *
 * `now` is always the page's own already-computed server render instant (Dashboard's `asOf`,
 * Tracker's `snapshotCheckedAt`) - never a fresh client-side `new Date()`. A client component
 * computing `new Date()` during render would differ between the server-render pass and the
 * client-hydration pass, which could flip a TODAY/PREVIOUS_SESSION timing-copy tier right at a
 * session boundary and produce a React hydration mismatch. The gap between evaluation and
 * guidance-deadline expiry is always seconds-to-minutes, so the original page-render `now` stays
 * accurate even for the CURRENT -> historical client transition.
 */
// `now` is required in both prop types below (callers always pass the page's own server render
// instant) but is only actually read by the EvidenceLine variant (HistoricalAssessmentBadge never
// renders timing copy) - kept in the Badge type purely for a matching, symmetric call-site API.
export function LivePositionAssessmentBadge({ display }: { display: PositionAssessmentDisplay; now: Date }) {
  // Called unconditionally, every render (React's rules of hooks) - null/null for a non-CURRENT
  // display, which useActiveGuidanceExpired already treats as "not expired" with no calibration.
  const expired = useActiveGuidanceExpired(
    display.state === "CURRENT" ? display.current.explanation.activeGuidanceDeadline : null,
    display.state === "CURRENT" ? display.current.explanation.evaluatedAt : null,
  );

  if (display.state === "UNAVAILABLE") {
    return <PositionReviewActionBadge result={display.currentUnavailable} />;
  }
  if (display.state === "LAST_VALID") {
    return <HistoricalAssessmentBadge lastValid={display.lastValid} />;
  }
  if (!expired) {
    return <PositionReviewActionBadge result={display.current} />;
  }
  if (display.lastValid) {
    return <HistoricalAssessmentBadge lastValid={display.lastValid} />;
  }
  return <Badge tone="neutral">Refresh to check current status</Badge>;
}

/** The secondary evidence line's own expiry - mirrors LivePositionAssessmentBadge exactly (same
 * display/now inputs, same branches) so the dominant badge and the supporting text never disagree
 * about whether the advisory is live, historical, or unavailable. */
export function LivePositionAssessmentEvidenceLine({ display, now }: { display: PositionAssessmentDisplay; now: Date }) {
  const expired = useActiveGuidanceExpired(
    display.state === "CURRENT" ? display.current.explanation.activeGuidanceDeadline : null,
    display.state === "CURRENT" ? display.current.explanation.evaluatedAt : null,
  );

  if (display.state === "UNAVAILABLE") {
    return <PositionReviewEvidenceLine result={display.currentUnavailable} />;
  }
  if (display.state === "LAST_VALID") {
    return <HistoricalAssessmentEvidenceLine lastValid={display.lastValid} now={now} />;
  }
  if (expired) {
    if (display.lastValid) {
      return <HistoricalAssessmentEvidenceLine lastValid={display.lastValid} now={now} />;
    }
    return <p className="mt-0.5 text-xs text-zinc-500">Evidence expired - refresh to check current status.</p>;
  }

  return <PositionReviewEvidenceLine result={display.current} />;
}
