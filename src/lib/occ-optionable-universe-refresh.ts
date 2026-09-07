import "server-only";

import { fetchOccOptionableSymbols } from "@/providers/occ/directory-of-listed-products";
import { refreshOptionableUniverseCache } from "./optionable-universe-cache";

export const OCC_OPTIONABLE_UNIVERSE_SOURCE = "OCC";

export type OccUniverseRefreshResult =
  | { status: "EMPTY"; message: string }
  | { status: "COUNT_TOO_LOW"; message: string; actualCount: number; minimumExpectedCount: number }
  | {
      status: "SUCCESS";
      source: string;
      rawRowCount: number;
      excludedRowCount: number;
      upsertedCount: number;
      removedCount: number;
    };

/**
 * OCC currently returns ~6,000 real Equity Underlying rows (live-verified 2026-09) - a genuinely
 * malformed/truncated fetch (e.g. a WAF challenge page, a network-level partial response) would
 * be nowhere close to this. This guard rejects (and leaves the previous cache untouched) rather
 * than trusting a suspiciously small fetch, per the same "refresh safety" requirement already
 * enforced generically inside refreshOptionableUniverseCache.
 */
const MINIMUM_EXPECTED_SYMBOL_COUNT = 1000;

/**
 * Fetches OCC's current Directory of Listed Products (prodType=EU) and refreshes the shared,
 * source-agnostic OptionableUniverseSymbol cache. NOT wired into any scheduled/automatic trigger
 * - this function performs one fetch+refresh when called, nothing more. Not yet scheduled in
 * production per the OCC-source-change task's explicit "do NOT schedule OCC refresh in
 * production" instruction.
 */
export async function refreshOccOptionableUniverse(options: { now?: Date } = {}): Promise<OccUniverseRefreshResult> {
  const fetchResult = await fetchOccOptionableSymbols();
  if (fetchResult.outcome !== "SUCCESS") {
    return { status: "EMPTY", message: fetchResult.message };
  }

  const result = await refreshOptionableUniverseCache(fetchResult.symbols, OCC_OPTIONABLE_UNIVERSE_SOURCE, {
    now: options.now,
    minimumExpectedCount: MINIMUM_EXPECTED_SYMBOL_COUNT,
  });

  if (result.status !== "SUCCESS") {
    return result;
  }

  return { ...result, rawRowCount: fetchResult.rawRowCount, excludedRowCount: fetchResult.excludedRowCount };
}
