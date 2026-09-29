import { describe, expect, it } from "vitest";
import type { EquityMarketSessionEvidence, QuoteReviewEvidence } from "@/providers/market-data/types";
import { evaluateQuoteEligibility, QUOTE_FRESHNESS_WINDOW_MS } from "./quoteEvidence";

const NY_DATE = "2026-06-15";
const SESSION_OPEN = new Date(`${NY_DATE}T09:30:00-04:00`);
const SESSION_CLOSE = new Date(`${NY_DATE}T16:00:00-04:00`);
const NOON = new Date(`${NY_DATE}T12:00:00-04:00`);

function ordinarySession(): EquityMarketSessionEvidence {
  return {
    status: "AVAILABLE",
    requestedDate: NY_DATE,
    returnedDate: NY_DATE,
    marketType: "EQUITY",
    product: "EQ",
    isOpen: true,
    regularMarketIntervals: [{ start: SESSION_OPEN, end: SESSION_CLOSE }],
  };
}

function baseEvidence(overrides: Partial<Extract<QuoteReviewEvidence, { status: "AVAILABLE" }>> = {}): QuoteReviewEvidence {
  return {
    status: "AVAILABLE",
    requestedSymbol: "SPY",
    returnedSymbol: "SPY",
    assetMainType: "EQUITY",
    realtime: true,
    price: 500.25,
    tradeTime: NOON,
    requestStartedAt: NOON,
    responseReceivedAt: NOON,
    ...overrides,
  };
}

describe("evaluateQuoteEligibility", () => {
  it("is eligible when every rule is satisfied at the moment of the trade", () => {
    const result = evaluateQuoteEligibility(baseEvidence(), ordinarySession(), NOON);
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.ageMs).toBe(0);
    }
  });

  it("rejects UNAVAILABLE evidence outright", () => {
    const result = evaluateQuoteEligibility({ status: "UNAVAILABLE", reason: "provider error" }, ordinarySession(), NOON);
    expect(result).toEqual({ eligible: false, reason: "EVIDENCE_UNAVAILABLE" });
  });

  describe("rule 1 - exact symbol match", () => {
    it("succeeds when requested and returned symbols are identical", () => {
      expect(evaluateQuoteEligibility(baseEvidence({ requestedSymbol: "SPY", returnedSymbol: "SPY" }), ordinarySession(), NOON).eligible).toBe(true);
    });

    it("rejects a mismatched returned symbol", () => {
      const result = evaluateQuoteEligibility(baseEvidence({ requestedSymbol: "SPY", returnedSymbol: "SPX" }), ordinarySession(), NOON);
      expect(result).toEqual({ eligible: false, reason: "SYMBOL_MISMATCH" });
    });

    it("rejects a case-only difference - exact match only, no case-folding", () => {
      const result = evaluateQuoteEligibility(baseEvidence({ requestedSymbol: "SPY", returnedSymbol: "spy" }), ordinarySession(), NOON);
      expect(result).toEqual({ eligible: false, reason: "SYMBOL_MISMATCH" });
    });
  });

  describe("rule 2 - supported EQUITY identity", () => {
    it("rejects a non-EQUITY asset type", () => {
      const result = evaluateQuoteEligibility(baseEvidence({ assetMainType: "OPTION" }), ordinarySession(), NOON);
      expect(result).toEqual({ eligible: false, reason: "UNSUPPORTED_ASSET_TYPE" });
    });

    it("rejects a null/unknown asset type", () => {
      const result = evaluateQuoteEligibility(baseEvidence({ assetMainType: null }), ordinarySession(), NOON);
      expect(result).toEqual({ eligible: false, reason: "UNSUPPORTED_ASSET_TYPE" });
    });
  });

  describe("rule 3 - realtime flag", () => {
    it("rejects realtime: false", () => {
      const result = evaluateQuoteEligibility(baseEvidence({ realtime: false }), ordinarySession(), NOON);
      expect(result).toEqual({ eligible: false, reason: "NOT_REALTIME" });
    });

    it("rejects a null/unknown realtime flag", () => {
      const result = evaluateQuoteEligibility(baseEvidence({ realtime: null }), ordinarySession(), NOON);
      expect(result).toEqual({ eligible: false, reason: "NOT_REALTIME" });
    });
  });

  describe("rule 4 - positive finite price", () => {
    it("rejects a zero price", () => {
      expect(evaluateQuoteEligibility(baseEvidence({ price: 0 }), ordinarySession(), NOON)).toEqual({ eligible: false, reason: "INVALID_PRICE" });
    });

    it("rejects a negative price", () => {
      expect(evaluateQuoteEligibility(baseEvidence({ price: -1 }), ordinarySession(), NOON)).toEqual({ eligible: false, reason: "INVALID_PRICE" });
    });

    it("rejects a non-finite price", () => {
      expect(evaluateQuoteEligibility(baseEvidence({ price: Number.NaN }), ordinarySession(), NOON)).toEqual({ eligible: false, reason: "INVALID_PRICE" });
      expect(evaluateQuoteEligibility(baseEvidence({ price: Number.POSITIVE_INFINITY }), ordinarySession(), NOON)).toEqual({ eligible: false, reason: "INVALID_PRICE" });
    });
  });

  describe("rule 5 - valid tradeTime instant", () => {
    it("rejects an invalid Date", () => {
      const result = evaluateQuoteEligibility(baseEvidence({ tradeTime: new Date(Number.NaN) }), ordinarySession(), NOON);
      expect(result).toEqual({ eligible: false, reason: "INVALID_TIMESTAMP" });
    });
  });

  describe("rule 6 - timestamp not in the future", () => {
    it("rejects a tradeTime after `now`", () => {
      const future = new Date(NOON.getTime() + 1000);
      // responseReceivedAt is bumped to match so this isolates the now-vs-tradeTime check from
      // the separate tradeTime-vs-responseReceivedAt chronology check (rule 5b).
      const result = evaluateQuoteEligibility(baseEvidence({ tradeTime: future, responseReceivedAt: future }), ordinarySession(), NOON);
      expect(result).toEqual({ eligible: false, reason: "FUTURE_TIMESTAMP" });
    });
  });

  describe("rule 5b - transport chronology (tradeTime vs. responseReceivedAt)", () => {
    it("rejects a tradeTime reported after the response that carried it was received", () => {
      const tradeTime = new Date(NOON.getTime() + 5000);
      const result = evaluateQuoteEligibility(baseEvidence({ tradeTime, responseReceivedAt: NOON }), ordinarySession(), tradeTime);
      expect(result).toEqual({ eligible: false, reason: "TRADE_TIME_AFTER_RESPONSE_RECEIVED" });
    });

    it("is eligible when tradeTime exactly equals responseReceivedAt", () => {
      const result = evaluateQuoteEligibility(baseEvidence({ tradeTime: NOON, responseReceivedAt: NOON }), ordinarySession(), NOON);
      expect(result.eligible).toBe(true);
    });
  });

  describe("rule 7 - 120 second freshness window", () => {
    it("is still eligible at exactly the 120 second boundary", () => {
      const now = new Date(NOON.getTime() + QUOTE_FRESHNESS_WINDOW_MS);
      const result = evaluateQuoteEligibility(baseEvidence({ tradeTime: NOON }), ordinarySession(), now);
      expect(result.eligible).toBe(true);
    });

    it("is stale one millisecond past the 120 second boundary", () => {
      const now = new Date(NOON.getTime() + QUOTE_FRESHNESS_WINDOW_MS + 1);
      const result = evaluateQuoteEligibility(baseEvidence({ tradeTime: NOON }), ordinarySession(), now);
      expect(result).toEqual({ eligible: false, reason: "STALE_TIMESTAMP" });
    });
  });

  describe("rules 8/9 - regular session membership", () => {
    it("rejects when session evidence itself is UNAVAILABLE", () => {
      const result = evaluateQuoteEligibility(baseEvidence(), { status: "UNAVAILABLE", reason: "provider error" }, NOON);
      expect(result).toEqual({ eligible: false, reason: "SESSION_EVIDENCE_UNAVAILABLE" });
    });

    it("rejects when `now` is outside the regular session (after-hours) even though the trade itself was coherent", () => {
      const afterHours = new Date(`${NY_DATE}T20:00:00-04:00`);
      // Mirrors the live-capture risk: a coherent lastPrice/tradeTime pair observed after-hours
      // must never produce an active advisory just because the pair is internally consistent.
      const result = evaluateQuoteEligibility(baseEvidence({ tradeTime: afterHours, responseReceivedAt: afterHours }), ordinarySession(), afterHours);
      expect(result).toEqual({ eligible: false, reason: "MARKET_NOT_IN_REGULAR_SESSION" });
    });

    it("rejects a premarket trade time carried over into the open regular session (no stale-quote carryover)", () => {
      // The trade itself is still fresh (well under the 120s window) so freshness (rule 7) is not
      // what rejects it - only the session-membership check (rule 9) should.
      const premarketTrade = new Date(`${NY_DATE}T09:29:00-04:00`);
      const nowDuringSession = new Date(`${NY_DATE}T09:30:30-04:00`);
      const result = evaluateQuoteEligibility(baseEvidence({ tradeTime: premarketTrade }), ordinarySession(), nowDuringSession);
      expect(result).toEqual({ eligible: false, reason: "TRADE_TIME_OUTSIDE_SESSION" });
    });

    it("rejects when the trade timestamp falls outside the session even though `now` is inside it", () => {
      const tradeBeforeOpen = new Date(SESSION_OPEN.getTime() - 60_000);
      const result = evaluateQuoteEligibility(baseEvidence({ tradeTime: tradeBeforeOpen }), ordinarySession(), SESSION_OPEN);
      expect(result).toEqual({ eligible: false, reason: "TRADE_TIME_OUTSIDE_SESSION" });
    });

    it("rejects a trade from an earlier session interval once evaluation time has moved into a later interval (Codex P1 B4)", () => {
      // Two regular-session intervals with a trading-halt gap between them - the trade happened
      // in the FIRST interval and is still well within the 120s freshness window relative to
      // `now`, but `now` has already moved into the SECOND interval. Being "in some interval" on
      // each side independently is not enough - they must be the SAME interval.
      const haltSession: EquityMarketSessionEvidence = {
        status: "AVAILABLE",
        requestedDate: NY_DATE,
        returnedDate: NY_DATE,
        marketType: "EQUITY",
        product: "EQ",
        isOpen: true,
        regularMarketIntervals: [
          { start: SESSION_OPEN, end: new Date(SESSION_OPEN.getTime() + 60_000) },
          { start: new Date(SESSION_OPEN.getTime() + 60_001), end: SESSION_CLOSE },
        ],
      };
      const tradeInFirstInterval = new Date(SESSION_OPEN.getTime() + 30_000);
      const nowInSecondInterval = new Date(SESSION_OPEN.getTime() + 60_500);
      const result = evaluateQuoteEligibility(
        baseEvidence({ tradeTime: tradeInFirstInterval, responseReceivedAt: tradeInFirstInterval }),
        haltSession,
        nowInSecondInterval,
      );
      expect(result).toEqual({ eligible: false, reason: "TRADE_TIME_NOT_IN_SAME_SESSION_INTERVAL_AS_NOW" });
    });

    it("is eligible when the trade and evaluation time are both within the same interval of a multi-interval session", () => {
      const haltSession: EquityMarketSessionEvidence = {
        status: "AVAILABLE",
        requestedDate: NY_DATE,
        returnedDate: NY_DATE,
        marketType: "EQUITY",
        product: "EQ",
        isOpen: true,
        regularMarketIntervals: [
          { start: SESSION_OPEN, end: new Date(SESSION_OPEN.getTime() + 60_000) },
          { start: new Date(SESSION_OPEN.getTime() + 60_001), end: SESSION_CLOSE },
        ],
      };
      const trade = new Date(SESSION_OPEN.getTime() + 70_000);
      const now = new Date(SESSION_OPEN.getTime() + 75_000);
      const result = evaluateQuoteEligibility(baseEvidence({ tradeTime: trade, responseReceivedAt: trade }), haltSession, now);
      expect(result.eligible).toBe(true);
    });

    it("rejects on a weekend/holiday with no regular-market intervals at all", () => {
      const weekendSession: EquityMarketSessionEvidence = {
        status: "AVAILABLE",
        requestedDate: "2026-06-13",
        returnedDate: "2026-06-13",
        marketType: "EQUITY",
        product: "EQ",
        isOpen: false,
        regularMarketIntervals: [],
      };
      const weekendNow = new Date("2026-06-13T16:00:00-04:00");
      const result = evaluateQuoteEligibility(baseEvidence({ tradeTime: weekendNow }), weekendSession, weekendNow);
      expect(result).toEqual({ eligible: false, reason: "MARKET_NOT_IN_REGULAR_SESSION" });
    });
  });
});
