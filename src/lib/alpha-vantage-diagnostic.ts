import "server-only";

import { getAlphaVantageApiKey } from "@/providers/alpha-vantage/config";
import {
  ALPHA_VANTAGE_OVERVIEW_TICKERS,
  ALPHA_VANTAGE_REMAINING_VERIFICATION_TICKERS,
  buildAlphaVantageOverviewDiagnosticFromApiKey,
  type AlphaVantageOverviewDiagnosticReport,
} from "@/providers/alpha-vantage/overview-diagnostic";
import type { AlphaVantageFetch } from "@/providers/alpha-vantage/client";

export type AlphaVantageDiagnosticResult =
  | { status: "OK"; report: AlphaVantageOverviewDiagnosticReport }
  | { status: "UNAVAILABLE"; reason: "NO_API_KEY"; message: string; timestamp: string; tickers: string[] }
  | { status: "ERROR"; message: string; timestamp: string; tickers: string[] };

type DiagnosticOptions = {
  fetchFn?: AlphaVantageFetch;
  now?: Date;
  tickers?: readonly string[];
};

/**
 * Verification-only: makes at most one OVERVIEW call per ticker (3 max by default, fewer if an
 * earlier call is rate-limited - see overview-diagnostic.ts), paced at least
 * ALPHA_VANTAGE_REQUEST_DELAY_MS apart to stay under Alpha Vantage's 1-request-per-second limit,
 * never runs automatically, and writes nothing to Research/Scanner/WatchlistItem. Any
 * authenticated user (Matt or Eric) may trigger it - the Alpha Vantage key is a single
 * server-level credential, not a per-user connection like Schwab.
 */
export async function runAlphaVantageOverviewDiagnostic(options: DiagnosticOptions = {}): Promise<AlphaVantageDiagnosticResult> {
  const now = options.now ?? new Date();
  const tickers = options.tickers ?? ALPHA_VANTAGE_OVERVIEW_TICKERS;
  const apiKey = getAlphaVantageApiKey();

  if (!apiKey) {
    return {
      status: "UNAVAILABLE",
      reason: "NO_API_KEY",
      message: "ALPHA_VANTAGE_API_KEY is not configured on the server. No request was made.",
      timestamp: now.toISOString(),
      tickers: [...tickers],
    };
  }

  try {
    const report = await buildAlphaVantageOverviewDiagnosticFromApiKey({ apiKey, tickers, fetchFn: options.fetchFn, now });
    return { status: "OK", report };
  } catch {
    return {
      status: "ERROR",
      message: "Alpha Vantage diagnostic failed safely. No raw response or key detail was returned.",
      timestamp: now.toISOString(),
      tickers: [...tickers],
    };
  }
}

/**
 * Temporary follow-up path for the 2026-09-03 production verification: APLD already returned a
 * real SUCCESS, so re-calling it would waste a daily request. Costs at most 2 calls
 * (RIOT, CORZ) instead of 3.
 */
export async function runAlphaVantageRemainingTickersDiagnostic(options: Omit<DiagnosticOptions, "tickers"> = {}): Promise<AlphaVantageDiagnosticResult> {
  return runAlphaVantageOverviewDiagnostic({ ...options, tickers: ALPHA_VANTAGE_REMAINING_VERIFICATION_TICKERS });
}
