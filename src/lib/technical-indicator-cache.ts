import "server-only";

import { randomUUID, createHash } from "node:crypto";
import { bollingerBands, wilderRsi } from "@/domain/finance/calculations";
import { previousNyseMarketDay } from "@/domain/finance/marketCalendar";
import { mapWithConcurrency } from "./concurrency";
import { OCC_OPTIONABLE_UNIVERSE_SOURCE } from "./occ-optionable-universe-refresh";
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
 * Phase B invocations 2..N never call getQuotes again for the same run - and both models carry a
 * real database uniqueness/claiming invariant (not just application-level "find then create") so
 * two OVERLAPPING invocations can never both perform the sweep, or both process the same ticker.
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

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "P2002");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------------------------
// Latest-candle-freshness probe - a small, read-only price-history check shared by BOTH the
// manual explicit-click diagnostic (Scanner Engineering Diagnostics page) and the automatic
// daily-candle-availability gate below, so the two can never disagree about what "fresh" means.
// Lives here (not a separate module) specifically to avoid a circular import between this file
// and the gate that consumes it.
// ---------------------------------------------------------------------------------------------

/** Default probe count for both the manual diagnostic and the automatic gate - 5 is deliberately
 * small (a handful of read-only history requests, never a bulk operation). */
export const LATEST_CANDLE_FRESHNESS_DIAGNOSTIC_SYMBOL_COUNT = 5;

/** `source` is optional and, when omitted, queries the WHOLE OptionableUniverseSymbol table with
 * no filter. Real callers (the manual diagnostic action, the automatic gate below) always pass an
 * explicit `source` (defaulting to OCC_OPTIONABLE_UNIVERSE_SOURCE - real "public OCC underlyings")
 * so the probe pool is deterministic and never accidentally widened by a concurrently-running test
 * file's own differently-sourced fixture rows under Vitest's parallel-by-file execution. */
async function loadDeterministicSymbols(limit: number, source?: string): Promise<string[]> {
  const rows = await prisma.optionableUniverseSymbol.findMany({
    where: source ? { source } : undefined,
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
 * LATEST_CANDLE_FRESHNESS_DIAGNOSTIC_SYMBOL_COUNT = 5) deterministic public symbols via the
 * caller's OWN resolved provider - never a shared connection, never account/position/transaction
 * data, no DB writes. A per-symbol fetch failure is reported as `latestCandleMarketDate: null,
 * fresh: false` rather than aborting the rest. Never more than `symbolCount` history requests.
 */
export async function runLatestCandleFreshnessDiagnostic(
  provider: MarketDataProvider,
  now: Date = new Date(),
  options: { universeSource?: string; symbolCount?: number } = {},
): Promise<LatestCandleFreshnessDiagnosticResult> {
  const requiredMarketDate = dateOnlyUtc(previousNyseMarketDay(now));
  const symbols = await loadDeterministicSymbols(options.symbolCount ?? LATEST_CANDLE_FRESHNESS_DIAGNOSTIC_SYMBOL_COUNT, options.universeSource);

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

// ---------------------------------------------------------------------------------------------
// Global daily-candle-availability gate - see PROJECT_HANDOFF.md's readiness-mismatch
// investigation. Before a NEW generation begins bulk work (the ~6,071-symbol Phase A quote sweep,
// then potentially thousands of TechnicalPreparationItem rows and history requests), probe a
// handful of symbols to answer one cheap question first: "has the provider published the
// required completed daily candle yet AT ALL, globally?" If not, skip Phase A and item creation
// entirely rather than creating thousands of DEFERRED rows that will all just retry the same real
// cause. This directly reuses runLatestCandleFreshnessDiagnostic - the manual diagnostic and this
// automatic gate can never disagree about what "fresh" means, by construction.
// ---------------------------------------------------------------------------------------------

/** How many successful (non-SYMBOL_UNAVAILABLE) probes are required before the gate will make a
 * READY/NOT_READY determination at all - deliberately small (3 of 5) so one or two permanently-
 * delisted/unavailable probe tickers can never single-handedly force a false NOT_READY forever.
 * Scaled down to the ACTUAL probe pool size when fewer than GATE_PROBE_SYMBOL_COUNT symbols exist
 * at all (e.g. an empty/tiny OptionableUniverseSymbol table) - with nothing meaningful to probe,
 * there is also nothing meaningful to gate, so the gate is vacuously READY rather than
 * permanently blocking a user who has no real universe yet. */
const GATE_MIN_SUCCESSFUL_PROBES = 3;

export type DailyCandleAvailabilityGateResult =
  | { ready: true }
  | {
      ready: false;
      requiredMarketDate: Date;
      freshProbeCount: number;
      staleProbeCount: number;
      unavailableProbeCount: number;
    };

/**
 * Runs the shared 5-symbol probe (never more than LATEST_CANDLE_FRESHNESS_DIAGNOSTIC_SYMBOL_COUNT
 * history requests) and applies a conservative decision rule: ready only if at least
 * min(GATE_MIN_SUCCESSFUL_PROBES, probed count) symbols returned real data AND every one of them
 * is fresh. A single SYMBOL_UNAVAILABLE probe (the ticker's own history is genuinely absent,
 * unrelated to daily-candle timing) is tracked separately from a stale one and never counted
 * against readiness on its own - see GATE_MIN_SUCCESSFUL_PROBES. `probeUniverseSource` defaults to
 * OCC_OPTIONABLE_UNIVERSE_SOURCE (real "public OCC underlyings," per spec) - overridable so tests
 * can scope the probe to their own deterministic fixture pool instead of the live table (which,
 * under Vitest's parallel-by-file execution, holds many concurrently-running test files' own
 * rows).
 */
export async function checkDailyCandleAvailabilityGate(
  provider: MarketDataProvider,
  now: Date,
  options: { probeUniverseSource?: string } = {},
): Promise<DailyCandleAvailabilityGateResult> {
  const diagnostic = await runLatestCandleFreshnessDiagnostic(provider, now, {
    symbolCount: LATEST_CANDLE_FRESHNESS_DIAGNOSTIC_SYMBOL_COUNT,
    universeSource: options.probeUniverseSource ?? OCC_OPTIONABLE_UNIVERSE_SOURCE,
  });

  let freshProbeCount = 0;
  let staleProbeCount = 0;
  let unavailableProbeCount = 0;
  for (const row of diagnostic.rows) {
    if (row.latestCandleMarketDate === null) {
      unavailableProbeCount += 1;
    } else if (row.fresh) {
      freshProbeCount += 1;
    } else {
      staleProbeCount += 1;
    }
  }

  const successfulProbeCount = freshProbeCount + staleProbeCount;
  const requiredSuccessfulProbes = Math.min(GATE_MIN_SUCCESSFUL_PROBES, diagnostic.rows.length);
  const ready = successfulProbeCount >= requiredSuccessfulProbes && staleProbeCount === 0;

  if (ready) {
    return { ready: true };
  }
  return {
    ready: false,
    requiredMarketDate: dateOnlyUtc(previousNyseMarketDay(now)),
    freshProbeCount,
    staleProbeCount,
    unavailableProbeCount,
  };
}

// ---------------------------------------------------------------------------------------------
// Persisted preparation run/queue - so Phase A runs once per cycle, not once per Phase B batch,
// and never twice under overlapping invocations.
// ---------------------------------------------------------------------------------------------

export type ActiveTechnicalPreparationRun = {
  runId: string;
  eligibleCount: number;
  /** True only when THIS call performed the real quote sweep (a brand new run was created) -
   * false when an existing, still-valid run was reused (including one that a concurrent caller
   * won the race to create). Exposed mainly for tests/observability. */
  freshlyCreated: boolean;
};

export type GetOrCreateTechnicalPreparationRunResult =
  | ({ status: "OK" } & ActiveTechnicalPreparationRun)
  | {
      /** The global daily-candle-availability gate (see checkDailyCandleAvailabilityGate) was not
       * ready when a NEW run would otherwise have been created - no run, no items, no Phase A
       * quote sweep were performed. Cost: at most LATEST_CANDLE_FRESHNESS_DIAGNOSTIC_SYMBOL_COUNT
       * (5) price-history requests, never the ~6,071-symbol sweep or bulk item creation. */
      status: "DAILY_CANDLE_NOT_READY";
      requiredMarketDate: Date;
      freshProbeCount: number;
      staleProbeCount: number;
      unavailableProbeCount: number;
    };

/** Bounded wait for a concurrent caller's in-flight run creation to finish - polling, not
 * blocking, and not a distributed lock: cheap DB reads only, no HTTP calls happen in this loop.
 * 100ms x 300 = 30s ceiling, comfortably longer than any real quote sweep observed in production
 * (a handful of seconds), short enough to fail loud rather than hang if the winner's process
 * genuinely died mid-sweep (see the failure-cleanup path below, which frees the row for retry). */
const RUN_CREATION_POLL_INTERVAL_MS = 100;
const RUN_CREATION_POLL_MAX_ATTEMPTS = 300;

async function waitForConcurrentRunCreation(runId: string): Promise<ActiveTechnicalPreparationRun> {
  for (let attempt = 0; attempt < RUN_CREATION_POLL_MAX_ATTEMPTS; attempt += 1) {
    const run = await prisma.technicalPreparationRun.findUnique({ where: { id: runId } });
    if (!run) {
      // The winner's attempt failed and cleaned up after itself (see the create-then-delete-on-
      // failure path) - nothing left to wait for. The caller can retry from scratch.
      throw new Error("A concurrent technical preparation run creation failed - retry.");
    }
    if (run.eligibleCount !== null) {
      return { runId: run.id, eligibleCount: run.eligibleCount, freshlyCreated: false };
    }
    await sleep(RUN_CREATION_POLL_INTERVAL_MS);
  }
  throw new Error("Timed out waiting for a concurrent technical preparation run to finish being created.");
}

/**
 * Returns the current user's active TechnicalPreparationRun for (marketDate, rulesFingerprint),
 * creating one - and doing the one real Phase A quote sweep - only if no matching run already
 * exists AND the global daily-candle-availability gate (checkDailyCandleAvailabilityGate) reports
 * ready. This is the ONLY place a new run is created, and therefore the ONLY place
 * getEligibleTechnicalRefreshTickersForUser (and its Schwab quote sweep) is ever called from the
 * rest of this module.
 *
 * Concurrency-safe by construction, not merely by convention: `(userId, marketDate,
 * rulesFingerprint)` is a REAL database unique constraint (see TechnicalPreparationRun's own
 * schema doc comment). Two overlapping calls both finding "no existing run" will both attempt
 * `create()`; Postgres accepts exactly one and rejects the other with a unique-constraint error
 * (P2002) - the loser never performs its own quote sweep, it instead polls
 * (waitForConcurrentRunCreation) for the winner's sweep to finish and returns that result. A
 * winner whose sweep or item-creation throws deletes its own placeholder row before rethrowing,
 * so the unique constraint is freed for a clean future retry rather than left permanently broken.
 * The gate check runs BEFORE either racer attempts `create()` - a redundant duplicate probe under
 * a genuine race is cheap (at most 5 extra history requests) and does not affect the create-race
 * invariant above at all.
 *
 * At creation time, each eligible ticker's TechnicalPreparationItem starts PENDING unless its
 * existing TechnicalIndicatorSnapshot is already READY and fresh (asOfDate >=
 * previousNyseMarketDay(now)) - in which case the item starts already READY, so Phase B never
 * wastes a history request re-fetching data that's already current. A ticker whose existing
 * snapshot is FAILED, stale, or missing always starts PENDING.
 *
 * If the quote sweep itself throws (e.g. a Schwab outage), no run/items survive and this
 * rethrows - the existing TechnicalIndicatorSnapshot cache is completely untouched, exactly like
 * a failed OCC/earnings refresh never destroys the prior valid cache.
 */
export async function getOrCreateActiveTechnicalPreparationRun(
  userId: string,
  provider: MarketDataProvider,
  now: Date = new Date(),
  options: { probeUniverseSource?: string } = {},
): Promise<GetOrCreateTechnicalPreparationRunResult> {
  const rules = await loadUserQuoteStageRules(userId);
  const fingerprint = computeQuoteStageRulesFingerprint(rules);
  const marketDate = dateOnlyUtc(now);
  const identity = { userId_marketDate_rulesFingerprint: { userId, marketDate, rulesFingerprint: fingerprint } };

  // status is deliberately NOT part of this lookup or the unique constraint it relies on. A
  // COMPLETE run is still the valid, current run for today's rules; excluding it here would make
  // every call after the run finishes re-trigger a whole new quote sweep just to discover
  // "there's nothing left to do," defeating the entire point of this persistence layer.
  const existing = await prisma.technicalPreparationRun.findUnique({ where: identity });
  if (existing) {
    if (existing.eligibleCount === null) {
      const result = await waitForConcurrentRunCreation(existing.id); // someone else is still creating it
      return { status: "OK", ...result };
    }
    return { status: "OK", runId: existing.id, eligibleCount: existing.eligibleCount, freshlyCreated: false };
  }

  // No existing run for this identity - before spending a real Phase A quote sweep (and
  // potentially creating thousands of TechnicalPreparationItem rows), cheaply probe whether the
  // provider has published the required daily candle AT ALL yet (see the module-level doc comment
  // above checkDailyCandleAvailabilityGate). A run/placeholder is never created while not ready.
  const gate = await checkDailyCandleAvailabilityGate(provider, now, { probeUniverseSource: options.probeUniverseSource });
  if (!gate.ready) {
    return {
      status: "DAILY_CANDLE_NOT_READY",
      requiredMarketDate: gate.requiredMarketDate,
      freshProbeCount: gate.freshProbeCount,
      staleProbeCount: gate.staleProbeCount,
      unavailableProbeCount: gate.unavailableProbeCount,
    };
  }

  // Claim the right to create this run. eligibleCount starts NULL - a concurrent loser reading
  // this placeholder knows creation is still in flight, not that the sweep found zero symbols.
  let placeholder: { id: string };
  try {
    placeholder = await prisma.technicalPreparationRun.create({
      data: { userId, marketDate, rulesFingerprint: fingerprint, eligibleCount: null, status: "IN_PROGRESS" },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const theirs = await prisma.technicalPreparationRun.findUnique({ where: identity });
      if (!theirs) {
        throw new Error("A concurrent technical preparation run creation failed - retry.");
      }
      if (theirs.eligibleCount === null) {
        const result = await waitForConcurrentRunCreation(theirs.id);
        return { status: "OK", ...result };
      }
      return { status: "OK", runId: theirs.id, eligibleCount: theirs.eligibleCount, freshlyCreated: false };
    }
    throw error;
  }

  // We won the race - perform the one real quote sweep for this cycle.
  try {
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

    if (initialStatuses.length) {
      await prisma.technicalPreparationItem.createMany({
        data: initialStatuses.map((item) => ({
          runId: placeholder.id,
          ticker: item.ticker,
          priority: item.priority,
          status: item.initialStatus,
          processedAt: item.initialStatus === "READY" ? now : null,
        })),
      });
    }
    await prisma.technicalPreparationRun.update({
      where: { id: placeholder.id },
      data: { eligibleCount: eligible.length, status: pendingCount > 0 ? "IN_PROGRESS" : "COMPLETE" },
    });

    return { status: "OK", runId: placeholder.id, eligibleCount: eligible.length, freshlyCreated: true };
  } catch (error) {
    // Free the unique constraint for a clean future retry - never leave a permanently-NULL
    // placeholder that every future call (and every waiting concurrent loser) would hang on.
    await prisma.technicalPreparationRun.delete({ where: { id: placeholder.id } }).catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Phase B: bounded, resumable, claim-based background history refresh.
// ---------------------------------------------------------------------------------------------

/** Conservative default per invocation - Schwab's safe sustained price-history throughput has
 * NOT been measured (only the quote batch size has been verified). Deliberately small rather
 * than guessed large; adjust only after a real, bounded throughput measurement. Preserved exactly
 * per real production evidence (25 @ concurrency 4, ~13-14s, 0 failures). */
export const TECHNICAL_REFRESH_BATCH_SIZE = 25;

/** Same conservative bound already used for the live scanner's own history fetching
 * (SCAN_FETCH_CONCURRENCY) - reused rather than inventing a second concurrency constant.
 * Preserved exactly per real production evidence. */
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

/** How long a PROCESSING claim is honored before it's considered abandoned (the worker that
 * claimed it crashed/died mid-batch) and safe to return to PENDING for a future claim. A real
 * 25-item batch at concurrency 4 completes in ~13-14s in production - 5 minutes is a deliberately
 * generous multiple of that (over 20x), so an actively-running worker's claim is never mistakenly
 * reclaimed out from under it, while a genuinely dead worker's rows don't stay stuck forever. */
export const PROCESSING_CLAIM_TIMEOUT_MS = 5 * 60 * 1000;

/** How long a DEFERRED item (this ONE ticker's own provider candle exists but is older than the
 * run's required market date, despite the global daily-candle-availability gate having already
 * passed - see checkDailyCandleAvailabilityGate) waits before it becomes reclaimable again -
 * deliberately NOT immediate, so a scheduled cron ticking every 5 minutes doesn't hammer the same
 * lagged ticker on every single tick. */
export const DEFERRED_RETRY_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/** Bounded retry cap for a DEFERRED item - after this many lagged-candle attempts, the item
 * becomes FAILED (terminal, exactly like a genuine history-fetch failure) rather than retrying
 * forever.
 *
 * Deliberately small (3 attempts x 15 minutes = 45 minutes of real retry span). This constant
 * used to also be the system's ONLY defense against a GLOBAL provider-timing issue (the real Sep
 * 8 incident, where the provider hadn't published ANY ticker's daily candle yet) - that role has
 * moved to checkDailyCandleAvailabilityGate, which now stops bulk work entirely before it starts
 * in that scenario. DEFERRED is reserved for the genuinely rare case where the gate's own 5-symbol
 * probe passed (most of the universe IS current) but one ISOLATED ticker's own history still
 * happens to lag - a per-symbol anomaly, not a systemic one, so a small bounded retry is
 * appropriate rather than the large multi-hour budget a global-outage assumption would need. */
export const MAX_DEFERRED_ATTEMPTS = 3;

export type TechnicalRefreshBatchResult =
  | {
      status: "OK";
      processedCount: number;
      succeededCount: number;
      /** Items whose provider candle existed but was older than the run's required market date,
       * and have not yet exhausted MAX_DEFERRED_ATTEMPTS - not counted in failedCount (not a
       * failure). After the global gate fix, this should only ever reflect rare, isolated
       * per-symbol anomalies - a systemic provider-timing issue is now caught by
       * checkDailyCandleAvailabilityGate before any items are even created. */
      deferredCount: number;
      failedCount: number;
      /** PENDING + PROCESSING + DEFERRED items remaining in the active run after this batch (i.e.
       * work not yet finished OR still waiting on a retryable deferred candle) - 0 means the run
       * just completed. Lets a caller decide whether to invoke again. */
      remainingEligibleCount: number;
      /** Real wall-clock time for this ENTIRE invocation, in milliseconds - on every call except
       * the one that creates a new run, this reflects ONLY Phase B (claim + history fetch +
       * RSI/BB), since no quote sweep happens. The aggregate cost a caller needs to estimate how
       * many worker invocations a full preparation cycle would take. Never a raw per-request
       * timing breakdown, no raw provider response, no token - just one aggregate number. */
      elapsedMs: number;
    }
  | {
      /** The global daily-candle-availability gate was not ready - no run/items were created and
       * no bulk work was attempted this call. See GetOrCreateTechnicalPreparationRunResult. */
      status: "DAILY_CANDLE_NOT_READY";
      requiredMarketDate: Date;
      freshProbeCount: number;
      staleProbeCount: number;
      unavailableProbeCount: number;
      elapsedMs: number;
    };

/**
 * Atomically claims up to `batchSize` PENDING (or retryable DEFERRED) items for this run and marks
 * them PROCESSING under `claimToken` - a single `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE
 * SKIP LOCKED)` statement, the standard Postgres claim-queue pattern. Two overlapping claims
 * against the same run are guaranteed disjoint by Postgres itself: the second claim's row-lock
 * attempt SKIPS whatever the first has already locked rather than blocking or double-claiming, so
 * it can never return more than what's genuinely claimable, and never the same ticker as the other
 * invocation. A DEFERRED item whose `retryAfter` hasn't passed yet is excluded from the WHERE
 * clause entirely - it is never reclaimed early, and its exclusion naturally lets the query fall
 * through to the next PENDING/retryable ticker in priority/ticker order, so a block of tickers
 * still waiting out their retry delay can never starve the rest of the queue. This is the ONLY
 * database work in this claim step - no Schwab HTTP call happens until after it commits, and no
 * explicit transaction wrapper is used or needed (a single statement is already atomic).
 */
async function claimNextPendingItems(
  runId: string,
  batchSize: number,
  claimToken: string,
  now: Date,
): Promise<{ id: string; ticker: string; priority: number; deferredAttempts: number }[]> {
  return prisma.$queryRaw<{ id: string; ticker: string; priority: number; deferredAttempts: number }[]>`
    UPDATE "TechnicalPreparationItem"
    SET "status" = 'PROCESSING', "claimToken" = ${claimToken}, "claimedAt" = ${now}
    WHERE "id" IN (
      SELECT "id" FROM "TechnicalPreparationItem"
      WHERE "runId" = ${runId}
        AND ("status" = 'PENDING' OR ("status" = 'DEFERRED' AND "retryAfter" <= ${now}))
      ORDER BY "priority" ASC, "ticker" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "ticker", "priority", "deferredAttempts"
  `;
}

/** Returns any PROCESSING item whose claim is older than PROCESSING_CLAIM_TIMEOUT_MS back to
 * PENDING (clearing its claim metadata) - run once, before claiming new work, so an abandoned
 * claim from a dead worker is eventually retried rather than stuck forever. A still-actively-
 * claimed row (claimedAt within the timeout) is never touched, even if this function runs many
 * times while that worker is still genuinely in flight. */
async function recoverAbandonedClaims(runId: string, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - PROCESSING_CLAIM_TIMEOUT_MS);
  await prisma.technicalPreparationItem.updateMany({
    where: { runId, status: "PROCESSING", claimedAt: { lt: cutoff } },
    data: { status: "PENDING", claimToken: null, claimedAt: null },
  });
}

type ItemOutcome = { outcome: "READY" | "DEFERRED" | "DEFERRED_EXHAUSTED" | "FAILED" };

/**
 * Phase B: claims and processes at most `batchSize` PENDING (or retryable DEFERRED) items from
 * this user's ACTIVE preparation run - never all ~2,000+ eligible symbols in one call (no
 * long-running single request), and never a fresh Schwab quote sweep unless
 * getOrCreateActiveTechnicalPreparationRun determines one is genuinely needed. Safely repeatable
 * AND safe under real overlapping invocations: claiming is atomic (see claimNextPendingItems) so
 * two simultaneous calls always receive disjoint symbol sets, never the same ticker twice.
 *
 * A history-fetch call that returns NO usable candle at all is a genuine, immediately-terminal
 * FAILED (existing behavior, isolated per-ticker via try/catch - never poisons the batch).
 *
 * A history-fetch call that DOES return real candles, but whose latest one is older than THIS
 * run's own required market date (`previousNyseMarketDay(now)`, the exact same freshness rule the
 * live scan itself uses via getTechnicalIndicatorSnapshotsForUser) is NOT marked READY - the
 * provider simply hasn't posted the just-closed session's own daily candle yet (see
 * PROJECT_HANDOFF.md's readiness-mismatch investigation). It is marked DEFERRED and becomes
 * reclaimable again after DEFERRED_RETRY_INTERVAL_MS, up to MAX_DEFERRED_ATTEMPTS before becoming
 * FAILED (terminal, same as a genuine fetch failure - never an unbounded retry loop). A lagged
 * fetch NEVER regresses an existing TechnicalIndicatorSnapshot to an older asOfDate than it
 * already had - the write only happens if the newly-fetched candle is at least as new as whatever
 * is already stored, exactly mirroring the existing "a failed refresh never destroys yesterday's
 * valid cache" pattern.
 *
 * FAILED (whether from a genuine fetch failure or exhausted deferral) is terminal for this
 * run/generation - a future run (new day, or a rule change) gives every ticker, including
 * previously-FAILED ones, a fresh PENDING item and another real attempt.
 */
export async function refreshTechnicalIndicatorCacheBatchForUser(
  userId: string,
  provider: MarketDataProvider,
  options: { batchSize?: number; now?: Date; probeUniverseSource?: string } = {},
): Promise<TechnicalRefreshBatchResult> {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? TECHNICAL_REFRESH_BATCH_SIZE;
  const claimToken = randomUUID(); // a random, non-secret, per-invocation identifier - never a credential

  const runResult = await getOrCreateActiveTechnicalPreparationRun(userId, provider, now, { probeUniverseSource: options.probeUniverseSource });
  if (runResult.status === "DAILY_CANDLE_NOT_READY") {
    return {
      status: "DAILY_CANDLE_NOT_READY",
      requiredMarketDate: runResult.requiredMarketDate,
      freshProbeCount: runResult.freshProbeCount,
      staleProbeCount: runResult.staleProbeCount,
      unavailableProbeCount: runResult.unavailableProbeCount,
      elapsedMs: Date.now() - startedAt,
    };
  }
  const { runId } = runResult;

  await recoverAbandonedClaims(runId, now);
  const claimedItems = await claimNextPendingItems(runId, batchSize, claimToken, now);

  // The live scan's own freshness cutoff, computed once for this whole batch - a candle must be
  // at least this new to be marked READY. Never derived from invocation time alone; always via
  // the same canonical previousNyseMarketDay helper the live scan itself uses.
  const requiredMarketDate = dateOnlyUtc(previousNyseMarketDay(now));

  const existingSnapshots = claimedItems.length
    ? await prisma.technicalIndicatorSnapshot.findMany({
        where: { userId, ticker: { in: claimedItems.map((item) => item.ticker) } },
        select: { ticker: true, asOfDate: true },
      })
    : [];
  const existingAsOfByTicker = new Map(existingSnapshots.map((row) => [row.ticker, row.asOfDate]));

  const outcomes: ItemOutcome[] = await mapWithConcurrency(claimedItems, TECHNICAL_REFRESH_CONCURRENCY, async (item) => {
    try {
      const candles = await provider.getPriceHistory(item.ticker, TECHNICAL_REFRESH_HISTORY_DAYS);
      const latestCandleDate = candles.at(-1)?.date ? dateOnlyUtc(candles.at(-1)!.date) : null;

      if (!latestCandleDate) {
        // No usable candle at all - a genuine data-unavailable failure, not a lag.
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
        await prisma.technicalPreparationItem.update({
          where: { id: item.id },
          data: { status: "FAILED", processedAt: now, retryAfter: null },
        });
        return { outcome: "FAILED" as const };
      }

      const existingAsOfDate = existingAsOfByTicker.get(item.ticker) ?? null;
      const improvesOnExisting = !existingAsOfDate || latestCandleDate.getTime() > existingAsOfDate.getTime();
      const isFreshEnough = latestCandleDate.getTime() >= requiredMarketDate.getTime();

      if (improvesOnExisting) {
        // Honest write either way - if not fresh enough, the read path
        // (getTechnicalIndicatorSnapshotsForUser) already correctly reports this as
        // TECHNICAL_DATA_STALE on its own via the identical freshness rule. Never regresses an
        // existing snapshot to an OLDER asOfDate than it already had.
        const closes = candles.map((candle) => candle.close);
        const rsi = wilderRsi(closes);
        const bands = bollingerBands(closes);
        await upsertSnapshot(userId, item.ticker, {
          status: "READY",
          asOfDate: latestCandleDate,
          rsi,
          bbLower: bands?.lower ?? null,
          bbMiddle: bands?.middle ?? null,
          bbUpper: bands?.upper ?? null,
          failureReason: null,
          historyFetchedAt: now,
          now,
        });
      }

      if (isFreshEnough) {
        await prisma.technicalPreparationItem.update({
          where: { id: item.id },
          data: { status: "READY", processedAt: now, retryAfter: null },
        });
        return { outcome: "READY" as const };
      }

      // Lagged - the provider's latest candle is genuinely older than what this run requires.
      const deferredAttempts = item.deferredAttempts + 1;
      if (deferredAttempts >= MAX_DEFERRED_ATTEMPTS) {
        await prisma.technicalPreparationItem.update({
          where: { id: item.id },
          data: { status: "FAILED", processedAt: now, deferredAttempts, retryAfter: null },
        });
        return { outcome: "DEFERRED_EXHAUSTED" as const };
      }
      await prisma.technicalPreparationItem.update({
        where: { id: item.id },
        data: {
          status: "DEFERRED",
          processedAt: null,
          deferredAttempts,
          retryAfter: new Date(now.getTime() + DEFERRED_RETRY_INTERVAL_MS),
          claimToken: null,
          claimedAt: null,
        },
      });
      return { outcome: "DEFERRED" as const };
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
      await prisma.technicalPreparationItem.update({
        where: { id: item.id },
        data: { status: "FAILED", processedAt: now, retryAfter: null },
      });
      return { outcome: "FAILED" as const };
    }
  });

  const succeededCount = outcomes.filter((o) => o.outcome === "READY").length;
  const deferredCount = outcomes.filter((o) => o.outcome === "DEFERRED").length;
  const failedCount = outcomes.filter((o) => o.outcome === "FAILED" || o.outcome === "DEFERRED_EXHAUSTED").length;

  // COMPLETE requires zero PENDING, PROCESSING, and DEFERRED - never declared while another
  // worker still owns claimed-but-unfinished rows, or while a deferred item still has a real
  // retry attempt left.
  const remainingEligibleCount = await prisma.technicalPreparationItem.count({
    where: { runId, status: { in: ["PENDING", "PROCESSING", "DEFERRED"] } },
  });
  if (remainingEligibleCount === 0) {
    await prisma.technicalPreparationRun.update({ where: { id: runId }, data: { status: "COMPLETE" } });
  }

  return {
    status: "OK",
    processedCount: claimedItems.length,
    succeededCount,
    deferredCount,
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

export function dateOnlyUtc(date: Date): Date {
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

export type TechnicalCacheReadinessStatus =
  | {
      status: "OK";
      eligibleCount: number;
      /** Item status = READY. After the immediate-stale-candle fix, an item can ONLY become READY
       * when its fetched candle was fresh enough for the live scan's own required market date at
       * write time (see refreshTechnicalIndicatorCacheBatchForUser) - so this now directly means
       * "fresh and usable right now," not merely "the worker attempted this ticker once." */
      readyCount: number;
      /** PENDING + PROCESSING only - never claimed/attempted yet, or actively being fetched right now. */
      pendingCount: number;
      /** This ONE ticker's own candle exists but is older than what's required, despite the
       * global gate having already passed - a rare, isolated per-symbol anomaly, waiting on
       * DEFERRED_RETRY_INTERVAL_MS before another attempt, not a failure. */
      deferredCount: number;
      /** Genuine history-fetch failure, or a DEFERRED item that exhausted MAX_DEFERRED_ATTEMPTS. */
      failedCount: number;
      lastPreparedAt: Date | null;
    }
  | {
      /** The global daily-candle-availability gate was not ready - no run/items exist yet this
       * cycle. See GetOrCreateTechnicalPreparationRunResult. */
      status: "DAILY_CANDLE_NOT_READY";
      requiredMarketDate: Date;
      freshProbeCount: number;
      staleProbeCount: number;
      unavailableProbeCount: number;
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
  options: { probeUniverseSource?: string } = {},
): Promise<TechnicalCacheReadinessStatus> {
  const runResult = await getOrCreateActiveTechnicalPreparationRun(userId, provider, now, { probeUniverseSource: options.probeUniverseSource });
  if (runResult.status === "DAILY_CANDLE_NOT_READY") {
    return {
      status: "DAILY_CANDLE_NOT_READY",
      requiredMarketDate: runResult.requiredMarketDate,
      freshProbeCount: runResult.freshProbeCount,
      staleProbeCount: runResult.staleProbeCount,
      unavailableProbeCount: runResult.unavailableProbeCount,
    };
  }
  const { runId, eligibleCount } = runResult;
  if (eligibleCount === 0) {
    return { status: "OK", eligibleCount: 0, readyCount: 0, pendingCount: 0, deferredCount: 0, failedCount: 0, lastPreparedAt: null };
  }

  const [readyCount, pendingCount, deferredCount, failedCount, lastReady] = await Promise.all([
    prisma.technicalPreparationItem.count({ where: { runId, status: "READY" } }),
    prisma.technicalPreparationItem.count({ where: { runId, status: { in: ["PENDING", "PROCESSING"] } } }),
    prisma.technicalPreparationItem.count({ where: { runId, status: "DEFERRED" } }),
    prisma.technicalPreparationItem.count({ where: { runId, status: "FAILED" } }),
    prisma.technicalPreparationItem.findFirst({ where: { runId, status: "READY" }, orderBy: { processedAt: "desc" }, select: { processedAt: true } }),
  ]);

  return {
    status: "OK",
    eligibleCount,
    readyCount,
    pendingCount,
    deferredCount,
    failedCount,
    lastPreparedAt: lastReady?.processedAt ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// Freshness breakdown - answers "of the items marked READY, how many are actually USABLE right
// now by the live scan's own freshness rule" (see PROJECT_HANDOFF.md's readiness-vs-live-scan
// investigation). TechnicalPreparationItem.status=READY is a pure workflow-completion flag (see
// getTechnicalCacheReadinessForUser above) that is never re-validated for asOfDate freshness once
// set - this function is the one place that cross-checks it against the EXACT SAME freshness rule
// getTechnicalIndicatorSnapshotsForUser (the live scan's own read path) uses, so the diagnostic and
// the scanner can never disagree about what "fresh" means. Deliberately takes no MarketDataProvider
// and performs no getOrCreate/quote-sweep - a plain read of whatever run already exists (or
// honestly reports none exists yet) - so this is always safe to call from a diagnostic page with
// zero Schwab spend, per explicit instruction.
// ---------------------------------------------------------------------------------------------

export type TechnicalCacheFreshnessBreakdown = {
  hasActiveRun: boolean;
  eligibleCount: number;
  /** TechnicalPreparationItem.status=READY count - identical to getTechnicalCacheReadinessForUser's
   * own readyCount, included here so a caller never needs to reconcile two separate numbers. */
  workflowReadyCount: number;
  /** Of the workflow-ready items, how many have a TechnicalIndicatorSnapshot whose asOfDate is >=
   * the live scan's own required market date right now - i.e. would actually be used (not treated
   * as stale) if a live scan ran this instant. */
  freshUsableCount: number;
  /** Workflow-ready items whose snapshot exists but whose asOfDate is older than the required
   * market date (or null) - marked READY, but the live scan would refuse to trust them. */
  staleSnapshotCount: number;
  /** Workflow-ready items whose snapshot's own status is FAILED, despite the workflow item itself
   * reading READY - should not normally happen (see technical-indicator-cache's own write path)
   * but reported honestly rather than assumed impossible. */
  failedSnapshotCount: number;
  /** Workflow-ready items with NO TechnicalIndicatorSnapshot row at all - should not normally
   * happen, reported honestly rather than assumed impossible. */
  missingSnapshotCount: number;
  pendingCount: number;
  /** Items whose provider candle exists but was older than the required market date, still
   * within their retry budget - not counted in workflowReadyCount, and not a failure. */
  deferredCount: number;
  /** The live scan's own required market date right now (previousNyseMarketDay(now),
   * date-only) - the exact cutoff freshUsableCount/staleSnapshotCount are computed against. */
  requiredMarketDate: Date;
  /** Newest asOfDate among this run's workflow-ready items' snapshots, or null if none have one. */
  newestSnapshotMarketDate: Date | null;
  /** Oldest asOfDate among only the FRESH (usable) workflow-ready snapshots, or null if none are
   * fresh - deliberately excludes stale ones so this reads as "how far back does usable data go,"
   * not diluted by known-stale rows. */
  oldestFreshSnapshotMarketDate: Date | null;
};

/**
 * DB-only diagnostic breakdown of the current active preparation run's READY items, cross-checked
 * against the live scan's own freshness rule. Requires no Schwab call - if no run exists yet for
 * today's (marketDate, rulesFingerprint) identity, returns hasActiveRun: false with zero counts
 * rather than creating one (unlike getTechnicalCacheReadinessForUser/getOrCreateActiveTechnicalPreparationRun,
 * which are allowed to trigger a real quote sweep on first use).
 */
export async function getTechnicalCacheFreshnessBreakdownForUser(userId: string, now: Date = new Date()): Promise<TechnicalCacheFreshnessBreakdown> {
  const requiredMarketDate = dateOnlyUtc(previousNyseMarketDay(now));
  const rules = await loadUserQuoteStageRules(userId);
  const fingerprint = computeQuoteStageRulesFingerprint(rules);
  const marketDate = dateOnlyUtc(now);

  const run = await prisma.technicalPreparationRun.findUnique({
    where: { userId_marketDate_rulesFingerprint: { userId, marketDate, rulesFingerprint: fingerprint } },
  });
  if (!run || run.eligibleCount === null) {
    return {
      hasActiveRun: false,
      eligibleCount: 0,
      workflowReadyCount: 0,
      freshUsableCount: 0,
      staleSnapshotCount: 0,
      failedSnapshotCount: 0,
      missingSnapshotCount: 0,
      pendingCount: 0,
      deferredCount: 0,
      requiredMarketDate,
      newestSnapshotMarketDate: null,
      oldestFreshSnapshotMarketDate: null,
    };
  }

  const [readyItems, pendingCount, deferredCount] = await Promise.all([
    prisma.technicalPreparationItem.findMany({ where: { runId: run.id, status: "READY" }, select: { ticker: true } }),
    prisma.technicalPreparationItem.count({ where: { runId: run.id, status: { in: ["PENDING", "PROCESSING"] } } }),
    prisma.technicalPreparationItem.count({ where: { runId: run.id, status: "DEFERRED" } }),
  ]);

  const readyTickers = readyItems.map((item) => item.ticker);
  const snapshots = readyTickers.length
    ? await prisma.technicalIndicatorSnapshot.findMany({
        where: { userId, ticker: { in: readyTickers } },
        select: { ticker: true, status: true, asOfDate: true },
      })
    : [];
  const snapshotByTicker = new Map(snapshots.map((row) => [row.ticker, row]));

  let freshUsableCount = 0;
  let staleSnapshotCount = 0;
  let failedSnapshotCount = 0;
  let missingSnapshotCount = 0;
  let newestSnapshotMarketDate: Date | null = null;
  let oldestFreshSnapshotMarketDate: Date | null = null;

  for (const ticker of readyTickers) {
    const snapshot = snapshotByTicker.get(ticker);
    if (!snapshot) {
      missingSnapshotCount += 1;
      continue;
    }
    if (snapshot.status === "FAILED") {
      failedSnapshotCount += 1;
      continue;
    }
    if (snapshot.asOfDate && (!newestSnapshotMarketDate || snapshot.asOfDate.getTime() > newestSnapshotMarketDate.getTime())) {
      newestSnapshotMarketDate = snapshot.asOfDate;
    }
    const isFresh = !!snapshot.asOfDate && snapshot.asOfDate.getTime() >= requiredMarketDate.getTime();
    if (isFresh) {
      freshUsableCount += 1;
      if (snapshot.asOfDate && (!oldestFreshSnapshotMarketDate || snapshot.asOfDate.getTime() < oldestFreshSnapshotMarketDate.getTime())) {
        oldestFreshSnapshotMarketDate = snapshot.asOfDate;
      }
    } else {
      staleSnapshotCount += 1;
    }
  }

  return {
    hasActiveRun: true,
    eligibleCount: run.eligibleCount,
    workflowReadyCount: readyTickers.length,
    freshUsableCount,
    staleSnapshotCount,
    failedSnapshotCount,
    missingSnapshotCount,
    pendingCount,
    deferredCount,
    requiredMarketDate,
    newestSnapshotMarketDate,
    oldestFreshSnapshotMarketDate,
  };
}

// ---------------------------------------------------------------------------------------------
// Orchestration support - cheap, DB-only status reads for technical-preparation-orchestrator.ts.
// Deliberately never touches a provider or does a quote sweep itself - only
// getOrCreateActiveTechnicalPreparationRun (already above) is allowed to do that.
// ---------------------------------------------------------------------------------------------

export type TechnicalPreparationStatusForUser = {
  hasRunForToday: boolean;
  isComplete: boolean;
  /** The run's own `updatedAt` if one exists for today's (marketDate, rulesFingerprint) identity,
   * else null - lets a caller order multiple users by "least recently touched" (null sorts first,
   * i.e. a user who hasn't been started at all today takes priority) without needing any separate
   * scheduler-state table. */
  lastTouchedAt: Date | null;
};

/**
 * Read-only, zero-provider-call check of whether THIS user's technical preparation for today
 * (their current rules fingerprint) exists and is complete - used by the orchestrator to cheaply
 * decide which of several connected users most needs a real (Schwab-calling) cycle, without
 * spending any provider work on users who don't.
 */
export async function getTechnicalPreparationStatusForUser(userId: string, now: Date = new Date()): Promise<TechnicalPreparationStatusForUser> {
  const rules = await loadUserQuoteStageRules(userId);
  const fingerprint = computeQuoteStageRulesFingerprint(rules);
  const marketDate = dateOnlyUtc(now);

  const run = await prisma.technicalPreparationRun.findUnique({
    where: { userId_marketDate_rulesFingerprint: { userId, marketDate, rulesFingerprint: fingerprint } },
  });
  if (!run) {
    return { hasRunForToday: false, isComplete: false, lastTouchedAt: null };
  }
  return { hasRunForToday: true, isComplete: run.status === "COMPLETE", lastTouchedAt: run.updatedAt };
}
