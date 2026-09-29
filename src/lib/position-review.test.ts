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
  it("resolves SCHWAB_CONFIRMED when a matching broker position exists with a real valuation time", async () => {
    getPositions.mockResolvedValue([
      { accountId: "broker-a", symbol: "UPST  261002P00025000", quantity: -1, marketValue: -100, valuationAsOf: NOON, accountLabel: "Test" },
    ]);

    const results = await resolvePositionReviewsForUser("matt", [putCampaign()], [schwabAccount], 3, NOON);

    expect(results).toHaveLength(1);
    expect(results[0].result.evidence.position).toBe("SCHWAB_CONFIRMED");
    expect(results[0].result.action).toBe("COMFORTABLE");
  });

  it("resolves NOT_ASSESSED when no broker position matches the campaign's contract", async () => {
    getPositions.mockResolvedValue([]);
    const results = await resolvePositionReviewsForUser("matt", [putCampaign()], [schwabAccount], 3, NOON);
    expect(results[0].result.evidence.position).toBe("NOT_ASSESSED");
  });

  it("resolves POSITION_MISMATCH_AMBIGUOUS when two campaigns compete for the same broker contract", async () => {
    getPositions.mockResolvedValue([
      { accountId: "broker-a", symbol: "UPST  261002P00025000", quantity: -1, marketValue: -100, valuationAsOf: NOON, accountLabel: "Test" },
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

  it("resolves NOT_ASSESSED (never a fabricated 'now') when a broker match exists but has no known valuation time", async () => {
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
