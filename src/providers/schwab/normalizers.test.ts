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
});
