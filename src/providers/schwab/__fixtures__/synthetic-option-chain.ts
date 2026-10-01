/**
 * SYNTHETIC Schwab option-chain contract/payload builders - NOT derived from any live Schwab
 * capture. The repo's one real sanitized observation is strict-option-chain-live-derived.json,
 * which recorded a zero-bid, 0-DTE contract and never preserved a raw `optionRoot` value at all.
 * Whenever a test needs something that capture doesn't provide - a positive bid, a
 * fully-standard-and-passing contract, a controlled timestamp, a malformed value - it must come
 * from here, built explicitly, never blended into or described as captured provider evidence.
 */

export type SyntheticContractOverrides = Record<string, unknown>;

/** A fully standard, fully eligible synthetic PUT contract shape (raw Schwab-like JSON) - every
 * value here is made up for test convenience, not observed. Override any field to construct a
 * specific failing/edge case while keeping the rest of the shape standard. */
export function makeSyntheticStandardSpyContract(overrides: SyntheticContractOverrides = {}): Record<string, unknown> {
  return {
    putCall: "PUT",
    symbol: "SPY   261016P00655000",
    optionRoot: "SPY", // synthetic - the real sanitized capture never preserved this raw field's value
    strikePrice: 655,
    expirationDate: "2026-10-16T20:00:00.000+00:00",
    bid: 1.25,
    ask: 1.3,
    quoteTimeInLong: 1769533800123,
    multiplier: 100,
    nonStandard: false,
    mini: false,
    settlementType: "P",
    optionDeliverablesList: [{ symbol: "SPY", assetType: "STOCK", deliverableUnits: 100, currencyType: "USD" }],
    openInterest: 312,
    totalVolume: 10,
    delta: -0.22,
    ...overrides,
  };
}

/** A full synthetic chain-root payload wrapping one synthetic contract, for normalizer/provider
 * tests that need a complete raw `/chains` response shape rather than just one contract object. */
export function makeSyntheticStandardSpyChainPayload(params: {
  expirationMapKey?: string;
  strikeMapKey?: string;
  rootOverrides?: Record<string, unknown>;
  contractOverrides?: SyntheticContractOverrides;
} = {}): Record<string, unknown> {
  const expirationMapKey = params.expirationMapKey ?? "2026-10-16:16";
  const strikeMapKey = params.strikeMapKey ?? "655.0";
  return {
    symbol: "SPY",
    status: "SUCCESS",
    isDelayed: false,
    putExpDateMap: { [expirationMapKey]: { [strikeMapKey]: [makeSyntheticStandardSpyContract(params.contractOverrides)] } },
    callExpDateMap: {},
    ...params.rootOverrides,
  };
}
