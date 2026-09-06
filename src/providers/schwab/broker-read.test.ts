import { describe, expect, it } from "vitest";
import { SchwabBrokerReadProvider } from "./broker-read";

function stubProvider(securitiesAccount: Record<string, unknown>) {
  const fetchFn = async () =>
    new Response(JSON.stringify({ securitiesAccount }), { status: 200, headers: { "content-type": "application/json" } });

  return new SchwabBrokerReadProvider({
    accessToken: "test-token",
    accountNumbers: [{ accountNumberLast4: "1234", hashValue: "acct-hash-1" }],
    fetchFn: fetchFn as typeof fetch,
  });
}

function optionPosition(overrides: Record<string, unknown> = {}) {
  return {
    shortQuantity: 1,
    longQuantity: 0,
    marketValue: -16,
    instrument: {
      symbol: "RIOT 260904P00017500",
      assetType: "OPTION",
      putCall: "PUT",
      strikePrice: 17.5,
      underlyingSymbol: "RIOT",
      ...(overrides.instrument as Record<string, unknown> | undefined),
    },
    ...overrides,
  };
}

describe("SchwabBrokerReadProvider.getPositions", () => {
  it("normalizes three short put positions with signed quantity and option fields", async () => {
    const provider = stubProvider({
      positions: [
        optionPosition({ instrument: { symbol: "RIOT 260904P00017500", assetType: "OPTION", putCall: "PUT", strikePrice: 17.5, underlyingSymbol: "RIOT" } }),
        optionPosition({ instrument: { symbol: "APLD 260904P00023500", assetType: "OPTION", putCall: "PUT", strikePrice: 23.5, underlyingSymbol: "APLD" } }),
        optionPosition({ instrument: { symbol: "CORZ 260904P00016500", assetType: "OPTION", putCall: "PUT", strikePrice: 16.5, underlyingSymbol: "CORZ" } }),
      ],
    });

    const positions = await provider.getPositions("acct-hash-1");
    expect(positions).toHaveLength(3);
    expect(positions[0]).toMatchObject({
      accountId: "acct-hash-1",
      symbol: "RIOT 260904P00017500",
      quantity: -1,
      assetType: "OPTION",
      putCall: "PUT",
      strikePrice: 17.5,
      underlyingSymbol: "RIOT",
    });
  });

  it("reports a short position as a negative quantity and a long position as positive", async () => {
    const provider = stubProvider({
      positions: [
        optionPosition({ shortQuantity: 2, longQuantity: 0 }),
        optionPosition({ shortQuantity: 0, longQuantity: 3, instrument: { symbol: "RIOT 260904P00017500", assetType: "OPTION", putCall: "PUT", strikePrice: 17.5 } }),
      ],
    });

    const positions = await provider.getPositions("acct-hash-1");
    expect(positions[0].quantity).toBe(-2);
    expect(positions[1].quantity).toBe(3);
  });

  it("normalizes an equity position without option fields", async () => {
    const provider = stubProvider({
      positions: [
        {
          shortQuantity: 0,
          longQuantity: 100,
          marketValue: 1500,
          instrument: { symbol: "RIOT", assetType: "EQUITY" },
        },
      ],
    });

    const positions = await provider.getPositions("acct-hash-1");
    expect(positions[0]).toMatchObject({ symbol: "RIOT", quantity: 100, assetType: "EQUITY", putCall: null, strikePrice: null });
  });

  it("skips a position with no instrument symbol", async () => {
    const provider = stubProvider({ positions: [{ shortQuantity: 1, instrument: {} }] });
    expect(await provider.getPositions("acct-hash-1")).toHaveLength(0);
  });
});

function transactionsProvider(transactions: Record<string, unknown>[]) {
  const fetchFn = async () => new Response(JSON.stringify(transactions), { status: 200, headers: { "content-type": "application/json" } });

  return new SchwabBrokerReadProvider({
    accessToken: "test-token",
    accountNumbers: [{ accountNumberLast4: "1234", hashValue: "acct-hash-1" }],
    fetchFn: fetchFn as typeof fetch,
  });
}

describe("SchwabBrokerReadProvider.getTransactions", () => {
  it("extracts the opening option leg's action, strike, expiration, and quantity from a Sell to Open", async () => {
    const provider = transactionsProvider([
      {
        activityId: "txn-sto-1",
        netAmount: 28,
        time: "2026-08-28T14:00:00Z",
        description: "Sell to Open",
        transferItems: [
          {
            instruction: "SELL_TO_OPEN",
            amount: 1,
            price: 0.28,
            instrument: { symbol: "APLD 260904P00023500", assetType: "OPTION", putCall: "PUT", strikePrice: 23.5, underlyingSymbol: "APLD", optionExpirationDate: "2026-09-04" },
          },
        ],
      },
    ]);

    const transactions = await provider.getTransactions("acct-hash-1", new Date("2026-08-01"), new Date("2026-09-30"));
    expect(transactions).toEqual([
      expect.objectContaining({
        id: "txn-sto-1",
        symbol: "APLD 260904P00023500",
        amount: 28,
        action: "Sell to Open",
        quantity: 1,
        price: 0.28,
        underlyingSymbol: "APLD",
        optionType: "PUT",
        strike: 23.5,
        expiration: new Date("2026-09-04"),
      }),
    ]);
  });

  it("sums fee-only transfer items into fees, distinct from the option leg's own transfer item", async () => {
    const provider = transactionsProvider([
      {
        activityId: "txn-btc-1",
        netAmount: -13,
        time: "2026-09-01T14:00:00Z",
        transferItems: [
          { instruction: "BUY_TO_CLOSE", amount: 1, price: 0.12, instrument: { symbol: "APLD 260904P00023500", assetType: "OPTION", putCall: "PUT", strikePrice: 23.5 } },
          { feeType: "COMMISSION", cost: 0.65 },
        ],
      },
    ]);

    const [transaction] = await provider.getTransactions("acct-hash-1", new Date("2026-08-01"), new Date("2026-09-30"));
    expect(transaction.action).toBe("Buy to Close");
    expect(transaction.fees).toBe(0.65);
  });

  it("labels an assignment transaction from free-text type/description when there is no instruction field", async () => {
    const provider = transactionsProvider([
      {
        activityId: "txn-assign-1",
        netAmount: 0,
        time: "2026-09-04T21:00:00Z",
        type: "RECEIVE_AND_DELIVER",
        description: "Option Assignment",
        transferItems: [{ instrument: { symbol: "APLD 260904P00023500", assetType: "OPTION" } }],
      },
    ]);

    const [transaction] = await provider.getTransactions("acct-hash-1", new Date("2026-08-01"), new Date("2026-09-30"));
    expect(transaction.action).toBe("Assignment");
  });

  it("returns null (not zero) fees and null option fields when Schwab reports none, rather than guessing", async () => {
    const provider = transactionsProvider([
      { activityId: "txn-cash-1", netAmount: 4.12, time: "2026-08-15T14:00:00Z", type: "CASH_IN_OR_CASH_OUT", description: "Bank Interest" },
    ]);

    const [transaction] = await provider.getTransactions("acct-hash-1", new Date("2026-08-01"), new Date("2026-09-30"));
    expect(transaction.action).toBeNull();
    expect(transaction.fees).toBeNull();
    expect(transaction.optionType).toBeNull();
    expect(transaction.strike).toBeNull();
    expect(transaction.expiration).toBeNull();
  });
});
