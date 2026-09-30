export type BrokerAccount = {
  id: string;
  label: string;
  accountValue: number;
  cash: number;
  /** Raw currentBalances.liquidationValue, with NO fallback chain applied - null when the
   * provider genuinely did not report it. Distinct from accountValue above (which falls back to
   * initialBalances/0 for display purposes) - never fabricate this one as zero. Session/cutoff
   * provenance is separately established (or not) at ingestion; this field never implies either. */
  liquidationValue: number | null;
};

export type BrokerPosition = {
  accountId: string;
  symbol: string;
  quantity: number;
  marketValue: number | null;
  /** Actual provider valuation time, if verified. Retrieval time is not valuation provenance. */
  valuationAsOf?: Date | null;
  /**
   * Codex P1 (B1) - this app's own observation of when the HTTP response carrying THIS position
   * was actually received, stamped once per `getPositions` call at the provider layer (see
   * SchwabBrokerReadProvider.getPositions) - deliberately distinct from `valuationAsOf` above,
   * which is a provider-reported price/valuation time and is currently always null in production.
   * Never substitute one for the other: `valuationAsOf` answers "as of when is this price/value
   * true," this field answers "when did we last successfully read this position." A cache HIT
   * (see providers/broker-read/cache.ts) replays the exact stored value - and therefore this exact
   * timestamp - unchanged, since it is stamped BEFORE the cache boundary, never re-stamped with
   * `new Date()` on every access. Null only when no successful read has ever produced this value
   * (e.g. a synthetic/test fixture) - never fabricated as "now."
   */
  positionReadReceivedAt?: Date | null;
  /** Schwab's own instrument classification, when available (e.g. "OPTION", "EQUITY"). */
  assetType?: string | null;
  /** Schwab's own put/call flag for an option instrument, when available - the most
   * authoritative signal for identifying a short put; falls back to OCC symbol parsing
   * (see src/domain/finance/occOption.ts) when absent. */
  putCall?: "PUT" | "CALL" | null;
  /** The option's strike price, straight from Schwab's instrument object when available. */
  strikePrice?: number | null;
  underlyingSymbol?: string | null;
  /**
   * Codex P2 (B, round 3) - the option's actual, provider-verified shares-per-contract deliverable,
   * when a trustworthy field for it exists on the underlying instrument. Deliberately NOT derived
   * from OCC symbol shape: a symbol parsing as this app's one supported standard OCC contract shape
   * (see occOption.ts) proves the SYMBOL is well-formed, never that the contract's actual current
   * deliverable is a standard 100 shares - adjusted/nonstandard deliverables can exist and this app
   * has no live diagnostic confirming Schwab's provider response ever exposes this field today.
   * Currently always null/undefined in production (no normalizer populates it) - present so covered
   * -call coverage math can require a PROVEN multiplier of 100 rather than assuming one, and so a
   * future ticket with verified provider evidence can populate it without another type change.
   */
  sharesPerContract?: number | null;
};

/**
 * One normalized Schwab transferItem, preserved alongside (never instead of) the existing
 * single selected primary-item fields on BrokerTransaction - see mapTransactionsPayload in
 * broker-read.ts. A single Schwab transaction can carry more than one economically relevant
 * transferItem (e.g. an option leg AND an equity leg on an assignment/exercise), and the
 * existing primary-item selection (selectTradedSecurityTransferItem) only ever keeps one of
 * them. This type exists so the discarded leg(s) are no longer silently lost - not to drive any
 * new reconciliation behavior yet (see PROJECT_HANDOFF.md's Covered Call Phase 3C).
 *
 * Every numeric field is preserved exactly as Schwab reports it on that item, including sign -
 * never abs()'d, never inferred from optionType/instruction. Fields genuinely absent on a given
 * leg (e.g. a non-option equity leg has no strike/expiration) come back null rather than guessed.
 */
export type BrokerTransferLeg = {
  assetType: string | null;
  symbol: string | null;
  underlyingSymbol: string | null;
  optionType: "PUT" | "CALL" | null;
  strike: number | null;
  expiration: Date | null;
  /** Schwab's own signed transferItem.amount - for an option/equity leg this is a signed
   * contract/share count (direction preserved exactly as Schwab reports it). */
  quantity: number | null;
  price: number | null;
  /** A fee-type transferItem's own dollar value (Schwab's `cost` field) - present instead of
   * quantity/price on fee legs, never combined with them. */
  cost: number | null;
  instruction: string | null;
  positionEffect: string | null;
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
  /** Every economically relevant transferItem on this Schwab transaction, normalized - see
   * BrokerTransferLeg. Additive/optional: absent or empty for a transaction with no transferItems
   * (e.g. a CSV-sourced record, which never has this concept at all). Never used to drive any
   * reconciliation decision yet - purely preserved evidence for a later phase. */
  transferLegs?: BrokerTransferLeg[];
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
  /** `signal` is optional and purely additive - see schwabGetJson's own doc comment
   * (providers/schwab/client.ts). Only the manual "Refresh status" bounded-operation path ever
   * passes one; every other existing caller keeps its exact prior behavior. */
  getAccounts(signal?: AbortSignal): Promise<BrokerAccount[]>;
  getAccount(accountId: string): Promise<BrokerAccount | null>;
  getPositions(accountId: string, signal?: AbortSignal): Promise<BrokerPosition[]>;
  getTransactions(accountId: string, from: Date, to: Date): Promise<BrokerTransactionsResult>;
  getOrders(accountId: string, from: Date, to: Date): Promise<BrokerObservedOrder[]>;
}
