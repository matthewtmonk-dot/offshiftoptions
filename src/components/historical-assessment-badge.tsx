import { Clock } from "lucide-react";
import { Badge } from "@/components/ui";
import { classifyLastValidTiming, type StoredLastValidAssessment } from "@/domain/finance/positionReviewAssessment";
import { formatEtCompactDateTime, formatEtTime, money } from "@/lib/format";
import { actionLabelFor, ICON_BY_ACTION, moneynessDistanceLabel, TONE_BY_ACTION } from "@/components/position-review-badge";
import { useLiveReferenceTime } from "@/components/use-live-reference-time";

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
 *
 * Attention-First Freshness Phase 1 - wording updated to the ticket's own SNAPSHOT/LAST_SESSION/
 * HISTORICAL vocabulary (see presentationFreshness.ts, which classifies the SAME three
 * classifyLastValidTiming tiers this function has always used - this is a copy-only change, no
 * new tiering/eligibility logic). "Snapshot" (same-session, not yet the last completed session),
 * "Last session" (the most recently completed NYSE session), "Historical" (anything older - the
 * conservative fallback label whenever session provenance can't justify a stronger claim).
 */
export function lastValidTimingCopy(evaluatedAt: Date, now: Date): string {
  const tier = classifyLastValidTiming(evaluatedAt, now);
  if (tier === "TODAY") {
    return `Snapshot · ${formatEtTime(evaluatedAt)}`;
  }
  if (tier === "PREVIOUS_SESSION") {
    return `Last session · ${formatEtCompactDateTime(evaluatedAt, now)}`;
  }
  return `Historical · ${formatEtCompactDateTime(evaluatedAt, now)}`;
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
 * "at observed snapshot"/"at last observed snapshot", never "closing price"), its moneyness
 * distance, and the timing-tier copy on its own sub-line - matches the ticket's explicit
 * "underlying price used, moneyness, dollar/percentage distance, evaluated timestamp" list.
 *
 * Attention-First Freshness Phase 1 - the price-line qualifier is tier-aware (matching the
 * ticket's own SNAPSHOT/LAST_SESSION/HISTORICAL wording examples): "at observed snapshot" for a
 * same-session SNAPSHOT row (not yet the LAST one from that session), "at last observed snapshot"
 * for LAST_SESSION/HISTORICAL. Still never "closing price"/"official close"/"live" - this app has
 * no verified official-close evidence for any provider it uses.
 *
 * Codex blocker repair (B) - `now` is only the SEED for useLiveReferenceTime, not the value
 * actually used to classify the timing tier: a page left open across a session boundary with no
 * new server render must not freeze on a stale tier forever. See use-live-reference-time.ts's own
 * doc comment for why the ordinary client clock is an acceptable source here (cosmetic tier
 * selection only, never a trust-sensitive decision).
 */
export function HistoricalAssessmentEvidenceLine({ lastValid, now }: { lastValid: StoredLastValidAssessment; now: Date }) {
  const liveNow = useLiveReferenceTime(now);
  const distanceLabel = moneynessDistanceLabel(lastValid);
  const tier = classifyLastValidTiming(lastValid.evaluatedAt, liveNow);
  const priceLabel = `${money(lastValid.underlyingPrice)} at ${tier === "TODAY" ? "observed snapshot" : "last observed snapshot"}`;

  return (
    <p className="mt-1 text-[13px] text-zinc-400">
      {distanceLabel ? `${priceLabel} · ${distanceLabel}` : priceLabel}
      <span className="block text-xs text-zinc-500">{lastValidTimingCopy(lastValid.evaluatedAt, liveNow)}</span>
    </p>
  );
}
