import { describe, expect, it } from "vitest";
import {
  describeCallStrikeVsAdjustedBasis,
  getCurrentOpenCall,
  getCurrentOpenPut,
  isPastExpiration,
  optionLegValue,
  summarizeCampaign,
  type CampaignEventInput,
} from "./campaigns";

describe("campaign financial summaries", () => {
  it("values a standard option leg from per-share premium and contract count", () => {
    expect(optionLegValue({ type: "SELL_PUT", occurredAt: "2026-08-28", premium: 0.48, contracts: 1 })).toBe(48);
    expect(optionLegValue({ type: "SELL_PUT", occurredAt: "2026-08-28", premium: 1.05, contracts: 2 })).toBe(210);
  });

  it("summarizes a simple profitable cash-secured put campaign", () => {
    const summary = summarizeCampaign({
      status: "CLOSED",
      asOf: new Date("2026-09-18T20:00:00Z"),
      events: [
        { type: "SELL_PUT", occurredAt: "2026-08-28T14:00:00Z", strike: 40, contracts: 1, premium: 0.48 },
        { type: "CLOSE_PUT", occurredAt: "2026-09-04T19:00:00Z", strike: 40, contracts: 1, premium: 0.12 },
      ],
    });

    // A short option campaign realizes premium received minus buy-to-close debit and fees.
    expect(summary.totalPremiumReceived).toBe(48);
    expect(summary.optionDebitsPaid).toBe(12);
    expect(summary.realizedPL).toBe(36);
    expect(summary.totalCampaignPL).toBe(36);
    expect(summary.finalResult).toBe("GAIN");
    expect(summary.collateralCommitted).toBe(4000);
  });

  it("preserves both legs of a roll and reports net roll premium", () => {
    const summary = summarizeCampaign({
      status: "CLOSED",
      events: [
        { type: "SELL_PUT", occurredAt: "2026-08-28T14:00:00Z", strike: 40, contracts: 1, premium: 0.48 },
        { type: "ROLL_PUT_CLOSE", occurredAt: "2026-09-04T14:00:00Z", strike: 40, contracts: 1, premium: 0.71 },
        { type: "ROLL_PUT_OPEN", occurredAt: "2026-09-04T14:01:00Z", strike: 39, contracts: 1, premium: 1.02 },
        { type: "CLOSE_PUT", occurredAt: "2026-09-11T18:30:00Z", strike: 39, contracts: 1, premium: 0.12 },
      ],
    });

    expect(summary.rollDebits).toBe(71);
    expect(summary.rollCredits).toBe(102);
    expect(summary.netRollPremium).toBe(31);
    expect(summary.realizedPL).toBe(67);
    expect(summary.currentStage).toBe("Closed");
  });

  it("summarizes a multi-roll campaign that still closes positive", () => {
    const summary = summarizeCampaign({
      status: "CLOSED",
      events: [
        { type: "SELL_PUT", occurredAt: "2026-08-20T14:00:00Z", strike: 18, contracts: 1, premium: 0.36 },
        { type: "ROLL_PUT_CLOSE", occurredAt: "2026-08-27T14:00:00Z", strike: 18, contracts: 1, premium: 0.52 },
        { type: "ROLL_PUT_OPEN", occurredAt: "2026-08-27T14:01:00Z", strike: 17.5, contracts: 1, premium: 0.88 },
        { type: "ROLL_PUT_CLOSE", occurredAt: "2026-09-03T14:00:00Z", strike: 17.5, contracts: 1, premium: 0.44 },
        { type: "ROLL_PUT_OPEN", occurredAt: "2026-09-03T14:01:00Z", strike: 17, contracts: 1, premium: 0.76 },
        { type: "CLOSE_PUT", occurredAt: "2026-09-10T18:30:00Z", strike: 17, contracts: 1, premium: 0.21 },
      ],
    });

    expect(summary.totalPremiumReceived).toBe(200);
    expect(summary.optionDebitsPaid).toBe(117);
    expect(summary.realizedPL).toBe(83);
    expect(summary.finalResult).toBe("GAIN");
  });

  it("reports losing campaigns without dressing them up", () => {
    const summary = summarizeCampaign({
      status: "CLOSED",
      events: [
        { type: "SELL_PUT", occurredAt: "2026-08-28T14:00:00Z", strike: 62, contracts: 1, premium: 0.62 },
        { type: "CLOSE_PUT", occurredAt: "2026-09-01T19:00:00Z", strike: 62, contracts: 1, premium: 1.35 },
      ],
    });

    expect(summary.realizedPL).toBe(-73);
    expect(summary.finalResult).toBe("LOSS");
  });

  it("keeps an assigned campaign open and calculates adjusted basis", () => {
    const summary = summarizeCampaign({
      status: "ASSIGNED",
      events: [
        { type: "SELL_PUT", occurredAt: "2026-08-28T14:00:00Z", strike: 40, contracts: 1, premium: 0.5 },
        { type: "ASSIGNMENT", occurredAt: "2026-09-18T20:30:00Z", strike: 40, contracts: 1 },
        { type: "SELL_COVERED_CALL", occurredAt: "2026-09-21T14:00:00Z", strike: 42, contracts: 1, premium: 0.3 },
      ],
    });

    // With shares still held, option premium is realized but total campaign P/L needs a stock price.
    expect(summary.sharesHeld).toBe(100);
    expect(summary.stockCost).toBe(4000);
    expect(summary.netOptionPremium).toBe(80);
    expect(summary.realizedPL).toBe(80);
    expect(summary.totalCampaignPL).toBeNull();
    expect(summary.adjustedBasis).toBe(39.2);
    expect(summary.currentStage).toBe("Covered call");
    expect(summary.unknowns).toContain("Open assigned shares need a current stock price for total campaign P/L.");
  });

  it("realizes stock P/L from a partial sale while the remaining shares stay open", () => {
    const summary = summarizeCampaign({
      status: "ASSIGNED",
      currentUnderlyingPrice: 41,
      events: [
        { type: "SELL_PUT", occurredAt: "2026-08-28T14:00:00Z", strike: 40, contracts: 2, premium: 0.5 },
        { type: "ASSIGNMENT", occurredAt: "2026-09-18T20:30:00Z", strike: 40, contracts: 2, shares: 200 },
        { type: "STOCK_SALE", occurredAt: "2026-09-25T15:00:00Z", shares: 100, underlyingPrice: 43 },
      ],
    });

    // Half the shares were sold for a $300 gain over their $4,000 allocated cost basis; the other
    // half (also $4,000 cost basis) are still held and must not be double-counted as realized.
    expect(summary.sharesHeld).toBe(100);
    expect(summary.stockProceeds).toBe(4300);
    expect(summary.realizedPL).toBe(400);
    expect(summary.unrealizedPL).toBe(100);
    expect(summary.totalCampaignPL).toBe(500);
  });

  it("realizes full stock P/L once every assigned share has been sold", () => {
    const summary = summarizeCampaign({
      status: "CLOSED",
      events: [
        { type: "SELL_PUT", occurredAt: "2026-08-28T14:00:00Z", strike: 40, contracts: 1, premium: 0.5 },
        { type: "ASSIGNMENT", occurredAt: "2026-09-18T20:30:00Z", strike: 40, contracts: 1 },
        { type: "STOCK_SALE", occurredAt: "2026-09-25T15:00:00Z", shares: 100, underlyingPrice: 38 },
      ],
    });

    expect(summary.sharesHeld).toBe(0);
    expect(summary.realizedPL).toBe(-150);
    expect(summary.totalCampaignPL).toBe(-150);
    expect(summary.finalResult).toBe("LOSS");
  });

  it("realizes a simple expired-worthless put as premium minus fees, with no fake closing debit", () => {
    const summary = summarizeCampaign({
      status: "CLOSED",
      asOf: new Date("2026-09-05T20:00:00Z"),
      events: [
        { type: "SELL_PUT", occurredAt: "2026-08-28T14:00:00Z", strike: 23.5, contracts: 1, premium: 0.28, expiration: "2026-09-04" },
        { type: "PUT_EXPIRED", occurredAt: "2026-09-04T21:00:00Z", strike: 23.5, contracts: 1, expiration: "2026-09-04", premium: 0, fees: 0 },
      ],
    });

    expect(summary.totalPremiumReceived).toBe(28);
    expect(summary.optionDebitsPaid).toBe(0);
    expect(summary.realizedPL).toBe(28);
    expect(summary.totalCampaignPL).toBe(28);
    expect(summary.finalResult).toBe("GAIN");
    expect(summary.currentStage).toBe("Closed");
  });

  it("reduces expired-worthless realized P/L by actual broker fees, never counting secured cash", () => {
    const summary = summarizeCampaign({
      status: "CLOSED",
      events: [
        { type: "SELL_PUT", occurredAt: "2026-08-28T14:00:00Z", strike: 16.5, contracts: 1, premium: 0.68, expiration: "2026-09-04" },
        { type: "PUT_EXPIRED", occurredAt: "2026-09-04T21:00:00Z", strike: 16.5, contracts: 1, expiration: "2026-09-04", premium: 0, fees: 0.65 },
      ],
    });

    // Secured capital (strike * contracts * 100) must never appear as profit.
    expect(summary.collateralCommitted).toBe(1650);
    expect(summary.realizedPL).toBe(67.35);
    expect(summary.totalCampaignPL).toBe(67.35);
  });

  it("shows 'Expiration processing' for a still-open put once its expiration date has passed", () => {
    const summary = summarizeCampaign({
      status: "OPEN",
      asOf: new Date("2026-09-05T13:00:00Z"),
      events: [{ type: "SELL_PUT", occurredAt: "2026-08-28T14:00:00Z", strike: 17.5, contracts: 1, premium: 0.28, expiration: "2026-09-04" }],
    });

    expect(summary.currentStage).toBe("Expiration processing");
  });

  it("does not show 'Expiration processing' while expiration day itself is still trading", () => {
    const summary = summarizeCampaign({
      status: "OPEN",
      asOf: new Date("2026-09-04T14:00:00Z"),
      events: [{ type: "SELL_PUT", occurredAt: "2026-08-28T14:00:00Z", strike: 17.5, contracts: 1, premium: 0.28, expiration: "2026-09-04" }],
    });

    expect(summary.currentStage).toBe("Cash-secured put");
  });

  it("can estimate open assigned total P/L when a current stock price exists", () => {
    const summary = summarizeCampaign({
      status: "ASSIGNED",
      currentUnderlyingPrice: 41,
      events: [
        { type: "SELL_PUT", occurredAt: "2026-08-28T14:00:00Z", strike: 40, contracts: 1, premium: 0.5 },
        { type: "ASSIGNMENT", occurredAt: "2026-09-18T20:30:00Z", strike: 40, contracts: 1 },
      ],
    });

    expect(summary.unrealizedPL).toBe(100);
    expect(summary.totalCampaignPL).toBe(150);
    expect(summary.finalResult).toBe("GAIN");
  });
});

describe("getCurrentOpenPut", () => {
  it("returns the strike/contracts/expiration of the most recent SELL_PUT", () => {
    const events: CampaignEventInput[] = [
      { type: "SELL_PUT", occurredAt: "2026-08-28T14:00:00Z", strike: 17.5, contracts: 2, premium: 0.5, expiration: "2026-09-11" },
    ];
    expect(getCurrentOpenPut(events)).toEqual({ strike: 17.5, contracts: 2, expiration: new Date("2026-09-11") });
  });

  it("returns the most recent ROLL_PUT_OPEN, not an earlier closed SELL_PUT", () => {
    const events: CampaignEventInput[] = [
      { type: "SELL_PUT", occurredAt: "2026-08-01T14:00:00Z", strike: 15, contracts: 1, premium: 0.4, expiration: "2026-08-14" },
      { type: "ROLL_PUT_CLOSE", occurredAt: "2026-08-14T14:00:00Z", strike: 15, contracts: 1, premium: 0.1, expiration: "2026-08-14", groupKey: "roll1" },
      { type: "ROLL_PUT_OPEN", occurredAt: "2026-08-14T14:00:00Z", sortOrder: 1, strike: 16, contracts: 1, premium: 0.5, expiration: "2026-08-28", groupKey: "roll1" },
    ];
    expect(getCurrentOpenPut(events)).toEqual({ strike: 16, contracts: 1, expiration: new Date("2026-08-28") });
  });

  it("returns null when the most recent trade event closed the put (no active put right now)", () => {
    const events: CampaignEventInput[] = [
      { type: "SELL_PUT", occurredAt: "2026-08-01T14:00:00Z", strike: 15, contracts: 1, premium: 0.4, expiration: "2026-08-14" },
      { type: "CLOSE_PUT", occurredAt: "2026-08-10T14:00:00Z", strike: 15, contracts: 1, premium: 0.1 },
    ];
    expect(getCurrentOpenPut(events)).toBeNull();
  });

  it("returns null once assigned - the campaign no longer has an open put", () => {
    const events: CampaignEventInput[] = [
      { type: "SELL_PUT", occurredAt: "2026-08-01T14:00:00Z", strike: 15, contracts: 1, premium: 0.4, expiration: "2026-08-14" },
      { type: "ASSIGNMENT", occurredAt: "2026-08-14T20:30:00Z", strike: 15, contracts: 1 },
    ];
    expect(getCurrentOpenPut(events)).toBeNull();
  });

  it("ignores trailing NOTE events and still finds the real most recent trade event", () => {
    const events: CampaignEventInput[] = [
      { type: "SELL_PUT", occurredAt: "2026-08-01T14:00:00Z", strike: 15, contracts: 1, premium: 0.4, expiration: "2026-08-14" },
      { type: "NOTE", occurredAt: "2026-08-05T14:00:00Z", notes: "watching earnings" },
    ];
    expect(getCurrentOpenPut(events)).toEqual({ strike: 15, contracts: 1, expiration: new Date("2026-08-14") });
  });

  it("returns null for an incomplete SELL_PUT missing strike/contracts/expiration", () => {
    expect(getCurrentOpenPut([{ type: "SELL_PUT", occurredAt: "2026-08-01T14:00:00Z", contracts: 1, premium: 0.4 }])).toBeNull();
    expect(getCurrentOpenPut([{ type: "SELL_PUT", occurredAt: "2026-08-01T14:00:00Z", strike: 15, premium: 0.4 }])).toBeNull();
    expect(getCurrentOpenPut([{ type: "SELL_PUT", occurredAt: "2026-08-01T14:00:00Z", strike: 15, contracts: 1 }])).toBeNull();
  });

  it("returns null for an empty event list", () => {
    expect(getCurrentOpenPut([])).toBeNull();
  });

  describe("deterministic ordering when a roll's close/open pair ties on BOTH occurredAt and sortOrder", () => {
    // Reproduces the exact production bug: a rolled campaign (PATH/ONON-shaped - STO old put,
    // BTC old put, STO new put) whose ROLL_PUT_CLOSE/ROLL_PUT_OPEN share the same occurredAt AND
    // the same sortOrder. Without a deterministic tertiary tiebreak, JS's stable sort + reverse()
    // would pick whichever of the two happened to come LAST in the caller's input array - so the
    // Dashboard and Tracker, running structurally different Prisma queries, could each see a
    // different "current" contract for the identical underlying data. createdAt (row-creation
    // order) makes the true insert order win regardless of input array order.
    const sellOld: CampaignEventInput = {
      id: "evt-1", createdAt: "2026-09-01T14:00:00.000Z",
      type: "SELL_PUT", occurredAt: "2026-09-01T14:00:00Z", sortOrder: 0,
      strike: 15.5, contracts: 1, premium: 0.4, expiration: "2026-09-18",
    };
    const rollClose: CampaignEventInput = {
      id: "evt-2", createdAt: "2026-09-15T14:00:05.000Z",
      type: "ROLL_PUT_CLOSE", occurredAt: "2026-09-15T14:00:00Z", sortOrder: 1,
      strike: 15.5, contracts: 1, premium: 0.7, expiration: "2026-09-18", groupKey: "roll1",
    };
    const rollOpen: CampaignEventInput = {
      id: "evt-3", createdAt: "2026-09-15T14:00:06.000Z",
      type: "ROLL_PUT_OPEN", occurredAt: "2026-09-15T14:00:00Z", sortOrder: 1,
      strike: 14, contracts: 1, premium: 1.02, expiration: "2026-09-25", groupKey: "roll1",
    };
    const expectedOpenPut = { strike: 14, contracts: 1, expiration: new Date("2026-09-25") };

    it("returns the new rolled contract regardless of the input array's order", () => {
      expect(getCurrentOpenPut([sellOld, rollClose, rollOpen])).toEqual(expectedOpenPut);
      expect(getCurrentOpenPut([rollOpen, rollClose, sellOld])).toEqual(expectedOpenPut);
      expect(getCurrentOpenPut([rollClose, sellOld, rollOpen])).toEqual(expectedOpenPut);
    });

    it("falls back to id when createdAt is also absent/tied, still regardless of input order", () => {
      const closeNoCreatedAt = { ...rollClose, createdAt: undefined };
      const openNoCreatedAt = { ...rollOpen, createdAt: undefined };
      expect(getCurrentOpenPut([sellOld, closeNoCreatedAt, openNoCreatedAt])).toEqual(expectedOpenPut);
      expect(getCurrentOpenPut([openNoCreatedAt, closeNoCreatedAt, sellOld])).toEqual(expectedOpenPut);
    });
  });
});

describe("summarizeCampaign currentStage after a roll (production PATH/ONON regression)", () => {
  // Old leg (Sep 18) has expired by asOf (Sep 19); the new rolled leg (Sep 25) has not. A
  // correct implementation must report the CURRENT leg's stage, not "Expiration processing".
  const events: CampaignEventInput[] = [
    { id: "evt-1", createdAt: "2026-09-01T14:00:00.000Z", type: "SELL_PUT", occurredAt: "2026-09-01T14:00:00Z", sortOrder: 0, strike: 15.5, contracts: 1, premium: 0.4, expiration: "2026-09-18" },
    { id: "evt-2", createdAt: "2026-09-15T14:00:05.000Z", type: "ROLL_PUT_CLOSE", occurredAt: "2026-09-15T14:00:00Z", sortOrder: 1, strike: 15.5, contracts: 1, premium: 0.7, expiration: "2026-09-18", groupKey: "roll1" },
    { id: "evt-3", createdAt: "2026-09-15T14:00:06.000Z", type: "ROLL_PUT_OPEN", occurredAt: "2026-09-15T14:00:00Z", sortOrder: 1, strike: 14, contracts: 1, premium: 1.02, expiration: "2026-09-25", groupKey: "roll1" },
  ];
  const asOf = new Date("2026-09-19T15:00:00Z");

  it("reports 'Rolled put', not 'Expiration processing', once the OLD leg is past but the NEW leg is not", () => {
    const summary = summarizeCampaign({ status: "OPEN", events, asOf });
    expect(summary.currentStage).toBe("Rolled put");
  });

  it("currentCollateralCommitted reflects the CURRENT (new) strike ($1,400), while collateralCommitted keeps its historical-max meaning ($1,550, the higher old strike)", () => {
    const summary = summarizeCampaign({ status: "OPEN", events, asOf });
    expect(summary.currentCollateralCommitted).toBe(1400);
    expect(summary.collateralCommitted).toBe(1550);
  });

  it("still shows exactly Short 1 contract on the current leg after a one-contract roll", () => {
    expect(getCurrentOpenPut(events)?.contracts).toBe(1);
  });
});

describe("getCurrentOpenCall", () => {
  const assigned: CampaignEventInput = { type: "ASSIGNMENT", occurredAt: "2026-08-28T20:00:00Z", strike: 40, shares: 200 };

  it("returns the open call's strike/contracts/expiration", () => {
    const events: CampaignEventInput[] = [
      assigned,
      { type: "SELL_COVERED_CALL", occurredAt: "2026-09-01T14:00:00Z", strike: 44, contracts: 1, premium: 0.3, expiration: "2026-09-11" },
    ];
    expect(getCurrentOpenCall(events)).toEqual({ strike: 44, contracts: 1, expiration: new Date("2026-09-11") });
  });

  it("returns null once the call is closed", () => {
    const events: CampaignEventInput[] = [
      assigned,
      { type: "SELL_COVERED_CALL", occurredAt: "2026-09-01T14:00:00Z", strike: 44, contracts: 1, premium: 0.3, expiration: "2026-09-11" },
      { type: "CLOSE_COVERED_CALL", occurredAt: "2026-09-08T14:00:00Z", strike: 44, contracts: 1, premium: 0.1, expiration: "2026-09-11" },
    ];
    expect(getCurrentOpenCall(events)).toBeNull();
  });

  it("returns null once the call expires", () => {
    const events: CampaignEventInput[] = [
      assigned,
      { type: "SELL_COVERED_CALL", occurredAt: "2026-09-01T14:00:00Z", strike: 44, contracts: 1, premium: 0.3, expiration: "2026-09-11" },
      { type: "COVERED_CALL_EXPIRED", occurredAt: "2026-09-12T14:00:00Z", strike: 44, contracts: 1, premium: 0, expiration: "2026-09-11" },
    ];
    expect(getCurrentOpenCall(events)).toBeNull();
  });

  it("finds the second call after the first closes (multiple sequential calls)", () => {
    const events: CampaignEventInput[] = [
      assigned,
      { type: "SELL_COVERED_CALL", occurredAt: "2026-09-01T14:00:00Z", strike: 44, contracts: 1, premium: 0.3, expiration: "2026-09-11" },
      { type: "COVERED_CALL_EXPIRED", occurredAt: "2026-09-12T14:00:00Z", strike: 44, contracts: 1, premium: 0, expiration: "2026-09-11" },
      { type: "SELL_COVERED_CALL", occurredAt: "2026-09-14T14:00:00Z", strike: 45, contracts: 1, premium: 0.25, expiration: "2026-09-25" },
    ];
    expect(getCurrentOpenCall(events)).toEqual({ strike: 45, contracts: 1, expiration: new Date("2026-09-25") });
  });

  it("keeps reporting an open call across a later STOCK_SALE on uncovered shares", () => {
    // 200 shares assigned, 1 call over 100 shares, then the other 100 uncovered shares are sold
    // while the call is still open - see sellStockForUser's naked-call protection.
    const events: CampaignEventInput[] = [
      assigned,
      { type: "SELL_COVERED_CALL", occurredAt: "2026-09-01T14:00:00Z", strike: 44, contracts: 1, premium: 0.3, expiration: "2026-09-11" },
      { type: "STOCK_SALE", occurredAt: "2026-09-05T14:00:00Z", shares: 100, underlyingPrice: 43 },
    ];
    expect(getCurrentOpenCall(events)).toEqual({ strike: 44, contracts: 1, expiration: new Date("2026-09-11") });
  });

  it("returns null for an incomplete SELL_COVERED_CALL missing strike/contracts/expiration", () => {
    expect(getCurrentOpenCall([{ type: "SELL_COVERED_CALL", occurredAt: "2026-09-01T14:00:00Z", contracts: 1, premium: 0.3 }])).toBeNull();
  });

  it("returns null for an empty event list", () => {
    expect(getCurrentOpenCall([])).toBeNull();
  });
});

describe("describeCallStrikeVsAdjustedBasis", () => {
  it("test 11: strike above adjusted basis computes a positive, not-flagged difference", () => {
    const relationship = describeCallStrikeVsAdjustedBasis(44, 40);
    expect(relationship?.differenceDollars).toBe(4);
    expect(relationship?.differencePct).toBe(10);
    expect(relationship?.belowBasis).toBe(false);
  });

  it("test 12: strike below adjusted basis -> negative difference, flagged as belowBasis", () => {
    const relationship = describeCallStrikeVsAdjustedBasis(38, 40);
    expect(relationship?.differenceDollars).toBe(-2);
    expect(relationship?.differencePct).toBe(-5);
    expect(relationship?.belowBasis).toBe(true);
  });

  it("strike exactly at adjusted basis is not flagged as below basis", () => {
    const relationship = describeCallStrikeVsAdjustedBasis(40, 40);
    expect(relationship?.differenceDollars).toBe(0);
    expect(relationship?.belowBasis).toBe(false);
  });

  it("test 10: returns null (never fabricates a warning) when adjusted basis is unavailable", () => {
    expect(describeCallStrikeVsAdjustedBasis(44, null)).toBeNull();
  });

  it("returns null for a non-finite or non-positive strike/basis", () => {
    expect(describeCallStrikeVsAdjustedBasis(0, 40)).toBeNull();
    expect(describeCallStrikeVsAdjustedBasis(-5, 40)).toBeNull();
    expect(describeCallStrikeVsAdjustedBasis(44, 0)).toBeNull();
    expect(describeCallStrikeVsAdjustedBasis(44, -10)).toBeNull();
    expect(describeCallStrikeVsAdjustedBasis(Number.NaN, 40)).toBeNull();
  });

  it("test 13: never touches or references total campaign P/L - it only relates strike to adjusted basis", () => {
    // A campaign whose strike is below adjusted basis (a stock-exit warning) can still have a
    // positive total campaign P/L overall once prior option premium is included - the two must
    // stay independent so the warning never gets relabeled as "this trade loses money."
    const summary = summarizeCampaign({
      status: "ASSIGNED",
      currentUnderlyingPrice: 39,
      events: [
        { type: "SELL_PUT", occurredAt: "2026-08-01T14:00:00Z", strike: 40, contracts: 1, premium: 1.0 },
        { type: "ASSIGNMENT", occurredAt: "2026-08-28T20:00:00Z", strike: 40, contracts: 1, shares: 100 },
        { type: "SELL_COVERED_CALL", occurredAt: "2026-09-01T14:00:00Z", strike: 38, contracts: 1, premium: 0.3, expiration: "2026-09-11" },
      ],
    });

    expect(summary.adjustedBasis).toBe(38.7);
    const relationship = describeCallStrikeVsAdjustedBasis(38, summary.adjustedBasis);
    expect(relationship?.belowBasis).toBe(true); // strike (38) is below adjusted basis (38.70)

    // Yet the campaign is still solidly positive overall thanks to the large put premium already
    // collected - describeCallStrikeVsAdjustedBasis's return value carries no P/L field at all,
    // so nothing here can be mistaken for (or silently overwrite) the real totalCampaignPL.
    expect(summary.totalCampaignPL).toBeGreaterThan(0);
    expect(relationship).not.toHaveProperty("totalCampaignPL");
    expect(relationship).not.toHaveProperty("campaignPL");
  });
});

describe("isPastExpiration", () => {
  it("is false on expiration day itself (still trading)", () => {
    expect(isPastExpiration(new Date("2026-09-04"), new Date("2026-09-04T14:00:00Z"))).toBe(false);
  });

  it("is true the calendar day after expiration", () => {
    expect(isPastExpiration(new Date("2026-09-04"), new Date("2026-09-05T00:30:00Z"))).toBe(true);
  });

  it("is false before expiration", () => {
    expect(isPastExpiration(new Date("2026-09-04"), new Date("2026-09-01"))).toBe(false);
  });
});
