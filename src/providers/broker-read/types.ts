export type BrokerAccount = {
  id: string;
  label: string;
  accountValue: number;
  cash: number;
};

export type BrokerPosition = {
  accountId: string;
  symbol: string;
  quantity: number;
  marketValue: number;
  /** Schwab's own instrument classification, when available (e.g. "OPTION", "EQUITY"). */
  assetType?: string | null;
  /** Schwab's own put/call flag for an option instrument, when available - the most
   * authoritative signal for identifying a short put; falls back to OCC symbol parsing
   * (see src/domain/finance/occOption.ts) when absent. */
  putCall?: "PUT" | "CALL" | null;
  /** The option's strike price, straight from Schwab's instrument object when available. */
  strikePrice?: number | null;
  underlyingSymbol?: string | null;
};

export type BrokerTransaction = {
  id: string;
  accountId: string;
  symbol?: string;
  amount: number;
  occurredAt: Date;
  description: string;
  /** The opening/closing instruction (e.g. "Sell to Open"), when Schwab reports one - same
   * vocabulary as the Transactions CSV export's "Action" column so both sources classify
   * identically via classifyBrokerTransactionAction. */
  action?: string | null;
  quantity?: number | null;
  price?: number | null;
  fees?: number | null;
  underlyingSymbol?: string | null;
  optionType?: "PUT" | "CALL" | null;
  strike?: number | null;
  expiration?: Date | null;
};

export type BrokerObservedOrder = {
  id: string;
  accountId: string;
  symbol?: string;
  status: string;
  enteredAt: Date;
};

/** Schwab's Transaction History `types` values this app actually requests - each fetched as
 * its own independent request so one unsupported/rejected category can never erase another's
 * results (see SchwabBrokerReadProvider.getTransactions). */
export type BrokerTransactionCategory = "TRADE" | "RECEIVE_AND_DELIVER" | "DIVIDEND_OR_INTEREST";

/** No error detail is carried on failure - only the enum - so a raw provider error can never
 * reach diagnostics or the UI through this type. */
export type BrokerTransactionCategoryOutcome = { status: "OK"; count: number } | { status: "ERROR" };

export type BrokerTransactionsResult = {
  transactions: BrokerTransaction[];
  categories: Record<BrokerTransactionCategory, BrokerTransactionCategoryOutcome>;
};

export interface BrokerReadProvider {
  getAccounts(): Promise<BrokerAccount[]>;
  getAccount(accountId: string): Promise<BrokerAccount | null>;
  getPositions(accountId: string): Promise<BrokerPosition[]>;
  getTransactions(accountId: string, from: Date, to: Date): Promise<BrokerTransactionsResult>;
  getOrders(accountId: string, from: Date, to: Date): Promise<BrokerObservedOrder[]>;
}
