import { CheckCircle2, CircleAlert, CircleHelp, XCircle } from "lucide-react";
import { Badge } from "@/components/ui";
import type { PositionReviewAction, PositionReviewEvidence, PositionReviewResult } from "@/domain/finance/positionReview";
import { isRoutineCannotAssessReason } from "@/domain/finance/positionReviewAssessment";
import { formatEtTime } from "@/lib/format";

/**
 * Dashboard V2 Phase 2 - shared presentation for a PositionReviewResult, used identically by the
 * Dashboard's "Positions to Review" table and the Tracker's campaign cards so the two pages can
 * never render conflicting colors/labels for the same evaluation. Every color also carries a text
 * label and an accessible icon (never color alone) - see the ticket's own "avoid excessive color,
 * one dominant status accent per row" instruction.
 */

// visual-tradingview-refresh: REVIEW_ROLL/REVIEW_CALL now render AMBER (warn), not RED (bad) -
// per the ticket's own explicit semantic-color rule ("AMBER: Watch / Review / warning states"),
// reserving RED strictly for an already-negative financial VALUE (e.g. a realized loss), never
// for "this still-open position now needs a decision." No change to action/evidence logic.
// Phase 2B - exported so the historical (LAST_VALID) presentation adapter
// (historical-assessment-badge.tsx) can reuse the identical tone/icon mapping rather than
// duplicating it, keeping live and historical badges visually in sync by construction.
export const TONE_BY_ACTION = {
  COMFORTABLE: "good",
  WATCH: "warn",
  REVIEW_ROLL: "warn",
  REVIEW_CALL: "warn",
  CANNOT_ASSESS: "neutral",
} as const;

export const ICON_BY_ACTION = {
  COMFORTABLE: CheckCircle2,
  WATCH: CircleAlert,
  REVIEW_ROLL: XCircle,
  REVIEW_CALL: XCircle,
  CANNOT_ASSESS: CircleHelp,
} as const;

/**
 * Phase 2B - decoupled from needing a full PositionReviewResult so the historical presentation
 * adapter can reuse it for a StoredLastValidAssessment's action too. Callers showing a HISTORICAL
 * action must pass `[]` for `reasonCodes`, never a stored row's frozen reasonCodes - EXPIRES_TODAY
 * was true only at the moment of the original live evaluation and would render a stale "expires
 * today" qualifier on a day-old (or older) historical row otherwise.
 */
export function actionLabelFor(action: PositionReviewAction, reasonCodes: readonly string[]): string {
  if (action === "COMFORTABLE") return "Comfortable";
  if (action === "REVIEW_ROLL") return "Review roll";
  if (action === "REVIEW_CALL") return "Review call";
  if (action === "WATCH") {
    return reasonCodes.includes("EXPIRES_TODAY") ? "Watch · expires today" : "Watch";
  }
  return "Cannot assess";
}

function actionLabel(result: PositionReviewResult): string {
  return actionLabelFor(result.action, result.explanation.reasonCodes);
}

const CANNOT_ASSESS_REASON_LABELS: Record<string, string> = {
  ASSIGNED_SHARES_NO_CALL: "Assigned shares - review next step",
  EXPIRATION_UNKNOWN: "Expiration unknown",
  INCOMPLETE_TERMS: "Incomplete position terms",
  MISSING_CONTRACTS: "Contract quantity missing",
  MARKET_CLOSED: "Market closed",
  QUOTE_UNAVAILABLE: "Quote unavailable",
  POSITION_INSUFFICIENT_SHARE_COVERAGE: "Insufficient share coverage for this call",
  POSITION_UNSUPPORTED_CONTRACT_DELIVERABLE: "Contract deliverable can't be verified",
};

/**
 * Weekend / Settlement Clarity - PAST_EXPIRATION_UNRESOLVED/EXPIRATION_SESSION_ENDED get
 * option-type-aware wording instead of the flat map above: "expiration pending" reads naturally
 * for an expired put, but an expired COVERED CALL leaves assigned shares in play too, so its wait
 * is for the call/share settlement together, not just "expiration." Never claims an outcome
 * (called away, shares retained, expired worthless) - only that confirmation is still pending.
 */
export function expirationWaitLabel(code: "PAST_EXPIRATION_UNRESOLVED" | "EXPIRATION_SESSION_ENDED", optionType: "PUT" | "CALL" | null): string {
  const prefix = code === "EXPIRATION_SESSION_ENDED" ? "Expiration session ended - awaiting " : "Awaiting ";
  return prefix + (optionType === "CALL" ? "covered-call/share settlement confirmation" : "Schwab expiration confirmation");
}

/** Picks the single most relevant human-readable reason for a CANNOT_ASSESS row, in the same
 * priority order priorityGroupOf uses internally - never a raw reason CODE shown to the user. */
function cannotAssessReasonLabel(result: PositionReviewResult): string {
  const codes = result.explanation.reasonCodes;
  for (const code of codes) {
    if (code === "PAST_EXPIRATION_UNRESOLVED" || code === "EXPIRATION_SESSION_ENDED") return expirationWaitLabel(code, result.explanation.optionType);
    if (CANNOT_ASSESS_REASON_LABELS[code]) return CANNOT_ASSESS_REASON_LABELS[code];
    if (code.startsWith("QUOTE_")) return "Quote unavailable";
    if (code.startsWith("POSITION_")) return "Position not confirmed";
  }
  return "Cannot assess";
}

/**
 * Compact position UX - a PRESENTATION-ONLY tier deciding how loudly a CANNOT_ASSESS row should
 * compete for attention, deliberately separate from the trust-sensitive `isKnownTransientFallbackReason`
 * allowlist (scheduled-capture.ts/positionReviewAssessment.ts) - that allowlist answers "is it safe
 * to show a historical fallback for this reason," a data-integrity question; this answers "should
 * a human's eye be drawn here," a UX question, and the two deliberately disagree in places (e.g.
 * EXPIRATION_SESSION_ENDED is routine/calm here - it is simply the ordinary end-of-day wait for
 * Schwab's own settlement confirmation - but is NOT allowlisted for historical fallback, since
 * showing stale pre-expiration guidance for an already-expired contract would be misleading).
 * CALM reasons are routine, expected, and resolve on their own (market hours, a quote hiccup, the
 * normal post-expiration settlement wait) - these never need a colored badge competing with the
 * lifecycle/activity badge that already explains the situation. Everything else (a genuine broker-
 * evidenced mismatch, incomplete/missing terms, an unrecognized reason) gets ATTENTION tier -
 * still never alarming RED (nothing here is a financial loss), but AMBER, worth a glance.
 *
 * Weekend / Settlement Clarity - the CALM allowlist itself now lives in `isRoutineCannotAssessReason`
 * (positionReviewAssessment.ts), shared verbatim with Dashboard's Attention Now list membership
 * (`isAttentionRow`, positionReviewRows.ts) - a row that shows no badge here can no longer still
 * occupy an Attention Now slot, which is exactly the inconsistency that let routine settlement-
 * wait rows (expired puts/calls awaiting Schwab confirmation) appear in Attention Now despite
 * rendering calmly everywhere else.
 */
export type CannotAssessPresentationTier = "calm" | "attention";

export function cannotAssessPresentationTier(reasonCodes: readonly string[]): CannotAssessPresentationTier {
  if (reasonCodes.length === 0) return "attention";
  return reasonCodes.every((code) => isRoutineCannotAssessReason(code)) ? "calm" : "attention";
}

const POSITION_EVIDENCE_LABELS: Record<PositionReviewEvidence["position"], string> = {
  SCHWAB_CONFIRMED: "Schwab confirmed",
  AWAITING_CONFIRMATION: "Awaiting confirmation",
  NOT_ASSESSED: "Not assessed",
  BROKER_UNAVAILABLE: "Broker unavailable",
  POSITION_MISMATCH_AMBIGUOUS: "Position mismatch",
  MANUAL_POSITION: "Manual position",
  INSUFFICIENT_SHARE_COVERAGE: "Insufficient share coverage",
  UNSUPPORTED_CONTRACT_DELIVERABLE: "Contract deliverable unverified",
};

/**
 * The compact colored action badge alone - text + icon, color never the only signal.
 *
 * Compact position UX - CANNOT_ASSESS no longer renders as a large neutral badge competing with
 * the lifecycle/activity badge that already explains the situation (e.g. "SETTLEMENT PENDING").
 * A CALM-tier reason (routine, expected, resolves on its own) renders NOTHING here at all - the
 * evidence line below already carries the one-sentence reason in small, de-emphasized text, which
 * is enough. An ATTENTION-tier reason (a genuine broker-evidenced mismatch, incomplete terms, or
 * anything this app doesn't specifically recognize as routine) still gets a small amber chip, so a
 * real, non-routine uncertainty doesn't visually disappear next to the calm cases - never RED
 * (nothing here is a realized loss), and never the loud original wording.
 */
export function PositionReviewActionBadge({ result }: { result: PositionReviewResult }) {
  if (result.action === "CANNOT_ASSESS") {
    if (cannotAssessPresentationTier(result.explanation.reasonCodes) === "calm") {
      return null;
    }
    return (
      <Badge tone="warn">
        <CircleHelp aria-hidden size={13} />
        <span className="ml-1">Needs confirmation</span>
      </Badge>
    );
  }
  const Icon = ICON_BY_ACTION[result.action];
  return (
    <Badge tone={TONE_BY_ACTION[result.action]}>
      <Icon aria-hidden size={15} />
      <span className="ml-1">{actionLabel(result)}</span>
    </Badge>
  );
}

/**
 * Phase 2B - extracted so the historical presentation adapter can render the identical
 * moneyness-distance phrasing from a StoredLastValidAssessment's own (always non-null) moneyness/
 * distance fields, without duplicating the string-building logic.
 */
export function moneynessDistanceLabel(args: { moneyness: "ITM" | "ATM" | "OTM" | null; dollarDistance: number | null; percentageDistance: number | null }): string | null {
  const { moneyness, dollarDistance, percentageDistance } = args;
  if (!moneyness || dollarDistance === null || percentageDistance === null) {
    return null;
  }
  if (moneyness === "ATM") {
    return "At strike";
  }
  return `${moneyness} by $${dollarDistance.toFixed(2)} / ${percentageDistance.toFixed(1)}%`;
}

/**
 * The secondary, visually de-emphasized detail line: moneyness distance (when available), the
 * lifecycle-appropriate reason for a CANNOT_ASSESS row, position/quote evidence labels, and the
 * quote's own trade time - never the render/retrieval time. Evidence labels stay secondary to the
 * one dominant action badge above, per the ticket's own presentation rule.
 */
export function PositionReviewEvidenceLine({ result }: { result: PositionReviewResult }) {
  const { explanation, evidence } = result;
  const parts: string[] = [];

  if (result.action === "CANNOT_ASSESS") {
    parts.push(cannotAssessReasonLabel(result));
  } else {
    const distanceLabel = moneynessDistanceLabel(explanation);
    if (distanceLabel) {
      parts.push(distanceLabel);
    }
  }

  parts.push(POSITION_EVIDENCE_LABELS[evidence.position]);

  // Attention-First Freshness Phase 1 - a persistable (live) action gets the same "<tier> ·
  // <time>" sub-line shape the historical presentation uses (see lastValidTimingCopy), so the
  // freshness label is always visible in the same place regardless of CURRENT/SNAPSHOT/
  // LAST_SESSION/HISTORICAL state. A CANNOT_ASSESS row keeps the plain "Price as of" phrasing -
  // it never claims "Current" guidance exists.
  const freshnessLine = explanation.quoteTradeTime
    ? result.action === "CANNOT_ASSESS"
      ? `Price as of ${formatEtTime(explanation.quoteTradeTime)}`
      : `Current · ${formatEtTime(explanation.quoteTradeTime)}`
    : null;

  return (
    <p className="mt-1 text-[13px] text-zinc-400">
      {parts.join(" · ")}
      {freshnessLine ? <span className="block text-xs text-zinc-500">{freshnessLine}</span> : null}
    </p>
  );
}
