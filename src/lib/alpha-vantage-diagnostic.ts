import "server-only";

import { getAlphaVantageApiKey } from "@/providers/alpha-vantage/config";
import {
  ALPHA_VANTAGE_OVERVIEW_TICKERS,
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
};

/**
 * Verification-only: makes at most one OVERVIEW call per ticker (3 max, fewer if an earlier call
 * is rate-limited - see overview-diagnostic.ts), never runs automatically, and writes nothing to
 * Research/Scanner/WatchlistItem. Any authenticated user (Matt or Eric) may trigger it - the
 * Alpha Vantage key is a single server-level credential, not a per-user connection like Schwab.
 */
export async function runAlphaVantageOverviewDiagnostic(options: DiagnosticOptions = {}): Promise<AlphaVantageDiagnosticResult> {
  const now = options.now ?? new Date();
  const apiKey = getAlphaVantageApiKey();

  if (!apiKey) {
    return {
      status: "UNAVAILABLE",
      reason: "NO_API_KEY",
      message: "ALPHA_VANTAGE_API_KEY is not configured on the server. No request was made.",
      timestamp: now.toISOString(),
      tickers: [...ALPHA_VANTAGE_OVERVIEW_TICKERS],
    };
  }

  try {
    const report = await buildAlphaVantageOverviewDiagnosticFromApiKey({ apiKey, fetchFn: options.fetchFn, now });
    return { status: "OK", report };
  } catch {
    return {
      status: "ERROR",
      message: "Alpha Vantage diagnostic failed safely. No raw response or key detail was returned.",
      timestamp: now.toISOString(),
      tickers: [...ALPHA_VANTAGE_OVERVIEW_TICKERS],
    };
  }
}
