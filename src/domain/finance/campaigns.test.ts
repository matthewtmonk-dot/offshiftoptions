import { describe, expect, it } from "vitest";
import { optionLegValue, summarizeCampaign } from "./campaigns";

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
