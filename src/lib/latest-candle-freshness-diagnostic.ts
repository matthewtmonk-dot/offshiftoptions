import "server-only";

import { previousNyseMarketDay } from "@/domain/finance/marketCalendar";
import { OCC_OPTIONABLE_UNIVERSE_SOURCE } from "./occ-optionable-universe-refresh";
import { prisma } from "./prisma";
import { dateOnlyUtc, TECHNICAL_REFRESH_HISTORY_DAYS } from "./technical-indicator-cache";
import type { MarketDataProvider } from "@/providers/market-data/types";

/**
 * Small, explicit-click, read-only diagnostic - see PROJECT_HANDOFF.md's readiness-mismatch
 * investigation. For a handful of deterministic public OCC symbols, fetches the SAME price
 * history technical preparation itself would fetch (TECHNICAL_REFRESH_HISTORY_DAYS) and reports
 * only whether the latest available daily candle is fresh enough for the live scan's own
 * freshness rule right now - never raw candles, prices, or account data. Lets Matt directly
 * observe whether the connected provider has posted the just-closed session's own daily candle
 * yet at the moment this is clicked, without guessing.
 */
export const LATEST_CANDLE_FRESHNESS_DIAGNOSTIC_SYMBOL_COUNT = 5;

async function loadDeterministicSymbols(limit: number, source: string): Promise<string[]> {
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

export type LatestCandleFreshnessRow = {
  ticker: string;
  /** ISO date-only (YYYY-MM-DD), or null if the provider returned no usable candle at all. */
  latestCandleMarketDate: string | null;
  fresh: boolean;
};

export type LatestCandleFreshnessDiagnosticResult = {
  readOnly: true;
  nothingSaved: true;
  accountDataTouched: false;
  /** ISO date-only (YYYY-MM-DD) - previousNyseMarketDay(now), the exact same freshness cutoff the
   * live scan itself uses (see getTechnicalIndicatorSnapshotsForUser). */
  requiredMarketDate: string;
  rows: LatestCandleFreshnessRow[];
};

/**
 * Requests price history for up to `symbolCount` (default
 * LATEST_CANDLE_FRESHNESS_DIAGNOSTIC_SYMBOL_COUNT = 5) deterministic public OCC symbols via this
 * user's OWN resolved provider - never a shared connection, never account/position/transaction
 * data, no DB writes. A per-symbol fetch failure is reported as `latestCandleMarketDate: null,
 * fresh: false` rather than aborting the whole diagnostic.
 */
export async function runLatestCandleFreshnessDiagnostic(
  provider: MarketDataProvider,
  now: Date = new Date(),
  options: { universeSource?: string; symbolCount?: number } = {},
): Promise<LatestCandleFreshnessDiagnosticResult> {
  const requiredMarketDate = dateOnlyUtc(previousNyseMarketDay(now));
  const symbols = await loadDeterministicSymbols(
    options.symbolCount ?? LATEST_CANDLE_FRESHNESS_DIAGNOSTIC_SYMBOL_COUNT,
    options.universeSource ?? OCC_OPTIONABLE_UNIVERSE_SOURCE,
  );

  const rows: LatestCandleFreshnessRow[] = [];
  for (const ticker of symbols) {
    try {
      const candles = await provider.getPriceHistory(ticker, TECHNICAL_REFRESH_HISTORY_DAYS);
      const latest = candles.at(-1)?.date ? dateOnlyUtc(candles.at(-1)!.date) : null;
      rows.push({
        ticker,
        latestCandleMarketDate: latest ? latest.toISOString().slice(0, 10) : null,
        fresh: !!latest && latest.getTime() >= requiredMarketDate.getTime(),
      });
    } catch {
      rows.push({ ticker, latestCandleMarketDate: null, fresh: false });
    }
  }

  return {
    readOnly: true,
    nothingSaved: true,
    accountDataTouched: false,
    requiredMarketDate: requiredMarketDate.toISOString().slice(0, 10),
    rows,
  };
}
