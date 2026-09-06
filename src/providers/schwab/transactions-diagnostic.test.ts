import { describe, expect, it } from "vitest";
import {
  fetchSchwabOrdersRaw,
  fetchSchwabTransactionsRaw,
  summarizeOrders,
  summarizeTransactions,
} from "./transactions-diagnostic";

describe("summarizeTransactions", () => {
  it("counts transactions by type", () => {
    const summary = summarizeTransactions([{ type: "TRADE" }, { type: "TRADE" }, { type: "DIVIDEND_OR_INTEREST" }]);
    expect(summary).toEqual({
      transactionCount: 3,
      typeCounts: { TRADE: 2, DIVIDEND_OR_INTEREST: 1 },
      malformedResponse: false,
    });
  });

  it("reports zero transactions for an honest empty array, not malformed", () => {
    expect(summarizeTransactions([])).toEqual({ transactionCount: 0, typeCounts: {}, malformedResponse: false });
  });

  it("falls back to UNKNOWN when a transaction has no type field", () => {
    const summary = summarizeTransactions([{}]);
    expect(summary.typeCounts).toEqual({ UNKNOWN: 1 });
  });

  it("flags a non-array 200 body as malformed, distinct from an honest empty array", () => {
    expect(summarizeTransactions({ error: "unexpected shape" })).toEqual({
      transactionCount: 0,
      typeCounts: {},
      malformedResponse: true,
    });
    expect(summarizeTransactions(null)).toMatchObject({ malformedResponse: true });
  });
});

describe("summarizeOrders", () => {
  it("reports zero counts for an honest empty array, not malformed", () => {
    expect(summarizeOrders([])).toEqual({
      ordersReceived: 0,
      filledOrders: 0,
      optionOrders: 0,
      fillLegs: 0,
      instrumentSummaries: [],
      malformedResponse: false,
    });
  });

  it("flags a non-array body as malformed", () => {
    expect(summarizeOrders({ notAnArray: true }).malformedResponse).toBe(true);
  });

  it("joins a filled single-leg option order's leg and execution leg into an instrument summary", () => {
    const summary = summarizeOrders([
      {
        orderId: "SECRET-ORDER-1",
        accountId: "SECRET-ACCOUNT-1",
        status: "FILLED",
        orderLegCollection: [
          {
            legId: 1,
            instruction: "SELL_TO_OPEN",
            quantity: 1,
            instrument: {
              assetType: "OPTION",
              symbol: "APLD  260904P00023500",
              underlyingSymbol: "APLD",
              putCall: "PUT",
              strikePrice: 23.5,
              optionExpirationDate: "2026-09-04T00:00:00.000Z",
            },
          },
        ],
        orderActivityCollection: [
          {
            activityType: "EXECUTION",
            executionLegs: [{ legId: 1, quantity: 1, price: 0.42, time: "2026-06-01T14:30:00.000Z" }],
          },
        ],
      },
    ]);

    expect(summary.ordersReceived).toBe(1);
    expect(summary.filledOrders).toBe(1);
    expect(summary.optionOrders).toBe(1);
    expect(summary.fillLegs).toBe(1);
    expect(summary.instrumentSummaries).toEqual([
      {
        underlyingSymbol: "APLD",
        expiration: "2026-09-04T00:00:00.000Z",
        strike: 23.5,
        putCall: "PUT",
        instruction: "SELL_TO_OPEN",
        quantity: 1,
        fillPrice: 0.42,
        fillDate: "2026-06-01T14:30:00.000Z",
      },
    ]);

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("SECRET-ORDER-1");
    expect(serialized).not.toContain("SECRET-ACCOUNT-1");
  });

  it("does not count a working (unfilled) order as filled, and still reports its option leg with no fill price", () => {
    const summary = summarizeOrders([
      {
        orderId: "2",
        status: "WORKING",
        orderLegCollection: [
          {
            legId: 1,
            instruction: "SELL_TO_OPEN",
            quantity: 2,
            instrument: { assetType: "OPTION", underlyingSymbol: "CORZ", putCall: "PUT", strikePrice: 16.5 },
          },
        ],
      },
    ]);

    expect(summary.filledOrders).toBe(0);
    expect(summary.optionOrders).toBe(1);
    expect(summary.fillLegs).toBe(0);
    expect(summary.instrumentSummaries[0]).toMatchObject({ fillPrice: null, fillDate: null, quantity: 2 });
  });

  it("ignores non-option (equity) legs entirely", () => {
    const summary = summarizeOrders([
      {
        status: "FILLED",
        orderLegCollection: [{ legId: 1, instruction: "BUY", quantity: 10, instrument: { assetType: "EQUITY", symbol: "AAPL" } }],
        orderActivityCollection: [{ executionLegs: [{ legId: 1, quantity: 10, price: 150, time: "2026-06-01T00:00:00.000Z" }] }],
      },
    ]);

    expect(summary.optionOrders).toBe(0);
    expect(summary.instrumentSummaries).toEqual([]);
  });

  it("caps instrument summaries at 50 even with more option orders", () => {
    const orders = Array.from({ length: 60 }, (_, index) => ({
      status: "FILLED",
      orderLegCollection: [
        {
          legId: 1,
          instruction: "SELL_TO_OPEN",
          quantity: 1,
          instrument: { assetType: "OPTION", underlyingSymbol: `T${index}`, putCall: "PUT", strikePrice: 10 },
        },
      ],
    }));

    expect(summarizeOrders(orders).instrumentSummaries).toHaveLength(50);
  });
});

describe("fetchSchwabTransactionsRaw", () => {
  it("sends full ISO-8601 date-time bounds and the requested types on the correct path", async () => {
    let capturedUrl: URL | null = null;
    const fetchFn = (async (input: URL | string) => {
      capturedUrl = new URL(input.toString());
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    const from = new Date("2026-06-01T00:00:00.000Z");
    const to = new Date("2026-08-30T00:00:00.000Z");
    await fetchSchwabTransactionsRaw({ accessToken: "token", accountHash: "hash-123", from, to, types: "TRADE", fetchFn });

    expect(capturedUrl).not.toBeNull();
    const url = capturedUrl as unknown as URL;
    expect(url.pathname).toBe("/trader/v1/accounts/hash-123/transactions");
    expect(url.searchParams.get("startDate")).toBe("2026-06-01T00:00:00.000Z");
    expect(url.searchParams.get("endDate")).toBe("2026-08-30T00:00:00.000Z");
    expect(url.searchParams.get("types")).toBe("TRADE");
  });
});

describe("fetchSchwabOrdersRaw", () => {
  it("uses fromEnteredTime/toEnteredTime with full ISO-8601 date-time bounds on the orders path", async () => {
    let capturedUrl: URL | null = null;
    const fetchFn = (async (input: URL | string) => {
      capturedUrl = new URL(input.toString());
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    const from = new Date("2026-07-01T00:00:00.000Z");
    const to = new Date("2026-08-30T00:00:00.000Z");
    await fetchSchwabOrdersRaw({ accessToken: "token", accountHash: "hash-123", from, to, fetchFn });

    expect(capturedUrl).not.toBeNull();
    const url = capturedUrl as unknown as URL;
    expect(url.pathname).toBe("/trader/v1/accounts/hash-123/orders");
    expect(url.searchParams.get("fromEnteredTime")).toBe("2026-07-01T00:00:00.000Z");
    expect(url.searchParams.get("toEnteredTime")).toBe("2026-08-30T00:00:00.000Z");
  });
});
