import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "./prisma";

export type OptionableUniverseSymbolInput = {
  ticker: string;
  name: string | null;
};

export type OptionableUniverseRefreshResult =
  | { status: "EMPTY"; message: string }
  | { status: "COUNT_TOO_LOW"; message: string; actualCount: number; minimumExpectedCount: number }
  | { status: "SUCCESS"; source: string; upsertedCount: number; removedCount: number };

export type OptionableUniverseCacheStatus = {
  lastSuccessfulRefreshBySource: Map<string, { lastSeenAt: Date; symbolCount: number }>;
  totalSymbolCount: number;
};

/**
 * Generic, source-agnostic, atomic/failure-safe refresh of the public OptionableUniverseSymbol
 * cache (Tier 2 of the scanner's broad universe - see docs/SCANNER_RULES.md). Deliberately
 * decoupled from HOW the symbol list was obtained - the caller is responsible for fetching (see
 * src/providers/occ/directory-of-listed-products.ts) and any source-specific terms-of-use
 * decision; this function only ever receives an already-fetched, already-decided-safe-to-use
 * symbol list.
 *
 * Required behavior (see PROJECT_HANDOFF.md "refresh safety"): a partial/failed fetch must
 * never destroy the existing universe. This function is only ever called with a COMPLETE,
 * already-parsed dataset - if the caller's fetch/parse failed, it must never call this function
 * at all, leaving yesterday's rows (and their own lastSeenAt) completely untouched. Within this
 * function itself: symbols are deduplicated and sanity-checked BEFORE any write; only a
 * genuinely successful validation reaches the upsert; and pruning (removing this source's
 * symbols not confirmed by this refresh) only ever runs AFTER the fresh batch is durably
 * written - a crash between upsert and prune simply leaves a few stale rows to be caught by the
 * next successful refresh, never a destroyed cache.
 */
export async function refreshOptionableUniverseCache(
  symbols: OptionableUniverseSymbolInput[],
  source: string,
  options: { now?: Date; minimumExpectedCount?: number } = {},
): Promise<OptionableUniverseRefreshResult> {
  const now = options.now ?? new Date();

  const deduped = dedupeSymbols(symbols);
  if (!deduped.length) {
    return { status: "EMPTY", message: `No usable symbols to refresh for source "${source}".` };
  }

  if (options.minimumExpectedCount !== undefined && deduped.length < options.minimumExpectedCount) {
    return {
      status: "COUNT_TOO_LOW",
      message: `Refresh for source "${source}" returned ${deduped.length} symbols, below the expected minimum of ${options.minimumExpectedCount} - likely a truncated or malformed fetch. Cache left untouched.`,
      actualCount: deduped.length,
      minimumExpectedCount: options.minimumExpectedCount,
    };
  }

  await bulkUpsertSymbols(deduped, source, now);

  // Only now, after the fresh batch is durably written: a symbol previously seen under this
  // SAME source that this refresh did NOT confirm is genuinely gone from the universe (e.g.
  // delisted, or lost its listed options) - remove it. Never touches another source's rows.
  const removed = await prisma.optionableUniverseSymbol.deleteMany({
    where: { source, lastSeenAt: { lt: now } },
  });

  return { status: "SUCCESS", source, upsertedCount: deduped.length, removedCount: removed.count };
}

function dedupeSymbols(symbols: OptionableUniverseSymbolInput[]): OptionableUniverseSymbolInput[] {
  const byTicker = new Map<string, OptionableUniverseSymbolInput>();
  for (const symbol of symbols) {
    const ticker = symbol.ticker.trim().toUpperCase();
    if (!ticker) {
      continue;
    }
    byTicker.set(ticker, { ticker, name: symbol.name });
  }
  return [...byTicker.values()];
}

/** One native Postgres multi-row UPSERT rather than one call per symbol - a real broad universe
 * can be 3,000+ rows; this keeps a full refresh to one round trip. */
async function bulkUpsertSymbols(symbols: OptionableUniverseSymbolInput[], source: string, lastSeenAt: Date): Promise<void> {
  const values = Prisma.join(
    symbols.map((symbol) => Prisma.sql`(${symbol.ticker}, ${symbol.name}, ${source}, ${lastSeenAt}, ${lastSeenAt})`),
  );

  await prisma.$executeRaw`
    INSERT INTO "OptionableUniverseSymbol" ("ticker", "name", "source", "lastSeenAt", "updatedAt")
    VALUES ${values}
    ON CONFLICT ("ticker") DO UPDATE SET
      "name" = EXCLUDED."name",
      "source" = EXCLUDED."source",
      "lastSeenAt" = EXCLUDED."lastSeenAt",
      "updatedAt" = EXCLUDED."updatedAt"
  `;
}

/** Read-only status derived entirely from the cache's own rows - no separate refresh-log table
 * (per the "no excessive new infrastructure" direction). One row per source with its own most
 * recent lastSeenAt and current row count. */
export async function getOptionableUniverseCacheStatus(): Promise<OptionableUniverseCacheStatus> {
  const rows = await prisma.optionableUniverseSymbol.groupBy({
    by: ["source"],
    _max: { lastSeenAt: true },
    _count: { _all: true },
  });

  const lastSuccessfulRefreshBySource = new Map<string, { lastSeenAt: Date; symbolCount: number }>();
  let totalSymbolCount = 0;
  for (const row of rows) {
    if (row._max.lastSeenAt) {
      lastSuccessfulRefreshBySource.set(row.source, { lastSeenAt: row._max.lastSeenAt, symbolCount: row._count._all });
    }
    totalSymbolCount += row._count._all;
  }

  return { lastSuccessfulRefreshBySource, totalSymbolCount };
}
