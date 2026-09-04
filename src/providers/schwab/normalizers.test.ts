import { describe, expect, it } from "vitest";
import { normalizeSchwabAccountNumbers } from "./broker-read";
import {
  normalizeSchwabOptionChainResponse,
  normalizeSchwabPriceHistoryResponse,
  normalizeSchwabQuoteResponse,
} from "./normalizers";

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
