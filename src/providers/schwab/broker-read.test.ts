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
