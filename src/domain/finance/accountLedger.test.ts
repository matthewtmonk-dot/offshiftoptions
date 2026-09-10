import { describe, expect, it } from "vitest";
import {
  currentAccountValue,
  summarizeAccountLedger,
  summarizeAccountPerformance,
  summarizeAccountsPerformance,
  type AccountBrokerRecordInput,
} from "./accountLedger";

function brokerRecord(input: Partial<AccountBrokerRecordInput> & { action: string | null; amount: number; occurredAt: string }): AccountBrokerRecordInput {
  return {
    id: input.id ?? `${input.action ?? "unknown"}-${input.occurredAt}-${input.amount}`,
    fingerprint: input.fingerprint ?? `${input.action ?? "unknown"}-${input.occurredAt}-${input.amount}`,
    kind: "TRANSACTION",
    status: "CONFIRMED",
    description: input.description ?? input.action,
    ...input,
  };
}

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

  it("derives starting capital from the first confirmed positive Schwab transfer", () => {
    const summary = summarizeAccountPerformance({
      ledgerEntries: [{ type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_123.77, cash: 10_123.77 }],
      brokerRecords: [brokerRecord({ action: "Security Transfer", amount: 10_000, occurredAt: "2026-07-20" })],
    });

    expect(summary.startingCapital).toBe(10_000);
    expect(summary.startingCapitalSource).toBe("BROKER_TRANSFER");
    expect(summary.netContributions).toBe(0);
    expect(summary.currentValue).toBe(10_123.77);
  });

  it("dedupes repeated broker facts before deriving the baseline", () => {
    const transfer = brokerRecord({
      id: "transfer-db-row",
      fingerprint: "same-economic-transfer",
      action: "Security Transfer",
      amount: 10_000,
      occurredAt: "2026-07-20",
    });

    const summary = summarizeAccountPerformance({
      ledgerEntries: [{ type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_000, cash: 10_000 }],
      brokerRecords: [transfer, { ...transfer, id: "duplicate-input-row" }],
    });

    expect(summary.startingCapital).toBe(10_000);
    expect(summary.cashFlowEvents.filter((event) => event.type === "STARTING_VALUE")).toHaveLength(1);
  });

  it("classifies later transfers as contributions, never trading P/L", () => {
    const summary = summarizeAccountPerformance({
      ledgerEntries: [{ type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 11_250, cash: 11_250 }],
      brokerRecords: [
        brokerRecord({ action: "Security Transfer", amount: 10_000, occurredAt: "2026-07-20" }),
        brokerRecord({ action: "MoneyLink Transfer", amount: 2_000, occurredAt: "2026-08-01" }),
        brokerRecord({ action: "ATM Withdrawal", amount: -750, occurredAt: "2026-08-15" }),
        brokerRecord({ action: "Sell to Open", amount: 50, occurredAt: "2026-08-20" }),
      ],
    });

    expect(summary.startingCapital).toBe(10_000);
    expect(summary.netContributions).toBe(1_250);
    expect(summary.tradingPL).toBe(50);
    expect(summary.totalGain).toBe(0);
    expect(summary.totalReturnPercent).toBeNull();
    expect(summary.totalReturnStatus).toBe("CONTRIBUTIONS_NEED_ADVANCED_RETURN");
  });

  it("reconciles the Schwab acceptance example into trading P/L, other income, total gain, and simple return", () => {
    const summary = summarizeAccountPerformance({
      ledgerEntries: [{ type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_123.77, cash: 10_123.77 }],
      brokerRecords: [
        brokerRecord({ action: "Security Transfer", amount: 10_000, occurredAt: "2026-07-20" }),
        brokerRecord({ action: "Sell to Open", amount: 27.34, occurredAt: "2026-08-31", fingerprint: "APLD_STO" }),
        brokerRecord({ action: "Sell to Open", amount: 27.34, occurredAt: "2026-08-31", fingerprint: "RIOT_STO" }),
        brokerRecord({ action: "Sell to Open", amount: 25.34, occurredAt: "2026-08-24", fingerprint: "CORZ_STO_1" }),
        brokerRecord({ action: "Buy to Close", amount: -23.66, occurredAt: "2026-08-28", fingerprint: "CORZ_BTC" }),
        brokerRecord({ action: "Sell to Open", amount: 67.34, occurredAt: "2026-08-28", fingerprint: "CORZ_STO_2" }),
        brokerRecord({ action: "Bank Interest", amount: 0.07, occurredAt: "2026-08-15" }),
      ],
    });

    expect(summary.startingCapital).toBe(10_000);
    expect(summary.tradingPL).toBe(123.7);
    expect(summary.otherIncome).toBe(0.07);
    expect(summary.netContributions).toBe(0);
    expect(summary.currentValue).toBe(10_123.77);
    expect(summary.totalGain).toBe(123.77);
    expect(summary.unexplainedGain).toBe(0);
    expect(summary.totalReturnPercent).toBeCloseTo(1.2377, 4);
  });

  it("keeps option trade fees inside trading P/L instead of other income", () => {
    const summary = summarizeAccountPerformance({
      ledgerEntries: [{ type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_027.34, cash: 10_027.34 }],
      brokerRecords: [
        brokerRecord({ action: "Security Transfer", amount: 10_000, occurredAt: "2026-07-20" }),
        brokerRecord({
          action: "Sell to Open",
          amount: 27.34,
          fees: 0.66,
          occurredAt: "2026-08-31",
          description: "Sell to Open 1 TST 250918P00020000 gross premium 28.00 fee 0.66",
          fingerprint: "TST_STO_NET_OF_FEE",
        }),
      ],
    });

    expect(summary.tradingPL).toBe(27.34);
    expect(summary.tradingPLSource).toBe("BROKER_TRANSACTIONS");
    expect(summary.otherIncome).toBe(0);
    expect(summary.totalGain).toBe(27.34);
    expect(summary.unexplainedGain).toBe(0);
  });

  it("keeps standalone account fees in other income and out of trading P/L", () => {
    const summary = summarizeAccountPerformance({
      ledgerEntries: [{ type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_022.34, cash: 10_022.34 }],
      brokerRecords: [
        brokerRecord({ action: "Security Transfer", amount: 10_000, occurredAt: "2026-07-20" }),
        brokerRecord({ action: "Sell to Open", amount: 27.34, fees: 0.66, occurredAt: "2026-08-31", fingerprint: "TST_STO_NET_OF_FEE" }),
        brokerRecord({ action: "Service Fee", amount: -5, occurredAt: "2026-09-01", fingerprint: "MONTHLY_SERVICE_FEE" }),
      ],
    });

    expect(summary.tradingPL).toBe(27.34);
    expect(summary.otherIncome).toBe(-5);
    expect(summary.totalGain).toBe(22.34);
    expect(summary.unexplainedGain).toBe(0);
  });

  it("prefers Schwab trade records over campaign fallback for a broker-backed account to avoid double counting", () => {
    const summary = summarizeAccountPerformance({
      ledgerEntries: [{ type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_123.77, cash: 10_123.77 }],
      brokerRecords: [
        brokerRecord({ action: "Security Transfer", amount: 10_000, occurredAt: "2026-07-20" }),
        brokerRecord({ action: "Sell to Open", amount: 27.34, occurredAt: "2026-08-31", fingerprint: "APLD_STO" }),
        brokerRecord({ action: "Sell to Open", amount: 27.34, occurredAt: "2026-08-31", fingerprint: "RIOT_STO" }),
        brokerRecord({ action: "Sell to Open", amount: 25.34, occurredAt: "2026-08-24", fingerprint: "CORZ_STO_1" }),
        brokerRecord({ action: "Buy to Close", amount: -23.66, occurredAt: "2026-08-28", fingerprint: "CORZ_BTC" }),
        brokerRecord({ action: "Sell to Open", amount: 67.34, occurredAt: "2026-08-28", fingerprint: "CORZ_STO_2" }),
      ],
      fallbackTradingPL: 69.02,
    });

    expect(summary.tradingPL).toBe(123.7);
    expect(summary.tradingPLSource).toBe("BROKER_TRANSACTIONS");
  });

  it("uses campaign fallback only while broker trade facts are unavailable", () => {
    const withoutBrokerFacts = summarizeAccountPerformance({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-07-20", amount: 10_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_069.02, cash: 10_069.02 },
      ],
      fallbackTradingPL: 69.02,
    });

    expect(withoutBrokerFacts.tradingPL).toBe(69.02);
    expect(withoutBrokerFacts.tradingPLSource).toBe("CAMPAIGNS");
    expect(withoutBrokerFacts.totalGain).toBe(69.02);
    expect(withoutBrokerFacts.otherIncome).toBeNull();

    const withBrokerFacts = summarizeAccountPerformance({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-07-20", amount: 10_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_123.7, cash: 10_123.7 },
      ],
      brokerRecords: [
        brokerRecord({ action: "Sell to Open", amount: 27.34, occurredAt: "2026-08-31", fingerprint: "APLD_STO" }),
        brokerRecord({ action: "Sell to Open", amount: 27.34, occurredAt: "2026-08-31", fingerprint: "RIOT_STO" }),
        brokerRecord({ action: "Sell to Open", amount: 25.34, occurredAt: "2026-08-24", fingerprint: "CORZ_STO_1" }),
        brokerRecord({ action: "Buy to Close", amount: -23.66, occurredAt: "2026-08-28", fingerprint: "CORZ_BTC" }),
        brokerRecord({ action: "Sell to Open", amount: 67.34, occurredAt: "2026-08-28", fingerprint: "CORZ_STO_2" }),
      ],
      fallbackTradingPL: 69.02,
    });

    expect(withBrokerFacts.tradingPL).toBe(123.7);
    expect(withBrokerFacts.tradingPLSource).toBe("BROKER_TRANSACTIONS");
    expect(withBrokerFacts.totalGain).toBe(123.7);
  });

  it("refuses to infer a broker baseline when earlier interest exists before the first funding transfer", () => {
    const summary = summarizeAccountPerformance({
      ledgerEntries: [{ type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_028.07, cash: 10_028.07 }],
      brokerRecords: [
        brokerRecord({ action: "Bank Interest", amount: 0.07, occurredAt: "2026-07-19", fingerprint: "EARLY_INTEREST" }),
        brokerRecord({ action: "Security Transfer", amount: 10_000, occurredAt: "2026-07-20" }),
        brokerRecord({ action: "Sell to Open", amount: 28, occurredAt: "2026-07-21", fingerprint: "AFTER_FUNDING_STO" }),
      ],
    });

    expect(summary.startingCapital).toBeNull();
    expect(summary.netContributions).toBeNull();
    expect(summary.tradingPL).toBe(28);
    expect(summary.otherIncome).toBe(0.07);
    expect(summary.currentValue).toBe(10_028.07);
    expect(summary.totalGain).toBeNull();
    expect(summary.totalReturnStatus).toBe("NO_BASELINE");
  });

  it("refuses to infer a broker baseline when earlier option premium exists before the first funding transfer", () => {
    const summary = summarizeAccountPerformance({
      ledgerEntries: [{ type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_028, cash: 10_028 }],
      brokerRecords: [
        brokerRecord({ action: "Sell to Open", amount: 28, occurredAt: "2026-07-19", fingerprint: "EARLY_STO" }),
        brokerRecord({ action: "Security Transfer", amount: 10_000, occurredAt: "2026-07-20" }),
      ],
    });

    expect(summary.startingCapital).toBeNull();
    expect(summary.netContributions).toBeNull();
    expect(summary.tradingPL).toBe(28);
    expect(summary.totalGain).toBeNull();
    expect(summary.totalReturnStatus).toBe("NO_BASELINE");
  });

  it("does not promote ordinary cash deposits, internal sweeps, or journal noise into starting capital", () => {
    const depositOnly = summarizeAccountPerformance({
      ledgerEntries: [{ type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 2_000, cash: 2_000 }],
      brokerRecords: [brokerRecord({ action: "MoneyLink Transfer", amount: 2_000, occurredAt: "2026-08-01" })],
    });

    expect(depositOnly.startingCapital).toBeNull();
    expect(depositOnly.netContributions).toBeNull();
    expect(depositOnly.totalGain).toBeNull();

    const withPriorHistory = summarizeAccountPerformance({
      ledgerEntries: [
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-07-01T12:00:00Z", accountValue: 5_000, cash: 5_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 7_000, cash: 7_000 },
      ],
      brokerRecords: [brokerRecord({ action: "Funds Received", amount: 2_000, occurredAt: "2026-08-01" })],
    });

    expect(withPriorHistory.startingCapital).toBeNull();
    expect(withPriorHistory.netContributions).toBeNull();
    expect(withPriorHistory.totalReturnStatus).toBe("NO_BASELINE");

    const journalOnly = summarizeAccountPerformance({
      ledgerEntries: [{ type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_000, cash: 10_000 }],
      brokerRecords: [brokerRecord({ action: "Journaled Shares", amount: 10_000, occurredAt: "2026-07-20" })],
    });

    expect(journalOnly.startingCapital).toBeNull();
    expect(journalOnly.cashFlowEvents).toHaveLength(0);
  });

  it("does not replace a manual starting value or double count the matching initial funding transfer", () => {
    const summary = summarizeAccountPerformance({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-07-20T00:00:00Z", amount: 10_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_100, cash: 10_100 },
      ],
      brokerRecords: [
        brokerRecord({ action: "Security Transfer", amount: 10_000, occurredAt: "2026-07-20T14:00:00Z" }),
        brokerRecord({ action: "Sell to Open", amount: 100, occurredAt: "2026-08-31" }),
      ],
    });

    expect(summary.startingCapital).toBe(10_000);
    expect(summary.startingCapitalSource).toBe("LEDGER");
    expect(summary.cashFlowEvents.filter((event) => event.type === "STARTING_VALUE")).toHaveLength(1);
    expect(summary.netContributions).toBe(0);
    expect(summary.tradingPL).toBe(100);
    expect(summary.totalGain).toBe(100);
  });

  it("classifies later deposits and withdrawals as contributions and leaves simple return unavailable", () => {
    const laterDeposit = summarizeAccountPerformance({
      ledgerEntries: [{ type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 12_100, cash: 12_100 }],
      brokerRecords: [
        brokerRecord({ action: "Security Transfer", amount: 10_000, occurredAt: "2026-07-20" }),
        brokerRecord({ action: "MoneyLink Transfer", amount: 2_000, occurredAt: "2026-08-01" }),
        brokerRecord({ action: "Sell to Open", amount: 100, occurredAt: "2026-08-31" }),
      ],
    });

    expect(laterDeposit.netContributions).toBe(2_000);
    expect(laterDeposit.totalGain).toBe(100);
    expect(laterDeposit.totalReturnPercent).toBeNull();
    expect(laterDeposit.totalReturnStatus).toBe("CONTRIBUTIONS_NEED_ADVANCED_RETURN");

    const laterWithdrawal = summarizeAccountPerformance({
      ledgerEntries: [{ type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 9_100, cash: 9_100 }],
      brokerRecords: [
        brokerRecord({ action: "Security Transfer", amount: 10_000, occurredAt: "2026-07-20" }),
        brokerRecord({ action: "ATM Withdrawal", amount: -1_000, occurredAt: "2026-08-01" }),
        brokerRecord({ action: "Sell to Open", amount: 100, occurredAt: "2026-08-31" }),
      ],
    });

    expect(laterWithdrawal.netContributions).toBe(-1_000);
    expect(laterWithdrawal.totalGain).toBe(100);
    expect(laterWithdrawal.totalReturnPercent).toBeNull();
    expect(laterWithdrawal.totalReturnStatus).toBe("CONTRIBUTIONS_NEED_ADVANCED_RETURN");
  });

  it("uses broker current value as authoritative and exposes unexplained divergence", () => {
    const summary = summarizeAccountPerformance({
      ledgerEntries: [{ type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_010, cash: 10_010 }],
      brokerRecords: [
        brokerRecord({ action: "Security Transfer", amount: 10_000, occurredAt: "2026-07-20" }),
        brokerRecord({ action: "Sell to Open", amount: 50, occurredAt: "2026-08-31" }),
        brokerRecord({ action: "Bank Interest", amount: 0.07, occurredAt: "2026-09-01" }),
      ],
    });

    expect(summary.currentValue).toBe(10_010);
    expect(summary.currentValueSource).toBe("SCHWAB");
    expect(summary.totalGain).toBe(10);
    expect(summary.tradingPL).toBe(50);
    expect(summary.otherIncome).toBe(0.07);
    expect(summary.unexplainedGain).toBe(-40.07);
  });

  it("aggregates multiple accounts without mixing source labels", () => {
    const summary = summarizeAccountsPerformance([
      {
        ledgerEntries: [{ type: "STARTING_VALUE", occurredAt: "2026-01-01", amount: 5_000 }],
        fallbackTradingPL: 50,
      },
      {
        ledgerEntries: [{ type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_100, cash: 10_100 }],
        brokerRecords: [
          brokerRecord({ action: "Security Transfer", amount: 10_000, occurredAt: "2026-07-20" }),
          brokerRecord({ action: "Sell to Open", amount: 100, occurredAt: "2026-08-31" }),
        ],
      },
    ]);

    expect(summary.startingCapital).toBe(15_000);
    expect(summary.currentValue).toBe(15_150);
    expect(summary.tradingPL).toBe(150);
    expect(summary.startingCapitalSource).toBe("MIXED");
    expect(summary.tradingPLSource).toBe("MIXED");
  });
});
