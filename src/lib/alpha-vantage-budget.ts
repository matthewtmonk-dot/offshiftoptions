import "server-only";

import { prisma } from "./prisma";

/**
 * OSO's own tracked daily Alpha Vantage request budget - see PROJECT_HANDOFF.md Alpha Vantage
 * API section. Alpha Vantage's free tier exposes no authoritative "remaining calls" signal, so
 * this is the only source of truth OSO has; it is never claimed authoritative if calls happen
 * outside OSO (a manually-run diagnostic, a different app using the same key, etc).
 *
 * autoCount is hard-capped independently of manualCount so the automatic queue can never use
 * more than ALPHA_VANTAGE_AUTO_DAILY_LIMIT even if manual refresh hasn't used any of its
 * reserve - this is what "reserve 3 calls/day for manual refresh" means in practice: the
 * reservation is guaranteed by the auto side's own cap, not by an artificial cap on manual
 * (manual is a direct, trusted user action and is only bounded by the shared 25/day total).
 */
export const ALPHA_VANTAGE_TOTAL_DAILY_LIMIT = 25;
export const ALPHA_VANTAGE_AUTO_DAILY_LIMIT = 22;
export const ALPHA_VANTAGE_MANUAL_RESERVE = ALPHA_VANTAGE_TOTAL_DAILY_LIMIT - ALPHA_VANTAGE_AUTO_DAILY_LIMIT;

export type AlphaVantageReservationKind = "AUTO" | "MANUAL";

export type AlphaVantageUsageSnapshot = {
  dateKey: string;
  autoCount: number;
  manualCount: number;
  totalCount: number;
  autoRemaining: number;
  totalRemaining: number;
};

/** OSO's tracked usage day is the UTC calendar date - stable regardless of server/browser timezone. */
export function utcDateKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function summarize(dateKey: string, autoCount: number, manualCount: number): AlphaVantageUsageSnapshot {
  const totalCount = autoCount + manualCount;
  return {
    dateKey,
    autoCount,
    manualCount,
    totalCount,
    autoRemaining: Math.max(0, ALPHA_VANTAGE_AUTO_DAILY_LIMIT - autoCount),
    totalRemaining: Math.max(0, ALPHA_VANTAGE_TOTAL_DAILY_LIMIT - totalCount),
  };
}

export async function getAlphaVantageUsageToday(now: Date = new Date()): Promise<AlphaVantageUsageSnapshot> {
  const dateKey = utcDateKey(now);
  const row = await prisma.alphaVantageDailyUsage.findUnique({ where: { date: new Date(`${dateKey}T00:00:00.000Z`) } });
  return summarize(dateKey, row?.autoCount ?? 0, row?.manualCount ?? 0);
}

/**
 * Atomically reserves ONE real Alpha Vantage call slot for today, or refuses if today's budget
 * is exhausted. This is a single guarded UPDATE...RETURNING statement (after an
 * INSERT...ON CONFLICT DO NOTHING to guarantee today's row exists) - never a JS-level
 * read-then-write - so two concurrent reservations racing for the last slot can never both
 * succeed: Postgres serializes concurrent UPDATEs against the same row, and the second
 * transaction's WHERE clause is re-evaluated against the first transaction's already-committed
 * increment. Call this BEFORE making the real Alpha Vantage HTTP request, never after -
 * "tracked" means "we made a real attempt," not "the attempt succeeded."
 */
export async function reserveAlphaVantageCall(
  kind: AlphaVantageReservationKind,
  now: Date = new Date(),
): Promise<{ reserved: boolean; usage: AlphaVantageUsageSnapshot }> {
  const dateKey = utcDateKey(now);

  await prisma.$executeRaw`
    INSERT INTO "AlphaVantageDailyUsage" ("date", "autoCount", "manualCount", "updatedAt")
    VALUES (${dateKey}::date, 0, 0, ${now})
    ON CONFLICT ("date") DO NOTHING
  `;

  const rows =
    kind === "AUTO"
      ? await prisma.$queryRaw<{ autoCount: number; manualCount: number }[]>`
          UPDATE "AlphaVantageDailyUsage"
          SET "autoCount" = "autoCount" + 1, "updatedAt" = ${now}
          WHERE "date" = ${dateKey}::date
            AND "autoCount" < ${ALPHA_VANTAGE_AUTO_DAILY_LIMIT}
            AND ("autoCount" + "manualCount") < ${ALPHA_VANTAGE_TOTAL_DAILY_LIMIT}
          RETURNING "autoCount", "manualCount"
        `
      : await prisma.$queryRaw<{ autoCount: number; manualCount: number }[]>`
          UPDATE "AlphaVantageDailyUsage"
          SET "manualCount" = "manualCount" + 1, "updatedAt" = ${now}
          WHERE "date" = ${dateKey}::date
            AND ("autoCount" + "manualCount") < ${ALPHA_VANTAGE_TOTAL_DAILY_LIMIT}
          RETURNING "autoCount", "manualCount"
        `;

  if (rows.length === 0) {
    return { reserved: false, usage: await getAlphaVantageUsageToday(now) };
  }

  return { reserved: true, usage: summarize(dateKey, rows[0].autoCount, rows[0].manualCount) };
}

/** A stuck lock (crashed process) self-heals after this long, rather than deadlocking the feature forever. */
export const ALPHA_VANTAGE_RUN_LOCK_STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * Single-flight guard: only one caller (the automatic queue OR a manual refresh, from any
 * request) may be mid-flight against the real Alpha Vantage API at a time - "do not
 * parallelize Alpha Vantage OVERVIEW calls" applies across requests, not just within one loop.
 * Claimed via the same atomic UPDATE...RETURNING pattern as the budget reservation above, never
 * by holding a long-lived DB transaction across the actual network calls. Always release with
 * releaseAlphaVantageRunLock() in a `finally` block.
 */
export async function tryAcquireAlphaVantageRunLock(now: Date = new Date()): Promise<boolean> {
  const dateKey = utcDateKey(now);
  const staleThreshold = new Date(now.getTime() - ALPHA_VANTAGE_RUN_LOCK_STALE_AFTER_MS);

  await prisma.$executeRaw`
    INSERT INTO "AlphaVantageDailyUsage" ("date", "autoCount", "manualCount", "updatedAt")
    VALUES (${dateKey}::date, 0, 0, ${now})
    ON CONFLICT ("date") DO NOTHING
  `;

  const rows = await prisma.$queryRaw<{ date: Date }[]>`
    UPDATE "AlphaVantageDailyUsage"
    SET "runningSince" = ${now}, "updatedAt" = ${now}
    WHERE "date" = ${dateKey}::date
      AND ("runningSince" IS NULL OR "runningSince" < ${staleThreshold})
    RETURNING "date"
  `;

  return rows.length > 0;
}

export async function releaseAlphaVantageRunLock(now: Date = new Date()): Promise<void> {
  const dateKey = utcDateKey(now);
  await prisma.$executeRaw`
    UPDATE "AlphaVantageDailyUsage" SET "runningSince" = NULL, "updatedAt" = ${now} WHERE "date" = ${dateKey}::date
  `;
}
