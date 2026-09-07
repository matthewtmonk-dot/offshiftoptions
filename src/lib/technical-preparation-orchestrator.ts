import "server-only";

import { isNyseMarketDay } from "@/domain/finance/marketCalendar";
import { resolveMarketDataProviderForUser } from "./broker-connections";
import { prisma } from "./prisma";
import {
  getTechnicalPreparationStatusForUser,
  refreshTechnicalIndicatorCacheBatchForUser,
  TECHNICAL_REFRESH_BATCH_SIZE,
} from "./technical-indicator-cache";
import type { MarketDataProvider } from "@/providers/market-data/types";

/**
 * Bounded orchestration around the ALREADY-BUILT, ALREADY-production-proven technical
 * preparation worker (technical-indicator-cache.ts's TechnicalPreparationRun/Item, claim
 * mechanism, stale-claim recovery, 25-symbol batches at concurrency 4 - real production evidence:
 * ~2.6s/25-item batch, 0 failures). This module does NOT recompute RSI/BB, does NOT touch Stage A
 * eligibility logic, and does NOT change the claim/recovery mechanism - it only decides WHICH
 * user gets a cycle and HOW MANY of the existing safe 25-symbol batches to run in one bounded HTTP
 * invocation, so a full ~2,036-symbol preparation doesn't need ~82 separate scheduled requests.
 *
 * No new schema was needed or added for this: "which user most needs a cycle" is answered live,
 * each invocation, from the existing TechnicalPreparationRun's own (marketDate, rulesFingerprint,
 * updatedAt) - there is nothing for a separate scheduler-state table to remember that this data
 * doesn't already answer, and adding one merely to "remember a cron ran" was explicitly avoided.
 */

// -------------------------------------------------------------------------------------------
// Bounded per-invocation budget - named constants, not magic numbers.
// -------------------------------------------------------------------------------------------

/** At most this many of the EXISTING 25-symbol batches run per orchestrator invocation - real
 * production evidence: ~2.6s per 25-item batch, so 5 batches is ~125 history symbols and roughly
 * 13s of observed provider work, leaving real headroom under ORCHESTRATOR_WALL_CLOCK_BUDGET_MS
 * for general application/network overhead. Deliberately conservative - raise only after real
 * sustained-throughput evidence, never guessed. */
export const MAX_SUB_BATCHES_PER_INVOCATION = 5;

/** Independent wall-clock guard, checked BEFORE starting each new sub-batch (never mid-batch) -
 * an in-flight sub-batch is always allowed to finish cleanly, but no additional sub-batch starts
 * once elapsed time has already reached this budget. ~20s is chosen to comfortably contain
 * MAX_SUB_BATCHES_PER_INVOCATION's worst-case real cost while stopping well short of typical
 * platform request-timeout territory. */
export const ORCHESTRATOR_WALL_CLOCK_BUDGET_MS = 20_000;

// -------------------------------------------------------------------------------------------
// NYSE-calendar-aware preparation window - DST-safe (real America/New_York wall-clock time via
// Intl, never a fixed UTC-offset assumption).
// -------------------------------------------------------------------------------------------

const REGULAR_SESSION_CLOSE_HOUR_ET = 16; // 4:00 PM ET, matching the existing daily-candle semantics

function nyDateTimeParts(date: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const valueFor = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  // Intl renders midnight as "24" with hour12: false in some environments - normalize to 0.
  const hour = valueFor("hour") % 24;
  return { year: valueFor("year"), month: valueFor("month"), day: valueFor("day"), hour, minute: valueFor("minute") };
}

/**
 * True whenever it is safe to run a technical-preparation cycle right now: NOT during a live
 * NYSE regular trading session (avoids intraday indicator-refresh churn - RSI/BB are computed
 * from DAILY candles, so nothing new exists until close anyway). On a genuine NYSE market day,
 * that means after 4:00 PM ET. On a weekend or NYSE holiday, always true - Friday's close stays
 * valid and safe to keep preparing against all weekend, and a holiday never fabricates a fake
 * trading day (getOrCreateActiveTechnicalPreparationRun's own history fetch would simply return
 * the same real last-trading-day candles either way - see PROJECT_HANDOFF.md for the full
 * reasoning this deliberately does not over-engineer around).
 */
export function isTechnicalPreparationWindowOpen(now: Date): boolean {
  const ny = nyDateTimeParts(now);
  const nyDateUtc = new Date(Date.UTC(ny.year, ny.month - 1, ny.day));
  if (!isNyseMarketDay(nyDateUtc)) {
    return true;
  }
  return ny.hour >= REGULAR_SESSION_CLOSE_HOUR_ET;
}

// -------------------------------------------------------------------------------------------
// User selection - fair, generic, never hardcoded to a specific user; a failing/disconnected
// candidate is skipped (cheaply, no provider work spent) in favor of the next one, so one
// permanently-broken user can never starve the rest.
// -------------------------------------------------------------------------------------------

type SelectedUser = { userId: string; provider: MarketDataProvider };

async function selectNextEligibleUserForTechnicalPreparation(now: Date): Promise<SelectedUser | null> {
  const connectedUserIds = await prisma.brokerConnection.findMany({
    where: { provider: "SCHWAB", status: "CONNECTED", accessTokenCiphertext: { not: null }, refreshTokenCiphertext: { not: null } },
    select: { userId: true },
    distinct: ["userId"],
  });
  if (!connectedUserIds.length) {
    return null;
  }

  const statuses = await Promise.all(
    connectedUserIds.map(async ({ userId }) => ({ userId, status: await getTechnicalPreparationStatusForUser(userId, now) })),
  );

  // Oldest/incompletely-prepared first: a user with no run at all today (lastTouchedAt null)
  // sorts before one who's merely mid-progress, and among in-progress users the one whose run
  // was updated longest ago goes first - fair, round-robin-equivalent, and derived entirely from
  // data the existing tables already hold.
  const needsWork = statuses
    .filter((entry) => !entry.status.isComplete)
    .sort((a, b) => (a.status.lastTouchedAt?.getTime() ?? 0) - (b.status.lastTouchedAt?.getTime() ?? 0));

  for (const candidate of needsWork) {
    const resolved = await resolveMarketDataProviderForUser(candidate.userId);
    if (resolved.provider) {
      return { userId: candidate.userId, provider: resolved.provider };
    }
    // This candidate's provider is unavailable right now (e.g. token refresh failed) - skip to
    // the next fairest candidate within THIS SAME invocation, spending no Schwab work on the
    // broken one. A later invocation will naturally re-evaluate them, never starving anyone else.
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// The bounded orchestration cycle itself.
// -------------------------------------------------------------------------------------------

export type TechnicalPreparationOrchestratorResult =
  | { status: "OUTSIDE_WINDOW" }
  | { status: "NO_ELIGIBLE_USER" }
  | {
      status: "OK";
      userProcessed: true;
      generationStatus: "IN_PROGRESS" | "COMPLETE";
      subBatchesProcessed: number;
      historySymbolsProcessed: number;
      succeededCount: number;
      failedCount: number;
      remainingEligibleCount: number;
      elapsedMs: number;
    }
  | { status: "USER_CYCLE_FAILED" };

/**
 * One bounded invocation: picks at most one user (see selectNextEligibleUserForTechnicalPreparation),
 * then runs up to MAX_SUB_BATCHES_PER_INVOCATION of the EXISTING, unmodified 25-symbol
 * refreshTechnicalIndicatorCacheBatchForUser batches for them, stopping as soon as ANY of these is
 * true: the run reports 0 remaining (COMPLETE), the sub-batch cap is reached, the wall-clock
 * budget is reached, or a batch claimed/processed nothing (meaning everything left is either done
 * or actively claimed by another concurrent invocation - no point spinning further sub-batches).
 * A GitHub Actions schedule is expected to call this endpoint repeatedly during a bounded
 * after-close window and simply NO-OP once every connected user is COMPLETE for the day.
 */
export async function runTechnicalPreparationOrchestratorCycle(now: Date = new Date()): Promise<TechnicalPreparationOrchestratorResult> {
  if (!isTechnicalPreparationWindowOpen(now)) {
    return { status: "OUTSIDE_WINDOW" };
  }

  const selected = await selectNextEligibleUserForTechnicalPreparation(now);
  if (!selected) {
    return { status: "NO_ELIGIBLE_USER" };
  }

  const startedAt = Date.now();
  let subBatchesProcessed = 0;
  let historySymbolsProcessed = 0;
  let succeededCount = 0;
  let failedCount = 0;
  let remainingEligibleCount = 0;

  try {
    for (let i = 0; i < MAX_SUB_BATCHES_PER_INVOCATION; i += 1) {
      if (Date.now() - startedAt >= ORCHESTRATOR_WALL_CLOCK_BUDGET_MS) {
        break; // never start another sub-batch once the wall-clock guard says the budget is spent
      }

      const batch = await refreshTechnicalIndicatorCacheBatchForUser(selected.userId, selected.provider, {
        batchSize: TECHNICAL_REFRESH_BATCH_SIZE,
        now,
      });
      subBatchesProcessed += 1;
      historySymbolsProcessed += batch.processedCount;
      succeededCount += batch.succeededCount;
      failedCount += batch.failedCount;
      remainingEligibleCount = batch.remainingEligibleCount;

      if (batch.processedCount === 0) {
        break; // nothing left to claim right now (done, or held by another concurrent invocation)
      }
      if (remainingEligibleCount === 0) {
        break; // generation just completed
      }
    }
  } catch {
    // Sanitized - never leaks a raw provider/database error. This selected user's cycle failed
    // unexpectedly (e.g. a transient auth/network failure, or - in the rare case a user is
    // deleted mid-cycle - a downstream write failure); refreshTechnicalIndicatorCacheBatchForUser's
    // own per-item isolation already means any sub-batches that DID complete before the failure
    // wrote real, valid data, and this user's existing TechnicalIndicatorSnapshot rows are
    // otherwise untouched. This failure never propagates to break another user's cycle or crash
    // the whole endpoint - a later invocation will naturally reconsider this user (or select
    // whichever other eligible user is fairest at that time).
    return { status: "USER_CYCLE_FAILED" };
  }

  return {
    status: "OK",
    userProcessed: true,
    generationStatus: remainingEligibleCount === 0 ? "COMPLETE" : "IN_PROGRESS",
    subBatchesProcessed,
    historySymbolsProcessed,
    succeededCount,
    failedCount,
    remainingEligibleCount,
    elapsedMs: Date.now() - startedAt,
  };
}
