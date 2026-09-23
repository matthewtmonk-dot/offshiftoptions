import { withFundingSyncFixture } from "../../../test/fixtures/funding-sync";
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
    // Astra corrective patch (Issue 4): an inferred (never explicit) baseline can never prove it
    // captured original funding, so it can no longer produce a confirmed dollar gain either -
    // this account has no STARTING_VALUE entry at all, only an inferred broker-transfer baseline.
    expect(summary.totalGain).toBeNull();
    expect(summary.totalReturnPercent).toBeNull();
    expect(summary.totalReturnStatus).toBe("INCOMPLETE_FUNDING_EVIDENCE");
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
    // Astra corrective patch (Issue 4): this baseline is inferred from broker-transfer activity,
    // never an explicit STARTING_VALUE - it cannot prove original funding, so whole-account gain
    // and simple return stay unavailable even with zero detected contributions.
    expect(summary.totalGain).toBeNull();
    expect(summary.unexplainedGain).toBeNull();
    expect(summary.totalReturnPercent).toBeNull();
    expect(summary.totalReturnStatus).toBe("INCOMPLETE_FUNDING_EVIDENCE");
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
    // Astra corrective patch (Issue 4): inferred (not explicit) baseline - gain stays unavailable.
    expect(summary.totalGain).toBeNull();
    expect(summary.unexplainedGain).toBeNull();
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
    // Astra corrective patch (Issue 4): inferred (not explicit) baseline - gain stays unavailable.
    expect(summary.totalGain).toBeNull();
    expect(summary.unexplainedGain).toBeNull();
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
    // Both fixtures have a valid Schwab snapshot after the baseline, so totalGain is reachable here
    // only with explicit proof of transaction coverage (Astra corrective patch, Issue 2) - this
    // test is about tradingPL SOURCE selection (CAMPAIGNS vs BROKER_TRANSACTIONS), not funding
    // coverage, so that proof is supplied to keep exercising totalGain's downstream value.
    const withoutBrokerFacts = summarizeAccountPerformance(withFundingSyncFixture({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-07-20", amount: 10_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_069.02, cash: 10_069.02 },
      ],
      fallbackTradingPL: 69.02,
    }));

    expect(withoutBrokerFacts.tradingPL).toBe(69.02);
    expect(withoutBrokerFacts.tradingPLSource).toBe("CAMPAIGNS");
    expect(withoutBrokerFacts.totalGain).toBe(69.02);
    expect(withoutBrokerFacts.otherIncome).toBeNull();

    const withBrokerFacts = summarizeAccountPerformance(withFundingSyncFixture({
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
    }));

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

  it("does not double count a same-day funding transfer that landed before the baseline's own end-of-day instant", () => {
    // Astra corrective patch, second pass (Issue 1): a real baseline's occurredAt is always an
    // America/New_York END-OF-DAY instant (endOfNyCalendarDateUtc), never midnight - so a transfer
    // that establishes the baseline is normally dated BEFORE that instant, and the plain interval
    // boundary excludes it correctly with no date/amount matching needed at all. (The old version
    // of this test used an unrealistic midnight-UTC baseline timestamp specifically to exercise the
    // now-removed date/amount dedup - see the sibling "still counts a later transfer..." test below
    // for why that dedup was actually unsafe.)
    const summary = summarizeAccountPerformance(withFundingSyncFixture({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-07-20T23:59:59.999Z", amount: 10_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_100, cash: 10_100 },
      ],
      brokerRecords: [
        brokerRecord({ action: "Security Transfer", amount: 10_000, occurredAt: "2026-07-20T14:00:00Z" }), // before the EOD baseline instant
        brokerRecord({ action: "Sell to Open", amount: 100, occurredAt: "2026-08-31" }),
      ],
    }));

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
    // Astra corrective patch (Issue 4): inferred (not explicit) baseline - gain stays unavailable
    // regardless of the separate contributions-need-advanced-return limitation.
    expect(laterDeposit.totalGain).toBeNull();
    expect(laterDeposit.totalReturnPercent).toBeNull();
    expect(laterDeposit.totalReturnStatus).toBe("INCOMPLETE_FUNDING_EVIDENCE");

    const laterWithdrawal = summarizeAccountPerformance({
      ledgerEntries: [{ type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 9_100, cash: 9_100 }],
      brokerRecords: [
        brokerRecord({ action: "Security Transfer", amount: 10_000, occurredAt: "2026-07-20" }),
        brokerRecord({ action: "ATM Withdrawal", amount: -1_000, occurredAt: "2026-08-01" }),
        brokerRecord({ action: "Sell to Open", amount: 100, occurredAt: "2026-08-31" }),
      ],
    });

    expect(laterWithdrawal.netContributions).toBe(-1_000);
    expect(laterWithdrawal.totalGain).toBeNull();
    expect(laterWithdrawal.totalReturnPercent).toBeNull();
    expect(laterWithdrawal.totalReturnStatus).toBe("INCOMPLETE_FUNDING_EVIDENCE");
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
    // Astra corrective patch (Issue 4): inferred (not explicit) baseline - gain stays unavailable,
    // so the unexplained-divergence figure derived from it does too (currentValue/tradingPL/
    // otherIncome themselves are unaffected - they don't depend on funding-coverage confidence).
    expect(summary.totalGain).toBeNull();
    expect(summary.tradingPL).toBe(50);
    expect(summary.otherIncome).toBe(0.07);
    expect(summary.unexplainedGain).toBeNull();
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

    // startingCapital/tradingPL are reported regardless of gain-trustworthiness - both accounts
    // have SOME number for each, so the sums and MIXED source labels still aggregate normally.
    expect(summary.startingCapital).toBe(15_000);
    expect(summary.tradingPL).toBe(150);
    expect(summary.startingCapitalSource).toBe("MIXED");
    expect(summary.tradingPLSource).toBe("MIXED");
    // Astra corrective patch (Issues 4 & 5): account 1 has an explicit baseline but NO broker
    // snapshot and only an undated lifetime CAMPAIGNS trading P/L to reconstruct a value from -
    // that can never be proven to fall entirely after the baseline (Issue 5), so its own
    // currentValue/totalGain are unavailable. Account 2's baseline is inferred, not explicit
    // (Issue 4), so its gain is also unavailable even though its currentValue (Schwab-snapshot-
    // backed) is fine. The aggregate must not silently sum a null account's contribution as zero.
    expect(summary.currentValue).toBeNull();
    expect(summary.totalGain).toBeNull();
    expect(summary.fundingCoverageStatus).toBe("INCOMPLETE_INFERRED_BASELINE");
  });

  it("suppresses aggregate gain when only one of several accounts has incomplete funding coverage", () => {
    const summary = summarizeAccountsPerformance([
      {
        // Clean, complete account: explicit baseline, no contributions, valid snapshot.
        ledgerEntries: [
          { type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 10_000 },
          { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_300, cash: 10_300 },
        ],
      },
      {
        // A second, otherwise-fine account whose contributions are ambiguous (mixed sources).
        ledgerEntries: [
          { type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 5_000 },
          { type: "DEPOSIT", occurredAt: "2026-07-01T00:00:00Z", amount: 500 },
          { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 6_800, cash: 6_800 },
        ],
        brokerRecords: [brokerRecord({ action: "MoneyLink Transfer", amount: 1_000, occurredAt: "2026-08-01" })],
      },
    ]);

    expect(summary.currentValue).toBe(17_100);
    expect(summary.startingCapital).toBe(15_000);
    // Both accounts have a real currentValue/startingCapital, but the second account's ambiguous
    // funding must still withhold the COMBINED gain - one bad account spoils the aggregate.
    expect(summary.totalGain).toBeNull();
    expect(summary.fundingCoverageStatus).toBe("INCOMPLETE_MIXED_SOURCES");
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
  it("converts a normal EST calendar date to the exact end-of-day UTC instant", () => {
    expect(endOfNyCalendarDateUtc("2026-01-15").toISOString()).toBe("2026-01-16T04:59:59.999Z");
  });

  it("converts a normal EDT calendar date to the exact end-of-day UTC instant", () => {
    expect(endOfNyCalendarDateUtc("2026-06-15").toISOString()).toBe("2026-06-16T03:59:59.999Z");
  });

  it("rejects a malformed date string", () => {
    expect(() => endOfNyCalendarDateUtc("06/15/2026")).toThrow(RangeError);
  });

  // Astra corrective patch (Issue 7, should-fix): Date.UTC silently normalizes an impossible date
  // (e.g. month 13 rolls into the next year, day 30 of February rolls into March) instead of
  // rejecting it - endOfNyCalendarDateUtc must validate the calendar components itself first.
  describe("calendar validation (Issue 7)", () => {
    const wellAfter2026 = new Date("2027-01-01T00:00:00Z");

    it("2026 DST spring-transition date (America/New_York springs forward at 2am on 2026-03-08) still converts correctly", () => {
      expect(endOfNyCalendarDateUtc("2026-03-08", wellAfter2026).toISOString()).toBe("2026-03-09T03:59:59.999Z");
    });

    it("2026 DST fall-transition date (America/New_York falls back at 2am on 2026-11-01) still converts correctly", () => {
      expect(endOfNyCalendarDateUtc("2026-11-01", wellAfter2026).toISOString()).toBe("2026-11-02T04:59:59.999Z");
    });

    it("accepts Feb 29 in a real leap year", () => {
      // 2024 is a leap year and is safely in the past relative to any real "now" during this ticket.
      expect(() => endOfNyCalendarDateUtc("2024-02-29")).not.toThrow();
      expect(endOfNyCalendarDateUtc("2024-02-29").toISOString()).toBe("2024-03-01T04:59:59.999Z");
    });

    it("rejects Feb 29 in a non-leap year", () => {
      expect(() => endOfNyCalendarDateUtc("2023-02-29")).toThrow(RangeError);
    });

    it("rejects Feb 30 in any year", () => {
      expect(() => endOfNyCalendarDateUtc("2024-02-30")).toThrow(RangeError);
      expect(() => endOfNyCalendarDateUtc("2023-02-30")).toThrow(RangeError);
    });

    it("rejects an impossible month", () => {
      expect(() => endOfNyCalendarDateUtc("2026-13-01")).toThrow(RangeError);
      expect(() => endOfNyCalendarDateUtc("2026-00-01")).toThrow(RangeError);
    });

    it("rejects a future baseline instant relative to the supplied reference time", () => {
      const referenceNow = new Date("2026-06-15T12:00:00Z");
      expect(() => endOfNyCalendarDateUtc("2026-06-16", referenceNow)).toThrow(RangeError);
      // The boundary itself (a date whose end-of-day instant is still before referenceNow) is fine.
      expect(() => endOfNyCalendarDateUtc("2026-06-14", referenceNow)).not.toThrow();
    });
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
  it("reports COMPLETE funding coverage and an available dollar gain when there is an explicit baseline, no contributions, and proven Schwab transaction coverage", () => {
    const performance = summarizeAccountPerformance(withFundingSyncFixture({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 10_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_300, cash: 10_300 },
      ],
      // Astra corrective patch, second pass (Issue 2): a short interval alone is no longer
      // sufficient for a Schwab-evidenced account - the caller must also affirmatively prove
      // transaction fetch+persistence succeeded.

    }));

    expect(performance.fundingCoverageStatus).toBe("COMPLETE");
    expect(performance.totalGain).toBe(300);
    expect(performance.totalReturnStatus).toBe("OK");
    expect(performance.totalReturnPercent).toBeCloseTo(3, 4);
  });

  it("labels an inferred (never explicit) baseline as INCOMPLETE_INFERRED_BASELINE and withholds gain", () => {
    const performance = summarizeAccountPerformance({
      ledgerEntries: [{ type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_123.77, cash: 10_123.77 }],
      brokerRecords: [brokerRecord({ action: "Security Transfer", amount: 10_000, occurredAt: "2026-07-20" })],
    });

    expect(performance.fundingCoverageStatus).toBe("INCOMPLETE_INFERRED_BASELINE");
    // Astra corrective patch (Issue 4, blocker): an inferred baseline can never prove it captured
    // original funding - a confirmed dollar gain must not be shown from it, even with zero
    // detected contributions. (Previously this was allowed; that was exactly the bug Astra found.)
    expect(performance.totalGain).toBeNull();
    expect(performance.totalReturnStatus).toBe("INCOMPLETE_FUNDING_EVIDENCE");
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
    const performance = summarizeAccountPerformance(withFundingSyncFixture({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 10_000 },
        { type: "DEPOSIT", occurredAt: "2026-07-01T00:00:00Z", amount: 2_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 12_100, cash: 12_100 },
      ],
    }));

    expect(performance.fundingCoverageStatus).toBe("COMPLETE");
    expect(performance.totalGain).toBe(100);
    expect(performance.totalReturnPercent).toBeNull();
    expect(performance.totalReturnStatus).toBe("CONTRIBUTIONS_NEED_ADVANCED_RETURN");
  });
});

describe("Astra corrective patch - superseded baselines must not suppress real funding (Issue 1, blocker)", () => {
  it("a superseded STARTING_VALUE's date/amount must never suppress a genuine later broker deposit", () => {
    // Exact Astra repro: superseded $500 STARTING_VALUE dated Aug 2, corrected effective baseline
    // $10,000 dated in July, and a GENUINE $500 broker deposit also on Aug 2. The old code matched
    // the deposit against the superseded revision's date/amount and silently dropped it.
    const performance = summarizeAccountPerformance(withFundingSyncFixture({
      ledgerEntries: [
        { id: "superseded", type: "STARTING_VALUE", occurredAt: "2026-08-02T00:00:00Z", createdAt: "2026-07-01T00:00:00Z", amount: 500 },
        { id: "effective", type: "STARTING_VALUE", occurredAt: "2026-07-01T00:00:00Z", createdAt: "2026-07-05T00:00:00Z", amount: 10_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_500, cash: 10_500 },
      ],
      brokerRecords: [brokerRecord({ action: "Security Transfer", amount: 500, occurredAt: "2026-08-02T00:00:00Z" })],
    }));

    expect(performance.startingCapital).toBe(10_000);
    expect(performance.netContributions).toBe(500);
    expect(performance.fundingCoverageStatus).toBe("COMPLETE");
    expect(performance.totalGain).toBe(0); // 10,500 - 10,000 - 500 = 0, never 500
  });

  it("a transfer strictly after the baseline's exact timestamp is always a contribution, regardless of matching the baseline's own date/amount (Astra corrective patch, second pass)", () => {
    // Exact new Astra repro: an explicit baseline of $10,000 at end of Sep 1 America/New_York, and
    // a GENUINE $10,000 broker deposit on Sep 2 afternoon. The baseline's own occurredAt (an NY
    // end-of-day instant) lands on Sep 2 in UTC - the same UTC calendar date as the afternoon
    // deposit - so the old same-day/same-amount dedup wrongly matched and suppressed it. There is
    // no such dedup left: only the exact timestamp boundary decides, and matching amount/date is
    // irrelevant.
    const performance = summarizeAccountPerformance(withFundingSyncFixture({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: endOfNyCalendarDateUtc("2026-09-01", new Date("2026-09-03T00:00:00Z")), amount: 10_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 20_000, cash: 20_000 },
      ],
      brokerRecords: [brokerRecord({ action: "Security Transfer", amount: 10_000, occurredAt: "2026-09-02T18:00:00Z" })],
    }));

    expect(performance.startingCapital).toBe(10_000);
    expect(performance.netContributions).toBe(10_000); // the genuine Sep 2 deposit, never suppressed
    expect(performance.totalGain).toBe(0); // 20,000 - 10,000 - 10,000 = 0, never the old wrong 10,000
    expect(performance.totalReturnPercent).toBeNull(); // a real contribution exists in the interval
  });

  it("a transfer at/before the baseline's exact timestamp is still excluded by the interval boundary alone, with no date/amount matching needed", () => {
    const performance = summarizeAccountPerformance(withFundingSyncFixture({
      ledgerEntries: [
        { id: "effective", type: "STARTING_VALUE", occurredAt: "2026-07-20T23:59:59.999Z", amount: 10_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-10T12:00:00Z", accountValue: 10_000, cash: 10_000 },
      ],
      brokerRecords: [brokerRecord({ action: "Security Transfer", amount: 10_000, occurredAt: "2026-07-20T14:00:00Z" })],
    }));

    expect(performance.netContributions).toBe(0);
    expect(performance.cashFlowEvents.filter((event) => event.type !== "STARTING_VALUE")).toHaveLength(0);
  });
});

describe("Astra corrective patch - valuation and funding share one measurement interval (Issue 2, blocker)", () => {
  it("a manual deposit dated after asOf never leaks into netContributions, and with no ending snapshot the whole-account gain stays unavailable regardless (Astra corrective patch, third pass)", () => {
    const performance = summarizeAccountPerformance({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 10_000 },
        { type: "DEPOSIT", occurredAt: "2026-07-01T00:00:00Z", amount: 300 }, // inside the interval
        { type: "DEPOSIT", occurredAt: "2026-09-15T00:00:00Z", amount: 999 }, // after asOf - must not leak
      ],
      asOf: new Date("2026-09-01T00:00:00Z"),
    });

    // netContributions itself is still correctly bounded - the post-asOf $999 deposit is excluded.
    expect(performance.netContributions).toBe(300);
    // Astra corrective patch, third pass: baseline + contributions is never a supported ending
    // valuation on its own (no way to rule out interest/fees/dividends/other unrecorded changes) -
    // there is no broker snapshot here, so currentValue/gain are unavailable regardless of how
    // correctly netContributions itself is bounded.
    expect(performance.currentValue).toBeNull();
    expect(performance.totalGain).toBeNull();
    expect(performance.totalReturnStatus).toBe("NO_CURRENT_VALUE");
  });

  it("a withdrawal dated after asOf never leaks into netContributions, and with no ending snapshot the whole-account gain stays unavailable regardless (Astra corrective patch, third pass)", () => {
    const performance = summarizeAccountPerformance({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 10_000 },
        { type: "WITHDRAWAL", occurredAt: "2026-09-15T00:00:00Z", amount: 400 }, // after asOf
      ],
      asOf: new Date("2026-09-01T00:00:00Z"),
    });

    expect(performance.netContributions).toBe(0);
    expect(performance.currentValue).toBeNull();
    expect(performance.totalGain).toBeNull();
  });

  it("a BROKER_SNAPSHOT dated before the baseline cannot serve as the ending valuation", () => {
    // Exact Astra repro: baseline $10,000, the ONLY broker snapshot is $9,000 from before the
    // baseline - must never produce gain = -$1,000. The snapshot describes a different, earlier
    // state of the account than the one the baseline started measuring.
    const performance = summarizeAccountPerformance({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-06-16T03:59:59.999Z", amount: 10_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-05-01T00:00:00Z", accountValue: 9_000, cash: 9_000 },
      ],
    });

    expect(performance.currentValue).toBeNull();
    expect(performance.currentValueSource).toBeNull();
    expect(performance.totalGain).toBeNull();
    expect(performance.totalReturnStatus).toBe("NO_CURRENT_VALUE");
  });
});

describe("Astra corrective patch - affirmative funding-coverage evidence required (Issue 3, blocker)", () => {
  it("an explicit baseline whose interval exceeds the Schwab transaction lookback window cannot claim complete coverage", () => {
    // Every Schwab sync only ever re-fetches a trailing 90-day window of transactions - a snapshot
    // more than 90 days after the baseline can never affirmatively prove no transfer was missed
    // in between, since anything older than the last sync's lookback was simply never observed.
    const performance = summarizeAccountPerformance({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-01-01T00:00:00Z", amount: 10_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-06-01T00:00:00Z", accountValue: 10_300, cash: 10_300 }, // 151 days later
      ],
    });

    expect(performance.fundingCoverageStatus).toBe("INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY");
    expect(performance.totalGain).toBeNull();
    expect(performance.totalReturnStatus).toBe("INCOMPLETE_FUNDING_EVIDENCE");
    // The current value reading itself is still shown - Schwab's own balance is accurate
    // regardless of whether we can prove complete historical transfer coverage.
    expect(performance.currentValue).toBe(10_300);
  });

  it("an explicit baseline whose interval fits inside the lookback window is COMPLETE only with proven transaction coverage (Astra corrective patch, second pass)", () => {
    // Fitting inside the 90-day window is necessary but no longer sufficient on its own (Issue 2,
    // second pass): "we asked Schwab for 90 days" is not proof we successfully received and
    // persisted them - the caller must also affirmatively vouch for this account's coverage.
    const withoutProof = summarizeAccountPerformance({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-01-01T00:00:00Z", amount: 10_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-03-01T00:00:00Z", accountValue: 10_300, cash: 10_300 }, // 59 days later
      ],
    });
    expect(withoutProof.fundingCoverageStatus).toBe("INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY");
    expect(withoutProof.totalGain).toBeNull();

    const performance = summarizeAccountPerformance(withFundingSyncFixture({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-01-01T00:00:00Z", amount: 10_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-03-01T00:00:00Z", accountValue: 10_300, cash: 10_300 }, // 59 days later
      ],
    }));

    expect(performance.fundingCoverageStatus).toBe("COMPLETE");
    expect(performance.totalGain).toBe(300);
  });

  it("a MANUAL account with no Schwab evidence at all is never subject to the Schwab-lookback check, even though its funding coverage is otherwise complete", () => {
    const performance = summarizeAccountPerformance({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-01-01T00:00:00Z", amount: 10_000 },
        { type: "DEPOSIT", occurredAt: "2026-06-01T00:00:00Z", amount: 500 }, // 151 days after baseline
      ],
      asOf: new Date("2026-06-02T00:00:00Z"),
    });

    // Funding coverage is COMPLETE - a manual account's own ledger entries are its funding
    // authority, and there is no Schwab evidence here to be "unverified" against. But funding
    // coverage is orthogonal to whether a SUPPORTED ENDING VALUATION exists (Astra corrective
    // patch, third pass): with no broker snapshot at all, currentValue/gain stay unavailable
    // regardless - a baseline plus ledger funding events alone is never an ending valuation.
    expect(performance.fundingCoverageStatus).toBe("COMPLETE");
    expect(performance.currentValue).toBeNull();
    expect(performance.totalGain).toBeNull();
    expect(performance.totalReturnStatus).toBe("NO_CURRENT_VALUE");
  });
});

describe("Astra corrective patch - lifetime trading P/L is never added onto a dated baseline (Issue 5, blocker)", () => {
  it("does not add undated lifetime CAMPAIGNS trading P/L onto an explicit baseline's reconstructed value", () => {
    // Exact Astra repro: baseline on Sep 1 = $10,000 that ALREADY includes $500 of earlier trading
    // gains; the old fallback added the lifetime +$500 again, producing a fabricated $10,500.
    const performance = summarizeAccountPerformance({
      ledgerEntries: [{ type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 }],
      fallbackTradingPL: 500, // undated, lifetime campaign P/L - may have happened before OR after Sep 1
      asOf: new Date("2026-09-15T00:00:00Z"),
    });

    expect(performance.currentValue).toBeNull();
    expect(performance.totalGain).toBeNull();
    expect(performance.totalReturnStatus).toBe("NO_CURRENT_VALUE");
    // tradingPL itself is still reported (informational figure, e.g. a "Trading Cash Flow" stat) -
    // only the WHOLE-ACCOUNT reconstructed value/gain is withheld.
    expect(performance.tradingPL).toBe(500);
    expect(performance.tradingPLSource).toBe("CAMPAIGNS");
  });

  it("dated broker-transaction trading P/L before the baseline is excluded from tradingPL, but option cash flow still cannot reconstruct a whole-account valuation (Astra corrective patch, second pass, Issue 3)", () => {
    const performance = summarizeAccountPerformance({
      ledgerEntries: [{ type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 }],
      brokerRecords: [
        brokerRecord({ action: "Sell to Open", amount: 500, occurredAt: "2026-08-01", fingerprint: "BEFORE_BASELINE" }), // already in the $10,000
        brokerRecord({ action: "Sell to Open", amount: 75, occurredAt: "2026-09-15", fingerprint: "AFTER_BASELINE" }),
      ],
      asOf: new Date("2026-10-01T00:00:00Z"),
    });

    // The pre-baseline $500 trade is still excluded from tradingPL entirely - that part of Issue 5's
    // fix stands. But per Issue 3 (second pass), even the remaining $75 post-baseline option
    // premium can never reconstruct a whole-account valuation on its own - it's a cash flow with an
    // offsetting short-option liability, not a supported account-value reading. With no broker
    // snapshot at all, there is no supported ending valuation here, so currentValue/gain are null.
    expect(performance.tradingPL).toBe(75);
    expect(performance.currentValue).toBeNull();
    expect(performance.totalGain).toBeNull();
    expect(performance.totalReturnStatus).toBe("NO_CURRENT_VALUE");
  });
});

describe("Astra corrective patch, second pass - proven Schwab transaction coverage required (Issue 2, blocker)", () => {
  it("1. recent baseline + successful complete transaction coverage -> coverage may be COMPLETE", () => {
    const performance = summarizeAccountPerformance(withFundingSyncFixture({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-20T00:00:00Z", accountValue: 12_000, cash: 12_000 },
      ],
    }));

    expect(performance.fundingCoverageStatus).toBe("COMPLETE");
    expect(performance.totalGain).toBe(2_000);
  });

  it("2. recent baseline + balance snapshot exists + transaction fetch failed -> coverage INCOMPLETE, gain unavailable", () => {
    // Exact Astra repro: syncSchwabAccountForUser writes the BROKER_SNAPSHOT unconditionally, then
    // the transaction fetch is a separate, independently-failable step - a fresh, accurate balance
    // reading proves nothing about whether the deposit/transfer history behind it was ever fetched.
    const performance = summarizeAccountPerformance({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-20T00:00:00Z", accountValue: 12_000, cash: 12_000 },
      ],
      brokerTransactionCoverageStatus: "FAILED",
    });

    expect(performance.fundingCoverageStatus).toBe("INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY");
    expect(performance.totalGain).toBeNull();
    expect(performance.totalReturnStatus).toBe("INCOMPLETE_FUNDING_EVIDENCE");
    // The balance reading itself is still shown - it is accurate regardless of transaction history.
    expect(performance.currentValue).toBe(12_000);
  });

  it("3. recent baseline + transaction fetch succeeded but persistence failed/partial -> coverage INCOMPLETE, gain unavailable", () => {
    // A successful fetch that was never durably persisted is just as unproven as a failed fetch -
    // reconcileSchwabActivityForUser and this function both read from BrokerRecord, so an activity
    // that was fetched but not stored is invisible to funding-coverage checks either way.
    const performance = summarizeAccountPerformance({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-20T00:00:00Z", accountValue: 12_000, cash: 12_000 },
      ],
      brokerTransactionCoverageStatus: "PARTIAL",
    });

    expect(performance.fundingCoverageStatus).toBe("INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY");
    expect(performance.totalGain).toBeNull();
  });

  it("4. recent baseline + no affirmative coverage evidence supplied at all -> coverage INCOMPLETE, gain unavailable", () => {
    // The honest default: no caller in this codebase can supply real evidence today (see
    // BrokerTransactionCoverageStatus's doc comment), so omitting the field entirely is what every
    // production call site actually does - it must never silently default to trusting coverage.
    const performance = summarizeAccountPerformance({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-20T00:00:00Z", accountValue: 12_000, cash: 12_000 },
      ],
    });

    expect(performance.fundingCoverageStatus).toBe("INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY");
    expect(performance.totalGain).toBeNull();
    expect(performance.totalReturnStatus).toBe("INCOMPLETE_FUNDING_EVIDENCE");
  });

  it("5. aggregate account performance withholds gain if any required account's coverage is incomplete", () => {
    const summary = summarizeAccountsPerformance([
      withFundingSyncFixture({
        ledgerEntries: [
          { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 },
          { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-20T00:00:00Z", accountValue: 11_000, cash: 11_000 },
        ],
      }),
      {
        // Second account has a proven-COMPLETE-looking short interval, but no coverage proof.
        ledgerEntries: [
          { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 5_000 },
          { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-20T00:00:00Z", accountValue: 5_500, cash: 5_500 },
        ],
      },
    ]);

    expect(summary.currentValue).toBe(16_500); // both accounts have a real snapshot-based value
    expect(summary.startingCapital).toBe(15_000);
    expect(summary.fundingCoverageStatus).toBe("INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY");
    expect(summary.totalGain).toBeNull(); // one unproven account withholds the combined gain
  });
});

describe("Astra corrective patch, second pass - option/trading cash flows are not a whole-account valuation (Issue 3, blocker)", () => {
  it("1. $10,000 baseline + $75 Sell to Open + no valid ending valuation -> gain and return unavailable", () => {
    // Exact Astra repro: receiving option premium also creates an offsetting short-option
    // liability - "cash in" is not the same fact as "whole-account value increased by that amount."
    const performance = summarizeAccountPerformance({
      ledgerEntries: [{ type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 }],
      brokerRecords: [brokerRecord({ action: "Sell to Open", amount: 75, occurredAt: "2026-09-05" })],
      asOf: new Date("2026-09-10T00:00:00Z"),
    });

    expect(performance.currentValue).toBeNull();
    expect(performance.totalGain).toBeNull();
    expect(performance.totalReturnPercent).toBeNull();
    expect(performance.totalReturnStatus).toBe("NO_CURRENT_VALUE");
  });

  it("2. baseline + option premium + a valid Schwab ending snapshot -> the snapshot governs valuation; the premium is never added on top again", () => {
    const performance = summarizeAccountPerformance(withFundingSyncFixture({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-20T00:00:00Z", accountValue: 10_050, cash: 10_050 },
      ],
      brokerRecords: [brokerRecord({ action: "Sell to Open", amount: 75, occurredAt: "2026-09-05" })],
    }));

    // If the $75 premium were wrongly added on top of the snapshot, currentValue would read
    // 10,125 (10,050 + 75) instead of the snapshot's own, real 10,050.
    expect(performance.currentValue).toBe(10_050);
    expect(performance.currentValueSource).toBe("SCHWAB");
    expect(performance.totalGain).toBe(50);
  });

  it("3. baseline + campaign P/L only + no ending valuation -> gain unavailable", () => {
    const performance = summarizeAccountPerformance({
      ledgerEntries: [{ type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 }],
      fallbackTradingPL: 500,
      asOf: new Date("2026-09-20T00:00:00Z"),
    });

    expect(performance.currentValue).toBeNull();
    expect(performance.totalGain).toBeNull();
  });

  it("4. baseline + dated broker option cash flows + no account snapshot -> gain unavailable", () => {
    const performance = summarizeAccountPerformance({
      ledgerEntries: [{ type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 }],
      brokerRecords: [
        brokerRecord({ action: "Sell to Open", amount: 30, occurredAt: "2026-09-05", fingerprint: "STO1" }),
        brokerRecord({ action: "Buy to Close", amount: -10, occurredAt: "2026-09-08", fingerprint: "BTC1" }),
      ],
      asOf: new Date("2026-09-20T00:00:00Z"),
    });

    expect(performance.tradingPL).toBe(20);
    expect(performance.currentValue).toBeNull();
    expect(performance.totalGain).toBeNull();
  });

  it("5. a valid ending account snapshot dated before the baseline is invalid as an ending valuation", () => {
    const performance = summarizeAccountPerformance({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-08-01T00:00:00Z", accountValue: 9_000, cash: 9_000 },
      ],
    });

    expect(performance.currentValue).toBeNull();
    expect(performance.totalGain).toBeNull();
  });

  it("6. a valid ending account snapshot dated at/after the baseline is an eligible valuation source", () => {
    const performance = summarizeAccountPerformance(withFundingSyncFixture({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-01T00:00:00Z", accountValue: 10_000, cash: 10_000 }, // exactly at the baseline instant
      ],
    }));

    expect(performance.currentValue).toBe(10_000);
    expect(performance.currentValueSource).toBe("SCHWAB");
    expect(performance.totalGain).toBe(0);
  });

  it("7. aggregate summaries preserve the unavailable status when one account's ending valuation is unsupported", () => {
    const summary = summarizeAccountsPerformance([
      withFundingSyncFixture({
        // Fully supported: explicit baseline, valid snapshot, proven coverage.
        ledgerEntries: [
          { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 },
          { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-20T00:00:00Z", accountValue: 10_300, cash: 10_300 },
        ],
      }),
      {
        // Only option premium, no account snapshot at all - no supported ending valuation.
        ledgerEntries: [{ type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 5_000 }],
        brokerRecords: [brokerRecord({ action: "Sell to Open", amount: 40, occurredAt: "2026-09-05" })],
        asOf: new Date("2026-09-20T00:00:00Z"),
      },
    ]);

    expect(summary.startingCapital).toBe(15_000); // both accounts have a starting capital figure
    expect(summary.currentValue).toBeNull(); // the second account has no supported ending valuation
    expect(summary.totalGain).toBeNull();
  });
});

describe("Astra corrective patch, third pass - baseline + contributions is never a supported ending valuation, with or without trading evidence (blocker)", () => {
  it("1. baseline + no ending snapshot + no trading evidence at all -> gain and return unavailable", () => {
    const performance = summarizeAccountPerformance({
      ledgerEntries: [{ type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 }],
      asOf: new Date("2026-09-20T00:00:00Z"),
    });

    expect(performance.currentValue).toBeNull();
    expect(performance.totalGain).toBeNull();
    expect(performance.totalReturnPercent).toBeNull();
    expect(performance.totalReturnStatus).toBe("NO_CURRENT_VALUE");
  });

  it("2. baseline + recorded interest + no ending snapshot -> gain and return unavailable", () => {
    // Exact Astra repro: baseline $10,000, $25 of recorded interest, no ending snapshot. The prior
    // fallback treated tradingPL === null (interest is otherIncome, not tradingPL) as proof nothing
    // had changed, producing currentValue $10,000 / gain $0 / return 0% / status OK - silently
    // discarding the $25. tradingPL === null never proves zero interest, fees, dividends, or any
    // other valuation change - only a real account snapshot can.
    const performance = summarizeAccountPerformance({
      ledgerEntries: [{ type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 }],
      brokerRecords: [brokerRecord({ action: "Bank Interest", amount: 25, occurredAt: "2026-09-10", fingerprint: "INTEREST_25" })],
      asOf: new Date("2026-09-20T00:00:00Z"),
    });

    expect(performance.otherIncome).toBe(25); // the interest is still reported as its own figure
    expect(performance.tradingPL).toBeNull(); // no trading occurred - tradingPL alone proves nothing
    expect(performance.currentValue).toBeNull();
    expect(performance.totalGain).toBeNull();
    expect(performance.totalReturnPercent).toBeNull();
    expect(performance.totalReturnStatus).toBe("NO_CURRENT_VALUE");
  });

  it("3. baseline + a standalone fee + no ending snapshot -> gain unavailable", () => {
    const performance = summarizeAccountPerformance({
      ledgerEntries: [{ type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 }],
      brokerRecords: [brokerRecord({ action: "Service Fee", amount: -5, occurredAt: "2026-09-10", fingerprint: "FEE_5" })],
      asOf: new Date("2026-09-20T00:00:00Z"),
    });

    expect(performance.otherIncome).toBe(-5);
    expect(performance.currentValue).toBeNull();
    expect(performance.totalGain).toBeNull();
  });

  it("4. baseline + ledger contributions only + no ending snapshot -> gain unavailable", () => {
    const performance = summarizeAccountPerformance({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 },
        { type: "DEPOSIT", occurredAt: "2026-09-10T00:00:00Z", amount: 1_000 },
      ],
      asOf: new Date("2026-09-20T00:00:00Z"),
    });

    expect(performance.netContributions).toBe(1_000);
    expect(performance.currentValue).toBeNull();
    expect(performance.totalGain).toBeNull();
  });

  it("5. aggregate account summary also stays unavailable when one account has interest but no supported ending valuation", () => {
    const summary = summarizeAccountsPerformance([
      withFundingSyncFixture({
        ledgerEntries: [
          { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 },
          { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-20T00:00:00Z", accountValue: 10_300, cash: 10_300 },
        ],
      }),
      {
        // Only interest recorded, no account snapshot at all - no supported ending valuation.
        ledgerEntries: [{ type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 5_000 }],
        brokerRecords: [brokerRecord({ action: "Bank Interest", amount: 25, occurredAt: "2026-09-10" })],
        asOf: new Date("2026-09-20T00:00:00Z"),
      },
    ]);

    expect(summary.startingCapital).toBe(15_000);
    expect(summary.currentValue).toBeNull();
    expect(summary.totalGain).toBeNull();
  });

  it("6. baseline + a valid ending snapshot at/after the baseline still produces a confirmed gain (existing valid path unaffected)", () => {
    const performance = summarizeAccountPerformance(withFundingSyncFixture({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-09-20T00:00:00Z", accountValue: 10_300, cash: 10_300 },
      ],
    }));

    expect(performance.currentValue).toBe(10_300);
    expect(performance.currentValueSource).toBe("SCHWAB");
    expect(performance.totalGain).toBe(300);
    expect(performance.totalReturnStatus).toBe("OK");
  });

  it("7. a snapshot dated before the baseline remains invalid as an ending valuation", () => {
    const performance = summarizeAccountPerformance({
      ledgerEntries: [
        { type: "STARTING_VALUE", occurredAt: "2026-09-01T00:00:00Z", amount: 10_000 },
        { type: "BROKER_SNAPSHOT", occurredAt: "2026-08-01T00:00:00Z", accountValue: 9_500, cash: 9_500 },
      ],
    });

    expect(performance.currentValue).toBeNull();
    expect(performance.currentValueSource).toBeNull();
    expect(performance.totalGain).toBeNull();
    expect(performance.totalReturnStatus).toBe("NO_CURRENT_VALUE");
  });
});
