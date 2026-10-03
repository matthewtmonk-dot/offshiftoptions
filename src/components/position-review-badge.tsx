import { CheckCircle2, CircleAlert, CircleHelp, XCircle } from "lucide-react";
import { Badge } from "@/components/ui";
import type { PositionReviewEvidence, PositionReviewResult } from "@/domain/finance/positionReview";
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
const TONE_BY_ACTION = {
  COMFORTABLE: "good",
  WATCH: "warn",
  REVIEW_ROLL: "warn",
  REVIEW_CALL: "warn",
  CANNOT_ASSESS: "neutral",
} as const;

const ICON_BY_ACTION = {
  COMFORTABLE: CheckCircle2,
  WATCH: CircleAlert,
  REVIEW_ROLL: XCircle,
  REVIEW_CALL: XCircle,
  CANNOT_ASSESS: CircleHelp,
} as const;

function actionLabel(result: PositionReviewResult): string {
  if (result.action === "COMFORTABLE") return "Comfortable";
  if (result.action === "REVIEW_ROLL") return "Review roll";
  if (result.action === "REVIEW_CALL") return "Review call";
  if (result.action === "WATCH") {
    return result.explanation.reasonCodes.includes("EXPIRES_TODAY") ? "Watch · expires today" : "Watch";
  }
  return "Cannot assess";
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
  } else if (explanation.moneyness && explanation.dollarDistance !== null && explanation.percentageDistance !== null) {
    const verb = explanation.moneyness === "ATM" ? "At strike" : `${explanation.moneyness} by`;
    parts.push(
      explanation.moneyness === "ATM"
        ? "At strike"
        : `${verb} $${explanation.dollarDistance.toFixed(2)} / ${explanation.percentageDistance.toFixed(1)}%`,
    );
  }

  parts.push(POSITION_EVIDENCE_LABELS[evidence.position]);

  return (
    <p className="mt-1 text-[13px] text-zinc-400">
      {parts.join(" · ")}
      {explanation.quoteTradeTime ? <span className="block text-xs text-zinc-500">Price as of {formatEtTime(explanation.quoteTradeTime)}</span> : null}
    </p>
  );
}
