import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EquityMarketSessionEvidence, QuoteReviewEvidence } from "@/providers/market-data/types";
import { getEquityMarketSessionEvidenceForUser, getQuoteReviewEvidenceForUser } from "./live-quotes";
import { resolvePositionReviewsForUser, resolveSortedPositionReviewsForUser, type PositionReviewAccountInput, type PositionReviewCampaignInput } from "./position-review";
import { getSchwabOpenPositionsForUser } from "./workflows";

vi.mock("./workflows", () => ({ getSchwabOpenPositionsForUser: vi.fn() }));
vi.mock("./live-quotes", () => ({ getQuoteReviewEvidenceForUser: vi.fn(), getEquityMarketSessionEvidenceForUser: vi.fn() }));

const getPositions = vi.mocked(getSchwabOpenPositionsForUser);
const getQuoteEvidence = vi.mocked(getQuoteReviewEvidenceForUser);
const getSessionEvidence = vi.mocked(getEquityMarketSessionEvidenceForUser);

const NY_DATE = "2026-06-15";
const NOON = new Date(`${NY_DATE}T16:00:00Z`);
const SESSION: EquityMarketSessionEvidence = {
  status: "AVAILABLE",
  requestedDate: NY_DATE,
  returnedDate: NY_DATE,
  marketType: "EQUITY",
  product: "EQ",
  isOpen: true,
  regularMarketIntervals: [{ start: new Date(`${NY_DATE}T09:30:00-04:00`), end: new Date(`${NY_DATE}T16:00:00-04:00`) }],
};

function quoteEvidence(price: number, tradeTime: Date = NOON): QuoteReviewEvidence {
  return {
    status: "AVAILABLE",
    requestedSymbol: "UPST",
    returnedSymbol: "UPST",
    assetMainType: "EQUITY",
    realtime: true,
    price,
    tradeTime,
    requestStartedAt: tradeTime,
    responseReceivedAt: tradeTime,
  };
}

const schwabAccount: PositionReviewAccountInput = { id: "account-1", userId: "matt", externalAccountId: "broker-a", source: "SCHWAB" };
const manualAccount: PositionReviewAccountInput = { id: "account-2", userId: "matt", externalAccountId: null, source: "MANUAL" };

function putCampaign(overrides: Partial<PositionReviewCampaignInput> = {}): PositionReviewCampaignInput {
  return {
    id: "campaign-1",
    ownerId: "matt",
    accountId: "account-1",
    ticker: "UPST",
    status: "OPEN",
    events: [
      {
        type: "SELL_PUT",
        occurredAt: new Date("2026-05-01T00:00:00.000Z"),
        optionType: "PUT",
        contracts: 1,
        strike: 25,
        expiration: new Date("2026-10-02T00:00:00.000Z"),
        premium: 1,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  getSessionEvidence.mockResolvedValue(SESSION);
  getQuoteEvidence.mockResolvedValue(new Map([["UPST", quoteEvidence(30)]]));
});

describe("resolvePositionReviewsForUser", () => {
  it("resolves SCHWAB_CONFIRMED when a matching broker position exists with a real read-receipt time", async () => {
    getPositions.mockResolvedValue([
      { accountId: "broker-a", symbol: "UPST  261002P00025000", quantity: -1, marketValue: -100, positionReadReceivedAt: NOON, accountLabel: "Test" },
    ]);

    const results = await resolvePositionReviewsForUser("matt", [putCampaign()], [schwabAccount], 3, NOON);

    expect(results).toHaveLength(1);
    expect(results[0].result.evidence.position).toBe("SCHWAB_CONFIRMED");
    expect(results[0].result.action).toBe("COMFORTABLE");
  });

  // Codex P1 (B1) - valuationAsOf is a provider valuation timestamp (currently always null in
  // production), conceptually unrelated to read freshness - it must never gate SCHWAB_CONFIRMED.
  it("resolves SCHWAB_CONFIRMED from positionReadReceivedAt alone, even when valuationAsOf is null (the real production shape)", async () => {
    getPositions.mockResolvedValue([
      { accountId: "broker-a", symbol: "UPST  261002P00025000", quantity: -1, marketValue: -100, valuationAsOf: null, positionReadReceivedAt: NOON, accountLabel: "Test" },
    ]);
    const results = await resolvePositionReviewsForUser("matt", [putCampaign()], [schwabAccount], 3, NOON);
    expect(results[0].result.evidence.position).toBe("SCHWAB_CONFIRMED");
  });

  it("resolves NOT_ASSESSED, never SCHWAB_CONFIRMED, from a stale valuationAsOf alone when positionReadReceivedAt is missing", async () => {
    // A present-but-irrelevant valuationAsOf must never be mistaken for a read-receipt time.
    getPositions.mockResolvedValue([
      { accountId: "broker-a", symbol: "UPST  261002P00025000", quantity: -1, marketValue: -100, valuationAsOf: NOON, accountLabel: "Test" },
    ]);
    const results = await resolvePositionReviewsForUser("matt", [putCampaign()], [schwabAccount], 3, NOON);
    expect(results[0].result.evidence.position).toBe("NOT_ASSESSED");
  });

  it("resolves NOT_ASSESSED when no broker position matches the campaign's contract", async () => {
    getPositions.mockResolvedValue([]);
    const results = await resolvePositionReviewsForUser("matt", [putCampaign()], [schwabAccount], 3, NOON);
    expect(results[0].result.evidence.position).toBe("NOT_ASSESSED");
  });

  it("resolves POSITION_MISMATCH_AMBIGUOUS when two campaigns compete for the same broker contract", async () => {
    getPositions.mockResolvedValue([
      { accountId: "broker-a", symbol: "UPST  261002P00025000", quantity: -1, marketValue: -100, positionReadReceivedAt: NOON, accountLabel: "Test" },
    ]);
    const duplicate = putCampaign({ id: "campaign-2" });
    const results = await resolvePositionReviewsForUser("matt", [putCampaign(), duplicate], [schwabAccount], 3, NOON);
    expect(results.every((entry) => entry.result.evidence.position === "POSITION_MISMATCH_AMBIGUOUS")).toBe(true);
  });

  it("resolves BROKER_UNAVAILABLE when the Schwab connection cannot be resolved at all", async () => {
    getPositions.mockResolvedValue(null);
    const results = await resolvePositionReviewsForUser("matt", [putCampaign()], [schwabAccount], 3, NOON);
    expect(results[0].result.evidence.position).toBe("BROKER_UNAVAILABLE");
    expect(results[0].result.action).toBe("CANNOT_ASSESS");
  });

  it("never throws even when the broker positions call rejects outright", async () => {
    getPositions.mockRejectedValue(new Error("network error"));
    const results = await resolvePositionReviewsForUser("matt", [putCampaign()], [schwabAccount], 3, NOON);
    expect(results[0].result.evidence.position).toBe("BROKER_UNAVAILABLE");
  });

  it("resolves MANUAL_POSITION for a manually-tracked account, bypassing broker matching entirely", async () => {
    getPositions.mockResolvedValue([]);
    const manualCampaign = putCampaign({ accountId: "account-2" });
    const results = await resolvePositionReviewsForUser("matt", [manualCampaign], [manualAccount], 3, NOON);
    expect(results[0].result.evidence.position).toBe("MANUAL_POSITION");
    expect(results[0].result.action).toBe("COMFORTABLE");
  });

  it("resolves NOT_ASSESSED (never a fabricated 'now') when a broker match exists but has no known read-receipt time", async () => {
    getPositions.mockResolvedValue([{ accountId: "broker-a", symbol: "UPST  261002P00025000", quantity: -1, marketValue: -100, accountLabel: "Test" }]);
    const results = await resolvePositionReviewsForUser("matt", [putCampaign()], [schwabAccount], 3, NOON);
    expect(results[0].result.evidence.position).toBe("NOT_ASSESSED");
  });

  it("evaluates an assigned-shares-with-no-call campaign as ASSIGNED_SHARES / CANNOT_ASSESS", async () => {
    getPositions.mockResolvedValue([]);
    const assigned = putCampaign({
      status: "ASSIGNED",
      events: [
        { type: "SELL_PUT", occurredAt: new Date("2026-05-01T00:00:00.000Z"), optionType: "PUT", contracts: 1, strike: 25, expiration: new Date("2026-06-01T00:00:00.000Z"), premium: 1 },
        { type: "ASSIGNMENT", occurredAt: new Date("2026-06-02T00:00:00.000Z"), contracts: 1, strike: 25, shares: 100 },
      ],
    });
    const results = await resolvePositionReviewsForUser("matt", [assigned], [schwabAccount], 3, NOON);
    expect(results[0].result.lifecycle).toBe("ASSIGNED_SHARES");
    expect(results[0].result.action).toBe("CANNOT_ASSESS");
  });

  it("skips CLOSED campaigns entirely", async () => {
    getPositions.mockResolvedValue([]);
    const results = await resolvePositionReviewsForUser("matt", [putCampaign({ status: "CLOSED" })], [schwabAccount], 3, NOON);
    expect(results).toHaveLength(0);
  });

  it("only requests quote evidence for tickers that actually have a leg to review", async () => {
    getPositions.mockResolvedValue([]);
    await resolvePositionReviewsForUser("matt", [putCampaign()], [schwabAccount], 3, NOON);
    expect(getQuoteEvidence).toHaveBeenCalledWith("matt", ["UPST"]);
  });
});

describe("resolveSortedPositionReviewsForUser", () => {
  it("returns results in the deterministic priority order, not input order", async () => {
    getPositions.mockResolvedValue([]);
    getQuoteEvidence.mockResolvedValue(new Map([
      ["AAA", quoteEvidence(30)], // comfortable
      ["ZZZ", quoteEvidence(24)], // review roll
    ]));
    // Manual accounts bypass broker-position matching entirely, isolating this test to the
    // ordering question rather than also depending on a matching Schwab position fixture.
    const comfortable = putCampaign({ id: "campaign-comfortable", ticker: "AAA", accountId: "account-2" });
    const reviewRoll = putCampaign({ id: "campaign-review", ticker: "ZZZ", accountId: "account-2" });

    const results = await resolveSortedPositionReviewsForUser("matt", [comfortable, reviewRoll], [manualAccount], 3, NOON);
    expect(results.map((entry) => entry.campaignId)).toEqual(["campaign-review", "campaign-comfortable"]);
  });
});

describe("Codex P1 (B1) - production-shaped broker receipt-timestamp chain: Schwab adapter -> broker cache -> review orchestration", () => {
  // Exercises the REAL SchwabBrokerReadProvider.getPositions (a real fetch response is parsed)
  // and the REAL withBrokerReadCache wrapper - only getSchwabOpenPositionsForUser's own DB/OAuth
  // account-resolution step is stood in for, since no live Schwab credentials exist in this
  // environment (see PROJECT_HANDOFF.md's Schwab-evidence-diagnostic tickets). The array these
  // real layers produce is what resolvePositionReviewsForUser then evaluates - never a hand-built
  // BrokerPosition literal standing in for the whole chain.
  it("SCHWAB_CONFIRMED comes from the adapter's OWN read-receipt time, survives a cache hit unchanged, and expires after 5 real minutes", async () => {
    const { SchwabBrokerReadProvider } = await import("@/providers/schwab/broker-read");
    const { withBrokerReadCache, clearBrokerReadCacheForTests } = await import("@/providers/broker-read/cache");
    clearBrokerReadCacheForTests();

    let fetchCallCount = 0;
    const fetchFn = (async () => {
      fetchCallCount += 1;
      return new Response(
        JSON.stringify({
          securitiesAccount: {
            positions: [
              {
                shortQuantity: 1,
                longQuantity: 0,
                marketValue: -100,
                // Real Schwab position responses carry no verified valuation timestamp - the
                // adapter itself always sets valuationAsOf: null (see broker-read.ts). Never mock
                // this as broker freshness - only positionReadReceivedAt below may do that.
                instrument: { symbol: "UPST  261002P00025000", assetType: "OPTION", putCall: "PUT", strikePrice: 25, underlyingSymbol: "UPST" },
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const rawProvider = new SchwabBrokerReadProvider({ accessToken: "test-token", accountNumbers: [], fetchFn });
    // The cache's own `now()` is an independent concern from the provider's real wall-clock
    // receipt stamp below - an arbitrary self-consistent base is enough to prove cache hit/miss
    // timing, decoupled from real time.
    let cacheNow = 1_000_000;
    const cachedProvider = withBrokerReadCache(rawProvider, "schwab:user:matt:connection:test", { now: () => cacheNow });

    const beforeFetch = Date.now();
    const firstRead = await cachedProvider.getPositions("broker-a");
    const afterFetch = Date.now();
    expect(fetchCallCount).toBe(1);
    expect(firstRead[0]?.valuationAsOf).toBeNull(); // confirms this test uses the real, honest adapter shape
    const receivedAt = firstRead[0]?.positionReadReceivedAt;
    expect(receivedAt).toBeInstanceOf(Date);
    // The adapter's own real `new Date()` call, bounded only by when the test's fetch actually ran.
    expect(receivedAt!.getTime()).toBeGreaterThanOrEqual(beforeFetch);
    expect(receivedAt!.getTime()).toBeLessThanOrEqual(afterFetch);

    getPositions.mockResolvedValue(firstRead.map((position) => ({ ...position, accountLabel: "Test" })));
    const freshResult = await resolvePositionReviewsForUser("matt", [putCampaign()], [schwabAccount], 3, receivedAt!);
    expect(freshResult[0]?.result.evidence.position).toBe("SCHWAB_CONFIRMED");

    // Still within the 15s broker-read cache TTL - a cache HIT must replay the exact same
    // positionReadReceivedAt, never a freshly-stamped `new Date()`.
    cacheNow += 10_000;
    const cachedRead = await cachedProvider.getPositions("broker-a");
    expect(fetchCallCount).toBe(1); // no second HTTP call - this really was a cache hit
    expect(cachedRead[0]?.positionReadReceivedAt?.getTime()).toBe(receivedAt!.getTime());

    // 6 real minutes after the ORIGINAL read (not the cache hit) - the cached value's un-renewed
    // receipt time must now read as stale, even though the cache itself may have already expired
    // and would re-fetch on the NEXT call; this evaluates the value already in hand.
    getPositions.mockResolvedValue(cachedRead.map((position) => ({ ...position, accountLabel: "Test" })));
    const staleResult = await resolvePositionReviewsForUser("matt", [putCampaign()], [schwabAccount], 3, new Date(receivedAt!.getTime() + 6 * 60_000));
    expect(staleResult[0]?.result.evidence.position).toBe("AWAITING_CONFIRMATION");

    clearBrokerReadCacheForTests();
  });
});
