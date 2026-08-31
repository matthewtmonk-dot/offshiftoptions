import { describe, expect, it } from "vitest";
import { currentAccountValue, summarizeAccountLedger } from "./accountLedger";

describe("account ledger", () => {
  it("keeps a deposit separate from trading profit", () => {
    const summary = summarizeAccountLedger([
      { type: "STARTING_VALUE", occurredAt: "2026-01-01", amount: 10_000 },
      { type: "DEPOSIT", occurredAt: "2026-02-01", amount: 2_000 },
    ]);

    expect(summary.startingValue).toBe(10_000);
    expect(summary.netContributions).toBe(2_000);
    expect(summary.ledgerDerivedValue).toBe(12_000);

    // The example from the spec: starting 10,000 + deposit 2,000 + trading P/L 300 = 12,300,
    // and the trading profit itself must read as +300, never +2,300.
    const current = currentAccountValue(summary, 300);
    expect(current.value).toBe(12_300);
    expect(current.source).toBe("MANUAL");
  });

  it("nets a withdrawal against contributions", () => {
    const summary = summarizeAccountLedger([
      { type: "STARTING_VALUE", occurredAt: "2026-01-01", amount: 10_000 },
      { type: "DEPOSIT", occurredAt: "2026-02-01", amount: 2_000 },
      { type: "WITHDRAWAL", occurredAt: "2026-03-01", amount: 500 },
    ]);

    expect(summary.netContributions).toBe(1_500);
    expect(summary.ledgerDerivedValue).toBe(11_500);
  });

  it("prefers a live Schwab snapshot as the authoritative current value", () => {
    const summary = summarizeAccountLedger([
      { type: "STARTING_VALUE", occurredAt: "2026-01-01", amount: 10_000 },
      { type: "DEPOSIT", occurredAt: "2026-02-01", amount: 2_000 },
      { type: "BROKER_SNAPSHOT", occurredAt: "2026-03-15", accountValue: 12_640, cash: 6_000 },
    ]);

    expect(summary.latestBrokerSnapshot).toMatchObject({ accountValue: 12_640, cash: 6_000 });

    const current = currentAccountValue(summary, 999);
    expect(current.value).toBe(12_640);
    expect(current.source).toBe("SCHWAB");
  });

  it("reports no ledger-derived value without a starting entry", () => {
    const summary = summarizeAccountLedger([{ type: "DEPOSIT", occurredAt: "2026-02-01", amount: 500 }]);
    expect(summary.ledgerDerivedValue).toBeNull();
    expect(currentAccountValue(summary, 0).value).toBeNull();
  });
});
