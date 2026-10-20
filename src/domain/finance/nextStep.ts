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
  /** Calendar days since the leg expired (only meaningful while settlement is pending); null when unknown. */
  daysPastExpiration?: number | null;
}): NextStep {
  const { settlementPending, action, dte, historical, daysPastExpiration = null } = input;
  // Kept deliberately terse - one short phrase per state; the badge beside it already says why.
  const sentence = (core: string) => `${core}${historical ? " (last reading)" : ""}.`;
  const when = dte === 0 ? "today" : dte === 1 ? "tomorrow" : null;

  if (settlementPending) {
    // A just-expired leg normally settles by the next sync. One that is still unconfirmed days later almost
    // always means Brokerage Sync hasn't run since it expired - "tomorrow" would be the wrong advice.
    if (daysPastExpiration !== null && daysPastExpiration >= 4) {
      return { tone: "watch", text: `Expired ${daysPastExpiration} days ago - run Brokerage Sync.` };
    }
    return { tone: "wait", text: "Waiting on Schwab - sync tomorrow." };
  }
  if (action === null || action === "CANNOT_ASSESS") {
    return { tone: "wait", text: "No reading yet - press Refresh status." };
  }
  if (action === "COMFORTABLE") {
    return { tone: "ok", text: sentence(`No action${when ? ` - expires ${when}` : ""}`) };
  }
  if (action === "WATCH") {
    if (dte !== null && dte <= 1) {
      return { tone: "watch", text: sentence(`Expires ${when} - roll or let it expire (3 PM check)`) };
    }
    return { tone: "watch", text: sentence("Check again at 3 PM") };
  }
  if (action === "REVIEW_CALL") {
    return { tone: "act", text: sentence("Roll, close, or let it be called away") };
  }
  // REVIEW_ROLL
  return { tone: "act", text: sentence(`Roll${when ? ` - expires ${when}` : ""}`) };
}
