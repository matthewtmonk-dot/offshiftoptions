import "server-only";

import { prisma } from "./prisma";
import { SchwabApiError, type SchwabFetch } from "@/providers/schwab/client";
import { accountNumbersFromMetadata, getValidSchwabAccessTokenForConnection } from "@/providers/schwab/tokens";
import {
  fetchSchwabOrdersRaw,
  fetchSchwabTransactionsRaw,
  SCHWAB_CURRENT_PRODUCTION_TRANSACTION_TYPES,
  SCHWAB_TRANSACTIONS_DIAGNOSTIC_ORDERS_WINDOW_DAYS,
  SCHWAB_TRANSACTIONS_DIAGNOSTIC_TYPE_TESTS,
  SCHWAB_TRANSACTIONS_DIAGNOSTIC_WINDOW_DAYS,
  summarizeOrders,
  summarizeTransactions,
  type OrdersSummary,
  type TransactionsSummary,
} from "@/providers/schwab/transactions-diagnostic";

type CallOutcome<TSummary> =
  | ({ status: "OK"; httpStatus: 200 } & TSummary)
  | { status: "ERROR"; httpStatus?: number; errorMessage: string };

export type TransactionWindowResult = { days: number } & CallOutcome<TransactionsSummary>;
export type TransactionTypeTestResult = { types: string } & CallOutcome<TransactionsSummary>;
export type OrdersDiagnosticResult = CallOutcome<OrdersSummary>;

export type SchwabTransactionsDiagnosticReport = {
  source: "Schwab Trader API";
  readOnly: true;
  nothingSaved: true;
  timestamp: string;
  windows: TransactionWindowResult[];
  typeTests: TransactionTypeTestResult[];
  orders: OrdersDiagnosticResult;
};

export type SchwabTransactionsDiagnosticResult =
  | {
      status: "OK";
      label: string;
      report: SchwabTransactionsDiagnosticReport;
    }
  | {
      status: "UNAVAILABLE";
      label: string;
      reason: "NO_USER_CONNECTION" | "TOKEN_UNAVAILABLE";
      message: string;
      timestamp: string;
    }
  | {
      status: "ERROR";
      label: string;
      message: string;
      timestamp: string;
      statusCode?: number;
      retryAfter?: string | null;
    };

type DiagnosticOptions = {
  fetchFn?: SchwabFetch;
  now?: Date;
};

export async function runSchwabTransactionsDiagnosticForUser(
  userId: string,
  options: DiagnosticOptions = {},
): Promise<SchwabTransactionsDiagnosticResult> {
  const now = options.now ?? new Date();

  const connection = await prisma.brokerConnection.findFirst({
    where: { userId, provider: "SCHWAB", status: "CONNECTED" },
    orderBy: { updatedAt: "desc" },
  });
  if (!connection) {
    return {
      status: "UNAVAILABLE",
      label: "No Schwab broker connection",
      reason: "NO_USER_CONNECTION",
      message: "Connect Schwab in Account before running this read-only diagnostic.",
      timestamp: now.toISOString(),
    };
  }

  const accessToken = await getValidSchwabAccessTokenForConnection(connection.id, {
    expectedUserId: userId,
    fetchFn: options.fetchFn,
  });
  if (!accessToken) {
    return {
      status: "UNAVAILABLE",
      label: "Schwab token unavailable",
      reason: "TOKEN_UNAVAILABLE",
      message: "Reconnect Schwab from Account before running this read-only diagnostic.",
      timestamp: now.toISOString(),
    };
  }

  const accountHash = accountNumbersFromMetadata(connection.metadata)[0]?.hashValue ?? null;
  if (!accountHash) {
    return {
      status: "ERROR",
      label: "Schwab account unavailable",
      message: "No Schwab account is linked to this connection yet. Reconnect Schwab to refresh account discovery.",
      timestamp: now.toISOString(),
    };
  }

  try {
    const windows: TransactionWindowResult[] = [];
    for (const days of SCHWAB_TRANSACTIONS_DIAGNOSTIC_WINDOW_DAYS) {
      const outcome = await callTransactions({
        accessToken,
        accountHash,
        from: daysAgo(now, days),
        to: now,
        types: SCHWAB_CURRENT_PRODUCTION_TRANSACTION_TYPES,
        fetchFn: options.fetchFn,
      });
      windows.push({ days, ...outcome });
    }

    const typeTests: TransactionTypeTestResult[] = [];
    for (const types of SCHWAB_TRANSACTIONS_DIAGNOSTIC_TYPE_TESTS) {
      const outcome = await callTransactions({
        accessToken,
        accountHash,
        from: daysAgo(now, 30),
        to: now,
        types,
        fetchFn: options.fetchFn,
      });
      typeTests.push({ types, ...outcome });
    }

    const orders = await callOrders({
      accessToken,
      accountHash,
      from: daysAgo(now, SCHWAB_TRANSACTIONS_DIAGNOSTIC_ORDERS_WINDOW_DAYS),
      to: now,
      fetchFn: options.fetchFn,
    });

    return {
      status: "OK",
      label: "User Schwab brokerage authorization",
      report: {
        source: "Schwab Trader API",
        readOnly: true,
        nothingSaved: true,
        timestamp: now.toISOString(),
        windows,
        typeTests,
        orders,
      },
    };
  } catch (error) {
    return {
      status: "ERROR",
      label: "Schwab diagnostic unavailable",
      message: diagnosticErrorMessage(error),
      timestamp: now.toISOString(),
      ...(error instanceof SchwabApiError ? { statusCode: error.status, retryAfter: error.retryAfter } : {}),
    };
  }
}

async function callTransactions(params: {
  accessToken: string;
  accountHash: string;
  from: Date;
  to: Date;
  types: string;
  fetchFn?: SchwabFetch;
}): Promise<CallOutcome<TransactionsSummary>> {
  try {
    const raw = await fetchSchwabTransactionsRaw(params);
    return { status: "OK", httpStatus: 200, ...summarizeTransactions(raw) };
  } catch (error) {
    return {
      status: "ERROR",
      httpStatus: error instanceof SchwabApiError ? error.status : undefined,
      errorMessage: diagnosticErrorMessage(error),
    };
  }
}

async function callOrders(params: {
  accessToken: string;
  accountHash: string;
  from: Date;
  to: Date;
  fetchFn?: SchwabFetch;
}): Promise<CallOutcome<OrdersSummary>> {
  try {
    const raw = await fetchSchwabOrdersRaw(params);
    return { status: "OK", httpStatus: 200, ...summarizeOrders(raw) };
  } catch (error) {
    return {
      status: "ERROR",
      httpStatus: error instanceof SchwabApiError ? error.status : undefined,
      errorMessage: diagnosticErrorMessage(error),
    };
  }
}

function daysAgo(now: Date, days: number) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function diagnosticErrorMessage(error: unknown): string {
  if (error instanceof SchwabApiError) {
    if (error.status === 401) {
      return "Schwab authorization is expired or unavailable. Reconnect Schwab, then try again.";
    }
    if (error.status === 429) {
      return "Schwab rate limit reached. Try again after the provider cooldown.";
    }
    return "Schwab returned an error while running the diagnostic. No raw response was returned.";
  }

  return "Schwab diagnostic failed safely. No raw response or credential detail was returned.";
}
