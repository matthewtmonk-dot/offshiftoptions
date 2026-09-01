import { describe, expect, it } from "vitest";
import { classifyBrokerTransactionAction, isReviewedBrokerTransactionActivity } from "./brokerTransactionActions";

describe("classifyBrokerTransactionAction", () => {
  it("classifies the real observed Schwab actions", () => {
    expect(classifyBrokerTransactionAction("Sell to Open")).toBe("SELL_TO_OPEN");
    expect(classifyBrokerTransactionAction("Buy to Close")).toBe("BUY_TO_CLOSE");
    expect(classifyBrokerTransactionAction("Bank Interest")).toBe("INTEREST");
    expect(classifyBrokerTransactionAction("Security Transfer")).toBe("TRANSFER");
  });

  it("is case-insensitive", () => {
    expect(classifyBrokerTransactionAction("SELL TO OPEN")).toBe("SELL_TO_OPEN");
  });

  it("returns UNKNOWN for an unrecognized or missing action rather than guessing", () => {
    expect(classifyBrokerTransactionAction("Some New Schwab Action Type")).toBe("UNKNOWN");
    expect(classifyBrokerTransactionAction(null)).toBe("UNKNOWN");
    expect(classifyBrokerTransactionAction("")).toBe("UNKNOWN");
  });

  it("flags UNKNOWN as needing review and everything else as reviewed", () => {
    expect(isReviewedBrokerTransactionActivity("UNKNOWN")).toBe(false);
    expect(isReviewedBrokerTransactionActivity("SELL_TO_OPEN")).toBe(true);
  });
});
