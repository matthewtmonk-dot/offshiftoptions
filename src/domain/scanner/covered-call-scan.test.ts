import { describe, expect, it } from "vitest";
import type { CampaignEventInput } from "../finance/campaigns";
import type { ScannerRule } from "./scanner";
import type { OptionContractSnapshot } from "@/providers/market-data/types";
import { availableSharesForCoveredCall, evaluateCoveredCallCampaign, maxCoveredCallContracts } from "./covered-call-scan";

const ASOF = new Date("2026-09-01T14:00:00Z");
const ROLL_BUFFER = 3;

/** shares=100, assignment strike=40, no option premium anywhere -> adjustedBasis = exactly 40. */
function assignedEvents(shares: number, strike = 40): CampaignEventInput[] {
  return [{ type: "ASSIGNMENT", occurredAt: "2026-08-28T20:00:00Z", strike, shares }];
}

function callOption(overrides: Partial<OptionContractSnapshot> & { strike: number; expiration: Date }): OptionContractSnapshot {
  return {
    symbol: `SYN ${overrides.expiration.toISOString().slice(0, 10).replace(/-/g, "")}C`,
    underlyingSymbol: "SYN",
    optionType: "CALL",
    bid: 0.3,
    ask: 0.35,
    mark: 0.32,
    openInterest: 200,
    volume: 50,
    ...overrides,
  };
}

function daysFrom(base: Date, days: number) {
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

const NO_RULES: ScannerRule[] = [];

describe("availableSharesForCoveredCall / maxCoveredCallContracts (universe math)", () => {
  it("test 2: 100 shares, no open call -> 1 contract available", () => {
    expect(availableSharesForCoveredCall(100, null)).toBe(100);
    expect(maxCoveredCallContracts(100)).toBe(1);
  });

  it("test 3: 200 shares, no open call -> 2 contracts available", () => {
    expect(availableSharesForCoveredCall(200, null)).toBe(200);
    expect(maxCoveredCallContracts(200)).toBe(2);
  });

  it("test 4: 150 shares -> 1 contract available (never rounds up)", () => {
    expect(maxCoveredCallContracts(150)).toBe(1);
  });

  it("test 5: 200 shares with an existing 1-contract obligation -> only 100 additional shares / 1 more contract available", () => {
    const available = availableSharesForCoveredCall(200, { strike: 45, contracts: 1, expiration: new Date("2026-09-11") });
    expect(available).toBe(100);
    expect(maxCoveredCallContracts(available)).toBe(1);
  });

  it("test 6: 100 shares fully covered by an existing 1-contract call -> 0 available, no naked call", () => {
    const available = availableSharesForCoveredCall(100, { strike: 45, contracts: 1, expiration: new Date("2026-09-11") });
    expect(available).toBe(0);
    expect(maxCoveredCallContracts(available)).toBe(0);
  });

  it("never returns a negative contract count even if shares are somehow over-obligated", () => {
    expect(maxCoveredCallContracts(-50)).toBe(0);
  });
});

describe("evaluateCoveredCallCampaign - universe/eligibility", () => {
  it("test 1: no assigned shares -> NO_SHARES_AVAILABLE", () => {
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c1",
      ticker: "SYN",
      events: [],
      status: "ASSIGNED",
      currentPrice: 41,
      options: [],
      rules: NO_RULES,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.reasonCode).toBe("NO_SHARES_AVAILABLE");
    expect(scan.basisSafeCandidates).toHaveLength(0);
  });

  it("test 6: 100 shares already covered -> FULLY_COVERED, no new call recommendation", () => {
    const events: CampaignEventInput[] = [
      ...assignedEvents(100),
      { type: "SELL_COVERED_CALL", occurredAt: "2026-08-29T14:00:00Z", strike: 45, contracts: 1, premium: 0.3, expiration: "2026-09-11" },
    ];
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c2",
      ticker: "SYN",
      events,
      status: "ASSIGNED",
      currentPrice: 41,
      options: [callOption({ strike: 42, expiration: daysFrom(ASOF, 7) })],
      rules: NO_RULES,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.reasonCode).toBe("FULLY_COVERED");
    expect(scan.availableShares).toBe(0);
  });

  it("PRICE_UNAVAILABLE when shares are available but no current price exists", () => {
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c3",
      ticker: "SYN",
      events: assignedEvents(100),
      status: "ASSIGNED",
      currentPrice: null,
      options: [],
      rules: NO_RULES,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.reasonCode).toBe("PRICE_UNAVAILABLE");
  });

  it("CHAIN_UNAVAILABLE when options fetch itself failed (null, not empty array)", () => {
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c4",
      ticker: "SYN",
      events: assignedEvents(100),
      status: "ASSIGNED",
      currentPrice: 41,
      options: null,
      rules: NO_RULES,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.reasonCode).toBe("CHAIN_UNAVAILABLE");
  });

  it("NO_CALL_CONTRACTS when the chain returned but had no CALL contracts", () => {
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c5",
      ticker: "SYN",
      events: assignedEvents(100),
      status: "ASSIGNED",
      currentPrice: 41,
      options: [{ ...callOption({ strike: 42, expiration: daysFrom(ASOF, 7) }), optionType: "PUT" }],
      rules: NO_RULES,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.reasonCode).toBe("NO_CALL_CONTRACTS");
  });

  it("NO_CONTRACT_WITH_POSITIVE_BID when every call has a zero bid", () => {
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c6",
      ticker: "SYN",
      events: assignedEvents(100),
      status: "ASSIGNED",
      currentPrice: 41,
      options: [callOption({ strike: 42, expiration: daysFrom(ASOF, 7), bid: 0 })],
      rules: NO_RULES,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.reasonCode).toBe("NO_CONTRACT_WITH_POSITIVE_BID");
  });
});

describe("evaluateCoveredCallCampaign - weekly expiration selection", () => {
  it("test 9/12/13: default horizon is 1-13 DTE - a 30 DTE call with a huge premium is excluded, never selected merely for premium", () => {
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c7",
      ticker: "SYN",
      events: assignedEvents(100),
      status: "ASSIGNED",
      currentPrice: 41,
      options: [callOption({ strike: 42, expiration: daysFrom(ASOF, 30), bid: 5 })],
      rules: NO_RULES,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.reasonCode).toBe("NO_WEEKLY_EXPIRATION");
  });

  it("test 10: expiration closest to 7 DTE is chosen among several candidates", () => {
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c8",
      ticker: "SYN",
      events: assignedEvents(100),
      status: "ASSIGNED",
      currentPrice: 41,
      options: [
        callOption({ strike: 42, expiration: daysFrom(ASOF, 2) }),
        callOption({ strike: 43, expiration: daysFrom(ASOF, 8) }), // closest to 7
        callOption({ strike: 44, expiration: daysFrom(ASOF, 13) }),
      ],
      rules: NO_RULES,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.selectedExpiration).toBe(daysFrom(ASOF, 8).toISOString().slice(0, 10));
  });

  it("test 11: equal distance from 7 DTE prefers the LATER expiration", () => {
    // 4 DTE and 10 DTE are both exactly 3 away from the 7-DTE target.
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c9",
      ticker: "SYN",
      events: assignedEvents(100),
      status: "ASSIGNED",
      currentPrice: 41,
      options: [callOption({ strike: 42, expiration: daysFrom(ASOF, 4) }), callOption({ strike: 43, expiration: daysFrom(ASOF, 10) })],
      rules: NO_RULES,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.selectedExpiration).toBe(daysFrom(ASOF, 10).toISOString().slice(0, 10));
  });

  it("a user-enabled hard dte rule is authoritative over the default weekly horizon, and reports the configured-range reason when empty", () => {
    const rules: ScannerRule[] = [{ key: "dte", name: "DTE", operator: "BETWEEN", desired: [20, 25] }];
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c10",
      ticker: "SYN",
      events: assignedEvents(100),
      status: "ASSIGNED",
      currentPrice: 41,
      options: [callOption({ strike: 42, expiration: daysFrom(ASOF, 7) })],
      rules,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.reasonCode).toBe("NO_EXPIRATIONS_IN_CONFIGURED_RANGE");
  });
});

describe("evaluateCoveredCallCampaign - basis safety", () => {
  it("test 14/15: strikes above and exactly at adjusted basis (40) are both basis-safe", () => {
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c11",
      ticker: "SYN",
      events: assignedEvents(100, 40),
      status: "ASSIGNED",
      currentPrice: 41,
      options: [callOption({ strike: 40, expiration: daysFrom(ASOF, 7) }), callOption({ strike: 41, expiration: daysFrom(ASOF, 7) })],
      rules: NO_RULES,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.adjustedBasis).toBe(40);
    expect(scan.basisSafeCandidates.map((c) => c.strike).sort()).toEqual([40, 41]);
    expect(scan.belowBasisCandidates).toHaveLength(0);
    for (const candidate of scan.basisSafeCandidates) {
      expect(candidate.strikeVsBasis?.belowBasis).toBe(false);
    }
  });

  it("test 16/17: a strike below adjusted basis is routed to belowBasisCandidates (never basisSafe) and carries the warning flag", () => {
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c12",
      ticker: "SYN",
      events: assignedEvents(100, 40),
      status: "ASSIGNED",
      currentPrice: 41,
      options: [callOption({ strike: 38, expiration: daysFrom(ASOF, 7) })],
      rules: NO_RULES,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.basisSafeCandidates).toHaveLength(0);
    expect(scan.belowBasisCandidates).toHaveLength(1);
    expect(scan.belowBasisCandidates[0].strikeVsBasis?.belowBasis).toBe(true);
    expect(scan.belowBasisCandidates[0].strikeVsBasis?.differenceDollars).toBe(-2);
  });

  it("test 18: no at/above-basis strike -> NO_BASIS_SAFE_WEEKLY_CALL, even though below-basis alternatives exist", () => {
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c13",
      ticker: "SYN",
      events: assignedEvents(100, 40),
      status: "ASSIGNED",
      currentPrice: 41,
      options: [callOption({ strike: 38, expiration: daysFrom(ASOF, 7) }), callOption({ strike: 39, expiration: daysFrom(ASOF, 7) })],
      rules: NO_RULES,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.reasonCode).toBe("NO_BASIS_SAFE_WEEKLY_CALL");
    expect(scan.belowBasisCandidates.length).toBeGreaterThan(0);
    // Below-basis alternatives are closest-to-basis first (descending strike).
    expect(scan.belowBasisCandidates[0].strike).toBe(39);
  });

  it("test 19: adjusted basis unavailable (shares already partially sold) -> candidates route to unknownBasisCandidates, never fabricated as basis-safe", () => {
    const events: CampaignEventInput[] = [
      ...assignedEvents(200, 40),
      { type: "STOCK_SALE", occurredAt: "2026-08-30T14:00:00Z", shares: 50, underlyingPrice: 42 },
    ];
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c14",
      ticker: "SYN",
      events,
      status: "ASSIGNED",
      currentPrice: 41,
      options: [callOption({ strike: 42, expiration: daysFrom(ASOF, 7) })],
      rules: NO_RULES,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.adjustedBasis).toBeNull();
    expect(scan.basisSafeCandidates).toHaveLength(0);
    expect(scan.belowBasisCandidates).toHaveLength(0);
    expect(scan.reasonCode).toBeNull(); // never claims "no basis-safe call" when basis itself is unknown
    expect(scan.unknownBasisCandidates.length).toBeGreaterThan(0);
    expect(scan.unknownBasisCandidates[0].strikeVsBasis).toBeNull();
  });
});

describe("evaluateCoveredCallCampaign - direction, metrics, and campaign-outcome math", () => {
  it("test 20/21: current price below strike -> OTM (GREEN), correct direction", () => {
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c15",
      ticker: "SYN",
      events: assignedEvents(100, 40),
      status: "ASSIGNED",
      currentPrice: 35,
      options: [callOption({ strike: 50, expiration: daysFrom(ASOF, 7) })],
      rules: NO_RULES,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.basisSafeCandidates[0].distanceStatus?.color).toBe("GREEN");
  });

  it("test 22: current price above strike -> ITM (RED)", () => {
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c16",
      ticker: "SYN",
      events: assignedEvents(100, 40),
      status: "ASSIGNED",
      currentPrice: 45,
      options: [callOption({ strike: 42, expiration: daysFrom(ASOF, 7) })],
      rules: NO_RULES,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.basisSafeCandidates[0].distanceStatus?.color).toBe("RED");
  });

  it("test 23/24: premium per contract = bid * 100", () => {
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c17",
      ticker: "SYN",
      events: assignedEvents(100, 40),
      status: "ASSIGNED",
      currentPrice: 41,
      options: [callOption({ strike: 42, expiration: daysFrom(ASOF, 7), bid: 0.45 })],
      rules: NO_RULES,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.basisSafeCandidates[0].premiumPerContract).toBe(45);
  });

  it("test 25: strike-vs-basis math is correct ($ and %)", () => {
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c18",
      ticker: "SYN",
      events: assignedEvents(100, 40),
      status: "ASSIGNED",
      currentPrice: 41,
      options: [callOption({ strike: 44, expiration: daysFrom(ASOF, 7) })],
      rules: NO_RULES,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.basisSafeCandidates[0].strikeVsBasis).toEqual({ differenceDollars: 4, differencePct: 10, belowBasis: false });
  });

  it("test 26: effective exit price = strike + bid", () => {
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c19",
      ticker: "SYN",
      events: assignedEvents(100, 40),
      status: "ASSIGNED",
      currentPrice: 41,
      options: [callOption({ strike: 42, expiration: daysFrom(ASOF, 7), bid: 0.5 })],
      rules: NO_RULES,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.basisSafeCandidates[0].effectiveExitPrice).toBe(42.5);
  });

  it("estimated campaign outcome if called away is derived via the real summarizeCampaign (fully covered lot -> a concrete, known number)", () => {
    // 100 shares assigned at 40 (adjustedBasis 40), sell 1 call at strike 42 for 0.50 premium,
    // then called away at 42: realizedPL = call premium (50) + stock gain (42-40)*100 = 250.
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c20",
      ticker: "SYN",
      events: assignedEvents(100, 40),
      status: "ASSIGNED",
      currentPrice: 41,
      options: [callOption({ strike: 42, expiration: daysFrom(ASOF, 7), bid: 0.5 })],
      rules: NO_RULES,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.basisSafeCandidates[0].estimatedCampaignPLIfCalledAway).toBe(250);
  });

  it("test 13 distinction: does not overstate loss - a below-basis strike's called-away projection can still show the true (possibly positive) number, never a hardcoded negative label", () => {
    const events: CampaignEventInput[] = [
      // Put premium of 1.80/share -> adjustedBasis = (4000 - 180) / 100 = 38.20, keeping the $38
      // candidate strike below basis, while still being enough (plus this call's own premium) to
      // keep the overall projected outcome positive despite that.
      { type: "SELL_PUT", occurredAt: "2026-08-01T14:00:00Z", strike: 40, contracts: 1, premium: 1.8 },
      ...assignedEvents(100, 40),
    ];
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c21",
      ticker: "SYN",
      events,
      status: "ASSIGNED",
      currentPrice: 37,
      options: [callOption({ strike: 38, expiration: daysFrom(ASOF, 7), bid: 0.5 })],
      rules: NO_RULES,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.belowBasisCandidates[0].strikeVsBasis?.belowBasis).toBe(true);
    // Despite the strike being below basis, the large put premium keeps the projected outcome positive.
    expect(scan.belowBasisCandidates[0].estimatedCampaignPLIfCalledAway).toBeGreaterThan(0);
  });
});

describe("evaluateCoveredCallCampaign - liquidity rule reuse", () => {
  it("test 27: an enabled openInterest rule fails a thin contract", () => {
    const rules: ScannerRule[] = [{ key: "openInterest", name: "Open Interest", operator: "GTE", desired: 100 }];
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c22",
      ticker: "SYN",
      events: assignedEvents(100, 40),
      status: "ASSIGNED",
      currentPrice: 41,
      options: [callOption({ strike: 42, expiration: daysFrom(ASOF, 7), openInterest: 5 })],
      rules,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.basisSafeCandidates[0].liquidityPass).toBe(false);
    expect(scan.basisSafeCandidates[0].liquidityCriteria.find((c) => c.key === "openInterest")?.status).toBe("FAIL");
  });

  it("test 28: an enabled optionBid minimum is respected", () => {
    const rules: ScannerRule[] = [{ key: "optionBid", name: "Option Bid", operator: "GTE", desired: 0.5 }];
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c23",
      ticker: "SYN",
      events: assignedEvents(100, 40),
      status: "ASSIGNED",
      currentPrice: 41,
      options: [callOption({ strike: 42, expiration: daysFrom(ASOF, 7), bid: 0.1 })],
      rules,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.basisSafeCandidates[0].liquidityPass).toBe(false);
  });

  it("test 29: UNKNOWN liquidity (missing OI) stays UNKNOWN, never a fabricated PASS/FAIL, and never excludes the candidate", () => {
    const rules: ScannerRule[] = [{ key: "openInterest", name: "Open Interest", operator: "GTE", desired: 100 }];
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c24",
      ticker: "SYN",
      events: assignedEvents(100, 40),
      status: "ASSIGNED",
      currentPrice: 41,
      options: [callOption({ strike: 42, expiration: daysFrom(ASOF, 7), openInterest: undefined })],
      rules,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.basisSafeCandidates).toHaveLength(1);
    expect(scan.basisSafeCandidates[0].liquidityCriteria.find((c) => c.key === "openInterest")?.status).toBe("UNKNOWN");
    expect(scan.basisSafeCandidates[0].liquidityPass).toBe(true); // UNKNOWN never excludes
  });

  it("a disabled liquidity rule (absent from rules) never appears in liquidityCriteria and never excludes", () => {
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c25",
      ticker: "SYN",
      events: assignedEvents(100, 40),
      status: "ASSIGNED",
      currentPrice: 41,
      options: [callOption({ strike: 42, expiration: daysFrom(ASOF, 7), bid: 0.01, openInterest: 0 })],
      rules: NO_RULES,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.basisSafeCandidates[0].liquidityCriteria).toHaveLength(0);
    expect(scan.basisSafeCandidates[0].liquidityPass).toBe(true);
  });
});

describe("evaluateCoveredCallCampaign - earnings reuse", () => {
  it("reuses the earningsDistance rule when enabled, evaluating the real reported distance", () => {
    const rules: ScannerRule[] = [{ key: "earningsDistance", name: "Earnings Distance", operator: "GTE", desired: 10 }];
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c26",
      ticker: "SYN",
      events: assignedEvents(100, 40),
      status: "ASSIGNED",
      currentPrice: 41,
      options: [callOption({ strike: 42, expiration: daysFrom(ASOF, 7) })],
      rules,
      earnings: { daysUntilReport: 3, reportDate: "2026-09-04" },
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.earningsDistance).toBe(3);
    expect(scan.earningsCriterion?.status).toBe("FAIL");
  });

  it("shows UNKNOWN (never a fabricated PASS) when earnings data is unavailable but the rule is enabled", () => {
    const rules: ScannerRule[] = [{ key: "earningsDistance", name: "Earnings Distance", operator: "GTE", desired: 10 }];
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c27",
      ticker: "SYN",
      events: assignedEvents(100, 40),
      status: "ASSIGNED",
      currentPrice: 41,
      options: [callOption({ strike: 42, expiration: daysFrom(ASOF, 7) })],
      rules,
      earnings: null,
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.earningsDistance).toBeNull();
    expect(scan.earningsCriterion?.status).toBe("UNKNOWN");
  });

  it("is null (not UNKNOWN) when the earningsDistance rule itself is disabled", () => {
    const scan = evaluateCoveredCallCampaign({
      campaignId: "c28",
      ticker: "SYN",
      events: assignedEvents(100, 40),
      status: "ASSIGNED",
      currentPrice: 41,
      options: [callOption({ strike: 42, expiration: daysFrom(ASOF, 7) })],
      rules: NO_RULES,
      earnings: { daysUntilReport: 3, reportDate: "2026-09-04" },
      rollBufferPercent: ROLL_BUFFER,
      asOf: ASOF,
    });
    expect(scan.earningsCriterion).toBeNull();
  });
});
