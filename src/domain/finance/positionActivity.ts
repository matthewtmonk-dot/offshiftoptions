import { isPastExpiration, type CampaignCurrentStage, type CampaignEventInput, type CampaignStatusInput } from "./campaigns";
import type { PositionAssessmentDisplay } from "./positionReviewAssessment";

/**
 * LST "Attention-First Freshness" Phase 1 - current-activity presentation labels. Deliberately a
 * thin relabeling of the campaign reducer's own already-authoritative `currentStage`
 * (campaigns.ts's `currentStage()`, exposed via `summarizeCampaign(...).currentStage`) - never a
 * second, competing interpretation of campaign lifecycle. The ticket's complaint is purely about
 * PRESENTATION ("Assigned" alone hides that a covered call is open) - `currentStage` already knows
 * "Covered call" vs "Assigned shares" distinctly; this module only picks a louder, activity-first
 * label for each existing stage.
 */
export type CurrentActivityLabel = "SHORT PUT OPEN" | "SHARES HELD" | "COVERED CALL OPEN" | "SETTLEMENT PENDING" | "CLOSED" | "REVIEW NEEDED";

/**
 * Weekend / Settlement Clarity, blocker repair (B1) - a pure calendar check (`isPastExpiration`)
 * only flips the DAY AFTER expiration; it cannot know whether TODAY's own expiration session has
 * already ended, since that requires real session evidence (regular-session close instant), not
 * just a calendar date. `positionReview.ts`'s live evaluator already has that evidence and already
 * flags a same-day, session-ended leg as `lifecycle: "EXPIRATION_SESSION_ENDED"` the INSTANT the
 * session closes (see its own `sessionEndedToday` check) - `EXPIRATION_PENDING` similarly covers
 * the day-after case the calendar check also catches. This reuses that ALREADY-COMPUTED,
 * authoritative evidence (never a new hard-coded clock test, never a second session-close
 * computation) whenever a live `display` is available for the row; `display.state` can only be
 * "UNAVAILABLE" with one of these two lifecycles when the leg has genuinely reached expiration
 * primacy - a "CURRENT" display's action is always one of the persistable
 * COMFORTABLE/WATCH/REVIEW_ROLL/REVIEW_CALL actions, which the evaluator can only reach when NEITHER
 * condition is true, and a "LAST_VALID" display can never represent this leg either (historical
 * fallback is itself blocked once lifecycle reaches EXPIRATION_PENDING/EXPIRATION_SESSION_ENDED -
 * see `LIFECYCLE_STAGES_BLOCKING_FALLBACK`, positionReviewAssessment.ts) - so this check never needs
 * to consult CURRENT/LAST_VALID.
 */
function isAwaitingBrokerSettlement(stage: CampaignCurrentStage, legExpiration: Date | null, asOf: Date, display: PositionAssessmentDisplay | null): boolean {
  if (display && display.state === "UNAVAILABLE") {
    const lifecycle = display.currentUnavailable.lifecycle;
    if (lifecycle === "EXPIRATION_PENDING" || lifecycle === "EXPIRATION_SESSION_ENDED") return true;
  }
  // Calendar-only fallback for a caller with no live evaluation available at all (e.g. the
  // Dashboard's own top-of-page exposure summary, which never resolves a PositionAssessmentDisplay
  // per campaign - see activeSettlementBreakdown, dashboard-view.ts). Correct for the day-after
  // case; without session evidence it cannot detect "still today, but the session already ended" on
  // its own - that narrower gap is an accepted limitation only where `display` genuinely isn't
  // available, never where it is.
  if (stage === "Expiration processing") return true;
  return legExpiration !== null && isPastExpiration(legExpiration, asOf);
}

/**
 * Weekend / Settlement Clarity - `legExpiration`/`asOf`/`display` let this recognize an expired-but-
 * unresolved leg (put OR covered call) as SETTLEMENT PENDING, including the SAME calendar day its
 * expiration session ends (see isAwaitingBrokerSettlement above) - `currentStage` alone only ever
 * flags a put the day AFTER expiration (its own "Expiration processing" stage), and never a covered
 * call at all: an ASSIGNED campaign with an open call always reports "Covered call" regardless of
 * that call's own expiration - the exact same reason rollStatus.ts's
 * `isCoveredCallRollGuidanceApplicable` exists as a SEPARATE function rather than a `currentStage`
 * branch ("A covered call has no dedicated CampaignCurrentStage of its own once a campaign is
 * ASSIGNED," see that function's own doc comment). This mirrors that established pattern instead of
 * adding branches to `currentStage()` itself - `positionReview.ts`'s live evaluator already
 * independently detects a past-expiration-or-session-ended leg (put OR call) via its own checks
 * before `currentStage` is ever consulted for lifecycle purposes, so `currentStage` staying
 * "Cash-secured put"/"Rolled put"/"Covered call" through session-end has never affected
 * ACTION/LIFECYCLE evaluation - only this presentation label was stale. `legExpiration` is the
 * CURRENTLY open leg's own expiration - pass `null` when there is no open leg to check (e.g.
 * assigned shares with no call). `display` is the SAME live PositionAssessmentDisplay the row
 * itself already resolved - pass `null` only when none is available at all.
 */
export function currentActivityLabel(stage: CampaignCurrentStage, legExpiration: Date | null, asOf: Date, display: PositionAssessmentDisplay | null): CurrentActivityLabel {
  switch (stage) {
    case "Cash-secured put":
    case "Rolled put":
      return isAwaitingBrokerSettlement(stage, legExpiration, asOf, display) ? "SETTLEMENT PENDING" : "SHORT PUT OPEN";
    case "Assigned shares":
      return "SHARES HELD";
    case "Covered call":
      return isAwaitingBrokerSettlement(stage, legExpiration, asOf, display) ? "SETTLEMENT PENDING" : "COVERED CALL OPEN";
    case "Expiration processing":
      return "SETTLEMENT PENDING";
    case "Closed":
      return "CLOSED";
    case "Review needed":
      return "REVIEW NEEDED";
  }
}

/**
 * Weekend / Settlement Clarity - the ONE shared predicate Dashboard (DashboardPositionSections,
 * client-freshness.tsx) and Tracker (CampaignCard's Open tab, positions/page.tsx) both use to split
 * their "open" rows into Active vs Awaiting Settlement - a thin wrapper around currentActivityLabel
 * so neither caller re-derives its own notion of "is this row genuinely active right now." Every
 * open row is, by construction, in exactly one of the two groups (this is a boolean and its
 * negation - never a third, overlapping category), mirroring the same mutual-exclusivity guarantee
 * partitionPositionReviewRows gives Attention Now/Open Positions.
 */
export function isAwaitingSettlement(stage: CampaignCurrentStage, legExpiration: Date | null, asOf: Date, display: PositionAssessmentDisplay | null): boolean {
  return currentActivityLabel(stage, legExpiration, asOf, display) === "SETTLEMENT PENDING";
}

/**
 * Compact position UX - the activity-state badge's own color, keyed on the SAME activity label
 * above rather than the coarser campaign.status (OPEN/ASSIGNED/CLOSED) a prior pass used. Matches
 * the ticket's own semantic-color rule: BLUE for an ordinary, non-urgent active-position state
 * (an open put/call, or shares simply being held - nothing requires a decision right now), AMBER
 * for a state that genuinely needs a look (settlement/expiration still resolving, or a decision
 * point like "no call sold yet against these shares"). CLOSED is handled by the caller with its
 * own existing P/L-colored tone (good/bad/neutral) - this function is never consulted for it, but
 * still returns a safe "neutral" rather than throwing if ever called with it directly.
 */
export type ActivityTone = "info" | "warn" | "neutral";

export function activityTone(label: CurrentActivityLabel): ActivityTone {
  switch (label) {
    case "SHORT PUT OPEN":
    case "COVERED CALL OPEN":
    case "SHARES HELD":
      return "info";
    case "SETTLEMENT PENDING":
    case "REVIEW NEEDED":
      return "warn";
    case "CLOSED":
      return "neutral";
  }
}

/**
 * Secondary, muted ORIGIN context - "how did we get here," never the primary activity signal above.
 * Reads only the campaign's own append-only event history (never inferred from moneyness/price,
 * expiration, or a strike/price relationship).
 *
 * Codex blocker repair (B3) - this used to upgrade to "Called away" once a CLOSED campaign also had
 * a STOCK_SALE event, but that is NOT proof a covered call was actually exercised: `STOCK_SALE` is
 * the SAME event type `sellStockAction` (workflows.ts) creates for a plain, deliberate manual sale
 * of assigned shares - there is no separate "call exercised/assigned" event anywhere in this app's
 * schema, and the ticket's own instruction is explicit: do not invent one, and do not infer call
 * assignment from a stock sale alone. A user who manually sold assigned shares (for any reason,
 * including simply changing their mind, well before any call's expiration) would otherwise be told
 * their shares were "Called away," which this app cannot actually prove. The honest, fully-provable
 * wording is used instead: "Assigned from put" (proven by a real ASSIGNMENT event) for a campaign
 * that still holds the shares or is only now resolving, and "Shares sold" (proven by a real,
 * already-recorded STOCK_SALE event) once the campaign has also CLOSED - a factual statement of
 * what happened, with no claim about WHY. If this app ever gains a real, authoritative signal that
 * actually proves call assignment (not invented here), "Called away" can be reintroduced as a
 * THIRD, separately-gated branch above "Shares sold" - never by weakening this function's current
 * proof requirement.
 */
export function historicalOriginLabel(args: { status: CampaignStatusInput; events: readonly Pick<CampaignEventInput, "type">[] }): string | null {
  const hasAssignment = args.events.some((event) => event.type === "ASSIGNMENT");
  if (!hasAssignment) {
    return null;
  }
  const hasStockSale = args.events.some((event) => event.type === "STOCK_SALE");
  if (args.status === "CLOSED" && hasStockSale) {
    return "Shares sold";
  }
  return "Assigned from put";
}
