import "server-only";

import { createHash } from "node:crypto";
import { bollingerBands, wilderRsi } from "@/domain/finance/calculations";
import { previousNyseMarketDay } from "@/domain/finance/marketCalendar";
import { mapWithConcurrency } from "./concurrency";
import { prisma } from "./prisma";
import { ensureMyLstScannerProfileForUser, getResearchUniverseTickersForUser } from "./workflows";
import { scannerRulesFromRecords } from "@/domain/scanner/profile";
import type { ScannerRule } from "@/domain/scanner/scanner";
import { STARTER_LIVE_SCAN_UNIVERSE } from "@/domain/scanner/live-scan";
import type { MarketDataProvider, MarketQuote } from "@/providers/market-data/types";

/**
 * User-scoped technical indicator cache - see TechnicalIndicatorSnapshot's own schema doc
 * comment for the full design rationale (why user-scoped, why bands not a precomputed bbPercent,
 * why no providerConnectionId). This module is the ONLY place that reads/writes that table.
 *
 * Real production evidence (2026-09-07) showed every Phase B (history) batch was ALSO
 * redundantly repeating the full Phase A (~6,071-symbol OCC quote sweep, ~61 Schwab /quotes
 * requests) - ~82 invocations to process ~2,036 eligible symbols would have meant ~5,000 wasted
 * quote requests just to rediscover the same eligible set. TechnicalPreparationRun/
 * TechnicalPreparationItem (see their own schema doc comments) now persist one sweep's result so
 * Phase B invocations 2..N never call getQuotes again for the same run.
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

async function loadUserQuoteStageRules(userId: string): Promise<ScannerRule[]> {
  const profile = await ensureMyLstScannerProfileForUser(userId);
  const records = await prisma.scannerRule.findMany({ where: { profileId: profile.id }, orderBy: { sortOrder: "asc" } });
  return scannerRulesFromRecords(records);
}

/**
 * A deterministic fingerprint of ONLY the two quote-stage rules Phase A actually evaluates
 * (price, stockVolume) - a rule's absence from `rules` already means "disabled" (see
 * scannerRulesFromRecords), so that absence is itself part of what gets hashed. Used to decide
 * whether a persisted TechnicalPreparationRun's eligible set is still valid for this user's
 * CURRENT rule configuration - if Matt changes his price range or volume rule, his fingerprint
 * changes, and the old run's set is never silently reused. Deliberately does NOT hash Research/
 * Watchlist membership (that only affects priority ordering, never which tickers are eligible at
 * all) or any other rule this Phase never looks at.
 */
export function computeQuoteStageRulesFingerprint(rules: ScannerRule[]): string {
  const priceRule = rules.find((rule) => rule.key === "price");
  const volumeRule = rules.find((rule) => rule.key === "stockVolume");
  const payload = JSON.stringify({ price: priceRule?.desired ?? null, stockVolume: volumeRule?.desired ?? null });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * Phase A: OCC's public Tier 2 universe (union this user's own private Tier 1 tickers) -> one
 * batched getQuotes call (VERIFIED chunked at SCHWAB_QUOTE_BATCH_SIZE=100 - see
 * SchwabMarketDataProvider.getQuotes) -> this user's own configured price/volume rules. Mirrors
 * runScannerUniverseDryRun's exact same universe-building and quote-only rule evaluation (same
 * evaluateCandidate engine, same rule keys) - never a second/different filtering formula - but
 * returns the actual surviving ticker list (with priority) instead of only counts.
 *
 * Called ONLY when getOrCreateActiveTechnicalPreparationRun decides a fresh sweep is actually
 * needed (see below) - never on every Phase B batch anymore.
 */
export async function getEligibleTechnicalRefreshTickersForUser(
  userId: string,
  provider: MarketDataProvider,
): Promise<EligibleTechnicalRefreshTicker[]> {
  const [rules, userTickers, publicUniverse] = await Promise.all([
    loadUserQuoteStageRules(userId),
    getResearchUniverseTickersForUser(userId),
    prisma.optionableUniverseSymbol.findMany({ select: { ticker: true } }),
  ]);

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
// Persisted preparation run/queue - so Phase A runs once per cycle, not once per Phase B batch.
// ---------------------------------------------------------------------------------------------

export type ActiveTechnicalPreparationRun = {
  runId: string;
  eligibleCount: number;
  /** True only when THIS call performed the real quote sweep (a brand new run was created) -
   * false when an existing, still-valid run was reused. Exposed mainly for tests/observability. */
  freshlyCreated: boolean;
};

/**
 * Returns the current user's active (same marketDate, same rulesFingerprint, IN_PROGRESS)
 * TechnicalPreparationRun, creating one - and doing the one real Phase A quote sweep - only if no
 * matching run already exists. This is the ONLY place a new run is created, and therefore the
 * ONLY place getEligibleTechnicalRefreshTickersForUser (and its Schwab quote sweep) is ever
 * called from the rest of this module.
 *
 * At creation time, each eligible ticker's TechnicalPreparationItem starts PENDING unless its
 * existing TechnicalIndicatorSnapshot is already READY and fresh (asOfDate >=
 * previousNyseMarketDay(now)) - in which case the item starts already READY, so Phase B never
 * wastes a history request re-fetching data that's already current. A ticker whose existing
 * snapshot is FAILED, stale, or missing always starts PENDING.
 *
 * If the quote sweep itself throws (e.g. a Schwab outage), no run/items are created and this
 * rethrows - the existing TechnicalIndicatorSnapshot cache is completely untouched, exactly like
 * a failed OCC/earnings refresh never destroys the prior valid cache.
 */
export async function getOrCreateActiveTechnicalPreparationRun(
  userId: string,
  provider: MarketDataProvider,
  now: Date = new Date(),
): Promise<ActiveTechnicalPreparationRun> {
  const rules = await loadUserQuoteStageRules(userId);
  const fingerprint = computeQuoteStageRulesFingerprint(rules);
  const marketDate = dateOnlyUtc(now);

  // Matched on (userId, marketDate, rulesFingerprint) alone - status is deliberately NOT part of
  // this filter. A COMPLETE run is still the valid, current run for today's rules; excluding it
  // here would make every call after the run finishes re-trigger a whole new quote sweep just to
  // discover "there's nothing left to do," defeating the entire point of this persistence layer.
  const existing = await prisma.technicalPreparationRun.findFirst({
    where: { userId, marketDate, rulesFingerprint: fingerprint },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    return { runId: existing.id, eligibleCount: existing.eligibleCount, freshlyCreated: false };
  }

  // Phase A: the one real quote sweep for this cycle.
  const eligible = await getEligibleTechnicalRefreshTickersForUser(userId, provider);
  const freshCutoff = dateOnlyUtc(previousNyseMarketDay(now));
  const existingSnapshots = eligible.length
    ? await prisma.technicalIndicatorSnapshot.findMany({
        where: { userId, ticker: { in: eligible.map((item) => item.ticker) } },
        select: { ticker: true, status: true, asOfDate: true },
      })
    : [];
  const snapshotByTicker = new Map(existingSnapshots.map((row) => [row.ticker, row]));

  const initialStatuses = eligible.map((item) => {
    const snapshot = snapshotByTicker.get(item.ticker);
    const alreadyFresh = snapshot?.status === "READY" && !!snapshot.asOfDate && snapshot.asOfDate.getTime() >= freshCutoff.getTime();
    return { ...item, initialStatus: alreadyFresh ? ("READY" as const) : ("PENDING" as const) };
  });
  const pendingCount = initialStatuses.filter((item) => item.initialStatus === "PENDING").length;

  const run = await prisma.technicalPreparationRun.create({
    data: {
      userId,
      marketDate,
      rulesFingerprint: fingerprint,
      eligibleCount: eligible.length,
      status: pendingCount > 0 ? "IN_PROGRESS" : "COMPLETE",
    },
  });
  if (initialStatuses.length) {
    await prisma.technicalPreparationItem.createMany({
      data: initialStatuses.map((item) => ({
        runId: run.id,
        ticker: item.ticker,
        priority: item.priority,
        status: item.initialStatus,
        processedAt: item.initialStatus === "READY" ? now : null,
      })),
    });
  }

  return { runId: run.id, eligibleCount: eligible.length, freshlyCreated: true };
}

// ---------------------------------------------------------------------------------------------
// Phase B: bounded, resumable background history refresh - consumes a persisted run's queue.
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

export const TECHNICAL_SNAPSHOT_FAILURE_REASONS = {
  HISTORY_FETCH_FAILED: "HISTORY_FETCH_FAILED",
} as const;

export type TechnicalRefreshBatchResult = {
  processedCount: number;
  succeededCount: number;
  failedCount: number;
  /** How many PENDING items remain in the active run after this batch - 0 means the run just
   * completed. Lets a caller decide whether to invoke again. */
  remainingEligibleCount: number;
  /** Real wall-clock time for this ENTIRE invocation, in milliseconds - on every call except the
   * one that creates a new run, this reflects ONLY Phase B (history fetch + RSI/BB), since no
   * quote sweep happens. The aggregate cost a caller needs to estimate how many worker
   * invocations a full preparation cycle would take. Never a raw per-request timing breakdown, no
   * raw provider response, no token - just one aggregate number. */
  elapsedMs: number;
};

/**
 * Phase B: processes at most `batchSize` PENDING items from this user's ACTIVE preparation run -
 * never all ~2,000+ eligible symbols in one call (no long-running single request), and never a
 * fresh Schwab quote sweep unless getOrCreateActiveTechnicalPreparationRun determines one is
 * genuinely needed (new day, or the user's price/volume rules changed). Safely repeatable: a
 * duplicate/resumed invocation only ever pulls whatever is still PENDING (already-processed items
 * are skipped by construction, since their status is no longer PENDING), so it's idempotent, not
 * additive. One symbol's price-history failure is caught and recorded as a FAILED row for that
 * symbol alone - it never aborts or "poisons" the rest of the batch.
 */
export async function refreshTechnicalIndicatorCacheBatchForUser(
  userId: string,
  provider: MarketDataProvider,
  options: { batchSize?: number; now?: Date } = {},
): Promise<TechnicalRefreshBatchResult> {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? TECHNICAL_REFRESH_BATCH_SIZE;

  const { runId } = await getOrCreateActiveTechnicalPreparationRun(userId, provider, now);

  const pendingItems = await prisma.technicalPreparationItem.findMany({
    where: { runId, status: "PENDING" },
    orderBy: [{ priority: "asc" }, { ticker: "asc" }],
    take: batchSize,
  });

  const outcomes = await mapWithConcurrency(pendingItems, TECHNICAL_REFRESH_CONCURRENCY, async (item) => {
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
      await prisma.technicalPreparationItem.update({ where: { id: item.id }, data: { status: "READY", processedAt: now } });
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
      await prisma.technicalPreparationItem.update({ where: { id: item.id }, data: { status: "FAILED", processedAt: now } });
      return { ok: false as const };
    }
  });

  const succeededCount = outcomes.filter((outcome) => outcome.ok).length;
  const failedCount = outcomes.length - succeededCount;

  const remainingEligibleCount = await prisma.technicalPreparationItem.count({ where: { runId, status: "PENDING" } });
  if (remainingEligibleCount === 0) {
    await prisma.technicalPreparationRun.update({ where: { id: runId }, data: { status: "COMPLETE" } });
  }

  return {
    processedCount: pendingItems.length,
    succeededCount,
    failedCount,
    remainingEligibleCount,
    elapsedMs: Date.now() - startedAt,
  };
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

/**
 * Reads the CURRENT active preparation run's own item counts - reuses
 * getOrCreateActiveTechnicalPreparationRun so a readiness check never performs its own separate
 * quote sweep either (only the very first check of a new run does, same as Phase B).
 */
export async function getTechnicalCacheReadinessForUser(
  userId: string,
  provider: MarketDataProvider,
  now: Date = new Date(),
): Promise<TechnicalCacheReadinessStatus> {
  const { runId, eligibleCount } = await getOrCreateActiveTechnicalPreparationRun(userId, provider, now);
  if (eligibleCount === 0) {
    return { eligibleCount: 0, readyCount: 0, pendingCount: 0, lastPreparedAt: null };
  }

  const [readyCount, pendingCount, lastReady] = await Promise.all([
    prisma.technicalPreparationItem.count({ where: { runId, status: "READY" } }),
    prisma.technicalPreparationItem.count({ where: { runId, status: "PENDING" } }),
    prisma.technicalPreparationItem.findFirst({ where: { runId, status: "READY" }, orderBy: { processedAt: "desc" }, select: { processedAt: true } }),
  ]);

  return {
    eligibleCount,
    readyCount,
    pendingCount,
    lastPreparedAt: lastReady?.processedAt ?? null,
  };
}
