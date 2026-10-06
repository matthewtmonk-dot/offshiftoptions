import { Clock } from "lucide-react";
import { Badge } from "@/components/ui";
import { classifyLastValidTiming, type StoredLastValidAssessment } from "@/domain/finance/positionReviewAssessment";
import { formatEtCompactDateTime, formatEtTime, money } from "@/lib/format";
import { actionLabelFor, ICON_BY_ACTION, moneynessDistanceLabel, TONE_BY_ACTION } from "@/components/position-review-badge";

/**
 * Phase 2B (Last Valid Position Assessment) - the one place that renders a `StoredLastValidAssessment`
 * as HISTORICAL display fallback. Used for a true LAST_VALID display AND for the client-side
 * CURRENT -> LAST_VALID expiry transition (see live-position-assessment-badge.tsx) - both render
 * through these same two components so a historical row can never look different depending on how
 * it got here. Never claims "current"/"live"/"fresh", never says "closing price"/"close"/"market
 * close value" - the stored evaluatedAt is the last-valid-OBSERVED-assessment instant, not
 * necessarily the official market close.
 */

/**
 * Pure presentation copy for a stored assessment's own evaluatedAt, given the caller's `now`
 * (always the page's own already-computed server instant - see live-position-assessment-badge.tsx
 * for why this is never a fresh client-side `new Date()`). Never uses relative wording that could
 * mislead across a weekend/holiday - classifyLastValidTiming already resolves that.
 */
export function lastValidTimingCopy(evaluatedAt: Date, now: Date): string {
  const tier = classifyLastValidTiming(evaluatedAt, now);
  if (tier === "TODAY") {
    return `Last valid today · ${formatEtTime(evaluatedAt)}`;
  }
  if (tier === "PREVIOUS_SESSION") {
    return `Previous session · Last valid ${formatEtCompactDateTime(evaluatedAt, now)}`;
  }
  return `Last valid ${formatEtCompactDateTime(evaluatedAt, now)}`;
}

/**
 * Same semantic action color/icon as the live badge, in a visibly muted container plus a small
 * clock indicator - "muted, not hidden": the action itself (Comfortable/Watch/Review roll/Review
 * call) is still immediately recognizable, just clearly marked as historical. Deliberately calls
 * actionLabelFor with an EMPTY reasonCodes array, never `lastValid.reasonCodes` - EXPIRES_TODAY was
 * only ever true at the moment of the original live evaluation and would otherwise render a stale
 * "expires today" qualifier on a day-old (or older) row.
 */
export function HistoricalAssessmentBadge({ lastValid }: { lastValid: StoredLastValidAssessment }) {
  const Icon = ICON_BY_ACTION[lastValid.action];
  return (
    <span className="inline-flex items-center gap-1.5 opacity-80">
      <Badge tone={TONE_BY_ACTION[lastValid.action]}>
        <Icon aria-hidden size={15} />
        <span className="ml-1">{actionLabelFor(lastValid.action, [])}</span>
      </Badge>
      <Clock aria-hidden size={13} className="text-zinc-500" />
    </span>
  );
}

/**
 * The historical counterpart to PositionReviewEvidenceLine: the stored underlying price (labeled
 * "at last valid check", never "closing price"), its moneyness distance, and the timing-tier copy
 * on its own sub-line - matches the ticket's explicit "underlying price used, moneyness, dollar/
 * percentage distance, evaluated timestamp" list.
 */
export function HistoricalAssessmentEvidenceLine({ lastValid, now }: { lastValid: StoredLastValidAssessment; now: Date }) {
  const distanceLabel = moneynessDistanceLabel(lastValid);
  const priceLabel = `${money(lastValid.underlyingPrice)} at last valid check`;

  return (
    <p className="mt-1 text-[13px] text-zinc-400">
      {distanceLabel ? `${priceLabel} · ${distanceLabel}` : priceLabel}
      <span className="block text-xs text-zinc-500">{lastValidTimingCopy(lastValid.evaluatedAt, now)}</span>
    </p>
  );
}
