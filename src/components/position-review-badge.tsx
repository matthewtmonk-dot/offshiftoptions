import { CheckCircle2, CircleAlert, CircleHelp, XCircle } from "lucide-react";
import { Badge } from "@/components/ui";
import type { PositionReviewAction, PositionReviewEvidence, PositionReviewResult } from "@/domain/finance/positionReview";
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
  PAST_EXPIRATION_UNRESOLVED: "Expiration pending",
  EXPIRATION_SESSION_ENDED: "Expiration session ended - awaiting confirmation",
  EXPIRATION_UNKNOWN: "Expiration unknown",
  INCOMPLETE_TERMS: "Incomplete position terms",
  MISSING_CONTRACTS: "Contract quantity missing",
  MARKET_CLOSED: "Market closed",
  QUOTE_UNAVAILABLE: "Quote unavailable",
  POSITION_INSUFFICIENT_SHARE_COVERAGE: "Insufficient share coverage for this call",
  POSITION_UNSUPPORTED_CONTRACT_DELIVERABLE: "Contract deliverable can't be verified",
};

/** Picks the single most relevant human-readable reason for a CANNOT_ASSESS row, in the same
 * priority order priorityGroupOf uses internally - never a raw reason CODE shown to the user. */
function cannotAssessReasonLabel(result: PositionReviewResult): string {
  const codes = result.explanation.reasonCodes;
  for (const code of codes) {
    if (CANNOT_ASSESS_REASON_LABELS[code]) return CANNOT_ASSESS_REASON_LABELS[code];
    if (code.startsWith("QUOTE_")) return "Quote unavailable";
    if (code.startsWith("POSITION_")) return "Position not confirmed";
  }
  return "Cannot assess";
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

/** The compact colored action badge alone - text + icon, color never the only signal. */
export function PositionReviewActionBadge({ result }: { result: PositionReviewResult }) {
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

  return (
    <p className="mt-1 text-[13px] text-zinc-400">
      {parts.join(" · ")}
      {explanation.quoteTradeTime ? <span className="block text-xs text-zinc-500">Price as of {formatEtTime(explanation.quoteTradeTime)}</span> : null}
    </p>
  );
}
