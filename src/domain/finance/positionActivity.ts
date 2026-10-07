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
 * Secondary, muted ORIGIN context - "how did we get here," never the primary activity signal above.
 * Reads only the campaign's own append-only event history (never inferred from moneyness/price) -
 * "Assigned from put" once any ASSIGNMENT event exists, upgraded to "Called away" once the campaign
 * has also CLOSED with a STOCK_SALE in its history (the wheel's own vocabulary for shares leaving
 * while a covered call was active - this app has no separate "call exercised" event type; a closed
 * campaign that assigned shares and later sold them is, by definition, how a covered call resolves
 * when it finishes in-the-money). Returns null when there is no assignment history to describe -
 * an ordinary still-open short put has no "origin" worth a secondary label.
 */
export function historicalOriginLabel(args: { status: CampaignStatusInput; events: readonly Pick<CampaignEventInput, "type">[] }): string | null {
  const hasAssignment = args.events.some((event) => event.type === "ASSIGNMENT");
  if (!hasAssignment) {
    return null;
  }
  const hasStockSale = args.events.some((event) => event.type === "STOCK_SALE");
  if (args.status === "CLOSED" && hasStockSale) {
    return "Called away";
  }
  return "Assigned from put";
}
