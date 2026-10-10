import type { CampaignCurrentStage } from "./campaigns";
import { comparePositionReviewPriority } from "./positionReview";
import { isKnownTransientFallbackReason, underlyingPositionReviewResult, type PositionAssessmentDisplay } from "./positionReviewAssessment";
import { resolveEffectivePresentation, type EffectivePresentation } from "./presentationFreshness";

/**
 * Dashboard V2 Phase 1 - deliberately excludes any money field: the architecture review found the
 * prior dashboard's open-row figure unsafe (`realizedPL ?? 0`, fabricating a confirmed-looking $0
 * for an OPEN campaign that has no realized result at all). Only already-certain lifecycle facts
 * are shown here.
 *
 * Compact position UX, final blocker repair - this type (and everything below) moved out of
 * src/lib/dashboard-view.ts (which is "server-only"-tagged) into this plain domain module
 * specifically so it can be imported by a CLIENT component (client-freshness.tsx) as well as the
 * server-rendered Dashboard page - see partitionPositionReviewRows's own doc comment for why that
 * client-side use is now required.
 */
export type PositionToReviewRow = {
  campaignId: string;
  ownerId: string;
  accountId: string;
  ticker: string;
  status: "OPEN" | "ASSIGNED";
  stage: CampaignCurrentStage;
  legType: "PUT" | "CALL" | null;
  strike: number | null;
  expiration: Date | null;
  /** Contracts for an option leg, shares held for an assigned-with-no-call row. */
  quantity: number | null;
  quantityUnit: "contracts" | "shares" | null;
};

/**
 * Phase 2B - merges each factual row with its shared orchestration display (CURRENT/LAST_VALID/
 * UNAVAILABLE), by campaign id. A row absent from `displaysByCampaignId` (no leg the shared
 * evaluator could resolve at all, e.g. a "Review needed" legacy row) gets `display: null` -
 * rendered distinctly, never defaulted to a guessed status.
 */
export type PositionToReviewDisplayRow = PositionToReviewRow & { display: PositionAssessmentDisplay | null };

export function attachPositionAssessmentDisplays(
  rows: PositionToReviewRow[],
  displaysByCampaignId: ReadonlyMap<string, PositionAssessmentDisplay>,
): PositionToReviewDisplayRow[] {
  return rows.map((row) => ({ ...row, display: displaysByCampaignId.get(row.campaignId) ?? null }));
}

/**
 * The ticket's own deterministic priority ordering, applied to full display rows rather than bare
 * PositionReviewResults - callers MUST sort the complete owner-scoped set before truncating for
 * display (never sort an already-truncated slice). A row with no display (no leg the shared
 * evaluator could resolve) sorts after every row that does have one - there is nothing to
 * prioritize it against, so it is treated as the least actionable case rather than guessed into a
 * priority group. Sorts on the underlying live PositionReviewResult regardless of CURRENT/
 * LAST_VALID/UNAVAILABLE state (underlyingPositionReviewResult) - this is a type-shape change
 * only, not a new sort policy: a LAST_VALID/UNAVAILABLE row's `currentUnavailable` already carries
 * the exact same priority/lifecycle fields a CANNOT_ASSESS row always had, pre-Phase-2B.
 */
export function sortPositionToReviewDisplayRows<T extends { display: PositionAssessmentDisplay | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.display && b.display) return comparePositionReviewPriority(underlyingPositionReviewResult(a.display), underlyingPositionReviewResult(b.display));
    if (a.display && !b.display) return -1;
    if (!a.display && b.display) return 1;
    return 0;
  });
}

/**
 * LST "Attention-First Freshness" Phase 1 - the single eligibility rule for "Attention Now": only
 * rows genuinely needing review/action, never a historical (LAST_VALID) Watch/Review carried over
 * from a stale evaluation. Two cases qualify:
 *   1. A CURRENT result whose action is WATCH/REVIEW_ROLL/REVIEW_CALL (COMFORTABLE and
 *      CANNOT_ASSESS are excluded - "current, no action needed" and "nothing to report" are not
 *      attention items) - AND `currentStillLive`, the caller's own answer to "has this specific
 *      CURRENT result's own trusted guidance deadline already passed." The server's own render-time
 *      call (attentionNowRows below) always passes `true` here (a row the server just evaluated as
 *      CURRENT is, by definition, within its budget at that instant); the CLIENT's live partition
 *      (partitionPositionReviewRows) passes the SAME stillLiveCurrent flag
 *      ClientPresentationProvider's own per-row observers already track, so this one rule governs
 *      both the initial server render and every live client re-partition - never two independently
 *      drifting notions of "is this current and actionable."
 *   2. A live UNAVAILABLE result carrying a genuine CONTRADICTION reason - any reasonCode outside
 *      isKnownTransientFallbackReason's existing allowlist (reused verbatim from the approved
 *      historical-fallback eligibility rule). An ordinary transient gap (market closed, quote
 *      momentarily unavailable) never appears here even when no historical fallback exists for it.
 *      This case has no deadline of its own, so `currentStillLive` is irrelevant to it.
 */
export function isAttentionRow(display: PositionAssessmentDisplay | null, currentStillLive: boolean): boolean {
  if (!display) return false;
  if (display.state === "CURRENT") {
    if (!currentStillLive) return false;
    return display.current.action === "WATCH" || display.current.action === "REVIEW_ROLL" || display.current.action === "REVIEW_CALL";
  }
  if (display.state === "UNAVAILABLE") {
    return display.currentUnavailable.explanation.reasonCodes.some((code) => !isKnownTransientFallbackReason(code));
  }
  // LAST_VALID - a historical action is context, never an attention-demanding item.
  return false;
}

/**
 * The SERVER-SIDE candidate list only, computed once at page render against `now` - a row this
 * identifies is, by construction, within its live guidance budget at that exact instant
 * (`currentStillLive: true`). Used for the Dashboard's initial render and wherever a plain,
 * render-time-only attention list is sufficient (never reorders - input rows are assumed already
 * sorted via sortPositionToReviewDisplayRows).
 */
export function attentionNowRows<T extends { display: PositionAssessmentDisplay | null }>(rows: readonly T[]): T[] {
  return rows.filter((row) => isAttentionRow(row.display, true));
}

/**
 * Compact position UX, final blocker repair - the ONE live-membership split both Dashboard
 * sections (Attention Now / Open Positions) render from. Every row in `rows` ends up in EXACTLY
 * one of the two returned buckets, by construction (a single pass, mutually exclusive by
 * if/else) - so the two sections can never disagree about a row (never both, never neither) the
 * way two independently server/client-filtered lists could. This is the actual fix for the Codex
 * blocker: previously, Attention Now (client-side, deadline-aware) and Open Positions
 * (server-computed once, deadline-oblivious) were two separate derivations that could drift apart
 * the instant a row's guidance deadline passed in the browser.
 *
 * `rows` must already be priority-sorted (sortPositionToReviewDisplayRows) - a single pass over
 * that order preserves it in both output buckets without ever needing to re-sort after a row
 * changes buckets.
 *
 * `liveByRevision`/`now` are the SAME live client state ClientPresentationProvider already
 * maintains (see client-freshness.tsx) - this reuses resolveEffectivePresentation's own
 * revision-safe lookup rule (presentationFreshness.ts) rather than re-deriving expiry, so this can
 * never drift from what each row's own badge is independently showing. For a row with no matching
 * live report yet (e.g. the very first render, before any observer has reported in), this falls
 * back to the same conservative "pending" default resolveEffectivePresentation already applies
 * everywhere else - a genuinely-live row may briefly start in Open Positions and then move up into
 * Attention Now moments later, never the reverse, and never invisible in both at once.
 */
export function partitionPositionReviewRows<T extends { campaignId: string; display: PositionAssessmentDisplay | null }>(
  rows: readonly T[],
  liveByRevision: ReadonlyMap<string, EffectivePresentation>,
  now: Date,
): { attention: T[]; open: T[] } {
  const attention: T[] = [];
  const open: T[] = [];
  for (const row of rows) {
    const display = row.display;
    const stillLive = display ? resolveEffectivePresentation(liveByRevision, row.campaignId, display, now).stillLiveCurrent : false;
    (isAttentionRow(display, stillLive) ? attention : open).push(row);
  }
  return { attention, open };
}
