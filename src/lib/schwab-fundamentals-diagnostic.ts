import "server-only";

import {
  buildSchwabFundamentalsDiagnosticFromToken,
  SCHWAB_FUNDAMENTALS_DIAGNOSTIC_TICKERS,
  type SchwabFundamentalsDiagnosticReport,
} from "@/providers/schwab/fundamentals-diagnostic";
import { SchwabApiError, type SchwabFetch } from "@/providers/schwab/client";
import { findSchwabMarketDataConnectionForUser, getValidSchwabAccessTokenForConnection } from "@/providers/schwab/tokens";

export type SchwabFundamentalsDiagnosticResult =
  | {
      status: "OK";
      label: string;
      usesUserDeveloperApp: boolean;
      report: SchwabFundamentalsDiagnosticReport;
    }
  | {
      status: "UNAVAILABLE";
      label: string;
      reason: "NO_USER_CONNECTION" | "TOKEN_UNAVAILABLE";
      message: string;
      source: "Schwab Trader API";
      tickers: string[];
      timestamp: string;
    }
  | {
      status: "ERROR";
      label: string;
      message: string;
      source: "Schwab Trader API";
      tickers: string[];
      timestamp: string;
      statusCode?: number;
      retryAfter?: string | null;
    };

type DiagnosticOptions = {
  fetchFn?: SchwabFetch;
  now?: Date;
};

export async function runSchwabFundamentalsDiagnosticForUser(
  userId: string,
  options: DiagnosticOptions = {},
): Promise<SchwabFundamentalsDiagnosticResult> {
  const now = options.now ?? new Date();
  const connection = await findSchwabMarketDataConnectionForUser(userId);
  if (!connection) {
    return {
      status: "UNAVAILABLE",
      label: "No Schwab market-data connection",
      reason: "NO_USER_CONNECTION",
      message: "Connect Schwab in Account before running this read-only diagnostic.",
      source: "Schwab Trader API",
      tickers: [...SCHWAB_FUNDAMENTALS_DIAGNOSTIC_TICKERS],
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
      source: "Schwab Trader API",
      tickers: [...SCHWAB_FUNDAMENTALS_DIAGNOSTIC_TICKERS],
      timestamp: now.toISOString(),
    };
  }

  try {
    return {
      status: "OK",
      label: connection.developerCredentialId ? "User Schwab developer app" : "User Schwab OAuth via OSO app",
      usesUserDeveloperApp: Boolean(connection.developerCredentialId),
      report: await buildSchwabFundamentalsDiagnosticFromToken({
        accessToken,
        fetchFn: options.fetchFn,
        now,
      }),
    };
  } catch (error) {
    return {
      status: "ERROR",
      label: "Schwab diagnostic unavailable",
      message: diagnosticErrorMessage(error),
      source: "Schwab Trader API",
      tickers: [...SCHWAB_FUNDAMENTALS_DIAGNOSTIC_TICKERS],
      timestamp: now.toISOString(),
      ...(error instanceof SchwabApiError ? { statusCode: error.status, retryAfter: error.retryAfter } : {}),
    };
  }
}

function diagnosticErrorMessage(error: unknown) {
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
