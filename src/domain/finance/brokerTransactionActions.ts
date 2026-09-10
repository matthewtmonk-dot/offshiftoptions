/**
 * Classifies a Schwab transaction-export "Action" cell into a fixed activity vocabulary,
 * using only what Schwab's own text says - never guessing intent from amount sign alone.
 * Anything not recognized comes back "UNKNOWN" so the caller can flag the row NEEDS_REVIEW
 * instead of silently mis-classifying it.
 */
export type BrokerTransactionActivityKind =
  | "SELL_TO_OPEN"
  | "BUY_TO_CLOSE"
  | "BUY_TO_OPEN"
  | "SELL_TO_CLOSE"
  | "STOCK_BUY"
  | "STOCK_SELL"
  | "ASSIGNMENT"
  | "EXERCISE"
  | "DIVIDEND"
  | "INTEREST"
  | "FEE"
  | "TRANSFER"
  | "OPTION_REMOVED_EXPIRATION"
  | "UNKNOWN";

const EXACT_ACTION_MAP: Record<string, BrokerTransactionActivityKind> = {
  "sell to open": "SELL_TO_OPEN",
  "buy to close": "BUY_TO_CLOSE",
  "buy to open": "BUY_TO_OPEN",
  "sell to close": "SELL_TO_CLOSE",
  buy: "STOCK_BUY",
  sell: "STOCK_SELL",
  "reinvest shares": "STOCK_BUY",
  assignment: "ASSIGNMENT",
  "option assignment": "ASSIGNMENT",
  exercise: "EXERCISE",
  "option exercise": "EXERCISE",
  dividend: "DIVIDEND",
  "qualified dividend": "DIVIDEND",
  "cash dividend": "DIVIDEND",
  "non-qualified div": "DIVIDEND",
  "reinvest dividend": "DIVIDEND",
  "bank interest": "INTEREST",
  interest: "INTEREST",
  "margin interest": "FEE",
  "service fee": "FEE",
  "adr fee": "FEE",
  "foreign tax paid": "FEE",
  "security transfer": "TRANSFER",
  "journaled shares": "TRANSFER",
  "wire received": "TRANSFER",
  "wire sent": "TRANSFER",
  "moneylink transfer": "TRANSFER",
  "funds received": "TRANSFER",
  "atm withdrawal": "TRANSFER",
  // Confirmed live against production: a real RECEIVE_AND_DELIVER transaction reports no
  // instruction at all, only free-text description ("Removed due to Expiration PUT ...") -
  // recognized evidence that an option reached expiration/removal, never a guess about the
  // final outcome (assignment vs. worthless still requires the existing confirmation rule).
  "removed - expiration": "OPTION_REMOVED_EXPIRATION",
};

export function classifyBrokerTransactionAction(action: string | null | undefined): BrokerTransactionActivityKind {
  if (!action) {
    return "UNKNOWN";
  }

  const normalized = action.trim().toLowerCase();
  return EXACT_ACTION_MAP[normalized] ?? "UNKNOWN";
}

/**
 * Some Schwab account-history rows arrive without a normalized action label, especially
 * RECEIVE_AND_DELIVER and DIVIDEND_OR_INTEREST activity. Use the explicit action first, then
 * fall back to conservative text matches from Schwab's type/description fields.
 */
export function classifyBrokerTransactionActivity(input: {
  action?: string | null;
  description?: string | null;
}): BrokerTransactionActivityKind {
  const actionKind = classifyBrokerTransactionAction(input.action);
  if (actionKind !== "UNKNOWN") {
    return actionKind;
  }

  const descriptionKind = classifyBrokerTransactionAction(input.description);
  if (descriptionKind !== "UNKNOWN") {
    return descriptionKind;
  }

  const text = `${input.action ?? ""} ${input.description ?? ""}`.trim().toLowerCase();
  if (!text) {
    return "UNKNOWN";
  }

  if (text.includes("removed due to expiration") || text.includes("removed - expiration")) {
    return "OPTION_REMOVED_EXPIRATION";
  }
  if (text.includes("assignment")) {
    return "ASSIGNMENT";
  }
  if (text.includes("exercise")) {
    return "EXERCISE";
  }
  if (text.includes("bank int")) {
    return "INTEREST";
  }
  if (text.includes("dividend")) {
    return "DIVIDEND";
  }
  if (text.includes("interest")) {
    return "INTEREST";
  }
  if (
    text.includes("security transfer") ||
    text.includes("toa acat") ||
    text.includes("moneylink transfer") ||
    text.includes("wire received") ||
    text.includes("wire sent") ||
    text.includes("funds received") ||
    text.includes("journaled shares") ||
    text.includes("atm withdrawal")
  ) {
    return "TRANSFER";
  }

  return "UNKNOWN";
}

/** True when the activity kind is well-understood enough to skip manual review. */
export function isReviewedBrokerTransactionActivity(kind: BrokerTransactionActivityKind): boolean {
  return kind !== "UNKNOWN";
}
