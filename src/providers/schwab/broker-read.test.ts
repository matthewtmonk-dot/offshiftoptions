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

/** Returns `transactions` only for the one category the fixture represents (default TRADE) and
 * `[]` for the other two - mirrors how Schwab's three independent per-category endpoints behave
 * in production, where only one category ever actually contains a given real transaction. */
function transactionsProvider(transactions: Record<string, unknown>[], options: { category?: string } = {}) {
  const category = options.category ?? "TRADE";
  const fetchFn = async (input: URL | string) => {
    const url = new URL(input.toString());
    const body = url.searchParams.get("types") === category ? transactions : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };

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

    const { transactions } = await provider.getTransactions("acct-hash-1", new Date("2026-08-01"), new Date("2026-09-30"));
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

    const { transactions } = await provider.getTransactions("acct-hash-1", new Date("2026-08-01"), new Date("2026-09-30"));
    expect(transactions[0].action).toBe("Buy to Close");
    expect(transactions[0].fees).toBe(0.65);
  });

  it("labels an assignment transaction from free-text type/description when there is no instruction field", async () => {
    const provider = transactionsProvider(
      [
        {
          activityId: "txn-assign-1",
          netAmount: 0,
          time: "2026-09-04T21:00:00Z",
          type: "RECEIVE_AND_DELIVER",
          description: "Option Assignment",
          transferItems: [{ instrument: { symbol: "APLD 260904P00023500", assetType: "OPTION" } }],
        },
      ],
      { category: "RECEIVE_AND_DELIVER" },
    );

    const { transactions } = await provider.getTransactions("acct-hash-1", new Date("2026-08-01"), new Date("2026-09-30"));
    expect(transactions[0].action).toBe("Assignment");
  });

  it("returns null (not zero) fees and null option fields when Schwab reports none, rather than guessing", async () => {
    const provider = transactionsProvider(
      [{ activityId: "txn-cash-1", netAmount: 4.12, time: "2026-08-15T14:00:00Z", type: "SOME_UNRECOGNIZED_TYPE", description: "Something Schwab hasn't documented" }],
      { category: "DIVIDEND_OR_INTEREST" },
    );

    const { transactions } = await provider.getTransactions("acct-hash-1", new Date("2026-08-01"), new Date("2026-09-30"));
    expect(transactions[0].action).toBeNull();
    expect(transactions[0].fees).toBeNull();
    expect(transactions[0].optionType).toBeNull();
    expect(transactions[0].strike).toBeNull();
    expect(transactions[0].expiration).toBeNull();
  });

  it("recognizes real bank-interest text with no instruction field, confirmed live against production", async () => {
    const provider = transactionsProvider(
      [{ activityId: "txn-int-1", netAmount: 0.07, time: "2026-08-15T14:00:00Z", type: "DIVIDEND_OR_INTEREST", description: "BANK INT 0000000000 SCHWAB BANK" }],
      { category: "DIVIDEND_OR_INTEREST" },
    );

    const { transactions } = await provider.getTransactions("acct-hash-1", new Date("2026-08-01"), new Date("2026-09-30"));
    expect(transactions[0].action).toBe("Bank Interest");
  });

  it("recognizes a real expiration-removal transaction with no instruction field, confirmed live against production", async () => {
    const provider = transactionsProvider(
      [
        {
          activityId: "txn-exp-1",
          netAmount: 0,
          time: "2026-09-04T21:00:00Z",
          type: "RECEIVE_AND_DELIVER",
          description: "Removed due to Expiration PUT RIOT PLATFORMS INC $17.5 EXP 09/04/26",
          transferItems: [
            { instrument: { symbol: "RIOT 260904P00017500", assetType: "OPTION", putCall: "PUT", strikePrice: 17.5, underlyingSymbol: "RIOT" } },
          ],
        },
      ],
      { category: "RECEIVE_AND_DELIVER" },
    );

    const { transactions } = await provider.getTransactions("acct-hash-1", new Date("2026-08-01"), new Date("2026-09-30"));
    expect(transactions[0].action).toBe("Removed - Expiration");
    expect(transactions[0].underlyingSymbol).toBe("RIOT");
    expect(transactions[0].strike).toBe(17.5);
  });

  it("selects the OPTION transfer item as the traded security even when a CURRENCY_USD cash leg is listed first - confirmed live against production", async () => {
    const provider = transactionsProvider([
      {
        activityId: "txn-sto-cash-first",
        netAmount: 28,
        time: "2026-08-31T14:02:00Z",
        transferItems: [
          { amount: 0.65, price: 1, instrument: { symbol: "CURRENCY_USD", assetType: "CURRENCY" } },
          {
            instruction: "SELL_TO_OPEN",
            amount: 1,
            price: 0.28,
            instrument: { symbol: "APLD 260904P00023500", assetType: "OPTION", putCall: "PUT", strikePrice: 23.5, underlyingSymbol: "APLD", optionExpirationDate: "2026-09-04" },
          },
        ],
      },
    ]);

    const { transactions } = await provider.getTransactions("acct-hash-1", new Date("2026-08-01"), new Date("2026-09-30"));
    expect(transactions[0]).toMatchObject({
      symbol: "APLD 260904P00023500",
      action: "Sell to Open",
      quantity: 1,
      price: 0.28,
      underlyingSymbol: "APLD",
      optionType: "PUT",
      strike: 23.5,
    });
  });

  it("selects the same OPTION transfer item regardless of transferItems order (order must not be assumed)", async () => {
    const optionFirst = transactionsProvider([
      {
        activityId: "txn-order-a",
        netAmount: 28,
        time: "2026-08-31T14:02:00Z",
        transferItems: [
          {
            instruction: "SELL_TO_OPEN",
            amount: 1,
            price: 0.28,
            instrument: { symbol: "APLD 260904P00023500", assetType: "OPTION", putCall: "PUT", strikePrice: 23.5, underlyingSymbol: "APLD" },
          },
          { amount: 0.65, instrument: { symbol: "CURRENCY_USD", assetType: "CURRENCY" } },
        ],
      },
    ]);
    const cashFirst = transactionsProvider([
      {
        activityId: "txn-order-b",
        netAmount: 28,
        time: "2026-08-31T14:02:00Z",
        transferItems: [
          { amount: 0.65, instrument: { symbol: "CURRENCY_USD", assetType: "CURRENCY" } },
          {
            instruction: "SELL_TO_OPEN",
            amount: 1,
            price: 0.28,
            instrument: { symbol: "APLD 260904P00023500", assetType: "OPTION", putCall: "PUT", strikePrice: 23.5, underlyingSymbol: "APLD" },
          },
        ],
      },
    ]);

    const [{ transactions: a }, { transactions: b }] = await Promise.all([
      optionFirst.getTransactions("acct-hash-1", new Date("2026-08-01"), new Date("2026-09-30")),
      cashFirst.getTransactions("acct-hash-1", new Date("2026-08-01"), new Date("2026-09-30")),
    ]);

    expect(a[0]).toMatchObject({ symbol: "APLD 260904P00023500", action: "Sell to Open", price: 0.28 });
    expect(b[0]).toMatchObject({ symbol: "APLD 260904P00023500", action: "Sell to Open", price: 0.28 });
  });

  it("never sends the invalid CASH_IN_OR_CASH_OUT value; fetches TRADE, RECEIVE_AND_DELIVER, and DIVIDEND_OR_INTEREST as three independent requests", async () => {
    const requestedTypes: string[] = [];
    const fetchFn = async (input: URL | string) => {
      const url = new URL(input.toString());
      requestedTypes.push(url.searchParams.get("types") ?? "");
      return new Response("[]", { status: 200 });
    };
    const provider = new SchwabBrokerReadProvider({
      accessToken: "test-token",
      accountNumbers: [{ accountNumberLast4: "1234", hashValue: "acct-hash-1" }],
      fetchFn: fetchFn as typeof fetch,
    });

    await provider.getTransactions("acct-hash-1", new Date("2026-08-01"), new Date("2026-08-31"));

    expect(requestedTypes).toHaveLength(3);
    expect(requestedTypes).not.toContain("CASH_IN_OR_CASH_OUT");
    expect(new Set(requestedTypes)).toEqual(new Set(["TRADE", "RECEIVE_AND_DELIVER", "DIVIDEND_OR_INTEREST"]));
  });

  it("does not let one rejected category erase the others' results", async () => {
    const fetchFn = async (input: URL | string) => {
      const url = new URL(input.toString());
      const types = url.searchParams.get("types");
      if (types === "DIVIDEND_OR_INTEREST") {
        return new Response("Bad Request", { status: 400 });
      }
      if (types === "TRADE") {
        return new Response(JSON.stringify([{ activityId: "trade-1", netAmount: 28, time: "2026-08-28T14:00:00Z" }]), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    };
    const provider = new SchwabBrokerReadProvider({
      accessToken: "test-token",
      accountNumbers: [{ accountNumberLast4: "1234", hashValue: "acct-hash-1" }],
      fetchFn: fetchFn as typeof fetch,
    });

    const result = await provider.getTransactions("acct-hash-1", new Date("2026-08-01"), new Date("2026-08-31"));

    expect(result.categories.DIVIDEND_OR_INTEREST).toEqual({ status: "ERROR" });
    expect(result.categories.TRADE).toEqual({ status: "OK", count: 1 });
    expect(result.categories.RECEIVE_AND_DELIVER).toEqual({ status: "OK", count: 0 });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].id).toBe("trade-1");
  });
});

/**
 * Diagnostic D's real production shape for an option TRADE: four CURRENCY_USD transfer items
 * (cash settlement + fee legs) followed by the OPTION item at index 4 - never at index 0. The
 * option item has NO `instruction` field, only `positionEffect` and a signed `amount`.
 */
function realShapeOptionTransaction(overrides: {
  activityId: string;
  netAmount: number;
  time: string;
  symbol: string;
  positionEffect: string;
  amount: number;
  price: number;
  strikePrice: number;
  underlyingSymbol: string;
  optionExpirationDate: string;
}) {
  const cashLeg = (cost: number) => ({ instrument: { symbol: "CURRENCY_USD", assetType: "CURRENCY" }, cost, feeType: "COMMISSION" });
  return {
    activityId: overrides.activityId,
    netAmount: overrides.netAmount,
    time: overrides.time,
    type: "TRADE",
    transferItems: [
      cashLeg(0.65),
      { instrument: { symbol: "CURRENCY_USD", assetType: "CURRENCY" }, amount: overrides.netAmount },
      cashLeg(0.01),
      { instrument: { symbol: "CURRENCY_USD", assetType: "CURRENCY" }, amount: 0 },
      {
        positionEffect: overrides.positionEffect,
        amount: overrides.amount,
        price: overrides.price,
        instrument: {
          symbol: overrides.symbol,
          assetType: "OPTION",
          type: "VANILLA",
          putCall: "PUT",
          strikePrice: overrides.strikePrice,
          underlyingSymbol: overrides.underlyingSymbol,
          optionExpirationDate: overrides.optionExpirationDate,
        },
      },
    ],
  };
}

describe("SchwabBrokerReadProvider.getTransactions - real production transfer-item shape (Diagnostic D)", () => {
  it("derives Sell to Open from positionEffect=OPENING + negative amount on the real 5-item shape", async () => {
    const provider = transactionsProvider([
      realShapeOptionTransaction({
        activityId: "riot-sto",
        netAmount: 28,
        time: "2026-08-31T14:02:00Z",
        symbol: "RIOT 260904P00017500",
        positionEffect: "OPENING",
        amount: -1,
        price: 0.28,
        strikePrice: 17.5,
        underlyingSymbol: "RIOT",
        optionExpirationDate: "2026-09-04",
      }),
    ]);

    const { transactions } = await provider.getTransactions("acct-hash-1", new Date("2026-08-01"), new Date("2026-09-30"));
    expect(transactions[0]).toMatchObject({
      symbol: "RIOT 260904P00017500",
      action: "Sell to Open",
      underlyingSymbol: "RIOT",
      optionType: "PUT",
      strike: 17.5,
      expiration: new Date("2026-09-04"),
      price: 0.28,
    });
    // Fees are summed from the separate cash/fee legs, never discarded because they aren't the security leg.
    expect(transactions[0].fees).toBe(0.66);
  });

  it("derives Buy to Close from positionEffect=CLOSING + positive amount", async () => {
    const provider = transactionsProvider([
      realShapeOptionTransaction({
        activityId: "corz-btc",
        netAmount: -23,
        time: "2026-08-28T13:32:00Z",
        symbol: "CORZ 260828P00016500",
        positionEffect: "CLOSING",
        amount: 1,
        price: 0.23,
        strikePrice: 16.5,
        underlyingSymbol: "CORZ",
        optionExpirationDate: "2026-08-28",
      }),
    ]);

    const { transactions } = await provider.getTransactions("acct-hash-1", new Date("2026-08-01"), new Date("2026-09-30"));
    expect(transactions[0]).toMatchObject({ action: "Buy to Close", price: 0.23, strike: 16.5, underlyingSymbol: "CORZ" });
  });

  it("derives Buy to Open and Sell to Close for the other two mathematically-consistent combinations", async () => {
    const provider = transactionsProvider([
      realShapeOptionTransaction({
        activityId: "bto-1",
        netAmount: -50,
        time: "2026-08-31T14:00:00Z",
        symbol: "XYZ 260904C00010000",
        positionEffect: "OPENING",
        amount: 1,
        price: 0.5,
        strikePrice: 10,
        underlyingSymbol: "XYZ",
        optionExpirationDate: "2026-09-04",
      }),
    ]);
    const { transactions: btoTx } = await provider.getTransactions("acct-hash-1", new Date("2026-08-01"), new Date("2026-09-30"));
    expect(btoTx[0].action).toBe("Buy to Open");

    const provider2 = transactionsProvider([
      realShapeOptionTransaction({
        activityId: "stc-1",
        netAmount: 50,
        time: "2026-08-31T14:00:00Z",
        symbol: "XYZ 260904C00010000",
        positionEffect: "CLOSING",
        amount: -1,
        price: 0.5,
        strikePrice: 10,
        underlyingSymbol: "XYZ",
        optionExpirationDate: "2026-09-04",
      }),
    ]);
    const { transactions: stcTx } = await provider2.getTransactions("acct-hash-1", new Date("2026-08-01"), new Date("2026-09-30"));
    expect(stcTx[0].action).toBe("Sell to Close");
  });

  it("never guesses when amount is zero or positionEffect is missing - leaves action null", async () => {
    const zeroAmount = transactionsProvider([
      realShapeOptionTransaction({
        activityId: "zero-1",
        netAmount: 0,
        time: "2026-08-31T14:00:00Z",
        symbol: "RIOT 260904P00017500",
        positionEffect: "OPENING",
        amount: 0,
        price: 0.28,
        strikePrice: 17.5,
        underlyingSymbol: "RIOT",
        optionExpirationDate: "2026-09-04",
      }),
    ]);
    const { transactions: zeroTx } = await zeroAmount.getTransactions("acct-hash-1", new Date("2026-08-01"), new Date("2026-09-30"));
    expect(zeroTx[0].action).toBeNull();

    const missingEffect = transactionsProvider([
      {
        activityId: "missing-effect-1",
        netAmount: 28,
        time: "2026-08-31T14:00:00Z",
        type: "TRADE",
        transferItems: [
          {
            amount: -1,
            price: 0.28,
            instrument: { symbol: "RIOT 260904P00017500", assetType: "OPTION", putCall: "PUT", strikePrice: 17.5, underlyingSymbol: "RIOT" },
          },
        ],
      },
    ]);
    const { transactions: missingTx } = await missingEffect.getTransactions("acct-hash-1", new Date("2026-08-01"), new Date("2026-09-30"));
    expect(missingTx[0].action).toBeNull();
  });

  it("locks in the real symbols Matt provided: underlying/expiration/strike/put-call all parse correctly", async () => {
    const fixtures: [string, string, number, string][] = [
      ["RIOT 260904P00017500", "RIOT", 17.5, "2026-09-04"],
      ["APLD 260904P00023500", "APLD", 23.5, "2026-09-04"],
      ["CORZ 260828P00016500", "CORZ", 16.5, "2026-08-28"],
      ["CORZ 260904P00016500", "CORZ", 16.5, "2026-09-04"],
    ];

    for (const [symbol, underlying, strike, expiration] of fixtures) {
      const provider = transactionsProvider([
        realShapeOptionTransaction({
          activityId: `sym-${symbol}`,
          netAmount: 1,
          time: "2026-08-31T14:00:00Z",
          symbol,
          positionEffect: "OPENING",
          amount: -1,
          price: 0.01,
          strikePrice: strike,
          underlyingSymbol: underlying,
          optionExpirationDate: expiration,
        }),
      ]);
      const { transactions } = await provider.getTransactions("acct-hash-1", new Date("2026-08-01"), new Date("2026-09-30"));
      expect(transactions[0]).toMatchObject({ underlyingSymbol: underlying, strike, expiration: new Date(expiration) });
    }
  });

  it("classifies a real expiration-removal transaction as 'Removed - Expiration' even when its option leg ALSO carries positionEffect=CLOSING and a nonzero amount - never mistaken for a genuine Buy to Close", async () => {
    // This is the exact regression: Schwab's expiration-removal transaction administratively
    // closes the option leg out on its own books too (positionEffect=CLOSING, a real amount),
    // which - before this fix - was read by positionEffectActionLabel BEFORE the expiration-
    // removal text check ever ran, misclassifying it as "Buy to Close" and letting a genuinely-
    // expired campaign get silently closed via findClosingEvidence's CLOSE branch instead of
    // staying in Expiration Processing until the NYSE confirmation rule is satisfied.
    const provider = transactionsProvider(
      [
        {
          activityId: "apld-removed",
          netAmount: 0,
          time: "2026-09-04T21:00:00Z",
          type: "RECEIVE_AND_DELIVER",
          description: "Removed due to Expiration PUT APPLIED DIGITAL CORP $23.5 EXP 09/04/26",
          transferItems: [
            {
              positionEffect: "CLOSING",
              amount: 1,
              price: 0,
              instrument: {
                symbol: "APLD 260904P00023500",
                assetType: "OPTION",
                putCall: "PUT",
                strikePrice: 23.5,
                underlyingSymbol: "APLD",
                optionExpirationDate: "2026-09-04",
              },
            },
          ],
        },
      ],
      { category: "RECEIVE_AND_DELIVER" },
    );

    const { transactions } = await provider.getTransactions("acct-hash-1", new Date("2026-08-01"), new Date("2026-09-30"));
    expect(transactions[0].action).toBe("Removed - Expiration");
    expect(transactions[0].action).not.toBe("Buy to Close");
  });
});
