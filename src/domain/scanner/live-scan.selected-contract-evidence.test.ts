import { describe, expect, it } from "vitest";
import type { MarketDataProvider, OptionContractSnapshot } from "@/providers/market-data/types";
import { evaluateLiveMarketScan, OPTION_CHAIN_ENRICHMENT_LIMIT, type LiveScanEarningsLookup, type LiveScanTechnicalLookup } from "./live-scan";
import { classifyReadiness } from "./scanner";
import { SCANNER_RULE_DEFINITIONS, GATING_RULE_KEYS } from "./profile";
import type { ScannerRule } from "./scanner";

// Ticket 8: selected-contract evidence must always trace to exactly one option contract, and the
// premium/ROR/earnings/quote-timing ambiguities the audit found must be explicit in the data.

const asOf = new Date("2026-09-16T14:00:00Z"); // a real Wednesday - see marketCalendar.test.ts
const rules: ScannerRule[] = SCANNER_RULE_DEFINITIONS.filter((rule) => rule.defaultEnabled).map((rule) => ({
  key: rule.key, name: rule.name, operator: rule.operator, desired: rule.defaultDesired,
}));
const ready: LiveScanTechnicalLookup = { state: "READY", rsi: 30, bbLower: 18, bbMiddle: 23, bbUpper: 28 };
const earnings: LiveScanEarningsLookup = { daysUntilReport: 36, reportDate: "2026-10-22" };

function put(overrides: Partial<OptionContractSnapshot> = {}): OptionContractSnapshot {
  return {
    symbol: "P-DEFAULT", underlyingSymbol: "TEST", optionType: "PUT", strike: 19,
    expiration: new Date(Date.UTC(2026, 8, 23, 20)), // 7 DTE from asOf
    bid: 0.25, ask: 0.30, mark: 0.275, openInterest: 200, volume: 41, delta: -0.2,
    ...overrides,
  };
}

function fixture(
  optionsFor: (symbol: string) => OptionContractSnapshot[],
  tickers: string[],
  opts: { failChainFor?: Set<string>; asOf?: Date; earningsDays?: number | null } = {},
) {
  const chainCalls: string[] = [];
  const provider: MarketDataProvider = {
    async getQuote(symbol) { return { symbol, price: 20, volume: 100_000, asOf: opts.asOf ?? asOf }; },
    async getPriceHistory() { throw new Error("Unexpected live history fetch"); },
    async getOptionChain(symbol) {
      chainCalls.push(symbol);
      if (opts.failChainFor?.has(symbol)) {
        throw new Error("chain unavailable");
      }
      return optionsFor(symbol);
    },
    async getInstrument(symbol) { return { symbol, description: symbol, assetType: "EQUITY" }; },
    async getMarketHours() { return { isOpen: true }; },
  };
  const technicalCache = new Map<string, LiveScanTechnicalLookup>(tickers.map((ticker) => [ticker, ready]));
  const earningsLookup =
    opts.earningsDays === null
      ? new Map<string, LiveScanEarningsLookup>()
      : new Map(tickers.map((ticker) => [ticker, { ...earnings, daysUntilReport: opts.earningsDays ?? earnings.daysUntilReport }]));
  return { provider, chainCalls, technicalCache, earningsLookup, universe: tickers, rules, asOf: opts.asOf ?? asOf };
}

describe("selected-contract evidence: premium basis (Ticket 8)", () => {
  it("1. a bid that differs materially from mark/midpoint keeps both explicit, and ROR uses the intended bid value", async () => {
    const row = (await evaluateLiveMarketScan(fixture(() => [put({ bid: 0.20, ask: 0.30, mark: 0.60 })], ["TEST"])))[0];

    expect(row.values.premium).toBe(0.60); // mark/midpoint estimate
    expect(row.values.premiumBasis).toBe("MARK_MIDPOINT");
    expect(row.values.bidProceedsPerContract).toBe(20); // 0.20 * 100 - the real bid-based figure
    expect(row.values.rorBasis).toBe("BID");
    // ror must be computed from the bid (0.20/19), never from the mark (0.60) or premium.
    expect(row.values.ror).toBeCloseTo((0.2 / 19) * 100, 1);
  });

  it("distinguishes bid and mark even when both are shown for the same contract", async () => {
    const row = (await evaluateLiveMarketScan(fixture(() => [put({ bid: 1, ask: 1.2, mark: 1.1 })], ["TEST"])))[0];
    expect(row.values.optionBid).toBe(1);
    expect(row.values.premium).toBe(1.1);
    expect(row.values.bidProceedsPerContract).toBe(100);
    expect(row.values.optionBid).not.toBe(row.values.premium);
  });
});

describe("selected-contract evidence: same-contract consistency (Ticket 8)", () => {
  it("2. expiration/strike/bid/ROR/liquidity all come from the same selected contract", async () => {
    const winner = put({ symbol: "WIN", strike: 19, bid: 0.5, ask: 0.55, mark: 0.525, openInterest: 777, volume: 88, delta: -0.25 });
    const loser = put({ symbol: "LOSE", strike: 15, bid: 0.05, ask: 0.5, mark: 0.2, openInterest: 5, volume: 1, delta: -0.05 });
    const row = (await evaluateLiveMarketScan(fixture(() => [loser, winner], ["TEST"])))[0];

    expect(row.values.optionSymbol).toBe("WIN");
    expect(row.values.strike).toBe(19);
    expect(row.values.optionBid).toBe(0.5);
    expect(row.values.openInterest).toBe(777);
    expect(row.values.optionVolume).toBe(88);
    expect(row.values.delta).toBeCloseTo(0.25, 6);
    expect(row.values.bidProceedsPerContract).toBe(50);
  });

  it("3. a different strike's data is never mixed into the selected contract's output", async () => {
    // Same expiration, two strikes - the worse-liquidity/lower-scoring strike must not leak any
    // of its own bid/OI/volume into the winning strike's row.
    const good = put({ symbol: "GOOD-19", strike: 19, bid: 0.4, openInterest: 500, volume: 60 });
    const bad = put({ symbol: "BAD-17", strike: 17, bid: 0.05, openInterest: 3, volume: 0 });
    const row = (await evaluateLiveMarketScan(fixture(() => [bad, good], ["TEST"])))[0];

    expect(row.values.strike).toBe(19);
    expect(row.values.optionBid).toBe(0.4);
    expect(row.values.openInterest).toBe(500);
    expect(row.values.optionBid).not.toBe(0.05);
    expect(row.values.openInterest).not.toBe(3);
  });

  it("4. a different expiration's data is never mixed into the selected contract's output", async () => {
    const nearWeekly = put({ symbol: "NEAR-7", expiration: new Date(Date.UTC(2026, 8, 23, 20)), bid: 0.3, openInterest: 300 }); // 7 DTE
    const farWeekly = put({ symbol: "FAR-30", expiration: new Date(Date.UTC(2026, 9, 16, 20)), bid: 0.9, openInterest: 900 }); // ~30 DTE, outside default horizon
    const row = (await evaluateLiveMarketScan(fixture(() => [nearWeekly, farWeekly], ["TEST"])))[0];

    expect(row.values.dte).toBe(7);
    expect(row.values.optionBid).toBe(0.3);
    expect(row.values.openInterest).toBe(300);
    expect(row.values.optionBid).not.toBe(0.9);
  });

  it("5. a zero bid is structurally excluded, never selected with a fabricated premium", async () => {
    const row = (await evaluateLiveMarketScan(fixture(() => [put({ bid: 0 })], ["TEST"])))[0];
    expect(row.values.contractReasonCode).toBe("NO_CONTRACT_WITH_POSITIVE_BID");
    expect(row.values.optionBid).toBeNull();
    expect(row.values.bidProceedsPerContract).toBeNull();
  });

  it("6. a missing/invalid (non-finite) bid is excluded the same way a zero bid is", async () => {
    const row = (await evaluateLiveMarketScan(fixture(() => [put({ bid: NaN })], ["TEST"])))[0];
    expect(row.values.contractReasonCode).toBe("NO_CONTRACT_WITH_POSITIVE_BID");
    expect(row.values.optionBid).toBeNull();
  });

  it("7. a missing/invalid (non-finite) ask is excluded the same way", async () => {
    const row = (await evaluateLiveMarketScan(fixture(() => [put({ ask: NaN })], ["TEST"])))[0];
    expect(row.values.contractReasonCode).toBe("NO_CONTRACT_WITH_POSITIVE_BID");
  });

  it("8. a wide spread still selects the contract honestly (a gating FAIL, not an exclusion or a hidden number)", async () => {
    const row = (await evaluateLiveMarketScan(fixture(() => [put({ bid: 0.10, ask: 2.00, mark: 1.05 })], ["TEST"])))[0];
    expect(row.values.optionBid).toBe(0.10);
    expect(row.values.optionAsk).toBe(2.00);
    expect(row.values.spreadPercent).toBeGreaterThan(100);
    expect(GATING_RULE_KEYS.has("spreadPercent")).toBe(true);
    expect(row.summary.status).toBe("FAIL");
  });

  it("9. a missing delta reads as null, never a fabricated/zero value", async () => {
    const row = (await evaluateLiveMarketScan(fixture(() => [put({ delta: undefined })], ["TEST"])))[0];
    expect(row.values.delta).toBeNull();
  });
});

describe("selected-contract evidence: earnings timing (Ticket 8)", () => {
  // The earningsDistance rule (LST Core default: GTE 10 days, gating) would otherwise exclude a
  // 3-day-to-earnings candidate from the option-chain shortlist entirely (a known stock-level
  // FAIL never competes for the budget) - disabled here to exercise the disclosure itself, which
  // matters most precisely when a user has turned that protection off.
  const rulesWithoutEarningsGate = rules.filter((rule) => rule.key !== "earningsDistance");

  it("10. earnings before this contract's expiration is disclosed explicitly", async () => {
    // dte=7 from asOf; earnings in 3 days falls squarely within the holding period.
    const input = fixture(() => [put()], ["TEST"], { earningsDays: 3 });
    const row = (await evaluateLiveMarketScan({ ...input, rules: rulesWithoutEarningsGate }))[0];
    expect(row.values.dte).toBe(7);
    expect(row.values.earningsDistance).toBe(3);
    expect(row.values.earningsWithinHoldingPeriod).toBe(true);
  });

  it("11. earnings after this contract's expiration is disclosed as such", async () => {
    const input = fixture(() => [put()], ["TEST"], { earningsDays: 30 });
    const row = (await evaluateLiveMarketScan({ ...input, rules: rulesWithoutEarningsGate }))[0];
    expect(row.values.dte).toBe(7);
    expect(row.values.earningsDistance).toBe(30);
    expect(row.values.earningsWithinHoldingPeriod).toBe(false);
  });

  it("12. an unavailable earnings date never invents a holding-period answer", async () => {
    const input = fixture(() => [put()], ["TEST"], { earningsDays: null });
    const row = (await evaluateLiveMarketScan({ ...input, rules: rulesWithoutEarningsGate }))[0];
    expect(row.values.earningsDate).toBeNull();
    expect(row.values.earningsDistance).toBeNull();
    expect(row.values.earningsWithinHoldingPeriod).toBeNull();
  });
});

describe("selected-contract evidence: quote vs. retrieval timing (Ticket 8)", () => {
  it("13. a quote fetched while the market was closed (weekend) is flagged, never presented as live", async () => {
    const sunday = new Date("2026-09-20T15:00:00Z"); // a real Sunday
    const row = (await evaluateLiveMarketScan(fixture(() => [put()], ["TEST"], { asOf: sunday })))[0];
    expect(row.values.retrievedAt).toBe(sunday.toISOString());
    expect(row.values.retrievedOnNonTradingDay).toBe(true);
  });

  it("a quote fetched on a real trading day is not flagged as a non-trading-day retrieval", async () => {
    const row = (await evaluateLiveMarketScan(fixture(() => [put()], ["TEST"])))[0]; // asOf = Wed Sep 16
    expect(row.values.retrievedOnNonTradingDay).toBe(false);
  });

  it("14 & 15. optionQuotedAt (genuine provider pricing time) is always distinct from, and never populated the same as, retrievedAt", async () => {
    const row = (await evaluateLiveMarketScan(fixture(() => [put()], ["TEST"])))[0];
    expect(row.values.retrievedAt).not.toBeNull();
    // No provider used here has ever supplied a verified per-quote pricing timestamp - this must
    // stay null rather than being silently backfilled from retrievedAt.
    expect(row.values.optionQuotedAt).toBeNull();
    expect(row.values.optionQuotedAt).not.toBe(row.values.retrievedAt);
  });
});

describe("selected-contract evidence: chain state feeds Ticket 6 readiness honestly (Ticket 8)", () => {
  it("16. a chain request that failed is ENRICHED (a real attempt), still gets a retrieval time, and reads NEEDS_DATA", async () => {
    const input = fixture(() => [put()], ["BROKEN"], { failChainFor: new Set(["BROKEN"]) });
    const row = (await evaluateLiveMarketScan(input))[0];

    expect(row.values.optionEnrichment).toBe("ENRICHED");
    expect(row.values.contractReasonCode).toBe("CHAIN_UNAVAILABLE");
    expect(row.values.retrievedAt).not.toBeNull();
    expect(classifyReadiness(row.summary, GATING_RULE_KEYS, row.values.optionEnrichment)).toBe("NEEDS_DATA");
  });

  it("17. a chain never requested due to the bounded budget has no retrieval time and reads NEEDS_DATA regardless of stock-only evidence", async () => {
    const tickers = Array.from({ length: OPTION_CHAIN_ENRICHMENT_LIMIT + 2 }, (_, i) => `RANK${String(i).padStart(2, "0")}`);
    const input = fixture(() => [put()], tickers);
    tickers.forEach((ticker, index) => input.technicalCache.set(ticker, { ...ready, rsi: 20 + index }));

    const rows = await evaluateLiveMarketScan(input);
    const budgetMiss = rows.find((row) => row.values.optionEnrichment === "NOT_ENRICHED_BUDGET")!;

    expect(budgetMiss.values.retrievedAt).toBeNull();
    expect(classifyReadiness(budgetMiss.summary, GATING_RULE_KEYS, budgetMiss.values.optionEnrichment)).toBe("NEEDS_DATA");
  });

  it("18. a chain checked but with no qualifying contract is ENRICHED, keeps a retrieval time, and never fabricates a selection", async () => {
    // Only a strike above the current price (20) - no acceptable OTM put exists.
    const row = (await evaluateLiveMarketScan(fixture(() => [put({ strike: 25 })], ["TEST"])))[0];

    expect(row.values.optionEnrichment).toBe("ENRICHED");
    expect(row.values.contractReasonCode).toBe("NO_ACCEPTABLE_STRIKE");
    expect(row.values.strike).toBeNull();
    expect(row.values.retrievedAt).not.toBeNull();
    // Enabled option-related rules (optionBid, ror, etc.) read UNKNOWN from the blank values, so
    // this is honestly NEEDS_DATA under the existing, unmodified Ticket 6 classifier - never PASS.
    expect(classifyReadiness(row.summary, GATING_RULE_KEYS, row.values.optionEnrichment)).not.toBe("PASS");
  });

  it("19. a fully assessed, qualifying contract reads PASS through the unmodified Ticket 6 classifier", async () => {
    const row = (await evaluateLiveMarketScan(fixture(() => [put()], ["TEST"])))[0];
    expect(row.values.optionEnrichment).toBe("ENRICHED");
    expect(classifyReadiness(row.summary, GATING_RULE_KEYS, row.values.optionEnrichment)).toBe("PASS");
  });
});

describe("bounded provider usage is unchanged (Ticket 8)", () => {
  it("20. adding selected-contract evidence fields issues no additional provider calls - one chain call per enriched ticker, capped at the budget", async () => {
    const tickers = Array.from({ length: OPTION_CHAIN_ENRICHMENT_LIMIT + 3 }, (_, i) => `RANK${String(i).padStart(2, "0")}`);
    const input = fixture(() => [put()], tickers);
    tickers.forEach((ticker, index) => input.technicalCache.set(ticker, { ...ready, rsi: 20 + index }));

    await evaluateLiveMarketScan(input);

    expect(input.chainCalls).toHaveLength(OPTION_CHAIN_ENRICHMENT_LIMIT);
  });
});
