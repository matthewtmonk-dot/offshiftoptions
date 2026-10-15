import "server-only";

import {
  enrichPersistedStockStageRow,
  expirationWindowFor,
  isPersistedRowOptionCheckable,
  weeklyHorizonFor,
} from "@/domain/scanner/live-scan";
import { GATING_RULE_KEYS, resultsPredateCurrentSettings, scannerRulesFromRecords } from "@/domain/scanner/profile";
import { classifyReadiness } from "@/domain/scanner/scanner";
import type { MarketDataProvider } from "@/providers/market-data/types";
import { getSchwabMarketDataProviderForUser } from "./broker-connections";
import { mapWithConcurrency } from "./concurrency";
import { prisma } from "./prisma";
import { ensureMyLstScannerProfileForUser } from "./workflows";

/**
 * "Check options" - price the options of stock-qualified candidates that the last live scan
 * stock-screened but had no chain budget for (optionEnrichment NOT_ENRICHED_BUDGET), a bounded
 * batch at a time, so the Scanner can show every name that truly qualifies instead of only the
 * 8 most-oversold ones.
 *
 * Safety properties (each covered by scanner-option-check.test.ts):
 *  - Owner-scoped: only the signed-in user's own latest scan run is read or written.
 *  - Reuses the scan's own contract-selection and criterion evaluation (enrichPersistedStockStageRow)
 *    - no second scoring path - and replaces a row's criterion results atomically with its new snapshot.
 *  - Never fabricates: a failed or rate-limited chain request leaves that row UNTOUCHED (still
 *    "waiting for an option check") so it can be retried; it is never recorded as "no options".
 *  - Never mixes rule sets: refuses when the user's rules changed after the scan, and refuses a scan
 *    older than MAX_SCAN_AGE_MS, because the stored stock price/RSI/Bollinger come from scan time.
 *  - Bounded provider usage: at most `batchSize` chain requests per call, concurrency capped.
 *  - Read-only toward the brokerage: only option-chain market data is requested; no order/account APIs.
 */
export const OPTION_CHECK_BATCH_SIZE = 12;
/** Conservative: Schwab publishes no per-connection limit, and the provider has no 429 backoff. */
export const OPTION_CHECK_CONCURRENCY = 3;
/** Stored prices/indicators are as of scan time; beyond this the user should simply rescan. */
export const MAX_SCAN_AGE_MS = 24 * 60 * 60 * 1000;

export type OptionCheckOutcome =
  | {
      ok: true;
      /** Rows whose options were priced and saved this call. */
      checked: number;
      /** Chain requests that failed (left untouched, retryable). */
      failedLookups: number;
      /** Stock-qualified rows still waiting for an option check after this call. */
      remaining: number;
      /** Of the rows checked this call, how many ended up PASS / NEAR. */
      newPass: number;
      newNear: number;
    }
  | { ok: false; error: string };

type StoredRow = { id: string; ticker: string; snapshotJson: unknown };

function asValues(snapshot: unknown): Record<string, number | string | boolean | null | undefined> {
  return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? (snapshot as Record<string, number | string | boolean | null | undefined>) : {};
}

function rankOf(values: Record<string, unknown>): number {
  const rsi = Number(values.rsi);
  const bb = Number(values.bbPercent);
  return (Number.isFinite(rsi) && values.rsi !== null ? rsi : 100) + (Number.isFinite(bb) && values.bbPercent !== null ? bb : 100) / 10;
}

export async function checkMoreScannerOptionsForUser(
  userId: string,
  options: { provider?: MarketDataProvider | null; now?: Date; batchSize?: number } = {},
): Promise<OptionCheckOutcome> {
  const now = options.now ?? new Date();
  const batchSize = Math.max(1, Math.min(options.batchSize ?? OPTION_CHECK_BATCH_SIZE, OPTION_CHECK_BATCH_SIZE));

  const run = await prisma.scanRun.findFirst({
    where: { ownerId: userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, source: true, createdAt: true, results: { select: { id: true, ticker: true, snapshotJson: true } } },
  });
  if (!run || run.source !== "LIVE:SCHWAB") {
    return { ok: false, error: "Run a live scan first - there are no live results to check yet." };
  }
  if (now.getTime() - run.createdAt.getTime() > MAX_SCAN_AGE_MS) {
    return { ok: false, error: "This scan is more than a day old, so its prices are stale. Run a new live scan first." };
  }

  const profile = await ensureMyLstScannerProfileForUser(userId);
  const stamp = asValues(run.results[0]?.snapshotJson).settingsRevisionAsOf;
  const evaluatedAt = typeof stamp === "string" && Number.isFinite(Date.parse(stamp)) ? new Date(stamp) : run.createdAt;
  if (resultsPredateCurrentSettings(profile.updatedAt, evaluatedAt)) {
    return { ok: false, error: "Your scanner rules changed after this scan. Run a new live scan first so every row uses the same rules." };
  }
  const records = await prisma.scannerRule.findMany({ where: { profileId: profile.id }, orderBy: { sortOrder: "asc" } });
  const rules = scannerRulesFromRecords(records);

  const awaiting = (run.results as StoredRow[]).filter((row) => {
    const values = asValues(row.snapshotJson);
    return values.optionEnrichment === "NOT_ENRICHED_BUDGET" && !values.technicalReasonCode && isPersistedRowOptionCheckable(values, rules);
  });
  if (awaiting.length === 0) {
    return { ok: true, checked: 0, failedLookups: 0, remaining: 0, newPass: 0, newNear: 0 };
  }
  const batch = [...awaiting]
    .sort((left, right) => rankOf(asValues(left.snapshotJson)) - rankOf(asValues(right.snapshotJson)) || (left.ticker < right.ticker ? -1 : left.ticker > right.ticker ? 1 : 0))
    .slice(0, batchSize);

  const provider = options.provider === undefined ? await getSchwabMarketDataProviderForUser(userId) : options.provider;
  if (!provider) {
    return { ok: false, error: "LIVE DATA UNAVAILABLE: connect Schwab in Account settings first." };
  }

  const chainRequest = { ...expirationWindowFor(weeklyHorizonFor(rules), now), contractType: "PUT" as const };
  const fetched = await mapWithConcurrency(batch, OPTION_CHECK_CONCURRENCY, async (row) => {
    try {
      return { row, options: await provider.getOptionChain(row.ticker, chainRequest), ok: true as const };
    } catch {
      return { row, options: [], ok: false as const };
    }
  });

  const updates = fetched.flatMap((entry) => {
    if (!entry.ok) return [];
    const result = enrichPersistedStockStageRow({ values: asValues(entry.row.snapshotJson), options: entry.options, rules, asOf: now });
    return result ? [{ id: entry.row.id, ...result }] : [];
  });

  let newPass = 0;
  let newNear = 0;
  if (updates.length > 0) {
    await prisma.$transaction(
      updates.flatMap((update) => [
        prisma.scanResult.update({
          where: { id: update.id },
          data: {
            summaryStatus: update.summary.status,
            passedCriteria: update.summary.passed,
            totalCriteria: update.summary.total,
            snapshotJson: Object.fromEntries(Object.entries(update.values).map(([key, value]) => [key, value ?? null])),
          },
        }),
        prisma.scanCriterionResult.deleteMany({ where: { scanResultId: update.id } }),
        prisma.scanCriterionResult.createMany({
          data: update.summary.results.map((result) => ({
            scanResultId: update.id,
            criterionName: result.name,
            actualValue: result.actualValue === undefined || result.actualValue === null ? null : String(result.actualValue),
            operator: result.operator,
            desiredValue: JSON.stringify(result.desiredValue),
            status: result.status,
            explanation: result.explanation,
          })),
        }),
      ]),
    );
    for (const update of updates) {
      const readiness = classifyReadiness(update.summary, GATING_RULE_KEYS, update.values.optionEnrichment, update.values.contractReasonCode);
      if (readiness === "PASS") newPass += 1;
      if (readiness === "NEAR") newNear += 1;
    }
  }

  return {
    ok: true,
    checked: updates.length,
    failedLookups: fetched.filter((entry) => !entry.ok).length,
    remaining: awaiting.length - updates.length,
    newPass,
    newNear,
  };
}
