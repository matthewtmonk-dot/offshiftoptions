import "server-only";

import { prisma } from "./prisma";
import {
  reserveAlphaVantageCall,
  tryAcquireAlphaVantageRunLock,
  releaseAlphaVantageRunLock,
  getAlphaVantageUsageToday,
  type AlphaVantageUsageSnapshot,
} from "./alpha-vantage-budget";
import { getAlphaVantageApiKey } from "@/providers/alpha-vantage/config";
import {
  ALPHA_VANTAGE_REQUEST_DELAY_MS,
} from "@/providers/alpha-vantage/overview-diagnostic";
import { fetchAlphaVantageOverviewForTicker, type AlphaVantageOverviewFetchResult } from "@/providers/alpha-vantage/overview";
import { STARTER_LIVE_SCAN_UNIVERSE } from "@/domain/scanner/live-scan";
import {
  getNearMisses,
  parseStoredCriterionActualValue,
  parseStoredCriterionDesiredValue,
  type CriterionResult,
  type CriterionStatus,
  type ScannerOperator,
} from "@/domain/scanner/scanner";
import type { AlphaVantageFetch } from "@/providers/alpha-vantage/client";
import type { TickerFundamentals } from "@/generated/prisma/client";

/** Slow-changing public fundamentals - a 7-day TTL is the recommended default for this data. */
export const ALPHA_VANTAGE_FUNDAMENTALS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A failed/empty/error attempt still backs off so one permanently-bad ticker can't get retried (and burn budget) on every single queue run. RATE_LIMITED never backs off - that's about pacing, not the ticker. */
export const ALPHA_VANTAGE_FAILURE_BACKOFF_MS = 24 * 60 * 60 * 1000;

async function defaultDelay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export type QueueTickerOutcome = {
  ticker: string;
  outcome: AlphaVantageOverviewFetchResult["outcome"];
  message?: string;
};

function toQueueOutcome(ticker: string, result: AlphaVantageOverviewFetchResult): QueueTickerOutcome {
  return {
    ticker,
    outcome: result.outcome,
    ...("message" in result ? { message: result.message } : {}),
  };
}

/**
 * Writes a fetch attempt to the shared cache. A SUCCESS is the ONLY outcome that ever touches
 * the actual fundamental value fields or fetchedAt - every other outcome only records attempt
 * metadata (lastAttemptAt/lastAttemptStatus/lastErrorMessage) so a failed/empty/rate-limited
 * request can never fabricate or blank out real fundamentals data. RATE_LIMITED does not even
 * advance the backoff (staleAfter) - that outcome is about OSO's own pacing, not the ticker.
 */
async function applyFetchResultToCache(ticker: string, result: AlphaVantageOverviewFetchResult, now: Date): Promise<void> {
  if (result.outcome === "SUCCESS") {
    const f = result.fields;
    await prisma.tickerFundamentals.upsert({
      where: { ticker },
      create: {
        ticker,
        name: f.name,
        description: f.description,
        sector: f.sector,
        industry: f.industry,
        marketCapitalization: f.marketCapitalization,
        peRatio: f.peRatio,
        pegRatio: f.pegRatio,
        eps: f.eps,
        dividendPerShare: f.dividendPerShare,
        dividendYield: f.dividendYield,
        profitMargin: f.profitMargin,
        operatingMarginTtm: f.operatingMarginTtm,
        returnOnAssetsTtm: f.returnOnAssetsTtm,
        returnOnEquityTtm: f.returnOnEquityTtm,
        revenueTtm: f.revenueTtm,
        grossProfitTtm: f.grossProfitTtm,
        quarterlyEarningsGrowthYoy: f.quarterlyEarningsGrowthYoy,
        quarterlyRevenueGrowthYoy: f.quarterlyRevenueGrowthYoy,
        analystTargetPrice: f.analystTargetPrice,
        analystStrongBuy: f.analystStrongBuy,
        analystBuy: f.analystBuy,
        analystHold: f.analystHold,
        analystSell: f.analystSell,
        analystStrongSell: f.analystStrongSell,
        bookValue: f.bookValue,
        priceToBookRatio: f.priceToBookRatio,
        evToEbitda: f.evToEbitda,
        beta: f.beta,
        source: "Alpha Vantage",
        fetchedAt: now,
        staleAfter: new Date(now.getTime() + ALPHA_VANTAGE_FUNDAMENTALS_TTL_MS),
        lastAttemptAt: now,
        lastAttemptStatus: "SUCCESS",
        lastErrorMessage: null,
      },
      update: {
        name: f.name,
        description: f.description,
        sector: f.sector,
        industry: f.industry,
        marketCapitalization: f.marketCapitalization,
        peRatio: f.peRatio,
        pegRatio: f.pegRatio,
        eps: f.eps,
        dividendPerShare: f.dividendPerShare,
        dividendYield: f.dividendYield,
        profitMargin: f.profitMargin,
        operatingMarginTtm: f.operatingMarginTtm,
        returnOnAssetsTtm: f.returnOnAssetsTtm,
        returnOnEquityTtm: f.returnOnEquityTtm,
        revenueTtm: f.revenueTtm,
        grossProfitTtm: f.grossProfitTtm,
        quarterlyEarningsGrowthYoy: f.quarterlyEarningsGrowthYoy,
        quarterlyRevenueGrowthYoy: f.quarterlyRevenueGrowthYoy,
        analystTargetPrice: f.analystTargetPrice,
        analystStrongBuy: f.analystStrongBuy,
        analystBuy: f.analystBuy,
        analystHold: f.analystHold,
        analystSell: f.analystSell,
        analystStrongSell: f.analystStrongSell,
        bookValue: f.bookValue,
        priceToBookRatio: f.priceToBookRatio,
        evToEbitda: f.evToEbitda,
        beta: f.beta,
        source: "Alpha Vantage",
        fetchedAt: now,
        staleAfter: new Date(now.getTime() + ALPHA_VANTAGE_FUNDAMENTALS_TTL_MS),
        lastAttemptAt: now,
        lastAttemptStatus: "SUCCESS",
        lastErrorMessage: null,
      },
    });
    return;
  }

  const attemptStatus = result.outcome;
  const message = "message" in result ? result.message : undefined;
  const backoffStaleAfter = attemptStatus === "RATE_LIMITED" ? undefined : new Date(now.getTime() + ALPHA_VANTAGE_FAILURE_BACKOFF_MS);

  await prisma.tickerFundamentals.upsert({
    where: { ticker },
    create: {
      ticker,
      lastAttemptAt: now,
      lastAttemptStatus: attemptStatus,
      lastErrorMessage: message ?? null,
      ...(backoffStaleAfter ? { staleAfter: backoffStaleAfter } : {}),
    },
    update: {
      lastAttemptAt: now,
      lastAttemptStatus: attemptStatus,
      lastErrorMessage: message ?? null,
      ...(backoffStaleAfter ? { staleAfter: backoffStaleAfter } : {}),
    },
  });
}

/**
 * Deduplicated, priority-ordered list of tickers whose fundamentals are missing or stale,
 * privacy-safe by construction: every query below selects `ticker` only, never `ownerId`,
 * `researchStatus`, or any other private field - the queue may know a ticker needs public
 * fundamentals, never which user (or why) researched it.
 *
 * Priority order: (1) any ticker in any user's Research, (2) Scanner PASS candidates from each
 * user's most recent scan, (3) Scanner Near candidates from the same runs, (4) the remaining
 * starter scanner universe. "Near" reuses the exact same canonical predicate the live scanner
 * itself uses for its own nearMatches count (`getNearMisses(result.summary.results).length ===
 * 1` in `rerunLiveSchwabScannerForUser`) - reconstructed from the persisted
 * `ScanCriterionResult` rows via the same shared parse helpers Research's own scan-snapshot
 * scoring uses (`parseStoredCriterionActualValue`/`parseStoredCriterionDesiredValue`), not a
 * second approximate definition. This only affects which ticker gets an Alpha Vantage refresh
 * sooner - it never touches Scanner's own score/status/label for anything a user sees.
 */
export async function getFundamentalsQueueCandidates(now: Date = new Date()): Promise<string[]> {
  const researchTickers = await prisma.watchlistItem.findMany({
    select: { ticker: true },
    distinct: ["ticker"],
  });

  const latestRunPerUser = await prisma.scanRun.findMany({
    distinct: ["ownerId"],
    orderBy: [{ ownerId: "asc" }, { createdAt: "desc" }],
    select: { id: true },
  });
  const runIds = latestRunPerUser.map((run) => run.id);

  const passResults = runIds.length
    ? await prisma.scanResult.findMany({
        where: { runId: { in: runIds }, summaryStatus: "PASS" },
        select: { ticker: true },
        distinct: ["ticker"],
      })
    : [];

  const otherResults = runIds.length
    ? await prisma.scanResult.findMany({
        where: { runId: { in: runIds }, summaryStatus: { not: "PASS" } },
        select: { ticker: true, criterionResults: { select: { actualValue: true, operator: true, desiredValue: true, status: true, criterionName: true } } },
      })
    : [];
  const nearTickers = [
    ...new Set(
      otherResults
        .filter((result) => {
          const criteria: CriterionResult[] = result.criterionResults.map((criterion) => ({
            key: criterion.criterionName,
            name: criterion.criterionName,
            actualValue: parseStoredCriterionActualValue(criterion.actualValue),
            operator: criterion.operator as ScannerOperator,
            desiredValue: parseStoredCriterionDesiredValue(criterion.desiredValue),
            status: criterion.status as CriterionStatus,
            explanation: "",
          }));
          return getNearMisses(criteria).length === 1;
        })
        .map((result) => result.ticker),
    ),
  ];

  const ordered = [
    ...researchTickers.map((r) => r.ticker),
    ...passResults.map((r) => r.ticker),
    ...nearTickers,
    ...STARTER_LIVE_SCAN_UNIVERSE,
  ];
  const deduped = [...new Set(ordered.map((t) => t.trim().toUpperCase()).filter(Boolean))];

  if (!deduped.length) {
    return [];
  }

  const freshRows = await prisma.tickerFundamentals.findMany({
    where: { ticker: { in: deduped }, staleAfter: { gt: now } },
    select: { ticker: true },
  });
  const freshSet = new Set(freshRows.map((r) => r.ticker));
  return deduped.filter((ticker) => !freshSet.has(ticker));
}

export type ProcessQueueStoppedReason = "COMPLETE" | "BUDGET_EXHAUSTED" | "RATE_LIMITED" | "LOCK_UNAVAILABLE" | "NO_API_KEY";

export type ProcessQueueSummary = {
  outcomes: QueueTickerOutcome[];
  callsConsumed: number;
  stoppedReason: ProcessQueueStoppedReason;
  usage: AlphaVantageUsageSnapshot;
};

type ProcessQueueOptions = {
  now?: Date;
  maxTickers?: number;
  fetchFn?: AlphaVantageFetch;
};

/**
 * The manual "Process fundamentals queue" action - see PROJECT_HANDOFF.md Alpha Vantage API
 * section for why this is click-triggered rather than automatic (Hostinger has no confirmed
 * persistent-worker/cron support). Never called from Scanner or Research render paths. Paces
 * real calls ALPHA_VANTAGE_REQUEST_DELAY_MS apart (never before the first), reserves an AUTO
 * budget slot atomically before each real call (stopping the instant the budget is exhausted -
 * so auto usage can never exceed ALPHA_VANTAGE_AUTO_DAILY_LIMIT), and stops immediately on a
 * real throttle response from Alpha Vantage. Only one queue run (or manual refresh) may be
 * in-flight at a time - see tryAcquireAlphaVantageRunLock().
 */
export async function processAlphaVantageFundamentalsQueue(options: ProcessQueueOptions = {}): Promise<ProcessQueueSummary> {
  const now = options.now ?? new Date();
  const apiKey = getAlphaVantageApiKey();
  if (!apiKey) {
    return { outcomes: [], callsConsumed: 0, stoppedReason: "NO_API_KEY", usage: await getAlphaVantageUsageToday(now) };
  }

  const acquired = await tryAcquireAlphaVantageRunLock(now);
  if (!acquired) {
    return { outcomes: [], callsConsumed: 0, stoppedReason: "LOCK_UNAVAILABLE", usage: await getAlphaVantageUsageToday(now) };
  }

  try {
    const candidates = await getFundamentalsQueueCandidates(now);
    const limited = typeof options.maxTickers === "number" ? candidates.slice(0, options.maxTickers) : candidates;

    const outcomes: QueueTickerOutcome[] = [];
    let stoppedReason: ProcessQueueStoppedReason = "COMPLETE";
    let hasMadeFirstCall = false;

    for (const ticker of limited) {
      const reservation = await reserveAlphaVantageCall("AUTO", now);
      if (!reservation.reserved) {
        stoppedReason = "BUDGET_EXHAUSTED";
        break;
      }

      if (hasMadeFirstCall) {
        await defaultDelay(ALPHA_VANTAGE_REQUEST_DELAY_MS);
      }
      hasMadeFirstCall = true;

      const result = await fetchAlphaVantageOverviewForTicker({ apiKey, ticker, fetchFn: options.fetchFn });
      await applyFetchResultToCache(ticker, result, now);
      outcomes.push(toQueueOutcome(ticker, result));

      if (result.outcome === "RATE_LIMITED") {
        stoppedReason = "RATE_LIMITED";
        break;
      }
    }

    return { outcomes, callsConsumed: outcomes.length, stoppedReason, usage: await getAlphaVantageUsageToday(now) };
  } finally {
    await releaseAlphaVantageRunLock(now);
  }
}

export type ManualRefreshResult =
  | { status: "NO_API_KEY" }
  | { status: "ALREADY_FRESH"; record: TickerFundamentals }
  | { status: "LOCK_UNAVAILABLE" }
  | { status: "BUDGET_EXHAUSTED"; usage: AlphaVantageUsageSnapshot }
  | { status: "DONE"; outcome: QueueTickerOutcome; usage: AlphaVantageUsageSnapshot };

type ManualRefreshOptions = {
  now?: Date;
  force?: boolean;
  fetchFn?: AlphaVantageFetch;
};

/**
 * Manual, single-ticker refresh. Uses the MANUAL budget kind (drawing from the 3-call daily
 * reserve once the automatic AUTO cap of 22 is hit). Refuses to waste a call on already-fresh
 * data unless `force` is explicitly set. Never overlaps with an in-flight automatic queue run
 * (or another manual refresh) - see tryAcquireAlphaVantageRunLock().
 */
export async function refreshSingleTickerFundamentals(ticker: string, options: ManualRefreshOptions = {}): Promise<ManualRefreshResult> {
  const now = options.now ?? new Date();
  const normalized = ticker.trim().toUpperCase();
  const apiKey = getAlphaVantageApiKey();
  if (!apiKey) {
    return { status: "NO_API_KEY" };
  }

  if (!options.force) {
    const existing = await prisma.tickerFundamentals.findUnique({ where: { ticker: normalized } });
    if (existing?.staleAfter && existing.staleAfter > now) {
      return { status: "ALREADY_FRESH", record: existing };
    }
  }

  const acquired = await tryAcquireAlphaVantageRunLock(now);
  if (!acquired) {
    return { status: "LOCK_UNAVAILABLE" };
  }

  try {
    const reservation = await reserveAlphaVantageCall("MANUAL", now);
    if (!reservation.reserved) {
      return { status: "BUDGET_EXHAUSTED", usage: reservation.usage };
    }

    const result = await fetchAlphaVantageOverviewForTicker({ apiKey, ticker: normalized, fetchFn: options.fetchFn });
    await applyFetchResultToCache(normalized, result, now);
    return { status: "DONE", outcome: toQueueOutcome(normalized, result), usage: await getAlphaVantageUsageToday(now) };
  } finally {
    await releaseAlphaVantageRunLock(now);
  }
}

/**
 * Batched, read-only lookup for Research display - never triggers a fetch, never writes
 * anything. Returns whatever is cached (fresh or stale) so a page render always has something
 * to show if it exists; staleness only affects whether the queue will refresh it later.
 */
export async function getTickerFundamentalsMap(tickers: string[]): Promise<Map<string, TickerFundamentals>> {
  const normalized = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))];
  if (!normalized.length) {
    return new Map();
  }
  const rows = await prisma.tickerFundamentals.findMany({ where: { ticker: { in: normalized } } });
  return new Map(rows.map((row) => [row.ticker, row]));
}

export type AlphaVantageCacheSummary = {
  cachedTickers: number;
  staleOrMissingQueued: number;
};

/** For the Account status panel - "Cached tickers" / "Stale/missing queued". Read-only. */
export async function getAlphaVantageCacheSummary(now: Date = new Date()): Promise<AlphaVantageCacheSummary> {
  const [cachedTickers, staleOrMissingQueued] = await Promise.all([
    prisma.tickerFundamentals.count({ where: { fetchedAt: { not: null } } }),
    getFundamentalsQueueCandidates(now).then((tickers) => tickers.length),
  ]);
  return { cachedTickers, staleOrMissingQueued };
}
