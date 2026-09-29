"use client";

import { Badge } from "@/components/ui";
import type { PositionReviewResult } from "@/domain/finance/positionReview";
import { PositionReviewActionBadge, PositionReviewEvidenceLine } from "@/components/position-review-badge";
import { useActiveGuidanceExpired } from "@/components/use-active-guidance-expired";

/**
 * Dashboard V2 Phase 2 - Codex P1 (B3). Client-side downgrade of an active colored advisory once
 * its own server-computed activeGuidanceDeadline passes in the viewer's browser - the EARLIEST of
 * the quote's 120s freshness window, a Schwab-confirmed position's 5-minute read-receipt window,
 * and the validated regular session's own close instant (see
 * PositionReviewExplanation.activeGuidanceDeadline's own doc comment for the full contract).
 * Scheduled against that real deadline (useActiveGuidanceExpired), not a fixed poll interval, and
 * re-checked on tab-visibility resume. Never triggers a brokerage sync or a data refetch itself -
 * only degrades the display; refreshing prices/positions stays the user's own explicit action.
 */
export function LivePositionReviewBadge({ result }: { result: PositionReviewResult }) {
  const expired = useActiveGuidanceExpired(result.explanation.activeGuidanceDeadline);

  if (!expired) {
    return <PositionReviewActionBadge result={result} />;
  }

  return <Badge tone="neutral">Refresh to check current status</Badge>;
}

/**
 * The secondary evidence line's own expiry - uses the SAME deadline and the SAME hook as
 * LivePositionReviewBadge above (both derive `expired` from an identical pure comparison against
 * an identical deadline, so they always agree at any given instant even though they render in two
 * different places in the page) so the dominant badge and the supporting text never disagree about
 * whether the advisory is still current.
 */
export function LivePositionReviewEvidenceLine({ result }: { result: PositionReviewResult }) {
  const expired = useActiveGuidanceExpired(result.explanation.activeGuidanceDeadline);

  if (expired) {
    return <p className="text-xs text-zinc-500">Evidence expired - refresh to check current status.</p>;
  }

  return <PositionReviewEvidenceLine result={result} />;
}
