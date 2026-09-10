import { round } from "./calculations";
import {
  classifyBrokerTransactionActivity,
  type BrokerTransactionActivityKind,
} from "./brokerTransactionActions";

export type AccountLedgerEntryKind =
  | "STARTING_VALUE"
  | "DEPOSIT"
  | "WITHDRAWAL"
  | "MANUAL_ADJUSTMENT"
  | "BROKER_SNAPSHOT"
  | "NOTE";

export type AccountLedgerEntryInput = {
  type: AccountLedgerEntryKind;
  occurredAt: Date | string;
  amount?: unknown;
  accountValue?: unknown;
  cash?: unknown;
};

export type AccountLedgerSummary = {
  startingValue: number | null;
  startingValueAt: Date | null;
  netContributions: number;
  latestBrokerSnapshot: { accountValue: number; cash: number | null; asOf: Date } | null;
  /**
   * Current value derived from the ledger alone: starting value + net contributions.
   * This intentionally does NOT include trading P/L - callers combine it with a
   * separately-computed trading P/L (broker transactions when available, campaign fallback)
   * to get a full picture,
   * so a deposit is never mistaken for profit and vice versa.
   */
  ledgerDerivedValue: number | null;
};

export type AccountBrokerRecordInput = {
  id?: string | null;
  fingerprint?: string | null;
  kind: string;
  status?: string | null;
  occurredAt?: Date | string | null;
  action?: string | null;
  description?: string | null;
  amount?: unknown;
  fees?: unknown;
  metadata?: unknown;
};

export type AccountCashFlowEvent = {
  type: "STARTING_VALUE" | "DEPOSIT" | "WITHDRAWAL" | "MANUAL_ADJUSTMENT";
  occurredAt: Date;
  amount: number;
  source: "LEDGER" | "BROKER_TRANSFER";
};

export type AccountPerformanceSummary = {
  ledger: AccountLedgerSummary;
  cashFlowEvents: AccountCashFlowEvent[];
  startingCapital: number | null;
  startingCapitalAt: Date | null;
  startingCapitalSource: "LEDGER" | "BROKER_TRANSFER" | "MIXED" | null;
  netContributions: number | null;
  contributionEventCount: number;
  tradingPL: number | null;
  tradingPLSource: "BROKER_TRANSACTIONS" | "CAMPAIGNS" | "MIXED" | null;
  otherIncome: number | null;
  currentValue: number | null;
  currentValueSource: "SCHWAB" | "MANUAL" | "MIXED" | null;
  totalGain: number | null;
  totalReturnPercent: number | null;
  totalReturnStatus: "OK" | "NO_BASELINE" | "NO_CURRENT_VALUE" | "CONTRIBUTIONS_NEED_ADVANCED_RETURN";
  unexplainedGain: number | null;
};

export type AccountPerformanceInput = {
  ledgerEntries: AccountLedgerEntryInput[];
  brokerRecords?: AccountBrokerRecordInput[];
  fallbackTradingPL?: number | null;
};

type StartingCapitalSource = NonNullable<AccountPerformanceSummary["startingCapitalSource"]>;
type TradingPLSource = NonNullable<AccountPerformanceSummary["tradingPLSource"]>;
type CurrentValueSource = NonNullable<AccountPerformanceSummary["currentValueSource"]>;

const OPTION_TRADING_ACTIVITY_KINDS = new Set<BrokerTransactionActivityKind>([
  "SELL_TO_OPEN",
  "BUY_TO_CLOSE",
  "BUY_TO_OPEN",
  "SELL_TO_CLOSE",
]);

const OTHER_INCOME_ACTIVITY_KINDS = new Set<BrokerTransactionActivityKind>(["DIVIDEND", "INTEREST", "FEE"]);

type NormalizedAccountBrokerRecord = AccountBrokerRecordInput & {
  amount: number;
  occurredAt: Date;
  activityKind: BrokerTransactionActivityKind;
};

/**
 * Summarizes an account's cash-flow history, keeping external contributions
 * (deposits/withdrawals/adjustments) strictly separate from trading performance.
 * A BROKER_SNAPSHOT entry never contributes to netContributions - it is a fact
 * reported by Schwab, not a cash flow the user made.
 */
export function summarizeAccountLedger(entries: AccountLedgerEntryInput[]): AccountLedgerSummary {
  const ordered = [...entries].sort(
    (left, right) => toDate(left.occurredAt).getTime() - toDate(right.occurredAt).getTime(),
  );

  let startingValue: number | null = null;
  let startingValueAt: Date | null = null;
  let netContributions = 0;
  let latestBrokerSnapshot: AccountLedgerSummary["latestBrokerSnapshot"] = null;

  for (const entry of ordered) {
    const amount = numeric(entry.amount);

    if (entry.type === "STARTING_VALUE") {
      if (amount !== null) {
        startingValue = amount;
        startingValueAt = toDate(entry.occurredAt);
      }
      continue;
    }

    if (entry.type === "DEPOSIT" && amount !== null) {
      netContributions += amount;
      continue;
    }

    if (entry.type === "WITHDRAWAL" && amount !== null) {
      netContributions -= amount;
      continue;
    }

    if (entry.type === "MANUAL_ADJUSTMENT" && amount !== null) {
      netContributions += amount;
      continue;
    }

    if (entry.type === "BROKER_SNAPSHOT") {
      const accountValue = numeric(entry.accountValue);
      if (accountValue !== null) {
        latestBrokerSnapshot = {
          accountValue,
          cash: numeric(entry.cash),
          asOf: toDate(entry.occurredAt),
        };
      }
    }
  }

  netContributions = round(netContributions, 2);
  const ledgerDerivedValue = startingValue === null ? null : round(startingValue + netContributions, 2);

  return {
    startingValue,
    startingValueAt,
    netContributions,
    latestBrokerSnapshot,
    ledgerDerivedValue,
  };
}

/**
 * Account-level performance keeps three facts separate:
 * transfer/contribution cash flows, realized option-trade cash flows, and non-trading income.
 * Schwab-imported BrokerRecord rows are already user/account scoped and fingerprint-deduped, so
 * this derives from those facts instead of creating a second persistent accounting surface.
 */
export function summarizeAccountPerformance(input: AccountPerformanceInput): AccountPerformanceSummary {
  const ledger = summarizeAccountLedger(input.ledgerEntries);
  const brokerRecords = uniqueBrokerRecords(input.brokerRecords ?? [])
    .filter((record) => record.kind === "TRANSACTION" && (record.status ?? "CONFIRMED") === "CONFIRMED")
    .map((record) => ({
      ...record,
      amount: numeric(record.amount),
      occurredAt: record.occurredAt ? toDate(record.occurredAt) : null,
      activityKind: brokerActivityKind(record),
    }))
    .filter((record): record is NormalizedAccountBrokerRecord => {
      return record.amount !== null && record.occurredAt !== null;
    })
    .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());

  const ledgerCashFlows = input.ledgerEntries
    .map((entry): AccountCashFlowEvent | null => {
      const amount = numeric(entry.amount);
      if (amount === null) {
        return null;
      }
      if (entry.type === "STARTING_VALUE" || entry.type === "DEPOSIT" || entry.type === "WITHDRAWAL" || entry.type === "MANUAL_ADJUSTMENT") {
        return { type: entry.type, occurredAt: toDate(entry.occurredAt), amount, source: "LEDGER" };
      }
      return null;
    })
    .filter((event): event is AccountCashFlowEvent => event !== null);

  const manualStartingEvents = ledgerCashFlows.filter((event) => event.type === "STARTING_VALUE");
  const transferRecords = brokerRecords.filter(isExternalTransfer);
  const firstPositiveTransfer = transferRecords.find((record) => record.amount > 0) ?? null;
  const baselineTransfer =
    ledger.startingValue === null && firstPositiveTransfer && canUseTransferAsStartingCapital(firstPositiveTransfer, brokerRecords, input.ledgerEntries)
      ? firstPositiveTransfer
      : null;
  const brokerCashFlows = transferRecords
    .filter((record) => {
      if (baselineTransfer && record === baselineTransfer) {
        return false;
      }
      if (isSameManualStartingTransfer(record, manualStartingEvents)) {
        return false;
      }
      if (ledger.startingValueAt) {
        return record.occurredAt > ledger.startingValueAt;
      }
      return baselineTransfer ? record.occurredAt > baselineTransfer.occurredAt : firstPositiveTransfer !== null;
    })
    .map((record): AccountCashFlowEvent => ({
      type: record.amount >= 0 ? "DEPOSIT" : "WITHDRAWAL",
      occurredAt: record.occurredAt,
      amount: Math.abs(record.amount),
      source: "BROKER_TRANSFER",
    }));

  const derivedBaseline = baselineTransfer
    ? ({
        type: "STARTING_VALUE",
        occurredAt: baselineTransfer.occurredAt,
        amount: baselineTransfer.amount,
        source: "BROKER_TRANSFER",
      } satisfies AccountCashFlowEvent)
    : null;
  const cashFlowEvents = [...ledgerCashFlows, ...(derivedBaseline ? [derivedBaseline] : []), ...brokerCashFlows].sort(
    (left, right) => left.occurredAt.getTime() - right.occurredAt.getTime(),
  );

  const starts = cashFlowEvents.filter((event) => event.type === "STARTING_VALUE");
  const startingCapital = starts.length ? round(starts.reduce((sum, event) => sum + event.amount, 0), 2) : null;
  const startingCapitalAt = starts[0]?.occurredAt ?? null;
  const startingCapitalSource = sourceSummary(starts.map((event) => event.source));
  const contributionEvents = cashFlowEvents.filter((event) => event.type !== "STARTING_VALUE");
  const netContributions =
    startingCapital === null
      ? null
      : round(
          contributionEvents.reduce((sum, event) => {
            if (event.type === "WITHDRAWAL") {
              return sum - event.amount;
            }
            return sum + event.amount;
          }, 0),
          2,
        );

  const brokerTradeRecords = brokerRecords.filter((record) => OPTION_TRADING_ACTIVITY_KINDS.has(record.activityKind));
  const brokerTradingPL = brokerTradeRecords.length
    ? round(brokerTradeRecords.reduce((sum, record) => sum + record.amount, 0), 2)
    : null;
  const fallbackTradingPL = input.fallbackTradingPL ?? null;
  const tradingPL = brokerTradingPL ?? fallbackTradingPL;
  const tradingPLSource =
    brokerTradingPL !== null
      ? "BROKER_TRANSACTIONS"
      : fallbackTradingPL !== null
        ? "CAMPAIGNS"
        : null;

  const otherIncome = brokerRecords.length
    ? round(
        brokerRecords
          .filter((record) => OTHER_INCOME_ACTIVITY_KINDS.has(record.activityKind))
          .reduce((sum, record) => sum + record.amount, 0),
        2,
      )
    : null;

  const current = currentAccountValue(ledger, tradingPL ?? 0);
  const currentValue = current.value;
  const currentValueSource = currentValue === null ? null : current.source;
  const totalGain =
    currentValue !== null && startingCapital !== null && netContributions !== null
      ? round(currentValue - startingCapital - netContributions, 2)
      : null;
  const totalReturnStatus = totalReturnStatusFor({ startingCapital, currentValue, contributionEventCount: contributionEvents.length });
  const totalReturnPercent =
    totalReturnStatus === "OK" && totalGain !== null && startingCapital !== null && startingCapital > 0
      ? round((totalGain / startingCapital) * 100, 4)
      : null;
  const explainedGain = tradingPL === null || otherIncome === null ? null : round(tradingPL + otherIncome, 2);
  const unexplainedGain = totalGain === null || explainedGain === null ? null : round(totalGain - explainedGain, 2);

  return {
    ledger,
    cashFlowEvents,
    startingCapital,
    startingCapitalAt,
    startingCapitalSource,
    netContributions,
    contributionEventCount: contributionEvents.length,
    tradingPL,
    tradingPLSource,
    otherIncome,
    currentValue,
    currentValueSource,
    totalGain,
    totalReturnPercent,
    totalReturnStatus,
    unexplainedGain,
  };
}

export function summarizeAccountsPerformance(accounts: AccountPerformanceInput[]): AccountPerformanceSummary {
  const summaries = accounts.map((account) => summarizeAccountPerformance(account));
  const hasAccounts = summaries.length > 0;
  const startingCapital = hasAccounts && summaries.every((summary) => summary.startingCapital !== null)
    ? round(summaries.reduce((sum, summary) => sum + (summary.startingCapital ?? 0), 0), 2)
    : null;
  const currentValue = hasAccounts && summaries.every((summary) => summary.currentValue !== null)
    ? round(summaries.reduce((sum, summary) => sum + (summary.currentValue ?? 0), 0), 2)
    : null;
  const netContributions = hasAccounts && summaries.every((summary) => summary.netContributions !== null)
    ? round(summaries.reduce((sum, summary) => sum + (summary.netContributions ?? 0), 0), 2)
    : null;
  const tradingPL = summaries.some((summary) => summary.tradingPL !== null)
    ? round(summaries.reduce((sum, summary) => sum + (summary.tradingPL ?? 0), 0), 2)
    : null;
  const otherIncome = hasAccounts && summaries.every((summary) => summary.otherIncome !== null)
    ? round(summaries.reduce((sum, summary) => sum + (summary.otherIncome ?? 0), 0), 2)
    : null;
  const totalGain =
    currentValue !== null && startingCapital !== null && netContributions !== null
      ? round(currentValue - startingCapital - netContributions, 2)
      : null;
  const contributionEventCount = summaries.reduce((sum, summary) => sum + summary.contributionEventCount, 0);
  const totalReturnStatus = totalReturnStatusFor({ startingCapital, currentValue, contributionEventCount });
  const totalReturnPercent =
    totalReturnStatus === "OK" && totalGain !== null && startingCapital !== null && startingCapital > 0
      ? round((totalGain / startingCapital) * 100, 4)
      : null;
  const explainedGain = tradingPL === null || otherIncome === null ? null : round(tradingPL + otherIncome, 2);

  return {
    ledger: {
      startingValue: startingCapital,
      startingValueAt: summaries.map((summary) => summary.startingCapitalAt).filter((date): date is Date => date !== null)[0] ?? null,
      netContributions: netContributions ?? 0,
      latestBrokerSnapshot: null,
      ledgerDerivedValue: startingCapital === null || netContributions === null ? null : round(startingCapital + netContributions, 2),
    },
    cashFlowEvents: summaries.flatMap((summary) => summary.cashFlowEvents).sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime()),
    startingCapital,
    startingCapitalAt: summaries.map((summary) => summary.startingCapitalAt).filter((date): date is Date => date !== null)[0] ?? null,
    startingCapitalSource: sourceSummary(summaries.map((summary) => summary.startingCapitalSource).filter((source): source is "LEDGER" | "BROKER_TRANSFER" | "MIXED" => source !== null)),
    netContributions,
    contributionEventCount,
    tradingPL,
    tradingPLSource: tradingSourceSummary(summaries.map((summary) => summary.tradingPLSource).filter((source): source is "BROKER_TRANSACTIONS" | "CAMPAIGNS" | "MIXED" => source !== null)),
    otherIncome,
    currentValue,
    currentValueSource: currentSourceSummary(summaries.map((summary) => summary.currentValueSource).filter((source): source is "SCHWAB" | "MANUAL" | "MIXED" => source !== null)),
    totalGain,
    totalReturnPercent,
    totalReturnStatus,
    unexplainedGain: totalGain === null || explainedGain === null ? null : round(totalGain - explainedGain, 2),
  };
}

/**
 * The account value to actually display: a live Schwab snapshot is authoritative when
 * present (it already reflects trading P/L, contributions, everything). Otherwise fall
 * back to the ledger-derived value plus known realized trading P/L, so a manual account
 * shows starting + contributions + completed trading profit - never contributions alone.
 */
export function currentAccountValue(
  summary: AccountLedgerSummary,
  realizedTradingPL: number,
): { value: number | null; source: "SCHWAB" | "MANUAL" } {
  if (summary.latestBrokerSnapshot) {
    return { value: summary.latestBrokerSnapshot.accountValue, source: "SCHWAB" };
  }

  if (summary.ledgerDerivedValue === null) {
    return { value: null, source: "MANUAL" };
  }

  return { value: round(summary.ledgerDerivedValue + realizedTradingPL, 2), source: "MANUAL" };
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const candidate = value as { toNumber?: () => number };
  if (typeof candidate.toNumber === "function") {
    const parsed = candidate.toNumber();
    return Number.isFinite(parsed) ? parsed : null;
  }

  const parsed = Number(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function toDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}

function uniqueBrokerRecords(records: AccountBrokerRecordInput[]) {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key =
      record.fingerprint ??
      record.id ??
      [
        record.kind,
        record.status ?? "",
        record.occurredAt ? toDate(record.occurredAt).toISOString() : "",
        record.action ?? "",
        record.description ?? "",
        numeric(record.amount)?.toFixed(4) ?? "",
      ].join("|");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function brokerActivityKind(record: AccountBrokerRecordInput): BrokerTransactionActivityKind {
  const direct = classifyBrokerTransactionActivity({ action: record.action, description: record.description });
  if (direct !== "UNKNOWN") {
    return direct;
  }

  const metadata = objectValue(record.metadata);
  return isBrokerActivityKind(metadata?.activityKind) ? metadata.activityKind : "UNKNOWN";
}

function isBrokerActivityKind(value: unknown): value is BrokerTransactionActivityKind {
  return (
    value === "SELL_TO_OPEN" ||
    value === "BUY_TO_CLOSE" ||
    value === "BUY_TO_OPEN" ||
    value === "SELL_TO_CLOSE" ||
    value === "STOCK_BUY" ||
    value === "STOCK_SELL" ||
    value === "ASSIGNMENT" ||
    value === "EXERCISE" ||
    value === "DIVIDEND" ||
    value === "INTEREST" ||
    value === "FEE" ||
    value === "TRANSFER" ||
    value === "OPTION_REMOVED_EXPIRATION" ||
    value === "UNKNOWN"
  );
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isExternalTransfer(record: NormalizedAccountBrokerRecord) {
  if (record.activityKind !== "TRANSFER") {
    return false;
  }

  const text = brokerRecordText(record);
  if (text.includes("internal") || text.includes("sweep") || text.includes("journaled shares")) {
    return false;
  }

  return (
    text.includes("security transfer") ||
    text.includes("toa acat") ||
    text.includes("moneylink transfer") ||
    text.includes("wire received") ||
    text.includes("wire sent") ||
    text.includes("funds received") ||
    text.includes("atm withdrawal")
  );
}

function canUseTransferAsStartingCapital(
  candidate: NormalizedAccountBrokerRecord,
  brokerRecords: NormalizedAccountBrokerRecord[],
  ledgerEntries: AccountLedgerEntryInput[],
) {
  if (candidate.amount <= 0 || !isQualifiedStartingTransfer(candidate)) {
    return false;
  }

  const candidateTime = candidate.occurredAt.getTime();
  const earlierBrokerActivity = brokerRecords.some(
    (record) => record !== candidate && record.occurredAt.getTime() < candidateTime,
  );
  if (earlierBrokerActivity) {
    return false;
  }

  const earliestSnapshot = earliestBrokerSnapshotAt(ledgerEntries);
  return earliestSnapshot === null || earliestSnapshot.getTime() >= candidateTime;
}

function isQualifiedStartingTransfer(record: NormalizedAccountBrokerRecord) {
  const text = brokerRecordText(record);
  return isExternalTransfer(record) && (text.includes("security transfer") || text.includes("toa acat"));
}

function earliestBrokerSnapshotAt(entries: AccountLedgerEntryInput[]) {
  const snapshotTimes = entries
    .filter((entry) => entry.type === "BROKER_SNAPSHOT" && numeric(entry.accountValue) !== null)
    .map((entry) => toDate(entry.occurredAt).getTime());
  if (!snapshotTimes.length) {
    return null;
  }
  return new Date(Math.min(...snapshotTimes));
}

function isSameManualStartingTransfer(record: NormalizedAccountBrokerRecord, manualStarts: AccountCashFlowEvent[]) {
  return (
    record.amount > 0 &&
    manualStarts.some((start) => sameUtcDate(record.occurredAt, start.occurredAt) && moneyEqual(record.amount, start.amount))
  );
}

function sameUtcDate(left: Date, right: Date) {
  return left.toISOString().slice(0, 10) === right.toISOString().slice(0, 10);
}

function moneyEqual(left: number, right: number) {
  return Math.abs(round(left - right, 2)) < 0.01;
}

function brokerRecordText(record: Pick<AccountBrokerRecordInput, "action" | "description">) {
  return `${record.action ?? ""} ${record.description ?? ""}`.trim().toLowerCase();
}

function sourceSummary(sources: StartingCapitalSource[]): AccountPerformanceSummary["startingCapitalSource"] {
  const concrete = sources.flatMap((source): ("LEDGER" | "BROKER_TRANSFER")[] =>
    source === "MIXED" ? ["LEDGER", "BROKER_TRANSFER"] : [source],
  );
  if (concrete.length === 0) {
    return null;
  }
  return new Set(concrete).size > 1 ? "MIXED" : concrete[0]!;
}

function tradingSourceSummary(sources: TradingPLSource[]): AccountPerformanceSummary["tradingPLSource"] {
  const concrete = sources.flatMap((source): ("BROKER_TRANSACTIONS" | "CAMPAIGNS")[] =>
    source === "MIXED" ? ["BROKER_TRANSACTIONS", "CAMPAIGNS"] : [source],
  );
  if (concrete.length === 0) {
    return null;
  }
  return new Set(concrete).size > 1 ? "MIXED" : concrete[0]!;
}

function currentSourceSummary(sources: CurrentValueSource[]): AccountPerformanceSummary["currentValueSource"] {
  const concrete = sources.flatMap((source): ("SCHWAB" | "MANUAL")[] =>
    source === "MIXED" ? ["SCHWAB", "MANUAL"] : [source],
  );
  if (concrete.length === 0) {
    return null;
  }
  return new Set(concrete).size > 1 ? "MIXED" : concrete[0]!;
}

function totalReturnStatusFor({
  startingCapital,
  currentValue,
  contributionEventCount,
}: {
  startingCapital: number | null;
  currentValue: number | null;
  contributionEventCount: number;
}): AccountPerformanceSummary["totalReturnStatus"] {
  if (startingCapital === null || startingCapital <= 0) {
    return "NO_BASELINE";
  }
  if (currentValue === null) {
    return "NO_CURRENT_VALUE";
  }
  if (contributionEventCount > 0) {
    return "CONTRIBUTIONS_NEED_ADVANCED_RETURN";
  }
  return "OK";
}
