import "server-only";

import { prisma } from "./prisma";
import { OCC_OPTIONABLE_UNIVERSE_SOURCE } from "./occ-optionable-universe-refresh";
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
 * to the next size if the current one was genuinely accepted with that many DISTINCT symbols.
 * Never brute-forced beyond 100.
 */
export const SCHWAB_QUOTE_BATCH_DIAGNOSTIC_SIZES = [5, 25, 50, 100] as const;

const LARGEST_DIAGNOSTIC_SIZE = Math.max(...SCHWAB_QUOTE_BATCH_DIAGNOSTIC_SIZES);

/**
 * Source of test symbols: the public, shared OCC optionable-universe cache
 * (OptionableUniverseSymbol - safe public reference data, production has ~6,071 real
 * underlyings). NEVER positions, transactions, campaigns, private Research/Watchlist, or account
 * holdings. A deterministic ORDER BY ticker ASC LIMIT keeps repeated diagnostic runs comparable -
 * the same first-N tickers every time, not a random sample. Normalized (trimmed/uppercased) and
 * deduplicated via Set BEFORE slicing into test batches, so a duplicate or case-variant row in
 * the source table can never silently shrink the actual distinct count below what a batch claims
 * to test. Ticker is this table's own primary key, so duplicates should never occur in practice -
 * the dedupe is defense in depth, not a workaround for a known data issue. No BRKB -> BRK.B (or
 * any other) ticker transliteration is applied - OCC's own values are used as-is. Scoped to a
 * specific `source` (real callers default to OCC_OPTIONABLE_UNIVERSE_SOURCE = "OCC") - the table
 * is otherwise source-agnostic (see optionable-universe-cache.ts), and this diagnostic's job is
 * to test against the real production OCC universe specifically, not merely "whatever happens to
 * be in the table" (which could otherwise include unrelated future sources, or - in dev/test -
 * other tests' own fixture rows sharing the same physical database).
 */
async function loadDeterministicDistinctSymbols(limit: number, source: string): Promise<string[]> {
  const rows = await prisma.optionableUniverseSymbol.findMany({
    where: { source },
    select: { ticker: true },
    orderBy: { ticker: "asc" },
    take: limit,
  });

  const seen = new Set<string>();
  const distinct: string[] = [];
  for (const row of rows) {
    const ticker = row.ticker.trim().toUpperCase();
    if (ticker && !seen.has(ticker)) {
      seen.add(ticker);
      distinct.push(ticker);
    }
  }
  return distinct;
}

export type SchwabQuoteBatchSizeOutcome =
  | {
      requestedDistinct: number;
      outcome: "SUCCESS";
      requestAccepted: true;
      returnedDistinct: number;
      missingCount: number;
      elapsedMs: number;
    }
  | {
      requestedDistinct: number;
      outcome: "HTTP_ERROR";
      requestAccepted: false;
      httpStatus?: number;
      elapsedMs: number;
    }
  | {
      requestedDistinct: number;
      outcome: "NOT_TESTED";
      requestAccepted: false;
      reason: "INSUFFICIENT_SOURCE_SYMBOLS";
      availableDistinct: number;
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
      /** The largest size for which the outbound request truly contained that many DISTINCT
       * symbols AND Schwab accepted the request - never inflated by a source pool too small to
       * actually contain that many distinct tickers (see loadDeterministicDistinctSymbols). */
      largestVerifiedRequestSize: number | null;
    };

/**
 * Runs the escalating Schwab quote batch-size diagnostic for one user's OWN existing Schwab
 * market-data connection. Market-data only - never resolves an accountHash, never reads
 * positions/transactions/orders/campaigns. Stops as soon as a size cannot be genuinely tested
 * (either the source pool has too few distinct symbols, or Schwab rejected the request) rather
 * than continuing to brute-force larger requests. Returns only sanitized counts/timing - never
 * the raw Schwab response body, never the access token.
 */
export async function runSchwabQuoteBatchDiagnosticForUser(
  userId: string,
  options: { fetchFn?: SchwabFetch; now?: Date; universeSource?: string } = {},
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

  // Loaded once, up front - the same deterministic, ordered, deduplicated pool backs every size;
  // each size just takes a longer prefix of it, so a 25-symbol test's tickers are a strict subset
  // of the 100-symbol test's tickers.
  const distinctSymbols = await loadDeterministicDistinctSymbols(LARGEST_DIAGNOSTIC_SIZE, options.universeSource ?? OCC_OPTIONABLE_UNIVERSE_SOURCE);

  const results: SchwabQuoteBatchSizeOutcome[] = [];
  let largestVerifiedRequestSize: number | null = null;

  for (const size of SCHWAB_QUOTE_BATCH_DIAGNOSTIC_SIZES) {
    if (distinctSymbols.length < size) {
      // The source pool itself cannot supply this many distinct symbols - no larger size can
      // possibly have more available either, so this is a genuine stopping point, not merely a
      // failed HTTP request. Never silently test fewer symbols and call it "size verified."
      results.push({
        requestedDistinct: size,
        outcome: "NOT_TESTED",
        requestAccepted: false,
        reason: "INSUFFICIENT_SOURCE_SYMBOLS",
        availableDistinct: distinctSymbols.length,
      });
      break;
    }

    const batch = distinctSymbols.slice(0, size);
    const started = Date.now();

    try {
      const payload = await schwabGetJson<unknown>({
        accessToken,
        baseUrl: SCHWAB_MARKET_DATA_BASE_URL,
        path: "/quotes",
        searchParams: new URLSearchParams({ symbols: batch.join(","), fields: "quote" }),
        fetchFn: options.fetchFn,
      });
      const elapsedMs = Date.now() - started;
      const quotes = normalizeSchwabQuotesResponse(batch, payload);

      results.push({
        requestedDistinct: size,
        outcome: "SUCCESS",
        requestAccepted: true,
        returnedDistinct: quotes.size,
        missingCount: batch.length - quotes.size,
        elapsedMs,
      });
      largestVerifiedRequestSize = size;
    } catch (error) {
      const elapsedMs = Date.now() - started;
      results.push({
        requestedDistinct: size,
        outcome: "HTTP_ERROR",
        requestAccepted: false,
        httpStatus: error instanceof SchwabApiError ? error.status : undefined,
        elapsedMs,
      });
      break; // Schwab rejected this size - never proceed to a larger one.
    }
  }

  return {
    status: "OK",
    readOnly: true,
    nothingSaved: true,
    accountDataTouched: false,
    timestamp: now.toISOString(),
    results,
    largestVerifiedRequestSize,
  };
}
