import { describe, expect, it } from "vitest";
import { performanceMetricText, summarizeCampaignProgress, summarizePerformanceMetrics } from "./performance";
import { resolveCurrentCostToClose, sameStrike, type LinkedPositionRecordInput, type OptionMarkSnapshotInput } from "./currentPositionMark";
import { getCurrentOpenPut, type CampaignEventInput, type CurrentOpenPut } from "./campaigns";

// Fri Sep 4 2026 is a real NYSE market day (see marketCalendar.test.ts); Sat Sep 5/Sun Sep 6 are
// weekend; Mon Sep 7 is Labor Day; Tue Sep 8 is the next market day. Reused here so freshness
// scenarios line up with already-verified marketCalendar fixtures.
const MARKET_DAY = new Date("2026-09-08T20:00:00Z"); // Tuesday, a real trading day
const WEEKEND_DAY = new Date("2026-09-05T12:00:00Z"); // Saturday

const activePut: CurrentOpenPut = { strike: 20, contracts: 1, expiration: new Date("2026-09-18") };

function linkedRecord(overrides: Partial<LinkedPositionRecordInput> = {}): LinkedPositionRecordInput {
  return {
    accountId: "acct-1",
    symbol: "RIOT  260918P00020000",
    underlyingSymbol: "RIOT",
    quantity: -1,
    amount: -150, // Schwab's own signed market value for a short option
    observedAt: MARKET_DAY,
    metadata: { valuationAsOf: (overrides.observedAt ?? MARKET_DAY).toISOString() },
    ...overrides,
  };
}

function resolve(opts: {
  campaignStatus?: string;
  campaignAccountId?: string;
  campaignTicker?: string;
  activePut?: CurrentOpenPut | null;
  linkedRecords?: LinkedPositionRecordInput[];
  optionMark?: OptionMarkSnapshotInput | null;
  now?: Date;
}) {
  return resolveCurrentCostToClose({
    campaignStatus: opts.campaignStatus ?? "OPEN",
    campaignAccountId: opts.campaignAccountId ?? "acct-1",
    campaignTicker: opts.campaignTicker ?? "RIOT",
    activePut: opts.activePut === undefined ? activePut : opts.activePut,
    linkedRecords: opts.linkedRecords ?? [],
    // These fixtures explicitly represent a verified price timestamp, separate from storage time.
    optionMark: opts.optionMark ? { valuationAsOf: opts.optionMark.capturedAt, ...opts.optionMark } : null,
    now: opts.now ?? MARKET_DAY,
  });
}

describe("resolveCurrentCostToClose (Ticket 5: validated current-position marks)", () => {
  it("test 1: an exact current-contract match is accepted", () => {
    const result = resolve({ linkedRecords: [linkedRecord()] });
    expect(result).not.toBeNull();
    expect(result!.source).toBe("LINKED_BROKER_POSITION");
    expect(result!.costToClose).toBe(150);
    expect(result!.freshness).toBe("CURRENT_SESSION");
  });

  it("test 2: old pre-roll contract and new post-roll contract both linked - the OLD one must never supply the current mark", () => {
    const oldContract = linkedRecord({ symbol: "RIOT  260904P00025000", amount: -300 }); // pre-roll: $25 strike, Sep 4 expiration
    const newContract = linkedRecord({ symbol: "RIOT  260918P00020000", amount: -150 }); // post-roll: matches activePut exactly
    // Order deliberately puts the OLD (wrong) record first - the function must not just take
    // "the first short put it finds."
    const result = resolve({ linkedRecords: [oldContract, newContract] });
    expect(result).not.toBeNull();
    expect(result!.costToClose).toBe(150); // the NEW contract's value, never the old $300
  });

  it("test 3: a linked record from the wrong brokerage account is rejected even though everything else matches", () => {
    const wrongAccount = linkedRecord({ accountId: "acct-OTHER" });
    const result = resolve({ linkedRecords: [wrongAccount] });
    expect(result).toBeNull();
  });

  // test 4 (wrong owner/user): this function is deliberately NOT given a userId - ownership
  // scoping is the caller's responsibility (getTrackerPageData's `linkedBrokerRecords` query is
  // itself `where: { userId, ... }` for the authenticated caller - see src/lib/app-data.ts, and
  // PROJECT_HANDOFF.md's owner-scoped brokerage access invariant). A cross-user record can
  // therefore never reach this function's `linkedRecords` input at all in production. The
  // analogous, actually-testable check this function DOES own is the account-identity check
  // proven in test 3 above - the same mechanism would reject a record belonging to a different
  // account regardless of why it doesn't belong to this campaign's holder.

  it("test 5: wrong option type (a call, not a put) is rejected", () => {
    const callRecord = linkedRecord({ symbol: "RIOT  260918C00020000", metadata: { putCall: "CALL" } });
    const result = resolve({ linkedRecords: [callRecord] });
    expect(result).toBeNull();
  });

  it("test 6: wrong strike is rejected", () => {
    const wrongStrike = linkedRecord({ symbol: "RIOT  260918P00025000" }); // $25, not $20
    const result = resolve({ linkedRecords: [wrongStrike] });
    expect(result).toBeNull();
  });

  it("test 7: wrong expiration is rejected", () => {
    const wrongExpiration = linkedRecord({ symbol: "RIOT  261016P00020000" }); // Oct 16, not Sep 18
    const result = resolve({ linkedRecords: [wrongExpiration] });
    expect(result).toBeNull();
  });

  it("test 8: wrong quantity/contracts is rejected - a 2-contract position never values a 1-contract campaign leg", () => {
    const wrongQuantity = linkedRecord({ quantity: -2 });
    const result = resolve({ linkedRecords: [wrongQuantity] });
    expect(result).toBeNull();
  });

  it("test 8b: a LONG put (positive quantity) at the exact same contract is rejected - never a short position", () => {
    const longPut = linkedRecord({ quantity: 1, amount: 150 });
    const result = resolve({ linkedRecords: [longPut] });
    expect(result).toBeNull();
  });

  it("test 9: a missing observation timestamp is rejected, not silently treated as current", () => {
    const noTimestamp = linkedRecord({ observedAt: null });
    const result = resolve({ linkedRecords: [noTimestamp] });
    expect(result).toBeNull();
  });

  it("test 10: a stale snapshot (2+ trading sessions old) is rejected", () => {
    // now = Sep 9 (Wed); Sep 4 (Fri) is two sessions behind (Sep4 -> Sep8 -> Sep9) - see
    // marketCalendar.test.ts's identical STALE boundary fixture.
    const stale = linkedRecord({ observedAt: new Date("2026-09-04T20:00:00Z") });
    const result = resolve({ linkedRecords: [stale], now: new Date("2026-09-09T15:00:00Z") });
    expect(result).toBeNull();
  });

  it("test 11: weekend/market-closed last-session evidence is accepted but explicitly labeled, never as a live quote", () => {
    const fridayRecord = linkedRecord({ observedAt: new Date("2026-09-04T20:00:00Z") }); // Friday's close
    const result = resolve({ linkedRecords: [fridayRecord], now: WEEKEND_DAY }); // checked on Saturday
    expect(result).not.toBeNull();
    expect(result!.freshness).toBe("LAST_SESSION");
  });

  it("test 12: no valid current mark anywhere (no matching linked record, no option mark) returns null - never a fabricated value", () => {
    const result = resolve({ linkedRecords: [linkedRecord({ symbol: "RIOT  260918P00099000" })], optionMark: null });
    expect(result).toBeNull();
  });

  it("test 13: an ASSIGNED campaign (no current put at all) never returns a cost-to-close, regardless of linked records", () => {
    const result = resolve({ campaignStatus: "ASSIGNED", activePut: null, linkedRecords: [linkedRecord()] });
    expect(result).toBeNull();
  });

  it("test 15: mixed coverage - one campaign resolves a valid mark, a sibling with only a mismatched record does not", () => {
    const validCampaign = resolve({ linkedRecords: [linkedRecord()] });
    const incompleteCampaign = resolve({
      campaignTicker: "ONON",
      activePut: { strike: 27, contracts: 1, expiration: new Date("2026-09-25") },
      linkedRecords: [linkedRecord({ symbol: "ONON  260918P00028000", underlyingSymbol: "ONON" })], // pre-roll leftover, wrong strike/expiration
    });
    expect(validCampaign).not.toBeNull();
    expect(incompleteCampaign).toBeNull();
  });

  describe("cached option mark fallback (no linked broker record at all)", () => {
    it("accepts a current-session cached mark when no linked record matches", () => {
      const result = resolve({ optionMark: { mark: 1.5, bid: 1.4, ask: 1.6, capturedAt: MARKET_DAY } });
      expect(result).not.toBeNull();
      expect(result!.source).toBe("CACHED_OPTION_MARK");
      expect(result!.costToClose).toBe(150); // 1.5 * 1 contract * 100
      expect(result!.freshness).toBe("CURRENT_SESSION");
    });

    it("falls back to the bid/ask midpoint when mark is zero/unavailable", () => {
      const result = resolve({ optionMark: { mark: null, bid: 1.4, ask: 1.6, capturedAt: MARKET_DAY } });
      expect(result).not.toBeNull();
      expect(result!.costToClose).toBe(150); // midpoint 1.5 * 100
    });

    it("rejects a stale cached mark", () => {
      const result = resolve({
        optionMark: { mark: 1.5, bid: 1.4, ask: 1.6, capturedAt: new Date("2026-09-04T20:00:00Z") },
        now: new Date("2026-09-09T15:00:00Z"),
      });
      expect(result).toBeNull();
    });

    it("rejects a cached mark with no capturedAt", () => {
      const result = resolve({ optionMark: { mark: 1.5, bid: 1.4, ask: 1.6, capturedAt: null } });
      expect(result).toBeNull();
    });

    it("prefers a validated linked broker position over the cached mark when both are available", () => {
      const result = resolve({
        linkedRecords: [linkedRecord()],
        optionMark: { mark: 99, bid: 98, ask: 100, capturedAt: MARKET_DAY },
      });
      expect(result!.source).toBe("LINKED_BROKER_POSITION");
      expect(result!.costToClose).toBe(150); // the linked position's real value, not the mark's 9900
    });
  });
});

describe("valuation evidence regressions", () => {
  it("rejects missing market value but accepts a verified, dated broker zero", () => {
    expect(resolve({ linkedRecords: [linkedRecord({ amount: null })] })).toBeNull();
    expect(resolve({ linkedRecords: [linkedRecord({ amount: 0 })] })?.costToClose).toBe(0);
  });
  it("neither a new sync timestamp nor database capturedAt proves valuation freshness", () => {
    expect(resolve({ linkedRecords: [linkedRecord({ metadata: null })] })).toBeNull();
    expect(resolve({ optionMark: { mark: 1, bid: 0.9, ask: 1.1, capturedAt: MARKET_DAY, valuationAsOf: null } })).toBeNull();
  });
  it.each([[0, 0], [-1, 1], [1, -1], [2, 1], [NaN, 1]])("rejects invalid bid/ask %s / %s", (bid, ask) => {
    expect(resolve({ optionMark: { mark: null, bid, ask, capturedAt: MARKET_DAY } })).toBeNull();
  });
  it("rejects a negative mark instead of disguising it with a valid midpoint", () => {
    expect(resolve({ optionMark: { mark: -1, bid: 1, ask: 2, capturedAt: MARKET_DAY } })).toBeNull();
  });
  it("allows a zero bid with a positive ask", () => {
    expect(resolve({ optionMark: { mark: null, bid: 0, ask: 0.1, capturedAt: MARKET_DAY } })?.costToClose).toBe(5);
  });
  it.each([-0.005, 0.005])("includes the exact half-cent strike boundary %s", (delta) => {
    expect(sameStrike(20, 20 + delta)).toBe(true);
    const symbol = `RIOT 260918P${String(Math.round((20 + delta) * 1000)).padStart(8, "0")}`;
    expect(resolve({ linkedRecords: [linkedRecord({ symbol })] })?.costToClose).toBe(150);
  });
  it("rejects beyond the half-cent boundary", () => {
    expect(sameStrike(20, 20.005001)).toBe(false);
    expect(sameStrike(20, 19.994999)).toBe(false);
  });
  it.each([-2, 0, 1, null])("latest contradictory quantity %s never falls back to an older match or a quote", (quantity) => {
    const old = linkedRecord({ observedAt: new Date("2026-09-08T15:00:00Z") });
    const latest = linkedRecord({ quantity });
    for (const linkedRecords of [[old, latest], [latest, old]]) {
      expect(resolve({ linkedRecords, optionMark: { mark: 1, bid: 0.9, ask: 1.1, capturedAt: MARKET_DAY } })).toBeNull();
    }
  });
  it("equal-time conflicting amounts are ambiguous in both orders", () => {
    const a = linkedRecord(), b = linkedRecord({ amount: -300 });
    expect(resolve({ linkedRecords: [a, b] })).toBeNull();
    expect(resolve({ linkedRecords: [b, a] })).toBeNull();
  });
  it("equal-time identical observations can agree", () => {
    expect(resolve({ linkedRecords: [linkedRecord(), linkedRecord()] })?.costToClose).toBe(150);
  });
  it("a persisted equal-time conflict cannot use the stored price or a fallback quote", () => {
    expect(resolve({ linkedRecords: [linkedRecord({ metadata: { valuationAsOf: MARKET_DAY.toISOString(), observationConflict: true } })],
      optionMark: { mark: 1, bid: 0.9, ask: 1.1, capturedAt: MARKET_DAY } })).toBeNull();
  });
  it("rejects future observation and valuation timestamps", () => {
    const future = new Date("2026-10-01T15:00:00Z");
    expect(resolve({ linkedRecords: [linkedRecord({ observedAt: future })] })).toBeNull();
    expect(resolve({ optionMark: { mark: 1, bid: 1, ask: 1, capturedAt: MARKET_DAY, valuationAsOf: future } })).toBeNull();
    expect(resolve({ optionMark: { mark: 1, bid: 1, ask: 1, capturedAt: future, valuationAsOf: MARKET_DAY } })).toBeNull();
  });
  it("full tied roll history selects the new put and preserves pending and last-session presentation", () => {
    const events: CampaignEventInput[] = [
      { type: "ROLL_PUT_OPEN", id: "3", sortOrder: 1, createdAt: "2026-09-04T15:00:02Z", occurredAt: "2026-09-04", strike: 20, contracts: 1, premium: 1.5, expiration: "2026-09-18" },
      { type: "SELL_PUT", id: "1", occurredAt: "2026-09-01", strike: 25, contracts: 1, premium: 1, expiration: "2026-09-04" },
      { type: "ROLL_PUT_CLOSE", id: "2", sortOrder: 1, createdAt: "2026-09-04T15:00:01Z", occurredAt: "2026-09-04", strike: 25, contracts: 1, premium: 0.5 },
    ];
    const source = resolve({ activePut: getCurrentOpenPut(events), now: WEEKEND_DAY, linkedRecords: [
      linkedRecord({ symbol: "RIOT 260904P00025000", amount: -900, observedAt: new Date("2026-09-04T20:00:00Z") }),
      linkedRecord({ amount: -30, observedAt: new Date("2026-09-04T20:00:00Z") }),
    ] });
    expect(source?.costToClose).toBe(30);
    expect(source?.freshness).toBe("LAST_SESSION");
    const progress = summarizeCampaignProgress({ status: "OPEN", events, feesFullyKnown: false, currentCostToClose: source!.costToClose });
    const totals = summarizePerformanceMetrics([{ status: "OPEN", progress, freshness: source!.freshness }]);
    expect(totals.current).toEqual({ value: 170, status: "PENDING" });
    expect(totals.lastSessionCount).toBe(1);
    expect(performanceMetricText(progress.currentPL, progress.currentPLStatus, (v) => `$${v}`)).toBe("$170 - pending");
  });
});
