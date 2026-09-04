import { describe, expect, it } from "vitest";
import type { BrokerPosition } from "@/providers/broker-read/types";
import {
  classifyBrokerPosition,
  computeOpenPositionsCount,
  describeBrokerPositionForDisplay,
  summarizeCspSecuredCapital,
} from "./brokerPositions";

function shortPut(overrides: Partial<BrokerPosition> = {}): BrokerPosition {
  return {
    accountId: "acct-1",
    symbol: "RIOT 260904P00017500",
    quantity: -1,
    marketValue: -16,
    ...overrides,
  };
}

describe("classifyBrokerPosition", () => {
  it("identifies a short put from the OCC symbol when Schwab fields are absent", () => {
    const classified = classifyBrokerPosition(shortPut());
    expect(classified).toMatchObject({ kind: "SHORT_PUT", optionType: "PUT", strike: 17.5, underlying: "RIOT" });
  });

  it("prefers Schwab's own putCall/strikePrice/assetType fields when present", () => {
    const classified = classifyBrokerPosition(
      shortPut({ symbol: "RIOT  260904P00017500", assetType: "OPTION", putCall: "PUT", strikePrice: 17.5, underlyingSymbol: "RIOT" }),
    );
    expect(classified.kind).toBe("SHORT_PUT");
    expect(classified.strike).toBe(17.5);
  });

  it("does not classify a long put as a short put", () => {
    const classified = classifyBrokerPosition(shortPut({ quantity: 1, marketValue: 16 }));
    expect(classified.kind).toBe("OTHER_OPTION");
  });

  it("does not classify a short call as a short put", () => {
    const classified = classifyBrokerPosition(shortPut({ symbol: "RIOT 260904C00017500" }));
    expect(classified.kind).toBe("OTHER_OPTION");
    expect(classified.optionType).toBe("CALL");
  });

  it("classifies a plain equity position as EQUITY_OR_OTHER, never as an option", () => {
    const classified = classifyBrokerPosition({ accountId: "acct-1", symbol: "RIOT", quantity: 100, marketValue: 1500 });
    expect(classified.kind).toBe("EQUITY_OR_OTHER");
  });

  it("classifies an unparseable option-like position as UNKNOWN rather than guessing", () => {
    const classified = classifyBrokerPosition(shortPut({ symbol: "RIOT SOMETHING WEIRD", assetType: "OPTION", putCall: null }));
    expect(classified.kind).toBe("UNKNOWN");
  });
});

describe("summarizeCspSecuredCapital", () => {
  it("sums strike x 100 x |short contracts| for Matt's three real short puts", () => {
    const positions: BrokerPosition[] = [
      shortPut({ symbol: "RIOT 260904P00017500", quantity: -1 }),
      shortPut({ symbol: "APLD 260904P00023500", quantity: -1 }),
      shortPut({ symbol: "CORZ 260904P00016500", quantity: -1 }),
    ];
    const summary = summarizeCspSecuredCapital(positions);
    expect(summary.total).toBe(17.5 * 100 + 23.5 * 100 + 16.5 * 100);
    expect(summary.hasUnknown).toBe(false);
  });

  it("scales by contract count for a multi-contract short put", () => {
    const summary = summarizeCspSecuredCapital([shortPut({ quantity: -3 })]);
    expect(summary.total).toBe(17.5 * 100 * 3);
  });

  it("excludes long puts from CSP collateral", () => {
    const summary = summarizeCspSecuredCapital([shortPut({ quantity: 1, marketValue: 16 })]);
    expect(summary.total).toBe(0);
  });

  it("excludes calls from CSP collateral", () => {
    const summary = summarizeCspSecuredCapital([shortPut({ symbol: "RIOT 260904C00017500" })]);
    expect(summary.total).toBe(0);
  });

  it("excludes equity/stock positions from CSP collateral", () => {
    const summary = summarizeCspSecuredCapital([{ accountId: "acct-1", symbol: "RIOT", quantity: -100, marketValue: -1500 }]);
    expect(summary.total).toBe(0);
  });

  it("never invents collateral for an unclassifiable position and flags it instead", () => {
    const summary = summarizeCspSecuredCapital([shortPut({ symbol: "RIOT SOMETHING WEIRD", assetType: "OPTION", putCall: null })]);
    expect(summary.total).toBe(0);
    expect(summary.hasUnknown).toBe(true);
  });
});

describe("computeOpenPositionsCount", () => {
  it("is not zero when there are zero OSO campaigns but Schwab reports open positions (the reported bug)", () => {
    const positions: BrokerPosition[] = [
      shortPut({ symbol: "RIOT 260904P00017500" }),
      shortPut({ symbol: "APLD 260904P00023500" }),
      shortPut({ symbol: "CORZ 260904P00016500" }),
    ];
    expect(computeOpenPositionsCount(0, positions)).toBe(3);
  });

  it("adds campaigns and broker positions together (documented interim non-deduplicated behavior)", () => {
    expect(computeOpenPositionsCount(2, [shortPut()])).toBe(3);
  });

  it("returns just the campaign count when there are no broker positions", () => {
    expect(computeOpenPositionsCount(4, [])).toBe(4);
  });
});

describe("describeBrokerPositionForDisplay", () => {
  it("renders a short put as human-readable ticker/date/strike with neutral 'Short N put' terminology", () => {
    const display = describeBrokerPositionForDisplay(shortPut());
    expect(display.title).toBe("RIOT");
    expect(display.detailLine).toBe("Sep 4, 2026 · $17.50 Put");
    expect(display.quantityLabel).toBe("Short 1 put");
  });

  it("pluralizes for a multi-contract position", () => {
    const display = describeBrokerPositionForDisplay(shortPut({ quantity: -2 }));
    expect(display.quantityLabel).toBe("Short 2 puts");
  });

  it("uses share terminology for an equity position", () => {
    const display = describeBrokerPositionForDisplay({ accountId: "acct-1", symbol: "RIOT", quantity: 100, marketValue: 1500 });
    expect(display.quantityLabel).toBe("100 sh");
    expect(display.detailLine).toBeNull();
  });

  it("shows a short option's liability as a positive 'Cost to close', never a signed loss - being short is not automatically a loss", () => {
    const display = describeBrokerPositionForDisplay(shortPut({ quantity: -1, marketValue: -16.5 }));
    expect(display.valueLabel).toBe("Cost to close");
    expect(display.value).toBe(16.5);
  });

  it("labels a long option or equity position as plain 'Market value', unmodified", () => {
    const longOption = describeBrokerPositionForDisplay(shortPut({ quantity: 1, marketValue: 16.5 }));
    expect(longOption.valueLabel).toBe("Market value");
    expect(longOption.value).toBe(16.5);

    const equity = describeBrokerPositionForDisplay({ accountId: "acct-1", symbol: "RIOT", quantity: 100, marketValue: 1500 });
    expect(equity.valueLabel).toBe("Market value");
    expect(equity.value).toBe(1500);
  });
});
