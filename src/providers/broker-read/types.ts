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

export interface BrokerReadProvider {
  getAccounts(): Promise<BrokerAccount[]>;
  getAccount(accountId: string): Promise<BrokerAccount | null>;
  getPositions(accountId: string): Promise<BrokerPosition[]>;
  getTransactions(accountId: string, from: Date, to: Date): Promise<BrokerTransaction[]>;
  getOrders(accountId: string, from: Date, to: Date): Promise<BrokerObservedOrder[]>;
}
