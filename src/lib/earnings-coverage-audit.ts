import "server-only";

import { getEarningsCalendarCacheStatus, getEarningsCalendarLookup } from "./earnings-calendar-cache";

/**
 * Read-only audit of WHY a ticker's earnings date is UNKNOWN to the scanner's earnings-distance
 * rule, using only the already-cached EarningsCalendarEntry data - makes zero Alpha Vantage
 * calls. Built to explain the real production gap (2,036 Stage 1 survivors, only 418 with a
 * known earnings date, 1,618 unknown - see PROJECT_HANDOFF.md) without adding a second earnings
 * provider or guessing.
 *
 * Categories, in order of how confidently they're determined from existing data alone:
 *  - MATCHED: a cached EarningsCalendarEntry row exists for this ticker.
 *  - NO_CALENDAR_ENTRY: no cached row - genuinely absent from Alpha Vantage's own
 *    EARNINGS_CALENDAR response. This is the expected, structural case for a large share of any
 *    universe: EARNINGS_CALENDAR's horizon is 3 months (ALPHA_VANTAGE_EARNINGS_CALENDAR_HORIZON -
 *    the shortest of the three Alpha Vantage offers), so a company whose next report is further
 *    out than that at the moment of the last refresh will not appear until a later refresh rolls
 *    the window forward. An ETF/ETN also legitimately never reports "earnings" in the corporate
 *    sense and would never appear - but this function deliberately does NOT attempt to infer
 *    "this is an ETF" from ticker/name shape and then relabel it - that would be exactly the kind
 *    of unproven heuristic this audit was asked not to do. NO_CALENDAR_ENTRY covers both cases
 *    (and any other legitimate absence) honestly, without pretending to distinguish them.
 *  - CACHE_STALE: the WHOLE earnings cache itself was stale (not individually refreshed) at the
 *    moment of this audit - every NO_CALENDAR_ENTRY ticker in that case is additionally suspect,
 *    since a stale cache under-reports real coverage across the board, not just for one ticker.
 *    Surfaced as a single cache-level flag (isCacheStale) rather than a per-ticker category,
 *    since it's a property of the whole cache, not of any individual ticker.
 */
export type EarningsCoverageAuditResult = {
  isCacheStale: boolean;
  cacheEntryCount: number;
  lastSuccessfulRefreshAt: string | null;
  matchedCount: number;
  noCalendarEntryCount: number;
  tickers: { ticker: string; category: "MATCHED" | "NO_CALENDAR_ENTRY" }[];
};

export async function auditEarningsCoverageForTickers(tickers: string[], now: Date = new Date()): Promise<EarningsCoverageAuditResult> {
  const normalized = [...new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean))];
  const [cacheStatus, lookup] = await Promise.all([getEarningsCalendarCacheStatus(now), getEarningsCalendarLookup(normalized, now)]);

  const result = normalized.map((ticker) => ({
    ticker,
    category: (lookup.has(ticker) ? "MATCHED" : "NO_CALENDAR_ENTRY") as "MATCHED" | "NO_CALENDAR_ENTRY",
  }));

  return {
    isCacheStale: cacheStatus.isStale,
    cacheEntryCount: cacheStatus.entryCount,
    lastSuccessfulRefreshAt: cacheStatus.lastSuccessfulRefreshAt?.toISOString() ?? null,
    matchedCount: result.filter((r) => r.category === "MATCHED").length,
    noCalendarEntryCount: result.filter((r) => r.category === "NO_CALENDAR_ENTRY").length,
    tickers: result,
  };
}
