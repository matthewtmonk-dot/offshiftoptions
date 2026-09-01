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
};

export function classifyBrokerTransactionAction(action: string | null | undefined): BrokerTransactionActivityKind {
  if (!action) {
    return "UNKNOWN";
  }

  const normalized = action.trim().toLowerCase();
  return EXACT_ACTION_MAP[normalized] ?? "UNKNOWN";
}

/** True when the activity kind is well-understood enough to skip manual review. */
export function isReviewedBrokerTransactionActivity(kind: BrokerTransactionActivityKind): boolean {
  return kind !== "UNKNOWN";
}
