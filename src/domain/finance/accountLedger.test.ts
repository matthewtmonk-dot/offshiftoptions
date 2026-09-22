import { describe, expect, it } from "vitest";
import {
  currentAccountValue,
  endOfNyCalendarDateUtc,
  selectEffectiveBaseline,
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

describe("selectEffectiveBaseline (Account Baseline & Funding Boundaries)", () => {
  it("returns null when there is no STARTING_VALUE entry", () => {
    expect(selectEffectiveBaseline([{ type: "DEPOSIT", occurredAt: "2026-01-01", amount: 100 }])).toBeNull();
  });

  it("picks the STARTING_VALUE with the latest createdAt, never the latest occurredAt", () => {
    const effective = selectEffectiveBaseline([
      // Recorded first, but its occurredAt is LATER than the correction below - occurredAt must
      // never be used to pick the winner, since a correction can deliberately move its own date.
      { id: "first", type: "STARTING_VALUE", occurredAt: "2026-06-30", createdAt: "2026-07-01T00:00:00Z", amount: 10_000 },
      { id: "correction", type: "STARTING_VALUE", occurredAt: "2026-01-01", createdAt: "2026-07-02T00:00:00Z", amount: 9_500 },
    ]);

    expect(effective?.entry.id).toBe("correction");
    expect(effective?.value).toBe(9_500);
    expect(effective?.occurredAt).toEqual(new Date("2026-01-01"));
    expect(effective?.revisionCount).toBe(2);
  });

  it("breaks an exact createdAt tie deterministically by id (descending)", () => {
    const tiedCreatedAt = "2026-07-01T00:00:00Z";
    const effective = selectEffectiveBaseline([
      { id: "aaa", type: "STARTING_VALUE", occurredAt: "2026-01-01", createdAt: tiedCreatedAt, amount: 1 },
      { id: "zzz", type: "STARTING_VALUE", occurredAt: "2026-01-01", createdAt: tiedCreatedAt, amount: 2 },
    ]);

    expect(effective?.entry.id).toBe("zzz");
  });

  it("ignores STARTING_VALUE entries with a non-numeric amount", () => {
    const effective = selectEffectiveBaseline([
      { id: "bad", type: "STARTING_VALUE", occurredAt: "2026-01-01", createdAt: "2026-01-02T00:00:00Z", amount: null },
      { id: "good", type: "STARTING_VALUE", occurredAt: "2026-01-01", createdAt: "2026-01-01T00:00:00Z", amount: 5_000 },
    ]);

    expect(effective?.entry.id).toBe("good");
    expect(effective?.revisionCount).toBe(1);
  });

  it("falls back to occurredAt as createdAt for legacy entries that never recorded a createdAt", () => {
    const effective = selectEffectiveBaseline([{ id: "legacy", type: "STARTING_VALUE", occurredAt: "2026-01-01", amount: 10_000 }]);
    expect(effective?.createdAt).toEqual(new Date("2026-01-01"));
  });
});

describe("endOfNyCalendarDateUtc (Account Baseline & Funding Boundaries)", () => {
  it("converts an EDT calendar date to the exact end-of-day UTC instant", () => {
    expect(endOfNyCalendarDateUtc("2026-06-15").toISOString()).toBe("2026-06-16T03:59:59.999Z");
  });

  it("converts an EST calendar date to the exact end-of-day UTC instant", () => {
    expect(endOfNyCalendarDateUtc("2026-01-15").toISOString()).toBe("2026-01-16T04:59:59.999Z");
  });

  it("rejects a malformed date string", () => {
    expect(() => endOfNyCalendarDateUtc("06/15/2026")).toThrow(RangeError);
  });
});

describe("baseline correction and audit (Account Baseline & Funding Boundaries)", () => {
  it("an appended correction becomes effective while the prior revision remains in the raw entry list", () => {
    const entries = [
      { id: "original", type: "STARTING_VALUE" as const, occurredAt: "2026-06-16T03:59:59.999Z", createdAt: "2026-06-16T04:00:00Z", amount: 10_000 },
      {
        id: "correction",
        type: "STARTING_VALUE" as const,
        occurredAt: "2026-06-20T03:59:59.999Z",
        createdAt: "2026-06-21T04:00:00Z",
        amount: 10_500,
        notes: "Replaces STARTING_VALUE original - found an old statement",
      },
    ];

    const ledger = summarizeAccountLedger(entries);
    expect(ledger.effectiveBaseline?.entry.id).toBe("correction");
    expect(ledger.startingValue).toBe(10_500);
    // The prior revision is untouched in the input - nothing here mutates or removes it.
    expect(entries.find((entry) => entry.id === "original")?.amount).toBe(10_000);
  });

  it("summarizeAccountLedger and summarizeAccountPerformance agree on the same effective revision", () => {
    const entries = [
      { id: "original", type: "STARTING_VALUE" as const, occurredAt: "2026-06-16T03:59:59.999Z", createdAt: "2026-06-16T04:00:00Z", amount: 10_000 },
      { id: "correction", type: "STARTING_VALUE" as const, occurredAt: "2026-06-20T03:59:59.999Z", createdAt: "2026-06-21T04:00:00Z", amount: 10_500 },
    ];

    const ledger = summarizeAccountLedger(entries);
    const performance = summarizeAccountPerformance({ ledgerEntries: entries, asOf: new Date("2026-09-01") });

    expect(performance.ledger.effectiveBaseline?.entry.id).toBe(ledger.effectiveBaseline?.entry.id);
    expect(performance.startingCapital).toBe(10_500);
    // The superseded revision must never also be summed as a cash-flow event.
    expect(performance.cashFlowEvents.filter((event) => event.type === "STARTING_VALUE")).toHaveLength(1);
  });
});

describe("measurement interval (Account Baseline & Funding Boundaries)", () => {
  it("excludes funding at or before the baseline instant from netContributions - it is already inside the starting value", () => {
    const ledger = summarizeAccountLedger([
      { type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 10_000 },
      { type: "DEPOSIT", occurredAt: "2026-06-16T03:59:59.999Z", amount: 500 }, // exactly at the boundary
      { type: "DEPOSIT", occurredAt: "2026-07-01T00:00:00Z", amount: 300 }, // after the boundary
    ]);

    expect(ledger.netContributions).toBe(300);
  });

  it("excludes funding dated after the ending valuation instant from account performance", () => {
    const performance = summarizeAccountPerformance({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 10_000 },
        { type: "DEPOSIT", occurredAt: "2026-07-01T00:00:00Z", amount: 300 }, // inside the interval
        { type: "DEPOSIT", occurredAt: "2026-09-15T00:00:00Z", amount: 999 }, // after asOf
      ],
      asOf: new Date("2026-09-01T00:00:00Z"),
    });

    expect(performance.netContributions).toBe(300);
    expect(performance.contributionEventCount).toBe(1);
  });

  it("uses the account's own latest broker snapshot as the ending instant instead of asOf when one exists", () => {
    const performance = summarizeAccountPerformance({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 10_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-08-01T00:00:00Z", accountValue: 10_300, cash: 10_300 },
        { type: "DEPOSIT", occurredAt: "2026-08-15T00:00:00Z", amount: 500 }, // after the snapshot's asOf
      ],
      asOf: new Date("2026-12-01T00:00:00Z"), // an asOf far in the future must not override the snapshot's own date
    });

    expect(performance.netContributions).toBe(0);
  });
});

describe("funding authority and mixed-source detection (Account Baseline & Funding Boundaries)", () => {
  it("reports COMPLETE funding coverage and an available dollar gain when there is an explicit baseline and no contributions", () => {
    const performance = summarizeAccountPerformance({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 10_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_300, cash: 10_300 },
      ],
    });

    expect(performance.fundingCoverageStatus).toBe("COMPLETE");
    expect(performance.totalGain).toBe(300);
    expect(performance.totalReturnStatus).toBe("OK");
    expect(performance.totalReturnPercent).toBeCloseTo(3, 4);
  });

  it("labels an inferred (never explicit) baseline as INCOMPLETE_INFERRED_BASELINE, not COMPLETE", () => {
    const performance = summarizeAccountPerformance({
      ledgerEntries: [{ type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_123.77, cash: 10_123.77 }],
      brokerRecords: [brokerRecord({ action: "Security Transfer", amount: 10_000, occurredAt: "2026-07-20" })],
    });

    expect(performance.fundingCoverageStatus).toBe("INCOMPLETE_INFERRED_BASELINE");
    // Still allowed (pre-existing behavior) - only the label changes, not availability.
    expect(performance.totalGain).toBe(123.77);
  });

  it("withholds dollar gain and reports INCOMPLETE_MIXED_SOURCES when both a manual and a broker-transfer contribution land in the same interval", () => {
    const performance = summarizeAccountPerformance({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 10_000 },
        { type: "DEPOSIT", occurredAt: "2026-07-01T00:00:00Z", amount: 500 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 12_800, cash: 12_800 },
      ],
      brokerRecords: [brokerRecord({ action: "MoneyLink Transfer", amount: 2_000, occurredAt: "2026-08-01" })],
    });

    expect(performance.fundingCoverageStatus).toBe("INCOMPLETE_MIXED_SOURCES");
    expect(performance.totalGain).toBeNull();
    expect(performance.totalReturnStatus).toBe("INCOMPLETE_FUNDING_EVIDENCE");
    // Historical entries are never deleted just because coverage became ambiguous.
    expect(performance.cashFlowEvents).toHaveLength(3);
  });

  it("does not treat unknown/no contribution history as zero - a null netContributions leaves totalGain null too", () => {
    const performance = summarizeAccountPerformance({
      ledgerEntries: [{ type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 2_000, cash: 2_000 }],
      brokerRecords: [brokerRecord({ action: "MoneyLink Transfer", amount: 2_000, occurredAt: "2026-08-01" })],
    });

    expect(performance.startingCapital).toBeNull();
    expect(performance.netContributions).toBeNull();
    expect(performance.totalGain).toBeNull();
    expect(performance.fundingCoverageStatus).toBeNull();
  });
});

describe("percentage return stays unavailable pending the TWR/XIRR ticket (Account Baseline & Funding Boundaries)", () => {
  it("keeps totalReturnPercent null when contributions exist even though funding coverage is otherwise complete", () => {
    const performance = summarizeAccountPerformance({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 10_000 },
        { type: "DEPOSIT", occurredAt: "2026-07-01T00:00:00Z", amount: 2_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 12_100, cash: 12_100 },
      ],
    });

    expect(performance.fundingCoverageStatus).toBe("COMPLETE");
    expect(performance.totalGain).toBe(100);
    expect(performance.totalReturnPercent).toBeNull();
    expect(performance.totalReturnStatus).toBe("CONTRIBUTIONS_NEED_ADVANCED_RETURN");
  });
});
