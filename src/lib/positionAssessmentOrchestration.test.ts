import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EquityMarketSessionEvidence, QuoteReviewEvidence } from "@/providers/market-data/types";
import type { StoredLastValidAssessment } from "@/domain/finance/positionReviewAssessment";
import { getEquityMarketSessionEvidenceForUser, getQuoteReviewEvidenceForUser } from "./live-quotes";
import { getSchwabOpenPositionsForUser } from "./workflows";
import { getLastValidPositionAssessment, getVerifiedPositionAssessmentForCurrentLeg, savePositionReviewAssessmentIfEligible } from "./positionReviewAssessmentStore";
import { resolvePositionAssessmentDisplaysForUser } from "./positionAssessmentOrchestration";
import type { PositionReviewAccountInput, PositionReviewCampaignInput } from "./position-review-scope";

vi.mock("./workflows", () => ({ getSchwabOpenPositionsForUser: vi.fn() }));
vi.mock("./live-quotes", () => ({ getQuoteReviewEvidenceForUser: vi.fn(), getEquityMarketSessionEvidenceForUser: vi.fn() }));
vi.mock("./positionReviewAssessmentStore", () => ({
  savePositionReviewAssessmentIfEligible: vi.fn(),
  getLastValidPositionAssessment: vi.fn(),
  getVerifiedPositionAssessmentForCurrentLeg: vi.fn(),
}));

const getPositions = vi.mocked(getSchwabOpenPositionsForUser);
const getQuoteEvidence = vi.mocked(getQuoteReviewEvidenceForUser);
const getSessionEvidence = vi.mocked(getEquityMarketSessionEvidenceForUser);
const saveAssessment = vi.mocked(savePositionReviewAssessmentIfEligible);
const getLastValid = vi.mocked(getLastValidPositionAssessment);
const getVerifiedCurrentLeg = vi.mocked(getVerifiedPositionAssessmentForCurrentLeg);

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

function putCampaign(overrides: Partial<PositionReviewCampaignInput> = {}): PositionReviewCampaignInput {
  return {
    id: "campaign-1",
    ownerId: "matt",
    accountId: "account-1",
    ticker: "UPST",
    status: "OPEN",
    events: [
      {
        id: "evt-1",
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

function storedFixture(overrides: Partial<StoredLastValidAssessment> = {}): StoredLastValidAssessment {
  return {
    scope: { ownerId: "matt", accountId: "account-1", campaignId: "campaign-1", openingEventId: "evt-1" },
    contextFingerprint: "fp",
    action: "COMFORTABLE",
    reasonCodes: [],
    evaluatedAt: NOON,
    nySessionDate: NY_DATE,
    regularSessionStart: new Date(`${NY_DATE}T09:30:00-04:00`),
    regularSessionEnd: new Date(`${NY_DATE}T16:00:00-04:00`),
    underlyingPrice: 30,
    underlyingTradeTime: NOON,
    ticker: "UPST",
    optionType: "PUT",
    strike: 25,
    expiration: new Date("2026-10-02T00:00:00.000Z"),
    contracts: 1,
    moneyness: "OTM",
    dollarDistance: 5,
    percentageDistance: 20,
    appliedRollBufferPercent: 3,
    positionEvidenceSource: "SCHWAB_CONFIRMED",
    brokerReceiptAt: NOON,
    evaluationPolicyVersion: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

function setUp(options: { quote?: number; equity?: boolean } = {}) {
  getPositions.mockResolvedValue([
    { accountId: "broker-a", symbol: "UPST  261002P00025000", quantity: -1, marketValue: -100, accountLabel: "Test", positionReadReceivedAt: NOON },
  ]);
  getQuoteEvidence.mockResolvedValue(new Map([["UPST", quoteEvidence(options.quote ?? 30)]]));
  getSessionEvidence.mockResolvedValue(SESSION);
  getLastValid.mockResolvedValue(null);
  getVerifiedCurrentLeg.mockResolvedValue(null);
}

describe("resolvePositionAssessmentDisplaysForUser - CURRENT", () => {
  it("a valid COMFORTABLE evaluation composes CURRENT and attempts persistence", async () => {
    setUp({ quote: 30 });
    saveAssessment.mockResolvedValue({ status: "SAVED" });
    getVerifiedCurrentLeg.mockResolvedValue(storedFixture());

    const results = await resolvePositionAssessmentDisplaysForUser("matt", [putCampaign()], [schwabAccount], 3, NOON);

    expect(results).toHaveLength(1);
    expect(results[0]!.display.state).toBe("CURRENT");
    expect(saveAssessment).toHaveBeenCalledTimes(1);
    expect(saveAssessment.mock.calls[0]![0]).toBe("matt");
    if (results[0]!.display.state === "CURRENT") {
      expect(results[0]!.display.current.action).toBe("COMFORTABLE");
      expect(results[0]!.display.lastValid).toEqual(storedFixture());
    }
  });

  // Codex blocker repair (A) regression - the exact shipped bug: WATCH/REVIEW_ROLL's own
  // reasonCodes (WITHIN_ROLL_BUFFER/PUT_AT_OR_ITM) previously made the OLD shared read-back
  // (evaluateHistoricalAssessmentEligibility's transient-outage allowlist) deny the read, leaving
  // `lastValid` wrongly null even after a successful save. Mocking
  // getVerifiedPositionAssessmentForCurrentLeg here proves the orchestration now calls the NEW,
  // narrower function for this path - calling the OLD getLastValidPositionAssessment would leave
  // this test's own `getLastValid` mock (which stays null via setUp) wrongly consulted instead.
  // (REVIEW_CALL requires an ASSIGNED campaign with an open call leg, which this PUT-campaign
  // fixture can't produce through the full resolveRelevantCampaignLegs pipeline - its own
  // reasonCode CALL_AT_OR_ITM is covered directly at the domain level, above.)
  it.each(["WATCH", "REVIEW_ROLL"] as const)("a valid %s evaluation reads back its own just-saved fallback (Codex blocker A)", async (action) => {
    const quoteFor = { WATCH: 25.3, REVIEW_ROLL: 20 }[action];
    setUp({ quote: quoteFor });
    saveAssessment.mockResolvedValue({ status: "SAVED" });
    const stored = storedFixture({ action });
    getVerifiedCurrentLeg.mockResolvedValue(stored);

    const results = await resolvePositionAssessmentDisplaysForUser("matt", [putCampaign()], [schwabAccount], 3, NOON);

    expect(results[0]!.display.state).toBe("CURRENT");
    if (results[0]!.display.state === "CURRENT") {
      expect(results[0]!.display.current.action).toBe(action);
      expect(results[0]!.display.lastValid).toEqual(stored);
    }
    expect(getVerifiedCurrentLeg).toHaveBeenCalledTimes(1);
    expect(getLastValid).not.toHaveBeenCalled();
  });

  it("CURRENT wins even when a historical row exists - current never gets masked by stale fallback data", async () => {
    setUp({ quote: 30 });
    saveAssessment.mockResolvedValue({ status: "SAVED" });
    getVerifiedCurrentLeg.mockResolvedValue(storedFixture({ action: "WATCH" }));

    const results = await resolvePositionAssessmentDisplaysForUser("matt", [putCampaign()], [schwabAccount], 3, NOON);
    expect(results[0]!.display.state).toBe("CURRENT");
  });

  it("persistence success produces a durable fallback payload via a fresh read", async () => {
    setUp({ quote: 30 });
    saveAssessment.mockResolvedValue({ status: "SAVED" });
    const stored = storedFixture();
    getVerifiedCurrentLeg.mockResolvedValue(stored);

    const results = await resolvePositionAssessmentDisplaysForUser("matt", [putCampaign()], [schwabAccount], 3, NOON);
    expect(getVerifiedCurrentLeg).toHaveBeenCalledTimes(1);
    if (results[0]!.display.state === "CURRENT") {
      expect(results[0]!.display.lastValid).toEqual(stored);
    }
  });

  it("a newer concurrent write (SUPERSEDED_BY_NEWER) still reads back the actually-durable row as the fallback", async () => {
    setUp({ quote: 30 });
    saveAssessment.mockResolvedValue({ status: "SUPERSEDED_BY_NEWER" });
    const stored = storedFixture({ underlyingPrice: 31 });
    getVerifiedCurrentLeg.mockResolvedValue(stored);

    const results = await resolvePositionAssessmentDisplaysForUser("matt", [putCampaign()], [schwabAccount], 3, NOON);
    expect(results[0]!.display.state).toBe("CURRENT");
    if (results[0]!.display.state === "CURRENT") {
      expect(results[0]!.display.lastValid).toEqual(stored);
    }
  });

  it("persistence INELIGIBLE does not invalidate CURRENT and never fabricates a fallback (no read attempted)", async () => {
    setUp({ quote: 30 });
    saveAssessment.mockResolvedValue({ status: "INELIGIBLE", reasonCode: "QUOTE_NOT_ELIGIBLE" });

    const results = await resolvePositionAssessmentDisplaysForUser("matt", [putCampaign()], [schwabAccount], 3, NOON);
    expect(results[0]!.display.state).toBe("CURRENT");
    if (results[0]!.display.state === "CURRENT") {
      expect(results[0]!.display.lastValid).toBeNull();
    }
    expect(getVerifiedCurrentLeg).not.toHaveBeenCalled();
  });

  it("persistence CONTEXT_CHANGED does not invalidate CURRENT and never fabricates a fallback", async () => {
    setUp({ quote: 30 });
    saveAssessment.mockResolvedValue({ status: "CONTEXT_CHANGED" });

    const results = await resolvePositionAssessmentDisplaysForUser("matt", [putCampaign()], [schwabAccount], 3, NOON);
    expect(results[0]!.display.state).toBe("CURRENT");
    if (results[0]!.display.state === "CURRENT") expect(results[0]!.display.lastValid).toBeNull();
  });

  it("a persistence throw never turns a valid current evaluation into a market/current failure", async () => {
    setUp({ quote: 30 });
    saveAssessment.mockRejectedValue(new Error("db exploded"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const results = await resolvePositionAssessmentDisplaysForUser("matt", [putCampaign()], [schwabAccount], 3, NOON);
    expect(results[0]!.display.state).toBe("CURRENT");
    if (results[0]!.display.state === "CURRENT") expect(results[0]!.display.lastValid).toBeNull();
    expect(getVerifiedCurrentLeg).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("a read-after-save throw still preserves CURRENT, with no fabricated fallback", async () => {
    setUp({ quote: 30 });
    saveAssessment.mockResolvedValue({ status: "SAVED" });
    getVerifiedCurrentLeg.mockRejectedValue(new Error("read exploded"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const results = await resolvePositionAssessmentDisplaysForUser("matt", [putCampaign()], [schwabAccount], 3, NOON);
    expect(results[0]!.display.state).toBe("CURRENT");
    if (results[0]!.display.state === "CURRENT") expect(results[0]!.display.lastValid).toBeNull();
    errorSpy.mockRestore();
  });
});

describe("resolvePositionAssessmentDisplaysForUser - LAST_VALID / UNAVAILABLE", () => {
  it("a CANNOT_ASSESS evaluation with an eligible historical row composes LAST_VALID", async () => {
    getPositions.mockResolvedValue(null); // BROKER_UNAVAILABLE -> CANNOT_ASSESS
    getQuoteEvidence.mockResolvedValue(new Map());
    getSessionEvidence.mockResolvedValue(SESSION);
    const stored = storedFixture();
    getLastValid.mockResolvedValue(stored);

    const results = await resolvePositionAssessmentDisplaysForUser("matt", [putCampaign()], [schwabAccount], 3, NOON);
    expect(results[0]!.display).toEqual({ state: "LAST_VALID", currentUnavailable: expect.objectContaining({ action: "CANNOT_ASSESS" }), lastValid: stored });
    expect(saveAssessment).not.toHaveBeenCalled();
  });

  it("a CANNOT_ASSESS evaluation with no eligible historical row composes UNAVAILABLE", async () => {
    getPositions.mockResolvedValue(null);
    getQuoteEvidence.mockResolvedValue(new Map());
    getSessionEvidence.mockResolvedValue(SESSION);
    getLastValid.mockResolvedValue(null);

    const results = await resolvePositionAssessmentDisplaysForUser("matt", [putCampaign()], [schwabAccount], 3, NOON);
    expect(results[0]!.display.state).toBe("UNAVAILABLE");
  });

  it("an incomplete leg (no durable identity at all) composes UNAVAILABLE without ever touching the store", async () => {
    getPositions.mockResolvedValue(null);
    getQuoteEvidence.mockResolvedValue(new Map());
    getSessionEvidence.mockResolvedValue(SESSION);
    const incomplete = putCampaign({ events: [{ id: "evt-1", type: "SELL_PUT", occurredAt: new Date("2026-05-01T00:00:00.000Z"), contracts: 1, premium: 0.4 }] });

    const results = await resolvePositionAssessmentDisplaysForUser("matt", [incomplete], [schwabAccount], 3, NOON);
    expect(results[0]!.display.state).toBe("UNAVAILABLE");
    expect(saveAssessment).not.toHaveBeenCalled();
    expect(getLastValid).not.toHaveBeenCalled();
  });

  it("a read throw on the CANNOT_ASSESS path resolves to UNAVAILABLE rather than throwing", async () => {
    getPositions.mockResolvedValue(null);
    getQuoteEvidence.mockResolvedValue(new Map());
    getSessionEvidence.mockResolvedValue(SESSION);
    getLastValid.mockRejectedValue(new Error("read exploded"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const results = await resolvePositionAssessmentDisplaysForUser("matt", [putCampaign()], [schwabAccount], 3, NOON);
    expect(results[0]!.display.state).toBe("UNAVAILABLE");
    errorSpy.mockRestore();
  });
});

describe("resolvePositionAssessmentDisplaysForUser - owner isolation (Buddy/Both)", () => {
  it("never calls save or read for a campaign that is not the authenticated user's own", async () => {
    getPositions.mockResolvedValue(null);
    getQuoteEvidence.mockResolvedValue(new Map());
    getSessionEvidence.mockResolvedValue(SESSION);
    const ericsCampaign = putCampaign({ id: "campaign-eric", ownerId: "eric" });
    const ericsAccount: PositionReviewAccountInput = { id: "account-1", userId: "eric", externalAccountId: "broker-a", source: "SCHWAB" };

    // Matt viewing Eric's campaign in a Buddy/Both batch - Matt's own id is passed as the viewer.
    const results = await resolvePositionAssessmentDisplaysForUser("matt", [ericsCampaign], [ericsAccount], 3, NOON);

    expect(saveAssessment).not.toHaveBeenCalled();
    expect(getLastValid).not.toHaveBeenCalled();
    expect(results[0]!.display.state).toBe("UNAVAILABLE");
  });

  it("never calls save or read when the account's own userId does not match the viewer, even if campaign.ownerId superficially matches", async () => {
    getPositions.mockResolvedValue(null);
    getQuoteEvidence.mockResolvedValue(new Map());
    getSessionEvidence.mockResolvedValue(SESSION);
    const mismatchedAccount: PositionReviewAccountInput = { id: "account-1", userId: "someone-else", externalAccountId: "broker-a", source: "SCHWAB" };

    const results = await resolvePositionAssessmentDisplaysForUser("matt", [putCampaign()], [mismatchedAccount], 3, NOON);
    expect(saveAssessment).not.toHaveBeenCalled();
    expect(getLastValid).not.toHaveBeenCalled();
    expect(results[0]!.display.state).toBe("UNAVAILABLE");
  });

  it("Matt's own campaign in the same mixed batch still resolves normally", async () => {
    setUp({ quote: 30 });
    saveAssessment.mockResolvedValue({ status: "SAVED" });
    getLastValid.mockResolvedValue(storedFixture());

    const mattsCampaign = putCampaign({ id: "campaign-matt" });
    const ericsCampaign = putCampaign({ id: "campaign-eric", ownerId: "eric", accountId: "account-eric" });
    const ericsAccount: PositionReviewAccountInput = { id: "account-eric", userId: "eric", externalAccountId: "broker-b", source: "SCHWAB" };

    const results = await resolvePositionAssessmentDisplaysForUser("matt", [mattsCampaign, ericsCampaign], [schwabAccount, ericsAccount], 3, NOON);
    const byId = new Map(results.map((r) => [r.campaignId, r.display]));
    expect(byId.get("campaign-matt")!.state).toBe("CURRENT");
    expect(byId.get("campaign-eric")!.state).toBe("UNAVAILABLE");
    expect(saveAssessment).toHaveBeenCalledTimes(1);
  });
});
