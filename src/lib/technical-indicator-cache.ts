import "server-only";

import { bollingerBands, wilderRsi } from "@/domain/finance/calculations";
import { previousNyseMarketDay } from "@/domain/finance/marketCalendar";
import { mapWithConcurrency } from "./concurrency";
import { prisma } from "./prisma";
import { ensureMyLstScannerProfileForUser, getResearchUniverseTickersForUser } from "./workflows";
import { scannerRulesFromRecords } from "@/domain/scanner/profile";
import { STARTER_LIVE_SCAN_UNIVERSE } from "@/domain/scanner/live-scan";
import type { MarketDataProvider, MarketQuote } from "@/providers/market-data/types";

/**
 * User-scoped technical indicator cache - see TechnicalIndicatorSnapshot's own schema doc
 * comment for the full design rationale (why user-scoped, why bands not a precomputed bbPercent,
 * why no providerConnectionId). This module is the ONLY place that reads/writes that table.
 *
 * Nothing here is wired into the live scanner or scheduled yet - see PROJECT_HANDOFF.md for the
 * full audit/design report this was built against.
 */

// ---------------------------------------------------------------------------------------------
// Phase A: the eligible-for-technical-refresh ticker set (quote-stage survivors).
// ---------------------------------------------------------------------------------------------

export type TechnicalRefreshPriority = 1 | 2;

export type EligibleTechnicalRefreshTicker = {
  ticker: string;
  /** 1 = this user's own Research/Watchlist/traded tickers (existing Tier 1 concept - see
   * getResearchUniverseTickersForUser); 2 = every other quote-stage (price+volume) survivor.
   * Deliberately just two tiers, in a stable/deterministic order within each - no invented
   * "strength" scoring beyond what the scanner's own configured rules already decide. */
  priority: TechnicalRefreshPriority;
};

/**
 * Phase A: OCC's public Tier 2 universe (union this user's own private Tier 1 tickers) -> one
 * batched getQuotes call (VERIFIED chunked at SCHWAB_QUOTE_BATCH_SIZE=100 - see
 * SchwabMarketDataProvider.getQuotes) -> this user's own configured price/volume rules. Mirrors
 * runScannerUniverseDryRun's exact same universe-building and quote-only rule evaluation (same
 * evaluateCandidate engine, same rule keys) - never a second/different filtering formula - but
 * returns the actual surviving ticker list (with priority) instead of only counts, since Phase B
 * needs concrete tickers to refresh.
 */
export async function getEligibleTechnicalRefreshTickersForUser(
  userId: string,
  provider: MarketDataProvider,
): Promise<EligibleTechnicalRefreshTicker[]> {
  const [profile, userTickers, publicUniverse] = await Promise.all([
    ensureMyLstScannerProfileForUser(userId),
    getResearchUniverseTickersForUser(userId),
    prisma.optionableUniverseSymbol.findMany({ select: { ticker: true } }),
  ]);

  const records = await prisma.scannerRule.findMany({ where: { profileId: profile.id }, orderBy: { sortOrder: "asc" } });
  const rules = scannerRulesFromRecords(records);
  const priceRule = rules.find((rule) => rule.key === "price");
  const volumeRule = rules.find((rule) => rule.key === "stockVolume");

  const userTickerSet = new Set(userTickers.map((ticker) => ticker.toUpperCase()));
  const universe = [...new Set([...STARTER_LIVE_SCAN_UNIVERSE, ...userTickers, ...publicUniverse.map((row) => row.ticker)])]
    .map((ticker) => ticker.toUpperCase())
    .sort(); // deterministic order - see loadDeterministicDistinctSymbols in the batch diagnostic for the same reasoning

  const quotesByTicker = provider.getQuotes ? await provider.getQuotes(universe) : await fetchQuotesIndividually(provider, universe);

  const survivors: EligibleTechnicalRefreshTicker[] = [];
  for (const ticker of universe) {
    const quote = quotesByTicker.get(ticker);
    if (!quote) continue;

    if (priceRule) {
      const [low, high] = priceRule.desired as [number, number];
      if (quote.price < low || quote.price > high) continue;
    }
    if (volumeRule) {
      const volume = quote.volume ?? null;
      const [min] = Array.isArray(volumeRule.desired) ? volumeRule.desired : [volumeRule.desired as number];
      if (volume === null || volume < min) continue;
    }

    survivors.push({ ticker, priority: userTickerSet.has(ticker) ? 1 : 2 });
  }

  return survivors.sort((a, b) => a.priority - b.priority || a.ticker.localeCompare(b.ticker));
}

async function fetchQuotesIndividually(provider: MarketDataProvider, tickers: string[]): Promise<Map<string, MarketQuote>> {
  const entries = await Promise.all(
    tickers.map(async (ticker) => {
      try {
        return [ticker, await provider.getQuote(ticker)] as const;
      } catch {
        return null;
      }
    }),
  );
  return new Map(entries.filter((entry): entry is readonly [string, MarketQuote] => entry !== null));
}

// ---------------------------------------------------------------------------------------------
// Phase B: bounded, resumable background history refresh.
// ---------------------------------------------------------------------------------------------

/** Conservative default per invocation - Schwab's safe sustained price-history throughput has
 * NOT been measured (only the quote batch size has been verified). Deliberately small rather
 * than guessed large; adjust only after a real, bounded throughput measurement. */
export const TECHNICAL_REFRESH_BATCH_SIZE = 25;

/** Same conservative bound already used for the live scanner's own history fetching
 * (SCAN_FETCH_CONCURRENCY) - reused rather than inventing a second concurrency constant. */
const TECHNICAL_REFRESH_CONCURRENCY = 4;

/** How many trailing daily candles to request - IDENTICAL to evaluateLiveMarketScan's own
 * provider.getPriceHistory(ticker, 80) call, so RSI/BB are computed from the exact same input
 * window the live scanner itself would use. Changing this number would change the calculated
 * values (Wilder RSI is not a fixed-window calculation - see calculations.test.ts), so it must
 * never drift from live-scan.ts's own constant. */
export const TECHNICAL_REFRESH_HISTORY_DAYS = 80;

/** A failed row is retried on a later batch, but not hammered every single invocation - avoids
 * hot-looping a provider/network failure. */
const FAILED_RETRY_COOLDOWN_MS = 60 * 60 * 1000;

export const TECHNICAL_SNAPSHOT_FAILURE_REASONS = {
  HISTORY_FETCH_FAILED: "HISTORY_FETCH_FAILED",
} as const;

export type TechnicalRefreshBatchResult = {
  processedCount: number;
  succeededCount: number;
  failedCount: number;
  /** How many eligible tickers still need a refresh (missing/stale/retryable-failed) after this
   * batch - 0 means fully caught up. Lets a caller decide whether to invoke again. */
  remainingEligibleCount: number;
  /** Real wall-clock time for this ENTIRE invocation (Phase A's quote sweep + Phase B's bounded
   * history processing), in milliseconds - the aggregate cost a caller needs to estimate how many
   * worker invocations a full preparation cycle would take. Never a raw per-request timing
   * breakdown, no raw provider response, no token - just one aggregate number. */
  elapsedMs: number;
};

/**
 * Phase B: processes at most `batchSize` symbols from this user's eligible set that are missing,
 * stale, or failed-but-retryable - never all ~2,000+ eligible symbols in one call (no long-running
 * single request). Safely repeatable: re-running immediately just reprocesses whatever is still
 * missing/stale/retryable (already-READY-and-fresh rows are skipped), so a resumed or duplicate
 * invocation is idempotent, not additive. One symbol's price-history failure is caught and
 * recorded as a FAILED row for that symbol alone - it never aborts or "poisons" the rest of the
 * batch.
 */
export async function refreshTechnicalIndicatorCacheBatchForUser(
  userId: string,
  provider: MarketDataProvider,
  options: { batchSize?: number; now?: Date } = {},
): Promise<TechnicalRefreshBatchResult> {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? TECHNICAL_REFRESH_BATCH_SIZE;

  const eligible = await getEligibleTechnicalRefreshTickersForUser(userId, provider);
  const needsWork = await filterTickersNeedingRefresh(userId, eligible, now);

  const batch = needsWork.slice(0, batchSize);
  const outcomes = await mapWithConcurrency(batch, TECHNICAL_REFRESH_CONCURRENCY, async (item) => {
    try {
      const candles = await provider.getPriceHistory(item.ticker, TECHNICAL_REFRESH_HISTORY_DAYS);
      const closes = candles.map((candle) => candle.close);
      const rsi = wilderRsi(closes);
      const bands = bollingerBands(closes);
      const asOfDate = candles.at(-1)?.date ?? null;

      await upsertSnapshot(userId, item.ticker, {
        status: "READY",
        asOfDate: asOfDate ? dateOnlyUtc(asOfDate) : null,
        rsi,
        bbLower: bands?.lower ?? null,
        bbMiddle: bands?.middle ?? null,
        bbUpper: bands?.upper ?? null,
        failureReason: null,
        historyFetchedAt: now,
        now,
      });
      return { ok: true as const };
    } catch {
      // Sanitized - never persists a raw provider error/exception detail.
      await upsertSnapshot(userId, item.ticker, {
        status: "FAILED",
        asOfDate: null,
        rsi: null,
        bbLower: null,
        bbMiddle: null,
        bbUpper: null,
        failureReason: TECHNICAL_SNAPSHOT_FAILURE_REASONS.HISTORY_FETCH_FAILED,
        historyFetchedAt: null,
        now,
        preserveExistingGoodValues: true,
      });
      return { ok: false as const };
    }
  });

  const succeededCount = outcomes.filter((outcome) => outcome.ok).length;
  const failedCount = outcomes.length - succeededCount;

  return {
    processedCount: batch.length,
    succeededCount,
    failedCount,
    remainingEligibleCount: Math.max(needsWork.length - batch.length, 0),
    elapsedMs: Date.now() - startedAt,
  };
}

async function filterTickersNeedingRefresh(
  userId: string,
  eligible: EligibleTechnicalRefreshTicker[],
  now: Date,
): Promise<EligibleTechnicalRefreshTicker[]> {
  if (!eligible.length) return [];

  const existing = await prisma.technicalIndicatorSnapshot.findMany({
    where: { userId, ticker: { in: eligible.map((item) => item.ticker) } },
    select: { ticker: true, status: true, asOfDate: true, updatedAt: true },
  });
  const byTicker = new Map(existing.map((row) => [row.ticker, row]));
  const freshCutoff = dateOnlyUtc(previousNyseMarketDay(now));

  return eligible.filter((item) => {
    const row = byTicker.get(item.ticker);
    if (!row) return true; // missing
    if (row.status === "FAILED") {
      return now.getTime() - row.updatedAt.getTime() >= FAILED_RETRY_COOLDOWN_MS; // failed-but-retryable
    }
    // READY - stale if its asOfDate predates the most recent completed trading day.
    return !row.asOfDate || row.asOfDate.getTime() < freshCutoff.getTime();
  });
}

async function upsertSnapshot(
  userId: string,
  ticker: string,
  values: {
    status: "READY" | "FAILED";
    asOfDate: Date | null;
    rsi: number | null;
    bbLower: number | null;
    bbMiddle: number | null;
    bbUpper: number | null;
    failureReason: string | null;
    historyFetchedAt: Date | null;
    now: Date;
    /** On a FAILED write, never overwrite a prior good READY row's actual indicator values with
     * nulls - only status/failureReason/updatedAt change, exactly like a failed OCC/earnings
     * refresh never destroys the prior valid cache. */
    preserveExistingGoodValues?: boolean;
  },
): Promise<void> {
  if (values.preserveExistingGoodValues) {
    await prisma.$executeRaw`
      INSERT INTO "TechnicalIndicatorSnapshot" ("userId", "ticker", "asOfDate", "status", "rsi", "bbLower", "bbMiddle", "bbUpper", "failureReason", "historyFetchedAt", "updatedAt")
      VALUES (${userId}, ${ticker}, ${values.asOfDate}, ${values.status}::"TechnicalSnapshotStatus", ${values.rsi}, ${values.bbLower}, ${values.bbMiddle}, ${values.bbUpper}, ${values.failureReason}, ${values.historyFetchedAt}, ${values.now})
      ON CONFLICT ("userId", "ticker") DO UPDATE SET
        "status" = EXCLUDED."status",
        "failureReason" = EXCLUDED."failureReason",
        "updatedAt" = EXCLUDED."updatedAt"
    `;
    return;
  }

  await prisma.$executeRaw`
    INSERT INTO "TechnicalIndicatorSnapshot" ("userId", "ticker", "asOfDate", "status", "rsi", "bbLower", "bbMiddle", "bbUpper", "failureReason", "historyFetchedAt", "updatedAt")
    VALUES (${userId}, ${ticker}, ${values.asOfDate}, ${values.status}::"TechnicalSnapshotStatus", ${values.rsi}, ${values.bbLower}, ${values.bbMiddle}, ${values.bbUpper}, ${values.failureReason}, ${values.historyFetchedAt}, ${values.now})
    ON CONFLICT ("userId", "ticker") DO UPDATE SET
      "asOfDate" = EXCLUDED."asOfDate",
      "status" = EXCLUDED."status",
      "rsi" = EXCLUDED."rsi",
      "bbLower" = EXCLUDED."bbLower",
      "bbMiddle" = EXCLUDED."bbMiddle",
      "bbUpper" = EXCLUDED."bbUpper",
      "failureReason" = EXCLUDED."failureReason",
      "historyFetchedAt" = EXCLUDED."historyFetchedAt",
      "updatedAt" = EXCLUDED."updatedAt"
  `;
}

function dateOnlyUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

// ---------------------------------------------------------------------------------------------
// Read path: for the eventual live-scan join (NOT wired into evaluateLiveMarketScan yet).
// ---------------------------------------------------------------------------------------------

export type TechnicalIndicatorLookup =
  | { state: "READY"; asOfDate: Date; rsi: number | null; bbLower: number | null; bbMiddle: number | null; bbUpper: number | null }
  | { state: "TECHNICAL_DATA_STALE"; asOfDate: Date; rsi: number | null; bbLower: number | null; bbMiddle: number | null; bbUpper: number | null }
  | { state: "TECHNICAL_DATA_PENDING" }
  | { state: "HISTORY_UNAVAILABLE" };

/**
 * Read-only, zero-provider-call lookup - never fetches. A missing row is honestly
 * TECHNICAL_DATA_PENDING (never fabricated), a READY row whose asOfDate predates the most recent
 * completed trading day is honestly TECHNICAL_DATA_STALE (still returned - a caller may choose to
 * use slightly-stale data rather than nothing, but is never told it's current when it isn't), and
 * a FAILED row is HISTORY_UNAVAILABLE. To reproduce live-scan's exact bbPercent, a caller must
 * combine the returned bands with a FRESH quote price via bollingerPositionPercent(quotePrice,
 * bands) itself - this function deliberately never guesses a price.
 */
export async function getTechnicalIndicatorSnapshotsForUser(
  userId: string,
  tickers: string[],
  now: Date = new Date(),
): Promise<Map<string, TechnicalIndicatorLookup>> {
  const normalized = [...new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean))];
  const map = new Map<string, TechnicalIndicatorLookup>();
  if (!normalized.length) return map;

  const rows = await prisma.technicalIndicatorSnapshot.findMany({ where: { userId, ticker: { in: normalized } } });
  const freshCutoff = dateOnlyUtc(previousNyseMarketDay(now));
  const byTicker = new Map(rows.map((row) => [row.ticker, row]));

  for (const ticker of normalized) {
    const row = byTicker.get(ticker);
    if (!row) {
      map.set(ticker, { state: "TECHNICAL_DATA_PENDING" });
      continue;
    }
    if (row.status === "FAILED") {
      map.set(ticker, { state: "HISTORY_UNAVAILABLE" });
      continue;
    }
    const base = { asOfDate: row.asOfDate as Date, rsi: row.rsi, bbLower: row.bbLower, bbMiddle: row.bbMiddle, bbUpper: row.bbUpper };
    const isStale = !row.asOfDate || row.asOfDate.getTime() < freshCutoff.getTime();
    map.set(ticker, isStale ? { state: "TECHNICAL_DATA_STALE", ...base } : { state: "READY", ...base });
  }

  return map;
}

// ---------------------------------------------------------------------------------------------
// Readiness status - the minimal aggregate a UI needs ("1,842 / 2,036 ready").
// ---------------------------------------------------------------------------------------------

export type TechnicalCacheReadinessStatus = {
  eligibleCount: number;
  readyCount: number;
  pendingCount: number;
  lastPreparedAt: Date | null;
};

export async function getTechnicalCacheReadinessForUser(
  userId: string,
  eligibleTickers: string[],
  now: Date = new Date(),
): Promise<TechnicalCacheReadinessStatus> {
  const normalized = [...new Set(eligibleTickers.map((ticker) => ticker.toUpperCase()))];
  if (!normalized.length) {
    return { eligibleCount: 0, readyCount: 0, pendingCount: 0, lastPreparedAt: null };
  }

  const rows = await prisma.technicalIndicatorSnapshot.findMany({
    where: { userId, ticker: { in: normalized } },
    select: { ticker: true, status: true, asOfDate: true, updatedAt: true },
  });
  const freshCutoff = dateOnlyUtc(previousNyseMarketDay(now));
  const byTicker = new Map(rows.map((row) => [row.ticker, row]));

  let readyCount = 0;
  let lastPreparedAt: Date | null = null;
  for (const ticker of normalized) {
    const row = byTicker.get(ticker);
    if (row?.status === "READY" && row.asOfDate && row.asOfDate.getTime() >= freshCutoff.getTime()) {
      readyCount += 1;
      if (!lastPreparedAt || row.updatedAt > lastPreparedAt) {
        lastPreparedAt = row.updatedAt;
      }
    }
  }

  return { eligibleCount: normalized.length, readyCount, pendingCount: normalized.length - readyCount, lastPreparedAt };
}
