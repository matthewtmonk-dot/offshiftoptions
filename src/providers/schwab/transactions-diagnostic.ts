import "server-only";

import { SCHWAB_TRADER_BASE_URL } from "./config";
import { schwabGetJson, type SchwabFetch } from "./client";

/**
 * Must match the `types` value SchwabBrokerReadProvider.getTransactions() actually sends
 * (src/providers/schwab/broker-read.ts). Diagnostic B tests this exact string plus each of its
 * components individually to find out whether one of them is rejected by Schwab - never a
 * guessed replacement value.
 */
export const SCHWAB_CURRENT_PRODUCTION_TRANSACTION_TYPES = "TRADE,DIVIDEND_OR_INTEREST,RECEIVE_AND_DELIVER,CASH_IN_OR_CASH_OUT";

export const SCHWAB_TRANSACTIONS_DIAGNOSTIC_WINDOW_DAYS = [7, 30, 60] as const;

export const SCHWAB_TRANSACTIONS_DIAGNOSTIC_TYPE_TESTS = [
  "TRADE",
  "DIVIDEND_OR_INTEREST",
  "RECEIVE_AND_DELIVER",
  "CASH_IN_OR_CASH_OUT",
  SCHWAB_CURRENT_PRODUCTION_TRANSACTION_TYPES,
] as const;

export const SCHWAB_TRANSACTIONS_DIAGNOSTIC_ORDERS_WINDOW_DAYS = 60;

const MAX_INSTRUMENT_SUMMARIES = 50;

export type TransactionsSummary = {
  transactionCount: number;
  typeCounts: Record<string, number>;
  malformedResponse: boolean;
};

export type OrderInstrumentSummary = {
  underlyingSymbol: string | null;
  expiration: string | null;
  strike: number | null;
  putCall: "PUT" | "CALL" | null;
  instruction: string | null;
  quantity: number | null;
  fillPrice: number | null;
  fillDate: string | null;
};

export type OrdersSummary = {
  ordersReceived: number;
  filledOrders: number;
  optionOrders: number;
  fillLegs: number;
  instrumentSummaries: OrderInstrumentSummary[];
  malformedResponse: boolean;
};

export async function fetchSchwabTransactionsRaw({
  accessToken,
  accountHash,
  from,
  to,
  types,
  fetchFn,
  baseUrl = SCHWAB_TRADER_BASE_URL,
}: {
  accessToken: string;
  accountHash: string;
  from: Date;
  to: Date;
  types: string;
  fetchFn?: SchwabFetch;
  baseUrl?: string;
}): Promise<unknown> {
  return schwabGetJson<unknown>({
    accessToken,
    baseUrl,
    path: `/accounts/${encodeURIComponent(accountHash)}/transactions`,
    searchParams: new URLSearchParams({
      startDate: from.toISOString(),
      endDate: to.toISOString(),
      types,
    }),
    fetchFn,
  });
}

export async function fetchSchwabOrdersRaw({
  accessToken,
  accountHash,
  from,
  to,
  fetchFn,
  baseUrl = SCHWAB_TRADER_BASE_URL,
}: {
  accessToken: string;
  accountHash: string;
  from: Date;
  to: Date;
  fetchFn?: SchwabFetch;
  baseUrl?: string;
}): Promise<unknown> {
  return schwabGetJson<unknown>({
    accessToken,
    baseUrl,
    path: `/accounts/${encodeURIComponent(accountHash)}/orders`,
    searchParams: new URLSearchParams({
      fromEnteredTime: from.toISOString(),
      toEnteredTime: to.toISOString(),
    }),
    fetchFn,
  });
}

export function summarizeTransactions(payload: unknown): TransactionsSummary {
  if (!Array.isArray(payload)) {
    return { transactionCount: 0, typeCounts: {}, malformedResponse: true };
  }

  const typeCounts: Record<string, number> = {};
  for (const item of payload) {
    const type = stringValue(objectValue(item)?.type) ?? "UNKNOWN";
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
  }

  return { transactionCount: payload.length, typeCounts, malformedResponse: false };
}

export function summarizeOrders(payload: unknown): OrdersSummary {
  if (!Array.isArray(payload)) {
    return { ordersReceived: 0, filledOrders: 0, optionOrders: 0, fillLegs: 0, instrumentSummaries: [], malformedResponse: true };
  }

  let filledOrders = 0;
  let optionOrders = 0;
  let fillLegs = 0;
  const instrumentSummaries: OrderInstrumentSummary[] = [];

  for (const orderValue of payload) {
    const order = objectValue(orderValue);
    if (!order) {
      continue;
    }

    const legs = arrayValue(order.orderLegCollection);
    const executionLegs = arrayValue(order.orderActivityCollection).flatMap((activity) =>
      arrayValue(objectValue(activity)?.executionLegs),
    );
    const isFilled = stringValue(order.status) === "FILLED" || executionLegs.length > 0;
    const isOption = legs.some((legValue) => stringValue(objectValue(objectValue(legValue)?.instrument)?.assetType) === "OPTION");

    if (isFilled) {
      filledOrders += 1;
    }
    if (isOption) {
      optionOrders += 1;
    }
    if (isOption && isFilled) {
      fillLegs += executionLegs.length;
    }

    if (!isOption) {
      continue;
    }

    for (const legValue of legs) {
      if (instrumentSummaries.length >= MAX_INSTRUMENT_SUMMARIES) {
        break;
      }

      const leg = objectValue(legValue);
      const instrument = objectValue(leg?.instrument);
      if (!instrument || stringValue(instrument.assetType) !== "OPTION") {
        continue;
      }

      const legId = leg?.legId;
      const execution = executionLegs
        .map((value) => objectValue(value))
        .find((value) => value && legId !== undefined && value.legId === legId);

      const putCallRaw = stringValue(instrument.putCall);
      instrumentSummaries.push({
        underlyingSymbol: stringValue(instrument.underlyingSymbol) ?? stringValue(instrument.symbol),
        expiration: dateValue(instrument.optionExpirationDate) ?? dateValue(instrument.expirationDate),
        strike: numberValue(instrument.strikePrice),
        putCall: putCallRaw === "PUT" || putCallRaw === "CALL" ? putCallRaw : null,
        instruction: stringValue(leg?.instruction),
        quantity: numberValue(execution?.quantity) ?? numberValue(leg?.quantity),
        fillPrice: numberValue(execution?.price),
        fillDate: dateValue(execution?.time),
      });
    }
  }

  return { ordersReceived: payload.length, filledOrders, optionOrders, fillLegs, instrumentSummaries, malformedResponse: false };
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
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateValue(value: unknown): string | null {
  const text = stringValue(value);
  if (!text) {
    return null;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
