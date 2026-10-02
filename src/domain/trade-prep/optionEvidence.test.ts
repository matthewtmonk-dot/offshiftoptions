import { describe, expect, it } from "vitest";
import type { EquityMarketSessionEvidence, QuoteReviewEvidence, StrictOptionContractSnapshot } from "@/providers/market-data/types";
import {
  evaluateOptionIdentity,
  hasConflictingDuplicateIdentity,
  evaluateBidAsk,
  evaluateQuoteFreshness,
  STRICT_QUOTE_MAX_AGE_MS,
  evaluateChainDelay,
  evaluateChainEnvelopeStatus,
  evaluateSessionEligibility,
  evaluateStandardContractTerms,
  evaluateUnderlyingOptionAlignment,
  evaluateUnderlyingBinding,
  evaluateOpenInterest,
  evaluateTotalVolume,
  evaluatePutDelta,
  computeStrictOptionEconomics,
  evaluateStrictOptionEvidence,
} from "./optionEvidence";

const EVALUATION_NOW = new Date("2026-10-01T18:00:00.000Z"); // 14:00 ET, mid regular-session
const QUOTE_TIME = new Date("2026-10-01T17:59:59.950Z"); // 50ms before now - fresh
const REQUEST_STARTED_AT = new Date("2026-10-01T17:59:59.000Z");
const RESPONSE_RECEIVED_AT = new Date("2026-10-01T17:59:59.950Z");

const BASE_ENVELOPE = { status: "SUCCESS", rootSymbol: "SPY", isDelayed: false };

// SYNTHETIC evaluator-unit-test fixture - deliberately NOT derived from any live Schwab capture
// (see src/providers/schwab/__fixtures__/strict-option-chain-live-derived.json for the repo's one
// real sanitized observation, which has a zero bid and no reliable optionRoot source value). This
// factory exists purely to exercise each pure evaluator's own logic in isolation with controlled,
// always-standard-and-passing inputs that individual tests then deviate from one field at a time.
function baseContract(): StrictOptionContractSnapshot {
  return {
    location: { expirationMapKey: "2026-10-16:16", strikeMapKey: "655.0", originatingMap: "PUT" },
    identity: {
      providerSymbol: "SPY   261016P00655000",
      putCall: "PUT",
      strikePrice: 655,
      expirationDate: new Date("2026-10-16T20:00:00.000Z"),
      optionRoot: "SPY", // synthetic - the real capture never preserved this raw field's value
    },
    quote: { bid: 1.2, ask: 1.3, quoteTimeInLong: QUOTE_TIME.getTime() },
    terms: {
      multiplier: 100,
      nonStandard: false,
      mini: false,
      optionDeliverablesList: [{ symbol: "SPY", assetType: "STOCK", deliverableUnits: 100, currencyType: "USD" }],
      settlementType: "P",
      deliverableNote: null,
    },
    ruleInputs: { openInterest: 312, totalVolume: 10, delta: -0.22 },
  };
}

function contractWith(patch: {
  location?: Partial<StrictOptionContractSnapshot["location"]>;
  identity?: Partial<StrictOptionContractSnapshot["identity"]>;
  quote?: Partial<StrictOptionContractSnapshot["quote"]>;
  terms?: Partial<StrictOptionContractSnapshot["terms"]>;
  ruleInputs?: Partial<StrictOptionContractSnapshot["ruleInputs"]>;
}): StrictOptionContractSnapshot {
  const base = baseContract();
  return {
    location: { ...base.location, ...patch.location },
    identity: { ...base.identity, ...patch.identity },
    quote: { ...base.quote, ...patch.quote },
    terms: { ...base.terms, ...patch.terms },
    ruleInputs: { ...base.ruleInputs, ...patch.ruleInputs },
  };
}

function sessionEvidenceFor(nyDate: string, overrides: Partial<EquityMarketSessionEvidence & { status: "AVAILABLE" }> = {}): EquityMarketSessionEvidence {
  return {
    status: "AVAILABLE",
    requestedDate: nyDate,
    returnedDate: nyDate,
    marketType: "EQUITY",
    product: "EQ",
    isOpen: true,
    regularMarketIntervals: [{ start: new Date(`${nyDate}T09:30:00-04:00`), end: new Date(`${nyDate}T16:00:00-04:00`) }],
    ...overrides,
  };
}

const BASE_SESSION = sessionEvidenceFor("2026-10-01");

function underlyingEvidenceAt(tradeTime: Date, overrides: Partial<Extract<QuoteReviewEvidence, { status: "AVAILABLE" }>> = {}): QuoteReviewEvidence {
  return {
    status: "AVAILABLE",
    requestedSymbol: "SPY",
    returnedSymbol: "SPY",
    assetMainType: "EQUITY",
    realtime: true,
    price: 650,
    tradeTime,
    requestStartedAt: tradeTime,
    responseReceivedAt: tradeTime,
    ...overrides,
  };
}

// =================================================================================================
// IDENTITY
// =================================================================================================

describe("evaluateOptionIdentity", () => {
  const base = () => ({ requestedUnderlying: "SPY", envelope: BASE_ENVELOPE, contract: baseContract() });

  it("PASSes when provider symbol, structured fields, and map location are all mutually consistent", () => {
    const result = evaluateOptionIdentity(base());
    expect(result).toEqual({ status: "PASS", reasonCode: "IDENTITY_VALID", detail: expect.any(String) });
  });

  it("is UNKNOWN (never FAIL, never PASS) when the provider symbol is absent - insufficient evidence, not a fabricated mismatch", () => {
    const result = evaluateOptionIdentity({ ...base(), contract: contractWith({ identity: { providerSymbol: null } }) });
    expect(result.status).toBe("UNKNOWN");
    expect(result.reasonCode).toBe("IDENTITY_MISSING");
  });

  it("is UNKNOWN when structured expirationDate is absent", () => {
    const result = evaluateOptionIdentity({ ...base(), contract: contractWith({ identity: { expirationDate: null } }) });
    expect(result.status).toBe("UNKNOWN");
    expect(result.reasonCode).toBe("IDENTITY_MISSING");
  });

  it("is UNKNOWN when the raw optionRoot field is absent (the real live-derived capture's own shape)", () => {
    const result = evaluateOptionIdentity({ ...base(), contract: contractWith({ identity: { optionRoot: null } }) });
    expect(result.status).toBe("UNKNOWN");
    expect(result.reasonCode).toBe("IDENTITY_MISSING");
  });

  it("is UNKNOWN when chain root symbol is absent", () => {
    const result = evaluateOptionIdentity({ ...base(), envelope: { rootSymbol: null } });
    expect(result.status).toBe("UNKNOWN");
    expect(result.reasonCode).toBe("IDENTITY_MISSING");
  });

  it("is UNKNOWN when structured putCall is absent", () => {
    const result = evaluateOptionIdentity({ ...base(), contract: contractWith({ identity: { putCall: null } }) });
    expect(result.status).toBe("UNKNOWN");
    expect(result.reasonCode).toBe("IDENTITY_MISSING");
  });

  it("is UNKNOWN when structured strikePrice is absent", () => {
    const result = evaluateOptionIdentity({ ...base(), contract: contractWith({ identity: { strikePrice: null } }) });
    expect(result.status).toBe("UNKNOWN");
    expect(result.reasonCode).toBe("IDENTITY_MISSING");
  });

  it("never accepts a synthesized fallback symbol shape (e.g. 'SPY 2026-10-16:16 PUT655') as valid", () => {
    const result = evaluateOptionIdentity({ ...base(), contract: contractWith({ identity: { providerSymbol: "SPY 2026-10-16:16 PUT655" } }) });
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("IDENTITY_MISMATCH");
  });

  it("fails (actual disagreement) on chain root symbol mismatch", () => {
    const result = evaluateOptionIdentity({ ...base(), envelope: { rootSymbol: "QQQ" } });
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("IDENTITY_MISMATCH");
  });

  it("fails when the contract did not originate from the PUT map", () => {
    const result = evaluateOptionIdentity({ ...base(), contract: contractWith({ location: { originatingMap: "CALL" } }) });
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("IDENTITY_MISMATCH");
  });

  it("fails on PUT/CALL mismatch between structured putCall and the provider symbol/map", () => {
    const result = evaluateOptionIdentity({ ...base(), contract: contractWith({ identity: { putCall: "CALL" } }) });
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("IDENTITY_MISMATCH");
  });

  it("fails (wrong optionRoot) when the raw optionRoot disagrees with the requested underlying", () => {
    const result = evaluateOptionIdentity({ ...base(), contract: contractWith({ identity: { optionRoot: "QQQ" } }) });
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("IDENTITY_MISMATCH");
  });

  it("never derives/fills optionRoot from the provider symbol - a present-but-wrong optionRoot fails even when the symbol itself would parse to the right underlying", () => {
    const result = evaluateOptionIdentity({ ...base(), contract: contractWith({ identity: { optionRoot: "QQQ" } }) }); // symbol is still "SPY   261016P00655000"
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("IDENTITY_MISMATCH");
  });

  it("fails on a strike mismatch between structured strikePrice and the strike map key", () => {
    const result = evaluateOptionIdentity({ ...base(), contract: contractWith({ location: { strikeMapKey: "660.0" } }) });
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("IDENTITY_MISMATCH");
  });

  it("fails (wrong strike) on a strike mismatch between the provider symbol's own encoded strike and strikePrice", () => {
    const result = evaluateOptionIdentity({
      ...base(),
      contract: contractWith({ identity: { strikePrice: 660 }, location: { strikeMapKey: "660.0" } }),
    });
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("IDENTITY_MISMATCH");
  });

  it("accepts decimal-equivalent strike representations (655, 655.0, 655.00) as equal", () => {
    expect(evaluateOptionIdentity({ ...base(), contract: contractWith({ identity: { strikePrice: 655.0 }, location: { strikeMapKey: "655.0000" } }) }).status).toBe("PASS");
    expect(evaluateOptionIdentity({ ...base(), contract: contractWith({ identity: { strikePrice: 655 }, location: { strikeMapKey: "655.00" } }) }).status).toBe("PASS");
  });

  it("does NOT silently round a materially different decimal strike (655.0001 vs 655) into equality", () => {
    const result = evaluateOptionIdentity({ ...base(), contract: contractWith({ identity: { strikePrice: 655.0001 } }) }); // map key/provider symbol still say 655
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("IDENTITY_MISMATCH");
  });

  describe("exact strike equality (Codex self-review repair - toFixed(4) previously rounded 25.00004 into 25)", () => {
    // Build a $25-strike contract so the strike map key/provider symbol both literally encode "25" -
    // only identity.strikePrice is varied per case, isolating strikesEqual's own exact-equality
    // behavior from every other identity check.
    const strike25Contract = (strikePrice: number, strikeMapKey: string = "25.0") =>
      contractWith({
        identity: { providerSymbol: "SPY   261016P00025000", strikePrice },
        location: { strikeMapKey },
      });

    it("25 equals 25.0 (structured strikePrice vs a differently-formatted structured strikePrice)", () => {
      expect(evaluateOptionIdentity({ ...base(), contract: strike25Contract(25) }).status).toBe("PASS");
      expect(evaluateOptionIdentity({ ...base(), contract: strike25Contract(25.0) }).status).toBe("PASS");
    });

    it("25 equals a strike map key written as \"25.000\"", () => {
      const result = evaluateOptionIdentity({ ...base(), contract: strike25Contract(25, "25.000") });
      expect(result.status).toBe("PASS");
    });

    it("25 does NOT equal 25.00004 - the exact Codex-reproduced toFixed(4) rounding failure", () => {
      const result = evaluateOptionIdentity({ ...base(), contract: strike25Contract(25.00004) }); // map key still says "25.0"
      expect(result.status).toBe("FAIL");
      expect(result.reasonCode).toBe("IDENTITY_MISMATCH");
    });

    it("25 does NOT equal 25.0001", () => {
      const result = evaluateOptionIdentity({ ...base(), contract: strike25Contract(25.0001) });
      expect(result.status).toBe("FAIL");
      expect(result.reasonCode).toBe("IDENTITY_MISMATCH");
    });

    it("25 does NOT equal 24.99999", () => {
      const result = evaluateOptionIdentity({ ...base(), contract: strike25Contract(24.99999) });
      expect(result.status).toBe("FAIL");
      expect(result.reasonCode).toBe("IDENTITY_MISMATCH");
    });
  });

  it("fails on a non-finite/non-positive strikePrice", () => {
    expect(evaluateOptionIdentity({ ...base(), contract: contractWith({ identity: { strikePrice: 0 } }) }).status).toBe("FAIL");
    expect(evaluateOptionIdentity({ ...base(), contract: contractWith({ identity: { strikePrice: -5 } }) }).status).toBe("FAIL");
    expect(evaluateOptionIdentity({ ...base(), contract: contractWith({ identity: { strikePrice: NaN } }) }).status).toBe("FAIL");
  });

  it("fails (wrong expiration) on a mismatch between the expiration map key and the provider symbol's encoded expiration", () => {
    const result = evaluateOptionIdentity({ ...base(), contract: contractWith({ location: { expirationMapKey: "2026-11-20:51" } }) });
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("IDENTITY_MISMATCH");
  });

  it("fails on an expiration mismatch between structured expirationDate and the expiration map key", () => {
    const result = evaluateOptionIdentity({ ...base(), contract: contractWith({ identity: { expirationDate: new Date("2026-11-20T20:00:00.000Z") } }) });
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("IDENTITY_MISMATCH");
  });

  it("fails when a deliverable symbol mismatch exists (surfaced via the composable evaluator's contractTerms gate, not identity itself)", () => {
    const result = evaluateStandardContractTerms({ terms: contractWith({ terms: { optionDeliverablesList: [{ symbol: "QQQ", assetType: "STOCK", deliverableUnits: 100, currencyType: "USD" }] } }).terms, supportedUnderlying: "SPY" });
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("CONTRACT_UNSUPPORTED");
  });

  it("fails with IDENTITY_MISMATCH when two contracts share strike/expiration/PUT but report conflicting provider symbols (remains ambiguous)", () => {
    const a = contractWith({});
    const b = contractWith({ identity: { providerSymbol: "SPY   261016P00655001" } }); // same strike/expiration/PUT key, different symbol
    const result = evaluateOptionIdentity({ ...base(), contract: a, siblingContracts: [a, b] });
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("IDENTITY_MISMATCH");
    expect(hasConflictingDuplicateIdentity([a, b], a)).toBe(true);
  });

  it("flags a conflicting duplicate even when the provider symbol matches but OTHER evidence (e.g. bid) differs", () => {
    const a = contractWith({ quote: { bid: 1.2 } });
    const b = contractWith({ quote: { bid: 1.5 } }); // identical identity, same symbol, but a different bid
    expect(hasConflictingDuplicateIdentity([a, b], a)).toBe(true);
  });

  it("does NOT flag a harmless identical duplicate observation (fully evidence-identical)", () => {
    const a = contractWith({});
    const b = contractWith({}); // structurally identical to a in every field
    expect(hasConflictingDuplicateIdentity([a, b], a)).toBe(false);
  });

  describe("same exact provider symbol with contradictory evidence (Codex final review - the apparent-identity pre-filter must not hide this)", () => {
    it("flags ambiguous when two records share the exact same provider symbol but disagree on structured strikePrice (550 vs 551)", () => {
      // Both records claim the SAME provider symbol, which itself encodes strike 655 - but B's own
      // structured strikePrice field contradicts it. The OLD pre-filter (requiring strike agreement
      // BEFORE comparing fingerprints) would skip this pair entirely, letting A look valid alone.
      const a = contractWith({ identity: { strikePrice: 655 }, location: { strikeMapKey: "655.0" } });
      const b = contractWith({ identity: { strikePrice: 656 }, location: { strikeMapKey: "655.0" } }); // same symbol, contradictory structured strike
      expect(hasConflictingDuplicateIdentity([a, b], a)).toBe(true);
      expect(evaluateOptionIdentity({ ...base(), contract: a, siblingContracts: [a, b] }).status).not.toBe("PASS");
    });

    it("flags ambiguous when two records share the exact same provider symbol but disagree on structured expirationDate", () => {
      const a = contractWith({});
      const b = contractWith({ identity: { expirationDate: new Date("2026-11-20T20:00:00.000Z") } }); // same symbol, different structured expiration
      expect(hasConflictingDuplicateIdentity([a, b], a)).toBe(true);
    });

    it("flags ambiguous when two records share the exact same provider symbol but were found at a different map location (originating map side)", () => {
      const a = contractWith({});
      const b = contractWith({ location: { originatingMap: "CALL" } }); // same symbol, different location
      expect(hasConflictingDuplicateIdentity([a, b], a)).toBe(true);
    });

    it("flags ambiguous when two records share the exact same provider symbol but disagree on quote values", () => {
      const a = contractWith({ quote: { bid: 1.2, ask: 1.3 } });
      const b = contractWith({ quote: { bid: 1.5, ask: 1.6 } });
      expect(hasConflictingDuplicateIdentity([a, b], a)).toBe(true);
    });

    it("exact duplicate (same symbol, fully identical evidence) remains harmless", () => {
      const a = contractWith({});
      const b = contractWith({});
      expect(hasConflictingDuplicateIdentity([a, b], a)).toBe(false);
    });
  });

  it("does NOT flag duplicates for two genuinely different contracts (different strikes)", () => {
    const a = contractWith({});
    const b = contractWith({ identity: { providerSymbol: "SPY   261016P00660000", strikePrice: 660 }, location: { strikeMapKey: "660.0" } });
    expect(hasConflictingDuplicateIdentity([a, b], a)).toBe(false);
    expect(evaluateOptionIdentity({ ...base(), contract: a, siblingContracts: [a, b] }).status).toBe("PASS");
  });
});

// =================================================================================================
// QUOTE (bid/ask)
// =================================================================================================

describe("evaluateBidAsk", () => {
  it("PASSes a sane positive bid/ask", () => {
    expect(evaluateBidAsk(contractWith({ quote: { bid: 1.2, ask: 1.3 } })).status).toBe("PASS");
  });

  it("is UNKNOWN when bid or ask is missing", () => {
    expect(evaluateBidAsk(contractWith({ quote: { bid: null } })).reasonCode).toBe("QUOTE_MISSING");
    expect(evaluateBidAsk(contractWith({ quote: { ask: null } })).reasonCode).toBe("QUOTE_MISSING");
  });

  it("fails a zero bid - never eligible", () => {
    const result = evaluateBidAsk(contractWith({ quote: { bid: 0 } }));
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("ZERO_BID");
  });

  it("fails a negative bid", () => {
    expect(evaluateBidAsk(contractWith({ quote: { bid: -0.5 } })).reasonCode).toBe("NEGATIVE_BID");
  });

  it("fails a crossed quote (ask < bid)", () => {
    const result = evaluateBidAsk(contractWith({ quote: { bid: 1.5, ask: 1.0 } }));
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("CROSSED_QUOTE");
  });

  it("accepts ask === bid (not crossed)", () => {
    expect(evaluateBidAsk(contractWith({ quote: { bid: 1.0, ask: 1.0 } })).status).toBe("PASS");
  });

  it("fails NaN/non-finite bid or ask", () => {
    expect(evaluateBidAsk(contractWith({ quote: { bid: NaN } })).reasonCode).toBe("QUOTE_NONFINITE");
    expect(evaluateBidAsk(contractWith({ quote: { ask: Infinity } })).reasonCode).toBe("QUOTE_NONFINITE");
  });
});

// =================================================================================================
// QUOTE TIMESTAMP / FRESHNESS
// =================================================================================================

describe("evaluateQuoteFreshness", () => {
  const transport = { requestStartedAt: REQUEST_STARTED_AT, responseReceivedAt: RESPONSE_RECEIVED_AT };

  it("is UNKNOWN when quoteTimeInLong is missing", () => {
    const result = evaluateQuoteFreshness({ quoteTimeInLong: null, ...transport, evaluationNow: EVALUATION_NOW });
    expect(result.status).toBe("UNKNOWN");
    expect(result.reasonCode).toBe("QUOTE_TIMESTAMP_MISSING");
  });

  it("fails a zero timestamp (not a positive integer)", () => {
    const result = evaluateQuoteFreshness({ quoteTimeInLong: 0, ...transport, evaluationNow: EVALUATION_NOW });
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("QUOTE_TIMESTAMP_INVALID");
  });

  it("fails a non-integer timestamp", () => {
    const result = evaluateQuoteFreshness({ quoteTimeInLong: RESPONSE_RECEIVED_AT.getTime() - 0.5, ...transport, evaluationNow: EVALUATION_NOW });
    expect(result.reasonCode).toBe("QUOTE_TIMESTAMP_INVALID");
  });

  it("rejects the exact Codex-reproduced 1e20 timestamp (an astronomically large but finite integer that produces an Invalid Date) rather than PASSing with ageMs: NaN", () => {
    const result = evaluateQuoteFreshness({ quoteTimeInLong: 1e20, ...transport, evaluationNow: EVALUATION_NOW });
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("QUOTE_TIMESTAMP_INVALID");
    expect(result.ageMs).toBeNull();
  });

  it("rejects NaN and Infinity quoteTimeInLong", () => {
    expect(evaluateQuoteFreshness({ quoteTimeInLong: NaN, ...transport, evaluationNow: EVALUATION_NOW }).status).toBe("FAIL");
    expect(evaluateQuoteFreshness({ quoteTimeInLong: Infinity, ...transport, evaluationNow: EVALUATION_NOW }).status).toBe("FAIL");
  });

  it("rejects (never clamps) a quote timestamp after responseReceivedAt", () => {
    const future = RESPONSE_RECEIVED_AT.getTime() + 1000;
    const result = evaluateQuoteFreshness({ quoteTimeInLong: future, ...transport, evaluationNow: EVALUATION_NOW });
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("QUOTE_TIMESTAMP_FUTURE");
  });

  it("treats a far-future timestamp (seconds mistaken as milliseconds, inverted) honestly - rejected as future, not silently accepted", () => {
    const result = evaluateQuoteFreshness({ quoteTimeInLong: RESPONSE_RECEIVED_AT.getTime() * 1000, ...transport, evaluationNow: EVALUATION_NOW });
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("QUOTE_TIMESTAMP_FUTURE");
  });

  it("treats a seconds-mistaken-for-milliseconds timestamp as stale (resolves to 1970, never a special-cased unit correction)", () => {
    const secondsEpoch = Math.floor(QUOTE_TIME.getTime() / 1000); // a real Unix-SECONDS value
    const result = evaluateQuoteFreshness({ quoteTimeInLong: secondsEpoch, ...transport, evaluationNow: EVALUATION_NOW });
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("QUOTE_STALE");
  });

  it("allows a quote timestamp that precedes requestStartedAt", () => {
    const beforeRequest = REQUEST_STARTED_AT.getTime() - 5000;
    const evaluationNow = new Date(RESPONSE_RECEIVED_AT.getTime() + 50); // after response, quote age ~5050ms - within limit
    const result = evaluateQuoteFreshness({ quoteTimeInLong: beforeRequest, requestStartedAt: REQUEST_STARTED_AT, responseReceivedAt: RESPONSE_RECEIVED_AT, evaluationNow });
    expect(result.status).toBe("PASS");
  });

  it("is exactly eligible at the 60,000ms boundary", () => {
    const quoteTimeInLong = EVALUATION_NOW.getTime() - STRICT_QUOTE_MAX_AGE_MS;
    const result = evaluateQuoteFreshness({ quoteTimeInLong, requestStartedAt: new Date(quoteTimeInLong), responseReceivedAt: new Date(quoteTimeInLong), evaluationNow: EVALUATION_NOW });
    expect(result.status).toBe("PASS");
    expect(result.ageMs).toBe(STRICT_QUOTE_MAX_AGE_MS);
  });

  it("is stale at 60,001ms", () => {
    const quoteTimeInLong = EVALUATION_NOW.getTime() - (STRICT_QUOTE_MAX_AGE_MS + 1);
    const result = evaluateQuoteFreshness({ quoteTimeInLong, requestStartedAt: new Date(quoteTimeInLong), responseReceivedAt: new Date(quoteTimeInLong), evaluationNow: EVALUATION_NOW });
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("QUOTE_STALE");
  });

  it("fails on out-of-order transport timestamps", () => {
    const result = evaluateQuoteFreshness({
      quoteTimeInLong: QUOTE_TIME.getTime(),
      requestStartedAt: RESPONSE_RECEIVED_AT,
      responseReceivedAt: REQUEST_STARTED_AT, // reversed
      evaluationNow: EVALUATION_NOW,
    });
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("TRANSPORT_TIMESTAMPS_INVALID");
  });

  it("fails on an invalid transport timestamp (Invalid Date)", () => {
    const result = evaluateQuoteFreshness({ quoteTimeInLong: QUOTE_TIME.getTime(), requestStartedAt: new Date(NaN), responseReceivedAt: RESPONSE_RECEIVED_AT, evaluationNow: EVALUATION_NOW });
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("TRANSPORT_TIMESTAMPS_INVALID");
  });
});

// =================================================================================================
// CHAIN DELAY
// =================================================================================================

describe("evaluateChainDelay", () => {
  it("PASSes only for actual boolean false", () => {
    expect(evaluateChainDelay(false).status).toBe("PASS");
  });
  it("fails for actual boolean true", () => {
    expect(evaluateChainDelay(true).status).toBe("FAIL");
    expect(evaluateChainDelay(true).reasonCode).toBe("CHAIN_DELAYED");
  });
  it("is UNKNOWN (never PASS) for null (covers missing and non-boolean per the normalizer's own contract)", () => {
    const result = evaluateChainDelay(null);
    expect(result.status).toBe("UNKNOWN");
    expect(result.reasonCode).toBe("CHAIN_DELAY_UNKNOWN");
  });
});

// =================================================================================================
// CHAIN ENVELOPE STATUS
// =================================================================================================

describe("evaluateChainEnvelopeStatus", () => {
  it("PASSes for SUCCESS", () => {
    const result = evaluateChainEnvelopeStatus("SUCCESS");
    expect(result.status).toBe("PASS");
    expect(result.reasonCode).toBe("CHAIN_ENVELOPE_SUCCESS");
  });

  it("is UNKNOWN for missing status", () => {
    const result = evaluateChainEnvelopeStatus(null);
    expect(result.status).toBe("UNKNOWN");
    expect(result.reasonCode).toBe("CHAIN_ENVELOPE_UNKNOWN");
  });

  it("fails closed for a non-success actual status (e.g. ERROR)", () => {
    const result = evaluateChainEnvelopeStatus("ERROR");
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("CHAIN_ENVELOPE_FAILED");
  });
});

// =================================================================================================
// SESSION ELIGIBILITY
// =================================================================================================

describe("evaluateSessionEligibility", () => {
  const params = (overrides: Partial<Parameters<typeof evaluateSessionEligibility>[0]> = {}) => ({
    sessionEvidence: BASE_SESSION,
    quoteTime: QUOTE_TIME,
    underlyingTradeTime: QUOTE_TIME,
    evaluationNow: EVALUATION_NOW,
    ...overrides,
  });

  it("PASSes during a normal open session with both timestamps inside it", () => {
    expect(evaluateSessionEligibility(params()).status).toBe("PASS");
  });

  it("fails before the session opens", () => {
    const beforeOpen = new Date("2026-10-01T13:00:00.000Z"); // 9:00 ET
    expect(evaluateSessionEligibility(params({ evaluationNow: beforeOpen })).status).toBe("FAIL");
  });

  it("PASSes exactly at session open (inclusive)", () => {
    const openInstant = new Date("2026-10-01T13:30:00.000Z"); // 9:30 ET
    expect(evaluateSessionEligibility(params({ evaluationNow: openInstant, quoteTime: openInstant, underlyingTradeTime: openInstant })).status).toBe("PASS");
  });

  it("fails exactly at session close (exclusive)", () => {
    const closeInstant = new Date("2026-10-01T20:00:00.000Z"); // 16:00 ET
    expect(evaluateSessionEligibility(params({ evaluationNow: closeInstant })).status).toBe("FAIL");
  });

  it("fails after close", () => {
    const afterClose = new Date("2026-10-01T21:00:00.000Z");
    expect(evaluateSessionEligibility(params({ evaluationNow: afterClose })).status).toBe("FAIL");
  });

  it("is a FAIL (genuinely closed, AVAILABLE evidence) on a holiday with no intervals - not UNKNOWN", () => {
    const holiday = sessionEvidenceFor("2026-12-25", { isOpen: false, regularMarketIntervals: [] });
    expect(evaluateSessionEligibility(params({ sessionEvidence: holiday })).status).toBe("FAIL");
  });

  it("is UNKNOWN when session evidence itself is unavailable", () => {
    const unavailable: EquityMarketSessionEvidence = { status: "UNAVAILABLE", reason: "test" };
    const result = evaluateSessionEligibility(params({ sessionEvidence: unavailable }));
    expect(result.status).toBe("UNKNOWN");
    expect(result.reasonCode).toBe("SESSION_UNKNOWN");
  });

  it("handles an early close - ineligible after the shortened session ends even though it would be open on a normal day", () => {
    const earlyClose = sessionEvidenceFor("2026-10-01", { regularMarketIntervals: [{ start: new Date("2026-10-01T09:30:00-04:00"), end: new Date("2026-10-01T13:00:00-04:00") }] });
    const afterEarlyClose = new Date("2026-10-01T17:30:00.000Z"); // 13:30 ET - after the 13:00 ET early close
    expect(evaluateSessionEligibility(params({ sessionEvidence: earlyClose, evaluationNow: afterEarlyClose })).status).toBe("FAIL");
  });

  it("is UNKNOWN when quote time or underlying trade time is missing, even though evaluationNow is inside the session", () => {
    expect(evaluateSessionEligibility(params({ quoteTime: null })).status).toBe("UNKNOWN");
    expect(evaluateSessionEligibility(params({ underlyingTradeTime: null })).status).toBe("UNKNOWN");
  });

  it("fails when the quote time is inside session but from a DIFFERENT session's interval (NY date rollover guard)", () => {
    const priorDayQuoteTime = new Date("2026-09-30T18:00:00.000Z"); // a real instant, but not within 2026-10-01's own interval
    expect(evaluateSessionEligibility(params({ quoteTime: priorDayQuoteTime })).status).toBe("FAIL");
  });
});

// =================================================================================================
// STANDARD CONTRACT TERMS
// =================================================================================================

describe("evaluateStandardContractTerms", () => {
  const params = (termsOverride: Partial<StrictOptionContractSnapshot["terms"]> = {}) => ({
    terms: contractWith({ terms: termsOverride }).terms,
    supportedUnderlying: "SPY",
  });

  it("PASSes the exact supported standard shape", () => {
    expect(evaluateStandardContractTerms(params()).status).toBe("PASS");
    expect(evaluateStandardContractTerms(params()).reasonCode).toBe("CONTRACT_STANDARD");
  });

  it("is UNKNOWN when multiplier is missing", () => {
    const result = evaluateStandardContractTerms(params({ multiplier: null }));
    expect(result.status).toBe("UNKNOWN");
    expect(result.reasonCode).toBe("CONTRACT_TERMS_UNKNOWN");
  });

  it("is UNSUPPORTED when multiplier != 100", () => {
    expect(evaluateStandardContractTerms(params({ multiplier: 10 })).reasonCode).toBe("CONTRACT_UNSUPPORTED");
  });

  it("is UNKNOWN when the deliverables list is missing entirely", () => {
    expect(evaluateStandardContractTerms(params({ optionDeliverablesList: null })).reasonCode).toBe("CONTRACT_TERMS_UNKNOWN");
  });

  it("is UNSUPPORTED when there are multiple deliverables", () => {
    const result = evaluateStandardContractTerms(
      params({ optionDeliverablesList: [{ symbol: "SPY", assetType: "STOCK", deliverableUnits: 100, currencyType: "USD" }, { symbol: "SPY", assetType: "STOCK", deliverableUnits: 100, currencyType: "USD" }] }),
    );
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("CONTRACT_UNSUPPORTED");
  });

  it("is UNSUPPORTED for a non-STOCK deliverable (e.g. cash-settled)", () => {
    const result = evaluateStandardContractTerms(params({ optionDeliverablesList: [{ symbol: "SPY", assetType: "CASH", deliverableUnits: 100, currencyType: "USD" }] }));
    expect(result.reasonCode).toBe("CONTRACT_UNSUPPORTED");
  });

  it("is UNSUPPORTED when the deliverable symbol does not match the supported underlying", () => {
    const result = evaluateStandardContractTerms(params({ optionDeliverablesList: [{ symbol: "QQQ", assetType: "STOCK", deliverableUnits: 100, currencyType: "USD" }] }));
    expect(result.reasonCode).toBe("CONTRACT_UNSUPPORTED");
  });

  it("is UNSUPPORTED when deliverableUnits != 100 (an adjusted contract)", () => {
    const result = evaluateStandardContractTerms(params({ optionDeliverablesList: [{ symbol: "SPY", assetType: "STOCK", deliverableUnits: 65, currencyType: "USD" }] }));
    expect(result.reasonCode).toBe("CONTRACT_UNSUPPORTED");
  });

  it("is UNSUPPORTED when explicitly nonStandard", () => {
    expect(evaluateStandardContractTerms(params({ nonStandard: true })).reasonCode).toBe("CONTRACT_UNSUPPORTED");
  });

  it("is UNSUPPORTED when explicitly mini", () => {
    expect(evaluateStandardContractTerms(params({ mini: true })).reasonCode).toBe("CONTRACT_UNSUPPORTED");
  });

  it("is UNSUPPORTED when contradictory metadata is present (mini AND nonStandard both true, still just UNSUPPORTED, never a crash)", () => {
    const result = evaluateStandardContractTerms(params({ mini: true, nonStandard: true }));
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("CONTRACT_UNSUPPORTED");
  });

  it("never infers 100 when deliverableUnits is absent on an otherwise-present deliverable entry", () => {
    const result = evaluateStandardContractTerms(params({ optionDeliverablesList: [{ symbol: "SPY", assetType: "STOCK", deliverableUnits: null, currencyType: "USD" }] }));
    expect(result.status).toBe("UNKNOWN");
    expect(result.reasonCode).toBe("CONTRACT_TERMS_UNKNOWN");
  });

  it("is UNSUPPORTED (Codex reproduction) when settlementType=\"C\" and deliverableNote=\"CASH ONLY\" contradict an otherwise-standard-looking shape", () => {
    const result = evaluateStandardContractTerms(params({ settlementType: "C", deliverableNote: "CASH ONLY" }));
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("CONTRACT_UNSUPPORTED");
  });

  it("is UNSUPPORTED for a non-physical settlementType alone", () => {
    expect(evaluateStandardContractTerms(params({ settlementType: "C" })).reasonCode).toBe("CONTRACT_UNSUPPORTED");
  });

  it("is UNKNOWN (never assumed standard) when settlementType is missing - it is a REQUIRED field, unlike deliverable currencyType", () => {
    const result = evaluateStandardContractTerms(params({ settlementType: null }));
    expect(result.status).toBe("UNKNOWN");
    expect(result.reasonCode).toBe("CONTRACT_TERMS_UNKNOWN");
  });

  it("is UNSUPPORTED for a deliverableNote contradicting physical delivery alone", () => {
    expect(evaluateStandardContractTerms(params({ deliverableNote: "CASH SETTLEMENT ONLY" })).reasonCode).toBe("CONTRACT_UNSUPPORTED");
  });

  it("is UNSUPPORTED for an unsupported deliverable currencyType (foreign-currency deliverable)", () => {
    const result = evaluateStandardContractTerms(params({ optionDeliverablesList: [{ symbol: "SPY", assetType: "STOCK", deliverableUnits: 100, currencyType: "EUR" }] }));
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("CONTRACT_UNSUPPORTED");
  });

  it("still PASSes with the supported physical settlementType \"P\" and a null (absent) deliverableNote/currencyType - the real live-derived capture's own shape", () => {
    const result = evaluateStandardContractTerms(params({ settlementType: "P", deliverableNote: null, optionDeliverablesList: [{ symbol: "SPY", assetType: "STOCK", deliverableUnits: 100, currencyType: null }] }));
    expect(result.status).toBe("PASS");
  });

  it("also PASSes when currencyType is explicitly present and USD", () => {
    const result = evaluateStandardContractTerms(params({ optionDeliverablesList: [{ symbol: "SPY", assetType: "STOCK", deliverableUnits: 100, currencyType: "USD" }] }));
    expect(result.status).toBe("PASS");
  });
});

// =================================================================================================
// UNDERLYING / OPTION ALIGNMENT
// =================================================================================================

describe("evaluateUnderlyingOptionAlignment", () => {
  const params = (overrides: Partial<Parameters<typeof evaluateUnderlyingOptionAlignment>[0]> = {}) => ({
    sessionEvidence: BASE_SESSION,
    underlyingTradeTime: QUOTE_TIME,
    quoteTime: QUOTE_TIME,
    evaluationNow: EVALUATION_NOW,
    ...overrides,
  });

  it("PASSes with equal timestamps (zero separation)", () => {
    const result = evaluateUnderlyingOptionAlignment(params());
    expect(result.status).toBe("PASS");
    expect(result.separationMs).toBe(0);
  });

  it("PASSes at exactly 60 seconds of separation", () => {
    // Option quote is exactly "now" (age 0); underlying is exactly 60s older (age exactly at the
    // limit too) - the largest possible separation while BOTH individual ages stay within bound.
    const quoteTime = EVALUATION_NOW;
    const underlyingTradeTime = new Date(EVALUATION_NOW.getTime() - STRICT_QUOTE_MAX_AGE_MS);
    const result = evaluateUnderlyingOptionAlignment(params({ quoteTime, underlyingTradeTime }));
    expect(result.status).toBe("PASS");
    expect(result.separationMs).toBe(STRICT_QUOTE_MAX_AGE_MS);
  });

  it("fails when separation exceeds 60,001ms (by construction this also always exceeds at least one side's own individual 60s freshness bound, since separation can never exceed the larger of the two ages)", () => {
    const quoteTime = EVALUATION_NOW; // age 0
    const underlyingTradeTime = new Date(EVALUATION_NOW.getTime() - (STRICT_QUOTE_MAX_AGE_MS + 1)); // age 60,001 - separation 60,001 too
    const result = evaluateUnderlyingOptionAlignment(params({ quoteTime, underlyingTradeTime }));
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("ALIGNMENT_STALE_UNDERLYING");
  });

  it("fails when the underlying is individually stale (even if separation from option is small)", () => {
    const staleInstant = new Date(EVALUATION_NOW.getTime() - (STRICT_QUOTE_MAX_AGE_MS + 1));
    const result = evaluateUnderlyingOptionAlignment(params({ underlyingTradeTime: staleInstant, quoteTime: staleInstant }));
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("ALIGNMENT_STALE_UNDERLYING");
  });

  it("fails when the option quote is individually stale", () => {
    const freshUnderlying = new Date(EVALUATION_NOW.getTime() - 10);
    const staleOption = new Date(EVALUATION_NOW.getTime() - (STRICT_QUOTE_MAX_AGE_MS + 1));
    const result = evaluateUnderlyingOptionAlignment(params({ underlyingTradeTime: freshUnderlying, quoteTime: staleOption }));
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("ALIGNMENT_STALE_OPTION");
  });

  it("fails (never passes on proximity alone) when either timestamp is in the future relative to the evaluation clock", () => {
    const future = new Date(EVALUATION_NOW.getTime() + 1000);
    expect(evaluateUnderlyingOptionAlignment(params({ underlyingTradeTime: future, quoteTime: future })).status).toBe("FAIL");
    expect(evaluateUnderlyingOptionAlignment(params({ underlyingTradeTime: future })).reasonCode).toBe("ALIGNMENT_STALE_UNDERLYING");
    expect(evaluateUnderlyingOptionAlignment(params({ quoteTime: future })).reasonCode).toBe("ALIGNMENT_STALE_OPTION");
  });

  it("is UNKNOWN when either timestamp is missing", () => {
    expect(evaluateUnderlyingOptionAlignment(params({ underlyingTradeTime: null })).status).toBe("UNKNOWN");
    expect(evaluateUnderlyingOptionAlignment(params({ quoteTime: null })).status).toBe("UNKNOWN");
  });

  it("is UNKNOWN (never PASS merely because two stale-relative-to-session observations are close to each other) when session evidence is unavailable", () => {
    const unavailable: EquityMarketSessionEvidence = { status: "UNAVAILABLE", reason: "test" };
    const result = evaluateUnderlyingOptionAlignment(params({ sessionEvidence: unavailable }));
    expect(result.status).toBe("UNKNOWN");
    expect(result.reasonCode).toBe("ALIGNMENT_UNKNOWN");
  });

  it("fails when quote time and underlying trade time fall in different regular-session intervals, even though both are individually fresh and close together", () => {
    // Two intervals within the same session evidence (e.g. a mid-day halt/resumption), with only a
    // 30-second gap between them - small enough that staleness/separation alone would not catch it.
    const twoIntervalSession: EquityMarketSessionEvidence = {
      status: "AVAILABLE",
      requestedDate: "2026-10-01",
      returnedDate: "2026-10-01",
      marketType: "EQUITY",
      product: "EQ",
      isOpen: true,
      regularMarketIntervals: [
        { start: new Date("2026-10-01T13:30:00.000Z"), end: new Date("2026-10-01T14:00:00.000Z") },
        { start: new Date("2026-10-01T14:00:30.000Z"), end: new Date("2026-10-01T20:00:00.000Z") },
      ],
    };
    const quoteTime = new Date("2026-10-01T13:59:59.990Z"); // inside interval A
    const underlyingTradeTime = new Date("2026-10-01T14:00:30.010Z"); // inside interval B
    const evaluationNow = new Date(underlyingTradeTime.getTime() + 10);

    const result = evaluateUnderlyingOptionAlignment({ sessionEvidence: twoIntervalSession, quoteTime, underlyingTradeTime, evaluationNow });
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("ALIGNMENT_MISALIGNED");
  });
});

// =================================================================================================
// UNDERLYING / OPTION CROSS-DOMAIN SYMBOL BINDING
// =================================================================================================

describe("evaluateUnderlyingBinding (Codex final review - cross-domain symbol binding)", () => {
  it("PASSes when the underlying evidence's requested/returned symbol both match the option's requested underlying", () => {
    const result = evaluateUnderlyingBinding({ requestedUnderlying: "SPY", underlyingEvidence: underlyingEvidenceAt(QUOTE_TIME) }); // SPY/SPY
    expect(result.status).toBe("PASS");
    expect(result.reasonCode).toBe("UNDERLYING_BOUND");
  });

  it("fails (never PASS) when the underlying evidence is for an entirely different ticker (QQQ/QQQ) than the SPY option", () => {
    const result = evaluateUnderlyingBinding({
      requestedUnderlying: "SPY",
      underlyingEvidence: underlyingEvidenceAt(QUOTE_TIME, { requestedSymbol: "QQQ", returnedSymbol: "QQQ" }),
    });
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("UNDERLYING_UNBOUND");
  });

  it("fails when requestedSymbol and returnedSymbol disagree with each other (SPY/QQQ) even if one matches the option", () => {
    const result = evaluateUnderlyingBinding({
      requestedUnderlying: "SPY",
      underlyingEvidence: underlyingEvidenceAt(QUOTE_TIME, { requestedSymbol: "SPY", returnedSymbol: "QQQ" }),
    });
    expect(result.status).toBe("FAIL");
    expect(result.reasonCode).toBe("UNDERLYING_UNBOUND");
  });

  it("is UNKNOWN when underlying symbol evidence is unavailable", () => {
    const result = evaluateUnderlyingBinding({ requestedUnderlying: "SPY", underlyingEvidence: { status: "UNAVAILABLE", reason: "test" } });
    expect(result.status).toBe("UNKNOWN");
    expect(result.reasonCode).toBe("UNDERLYING_BINDING_UNKNOWN");
  });
});

// =================================================================================================
// OI / VOLUME / DELTA
// =================================================================================================

describe("OI / volume / delta safe semantics", () => {
  it("openInterest: KNOWN for a finite nonnegative integer, UNKNOWN otherwise", () => {
    expect(evaluateOpenInterest(312)).toEqual({ status: "KNOWN", value: 312 });
    expect(evaluateOpenInterest(0)).toEqual({ status: "KNOWN", value: 0 });
    expect(evaluateOpenInterest(null)).toEqual({ status: "UNKNOWN" });
    expect(evaluateOpenInterest(-1)).toEqual({ status: "UNKNOWN" });
    expect(evaluateOpenInterest(1.5)).toEqual({ status: "UNKNOWN" });
  });

  it("totalVolume: KNOWN for a finite nonnegative integer, UNKNOWN otherwise", () => {
    expect(evaluateTotalVolume(0)).toEqual({ status: "KNOWN", value: 0 });
    expect(evaluateTotalVolume(null)).toEqual({ status: "UNKNOWN" });
    expect(evaluateTotalVolume(NaN)).toEqual({ status: "UNKNOWN" });
  });

  it("a fractional openInterest (2.9) is UNKNOWN, never truncated to 2", () => {
    expect(evaluateOpenInterest(2.9)).toEqual({ status: "UNKNOWN" });
  });

  it("a fractional totalVolume (2.9) is UNKNOWN, never truncated to 2", () => {
    expect(evaluateTotalVolume(2.9)).toEqual({ status: "UNKNOWN" });
  });

  it("putDelta: reports the absolute value (Scanner convention), UNKNOWN when missing/non-finite", () => {
    expect(evaluatePutDelta(-0.22)).toEqual({ status: "KNOWN", value: 0.22 });
    expect(evaluatePutDelta(null)).toEqual({ status: "UNKNOWN" });
    expect(evaluatePutDelta(NaN)).toEqual({ status: "UNKNOWN" });
  });

  it("putDelta: rejects an impossible magnitude (|delta| > 1)", () => {
    expect(evaluatePutDelta(-1.5)).toEqual({ status: "UNKNOWN" });
    expect(evaluatePutDelta(1.0000001)).toEqual({ status: "UNKNOWN" });
    expect(evaluatePutDelta(-1)).toEqual({ status: "KNOWN", value: 1 }); // exactly 1 is the valid boundary
  });
});

// =================================================================================================
// ECONOMICS
// =================================================================================================

describe("computeStrictOptionEconomics", () => {
  const valid = () => ({ identityStatus: "PASS" as const, quoteStatus: "PASS" as const, standardTermsStatus: "PASS" as const, bid: 1.2, strike: 655, quantity: 1 });

  it("computes gross bid-based economics when identity/quote/terms all PASS", () => {
    const result = computeStrictOptionEconomics(valid());
    expect(result).toEqual({ basis: "GROSS_BID_BEFORE_FEES", grossBidProceeds: 120, grossSecuredCapital: 65500, grossBidReturnOnSecuredCapitalPercent: expect.any(Number) });
  });

  it("is null when identity did not PASS, even with otherwise-valid numbers", () => {
    expect(computeStrictOptionEconomics({ ...valid(), identityStatus: "UNKNOWN" })).toBeNull();
    expect(computeStrictOptionEconomics({ ...valid(), identityStatus: "FAIL" })).toBeNull();
  });

  it("is null when quote did not PASS", () => {
    expect(computeStrictOptionEconomics({ ...valid(), quoteStatus: "FAIL" })).toBeNull();
  });

  it("is null when standard terms did not PASS", () => {
    expect(computeStrictOptionEconomics({ ...valid(), standardTermsStatus: "UNKNOWN" })).toBeNull();
    expect(computeStrictOptionEconomics({ ...valid(), standardTermsStatus: "FAIL" })).toBeNull();
  });

  it("is null for quantity 0", () => {
    expect(computeStrictOptionEconomics({ ...valid(), quantity: 0 })).toBeNull();
  });

  it("is null for a negative quantity", () => {
    expect(computeStrictOptionEconomics({ ...valid(), quantity: -1 })).toBeNull();
  });

  it("is null for a fractional quantity", () => {
    expect(computeStrictOptionEconomics({ ...valid(), quantity: 1.5 })).toBeNull();
  });

  it("is null for zero or negative bid", () => {
    expect(computeStrictOptionEconomics({ ...valid(), bid: 0 })).toBeNull();
    expect(computeStrictOptionEconomics({ ...valid(), bid: -1 })).toBeNull();
  });

  it("is null for a non-finite bid", () => {
    expect(computeStrictOptionEconomics({ ...valid(), bid: NaN })).toBeNull();
  });

  it("is null for an invalid strike (null, zero, negative, non-finite)", () => {
    expect(computeStrictOptionEconomics({ ...valid(), strike: null })).toBeNull();
    expect(computeStrictOptionEconomics({ ...valid(), strike: 0 })).toBeNull();
    expect(computeStrictOptionEconomics({ ...valid(), strike: -1 })).toBeNull();
    expect(computeStrictOptionEconomics({ ...valid(), strike: Infinity })).toBeNull();
  });
});

// =================================================================================================
// COMPOSABLE EVALUATION
// =================================================================================================

describe("evaluateStrictOptionEvidence (composable bundle)", () => {
  const baseParams = () => ({
    requestedUnderlying: "SPY",
    envelope: BASE_ENVELOPE,
    contract: baseContract(),
    siblingContracts: [baseContract()],
    requestStartedAt: REQUEST_STARTED_AT,
    responseReceivedAt: RESPONSE_RECEIVED_AT,
    sessionEvidence: BASE_SESSION,
    underlyingEvidence: underlyingEvidenceAt(QUOTE_TIME),
    evaluationNow: EVALUATION_NOW,
    quantity: 1,
  });

  it("produces a fully-passing bundle with computed economics for an all-valid standard contract and a valid underlying", () => {
    const result = evaluateStrictOptionEvidence(baseParams());
    expect(result.envelopeStatus.status).toBe("PASS");
    expect(result.identity.status).toBe("PASS");
    expect(result.quote.status).toBe("PASS");
    expect(result.quoteTimestamp.status).toBe("PASS");
    expect(result.chainDelay.status).toBe("PASS");
    expect(result.underlyingEligibility.eligible).toBe(true);
    expect(result.session.status).toBe("PASS");
    expect(result.contractTerms.status).toBe("PASS");
    expect(result.alignment.status).toBe("PASS");
    expect(result.economics).not.toBeNull();
  });

  it("the chain envelope gate fails closed for a non-SUCCESS status - never authorizing strict evidence from an unsuccessful response", () => {
    const result = evaluateStrictOptionEvidence({ ...baseParams(), envelope: { ...BASE_ENVELOPE, status: "ERROR" } });
    expect(result.envelopeStatus.status).toBe("FAIL");
  });

  it("the chain envelope gate is UNKNOWN for a missing status", () => {
    const result = evaluateStrictOptionEvidence({ ...baseParams(), envelope: { ...BASE_ENVELOPE, status: null as unknown as string } });
    expect(result.envelopeStatus.status).toBe("UNKNOWN");
  });

  it("has no economics when the quote is a zero bid (the observed live-capture shape)", () => {
    const result = evaluateStrictOptionEvidence({ ...baseParams(), contract: contractWith({ quote: { bid: 0 } }) });
    expect(result.quote.status).toBe("FAIL");
    expect(result.economics).toBeNull();
  });

  it("has no economics when contract terms are unsupported (adjusted contract)", () => {
    const result = evaluateStrictOptionEvidence({ ...baseParams(), contract: contractWith({ terms: { multiplier: 65 } }) });
    expect(result.contractTerms.status).toBe("FAIL");
    expect(result.economics).toBeNull();
  });

  it("independent gates can each independently fail without crashing the overall bundle", () => {
    const result = evaluateStrictOptionEvidence({ ...baseParams(), envelope: { ...BASE_ENVELOPE, isDelayed: true } });
    expect(result.chainDelay.status).toBe("FAIL");
    expect(result.identity.status).toBe("PASS"); // unaffected by the unrelated chain-delay failure
  });

  describe("strict underlying eligibility gates session/alignment - a bundle can never show all-PASS from a failed/unavailable underlying (Codex reproduction)", () => {
    it("an internally-inconsistent underlying symbol (requestedSymbol != returnedSymbol) blocks session/alignment from PASSing", () => {
      const result = evaluateStrictOptionEvidence({ ...baseParams(), underlyingEvidence: underlyingEvidenceAt(QUOTE_TIME, { returnedSymbol: "QQQ" }) });
      expect(result.underlyingEligibility.eligible).toBe(false);
      expect(result.session.status).not.toBe("PASS");
      expect(result.alignment.status).not.toBe("PASS");
    });

    it("Codex final-review reproduction: underlying evidence that is INTERNALLY valid but for a completely different ticker (QQQ/QQQ) must NOT let a SPY option bundle all-pass", () => {
      const result = evaluateStrictOptionEvidence({ ...baseParams(), underlyingEvidence: underlyingEvidenceAt(QUOTE_TIME, { requestedSymbol: "QQQ", returnedSymbol: "QQQ" }) });
      expect(result.underlyingEligibility.eligible).toBe(true); // internally valid in isolation - requestedSymbol === returnedSymbol
      expect(result.underlyingBinding.status).toBe("FAIL"); // but NOT bound to this SPY option
      expect(result.underlyingBinding.reasonCode).toBe("UNDERLYING_UNBOUND");
      expect(result.session.status).not.toBe("PASS");
      expect(result.alignment.status).not.toBe("PASS");
    });

    it("non-realtime underlying evidence blocks session/alignment from PASSing", () => {
      const result = evaluateStrictOptionEvidence({ ...baseParams(), underlyingEvidence: underlyingEvidenceAt(QUOTE_TIME, { realtime: false }) });
      expect(result.underlyingEligibility.eligible).toBe(false);
      expect(result.session.status).not.toBe("PASS");
      expect(result.alignment.status).not.toBe("PASS");
    });

    it("an unsupported underlying asset type (e.g. BOND) blocks session/alignment from PASSing", () => {
      const result = evaluateStrictOptionEvidence({ ...baseParams(), underlyingEvidence: underlyingEvidenceAt(QUOTE_TIME, { assetMainType: "BOND" }) });
      expect(result.underlyingEligibility.eligible).toBe(false);
      expect(result.session.status).not.toBe("PASS");
      expect(result.alignment.status).not.toBe("PASS");
    });

    it("a nonpositive underlying price blocks session/alignment from PASSing", () => {
      const result = evaluateStrictOptionEvidence({ ...baseParams(), underlyingEvidence: underlyingEvidenceAt(QUOTE_TIME, { price: -1 }) });
      expect(result.underlyingEligibility.eligible).toBe(false);
      expect(result.session.status).not.toBe("PASS");
      expect(result.alignment.status).not.toBe("PASS");
    });

    it("a stale underlying trade time blocks session/alignment from PASSing", () => {
      const staleTradeTime = new Date(EVALUATION_NOW.getTime() - 130_000); // beyond the 120s Phase-2 freshness window
      const result = evaluateStrictOptionEvidence({ ...baseParams(), underlyingEvidence: underlyingEvidenceAt(staleTradeTime) });
      expect(result.underlyingEligibility.eligible).toBe(false);
      expect(result.session.status).not.toBe("PASS");
      expect(result.alignment.status).not.toBe("PASS");
    });

    it("an unavailable underlying evidence blocks session/alignment from PASSing", () => {
      const result = evaluateStrictOptionEvidence({ ...baseParams(), underlyingEvidence: { status: "UNAVAILABLE", reason: "test" } });
      expect(result.underlyingEligibility.eligible).toBe(false);
      expect(result.session.status).not.toBe("PASS");
      expect(result.alignment.status).not.toBe("PASS");
    });
  });
});
