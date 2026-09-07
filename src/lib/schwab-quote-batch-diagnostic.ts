import "server-only";

import { prisma } from "./prisma";
import { SchwabApiError, schwabGetJson, type SchwabFetch } from "@/providers/schwab/client";
import { SCHWAB_MARKET_DATA_BASE_URL } from "@/providers/schwab/config";
import { normalizeSchwabQuotesResponse } from "@/providers/schwab/normalizers";
import { getValidSchwabAccessTokenForConnection } from "@/providers/schwab/tokens";

/**
 * Escalating batch sizes for the Schwab quote batch-size diagnostic (see
 * SCHWAB_QUOTE_BATCH_SIZE's own "unverified placeholder" comment in
 * src/providers/schwab/market-data.ts). Each size is tested with exactly ONE real, uncached,
 * unchunked /quotes HTTP call (via schwabGetJson directly, never SchwabMarketDataProvider.
 * getQuotes, which would silently split anything over 100 into multiple calls) - only proceeding
 * to the next size if the current one succeeds. Never brute-forced beyond 100.
 */
export const SCHWAB_QUOTE_BATCH_DIAGNOSTIC_SIZES = [5, 25, 50, 100] as const;

/**
 * A real, ordinary, already-boring-to-this-codebase set of tickers (reused from
 * src/providers/schwab/fundamentals-diagnostic.ts, src/domain/scanner/profile.ts, and
 * prisma/seed.ts demo data) - never invented symbols. Sizes above this pool's length repeat
 * tickers to reach the exact requested count; the report is explicit about "distinct symbols"
 * vs "requested count" so a repeated-symbol artifact is never mistaken for a real duplicate-
 * quote failure.
 */
const DIAGNOSTIC_TICKER_POOL = [
  "AAP",
  "AMD",
  "APLD",
  "BROS",
  "CORZ",
  "F",
  "HOOD",
  "IONQ",
  "PLTR",
  "RIOT",
  "RIVN",
  "ROKU",
  "SNAP",
  "SOFI",
  "T",
  "WBD",
] as const;

export type SchwabQuoteBatchSizeOutcome = {
  requestedCount: number;
  distinctSymbolsRequested: number;
  outcome: "SUCCESS" | "HTTP_ERROR";
  httpStatus?: number;
  symbolsReturnedCount?: number;
  missingCount?: number;
  elapsedMs: number;
};

export type SchwabQuoteBatchDiagnosticResult =
  | { status: "UNAVAILABLE"; reason: "NO_USER_CONNECTION" | "TOKEN_UNAVAILABLE"; message: string; timestamp: string }
  | {
      status: "OK";
      readOnly: true;
      nothingSaved: true;
      accountDataTouched: false;
      timestamp: string;
      results: SchwabQuoteBatchSizeOutcome[];
      largestVerifiedBatchSize: number | null;
    };

/**
 * Runs the escalating Schwab quote batch-size diagnostic for one user's OWN existing Schwab
 * market-data connection. Market-data only - never resolves an accountHash, never reads
 * positions/transactions/orders/campaigns. Stops at the first failed size rather than continuing
 * to brute-force larger requests. Returns only sanitized counts/timing - never the raw Schwab
 * response body, never the access token.
 */
export async function runSchwabQuoteBatchDiagnosticForUser(
  userId: string,
  options: { fetchFn?: SchwabFetch; now?: Date } = {},
): Promise<SchwabQuoteBatchDiagnosticResult> {
  const now = options.now ?? new Date();

  const connection = await prisma.brokerConnection.findFirst({
    where: { userId, provider: "SCHWAB", status: "CONNECTED", accessTokenCiphertext: { not: null }, refreshTokenCiphertext: { not: null } },
    orderBy: { updatedAt: "desc" },
  });
  if (!connection) {
    return {
      status: "UNAVAILABLE",
      reason: "NO_USER_CONNECTION",
      message: "Connect Schwab from Account before running this read-only diagnostic.",
      timestamp: now.toISOString(),
    };
  }

  const accessToken = await getValidSchwabAccessTokenForConnection(connection.id, { expectedUserId: userId, fetchFn: options.fetchFn });
  if (!accessToken) {
    return {
      status: "UNAVAILABLE",
      reason: "TOKEN_UNAVAILABLE",
      message: "Reconnect Schwab from Account before running this read-only diagnostic.",
      timestamp: now.toISOString(),
    };
  }

  const results: SchwabQuoteBatchSizeOutcome[] = [];
  let largestVerifiedBatchSize: number | null = null;

  for (const size of SCHWAB_QUOTE_BATCH_DIAGNOSTIC_SIZES) {
    const symbols = symbolsForBatchSize(size);
    const started = Date.now();

    try {
      const payload = await schwabGetJson<unknown>({
        accessToken,
        baseUrl: SCHWAB_MARKET_DATA_BASE_URL,
        path: "/quotes",
        searchParams: new URLSearchParams({ symbols: symbols.join(","), fields: "quote" }),
        fetchFn: options.fetchFn,
      });
      const elapsedMs = Date.now() - started;
      const quotes = normalizeSchwabQuotesResponse([...new Set(symbols)], payload);

      results.push({
        requestedCount: size,
        distinctSymbolsRequested: new Set(symbols).size,
        outcome: "SUCCESS",
        symbolsReturnedCount: quotes.size,
        missingCount: new Set(symbols).size - quotes.size,
        elapsedMs,
      });
      largestVerifiedBatchSize = size;
    } catch (error) {
      const elapsedMs = Date.now() - started;
      results.push({
        requestedCount: size,
        distinctSymbolsRequested: new Set(symbols).size,
        outcome: "HTTP_ERROR",
        httpStatus: error instanceof SchwabApiError ? error.status : undefined,
        elapsedMs,
      });
      break; // never proceed to a larger size after a failure
    }
  }

  return {
    status: "OK",
    readOnly: true,
    nothingSaved: true,
    accountDataTouched: false,
    timestamp: now.toISOString(),
    results,
    largestVerifiedBatchSize,
  };
}

function symbolsForBatchSize(size: number): string[] {
  return Array.from({ length: size }, (_, i) => DIAGNOSTIC_TICKER_POOL[i % DIAGNOSTIC_TICKER_POOL.length]);
}
