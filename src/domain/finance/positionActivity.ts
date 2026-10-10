import type { CampaignCurrentStage, CampaignEventInput, CampaignStatusInput } from "./campaigns";

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

export function currentActivityLabel(stage: CampaignCurrentStage): CurrentActivityLabel {
  switch (stage) {
    case "Cash-secured put":
    case "Rolled put":
      return "SHORT PUT OPEN";
    case "Assigned shares":
      return "SHARES HELD";
    case "Covered call":
      return "COVERED CALL OPEN";
    case "Expiration processing":
      return "SETTLEMENT PENDING";
    case "Closed":
      return "CLOSED";
    case "Review needed":
      return "REVIEW NEEDED";
  }
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
