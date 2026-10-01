import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "./prisma";
import {
  reserveAlphaVantageCall,
  tryAcquireAlphaVantageRunLock,
  releaseAlphaVantageRunLock,
  getAlphaVantageUsageToday,
  type AlphaVantageReservationKind,
  type AlphaVantageUsageSnapshot,
} from "./alpha-vantage-budget";
import { getAlphaVantageApiKey } from "@/providers/alpha-vantage/config";
import { fetchAlphaVantageEarningsCalendar, type EarningsCalendarEntry } from "@/providers/alpha-vantage/earnings-calendar";
import type { AlphaVantageFetch } from "@/providers/alpha-vantage/client";
import { selectEarningsEvidenceFromRows, type TickerEarningsEvidence } from "@/domain/finance/earningsEvidence";

/**
 * How long a successful refresh stays "fresh" before the scanner should try again - a bit under
 * 24h so a fixed-time daily cron always finds yesterday's cache stale, never skipping a day due
 * to clock drift. Deliberately NOT a separate table/counter - freshness is derived from the
 * cache's own MAX(fetchedAt), per the "no excessive new infrastructure" direction.
 */
export const EARNINGS_CALENDAR_REFRESH_INTERVAL_MS = 20 * 60 * 60 * 1000;

export type EarningsCalendarCacheStatus = {
  lastSuccessfulRefreshAt: Date | null;
  entryCount: number;
  isStale: boolean;
};

export async function getEarningsCalendarCacheStatus(now: Date = new Date()): Promise<EarningsCalendarCacheStatus> {
  const [latest, entryCount] = await Promise.all([
    prisma.earningsCalendarEntry.findFirst({ orderBy: { fetchedAt: "desc" }, select: { fetchedAt: true } }),
    prisma.earningsCalendarEntry.count(),
  ]);

  const lastSuccessfulRefreshAt = latest?.fetchedAt ?? null;
  const isStale = !lastSuccessfulRefreshAt || now.getTime() - lastSuccessfulRefreshAt.getTime() > EARNINGS_CALENDAR_REFRESH_INTERVAL_MS;

  return { lastSuccessfulRefreshAt, entryCount, isStale };
}

export type EarningsCalendarRefreshResult =
  | { status: "NO_API_KEY" }
  | { status: "LOCK_UNAVAILABLE" }
  | { status: "BUDGET_EXHAUSTED"; usage: AlphaVantageUsageSnapshot }
  | { status: "ALREADY_FRESH"; cache: EarningsCalendarCacheStatus }
  | { status: "FETCH_FAILED"; outcome: "RATE_LIMITED" | "ERROR_MESSAGE" | "EMPTY" | "HTTP_ERROR"; message?: string; httpStatus?: number }
  | { status: "SUCCESS"; entryCount: number; prunedCount: number; supersededCount: number; usage: AlphaVantageUsageSnapshot };

type RefreshOptions = {
  now?: Date;
  force?: boolean;
  reservationKind?: AlphaVantageReservationKind;
  fetchFn?: AlphaVantageFetch;
};

/**
 * One shared, cached EARNINGS_CALENDAR refresh - costs exactly ONE reservation against the
 * existing shared 25/day Alpha Vantage budget (see alpha-vantage-budget.ts), regardless of how
 * many tickers the resulting cache covers. Never called from a scan/page-render path or once
 * per scanned ticker - this is the sole place Alpha Vantage is asked for earnings data.
 *
 * Failure-safe by construction: the real HTTP fetch happens BEFORE any write. A RATE_LIMITED /
 * ERROR_MESSAGE / EMPTY / HTTP_ERROR outcome returns immediately without touching
 * EarningsCalendarEntry at all - the prior day's cache (now correctly reported as stale via
 * getEarningsCalendarCacheStatus) remains fully queryable. Only a genuinely successful fetch
 * writes anything.
 *
 * Response coherence: a successful response represents ONE coherent observation of each
 * mentioned ticker's schedule. The upsert (write/refresh fetchedAt for every row this response
 * confirmed) and the "supersede" delete (remove any OTHER future-dated row this response's own
 * tickers already had cached, from an earlier observation) run together in a single DB
 * transaction - either both apply or neither does, so a ticker can never end up with two
 * competing future report dates where one is simply forgotten stale data (see
 * EARNINGS_CALENDAR_REFRESH_INTERVAL_MS's own evidence-contract notes and
 * domain/finance/earningsEvidence.ts). A ticker NOT mentioned in this response is never touched -
 * absence from one response is not proof of "no earnings," so its prior evidence (if any) is left
 * exactly as it was. Pruning already-past reportDates (for ANY ticker, not just this response's)
 * remains its own separate, slightly looser-timing step after the transaction - a crash between
 * the transaction and this prune simply leaves a few already-past rows to be pruned on the next
 * successful refresh, never a destroyed or incoherent "current schedule" cache.
 */
export async function refreshEarningsCalendarCache(options: RefreshOptions = {}): Promise<EarningsCalendarRefreshResult> {
  const now = options.now ?? new Date();
  const apiKey = getAlphaVantageApiKey();
  if (!apiKey) {
    return { status: "NO_API_KEY" };
  }

  if (!options.force) {
    const cache = await getEarningsCalendarCacheStatus(now);
    if (!cache.isStale) {
      return { status: "ALREADY_FRESH", cache };
    }
  }

  const acquired = await tryAcquireAlphaVantageRunLock(now);
  if (!acquired) {
    return { status: "LOCK_UNAVAILABLE" };
  }

  try {
    const reservation = await reserveAlphaVantageCall(options.reservationKind ?? "AUTO", now);
    if (!reservation.reserved) {
      return { status: "BUDGET_EXHAUSTED", usage: reservation.usage };
    }

    const result = await fetchAlphaVantageEarningsCalendar({ apiKey, fetchFn: options.fetchFn });
    if (result.outcome !== "SUCCESS") {
      return {
        status: "FETCH_FAILED",
        outcome: result.outcome,
        message: "message" in result ? result.message : undefined,
        httpStatus: result.outcome === "HTTP_ERROR" ? result.status : undefined,
      };
    }

    const deduped = dedupeEntries(result.entries);
    let supersededCount = 0;
    if (deduped.length > 0) {
      const [, supersedeResult] = await prisma.$transaction([
        buildUpsertQuery(deduped, now),
        buildSupersedeDeleteQuery(deduped, now),
      ]);
      supersededCount = supersedeResult;
    }

    // Retention rule: a report date that has already passed is never useful to an
    // earnings-distance rule (which only ever measures days UNTIL a future report) - prune it
    // only now, after the fresh batch is durably written.
    const pruned = await prisma.earningsCalendarEntry.deleteMany({ where: { reportDate: { lt: dateOnlyUtc(now) } } });

    return {
      status: "SUCCESS",
      entryCount: deduped.length,
      prunedCount: pruned.count,
      supersededCount,
      usage: await getAlphaVantageUsageToday(now),
    };
  } finally {
    await releaseAlphaVantageRunLock(now);
  }
}

/** A ticker could legitimately appear twice in the raw CSV in rare data-quality cases (e.g. two
 * share classes briefly sharing a row) - since (ticker, reportDate) is the table's primary key,
 * the last occurrence wins rather than letting a bulk upsert choke on a duplicate key. */
function dedupeEntries(entries: EarningsCalendarEntry[]): EarningsCalendarEntry[] {
  const byKey = new Map<string, EarningsCalendarEntry>();
  for (const entry of entries) {
    byKey.set(`${entry.ticker}:${entry.reportDate.toISOString()}`, entry);
  }
  return [...byKey.values()];
}

/**
 * A single native Postgres multi-row UPSERT (INSERT ... ON CONFLICT DO UPDATE) rather than one
 * upsert call per ticker - a full refresh can cover ~1,400+ companies, and this keeps that to
 * one round trip and one atomic statement instead of thousands of individual queries.
 * `fetchedAt` is touched on every row this refresh confirmed (new or already-known), so
 * getEarningsCalendarCacheStatus's MAX(fetchedAt) always reflects the most recent full,
 * successful refresh. Returns the un-awaited query so the caller can run it inside a
 * `prisma.$transaction([...])` together with buildSupersedeDeleteQuery.
 */
function buildUpsertQuery(entries: EarningsCalendarEntry[], fetchedAt: Date) {
  const values = Prisma.join(
    entries.map((entry) => Prisma.sql`(${entry.ticker}, ${entry.reportDate}::date, ${fetchedAt})`),
  );

  return prisma.$executeRaw`
    INSERT INTO "EarningsCalendarEntry" ("ticker", "reportDate", "fetchedAt")
    VALUES ${values}
    ON CONFLICT ("ticker", "reportDate") DO UPDATE SET "fetchedAt" = EXCLUDED."fetchedAt"
  `;
}

/**
 * Deletes any OTHER future-dated row this response's own tickers already had cached from an
 * earlier observation - the fix for "earliest stored future date is not necessarily the
 * provider's current next scheduled report" / "multiple future dates can coexist" (see this
 * module's own refreshEarningsCalendarCache doc comment). Scoped to:
 *  - only tickers mentioned in THIS response (a ticker this response is silent about is never
 *    touched - absence is not proof of "no earnings")
 *  - only reportDate >= today (already-past rows are left to the existing separate prune step)
 *  - only rows whose exact (ticker, reportDate) pair is NOT part of this response's own batch
 * Returns the un-awaited query so the caller can run it in the same transaction as the upsert -
 * both must apply together or neither does, or a ticker could transiently end up with zero
 * current rows (crash after delete, before upsert) or two competing ones (crash after upsert,
 * before delete).
 */
function buildSupersedeDeleteQuery(entries: EarningsCalendarEntry[], now: Date) {
  const tickers = [...new Set(entries.map((entry) => entry.ticker))];
  const batchValues = Prisma.join(entries.map((entry) => Prisma.sql`(${entry.ticker}, ${entry.reportDate}::date)`));

  return prisma.$executeRaw`
    DELETE FROM "EarningsCalendarEntry" e
    WHERE e."ticker" = ANY(${tickers}::text[])
      AND e."reportDate" >= ${dateOnlyUtc(now)}::date
      AND NOT EXISTS (
        SELECT 1 FROM (VALUES ${batchValues}) AS batch("ticker", "reportDate")
        WHERE batch."ticker" = e."ticker" AND batch."reportDate" = e."reportDate"
      )
  `;
}

function dateOnlyUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export type TickerEarningsLookup = {
  reportDate: Date;
  daysUntilReport: number;
};

/**
 * Read-only, zero-Alpha-Vantage-call lookup for the scanner's earnings-distance rule - looks up
 * whatever is already cached, never triggers a fetch. Returns the SOONEST upcoming report date
 * for each ticker (a ticker can appear more than once across horizons in rare cases); a ticker
 * absent from the map means "no cached earnings data" (genuinely UNKNOWN), never a fabricated
 * absence-of-earnings claim - see resolveEarningsDistanceForTicker in the scanner integration.
 */
export async function getEarningsCalendarLookup(tickers: string[], now: Date = new Date()): Promise<Map<string, TickerEarningsLookup>> {
  const normalized = [...new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean))];
  if (!normalized.length) {
    return new Map();
  }

  const today = dateOnlyUtc(now);
  const rows = await prisma.earningsCalendarEntry.findMany({
    where: { ticker: { in: normalized }, reportDate: { gte: today } },
    orderBy: { reportDate: "asc" },
  });

  const map = new Map<string, TickerEarningsLookup>();
  for (const row of rows) {
    if (map.has(row.ticker)) {
      continue; // already have the soonest (rows are ordered ascending by reportDate)
    }
    const daysUntilReport = Math.round((row.reportDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
    map.set(row.ticker, { reportDate: row.reportDate, daysUntilReport });
  }
  return map;
}

/**
 * Evidence-oriented earnings lookup for future Trade Prep (see domain/finance/earningsEvidence.ts
 * for the full status/selection contract). Strictly additive - existing Scanner behavior keeps
 * using getEarningsCalendarLookup above, unchanged, so this function has no production call site
 * yet and does not alter what the Scanner sees.
 *
 * Unlike getEarningsCalendarLookup, EVERY requested ticker gets an explicit entry in the returned
 * Map, even ones with no cached row at all (status: NO_EVIDENCE) - so a caller can distinguish
 * "we checked and found nothing" from "we never checked this ticker," which an omitted Map key
 * cannot express on its own.
 */
export async function getEarningsEvidenceLookup(
  tickers: string[],
  now: Date = new Date(),
  freshnessWindowMs: number = EARNINGS_CALENDAR_REFRESH_INTERVAL_MS,
): Promise<Map<string, TickerEarningsEvidence>> {
  const normalized = [...new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean))];
  if (!normalized.length) {
    return new Map();
  }

  const today = dateOnlyUtc(now);
  const rows = await prisma.earningsCalendarEntry.findMany({
    where: { ticker: { in: normalized }, reportDate: { gte: today } },
  });

  return selectEarningsEvidenceFromRows(normalized, rows, now, freshnessWindowMs);
}
