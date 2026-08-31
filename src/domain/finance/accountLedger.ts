import { round } from "./calculations";

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
  netContributions: number;
  latestBrokerSnapshot: { accountValue: number; cash: number | null; asOf: Date } | null;
  /**
   * Current value derived from the ledger alone: starting value + net contributions.
   * This intentionally does NOT include trading P/L - callers combine it with a
   * separately-computed realized trading P/L (see campaigns.ts) to get a full picture,
   * so a deposit is never mistaken for profit and vice versa.
   */
  ledgerDerivedValue: number | null;
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
  let netContributions = 0;
  let latestBrokerSnapshot: AccountLedgerSummary["latestBrokerSnapshot"] = null;

  for (const entry of ordered) {
    const amount = numeric(entry.amount);

    if (entry.type === "STARTING_VALUE") {
      startingValue = amount ?? startingValue;
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
    netContributions,
    latestBrokerSnapshot,
    ledgerDerivedValue,
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
