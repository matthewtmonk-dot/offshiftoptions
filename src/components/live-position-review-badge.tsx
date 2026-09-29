"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui";
import type { PositionReviewResult } from "@/domain/finance/positionReview";
import { PositionReviewActionBadge } from "@/components/position-review-badge";

const QUOTE_FRESHNESS_WINDOW_MS = 120_000;

function isStillFresh(quoteTradeTime: Date | null): boolean {
  if (!quoteTradeTime) return false;
  return Date.now() - quoteTradeTime.getTime() <= QUOTE_FRESHNESS_WINDOW_MS;
}

/**
 * Dashboard V2 Phase 2 - client-side downgrade of an active colored advisory once its own
 * 120-second quote-freshness window elapses in the viewer's browser. The check is always
 * `Date.now() - quoteTradeTime` - the client's own clock is only ever used to measure elapsed
 * time against the provider's real trade timestamp, never substituted FOR that timestamp (the
 * exact rule quoteEvidence.ts's server-side eligibility check already applied to produce this
 * result). Never triggers a brokerage sync or a data refetch itself - only degrades the display;
 * refreshing prices/positions stays the user's own explicit Refresh action.
 */
export function LivePositionReviewBadge({ result }: { result: PositionReviewResult }) {
  const isLiveAdvisory = result.evidence.quote === "ELIGIBLE" && result.explanation.quoteTradeTime !== null;
  const quoteTradeTimeMs = result.explanation.quoteTradeTime?.getTime() ?? null;
  const [fresh, setFresh] = useState(() => (isLiveAdvisory ? isStillFresh(result.explanation.quoteTradeTime) : false));

  useEffect(() => {
    if (!isLiveAdvisory) return;
    const check = () => setFresh(isStillFresh(result.explanation.quoteTradeTime));
    check();
    const interval = setInterval(check, 5_000);
    // A hidden/backgrounded tab can suspend or throttle timers far longer than the 120s window -
    // re-check immediately on resume rather than trusting a stale interval tick (the ticket's own
    // "downgrade appropriately until refreshed" requirement).
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- quoteTradeTimeMs is the real dependency; the Date object's identity is not.
  }, [isLiveAdvisory, quoteTradeTimeMs]);

  if (!isLiveAdvisory || fresh) {
    return <PositionReviewActionBadge result={result} />;
  }

  return <Badge tone="neutral">Refresh to check current status</Badge>;
}
