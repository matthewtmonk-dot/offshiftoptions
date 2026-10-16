import type { PositionReviewAction } from "./positionReview";

/**
 * "What do I do next?" in one plain sentence per position. Pure presentation of the app's EXISTING
 * review result (Comfortable / Watch / Review roll / Review call) plus days-to-expiration - it adds no new
 * judgement and never tells anyone to place a trade; execution stays in Schwab. The wording leans on the
 * app's own routine (the 3:00 PM ET position check) rather than inventing urgency.
 *
 * tone: "ok" nothing to do, "watch" check again soon, "act" a decision is due, "wait" nothing can be
 * done until data arrives.
 */
export type NextStep = { text: string; tone: "ok" | "watch" | "act" | "wait" };

export function nextStepFor(input: {
  settlementPending: boolean;
  /** null when no review result exists (still loading / unavailable). */
  action: PositionReviewAction | null;
  /** Calendar days until the open leg expires (0 = today); null when unknown. */
  dte: number | null;
  /** True when `action` comes from the last valid (older) reading rather than a live one. */
  historical: boolean;
}): NextStep {
  const { settlementPending, action, dte, historical } = input;
  const older = historical ? " (from the last valid reading - press Refresh status to update)" : "";
  const when = dte === 0 ? "today" : dte === 1 ? "tomorrow" : null;

  if (settlementPending) {
    return { tone: "wait", text: "Nothing to do - waiting for Schwab to settle this. Run Brokerage Sync tomorrow to confirm." };
  }
  if (action === null || action === "CANNOT_ASSESS") {
    return { tone: "wait", text: "No current reading yet - press Refresh status (or run Brokerage Sync if the position isn't confirmed)." };
  }
  if (action === "COMFORTABLE") {
    return { tone: "ok", text: `No action needed${when ? ` - expires ${when}` : ""}.${older}` };
  }
  if (action === "WATCH") {
    if (dte !== null && dte <= 1) {
      return { tone: "watch", text: `Expires ${when}, close to the strike - decide at the 3:00 PM ET check whether to roll or let it expire.${older}` };
    }
    return { tone: "watch", text: `Re-check at the next 3:00 PM ET position check.${older}` };
  }
  if (action === "REVIEW_CALL") {
    return { tone: "act", text: `Decide on this covered call - the stock is at or above the strike: roll it, close it, or let the shares be called away.${older}` };
  }
  // REVIEW_ROLL
  if (dte !== null && dte <= 1) {
    return { tone: "act", text: `Decide ${when}: the stock is past the strike and this expires ${when} - roll it, close it, or take assignment.${older}` };
  }
  return { tone: "act", text: `Decide whether to roll: the stock is past the strike. Compare roll options in Schwab.${older}` };
}
