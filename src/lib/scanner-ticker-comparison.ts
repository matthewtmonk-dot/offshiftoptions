import "server-only";

import { bollingerPositionPercent } from "@/domain/finance/calculations";
import { previousNyseMarketDay } from "@/domain/finance/marketCalendar";
import { scannerRulesFromRecords } from "@/domain/scanner/profile";
import { getEarningsCalendarLookup } from "./earnings-calendar-cache";
import { prisma } from "./prisma";
import { dateOnlyUtc, getTechnicalIndicatorSnapshotsForUser } from "./technical-indicator-cache";
import { ensureMyLstScannerProfileForUser, getResearchUniverseTickersForUser } from "./workflows";
import type { MarketDataProvider } from "@/providers/market-data/types";

/**
 * Read-only engineering comparison tool - see PROJECT_HANDOFF.md's weekend-coverage
 * investigation. For a small, explicitly-supplied list of tickers, answers "why does/doesn't this
 * ticker show up the way I expect" without manually hunting a hundred-row scanner table. Never
 * persists anything, never touches another user's data, never fetches an option chain. This is
 * NOT the same code path as evaluateLiveMarketScan and never mutates a ScanRun - it independently
 * re-derives price/volume-rule survival from one small, bounded quote request, and reads the
 * user's own already-cached technical snapshots and already-persisted last scan results.
 */
export const TICKER_COMPARISON_MAX_TICKERS = 25;

export type TickerComparisonRow = {
  ticker: string;
  inOccUniverse: boolean;
  inResearchTier1: boolean;
  quote: { price: number; volume: number | null } | null;
  quoteError: boolean;
  survivesPriceRule: boolean | null;
  survivesVolumeRule: boolean | null;
  technicalState: "READY" | "TECHNICAL_DATA_STALE" | "TECHNICAL_DATA_PENDING" | "HISTORY_UNAVAILABLE";
  rsi: number | null;
  bbPercent: number | null;
  earnings: { daysUntilReport: number; reportDate: string } | null;
  /** From the user's own most recent LIVE:SCHWAB scan's persisted ScanResult for this ticker, if
   * any exists - never a fresh re-run, so this can be older than the current live technical/quote
   * columns above. Null fields mean "not present in that last persisted run" (e.g. it was a
   * quote-stage exclusion, never even reaching a persisted row - see workflows.ts's own bounded
   * persistence: only Tier 1 plus the top-ranked non-Tier-1 survivors are ever saved). */
  lastScan: {
    foundInLastRun: boolean;
    lastRunAt: string | null;
    technicalReasonCode: string | null;
    contractReasonCode: string | null;
    hadOptionValues: boolean;
  };
  /** One human sentence combining the above - never a fabricated score, just an explanation of
   * which known fact accounts for the current state. */
  reasonSummary: string;
};

export type TickerComparisonResult = {
  readOnly: true;
  nothingSaved: true;
  accountDataTouched: false;
  requiredMarketDate: string;
  rows: TickerComparisonRow[];
};

function reasonCodeToText(code: string): string {
  return code
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function summarize(row: Omit<TickerComparisonRow, "reasonSummary">): string {
  if (!row.inOccUniverse && !row.inResearchTier1) {
    return "Not in the public OCC universe and not one of your own Research/Watchlist tickers - never considered.";
  }
  if (row.quoteError || !row.quote) {
    return "Could not get a live quote for this ticker just now.";
  }
  if (row.survivesPriceRule === false) {
    return "Excluded by your price rule at the current quote price.";
  }
  if (row.survivesVolumeRule === false) {
    return "Excluded by your stock-volume rule at the current quote.";
  }
  if (row.technicalState !== "READY") {
    return row.technicalState === "TECHNICAL_DATA_PENDING"
      ? "Survives price/volume, but technical preparation has not reached this ticker yet - RSI/BB unknown."
      : row.technicalState === "TECHNICAL_DATA_STALE"
        ? "Survives price/volume, but the cached technical snapshot is older than the required market date - RSI/BB withheld as stale."
        : "Survives price/volume, but the last history fetch for this ticker failed.";
  }
  if (!row.lastScan.foundInLastRun) {
    return "Currently survives price/volume/technical, but was not found in your last persisted live scan result - it may not have been in the top-ranked shortlist that run, or the universe/rules have changed since.";
  }
  if (row.lastScan.contractReasonCode) {
    return `Reached the option-chain shortlist in your last scan, but was excluded there: ${reasonCodeToText(row.lastScan.contractReasonCode)}.`;
  }
  if (row.lastScan.hadOptionValues) {
    return "Reached the option-chain shortlist in your last scan and was enriched with real contract data.";
  }
  return "Found in your last scan's persisted results, but did not reach the option-chain shortlist that run (technical was known, but it did not rank in the top spots).";
}

/**
 * Requests one bounded, real quote for up to TICKER_COMPARISON_MAX_TICKERS symbols (never the
 * broad universe) via the caller's OWN resolved provider - no history, no option chains, no DB
 * writes.
 */
export async function compareScannerTickersForUser(
  userId: string,
  provider: MarketDataProvider,
  rawTickers: string[],
  now: Date = new Date(),
): Promise<TickerComparisonResult> {
  const tickers = [...new Set(rawTickers.map((t) => t.trim().toUpperCase()).filter(Boolean))].slice(0, TICKER_COMPARISON_MAX_TICKERS);
  const requiredMarketDate = dateOnlyUtc(previousNyseMarketDay(now));

  const [occRows, researchTickers, profile, technicalMap, earningsLookup, lastRun] = await Promise.all([
    tickers.length ? prisma.optionableUniverseSymbol.findMany({ where: { ticker: { in: tickers } }, select: { ticker: true } }) : [],
    getResearchUniverseTickersForUser(userId),
    ensureMyLstScannerProfileForUser(userId),
    tickers.length ? getTechnicalIndicatorSnapshotsForUser(userId, tickers, now) : new Map(),
    tickers.length ? getEarningsCalendarLookup(tickers, now) : new Map(),
    prisma.scanRun.findFirst({
      where: { ownerId: userId, source: "LIVE:SCHWAB" },
      orderBy: { createdAt: "desc" },
      select: {
        createdAt: true,
        results: { where: { ticker: { in: tickers } }, select: { ticker: true, snapshotJson: true } },
      },
    }),
  ]);

  const occTickerSet = new Set(occRows.map((row) => row.ticker));
  const researchTickerSet = new Set(researchTickers.map((t) => t.toUpperCase()));
  const rules = scannerRulesFromRecords(
    await prisma.scannerRule.findMany({ where: { profileId: profile.id }, orderBy: { sortOrder: "asc" } }),
  );
  const priceRule = rules.find((rule) => rule.key === "price");
  const volumeRule = rules.find((rule) => rule.key === "stockVolume");
  const lastRunResultByTicker = new Map((lastRun?.results ?? []).map((result) => [result.ticker, result.snapshotJson]));

  const rows: TickerComparisonRow[] = [];
  for (const ticker of tickers) {
    let quote: { price: number; volume: number | null } | null = null;
    let quoteError = false;
    try {
      const real = await provider.getQuote(ticker);
      quote = { price: real.price, volume: real.volume ?? null };
    } catch {
      quoteError = true;
    }

    const survivesPriceRule =
      !quote || !priceRule ? null : (() => {
        const [low, high] = priceRule.desired as [number, number];
        return quote.price >= low && quote.price <= high;
      })();
    const survivesVolumeRule =
      !quote || !volumeRule
        ? null
        : (() => {
            const [min] = Array.isArray(volumeRule.desired) ? volumeRule.desired : [volumeRule.desired as number];
            return quote.volume !== null && quote.volume >= min;
          })();

    const technicalLookup = technicalMap.get(ticker);
    const technicalState = technicalLookup?.state ?? "TECHNICAL_DATA_PENDING";
    const rsi = technicalLookup && "rsi" in technicalLookup ? technicalLookup.rsi : null;
    const bbPercent =
      technicalLookup && "bbLower" in technicalLookup && quote
        ? bollingerPositionPercent(quote.price, {
            lower: technicalLookup.bbLower ?? 0,
            middle: technicalLookup.bbMiddle ?? 0,
            upper: technicalLookup.bbUpper ?? 0,
          })
        : null;

    const earningsEntry = earningsLookup.get(ticker);
    const earnings = earningsEntry
      ? { daysUntilReport: earningsEntry.daysUntilReport, reportDate: earningsEntry.reportDate.toISOString().slice(0, 10) }
      : null;

    const lastRunSnapshot = lastRunResultByTicker.get(ticker) as Record<string, unknown> | undefined;
    const lastScan = {
      foundInLastRun: !!lastRunSnapshot,
      lastRunAt: lastRun?.createdAt.toISOString() ?? null,
      technicalReasonCode: lastRunSnapshot?.technicalReasonCode ? String(lastRunSnapshot.technicalReasonCode) : null,
      contractReasonCode: lastRunSnapshot?.contractReasonCode ? String(lastRunSnapshot.contractReasonCode) : null,
      hadOptionValues: !!lastRunSnapshot && lastRunSnapshot.optionBid !== null && lastRunSnapshot.optionBid !== undefined,
    };

    const rowWithoutSummary = {
      ticker,
      inOccUniverse: occTickerSet.has(ticker),
      inResearchTier1: researchTickerSet.has(ticker),
      quote,
      quoteError,
      survivesPriceRule,
      survivesVolumeRule,
      technicalState,
      rsi,
      bbPercent,
      earnings,
      lastScan,
    };
    rows.push({ ...rowWithoutSummary, reasonSummary: summarize(rowWithoutSummary) });
  }

  return {
    readOnly: true,
    nothingSaved: true,
    accountDataTouched: false,
    requiredMarketDate: requiredMarketDate.toISOString().slice(0, 10),
    rows,
  };
}
