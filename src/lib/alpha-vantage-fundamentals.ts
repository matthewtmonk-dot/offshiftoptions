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
import { fetchAlphaVantageBalanceSheetForTicker, type AlphaVantageBalanceSheetFetchResult } from "@/providers/alpha-vantage/balance-sheet";
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

// ===== BALANCE_SHEET (Current Ratio / Debt-Equity) =====
//
// Tracked independently from OVERVIEW above via its own balanceSheet*FetchedAt/StaleAfter/
// LastAttempt* columns on the same TickerFundamentals row - a ticker's OVERVIEW being fresh
// never implies its BALANCE_SHEET is, and vice versa. Shares the exact same daily budget,
// global run lock, and pacing constant as OVERVIEW (see processAlphaVantageBalanceSheetQueue
// below) - there is only ever one combined 25/day Alpha Vantage budget, never a second one.
// Both Current Ratio and Debt/Equity are computed from the same single BALANCE_SHEET request -
// see src/providers/alpha-vantage/balance-sheet.ts for the verified debtToEquity formula
// (shortLongTermDebtTotal / totalShareholderEquity, verified 2026-09 against a real production
// APLD response).

export type BalanceSheetQueueTickerOutcome = {
  ticker: string;
  outcome: AlphaVantageBalanceSheetFetchResult["outcome"];
  message?: string;
};

function toBalanceSheetQueueOutcome(ticker: string, result: AlphaVantageBalanceSheetFetchResult): BalanceSheetQueueTickerOutcome {
  return {
    ticker,
    outcome: result.outcome,
    ...("message" in result ? { message: result.message } : {}),
  };
}

async function applyBalanceSheetResultToCache(ticker: string, result: AlphaVantageBalanceSheetFetchResult, now: Date): Promise<void> {
  if (result.outcome === "SUCCESS") {
    const f = result.fields;
    const fiscalDateEnding = f.fiscalDateEnding ? new Date(f.fiscalDateEnding) : null;
    const validFiscalDateEnding = fiscalDateEnding && !Number.isNaN(fiscalDateEnding.getTime()) ? fiscalDateEnding : null;
    await prisma.tickerFundamentals.upsert({
      where: { ticker },
      create: {
        ticker,
        balanceSheetCurrentRatio: f.currentRatio,
        balanceSheetDebtToEquity: f.debtToEquity,
        balanceSheetFiscalDateEnding: validFiscalDateEnding,
        balanceSheetFetchedAt: now,
        balanceSheetStaleAfter: new Date(now.getTime() + ALPHA_VANTAGE_FUNDAMENTALS_TTL_MS),
        balanceSheetLastAttemptAt: now,
        balanceSheetLastAttemptStatus: "SUCCESS",
        balanceSheetLastErrorMessage: null,
      },
      update: {
        balanceSheetCurrentRatio: f.currentRatio,
        balanceSheetDebtToEquity: f.debtToEquity,
        balanceSheetFiscalDateEnding: validFiscalDateEnding,
        balanceSheetFetchedAt: now,
        balanceSheetStaleAfter: new Date(now.getTime() + ALPHA_VANTAGE_FUNDAMENTALS_TTL_MS),
        balanceSheetLastAttemptAt: now,
        balanceSheetLastAttemptStatus: "SUCCESS",
        balanceSheetLastErrorMessage: null,
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
      balanceSheetLastAttemptAt: now,
      balanceSheetLastAttemptStatus: attemptStatus,
      balanceSheetLastErrorMessage: message ?? null,
      ...(backoffStaleAfter ? { balanceSheetStaleAfter: backoffStaleAfter } : {}),
    },
    update: {
      balanceSheetLastAttemptAt: now,
      balanceSheetLastAttemptStatus: attemptStatus,
      balanceSheetLastErrorMessage: message ?? null,
      ...(backoffStaleAfter ? { balanceSheetStaleAfter: backoffStaleAfter } : {}),
    },
  });
}

/**
 * Priority order for BALANCE_SHEET, deliberately narrower than OVERVIEW's queue: (1) every
 * ticker in any user's Research, (2) Scanner PASS candidates only, as a lower-priority tail
 * used only when Research tickers are already fresh. Scanner "Near" candidates and the starter
 * scanner universe are NOT included - balance sheet data is only useful for tickers a user is
 * actually tracking closely, and this endpoint must not be spent scanning the full universe.
 */
export async function getBalanceSheetQueueCandidates(now: Date = new Date()): Promise<string[]> {
  const researchTickers = await prisma.watchlistItem.findMany({ select: { ticker: true }, distinct: ["ticker"] });
  const researchList = researchTickers.map((r) => r.ticker);

  const latestRunPerUser = await prisma.scanRun.findMany({
    distinct: ["ownerId"],
    orderBy: [{ ownerId: "asc" }, { createdAt: "desc" }],
    select: { id: true },
  });
  const runIds = latestRunPerUser.map((run) => run.id);
  const passResults = runIds.length
    ? await prisma.scanResult.findMany({ where: { runId: { in: runIds }, summaryStatus: "PASS" }, select: { ticker: true }, distinct: ["ticker"] })
    : [];
  const passList = passResults.map((r) => r.ticker);

  const ordered = [...researchList, ...passList];
  const deduped = [...new Set(ordered.map((t) => t.trim().toUpperCase()).filter(Boolean))];
  if (!deduped.length) {
    return [];
  }

  const freshRows = await prisma.tickerFundamentals.findMany({
    where: { ticker: { in: deduped }, balanceSheetStaleAfter: { gt: now } },
    select: { ticker: true },
  });
  const freshSet = new Set(freshRows.map((r) => r.ticker));
  return deduped.filter((ticker) => !freshSet.has(ticker));
}

export type ProcessBalanceSheetQueueSummary = {
  outcomes: BalanceSheetQueueTickerOutcome[];
  callsConsumed: number;
  stoppedReason: ProcessQueueStoppedReason;
  usage: AlphaVantageUsageSnapshot;
};

/**
 * The automatic BALANCE_SHEET queue pass - reuses the exact same AUTO budget reservation,
 * global run lock, and ALPHA_VANTAGE_REQUEST_DELAY_MS pacing as processAlphaVantageFundamentalsQueue.
 * Called after the OVERVIEW pass in the same cron invocation (see
 * src/app/api/internal/alpha-vantage/process/route.ts) so both endpoints draw from one shared
 * daily counter - if OVERVIEW's queue consumes the full AUTO budget on a given day, this pass
 * simply reserves 0 calls and returns BUDGET_EXHAUSTED immediately, spending nothing extra.
 */
export async function processAlphaVantageBalanceSheetQueue(options: ProcessQueueOptions = {}): Promise<ProcessBalanceSheetQueueSummary> {
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
    const candidates = await getBalanceSheetQueueCandidates(now);
    const limited = typeof options.maxTickers === "number" ? candidates.slice(0, options.maxTickers) : candidates;

    const outcomes: BalanceSheetQueueTickerOutcome[] = [];
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

      const result = await fetchAlphaVantageBalanceSheetForTicker({ apiKey, ticker, fetchFn: options.fetchFn });
      await applyBalanceSheetResultToCache(ticker, result, now);
      outcomes.push(toBalanceSheetQueueOutcome(ticker, result));

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

export type BalanceSheetManualRefreshResult =
  | { status: "NO_API_KEY" }
  | { status: "ALREADY_FRESH"; record: TickerFundamentals }
  | { status: "LOCK_UNAVAILABLE" }
  | { status: "BUDGET_EXHAUSTED"; usage: AlphaVantageUsageSnapshot }
  | { status: "DONE"; outcome: BalanceSheetQueueTickerOutcome; usage: AlphaVantageUsageSnapshot };

/**
 * Manual, single-ticker BALANCE_SHEET refresh - the symmetric equivalent of
 * refreshSingleTickerFundamentals() above, for exactly one named ticker rather than the
 * priority queue. Uses the MANUAL budget kind and the same run lock. Not currently wired to any
 * production UI this slice (only the queue and the temporary APLD diagnostic are) - exists so a
 * specific ticker's Current Ratio can be forced without waiting for/depending on the queue's
 * candidate ordering, and so tests can assert on one exact ticker's outcome deterministically.
 */
export async function refreshSingleTickerBalanceSheet(ticker: string, options: ManualRefreshOptions = {}): Promise<BalanceSheetManualRefreshResult> {
  const now = options.now ?? new Date();
  const normalized = ticker.trim().toUpperCase();
  const apiKey = getAlphaVantageApiKey();
  if (!apiKey) {
    return { status: "NO_API_KEY" };
  }

  if (!options.force) {
    const existing = await prisma.tickerFundamentals.findUnique({ where: { ticker: normalized } });
    if (existing?.balanceSheetStaleAfter && existing.balanceSheetStaleAfter > now) {
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

    const result = await fetchAlphaVantageBalanceSheetForTicker({ apiKey, ticker: normalized, fetchFn: options.fetchFn });
    await applyBalanceSheetResultToCache(normalized, result, now);
    return { status: "DONE", outcome: toBalanceSheetQueueOutcome(normalized, result), usage: await getAlphaVantageUsageToday(now) };
  } finally {
    await releaseAlphaVantageRunLock(now);
  }
}

// ===== UNIFIED WORK QUEUE (fixes OVERVIEW/BALANCE_SHEET budget starvation) =====
//
// Running processAlphaVantageFundamentalsQueue() then processAlphaVantageBalanceSheetQueue()
// back-to-back (the original cron wiring) let a broad OVERVIEW pass spend the ENTIRE 22-call
// AUTO budget before BALANCE_SHEET ever got a single call, even for a Research ticker missing
// both. OSO's goal is a complete one-stop Research workspace, so Research completeness across
// BOTH endpoints must outrank broad Scanner-only OVERVIEW refreshes. getUnifiedAlphaVantageWorkQueue
// below builds one priority-ordered {ticker, endpoint} list spanning both endpoints, and
// processAlphaVantageQueues() drains it under a single shared budget/lock/pacing loop, so a
// higher-priority BALANCE_SHEET item can never be starved merely because lower-priority
// OVERVIEW work exists ahead of it in a separate queue. This is additive - the two
// single-endpoint functions above are unchanged and still used by the manual "Process
// fundamentals queue" button (OVERVIEW only) and by their own existing tests.

type TickerTiers = {
  research: string[];
  scannerPass: string[];
  scannerNear: string[];
  starterUniverse: string[];
};

function normalizeTickerList(tickers: string[]): string[] {
  return [...new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean))];
}

/**
 * The same four raw (deduped, NOT freshness-filtered) ticker tiers getFundamentalsQueueCandidates
 * and getBalanceSheetQueueCandidates each independently compute - factored out here so the
 * unified queue builder below can apply per-endpoint freshness and priority ordering without a
 * second, drifting copy of the Scanner Near reconstruction logic (parseStoredCriterionActualValue/
 * parseStoredCriterionDesiredValue/getNearMisses - see getFundamentalsQueueCandidates's own
 * docstring for why this must stay the canonical Scanner predicate, not an approximation).
 */
async function getTickerTiers(): Promise<TickerTiers> {
  const researchTickers = await prisma.watchlistItem.findMany({ select: { ticker: true }, distinct: ["ticker"] });
  const research = normalizeTickerList(researchTickers.map((row) => row.ticker));

  const latestRunPerUser = await prisma.scanRun.findMany({
    distinct: ["ownerId"],
    orderBy: [{ ownerId: "asc" }, { createdAt: "desc" }],
    select: { id: true },
  });
  const runIds = latestRunPerUser.map((run) => run.id);

  const passResults = runIds.length
    ? await prisma.scanResult.findMany({ where: { runId: { in: runIds }, summaryStatus: "PASS" }, select: { ticker: true }, distinct: ["ticker"] })
    : [];
  const scannerPass = normalizeTickerList(passResults.map((row) => row.ticker));

  const otherResults = runIds.length
    ? await prisma.scanResult.findMany({
        where: { runId: { in: runIds }, summaryStatus: { not: "PASS" } },
        select: { ticker: true, criterionResults: { select: { actualValue: true, operator: true, desiredValue: true, status: true, criterionName: true } } },
      })
    : [];
  const scannerNear = normalizeTickerList(
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
  );

  return { research, scannerPass, scannerNear, starterUniverse: normalizeTickerList([...STARTER_LIVE_SCAN_UNIVERSE]) };
}

export type AlphaVantageEndpoint = "OVERVIEW" | "BALANCE_SHEET";
export type AlphaVantageWorkItem = { ticker: string; endpoint: AlphaVantageEndpoint };

/**
 * Unified, priority-ordered work-item queue spanning both Alpha Vantage endpoints:
 *   1. Research tickers missing/stale OVERVIEW
 *   2. Research tickers missing/stale BALANCE_SHEET
 *   3. Scanner PASS tickers missing/stale OVERVIEW
 *   4. Scanner PASS tickers missing/stale BALANCE_SHEET
 *   5. Scanner Near tickers missing/stale OVERVIEW (BALANCE_SHEET is never spent on this tier)
 *   6. Starter scanner universe tickers missing/stale OVERVIEW (BALANCE_SHEET is never spent here either)
 * A ticker that qualifies for more than one tier (e.g. it's in Research AND a Scanner PASS
 * result) is only ever processed once per endpoint, at its highest-priority tier - never twice,
 * never re-fetched because a lower tier also mentions it. Privacy-safe by construction, same as
 * the two single-endpoint queues: only bare ticker strings ever leave this function.
 */
export async function getUnifiedAlphaVantageWorkQueue(now: Date = new Date()): Promise<AlphaVantageWorkItem[]> {
  const tiers = await getTickerTiers();
  const allTickers = normalizeTickerList([...tiers.research, ...tiers.scannerPass, ...tiers.scannerNear, ...tiers.starterUniverse]);

  const freshnessRows = allTickers.length
    ? await prisma.tickerFundamentals.findMany({
        where: { ticker: { in: allTickers } },
        select: { ticker: true, staleAfter: true, balanceSheetStaleAfter: true },
      })
    : [];
  const overviewFresh = new Set(freshnessRows.filter((row) => row.staleAfter && row.staleAfter > now).map((row) => row.ticker));
  const balanceSheetFresh = new Set(
    freshnessRows.filter((row) => row.balanceSheetStaleAfter && row.balanceSheetStaleAfter > now).map((row) => row.ticker),
  );

  const items: AlphaVantageWorkItem[] = [];
  const added = new Set<string>();

  function addTier(tickers: string[], endpoint: AlphaVantageEndpoint, freshSet: Set<string>) {
    for (const ticker of tickers) {
      const key = `${ticker}:${endpoint}`;
      if (added.has(key) || freshSet.has(ticker)) {
        continue;
      }
      added.add(key);
      items.push({ ticker, endpoint });
    }
  }

  addTier(tiers.research, "OVERVIEW", overviewFresh);
  addTier(tiers.research, "BALANCE_SHEET", balanceSheetFresh);
  addTier(tiers.scannerPass, "OVERVIEW", overviewFresh);
  addTier(tiers.scannerPass, "BALANCE_SHEET", balanceSheetFresh);
  addTier(tiers.scannerNear, "OVERVIEW", overviewFresh);
  addTier(tiers.starterUniverse, "OVERVIEW", overviewFresh);

  return items;
}

export type UnifiedQueueTickerOutcome = {
  ticker: string;
  endpoint: AlphaVantageEndpoint;
  outcome: AlphaVantageOverviewFetchResult["outcome"] | AlphaVantageBalanceSheetFetchResult["outcome"];
  message?: string;
};

export type ProcessUnifiedQueueSummary = {
  outcomes: UnifiedQueueTickerOutcome[];
  callsConsumed: number;
  stoppedReason: ProcessQueueStoppedReason;
  usage: AlphaVantageUsageSnapshot;
};

/**
 * Drains getUnifiedAlphaVantageWorkQueue() under one shared budget reservation, global run
 * lock, and 1300ms pacing loop - this is the production entry point for the scheduled cron
 * (src/app/api/internal/alpha-vantage/process/route.ts). Reserving AUTO budget per work item
 * (not per ticker) means a Research ticker needing both endpoints correctly costs two
 * reservations, exactly as expected ("A Research ticker may legitimately cost 1+1 calls when
 * both are missing/stale - that is acceptable"). Stops immediately on budget exhaustion or a
 * real throttle response, same semantics as the two single-endpoint queues.
 */
export async function processAlphaVantageQueues(options: ProcessQueueOptions = {}): Promise<ProcessUnifiedQueueSummary> {
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
    const workItems = await getUnifiedAlphaVantageWorkQueue(now);
    const limited = typeof options.maxTickers === "number" ? workItems.slice(0, options.maxTickers) : workItems;

    const outcomes: UnifiedQueueTickerOutcome[] = [];
    let stoppedReason: ProcessQueueStoppedReason = "COMPLETE";
    let hasMadeFirstCall = false;

    for (const item of limited) {
      const reservation = await reserveAlphaVantageCall("AUTO", now);
      if (!reservation.reserved) {
        stoppedReason = "BUDGET_EXHAUSTED";
        break;
      }

      if (hasMadeFirstCall) {
        await defaultDelay(ALPHA_VANTAGE_REQUEST_DELAY_MS);
      }
      hasMadeFirstCall = true;

      if (item.endpoint === "OVERVIEW") {
        const result = await fetchAlphaVantageOverviewForTicker({ apiKey, ticker: item.ticker, fetchFn: options.fetchFn });
        await applyFetchResultToCache(item.ticker, result, now);
        outcomes.push({ ticker: item.ticker, endpoint: "OVERVIEW", outcome: result.outcome, ...("message" in result ? { message: result.message } : {}) });
        if (result.outcome === "RATE_LIMITED") {
          stoppedReason = "RATE_LIMITED";
          break;
        }
      } else {
        const result = await fetchAlphaVantageBalanceSheetForTicker({ apiKey, ticker: item.ticker, fetchFn: options.fetchFn });
        await applyBalanceSheetResultToCache(item.ticker, result, now);
        outcomes.push({ ticker: item.ticker, endpoint: "BALANCE_SHEET", outcome: result.outcome, ...("message" in result ? { message: result.message } : {}) });
        if (result.outcome === "RATE_LIMITED") {
          stoppedReason = "RATE_LIMITED";
          break;
        }
      }
    }

    return { outcomes, callsConsumed: outcomes.length, stoppedReason, usage: await getAlphaVantageUsageToday(now) };
  } finally {
    await releaseAlphaVantageRunLock(now);
  }
}
