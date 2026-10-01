import { describe, expect, it } from "vitest";
import { normalizeSchwabAccountNumbers } from "./broker-read";
import {
  normalizeSchwabEquityMarketSessionEvidence,
  normalizeSchwabOptionChainResponse,
  normalizeSchwabPriceHistoryResponse,
  normalizeSchwabQuoteResponse,
  normalizeSchwabQuoteReviewEvidence,
  normalizeSchwabQuotesResponse,
  normalizeSchwabStrictOptionChainSnapshot,
} from "./normalizers";
import strictOptionChainLiveDerived from "./__fixtures__/strict-option-chain-live-derived.json";
import { makeSyntheticStandardSpyChainPayload } from "./__fixtures__/synthetic-option-chain";
import { evaluateBidAsk, evaluateOptionIdentity } from "@/domain/trade-prep/optionEvidence";

const TRANSPORT = { requestStartedAt: new Date("2026-09-25T19:58:00.000Z"), responseReceivedAt: new Date("2026-09-25T19:58:00.250Z") };

/**
 * Sanitized, provider-shaped SPY quote fixture derived from the approved live-capture facts
 * (see PROJECT_HANDOFF.md / the Phase 2 ticket) - no account identity, connection suffix, tokens,
 * or database information. The after-hours regularMarketTradeTime (~20:00 ET) is deliberately
 * included: it is the exact evidence proving regular.regularMarketTradeTime must never be trusted
 * as a regular-session trade time, even when it looks coherent next to a real trade.
 */
function spyQuoteFixture(overrides: { quote?: Record<string, unknown>; record?: Record<string, unknown> } = {}) {
  return {
    SPY: {
      assetMainType: "EQUITY",
      assetSubType: "ETF",
      symbol: "SPY",
      quoteType: "NBBO",
      realtime: true,
      quote: {
        lastPrice: 668.73,
        tradeTime: Date.parse("2026-09-25T23:58:12.000Z"), // 7:58:12 PM ET - after-hours trade
        quoteTime: Date.parse("2026-09-25T23:59:00.000Z"), // deliberately different from tradeTime
        mark: 668.7,
        closePrice: 665.1,
        ...overrides.quote,
      },
      regular: {
        regularMarketLastPrice: 668.73,
        // Deliberately ~20:00 ET despite the regular session having closed at 16:00 ET - the
        // exact live-capture anomaly this evidence type must never trust.
        regularMarketTradeTime: Date.parse("2026-09-26T00:00:05.000Z"),
      },
      extended: {
        lastPrice: 668.9,
        quoteTime: Date.parse("2026-09-25T23:58:30.000Z"),
      },
      ...overrides.record,
    },
  };
}

function ordinaryDayMarketHoursFixture() {
  return {
    equity: {
      EQ: {
        date: "2026-06-15",
        marketType: "EQUITY",
        product: "EQ",
        productName: "equity",
        isOpen: true,
        sessionHours: {
          preMarket: [{ start: "2026-06-15T07:00:00-04:00", end: "2026-06-15T09:30:00-04:00" }],
          regularMarket: [{ start: "2026-06-15T09:30:00-04:00", end: "2026-06-15T16:00:00-04:00" }],
          postMarket: [{ start: "2026-06-15T16:00:00-04:00", end: "2026-06-15T20:00:00-04:00" }],
        },
      },
    },
  };
}

function earlyCloseMarketHoursFixture() {
  return {
    equity: {
      EQ: {
        date: "2026-11-27",
        marketType: "EQUITY",
        product: "EQ",
        productName: "equity",
        isOpen: true,
        sessionHours: {
          preMarket: [{ start: "2026-11-27T07:00:00-05:00", end: "2026-11-27T09:30:00-05:00" }],
          regularMarket: [{ start: "2026-11-27T09:30:00-05:00", end: "2026-11-27T13:00:00-05:00" }],
          postMarket: [{ start: "2026-11-27T13:00:00-05:00", end: "2026-11-27T17:00:00-05:00" }],
        },
      },
    },
  };
}

describe("Schwab market-data normalizers", () => {
  it("normalizes quote, history, option chain, and account hash payloads", () => {
    const quote = normalizeSchwabQuoteResponse("RIOT", {
      RIOT: {
        quote: {
          lastPrice: 12.34,
          netChange: 0.21,
          netPercentChange: 1.73,
          totalVolume: 1234567,
          quoteTimeInLong: Date.UTC(2026, 7, 31, 14, 30),
        },
      },
    });

    expect(quote).toMatchObject({
      symbol: "RIOT",
      price: 12.34,
      change: 0.21,
      changePercent: 1.73,
      volume: 1234567,
    });

    expect(
      normalizeSchwabPriceHistoryResponse("RIOT", {
        candles: [{ datetime: Date.UTC(2026, 7, 28), open: 12, high: 13, low: 11.5, close: 12.5, volume: 1000 }],
      }),
    ).toEqual([
      {
        symbol: "RIOT",
        date: new Date(Date.UTC(2026, 7, 28)),
        open: 12,
        high: 13,
        low: 11.5,
        close: 12.5,
        volume: 1000,
      },
    ]);

    expect(
      normalizeSchwabOptionChainResponse({
        symbol: "RIOT",
        putExpDateMap: {
          "2026-09-18:18": {
            "11.0": [
              {
                symbol: "RIOT  260918P00011000",
                strikePrice: 11,
                bid: 0.2,
                ask: 0.26,
                mark: 0.23,
                delta: -0.22,
                openInterest: 250,
                totalVolume: 41,
                volatility: 65.4,
              },
            ],
          },
        },
      }),
    ).toMatchObject([
      {
        symbol: "RIOT  260918P00011000",
        underlyingSymbol: "RIOT",
        optionType: "PUT",
        strike: 11,
        bid: 0.2,
        ask: 0.26,
        mark: 0.23,
        delta: -0.22,
        openInterest: 250,
        volume: 41,
        impliedVolatility: 65.4,
      },
    ]);

    expect(
      normalizeSchwabAccountNumbers([{ accountNumber: "123456789", hashValue: "hash-value" }]),
    ).toEqual([{ accountNumberLast4: "6789", hashValue: "hash-value" }]);
  });

  it("normalizes reference/fundamental fields using real verified production values (APLD, 2026-09)", () => {
    // Real values from Matt's production Schwab Trader API connection (read-only fundamentals
    // diagnostic, after-hours run) - see PROJECT_HANDOFF.md Research section. peRatio/eps are
    // genuinely negative; divAmount/divYield/divFreq are genuinely 0 - both must survive
    // normalization exactly, never becoming null (for the reals) or 0 (for a truly-absent field).
    const quote = normalizeSchwabQuoteResponse("APLD", {
      APLD: {
        reference: { description: "APPLIED DIGITAL CORP" },
        fundamental: { peRatio: -27.50359, eps: -0.9057, divAmount: 0, divYield: 0, divFreq: 0 },
        quote: { lastPrice: 10.5 },
      },
    });

    expect(quote.companyDescription).toBe("APPLIED DIGITAL CORP");
    expect(quote.fundamentals).toEqual({
      peRatio: -27.50359,
      eps: -0.9057,
      dividendAmount: 0,
      dividendYield: 0,
      dividendFrequency: 0,
    });
  });

  it("maps a genuinely absent fundamental field to null, never to 0 or undefined-as-zero", () => {
    const quote = normalizeSchwabQuoteResponse("RIOT", {
      RIOT: {
        reference: {},
        // peRatio omitted entirely (as Schwab's real response does for verified-absent fields)
        // and eps explicitly null, to cover both shapes of "no value".
        fundamental: { eps: null, divAmount: 0 },
        quote: { lastPrice: 9.1 },
      },
    });

    expect(quote.fundamentals).toEqual({
      peRatio: null,
      eps: null,
      dividendAmount: 0,
      dividendYield: null,
      dividendFrequency: null,
    });
    expect(quote.companyDescription).toBeNull();
  });

  it("leaves companyDescription/fundamentals unset when the provider supplies no reference/fundamental group at all (e.g. demo data)", () => {
    const quote = normalizeSchwabQuoteResponse("CORZ", {
      CORZ: { quote: { lastPrice: 4.2 } },
    });

    expect(quote.companyDescription).toBeNull();
    expect(quote.fundamentals).toBeNull();
  });
});

describe("normalizeSchwabStrictOptionChainSnapshot (Trade Prep strict evidence foundation)", () => {
  const REQUEST = { requestedUnderlying: "SPY", fromDate: null, toDate: null, contractType: "PUT" as const };
  const TRANSPORT_WITH_DATE = { requestStartedAt: new Date("2026-10-01T14:47:32.861Z"), responseReceivedAt: new Date("2026-10-01T14:47:33.602Z"), httpDateHeader: "Thu, 01 Oct 2026 14:47:33 GMT" };

  /**
   * strict-option-chain-live-derived.json is the ONE real sanitized observation this repo has (a
   * single approved one-call read-only diagnostic against SPY, captured 2026-10-01T14:47:33.602Z -
   * see PROJECT_HANDOFF.md). Every value asserted below is literally what that diagnostic
   * preserved - a zero-bid, same-day (0 DTE) contract. It is correct and expected for this
   * contract to FAIL strict quote eligibility (see the dedicated zero-bid test further down) -
   * that is exactly what was observed, not a test-construction mistake.
   */
  it("mechanically preserves every real observed field from the live-derived capture, including the exact padded provider symbol", () => {
    const result = normalizeSchwabStrictOptionChainSnapshot(strictOptionChainLiveDerived, REQUEST, TRANSPORT_WITH_DATE);
    expect(result.status).toBe("AVAILABLE");
    if (result.status !== "AVAILABLE") throw new Error("expected AVAILABLE");

    expect(result.envelope).toEqual({ status: "SUCCESS", rootSymbol: "SPY", isDelayed: false });
    expect(result.contracts).toHaveLength(1);
    const contract = result.contracts[0]!;

    expect(contract.identity.providerSymbol).toBe("SPY   261001P00550000"); // exact, including Schwab's own padding - never trimmed
    expect(contract.identity.putCall).toBe("PUT");
    expect(contract.identity.strikePrice).toBe(550);
    expect(contract.identity.expirationDate?.toISOString()).toBe("2026-10-01T20:00:00.000Z");
    // optionRoot is Schwab's own RAW field, read as-is - NEVER derived from the provider symbol.
    // The sanitized diagnostic confirmed the raw optionRoot key exists in rawKeys but did NOT
    // preserve its literal value, so this correctly stays null - never guessed as "SPY" just
    // because the symbol happens to parse that way under OCC convention.
    expect(contract.identity.optionRoot).toBeNull();

    expect(contract.quote).toEqual({ bid: 0, ask: 0.01, quoteTimeInLong: 1790866052584 }); // real observed zero bid
    expect(contract.terms).toEqual({
      multiplier: 100,
      nonStandard: false,
      mini: false,
      optionDeliverablesList: [{ symbol: "SPY", assetType: "STOCK", deliverableUnits: 100, currencyType: null }], // currencyType genuinely absent in the sanitized capture
      settlementType: "P",
      deliverableNote: null, // not present in the sanitized capture - never invented
    });
    expect(contract.ruleInputs).toEqual({ openInterest: 10, totalVolume: 1, delta: 0 });
    expect(contract.location).toEqual({ expirationMapKey: "2026-10-01:0", strikeMapKey: "550.0", originatingMap: "PUT" });

    expect(result.transport).toEqual({
      provider: "SCHWAB",
      requestStartedAt: TRANSPORT_WITH_DATE.requestStartedAt,
      responseReceivedAt: TRANSPORT_WITH_DATE.responseReceivedAt,
      httpDateHeader: "Thu, 01 Oct 2026 14:47:33 GMT",
      evidencePolicyVersion: "v1",
    });
  });

  it("is UNAVAILABLE (never a fabricated empty-AVAILABLE shape) when the payload is not a usable object", () => {
    const result = normalizeSchwabStrictOptionChainSnapshot(null, REQUEST, TRANSPORT_WITH_DATE);
    expect(result.status).toBe("UNAVAILABLE");
  });

  it("never synthesizes a fallback provider symbol - a contract missing its symbol stays null", () => {
    const payload = { symbol: "SPY", isDelayed: false, putExpDateMap: { "2026-10-16:16": { "655.0": [{ putCall: "PUT", strikePrice: 655 }] } } };
    const result = normalizeSchwabStrictOptionChainSnapshot(payload, REQUEST, TRANSPORT_WITH_DATE);
    if (result.status !== "AVAILABLE") throw new Error("expected AVAILABLE");
    expect(result.contracts[0]!.identity.providerSymbol).toBeNull();
    expect(result.contracts[0]!.identity.optionRoot).toBeNull();
  });

  it("normalizes isDelayed to null (never false) for a non-boolean or missing value", () => {
    const stringFalse = normalizeSchwabStrictOptionChainSnapshot({ symbol: "SPY", isDelayed: "false" }, REQUEST, TRANSPORT_WITH_DATE);
    const missing = normalizeSchwabStrictOptionChainSnapshot({ symbol: "SPY" }, REQUEST, TRANSPORT_WITH_DATE);
    if (stringFalse.status !== "AVAILABLE" || missing.status !== "AVAILABLE") throw new Error("expected AVAILABLE");
    expect(stringFalse.envelope.isDelayed).toBeNull();
    expect(missing.envelope.isDelayed).toBeNull();
  });

  it("preserves optionDeliverablesList presence distinctly: null when absent, [] when present and empty", () => {
    const absent = { symbol: "SPY", isDelayed: false, putExpDateMap: { "2026-10-16:16": { "655.0": [{ symbol: "SPY   261016P00655000", putCall: "PUT", strikePrice: 655 }] } } };
    const empty = { symbol: "SPY", isDelayed: false, putExpDateMap: { "2026-10-16:16": { "655.0": [{ symbol: "SPY   261016P00655000", putCall: "PUT", strikePrice: 655, optionDeliverablesList: [] }] } } };
    const absentResult = normalizeSchwabStrictOptionChainSnapshot(absent, REQUEST, TRANSPORT_WITH_DATE);
    const emptyResult = normalizeSchwabStrictOptionChainSnapshot(empty, REQUEST, TRANSPORT_WITH_DATE);
    if (absentResult.status !== "AVAILABLE" || emptyResult.status !== "AVAILABLE") throw new Error("expected AVAILABLE");
    expect(absentResult.contracts[0]!.terms.optionDeliverablesList).toBeNull();
    expect(emptyResult.contracts[0]!.terms.optionDeliverablesList).toEqual([]);
  });

  it("does not modify or call the legacy normalizeSchwabOptionChainResponse output for the same payload", () => {
    const legacy = normalizeSchwabOptionChainResponse(strictOptionChainLiveDerived);
    expect(legacy).toHaveLength(1);
    expect(legacy[0]!.symbol).toBe("SPY   261001P00550000"); // legacy path still works, completely independently
  });

  it("the live-derived capture's own real zero bid fails strict quote eligibility (a valuable real-data regression, not a constructed failing case)", () => {
    const result = normalizeSchwabStrictOptionChainSnapshot(strictOptionChainLiveDerived, REQUEST, TRANSPORT_WITH_DATE);
    if (result.status !== "AVAILABLE") throw new Error("expected AVAILABLE");
    const quoteResult = evaluateBidAsk(result.contracts[0]!);
    expect(quoteResult.status).toBe("FAIL");
    expect(quoteResult.reasonCode).toBe("ZERO_BID");
  });

  it("a SYNTHETIC fully-standard chain payload parses to a passing-eligible shape - clearly distinct from the live-derived capture above", () => {
    const result = normalizeSchwabStrictOptionChainSnapshot(makeSyntheticStandardSpyChainPayload(), REQUEST, TRANSPORT_WITH_DATE);
    if (result.status !== "AVAILABLE") throw new Error("expected AVAILABLE");
    expect(evaluateBidAsk(result.contracts[0]!).status).toBe("PASS"); // synthetic positive bid - never claimed as captured evidence
  });

  it("the live-derived capture's missing raw optionRoot keeps strict identity at UNKNOWN (insufficient evidence), never a false PASS or a guessed value", () => {
    const result = normalizeSchwabStrictOptionChainSnapshot(strictOptionChainLiveDerived, REQUEST, TRANSPORT_WITH_DATE);
    if (result.status !== "AVAILABLE") throw new Error("expected AVAILABLE");
    expect(result.contracts[0]!.identity.optionRoot).toBeNull();
    const identity = evaluateOptionIdentity({ requestedUnderlying: "SPY", envelope: result.envelope, contract: result.contracts[0]! });
    expect(identity.status).toBe("UNKNOWN");
    expect(identity.reasonCode).toBe("IDENTITY_MISSING");
  });

  describe("strict numeric readers reject coercion (Codex blocker repair)", () => {
    const payloadWith = (contractOverrides: Record<string, unknown>) => makeSyntheticStandardSpyChainPayload({ contractOverrides });

    it("a numeric-string bid never becomes a valid number", () => {
      const result = normalizeSchwabStrictOptionChainSnapshot(payloadWith({ bid: "1" }), REQUEST, TRANSPORT_WITH_DATE);
      if (result.status !== "AVAILABLE") throw new Error("expected AVAILABLE");
      expect(result.contracts[0]!.quote.bid).toBeNull();
    });

    it("a boolean ask never becomes a valid number", () => {
      const result = normalizeSchwabStrictOptionChainSnapshot(payloadWith({ ask: true }), REQUEST, TRANSPORT_WITH_DATE);
      if (result.status !== "AVAILABLE") throw new Error("expected AVAILABLE");
      expect(result.contracts[0]!.quote.ask).toBeNull();
    });

    it("a numeric-string multiplier never becomes a valid number", () => {
      const result = normalizeSchwabStrictOptionChainSnapshot(payloadWith({ multiplier: "100" }), REQUEST, TRANSPORT_WITH_DATE);
      if (result.status !== "AVAILABLE") throw new Error("expected AVAILABLE");
      expect(result.contracts[0]!.terms.multiplier).toBeNull();
    });

    it("a fractional openInterest is preserved exactly (2.9), never truncated to 2", () => {
      const result = normalizeSchwabStrictOptionChainSnapshot(payloadWith({ openInterest: 2.9 }), REQUEST, TRANSPORT_WITH_DATE);
      if (result.status !== "AVAILABLE") throw new Error("expected AVAILABLE");
      expect(result.contracts[0]!.ruleInputs.openInterest).toBe(2.9);
    });

    it("a fractional totalVolume is preserved exactly (2.9), never truncated to 2", () => {
      const result = normalizeSchwabStrictOptionChainSnapshot(payloadWith({ totalVolume: 2.9 }), REQUEST, TRANSPORT_WITH_DATE);
      if (result.status !== "AVAILABLE") throw new Error("expected AVAILABLE");
      expect(result.contracts[0]!.ruleInputs.totalVolume).toBe(2.9);
    });
  });
});

describe("normalizeSchwabQuotesResponse (batch)", () => {
  it("normalizes every requested symbol from one multi-key payload - no cross-symbol mixup", () => {
    const result = normalizeSchwabQuotesResponse(["RIOT", "APLD", "CORZ"], {
      RIOT: { quote: { lastPrice: 12.34 } },
      APLD: { quote: { lastPrice: 23.5 } },
      CORZ: { quote: { lastPrice: 16.5 } },
    });

    expect(result.size).toBe(3);
    expect(result.get("RIOT")?.price).toBe(12.34);
    expect(result.get("APLD")?.price).toBe(23.5);
    expect(result.get("CORZ")?.price).toBe(16.5);
  });

  it("a symbol missing from the payload is simply absent from the result - never thrown, never fabricated", () => {
    const result = normalizeSchwabQuotesResponse(["RIOT", "DELISTED"], {
      RIOT: { quote: { lastPrice: 12.34 } },
      // DELISTED intentionally not present in the response at all
    });

    expect(result.has("RIOT")).toBe(true);
    expect(result.has("DELISTED")).toBe(false);
  });

  it("a symbol present but with no usable price is also simply absent, not a thrown error for the whole batch", () => {
    const result = normalizeSchwabQuotesResponse(["RIOT", "NOPRICE"], {
      RIOT: { quote: { lastPrice: 12.34 } },
      NOPRICE: { reference: { description: "present but priceless" } },
    });

    expect(result.has("RIOT")).toBe(true);
    expect(result.has("NOPRICE")).toBe(false);
  });

  it("uppercases requested symbols regardless of input casing", () => {
    const result = normalizeSchwabQuotesResponse(["riot"], { RIOT: { quote: { lastPrice: 12.34 } } });
    expect(result.get("RIOT")?.symbol).toBe("RIOT");
  });

  it("returns an empty map for an empty symbol list without touching the payload", () => {
    expect(normalizeSchwabQuotesResponse([], { RIOT: { quote: { lastPrice: 12.34 } } }).size).toBe(0);
  });
});

describe("normalizeSchwabQuoteReviewEvidence", () => {
  it("selects quote.lastPrice + quote.tradeTime atomically on an exact symbol match", () => {
    const result = normalizeSchwabQuoteReviewEvidence("SPY", spyQuoteFixture(), TRANSPORT);
    expect(result).toEqual({
      status: "AVAILABLE",
      requestedSymbol: "SPY",
      returnedSymbol: "SPY",
      assetMainType: "EQUITY",
      realtime: true,
      price: 668.73,
      tradeTime: new Date(Date.parse("2026-09-25T23:58:12.000Z")),
      requestStartedAt: TRANSPORT.requestStartedAt,
      responseReceivedAt: TRANSPORT.responseReceivedAt,
    });
  });

  it("is UNAVAILABLE when the requested symbol is entirely absent from the payload", () => {
    const result = normalizeSchwabQuoteReviewEvidence("MSFT", spyQuoteFixture(), TRANSPORT);
    expect(result.status).toBe("UNAVAILABLE");
  });

  it("is UNAVAILABLE (never substituted) when the record's own symbol field disagrees with the requested key", () => {
    const payload = { SPY: { ...spyQuoteFixture().SPY, symbol: "SPYX" } };
    const result = normalizeSchwabQuoteReviewEvidence("SPY", payload, TRANSPORT);
    expect(result.status).toBe("UNAVAILABLE");
  });

  it("is UNAVAILABLE when quote.lastPrice is missing - never falls back to mark or closePrice", () => {
    const payload = spyQuoteFixture();
    delete (payload.SPY.quote as Record<string, unknown>).lastPrice;
    const result = normalizeSchwabQuoteReviewEvidence("SPY", payload, TRANSPORT);
    expect(result).toEqual({ status: "UNAVAILABLE", reason: expect.any(String) });
  });

  it("is UNAVAILABLE when quote.tradeTime is missing - never falls back to quote.quoteTime", () => {
    const payload = spyQuoteFixture();
    delete (payload.SPY.quote as Record<string, unknown>).tradeTime;
    const result = normalizeSchwabQuoteReviewEvidence("SPY", payload, TRANSPORT);
    expect(result).toEqual({ status: "UNAVAILABLE", reason: expect.any(String) });
  });

  it("never uses regular.regularMarketTradeTime even though it looks like a plausible timestamp", () => {
    const result = normalizeSchwabQuoteReviewEvidence("SPY", spyQuoteFixture(), TRANSPORT);
    if (result.status === "AVAILABLE") {
      expect(result.tradeTime.getTime()).not.toBe(Date.parse("2026-09-26T00:00:05.000Z"));
    } else {
      throw new Error("expected AVAILABLE evidence for this fixture");
    }
  });

  it("never cross-pairs quote.lastPrice with quote.quoteTime, mark, or closePrice's own timing", () => {
    // quote.tradeTime deliberately differs from quote.quoteTime in the fixture - confirm the
    // returned tradeTime is the tradeTime field's own value, not quoteTime's.
    const result = normalizeSchwabQuoteReviewEvidence("SPY", spyQuoteFixture(), TRANSPORT);
    expect(result.status).toBe("AVAILABLE");
    if (result.status === "AVAILABLE") {
      expect(result.tradeTime.getTime()).toBe(Date.parse("2026-09-25T23:58:12.000Z"));
      expect(result.tradeTime.getTime()).not.toBe(Date.parse("2026-09-25T23:59:00.000Z"));
    }
  });

  it("passes through realtime: false rather than upgrading it to true", () => {
    const payload = spyQuoteFixture({ record: { realtime: false } });
    const result = normalizeSchwabQuoteReviewEvidence("SPY", payload, TRANSPORT);
    expect(result).toMatchObject({ status: "AVAILABLE", realtime: false });
  });

  it("maps an absent/non-boolean realtime flag to null, never assuming true", () => {
    const payload = spyQuoteFixture();
    delete (payload.SPY as Record<string, unknown>).realtime;
    const result = normalizeSchwabQuoteReviewEvidence("SPY", payload, TRANSPORT);
    expect(result).toMatchObject({ status: "AVAILABLE", realtime: null });
  });

  it("passes through a non-EQUITY assetMainType rather than assuming EQUITY", () => {
    const payload = spyQuoteFixture({ record: { assetMainType: "OPTION" } });
    const result = normalizeSchwabQuoteReviewEvidence("SPY", payload, TRANSPORT);
    expect(result).toMatchObject({ status: "AVAILABLE", assetMainType: "OPTION" });
  });
});

describe("normalizeSchwabEquityMarketSessionEvidence", () => {
  it("parses an ordinary 9:30-16:00 regular session through equity.EQ", () => {
    const result = normalizeSchwabEquityMarketSessionEvidence("2026-06-15", ordinaryDayMarketHoursFixture());
    expect(result.status).toBe("AVAILABLE");
    if (result.status === "AVAILABLE") {
      expect(result.marketType).toBe("EQUITY");
      expect(result.product).toBe("EQ");
      expect(result.isOpen).toBe(true);
      expect(result.regularMarketIntervals).toHaveLength(1);
      expect(result.regularMarketIntervals[0]!.start.toISOString()).toBe(new Date("2026-06-15T09:30:00-04:00").toISOString());
      expect(result.regularMarketIntervals[0]!.end.toISOString()).toBe(new Date("2026-06-15T16:00:00-04:00").toISOString());
    }
  });

  it("parses a verified early-close session (9:30-13:00) without assuming the ordinary close time", () => {
    const result = normalizeSchwabEquityMarketSessionEvidence("2026-11-27", earlyCloseMarketHoursFixture());
    expect(result.status).toBe("AVAILABLE");
    if (result.status === "AVAILABLE") {
      expect(result.regularMarketIntervals[0]!.end.toISOString()).toBe(new Date("2026-11-27T13:00:00-05:00").toISOString());
    }
  });

  it("is UNAVAILABLE when equity.EQ is entirely absent - never falls back to the first object in the payload", () => {
    const result = normalizeSchwabEquityMarketSessionEvidence("2026-06-15", { equity: { OPTION: { date: "2026-06-15" } } });
    expect(result.status).toBe("UNAVAILABLE");
  });

  it("is UNAVAILABLE for a malformed payload (not an object at all)", () => {
    expect(normalizeSchwabEquityMarketSessionEvidence("2026-06-15", null).status).toBe("UNAVAILABLE");
    expect(normalizeSchwabEquityMarketSessionEvidence("2026-06-15", "not json").status).toBe("UNAVAILABLE");
  });

  it("is UNAVAILABLE, never silently accepted, when the returned date disagrees with the requested date", () => {
    const fixture = ordinaryDayMarketHoursFixture();
    const result = normalizeSchwabEquityMarketSessionEvidence("2026-06-16", fixture);
    expect(result.status).toBe("UNAVAILABLE");
  });

  it("is UNAVAILABLE when marketType is not EQUITY", () => {
    const fixture = ordinaryDayMarketHoursFixture();
    (fixture.equity.EQ as Record<string, unknown>).marketType = "OPTION";
    expect(normalizeSchwabEquityMarketSessionEvidence("2026-06-15", fixture).status).toBe("UNAVAILABLE");
  });

  it("is UNAVAILABLE when product is not EQ", () => {
    const fixture = ordinaryDayMarketHoursFixture();
    (fixture.equity.EQ as Record<string, unknown>).product = "OPT";
    expect(normalizeSchwabEquityMarketSessionEvidence("2026-06-15", fixture).status).toBe("UNAVAILABLE");
  });

  it("is UNAVAILABLE when isOpen is missing or not an actual boolean", () => {
    const fixture = ordinaryDayMarketHoursFixture();
    delete (fixture.equity.EQ as Record<string, unknown>).isOpen;
    expect(normalizeSchwabEquityMarketSessionEvidence("2026-06-15", fixture).status).toBe("UNAVAILABLE");

    const stringFixture = ordinaryDayMarketHoursFixture();
    (stringFixture.equity.EQ as Record<string, unknown>).isOpen = "true";
    expect(normalizeSchwabEquityMarketSessionEvidence("2026-06-15", stringFixture).status).toBe("UNAVAILABLE");
  });

  it("is UNAVAILABLE when two regularMarket intervals overlap", () => {
    const fixture = ordinaryDayMarketHoursFixture();
    (fixture.equity.EQ.sessionHours as Record<string, unknown>).regularMarket = [
      { start: "2026-06-15T09:30:00-04:00", end: "2026-06-15T13:00:00-04:00" },
      { start: "2026-06-15T12:00:00-04:00", end: "2026-06-15T16:00:00-04:00" },
    ];
    expect(normalizeSchwabEquityMarketSessionEvidence("2026-06-15", fixture).status).toBe("UNAVAILABLE");
  });

  it("is UNAVAILABLE when a regularMarket interval's start is not before its end", () => {
    const fixture = ordinaryDayMarketHoursFixture();
    (fixture.equity.EQ.sessionHours as Record<string, unknown>).regularMarket = [
      { start: "2026-06-15T16:00:00-04:00", end: "2026-06-15T09:30:00-04:00" },
    ];
    expect(normalizeSchwabEquityMarketSessionEvidence("2026-06-15", fixture).status).toBe("UNAVAILABLE");
  });

  it("is UNAVAILABLE when a regularMarket interval does not belong to the requested NY date", () => {
    const fixture = ordinaryDayMarketHoursFixture();
    (fixture.equity.EQ.sessionHours as Record<string, unknown>).regularMarket = [
      { start: "2026-06-16T09:30:00-04:00", end: "2026-06-16T16:00:00-04:00" },
    ];
    expect(normalizeSchwabEquityMarketSessionEvidence("2026-06-15", fixture).status).toBe("UNAVAILABLE");
  });

  it("is AVAILABLE with zero regularMarket intervals for a genuine weekend/holiday (isOpen: false)", () => {
    const fixture = {
      equity: {
        EQ: {
          date: "2026-06-13",
          marketType: "EQUITY",
          product: "EQ",
          isOpen: false,
          sessionHours: {},
        },
      },
    };
    const result = normalizeSchwabEquityMarketSessionEvidence("2026-06-13", fixture);
    expect(result).toMatchObject({ status: "AVAILABLE", isOpen: false, regularMarketIntervals: [] });
  });

  // Codex P2 (D) - "regularMarket legitimately absent" (a genuinely closed day may omit it
  // entirely) must never be conflated with "regularMarket was supplied but malformed" (corrupt
  // provider data) - collapsing both into the same [] treatment would let corrupt data masquerade
  // as a validated closed day.
  it("is AVAILABLE/CLOSED when sessionHours itself is entirely absent on an explicit closed day", () => {
    const fixture = { equity: { EQ: { date: "2026-06-13", marketType: "EQUITY", product: "EQ", isOpen: false } } };
    const result = normalizeSchwabEquityMarketSessionEvidence("2026-06-13", fixture);
    expect(result).toMatchObject({ status: "AVAILABLE", isOpen: false, regularMarketIntervals: [] });
  });

  // Codex P2 (D, round 3) - an EXPLICIT `null` is a real value the provider chose to send, never
  // the same claim as omitting the key entirely - both must be rejected as UNAVAILABLE, never
  // silently treated the same as "genuinely absent" (which would still make a closed day).
  it("is UNAVAILABLE when sessionHours is explicitly null (never the same as omitting the key)", () => {
    const fixture = { equity: { EQ: { date: "2026-06-13", marketType: "EQUITY", product: "EQ", isOpen: false, sessionHours: null } } };
    expect(normalizeSchwabEquityMarketSessionEvidence("2026-06-13", fixture).status).toBe("UNAVAILABLE");
  });

  it("is UNAVAILABLE when regularMarket is explicitly null (never the same as omitting the key)", () => {
    const fixture = { equity: { EQ: { date: "2026-06-13", marketType: "EQUITY", product: "EQ", isOpen: false, sessionHours: { regularMarket: null } } } };
    expect(normalizeSchwabEquityMarketSessionEvidence("2026-06-13", fixture).status).toBe("UNAVAILABLE");
  });

  it("is UNAVAILABLE when regularMarket was SUPPLIED as a malformed scalar rather than legitimately absent", () => {
    const fixture = {
      equity: { EQ: { date: "2026-06-13", marketType: "EQUITY", product: "EQ", isOpen: false, sessionHours: { regularMarket: "closed" } } },
    };
    expect(normalizeSchwabEquityMarketSessionEvidence("2026-06-13", fixture).status).toBe("UNAVAILABLE");
  });

  it("is UNAVAILABLE when regularMarket was SUPPLIED as a malformed object rather than legitimately absent", () => {
    const fixture = {
      equity: { EQ: { date: "2026-06-13", marketType: "EQUITY", product: "EQ", isOpen: false, sessionHours: { regularMarket: { unexpected: true } } } },
    };
    expect(normalizeSchwabEquityMarketSessionEvidence("2026-06-13", fixture).status).toBe("UNAVAILABLE");
  });

  it("is UNAVAILABLE when isOpen: false is reported alongside a valid, non-empty regularMarket (contradiction, not a malformed-value case)", () => {
    const fixture = ordinaryDayMarketHoursFixture();
    (fixture.equity.EQ as Record<string, unknown>).isOpen = false;
    expect(normalizeSchwabEquityMarketSessionEvidence("2026-06-15", fixture).status).toBe("UNAVAILABLE");
  });

  it("is UNAVAILABLE when sessionHours itself is a malformed scalar", () => {
    const fixture = { equity: { EQ: { date: "2026-06-13", marketType: "EQUITY", product: "EQ", isOpen: false, sessionHours: "not-an-object" } } };
    expect(normalizeSchwabEquityMarketSessionEvidence("2026-06-13", fixture).status).toBe("UNAVAILABLE");
  });

  it("is UNAVAILABLE when required identity/date/type fields are missing, distinct from the closed-day case", () => {
    expect(normalizeSchwabEquityMarketSessionEvidence("2026-06-13", { equity: { EQ: { isOpen: false } } }).status).toBe("UNAVAILABLE");
    expect(
      normalizeSchwabEquityMarketSessionEvidence("2026-06-13", { equity: { EQ: { date: "2026-06-13", isOpen: false } } }).status,
    ).toBe("UNAVAILABLE");
  });

  // Codex P1 (B2): the session parser previously let isOpen and the regularMarket intervals
  // disagree, silently trusting whichever one it happened to read - both of the tests below prove
  // a disagreement between the two now fails closed to UNAVAILABLE instead of picking a side.
  it("is UNAVAILABLE (never a silently-open day) when isOpen: false is reported alongside regular-session intervals", () => {
    const fixture = ordinaryDayMarketHoursFixture();
    (fixture.equity.EQ as Record<string, unknown>).isOpen = false;
    expect(normalizeSchwabEquityMarketSessionEvidence("2026-06-15", fixture).status).toBe("UNAVAILABLE");
  });

  it("is UNAVAILABLE (never silently reinterpreted as CLOSED) when isOpen: true is reported with no regular-session intervals", () => {
    const fixture = {
      equity: { EQ: { date: "2026-06-15", marketType: "EQUITY", product: "EQ", isOpen: true, sessionHours: {} } },
    };
    expect(normalizeSchwabEquityMarketSessionEvidence("2026-06-15", fixture).status).toBe("UNAVAILABLE");
  });

  it("is UNAVAILABLE when isOpen: true is reported but sessionHours.regularMarket is malformed (not an array)", () => {
    const fixture = ordinaryDayMarketHoursFixture();
    (fixture.equity.EQ.sessionHours as Record<string, unknown>).regularMarket = "not-an-array";
    expect(normalizeSchwabEquityMarketSessionEvidence("2026-06-15", fixture).status).toBe("UNAVAILABLE");
  });

  // Codex P1 (B2): a bare "2026-06-15T09:30:00" with no Z/offset is ambiguous (ECMAScript parses
  // it as LOCAL time, which depends on the runtime's own timezone) - it must be rejected outright,
  // never silently accepted the way `new Date()` alone would accept it.
  it("is UNAVAILABLE when a regular-session interval's start or end has no explicit UTC offset", () => {
    const missingStartOffset = ordinaryDayMarketHoursFixture();
    (missingStartOffset.equity.EQ.sessionHours as Record<string, unknown>).regularMarket = [
      { start: "2026-06-15T09:30:00", end: "2026-06-15T16:00:00-04:00" },
    ];
    expect(normalizeSchwabEquityMarketSessionEvidence("2026-06-15", missingStartOffset).status).toBe("UNAVAILABLE");

    const missingEndOffset = ordinaryDayMarketHoursFixture();
    (missingEndOffset.equity.EQ.sessionHours as Record<string, unknown>).regularMarket = [
      { start: "2026-06-15T09:30:00-04:00", end: "2026-06-15T16:00:00" },
    ];
    expect(normalizeSchwabEquityMarketSessionEvidence("2026-06-15", missingEndOffset).status).toBe("UNAVAILABLE");
  });

  it("accepts a Z-suffixed UTC offset just as validly as a numeric +/-HH:MM offset", () => {
    const fixture = {
      equity: {
        EQ: {
          date: "2026-06-15",
          marketType: "EQUITY",
          product: "EQ",
          isOpen: true,
          sessionHours: { regularMarket: [{ start: "2026-06-15T13:30:00Z", end: "2026-06-15T20:00:00Z" }] },
        },
      },
    };
    expect(normalizeSchwabEquityMarketSessionEvidence("2026-06-15", fixture).status).toBe("AVAILABLE");
  });

  it("is UNAVAILABLE when a regular-session interval's END crosses into a different NY calendar date than its start", () => {
    const fixture = ordinaryDayMarketHoursFixture();
    // Start is legitimately on 2026-06-15, but end is pushed to 2026-06-16 - only `start` was
    // checked against the requested date before this fix, letting a malformed `end` slip through.
    (fixture.equity.EQ.sessionHours as Record<string, unknown>).regularMarket = [
      { start: "2026-06-15T09:30:00-04:00", end: "2026-06-16T00:30:00-04:00" },
    ];
    expect(normalizeSchwabEquityMarketSessionEvidence("2026-06-15", fixture).status).toBe("UNAVAILABLE");
  });
});
