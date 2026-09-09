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

/**
 * Morning preparation window, America/New_York, before the regular session opens - see
 * PROJECT_HANDOFF.md's readiness-mismatch investigation. Real production evidence proved an
 * evening-after-close run (~9:32 PM ET) could see a provider that had NOT yet posted the
 * just-closed session's own daily candle, producing an immediately-stale snapshot. Moving
 * preparation to the following morning (before that day's own open) gives the provider the
 * whole overnight window to post the prior session's candle, and DEFERRED/retry (see
 * refreshTechnicalIndicatorCacheBatchForUser) safely absorbs the case where it still hasn't by
 * the time the window opens. 5:00-9:15 AM ET is a starting default, not a measured optimum -
 * adjust the start after inspecting real provider behavior (see the new latest-candle-freshness
 * diagnostic on the Scanner Engineering Diagnostics page).
 */
const PREPARATION_WINDOW_START_MINUTE_OF_DAY_ET = 5 * 60; // 5:00 AM ET
const PREPARATION_WINDOW_END_MINUTE_OF_DAY_ET = 9 * 60 + 15; // 9:15 AM ET (inclusive)

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
 * True whenever it is safe to run a technical-preparation cycle right now: America/New_York wall-
 * clock time (via Intl, never a fixed UTC-offset assumption - DST-safe by construction), between
 * PREPARATION_WINDOW_START_MINUTE_OF_DAY_ET and PREPARATION_WINDOW_END_MINUTE_OF_DAY_ET, on a real
 * NYSE market day only - preparing before an open that isn't actually happening today has no
 * purpose. A worker invoked inside this window computes its own required market date via
 * previousNyseMarketDay(now) (see technical-indicator-cache.ts), which already correctly resolves
 * "the previous completed trading day" across weekends/holidays (e.g. Tuesday morning after Labor
 * Day correctly requires the prior Friday, never a fabricated Monday) - no separate calendar logic
 * is needed here beyond deciding whether the window itself is currently open.
 */
export function isTechnicalPreparationWindowOpen(now: Date): boolean {
  const ny = nyDateTimeParts(now);
  const nyDateUtc = new Date(Date.UTC(ny.year, ny.month - 1, ny.day));
  if (!isNyseMarketDay(nyDateUtc)) {
    return false;
  }
  const minuteOfDay = ny.hour * 60 + ny.minute;
  return minuteOfDay >= PREPARATION_WINDOW_START_MINUTE_OF_DAY_ET && minuteOfDay <= PREPARATION_WINDOW_END_MINUTE_OF_DAY_ET;
}

// -------------------------------------------------------------------------------------------
// User selection - fair, generic, never hardcoded to a specific user; a failing/disconnected
// candidate is skipped (cheaply, no provider work spent) in favor of the next one, so one
// permanently-broken user can never starve the rest.
// -------------------------------------------------------------------------------------------

type SelectedUser = { userId: string; provider: MarketDataProvider };

/**
 * True only for a Prisma error meaning "the specific record this candidate depended on no longer
 * exists" - P2003 (foreign key constraint violation - e.g. ensureMyLstScannerProfileForUser's own
 * ScannerProfile.create failing because the candidate's own User row was deleted between the
 * connected-user query above and this status lookup) or P2025 (an operation expected to find
 * exactly one existing record and found none). Both mean this ONE candidate genuinely vanished
 * mid-selection - never a systemic DB/connection problem (timeout, pool exhaustion, network
 * partition), which must still propagate as a real failure rather than being silently absorbed as
 * if it were just an ordinary unavailable candidate.
 */
function isStaleCandidateError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: string }).code;
  return code === "P2003" || code === "P2025";
}

async function selectNextEligibleUserForTechnicalPreparation(now: Date): Promise<SelectedUser | null> {
  const connectedUserIds = await prisma.brokerConnection.findMany({
    where: { provider: "SCHWAB", status: "CONNECTED", accessTokenCiphertext: { not: null }, refreshTokenCiphertext: { not: null } },
    select: { userId: true },
    distinct: ["userId"],
  });
  if (!connectedUserIds.length) {
    return null;
  }

  // Each candidate's status lookup is isolated - a single candidate that disappeared between the
  // connected-user query above and this lookup (isStaleCandidateError) is skipped, never aborting
  // the whole selection cycle for every other genuinely eligible user. A non-stale error (a real
  // systemic DB/connection failure) rethrows and fails Promise.all as before - never silently
  // swallowed just because it happened inside a per-candidate lookup.
  const statusOutcomes = await Promise.all(
    connectedUserIds.map(async ({ userId }) => {
      try {
        return { userId, status: await getTechnicalPreparationStatusForUser(userId, now) };
      } catch (error) {
        if (isStaleCandidateError(error)) {
          return null;
        }
        throw error;
      }
    }),
  );
  const statuses = statusOutcomes.filter((entry): entry is { userId: string; status: Awaited<ReturnType<typeof getTechnicalPreparationStatusForUser>> } => entry !== null);

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
  | { status: "USER_CYCLE_FAILED" }
  | {
      /** The global daily-candle-availability gate (see checkDailyCandleAvailabilityGate in
       * technical-indicator-cache.ts) was not ready for the selected user - no Phase A quote
       * sweep, no bulk TechnicalPreparationItem creation, no bulk history requests were attempted
       * this invocation. Costs at most 5 read-only price-history probe requests, then stops. */
      status: "DAILY_CANDLE_NOT_READY";
      requiredMarketDate: string;
      freshProbeCount: number;
      staleProbeCount: number;
      unavailableProbeCount: number;
    };

/**
 * One bounded invocation: picks at most one user (see selectNextEligibleUserForTechnicalPreparation),
 * then runs up to MAX_SUB_BATCHES_PER_INVOCATION of the EXISTING, unmodified 25-symbol
 * refreshTechnicalIndicatorCacheBatchForUser batches for them, stopping as soon as ANY of these is
 * true: the run reports 0 remaining (COMPLETE), the sub-batch cap is reached, the wall-clock
 * budget is reached, a batch claimed/processed nothing (meaning everything left is either done or
 * actively claimed by another concurrent invocation - no point spinning further sub-batches), or
 * the VERY FIRST sub-batch call reports DAILY_CANDLE_NOT_READY (the gate result cannot change
 * mid-invocation, so there is no point spending further probe/sub-batch attempts once it's known -
 * see refreshTechnicalIndicatorCacheBatchForUser/getOrCreateActiveTechnicalPreparationRun). A
 * GitHub Actions schedule is expected to call this endpoint repeatedly during a bounded
 * before-open window and simply NO-OP once every connected user is COMPLETE for the day, or once
 * the gate reports not ready.
 */
export async function runTechnicalPreparationOrchestratorCycle(
  now: Date = new Date(),
  options: { probeUniverseSource?: string } = {},
): Promise<TechnicalPreparationOrchestratorResult> {
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
        probeUniverseSource: options.probeUniverseSource,
      });

      if (batch.status === "DAILY_CANDLE_NOT_READY") {
        // Never spend further sub-batch attempts probing again this same invocation - the gate
        // result cannot change within one call, and each probe already cost real requests.
        return {
          status: "DAILY_CANDLE_NOT_READY",
          requiredMarketDate: batch.requiredMarketDate.toISOString().slice(0, 10),
          freshProbeCount: batch.freshProbeCount,
          staleProbeCount: batch.staleProbeCount,
          unavailableProbeCount: batch.unavailableProbeCount,
        };
      }

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
