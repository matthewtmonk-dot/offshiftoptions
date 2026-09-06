import "server-only";

import type {
  BrokerAccount,
  BrokerObservedOrder,
  BrokerPosition,
  BrokerReadProvider,
  BrokerTransaction,
  BrokerTransactionCategory,
  BrokerTransactionCategoryOutcome,
  BrokerTransactionsResult,
} from "@/providers/broker-read/types";
import { SCHWAB_TRADER_BASE_URL } from "./config";
import { schwabGetJson, type SchwabFetch } from "./client";

export type SchwabAccountNumber = {
  accountNumberLast4: string | null;
  hashValue: string;
};

/** Only Schwab transaction-type values verified live against production (see
 * PROJECT_HANDOFF.md) - never add a value here without live confirmation it's accepted. */
const TRANSACTION_CATEGORIES: BrokerTransactionCategory[] = ["TRADE", "RECEIVE_AND_DELIVER", "DIVIDEND_OR_INTEREST"];

export class SchwabBrokerReadProvider implements BrokerReadProvider {
  constructor(
    private readonly options: {
      accessToken: string;
      accountNumbers: SchwabAccountNumber[];
      fetchFn?: SchwabFetch;
      baseUrl?: string;
    },
  ) {}

  async getAccounts(): Promise<BrokerAccount[]> {
    const payload = await this.get("/accounts", {
      fields: "positions",
    });
    const accountRecords = Array.isArray(payload) ? payload : [];

    return accountRecords.flatMap((record) => {
      const account = objectValue(objectValue(record)?.securitiesAccount);
      const hash = this.hashForAccount(account);
      if (!account || !hash) {
        return [];
      }

      const label = accountLabel(account, hash);
      return {
        id: hash,
        label,
        accountValue:
          numberValue(objectValue(account.currentBalances)?.liquidationValue) ??
          numberValue(objectValue(account.initialBalances)?.accountValue) ??
          0,
        cash:
          numberValue(objectValue(account.currentBalances)?.cashBalance) ??
          numberValue(objectValue(account.currentBalances)?.cashAvailableForTrading) ??
          0,
      };
    });
  }

  async getAccount(accountId: string): Promise<BrokerAccount | null> {
    const payload = await this.get(`/accounts/${encodeURIComponent(accountId)}`, {
      fields: "positions",
    });
    const account = objectValue(objectValue(payload)?.securitiesAccount);
    if (!account) {
      return null;
    }

    return {
      id: accountId,
      label: accountLabel(account, accountId),
      accountValue:
        numberValue(objectValue(account.currentBalances)?.liquidationValue) ??
        numberValue(objectValue(account.initialBalances)?.accountValue) ??
        0,
      cash:
        numberValue(objectValue(account.currentBalances)?.cashBalance) ??
        numberValue(objectValue(account.currentBalances)?.cashAvailableForTrading) ??
        0,
    };
  }

  async getPositions(accountId: string): Promise<BrokerPosition[]> {
    const payload = await this.get(`/accounts/${encodeURIComponent(accountId)}`, {
      fields: "positions",
    });
    const account = objectValue(objectValue(payload)?.securitiesAccount);
    const positions = arrayValue(account?.positions);

    return positions.flatMap((positionValue) => {
      const position = objectValue(positionValue);
      if (!position) {
        return [];
      }
      const instrument = objectValue(position?.instrument);
      const symbol = stringValue(instrument?.symbol);
      if (!symbol) {
        return [];
      }

      const putCallRaw = stringValue(instrument?.putCall);

      return {
        accountId,
        symbol,
        quantity: positionQuantity(position),
        marketValue: numberValue(position?.marketValue) ?? 0,
        assetType: stringValue(instrument?.assetType),
        putCall: putCallRaw === "PUT" || putCallRaw === "CALL" ? putCallRaw : null,
        strikePrice: numberValue(instrument?.strikePrice),
        underlyingSymbol: stringValue(instrument?.underlyingSymbol),
      };
    });
  }

  /**
   * Schwab rejects a transactions request outright (HTTP 400) if any value in a combined
   * `types` list isn't one it recognizes - confirmed live against production (see
   * PROJECT_HANDOFF.md) that the previously-used `CASH_IN_OR_CASH_OUT` value is exactly such a
   * case, and that it silently poisoned the other three, otherwise-valid categories in the same
   * request. Each category is now fetched independently via Promise.allSettled so one rejected
   * or unsupported category can never prevent the others from being received.
   */
  async getTransactions(accountId: string, from: Date, to: Date): Promise<BrokerTransactionsResult> {
    const settled = await Promise.allSettled(
      TRANSACTION_CATEGORIES.map((category) =>
        this.get(`/accounts/${encodeURIComponent(accountId)}/transactions`, {
          startDate: from.toISOString(),
          endDate: to.toISOString(),
          types: category,
        }),
      ),
    );

    const transactions: BrokerTransaction[] = [];
    const categories = {} as Record<BrokerTransactionCategory, BrokerTransactionCategoryOutcome>;

    settled.forEach((outcome, index) => {
      const category = TRANSACTION_CATEGORIES[index];
      if (outcome.status === "fulfilled") {
        const parsed = this.mapTransactionsPayload(outcome.value, accountId);
        transactions.push(...parsed);
        categories[category] = { status: "OK", count: parsed.length };
      } else {
        categories[category] = { status: "ERROR" };
      }
    });

    return { transactions, categories };
  }

  private mapTransactionsPayload(payload: unknown, accountId: string): BrokerTransaction[] {
    const transactions = Array.isArray(payload) ? payload : [];

    return transactions.flatMap((transactionValue) => {
      const transaction = objectValue(transactionValue);
      if (!transaction) {
        return [];
      }
      const id = stringValue(transaction?.activityId) ?? stringValue(transaction?.transactionId);
      if (!id) {
        return [];
      }

      const item = selectTradedSecurityTransferItem(transaction);
      const instrument = objectValue(item?.instrument);
      const symbol = stringValue(instrument?.symbol);
      const isOption = stringValue(instrument?.assetType) === "OPTION";
      const putCallRaw = stringValue(instrument?.putCall);

      return {
        id,
        accountId,
        ...(symbol ? { symbol } : {}),
        amount: numberValue(transaction?.netAmount) ?? 0,
        occurredAt: dateValue(transaction?.time) ?? dateValue(transaction?.settlementDate) ?? new Date(),
        description: stringValue(transaction?.description) ?? stringValue(transaction?.type) ?? "Schwab transaction",
        action:
          instructionToActionLabel(stringValue(item?.instruction)) ??
          assignmentOrExerciseActionLabel(transaction) ??
          nonTradeActivityActionLabel(transaction),
        quantity: numberValue(item?.amount),
        price: numberValue(item?.price),
        fees: totalFees(transaction),
        underlyingSymbol: isOption ? stringValue(instrument?.underlyingSymbol) : null,
        optionType: putCallRaw === "PUT" || putCallRaw === "CALL" ? putCallRaw : null,
        strike: isOption ? numberValue(instrument?.strikePrice) : null,
        expiration: isOption ? dateValue(instrument?.optionExpirationDate) : null,
      };
    });
  }

  async getOrders(accountId: string, from: Date, to: Date): Promise<BrokerObservedOrder[]> {
    const payload = await this.get(`/accounts/${encodeURIComponent(accountId)}/orders`, {
      fromEnteredTime: from.toISOString(),
      toEnteredTime: to.toISOString(),
    });
    const orders = Array.isArray(payload) ? payload : [];

    return orders.flatMap((orderValue) => {
      const order = objectValue(orderValue);
      if (!order) {
        return [];
      }
      const id = stringValue(order?.orderId) ?? stringValue(order?.enteredTime);
      if (!id) {
        return [];
      }

      const symbol = orderSymbol(order);
      return {
        id,
        accountId,
        ...(symbol ? { symbol } : {}),
        status: stringValue(order?.status) ?? "UNKNOWN",
        enteredAt: dateValue(order?.enteredTime) ?? new Date(),
      };
    });
  }

  private hashForAccount(account: Record<string, unknown> | null) {
    const rawAccountNumber = stringValue(account?.accountNumber);
    const exact = this.options.accountNumbers.find((item) => rawAccountNumber?.endsWith(item.accountNumberLast4 ?? ""));
    return exact?.hashValue ?? this.options.accountNumbers[0]?.hashValue ?? null;
  }

  private async get(path: string, params: Record<string, string>) {
    return schwabGetJson<unknown>({
      accessToken: this.options.accessToken,
      baseUrl: this.options.baseUrl ?? SCHWAB_TRADER_BASE_URL,
      path,
      searchParams: new URLSearchParams(params),
      fetchFn: this.options.fetchFn,
    });
  }
}

export function normalizeSchwabAccountNumbers(payload: unknown): SchwabAccountNumber[] {
  const records = Array.isArray(payload) ? payload : [];
  return records.flatMap((recordValue) => {
    const record = objectValue(recordValue);
    const hashValue = stringValue(record?.hashValue);
    if (!hashValue) {
      return [];
    }

    return {
      accountNumberLast4: last4(stringValue(record?.accountNumber)),
      hashValue,
    };
  });
}

function accountLabel(account: Record<string, unknown>, hash: string) {
  const type = stringValue(account.type) ?? "Schwab account";
  const lastFour = last4(stringValue(account.accountNumber)) ?? last4(hash);
  return lastFour ? `${type} ...${lastFour}` : type;
}

/**
 * A real multi-leg Schwab TRADE transaction (an option order's cash settlement alongside the
 * option leg itself) does not put the traded security at a fixed index - confirmed live against
 * production that index 0 is the CURRENCY_USD cash leg, not the option, for every real option
 * trade in this account. Scans every transferItem for the one whose instrument is actually an
 * OPTION; falls back to index 0 only when none is (equity trades, cash-only activity), which
 * was never wrong for those cases.
 */
function selectTradedSecurityTransferItem(transaction: Record<string, unknown>): Record<string, unknown> | null {
  const items = arrayValue(transaction.transferItems);
  for (const itemValue of items) {
    const item = objectValue(itemValue);
    if (stringValue(objectValue(item?.instrument)?.assetType) === "OPTION") {
      return item;
    }
  }
  return objectValue(items[0]);
}

const INSTRUCTION_LABELS: Record<string, string> = {
  SELL_TO_OPEN: "Sell to Open",
  BUY_TO_CLOSE: "Buy to Close",
  BUY_TO_OPEN: "Buy to Open",
  SELL_TO_CLOSE: "Sell to Close",
  BUY: "Buy",
  SELL: "Sell",
};

/**
 * Schwab's Transaction History API reports an opening/closing option instruction on the
 * transfer item itself, but assignment/exercise instead shows up as a RECEIVE_AND_DELIVER
 * transaction type with no "instruction" at all - only free-text type/description. This is
 * a best-effort mapping (not verified against a live sandbox); anything it can't confidently
 * label comes back null so the caller treats it as unclassified rather than guessing.
 */
function instructionToActionLabel(instruction: string | null): string | null {
  if (instruction && INSTRUCTION_LABELS[instruction.toUpperCase()]) {
    return INSTRUCTION_LABELS[instruction.toUpperCase()];
  }

  return null;
}

function assignmentOrExerciseActionLabel(transaction: Record<string, unknown>): string | null {
  const text = `${stringValue(transaction.type) ?? ""} ${stringValue(transaction.description) ?? ""}`.toLowerCase();
  if (text.includes("exercise")) {
    return "Exercise";
  }
  if (text.includes("assignment")) {
    return "Assignment";
  }
  return null;
}

/**
 * Recognizes non-trade cash/removal activity from Schwab's free-text type/description when
 * there's no buy/sell instruction to label at all - confirmed live against production: a real
 * "BANK INT ... SCHWAB BANK" transaction and real "Removed due to Expiration PUT ..." removal
 * transactions both report no instruction. Anything not confidently matched returns null, same
 * fail-safe pattern as assignmentOrExerciseActionLabel - this never guesses a trade action.
 */
function nonTradeActivityActionLabel(transaction: Record<string, unknown>): string | null {
  const text = `${stringValue(transaction.type) ?? ""} ${stringValue(transaction.description) ?? ""}`.toLowerCase();
  if (text.includes("removed due to expiration") || text.includes("removed - expiration")) {
    return "Removed - Expiration";
  }
  if (text.includes("bank int")) {
    return "Bank Interest";
  }
  if (text.includes("dividend")) {
    return "Dividend";
  }
  if (text.includes("interest")) {
    return "Interest";
  }
  return null;
}

/**
 * Sums whatever fee/commission fields Schwab actually reports for this transaction. Schwab's
 * documented schema varies by transaction type - some report a top-level `fees` object
 * (commission, secFee, optRegFee, ...), others report fee-only transferItems (feeType set,
 * no instruction). Returns null (not 0) when nothing is found, so callers never assert a
 * confirmed-zero fee they didn't actually observe.
 */
function totalFees(transaction: Record<string, unknown>): number | null {
  const amounts: number[] = [];

  const feesObject = objectValue(transaction.fees);
  if (feesObject) {
    for (const value of Object.values(feesObject)) {
      const parsed = numberValue(value);
      if (parsed !== null) {
        amounts.push(parsed);
      }
    }
  }

  for (const itemValue of arrayValue(transaction.transferItems)) {
    const item = objectValue(itemValue);
    if (item && stringValue(item.feeType)) {
      const parsed = numberValue(item.cost) ?? numberValue(item.amount);
      if (parsed !== null) {
        amounts.push(Math.abs(parsed));
      }
    }
  }

  return amounts.length > 0 ? amounts.reduce((sum, value) => sum + value, 0) : null;
}

function orderSymbol(order: Record<string, unknown>) {
  const leg = arrayValue(order.orderLegCollection)[0];
  const instrument = objectValue(objectValue(leg)?.instrument);
  return stringValue(instrument?.symbol);
}

function positionQuantity(position: Record<string, unknown>) {
  const longQuantity = numberValue(position.longQuantity);
  if (longQuantity !== null && longQuantity > 0) {
    return longQuantity;
  }

  const shortQuantity = numberValue(position.shortQuantity);
  if (shortQuantity !== null && shortQuantity > 0) {
    return -shortQuantity;
  }

  return longQuantity ?? shortQuantity ?? 0;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  if (typeof value === "number") {
    return String(value);
  }

  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateValue(value: unknown) {
  const text = stringValue(value);
  if (!text) {
    return null;
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function last4(value: string | null) {
  return value ? value.slice(-4) : null;
}
