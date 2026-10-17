import { describe, expect, it } from "vitest";
import {
  classifyBrokerTransactionAction,
  classifyBrokerTransactionActivity,
  isReviewedBrokerTransactionActivity,
} from "./brokerTransactionActions";

describe("classifyBrokerTransactionAction", () => {
  it("classifies the real observed Schwab actions", () => {
    expect(classifyBrokerTransactionAction("Sell to Open")).toBe("SELL_TO_OPEN");
    expect(classifyBrokerTransactionAction("Buy to Close")).toBe("BUY_TO_CLOSE");
    expect(classifyBrokerTransactionAction("Bank Interest")).toBe("INTEREST");
    expect(classifyBrokerTransactionAction("Security Transfer")).toBe("TRANSFER");
    expect(classifyBrokerTransactionAction("Removed - Expiration")).toBe("OPTION_REMOVED_EXPIRATION");
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

describe("classifyBrokerTransactionActivity", () => {
  it("recognizes account activity from Schwab description text when action is missing", () => {
    expect(classifyBrokerTransactionActivity({ action: null, description: "TOA ACAT 0999" })).toBe("TRANSFER");
    expect(classifyBrokerTransactionActivity({ action: null, description: "BANK INT 0000000000 SCHWAB BANK" })).toBe("INTEREST");
    expect(classifyBrokerTransactionActivity({ action: null, description: "Removed due to Expiration PUT RIOT" })).toBe(
      "OPTION_REMOVED_EXPIRATION",
    );
  });

  it("still refuses unrecognized activity", () => {
    expect(classifyBrokerTransactionActivity({ action: null, description: "Some new Schwab bookkeeping row" })).toBe("UNKNOWN");
  });
});

describe("Schwab wording observed live in October 2026", () => {
  it("recognizes the separate 'Expired' notice as expiration evidence, never as assignment", () => {
    expect(classifyBrokerTransactionAction("Expired")).toBe("OPTION_REMOVED_EXPIRATION");
    expect(classifyBrokerTransactionAction("EXPIRED")).toBe("OPTION_REMOVED_EXPIRATION");
  });
  it("keeps 'Assigned' unrecognized - contrary evidence must stay flagged, not be silently reclassified", () => {
    expect(classifyBrokerTransactionAction("Assigned")).toBe("UNKNOWN");
  });
  it("recognizes a system transfer of shares and a qualified-dividend reinvestment", () => {
    expect(classifyBrokerTransactionActivity({ action: null, description: "System transfer" })).toBe("TRANSFER");
    expect(classifyBrokerTransactionAction("Qual Div Reinvest")).toBe("DIVIDEND");
  });
});
