import { describe, expect, it } from "vitest";
import { resolveRelevantCampaignLegs, type PositionReviewCampaignInput } from "./position-review-scope";

const NOW = new Date("2026-06-15T16:00:00Z");

function putCampaign(overrides: Partial<PositionReviewCampaignInput> = {}): PositionReviewCampaignInput {
  return {
    id: "campaign-1",
    ownerId: "matt",
    accountId: "account-1",
    ticker: "UPST",
    status: "OPEN",
    events: [
      {
        id: "evt-sell-put",
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
        id: "evt-sell-call",
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

describe("resolveRelevantCampaignLegs - opening event provenance (LST Last-Valid Phase 1)", () => {
  it("exposes the current open put's originating opening event id via the parallel map", () => {
    const result = resolveRelevantCampaignLegs([putCampaign()], NOW);
    expect(result.openingEventIdByCampaignId.get("campaign-1")).toBe("evt-sell-put");
  });

  it("exposes the current open call's originating opening event id via the parallel map", () => {
    const result = resolveRelevantCampaignLegs([callCampaign()], NOW);
    expect(result.openingEventIdByCampaignId.get("campaign-call")).toBe("evt-sell-call");
  });

  it("leaves existing legByCampaignId/trackedPuts/trackedCalls behavior unchanged", () => {
    const result = resolveRelevantCampaignLegs([putCampaign()], NOW);
    expect(result.legByCampaignId.get("campaign-1")).toEqual({ kind: "PUT", strike: 25, expiration: new Date("2026-10-02T00:00:00.000Z"), contracts: 1 });
    expect(result.trackedPuts).toHaveLength(1);
    expect(result.trackedPuts[0]).toMatchObject({ id: "campaign-1", strike: 25, contracts: 1 });
  });

  it("changes the opening event id after a roll, even though strike/expiration both change together", () => {
    const rolled = putCampaign({
      events: [
        {
          id: "evt-sell-put",
          type: "SELL_PUT",
          occurredAt: new Date("2026-05-01T00:00:00.000Z"),
          optionType: "PUT",
          contracts: 1,
          strike: 25,
          expiration: new Date("2026-09-11T00:00:00.000Z"),
          premium: 1,
        },
        {
          id: "evt-roll-close",
          type: "ROLL_PUT_CLOSE",
          occurredAt: new Date("2026-09-11T00:00:00.000Z"),
          contracts: 1,
          strike: 25,
          expiration: new Date("2026-09-11T00:00:00.000Z"),
          premium: 0.1,
          groupKey: "roll-1",
        },
        {
          id: "evt-roll-open",
          type: "ROLL_PUT_OPEN",
          occurredAt: new Date("2026-09-11T00:00:00.000Z"),
          contracts: 1,
          strike: 24,
          expiration: new Date("2026-10-02T00:00:00.000Z"),
          premium: 0.5,
          groupKey: "roll-1",
        },
      ],
    });

    const result = resolveRelevantCampaignLegs([rolled], NOW);
    expect(result.openingEventIdByCampaignId.get("campaign-1")).toBe("evt-roll-open");
    expect(result.openingEventIdByCampaignId.get("campaign-1")).not.toBe("evt-sell-put");
  });

  it("gives a reopened position with identical strike/expiration/contracts a different opening event id than the original", () => {
    const reopened = putCampaign({
      events: [
        {
          id: "evt-sell-put-1",
          type: "SELL_PUT",
          occurredAt: new Date("2026-05-01T00:00:00.000Z"),
          optionType: "PUT",
          contracts: 1,
          strike: 25,
          expiration: new Date("2026-10-02T00:00:00.000Z"),
          premium: 1,
        },
        {
          id: "evt-close-put-1",
          type: "CLOSE_PUT",
          occurredAt: new Date("2026-05-10T00:00:00.000Z"),
          contracts: 1,
          strike: 25,
          premium: 0.2,
        },
        {
          id: "evt-sell-put-2",
          type: "SELL_PUT",
          occurredAt: new Date("2026-05-11T00:00:00.000Z"),
          optionType: "PUT",
          contracts: 1,
          strike: 25,
          expiration: new Date("2026-10-02T00:00:00.000Z"),
          premium: 1,
        },
      ],
    });

    const result = resolveRelevantCampaignLegs([reopened], NOW);
    expect(result.openingEventIdByCampaignId.get("campaign-1")).toBe("evt-sell-put-2");
    expect(result.openingEventIdByCampaignId.get("campaign-1")).not.toBe("evt-sell-put-1");
  });

  it("sets null (never throws/undefined-crashes) when the opening event has no id", () => {
    const noId = putCampaign({
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
    });

    const result = resolveRelevantCampaignLegs([noId], NOW);
    expect(result.openingEventIdByCampaignId.get("campaign-1")).toBeNull();
  });

  it("does not set an entry for a campaign with no current leg", () => {
    const closed = putCampaign({
      events: [
        {
          id: "evt-sell-put",
          type: "SELL_PUT",
          occurredAt: new Date("2026-05-01T00:00:00.000Z"),
          optionType: "PUT",
          contracts: 1,
          strike: 25,
          expiration: new Date("2026-06-01T00:00:00.000Z"),
          premium: 1,
        },
        {
          id: "evt-close-put",
          type: "CLOSE_PUT",
          occurredAt: new Date("2026-05-20T00:00:00.000Z"),
          contracts: 1,
          strike: 25,
          premium: 0.1,
        },
      ],
    });

    const result = resolveRelevantCampaignLegs([closed], NOW);
    expect(result.openingEventIdByCampaignId.has("campaign-1")).toBe(false);
  });
});
