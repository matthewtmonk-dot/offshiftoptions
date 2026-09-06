import { describe, expect, it } from "vitest";
import { classifyRow } from "./broker-record-classification-diagnostic";

function row(overrides: Partial<Parameters<typeof classifyRow>[0]> = {}): Parameters<typeof classifyRow>[0] {
  return {
    linkedCampaignId: null,
    symbol: null,
    underlyingSymbol: null,
    action: null,
    description: null,
    quantity: null,
    price: null,
    fees: null,
    occurredAt: new Date("2026-08-28T14:00:00Z"),
    metadata: null,
    ...overrides,
  };
}

describe("classifyRow", () => {
  it("classifies a correctly-normalized Sell to Open put as CAMPAIGN_READY", () => {
    const result = classifyRow(
      row({
        symbol: "APLD 260904P00023500",
        underlyingSymbol: "APLD",
        action: "Sell to Open",
        quantity: 1,
        price: 0.28,
        metadata: { optionType: "PUT", strikePrice: 23.5, expiration: "2026-09-04T00:00:00.000Z" },
      }),
    );

    expect(result.category).toBe("CAMPAIGN_READY");
    expect(result.reconciliationEligible).toBe(true);
  });

  it("classifies the real pre-fix shape (CURRENCY_USD symbol, null action) as NEEDS_REVIEW", () => {
    const result = classifyRow(row({ symbol: "CURRENCY_USD", action: null, quantity: 0.65, price: null }));

    expect(result.category).toBe("NEEDS_REVIEW");
    expect(result.classification).toBe("UNKNOWN");
  });

  it("classifies real bank interest as NON_CAMPAIGN_ACTIVITY, never needs-review", () => {
    const result = classifyRow(row({ symbol: "CURRENCY_USD", action: "Bank Interest", description: "BANK INT 0000000000 SCHWAB BANK" }));

    expect(result.category).toBe("NON_CAMPAIGN_ACTIVITY");
    expect(result.classification).toBe("INTEREST");
  });

  it("classifies a real expiration-removal record as EXPIRATION_EVIDENCE, not needs-review or campaign-ready", () => {
    const result = classifyRow(
      row({
        underlyingSymbol: "RIOT",
        action: "Removed - Expiration",
        description: "Removed due to Expiration PUT RIOT PLATFORMS INC $17.5 EXP 09/04/26",
        metadata: { optionType: "PUT", strikePrice: 17.5, expiration: "2026-09-04T00:00:00.000Z" },
      }),
    );

    expect(result.category).toBe("EXPIRATION_EVIDENCE");
    expect(result.classification).toBe("OPTION_REMOVED_EXPIRATION");
  });

  it("flags an option instrument with an unrecognized action as NEEDS_REVIEW, never silently as non-campaign activity", () => {
    // An option-instrument record whose action classifies as a plain stock buy/sell (e.g. a
    // bare "Sell" instruction) must not be hidden under NON_CAMPAIGN_ACTIVITY just because
    // STOCK_SELL is normally benign for equity trades.
    const result = classifyRow(
      row({
        symbol: "APLD 260904P00023500",
        underlyingSymbol: "APLD",
        action: "Sell",
        metadata: { optionType: "PUT", strikePrice: 23.5, expiration: "2026-09-04T00:00:00.000Z" },
      }),
    );

    expect(result.category).toBe("NEEDS_REVIEW");
    expect(result.reason).toMatch(/option instrument/i);
  });

  it("marks an already-linked record as ALREADY_LINKED regardless of its classification", () => {
    const result = classifyRow(row({ linkedCampaignId: "campaign-1", action: "Sell to Open", symbol: "APLD 260904P00023500" }));

    expect(result.category).toBe("ALREADY_LINKED");
  });

  it("never exposes the linkedCampaignId or raw metadata identifiers in the sanitized result", () => {
    const result = classifyRow(row({ linkedCampaignId: "campaign-1", metadata: { accountId: "secret-hash", brokerTransactionId: "secret-id" } }));

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret-hash");
    expect(serialized).not.toContain("secret-id");
    expect(serialized).not.toContain("campaign-1");
  });
});
