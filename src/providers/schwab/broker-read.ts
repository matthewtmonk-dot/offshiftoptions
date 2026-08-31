import "server-only";

import type {
  BrokerAccount,
  BrokerObservedOrder,
  BrokerPosition,
  BrokerReadProvider,
  BrokerTransaction,
} from "@/providers/broker-read/types";
import { SCHWAB_TRADER_BASE_URL } from "./config";
import { schwabGetJson, type SchwabFetch } from "./client";

export type SchwabAccountNumber = {
  accountNumberLast4: string | null;
  hashValue: string;
};

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

  async getTransactions(accountId: string, from: Date, to: Date): Promise<BrokerTransaction[]> {
    const payload = await this.get(`/accounts/${encodeURIComponent(accountId)}/transactions`, {
      startDate: from.toISOString(),
      endDate: to.toISOString(),
      types: "TRADE,DIVIDEND_OR_INTEREST,RECEIVE_AND_DELIVER,CASH_IN_OR_CASH_OUT",
    });
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

      const symbol = transactionSymbol(transaction);
      return {
        id,
        accountId,
        ...(symbol ? { symbol } : {}),
        amount: numberValue(transaction?.netAmount) ?? 0,
        occurredAt: dateValue(transaction?.time) ?? dateValue(transaction?.settlementDate) ?? new Date(),
        description: stringValue(transaction?.description) ?? stringValue(transaction?.type) ?? "Schwab transaction",
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

function transactionSymbol(transaction: Record<string, unknown>) {
  const item = arrayValue(transaction.transferItems)[0];
  const instrument = objectValue(objectValue(item)?.instrument);
  return stringValue(instrument?.symbol);
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
