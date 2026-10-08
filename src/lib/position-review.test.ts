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

function callCampaign(overrides: Partial<PositionReviewCampaignInput> = {}): PositionReviewCampaignInput {
  return {
    id: "campaign-call",
    ownerId: "matt",
    accountId: "account-1",
    ticker: "UPST",
    status: "ASSIGNED",
    events: [
      { type: "ASSIGNMENT", occurredAt: new Date("2026-05-01T00:00:00.000Z"), contracts: 1, strike: 25, shares: 100 },
      {
        type: "SELL_COVERED_CALL",
        occurredAt: new Date("2026-05-02T00:00:00.000Z"),
        optionType: "CALL",
        contracts: 1,
        strike: 30,
        expiration: new Date("2026-10-02T00:00:00.000Z"),
        premium: 1,
      },
    ],
    ...overrides,
  };
}

function equityPosition(overrides: Partial<{ accountId: string; symbol: string; quantity: number }> = {}) {
  return { accountId: "broker-a", symbol: "UPST", quantity: 100, marketValue: 3000, assetType: "EQUITY", accountLabel: "Test", ...overrides };
}

/**
 * Codex P2 (B, round 3) - defaults to `sharesPerContract: 100` so every EXISTING call site below
 * keeps testing the obligation-grouping/arithmetic logic in isolation from the separate deliverable
 * -proof gate (computeCallShareCoverage's `multiplierProven` check) - exactly as if a future ticket
 * had already wired up trustworthy provider evidence. This is NOT today's real production shape:
 * see the dedicated "round 3 - deliverable-proof gate" describe block below, which explicitly omits
 * this field to prove the REAL default (no normalizer populates it) fails closed regardless of how
 * the share arithmetic would otherwise come out.
 */
function callOptionPosition(overrides: Partial<{ accountId: string; symbol: string; quantity: number; sharesPerContract: number | null }> = {}) {
  return { accountId: "broker-a", symbol: "UPST  261002C00030000", quantity: -1, marketValue: -100, positionReadReceivedAt: NOON, sharesPerContract: 100, accountLabel: "Test", ...overrides };
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
    expect(getQuoteEvidence).toHaveBeenCalledWith("matt", ["UPST"], undefined);
  });
});

describe("Codex P1 (B7) - owner isolation, CRITICAL", () => {
  const ericManualAccount: PositionReviewAccountInput = { id: "account-eric-manual", userId: "eric", externalAccountId: null, source: "MANUAL" };
  const ericSchwabAccount: PositionReviewAccountInput = { id: "account-eric-schwab", userId: "eric", externalAccountId: "broker-eric", source: "SCHWAB" };

  it("never evaluates an Eric-owned MANUAL campaign as COMFORTABLE using Matt's settings (the exact Codex repro)", async () => {
    getPositions.mockResolvedValue([]);
    const ericCampaign = putCampaign({ id: "campaign-eric", ownerId: "eric", accountId: "account-eric-manual" });

    const results = await resolvePositionReviewsForUser("matt", [ericCampaign], [ericManualAccount], 3, NOON);

    expect(results[0]?.result.evidence.position).toBe("NOT_ASSESSED");
    expect(results[0]?.result.action).toBe("CANNOT_ASSESS");
    expect(results[0]?.result.action).not.toBe("COMFORTABLE");
  });

  it("never confirms an Eric-owned Schwab campaign against Matt's own broker positions", async () => {
    // Matt's own Schwab connection happens to hold the exact same contract - it must never be
    // treated as confirming ERIC's campaign.
    getPositions.mockResolvedValue([
      { accountId: "broker-eric", symbol: "UPST  261002P00025000", quantity: -1, marketValue: -100, positionReadReceivedAt: NOON, accountLabel: "Test" },
    ]);
    const ericCampaign = putCampaign({ id: "campaign-eric", ownerId: "eric", accountId: "account-eric-schwab" });

    const results = await resolvePositionReviewsForUser("matt", [ericCampaign], [ericSchwabAccount], 3, NOON);

    expect(results[0]?.result.evidence.position).toBe("NOT_ASSESSED");
    expect(results[0]?.result.action).toBe("CANNOT_ASSESS");
  });

  it("isolates ownership correctly in a mixed batch (Matt's own campaign confirms normally; Eric's buddy row alongside it does not)", async () => {
    getPositions.mockResolvedValue([
      { accountId: "broker-a", symbol: "UPST  261002P00025000", quantity: -1, marketValue: -100, positionReadReceivedAt: NOON, accountLabel: "Test" },
    ]);
    const mattsCampaign = putCampaign({ id: "campaign-matt" });
    const ericsCampaign = putCampaign({ id: "campaign-eric", ownerId: "eric", accountId: "account-eric-manual", ticker: "UPST" });

    const results = await resolvePositionReviewsForUser("matt", [mattsCampaign, ericsCampaign], [schwabAccount, ericManualAccount], 3, NOON);

    const mattResult = results.find((r) => r.campaignId === "campaign-matt");
    const ericResult = results.find((r) => r.campaignId === "campaign-eric");
    expect(mattResult?.result.evidence.position).toBe("SCHWAB_CONFIRMED");
    expect(mattResult?.result.action).toBe("COMFORTABLE");
    expect(ericResult?.result.evidence.position).toBe("NOT_ASSESSED");
    expect(ericResult?.result.action).toBe("CANNOT_ASSESS");
  });

  it("never grants active guidance when the campaign owner matches but the account itself belongs to someone else", async () => {
    // A defensive/contradictory-data case: campaign.ownerId says "matt" but its account row's own
    // userId says "eric" - ownership must be proven on BOTH, never just the campaign's own claim.
    getPositions.mockResolvedValue([]);
    const mismatchedCampaign = putCampaign({ accountId: "account-eric-manual" });
    const results = await resolvePositionReviewsForUser("matt", [mismatchedCampaign], [ericManualAccount], 3, NOON);
    expect(results[0]?.result.evidence.position).toBe("NOT_ASSESSED");
  });

  it("does not let Eric's own settings/buffer apply when Eric views his own campaign through a shared batch call using a different rollBufferPercent than Matt's", async () => {
    // Sanity: when the VIEWER is genuinely Eric, his own campaign confirms and evaluates normally.
    getPositions.mockResolvedValue([]);
    const ericOwnCampaign = putCampaign({ id: "campaign-eric-own", ownerId: "eric", accountId: "account-eric-manual" });
    const results = await resolvePositionReviewsForUser("eric", [ericOwnCampaign], [ericManualAccount], 10, NOON);
    expect(results[0]?.result.evidence.position).toBe("MANUAL_POSITION");
    expect(results[0]?.result.explanation.bufferPercent).toBe(10);
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

describe("Codex P1 (B5) - covered-call underlying-share coverage", () => {
  it("is SCHWAB_CONFIRMED when one covered call is fully backed by enough broker-held shares", async () => {
    getPositions.mockResolvedValue([equityPosition({ quantity: 100 }), callOptionPosition()]);
    const results = await resolvePositionReviewsForUser("matt", [callCampaign()], [schwabAccount], 3, NOON);
    expect(results[0]?.result.evidence.position).toBe("SCHWAB_CONFIRMED");
  });

  it("confirms BOTH calls when two competing campaigns' aggregate share need fits the actual broker-held shares", async () => {
    getPositions.mockResolvedValue([
      equityPosition({ quantity: 200 }),
      callOptionPosition(),
      callOptionPosition({ symbol: "UPST  261101C00032000" }),
    ]);
    const first = callCampaign({ id: "campaign-call-a" });
    const second = callCampaign({
      id: "campaign-call-b",
      events: [
        { type: "ASSIGNMENT", occurredAt: new Date("2026-05-01T00:00:00.000Z"), contracts: 1, strike: 28, shares: 100 },
        { type: "SELL_COVERED_CALL", occurredAt: new Date("2026-05-02T00:00:00.000Z"), optionType: "CALL", contracts: 1, strike: 32, expiration: new Date("2026-11-01T00:00:00.000Z"), premium: 1 },
      ],
    });

    const results = await resolvePositionReviewsForUser("matt", [first, second], [schwabAccount], 3, NOON);
    expect(results.map((r) => r.result.evidence.position)).toEqual(["SCHWAB_CONFIRMED", "SCHWAB_CONFIRMED"]);
  });

  it("resolves BOTH competing calls to INSUFFICIENT_SHARE_COVERAGE when the aggregate need exceeds actual broker-held shares (never a first-campaign-wins pick)", async () => {
    getPositions.mockResolvedValue([
      equityPosition({ quantity: 100 }), // only enough for ONE call's 100 shares, not both
      callOptionPosition(),
      callOptionPosition({ symbol: "UPST  261101C00032000" }),
    ]);
    const first = callCampaign({ id: "campaign-call-a" });
    const second = callCampaign({
      id: "campaign-call-b",
      events: [
        { type: "ASSIGNMENT", occurredAt: new Date("2026-05-01T00:00:00.000Z"), contracts: 1, strike: 28, shares: 100 },
        { type: "SELL_COVERED_CALL", occurredAt: new Date("2026-05-02T00:00:00.000Z"), optionType: "CALL", contracts: 1, strike: 32, expiration: new Date("2026-11-01T00:00:00.000Z"), premium: 1 },
      ],
    });

    const results = await resolvePositionReviewsForUser("matt", [first, second], [schwabAccount], 3, NOON);
    expect(results.map((r) => r.result.evidence.position)).toEqual(["INSUFFICIENT_SHARE_COVERAGE", "INSUFFICIENT_SHARE_COVERAGE"]);
    expect(results.every((r) => r.result.action === "CANNOT_ASSESS")).toBe(true);
  });

  it("keeps competing-shares grouping isolated per ACCOUNT - two calls on the same ticker in different accounts never compete", async () => {
    const accountB: PositionReviewAccountInput = { id: "account-b", userId: "matt", externalAccountId: "broker-b", source: "SCHWAB" };
    getPositions.mockResolvedValue([
      equityPosition({ accountId: "broker-a", quantity: 100 }),
      callOptionPosition({ accountId: "broker-a" }),
      equityPosition({ accountId: "broker-b", quantity: 100 }),
      callOptionPosition({ accountId: "broker-b" }),
    ]);
    const first = callCampaign({ id: "campaign-call-a", accountId: "account-1" });
    const second = callCampaign({ id: "campaign-call-b", accountId: "account-b" });

    const results = await resolvePositionReviewsForUser("matt", [first, second], [schwabAccount, accountB], 3, NOON);
    expect(results.map((r) => r.result.evidence.position)).toEqual(["SCHWAB_CONFIRMED", "SCHWAB_CONFIRMED"]);
  });

  it("keeps competing-shares grouping isolated per OWNER - Eric's call is never counted against Matt's shares (or vice versa)", async () => {
    const ericSchwabAccount: PositionReviewAccountInput = { id: "account-eric", userId: "eric", externalAccountId: "broker-a", source: "SCHWAB" };
    // Same account/ticker as Matt's own call, but owned by Eric - grouping must not merge them
    // even though they'd otherwise share an owner+account+underlying key collision risk.
    getPositions.mockResolvedValue([equityPosition({ quantity: 100 }), callOptionPosition()]);
    const mattsCall = callCampaign({ id: "campaign-call-matt" });
    const ericsCall = callCampaign({ id: "campaign-call-eric", ownerId: "eric", accountId: "account-eric" });

    const results = await resolvePositionReviewsForUser("matt", [mattsCall, ericsCall], [schwabAccount, ericSchwabAccount], 3, NOON);
    const mattResult = results.find((r) => r.campaignId === "campaign-call-matt");
    const ericResult = results.find((r) => r.campaignId === "campaign-call-eric");
    expect(mattResult?.result.evidence.position).toBe("SCHWAB_CONFIRMED");
    // Eric's campaign is blocked by the B7 owner-isolation check regardless, but confirms grouping
    // never crosses owners either way.
    expect(ericResult?.result.evidence.position).toBe("NOT_ASSESSED");
  });

  it("proves share coverage without needing cost-basis evidence at all", async () => {
    // No STOCK_SALE/basis-relevant events beyond the assignment itself - summarizeCampaign's own
    // adjustedBasis may be null here, but that must never block a pure share-count coverage proof.
    getPositions.mockResolvedValue([equityPosition({ quantity: 100 }), callOptionPosition()]);
    const results = await resolvePositionReviewsForUser("matt", [callCampaign()], [schwabAccount], 3, NOON);
    expect(results[0]?.result.evidence.position).toBe("SCHWAB_CONFIRMED");
    expect(results[0]?.result.explanation.strike).toBe(30); // the call's own strike, confirming normal evaluation proceeded
  });

  it("resolves INSUFFICIENT_SHARE_COVERAGE (never SCHWAB_CONFIRMED) when no equity share position can be found at all", async () => {
    getPositions.mockResolvedValue([callOptionPosition()]); // contract matches, but no stock position exists
    const results = await resolvePositionReviewsForUser("matt", [callCampaign()], [schwabAccount], 3, NOON);
    expect(results[0]?.result.evidence.position).toBe("INSUFFICIENT_SHARE_COVERAGE");
  });
});

describe("Codex P2 (B) - covered-call coverage must account for ALL broker-visible short calls, not just tracked ones", () => {
  it("the exact reproduced defect: 100 shares, one tracked call, plus one UNTRACKED broker short call on the same underlying -> Cannot assess", async () => {
    getPositions.mockResolvedValue([
      equityPosition({ quantity: 100 }),
      callOptionPosition(), // the tracked campaign's own matching contract
      callOptionPosition({ symbol: "UPST  261101C00032000" }), // an UNTRACKED short call Schwab reports on the same underlying/account
    ]);
    const results = await resolvePositionReviewsForUser("matt", [callCampaign()], [schwabAccount], 3, NOON);
    expect(results[0]?.result.evidence.position).toBe("INSUFFICIENT_SHARE_COVERAGE");
    expect(results[0]?.result.action).toBe("CANNOT_ASSESS");
  });

  it("100 shares, exactly one tracked short call, no other broker obligation -> potentially covered", async () => {
    getPositions.mockResolvedValue([equityPosition({ quantity: 100 }), callOptionPosition()]);
    const results = await resolvePositionReviewsForUser("matt", [callCampaign()], [schwabAccount], 3, NOON);
    expect(results[0]?.result.evidence.position).toBe("SCHWAB_CONFIRMED");
  });

  it("200 shares, two total broker short standard calls (both tracked) -> potentially covered", async () => {
    getPositions.mockResolvedValue([
      equityPosition({ quantity: 200 }),
      callOptionPosition(),
      callOptionPosition({ symbol: "UPST  261101C00032000" }),
    ]);
    const second = callCampaign({
      id: "campaign-call-b",
      events: [
        { type: "ASSIGNMENT", occurredAt: new Date("2026-05-01T00:00:00.000Z"), contracts: 1, strike: 28, shares: 100 },
        { type: "SELL_COVERED_CALL", occurredAt: new Date("2026-05-02T00:00:00.000Z"), optionType: "CALL", contracts: 1, strike: 32, expiration: new Date("2026-11-01T00:00:00.000Z"), premium: 1 },
      ],
    });
    const results = await resolvePositionReviewsForUser("matt", [callCampaign({ id: "campaign-call-a" }), second], [schwabAccount], 3, NOON);
    expect(results.every((r) => r.result.evidence.position === "SCHWAB_CONFIRMED")).toBe(true);
  });

  it("150 shares, two total broker short standard calls -> insufficient / Cannot assess", async () => {
    getPositions.mockResolvedValue([
      equityPosition({ quantity: 150 }),
      callOptionPosition(),
      callOptionPosition({ symbol: "UPST  261101C00032000" }),
    ]);
    const second = callCampaign({
      id: "campaign-call-b",
      events: [
        { type: "ASSIGNMENT", occurredAt: new Date("2026-05-01T00:00:00.000Z"), contracts: 1, strike: 28, shares: 100 },
        { type: "SELL_COVERED_CALL", occurredAt: new Date("2026-05-02T00:00:00.000Z"), optionType: "CALL", contracts: 1, strike: 32, expiration: new Date("2026-11-01T00:00:00.000Z"), premium: 1 },
      ],
    });
    const results = await resolvePositionReviewsForUser("matt", [callCampaign({ id: "campaign-call-a" }), second], [schwabAccount], 3, NOON);
    expect(results.every((r) => r.result.evidence.position === "INSUFFICIENT_SHARE_COVERAGE")).toBe(true);
  });

  it("a tracked call's own matching broker row is never double-counted against its own tracked contracts", async () => {
    // 100 shares, exactly one tracked call (1 contract = 100 shares needed) whose OWN broker row
    // is present - if it were double-counted (100 needed twice = 200), this would incorrectly
    // read as insufficient against only 100 shares.
    getPositions.mockResolvedValue([equityPosition({ quantity: 100 }), callOptionPosition()]);
    const results = await resolvePositionReviewsForUser("matt", [callCampaign()], [schwabAccount], 3, NOON);
    expect(results[0]?.result.evidence.position).toBe("SCHWAB_CONFIRMED");
  });

  it("fails closed as ambiguous when conflicting/multiple broker equity rows exist for the same account+underlying", async () => {
    getPositions.mockResolvedValue([
      equityPosition({ quantity: 100 }),
      equityPosition({ quantity: 50 }), // a second, conflicting equity row for the same symbol/account
      callOptionPosition(),
    ]);
    const results = await resolvePositionReviewsForUser("matt", [callCampaign()], [schwabAccount], 3, NOON);
    expect(results[0]?.result.evidence.position).toBe("INSUFFICIENT_SHARE_COVERAGE");
  });

  it("never counts a SHORT (negative) equity row as coverage", async () => {
    getPositions.mockResolvedValue([equityPosition({ quantity: -100 }), callOptionPosition()]);
    const results = await resolvePositionReviewsForUser("matt", [callCampaign()], [schwabAccount], 3, NOON);
    expect(results[0]?.result.evidence.position).toBe("INSUFFICIENT_SHARE_COVERAGE");
  });
});

describe("Codex P2 (B, round 3) - broker-authoritative obligation model + deliverable-proof gate", () => {
  it("the REAL production shape (no provider deliverable evidence anywhere) fails closed to UNSUPPORTED_CONTRACT_DELIVERABLE even with fully sufficient broker-held shares", async () => {
    // Deliberately built WITHOUT callOptionPosition()'s test-only sharesPerContract:100 default -
    // this is the actual shape every current Schwab normalizer produces in production.
    getPositions.mockResolvedValue([
      equityPosition({ quantity: 100 }),
      { accountId: "broker-a", symbol: "UPST  261002C00030000", quantity: -1, marketValue: -100, positionReadReceivedAt: NOON, accountLabel: "Test" },
    ]);
    const results = await resolvePositionReviewsForUser("matt", [callCampaign()], [schwabAccount], 3, NOON);
    expect(results[0]?.result.evidence.position).toBe("UNSUPPORTED_CONTRACT_DELIVERABLE");
    expect(results[0]?.result.action).toBe("CANNOT_ASSESS");
  });

  it("put-side review is never affected by the covered-call deliverable-proof gate", async () => {
    getPositions.mockResolvedValue([
      { accountId: "broker-a", symbol: "UPST  261002P00025000", quantity: -1, marketValue: -100, positionReadReceivedAt: NOON, accountLabel: "Test" },
    ]);
    const results = await resolvePositionReviewsForUser("matt", [putCampaign()], [schwabAccount], 3, NOON);
    expect(results[0]?.result.evidence.position).toBe("SCHWAB_CONFIRMED");
    expect(results[0]?.result.action).toBe("COMFORTABLE");
  });

  it("the exact reproduced defect: a tracked campaign's own CLAIMED contract count must never stand in for its real broker quantity when computing a DIFFERENT campaign's coverage", async () => {
    // Campaign A: tracks 1 call, broker's ACTUAL quantity agrees (-1, EXACT match, confirmed).
    // Campaign B: tracks 1 call, but broker's ACTUAL quantity is -3 (mismatch - B's own identity
    // match fails and B resolves NOT_ASSESSED) - the real group obligation is 1 + 3 = 4 contracts
    // (400 shares), never 1 + 1 = 2 (200 shares, which 200 held shares would have wrongly covered).
    getPositions.mockResolvedValue([
      equityPosition({ quantity: 200 }),
      callOptionPosition(), // Campaign A's own contract: UPST 261002C00030000, quantity -1
      callOptionPosition({ symbol: "UPST  261101C00032000", quantity: -3 }), // Campaign B's contract: broker reports -3, not -1
    ]);
    const campaignA = callCampaign({ id: "campaign-call-a" });
    const campaignB = callCampaign({
      id: "campaign-call-b",
      events: [
        { type: "ASSIGNMENT", occurredAt: new Date("2026-05-01T00:00:00.000Z"), contracts: 1, strike: 28, shares: 100 },
        { type: "SELL_COVERED_CALL", occurredAt: new Date("2026-05-02T00:00:00.000Z"), optionType: "CALL", contracts: 1, strike: 32, expiration: new Date("2026-11-01T00:00:00.000Z"), premium: 1 },
      ],
    });

    const results = await resolvePositionReviewsForUser("matt", [campaignA, campaignB], [schwabAccount], 3, NOON);

    const resultA = results.find((r) => r.campaignId === "campaign-call-a");
    const resultB = results.find((r) => r.campaignId === "campaign-call-b");
    // B's own claimed 1 contract never matched its real broker row's -3 quantity.
    expect(resultB?.result.evidence.position).toBe("NOT_ASSESSED");
    // A's own contract matched exactly, but the GROUP's real obligation (1 + 3 = 4 contracts, 400
    // shares) exceeds the 200 held shares - never wrongly SCHWAB_CONFIRMED from an undercounted
    // (1 + 1 = 2 contract, 200 share) total.
    expect(resultA?.result.evidence.position).toBe("INSUFFICIENT_SHARE_COVERAGE");
  });

  it("treats duplicate broker rows for the identical OCC contract as ambiguous and fails the whole group closed, regardless of how much share capacity would otherwise appear available", async () => {
    getPositions.mockResolvedValue([
      equityPosition({ quantity: 1000 }), // far more than enough under ANY naive interpretation
      callOptionPosition(), // Campaign A's own contract - unique, matches cleanly
      // An UNTRACKED contract reported TWICE - a duplicate-row data anomaly this app has no
      // verified provider semantics proving is a legitimate pair of additive lots.
      callOptionPosition({ symbol: "UPST  261101C00032000", quantity: -1 }),
      callOptionPosition({ symbol: "UPST  261101C00032000", quantity: -1 }),
    ]);
    const results = await resolvePositionReviewsForUser("matt", [callCampaign()], [schwabAccount], 3, NOON);
    expect(results[0]?.result.evidence.position).toBe("INSUFFICIENT_SHARE_COVERAGE");
    expect(results[0]?.result.action).toBe("CANNOT_ASSESS");
  });
});

describe("Codex P1 (B6) - incomplete campaigns survive orchestration as CANNOT_ASSESS, never disappear", () => {
  it("an OPEN campaign with an incomplete put record (missing strike) is CANNOT_ASSESS, not dropped", async () => {
    getPositions.mockResolvedValue([]);
    const incomplete = putCampaign({
      events: [{ type: "SELL_PUT", occurredAt: new Date("2026-05-01T00:00:00.000Z"), optionType: "PUT", contracts: 1, expiration: new Date("2026-10-02T00:00:00.000Z"), premium: 1 }],
    });

    const results = await resolvePositionReviewsForUser("matt", [incomplete], [schwabAccount], 3, NOON);

    // Codex P2 (C) - leg-term completeness (expiration/contracts/strike) is now validated FIRST,
    // before position evidence is even resolved (so a MANUAL_POSITION bypass could never override
    // it) - a missing strike now produces the precise INCOMPLETE_TERMS reason directly, never the
    // more generic POSITION_NOT_ASSESSED (broker matching is never even attempted for an
    // incomplete leg, but the leg's OWN incompleteness is now the reported reason).
    expect(results).toHaveLength(1);
    expect(results[0]?.result.action).toBe("CANNOT_ASSESS");
    expect(results[0]?.result.explanation.reasonCodes).toContain("INCOMPLETE_TERMS");
    expect(results[0]?.result.priority.group).toBe(3);
  });

  it("an OPEN campaign with an incomplete put record (missing expiration) is CANNOT_ASSESS with EXPIRATION_UNKNOWN, in the high-priority group", async () => {
    getPositions.mockResolvedValue([]);
    const incomplete = putCampaign({
      events: [{ type: "SELL_PUT", occurredAt: new Date("2026-05-01T00:00:00.000Z"), optionType: "PUT", contracts: 1, strike: 25, premium: 1 }],
    });

    const results = await resolvePositionReviewsForUser("matt", [incomplete], [schwabAccount], 3, NOON);

    expect(results[0]?.result.action).toBe("CANNOT_ASSESS");
    expect(results[0]?.result.explanation.reasonCodes).toContain("EXPIRATION_UNKNOWN");
    expect(results[0]?.result.priority.group).toBe(3);
  });

  it("a genuinely put-less OPEN campaign (no open-attempt event at all) still has no leg to review", async () => {
    getPositions.mockResolvedValue([]);
    const noPutAtAll = putCampaign({ events: [{ type: "NOTE", occurredAt: new Date("2026-05-01T00:00:00.000Z"), notes: "placeholder" }] });
    const results = await resolvePositionReviewsForUser("matt", [noPutAtAll], [schwabAccount], 3, NOON);
    expect(results).toHaveLength(0);
  });

  it("an ASSIGNED campaign with an INCOMPLETE call record is Cannot assess / incomplete call evidence - never 'Assigned shares, no call'", async () => {
    getPositions.mockResolvedValue([]);
    const incompleteCall = callCampaign({
      events: [
        { type: "ASSIGNMENT", occurredAt: new Date("2026-05-01T00:00:00.000Z"), contracts: 1, strike: 25, shares: 100 },
        // Missing strike - an attempted call with a broken record, distinct from no call at all.
        { type: "SELL_COVERED_CALL", occurredAt: new Date("2026-05-02T00:00:00.000Z"), optionType: "CALL", contracts: 1, expiration: new Date("2026-10-02T00:00:00.000Z"), premium: 1 },
      ],
    });

    const results = await resolvePositionReviewsForUser("matt", [incompleteCall], [schwabAccount], 3, NOON);

    expect(results).toHaveLength(1);
    expect(results[0]?.result.lifecycle).toBe("COVERED_CALL");
    expect(results[0]?.result.action).toBe("CANNOT_ASSESS");
    // Codex P2 (C) - leg-term completeness is validated before position evidence, so the precise
    // INCOMPLETE_TERMS reason is reported directly.
    expect(results[0]?.result.explanation.reasonCodes).toContain("INCOMPLETE_TERMS");
    // Never the "no call recorded" reason - a real attempt exists, just with broken terms.
    expect(results[0]?.result.explanation.reasonCodes).not.toContain("ASSIGNED_SHARES_NO_CALL");
  });

  it("an ASSIGNED campaign with genuinely NO call ever recorded still resolves to 'Assigned shares - review next step'", async () => {
    getPositions.mockResolvedValue([]);
    const noCallAtAll = callCampaign({
      events: [{ type: "ASSIGNMENT", occurredAt: new Date("2026-05-01T00:00:00.000Z"), contracts: 1, strike: 25, shares: 100 }],
    });
    const results = await resolvePositionReviewsForUser("matt", [noCallAtAll], [schwabAccount], 3, NOON);
    expect(results[0]?.result.lifecycle).toBe("ASSIGNED_SHARES");
    expect(results[0]?.result.explanation.reasonCodes).toContain("ASSIGNED_SHARES_NO_CALL");
  });

  it("deterministic tie-breakers still apply to incomplete rows alongside ordinary ones", async () => {
    getPositions.mockResolvedValue([]);
    const incomplete = putCampaign({
      id: "campaign-incomplete",
      ticker: "AAA",
      events: [{ type: "SELL_PUT", occurredAt: new Date("2026-05-01T00:00:00.000Z"), optionType: "PUT", contracts: 1, expiration: new Date("2026-10-02T00:00:00.000Z"), premium: 1 }],
    });
    const comfortable = putCampaign({ id: "campaign-comfortable", ticker: "ZZZ" });
    getQuoteEvidence.mockResolvedValue(new Map([["AAA", quoteEvidence(30)], ["ZZZ", quoteEvidence(30)]]));

    const { resolveSortedPositionReviewsForUser: sortedFn } = await import("./position-review");
    const results = await sortedFn("matt", [comfortable, incomplete], [schwabAccount], 3, NOON);
    // Group 5 (incomplete-terms evidence failure) sorts before group 8 (comfortable) - stable and
    // deterministic regardless of input order.
    expect(results.map((r) => r.campaignId)).toEqual(["campaign-incomplete", "campaign-comfortable"]);
  });
});

describe("Codex P1 (B8) - evaluation time is captured AFTER retrieval, never before", () => {
  it("a quote that arrived after the initial request-start timestamp is still eligible when judged against the post-retrieval evaluation time", async () => {
    const requestStartedAt = NOON;
    const evaluationTime = new Date(NOON.getTime() + 5_000);
    // The trade happened AFTER the pre-fetch `now` but BEFORE the real evaluation time - under
    // the old (buggy) behavior of evaluating against the pre-fetch `now`, this would incorrectly
    // read as a future timestamp and be rejected.
    const midRetrievalTrade = new Date(NOON.getTime() + 2_000);
    getPositions.mockResolvedValue([]);
    getQuoteEvidence.mockResolvedValue(new Map([["UPST", quoteEvidence(30, midRetrievalTrade)]]));

    // A manual account isolates this test to the quote-timing question alone, bypassing broker
    // position matching (a separate concern already covered elsewhere).
    const results = await resolvePositionReviewsForUser("matt", [putCampaign({ accountId: "account-2" })], [manualAccount], 3, requestStartedAt, () => evaluationTime);

    expect(results[0]?.result.evidence.quote).toBe("ELIGIBLE");
    expect(results[0]?.result.evidence.quoteIneligibleReason).toBeNull();
    expect(results[0]?.result.action).toBe("COMFORTABLE");
  });

  it("evaluates session membership at the REAL post-retrieval time, correctly reflecting a request that crossed the regular-session close", async () => {
    const requestStartedAt = new Date(`${NY_DATE}T15:59:59-04:00`); // just before 4:00 PM ET close
    const evaluationTime = new Date(`${NY_DATE}T16:00:05-04:00`); // retrieval took long enough to cross close
    getPositions.mockResolvedValue([]);
    getQuoteEvidence.mockResolvedValue(new Map([["UPST", quoteEvidence(30, requestStartedAt)]]));

    const results = await resolvePositionReviewsForUser("matt", [putCampaign()], [schwabAccount], 3, requestStartedAt, () => evaluationTime);

    expect(results[0]?.result.evidence.session).toBe("CLOSED");
    expect(results[0]?.result.evidence.quoteIneligibleReason).toBe("MARKET_NOT_IN_REGULAR_SESSION");
  });

  it("fails closed (never reuses the wrong date's session evidence) when the NY calendar date advances during retrieval", async () => {
    const requestStartedAt = new Date(`${NY_DATE}T23:59:58-04:00`); // 11:59:58 PM ET
    const nextNyDate = "2026-06-16";
    const evaluationTime = new Date(`${nextNyDate}T00:00:02-04:00`); // retrieval crossed NY midnight
    getPositions.mockResolvedValue([]);
    // Session evidence was requested and returned for the ORIGINAL (now-stale) NY date.
    getSessionEvidence.mockResolvedValue({ ...SESSION, requestedDate: NY_DATE, returnedDate: NY_DATE });
    getQuoteEvidence.mockResolvedValue(new Map([["UPST", quoteEvidence(30, requestStartedAt)]]));

    const results = await resolvePositionReviewsForUser("matt", [putCampaign()], [schwabAccount], 3, requestStartedAt, () => evaluationTime);

    expect(results[0]?.result.evidence.session).toBe("UNAVAILABLE");
    expect(results[0]?.result.evidence.quoteIneligibleReason).toBe("SESSION_EVIDENCE_UNAVAILABLE");
  });

  it("still evaluates correctly when the NY date does NOT change during retrieval (no false-positive fail-closed)", async () => {
    const requestStartedAt = NOON;
    const evaluationTime = new Date(NOON.getTime() + 3_000); // a few seconds later, same NY date
    getPositions.mockResolvedValue([]);
    getQuoteEvidence.mockResolvedValue(new Map([["UPST", quoteEvidence(30, evaluationTime)]]));

    const results = await resolvePositionReviewsForUser("matt", [putCampaign({ accountId: "account-2" })], [manualAccount], 3, requestStartedAt, () => evaluationTime);

    expect(results[0]?.result.evidence.session).toBe("OPEN");
    expect(results[0]?.result.action).toBe("COMFORTABLE");
  });

  it("defaults the clock to the supplied `now` when no explicit clock is given - fully backward compatible", async () => {
    getPositions.mockResolvedValue([]);
    const results = await resolvePositionReviewsForUser("matt", [putCampaign()], [schwabAccount], 3, NOON);
    expect(results[0]?.result.explanation.quoteAgeMs).toBe(0);
  });

  it("resolveSortedPositionReviewsForUser forwards the injectable clock through to evaluation", async () => {
    const requestStartedAt = new Date(`${NY_DATE}T15:59:59-04:00`);
    const evaluationTime = new Date(`${NY_DATE}T16:00:05-04:00`);
    getPositions.mockResolvedValue([]);
    getQuoteEvidence.mockResolvedValue(new Map([["UPST", quoteEvidence(30, requestStartedAt)]]));

    const results = await resolveSortedPositionReviewsForUser("matt", [putCampaign()], [schwabAccount], 3, requestStartedAt, () => evaluationTime);

    expect(results[0]?.result.evidence.session).toBe("CLOSED");
  });
});

describe("Codex P1 - Dashboard/Tracker orchestration parity", () => {
  // Dashboard and Tracker each fetch campaigns/accounts via their OWN Prisma queries, carrying
  // different extra fields the shared evaluator never asked for (Dashboard's own
  // entrySnapshotJson/thesis/strategy vs. Tracker's own relation objects/visibility) before
  // mapping down to the identical PositionReviewCampaignInput/PositionReviewAccountInput shape -
  // see the exact mapping in both page.tsx files. This proves the shared orchestration's result
  // depends ONLY on that shared shape, never accidentally on which page's incidental extra fields
  // happened to be present alongside it.
  function dashboardShapedCampaign(): PositionReviewCampaignInput & { strategy: string; entrySnapshotJson: unknown; thesis: string | null } {
    return { ...putCampaign(), strategy: "CASH_SECURED_PUT", entrySnapshotJson: { note: "dashboard-only field" }, thesis: "Dashboard's own thesis field" };
  }

  function trackerShapedCampaign(): PositionReviewCampaignInput & { account: { visibility: string; name: string }; owner: { name: string } } {
    return { ...putCampaign(), account: { visibility: "PRIVATE", name: "Tracker's own account relation" }, owner: { name: "Matt" } };
  }

  it("produces an identical result whether the campaign arrives in Dashboard's own shape or Tracker's own shape", async () => {
    getPositions.mockResolvedValue([
      { accountId: "broker-a", symbol: "UPST  261002P00025000", quantity: -1, marketValue: -100, positionReadReceivedAt: NOON, accountLabel: "Test" },
    ]);

    const fromDashboardShape = await resolvePositionReviewsForUser("matt", [dashboardShapedCampaign()], [schwabAccount], 3, NOON);
    const fromTrackerShape = await resolvePositionReviewsForUser("matt", [trackerShapedCampaign()], [schwabAccount], 3, NOON);

    expect(fromTrackerShape).toEqual(fromDashboardShape);
    expect(fromDashboardShape[0]?.result.action).toBe("COMFORTABLE");
  });

  it("produces identical action/moneyness/DTE/lifecycle/evidence for the same owner+campaign+evidence+settings regardless of which page's account shape supplied the account row", async () => {
    // Dashboard's own account mapping vs. Tracker's own account mapping both reduce to the exact
    // same PositionReviewAccountInput fields - confirms neither page can drift by carrying a
    // differently-shaped account object into the shared resolver.
    const dashboardAccountShape = { id: "account-1", userId: "matt", externalAccountId: "broker-a", source: "SCHWAB" as const, brokerName: "Schwab", accountType: "Margin" };
    const trackerAccountShape = { id: "account-1", userId: "matt", externalAccountId: "broker-a", source: "SCHWAB" as const, currency: "USD", visibility: "PRIVATE" };
    getPositions.mockResolvedValue([
      { accountId: "broker-a", symbol: "UPST  261002P00025000", quantity: -1, marketValue: -100, positionReadReceivedAt: NOON, accountLabel: "Test" },
    ]);

    const fromDashboardAccount = await resolvePositionReviewsForUser("matt", [putCampaign()], [dashboardAccountShape], 3, NOON);
    const fromTrackerAccount = await resolvePositionReviewsForUser("matt", [putCampaign()], [trackerAccountShape], 3, NOON);

    expect(fromDashboardAccount[0]?.result.action).toBe(fromTrackerAccount[0]?.result.action);
    expect(fromDashboardAccount[0]?.result.explanation.moneyness).toBe(fromTrackerAccount[0]?.result.explanation.moneyness);
    expect(fromDashboardAccount[0]?.result.explanation.daysToExpiration).toBe(fromTrackerAccount[0]?.result.explanation.daysToExpiration);
    expect(fromDashboardAccount[0]?.result.lifecycle).toBe(fromTrackerAccount[0]?.result.lifecycle);
    expect(fromDashboardAccount[0]?.result.evidence).toEqual(fromTrackerAccount[0]?.result.evidence);
  });
});

describe("Codex P1 - rolled-position orchestration (realistic history, not a pre-selected leg)", () => {
  it("derives strike/expiration/review status from the CURRENT (post-roll) leg only - the original, closed leg never leaks through", async () => {
    const rolledCampaign = putCampaign({
      events: [
        // Original put: strike 20, expiring Sep 18 - if this leaked through, moneyness/DTE would
        // be computed against a strike/expiration that no longer exists.
        { type: "SELL_PUT", occurredAt: new Date("2026-04-01T00:00:00.000Z"), optionType: "PUT", contracts: 1, strike: 20, expiration: new Date("2026-09-18T00:00:00.000Z"), premium: 1 },
        { type: "ROLL_PUT_CLOSE", occurredAt: new Date("2026-05-01T00:00:00.000Z"), optionType: "PUT", contracts: 1, strike: 20, expiration: new Date("2026-09-18T00:00:00.000Z"), premium: 0.5 },
        // Rolled put: the REAL current leg - strike 25, expiring Oct 2.
        { type: "ROLL_PUT_OPEN", occurredAt: new Date("2026-05-01T00:00:00.000Z"), sortOrder: 1, optionType: "PUT", contracts: 1, strike: 25, expiration: new Date("2026-10-02T00:00:00.000Z"), premium: 1.2 },
      ],
    });
    getPositions.mockResolvedValue([
      { accountId: "broker-a", symbol: "UPST  261002P00025000", quantity: -1, marketValue: -100, positionReadReceivedAt: NOON, accountLabel: "Test" },
    ]);

    const results = await resolvePositionReviewsForUser("matt", [rolledCampaign], [schwabAccount], 3, NOON);

    expect(results).toHaveLength(1);
    expect(results[0]?.result.lifecycle).toBe("ROLLED_PUT");
    expect(results[0]?.result.explanation.strike).toBe(25); // the NEW strike, never the original 20
    expect(results[0]?.result.explanation.expiration?.toISOString().slice(0, 10)).toBe("2026-10-02"); // never Sep 18
    expect(results[0]?.result.evidence.position).toBe("SCHWAB_CONFIRMED"); // matched against the NEW contract's own OCC symbol
    expect(results[0]?.result.action).toBe("COMFORTABLE"); // quote(30) is well OTM of the new $25 strike
  });

  it("a rolled-then-closed-again put has no current leg at all - never reports the original or the intermediate strike", async () => {
    const closedAfterRoll = putCampaign({
      status: "CLOSED",
      events: [
        { type: "SELL_PUT", occurredAt: new Date("2026-04-01T00:00:00.000Z"), optionType: "PUT", contracts: 1, strike: 20, expiration: new Date("2026-09-18T00:00:00.000Z"), premium: 1 },
        { type: "ROLL_PUT_CLOSE", occurredAt: new Date("2026-05-01T00:00:00.000Z"), optionType: "PUT", contracts: 1, strike: 20, expiration: new Date("2026-09-18T00:00:00.000Z"), premium: 0.5 },
        { type: "ROLL_PUT_OPEN", occurredAt: new Date("2026-05-01T00:00:00.000Z"), sortOrder: 1, optionType: "PUT", contracts: 1, strike: 25, expiration: new Date("2026-10-02T00:00:00.000Z"), premium: 1.2 },
        { type: "CLOSE_PUT", occurredAt: new Date("2026-06-01T00:00:00.000Z"), optionType: "PUT", contracts: 1, strike: 25, expiration: new Date("2026-10-02T00:00:00.000Z"), premium: 0.1 },
      ],
    });
    getPositions.mockResolvedValue([]);
    const results = await resolvePositionReviewsForUser("matt", [closedAfterRoll], [schwabAccount], 3, NOON);
    expect(results).toHaveLength(0); // CLOSED campaigns are never part of the review set at all
  });
});
