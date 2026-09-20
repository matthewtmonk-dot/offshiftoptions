import { describe, expect, it } from "vitest";
import type { BrokerPosition } from "@/providers/broker-read/types";
import {
  classifyBrokerPosition,
  describeBrokerPositionForDisplay,
  summarizeCampaignExposure,
  summarizeCspSecuredCapital,
  type CampaignExposureInput,
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

describe("summarizeCampaignExposure (Ticket 5: separate exposure types)", () => {
  function campaign(overrides: Partial<CampaignExposureInput> = {}): CampaignExposureInput {
    return { status: "OPEN", currentCollateralCommitted: null, stockCost: 0, hasOpenCoveredCall: false, ...overrides };
  }

  it("test 13: an ASSIGNED campaign with no current put contributes zero to securedPutCollateral, and its share basis is tracked separately", () => {
    const summary = summarizeCampaignExposure([campaign({ status: "ASSIGNED", currentCollateralCommitted: null, stockCost: 3000 })]);
    expect(summary.securedPutCollateral).toBe(0); // the real bug this fixes: no historical put collateral leaks in here
    expect(summary.assignedCampaignCount).toBe(1);
    expect(summary.assignedShareCapital).toBe(3000);
    expect(summary.assignedCampaignsWithKnownBasis).toBe(1);
    expect(summary.assignedCampaignsWithCoveredCall).toBe(0);
  });

  it("test 14: an ASSIGNED campaign with an existing covered call is counted, without fabricating a valuation for it", () => {
    const summary = summarizeCampaignExposure([campaign({ status: "ASSIGNED", stockCost: 4000, hasOpenCoveredCall: true })]);
    expect(summary.assignedCampaignsWithCoveredCall).toBe(1);
    expect(summary.assignedShareCapital).toBe(4000); // still just the cost basis, never a call-adjusted mark-to-market
  });

  it("test 15: mixed exposure - an open CSP's collateral, an assigned campaign's basis, and an unsupported/incomplete campaign all stay distinct and additive where valid", () => {
    const summary = summarizeCampaignExposure([
      campaign({ status: "OPEN", currentCollateralCommitted: 1650 }), // CORZ-like open put
      campaign({ status: "ASSIGNED", stockCost: 3000 }), // assigned, no call yet
      campaign({ status: "ASSIGNED", stockCost: 4000, hasOpenCoveredCall: true }), // assigned + covered call
      campaign({ status: "OPEN", currentCollateralCommitted: null }), // evidence incomplete - contributes nothing, never a fabricated zero-as-collateral claim
    ]);
    expect(summary.securedPutCollateral).toBe(1650); // only the genuinely open put's collateral
    expect(summary.assignedCampaignCount).toBe(2);
    expect(summary.assignedShareCapital).toBe(7000); // 3000 + 4000, never blended with the 1650 above
    expect(summary.assignedCampaignsWithCoveredCall).toBe(1);
  });

  it("never lets an ASSIGNED campaign's real exposure disappear when its basis is unknown - counted, but flagged as unknown rather than zero", () => {
    const summary = summarizeCampaignExposure([campaign({ status: "ASSIGNED", stockCost: 0 })]);
    expect(summary.assignedCampaignCount).toBe(1);
    expect(summary.assignedShareCapital).toBe(0);
    expect(summary.assignedCampaignsWithKnownBasis).toBe(0); // the caller can tell "known $0" apart from "no data" via this count
  });

  it("a CLOSED campaign never contributes to either secured collateral or assigned capital", () => {
    const summary = summarizeCampaignExposure([campaign({ status: "CLOSED", currentCollateralCommitted: 2000, stockCost: 5000 })]);
    expect(summary.securedPutCollateral).toBe(0);
    expect(summary.assignedCampaignCount).toBe(0);
    expect(summary.assignedShareCapital).toBe(0);
  });

  it("returns all zeros for an empty campaign list", () => {
    const summary = summarizeCampaignExposure([]);
    expect(summary).toEqual({
      securedPutCollateral: 0,
      assignedCampaignCount: 0,
      assignedShareCapital: 0,
      assignedCampaignsWithKnownBasis: 0,
      assignedCampaignsWithCoveredCall: 0,
    });
  });
});
