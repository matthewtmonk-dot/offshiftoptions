import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "./prisma";

/** Refuses to repair an implausibly large match count - defense in depth in case the predicate
 * below is ever broadened incorrectly; a real "malformed sync" repair should only ever be a
 * handful of rows. */
const DEFAULT_SAFETY_CAP = 200;

export type MalformedRecordCategory = "CASH_LEG_MISIDENTIFIED" | "UNRECOGNIZED_ACTIVITY";

export type SchwabRecordRepairPreview = {
  totalMatched: number;
  countsByCategory: Record<MalformedRecordCategory, number>;
  safetyCapExceeded: boolean;
  /** Opaque hash of the exact matching row-id set at preview time - never the raw ids
   * themselves. The repair call must present this same token; if the live matching set has
   * changed at all (a row got linked, deleted, resolved, or a new one now qualifies), the
   * recomputed hash won't match and the repair refuses, requiring a fresh preview. */
  matchToken: string;
};

export type SchwabRecordRepairResult = {
  deletedCount: number;
};

/**
 * The one narrow, generic, user-scoped signature this bug class produced - never Matt/ticker/
 * account-specific. Shared by both the dry-run preview and the actual repair so their matching
 * sets can never diverge by construction:
 *
 * - this user's own rows only (never another user's, never a client-supplied account id)
 * - SCHWAB_API-sourced only (never touches a CSV import - see BrokerRecordSource)
 * - TRANSACTION kind, NEEDS_REVIEW status, unlinked - reconciliation only ever reads
 *   status="CONFIRMED" rows, so anything CONFIRMED or already linked to a campaign is left
 *   alone unconditionally
 * - action IS NULL - the exact, honest signature every row this normalization bug produced
 *   shares (both the CURRENCY_USD-misidentified trades and the unrecognized expiration-removal
 *   rows had a null action under the old code); any successfully-classified row - including a
 *   dividend, a plain stock trade, or a correctly-normalized option trade - always has a
 *   non-null action and can never match this predicate.
 */
function malformedSchwabTransactionWhere(userId: string): Prisma.BrokerRecordWhereInput {
  return {
    userId,
    provider: "SCHWAB",
    kind: "TRANSACTION",
    status: "NEEDS_REVIEW",
    linkedCampaignId: null,
    action: null,
    sources: { has: "SCHWAB_API" },
  };
}

async function findMalformedRecordIds(userId: string): Promise<{ id: string; symbol: string | null }[]> {
  return prisma.brokerRecord.findMany({
    where: malformedSchwabTransactionWhere(userId),
    select: { id: true, symbol: true },
  });
}

/** A hash, never the raw ids - safe to hand back to the browser and round-trip unmodified. */
function computeMatchToken(ids: string[]): string {
  const sorted = [...ids].sort();
  return createHash("sha256").update(sorted.join(",")).digest("hex");
}

/** Read-only. Safe to call at any time - makes no database writes. */
export async function previewMalformedSchwabTransactionRepairForUser(
  userId: string,
  options: { safetyCap?: number } = {},
): Promise<SchwabRecordRepairPreview> {
  const safetyCap = options.safetyCap ?? DEFAULT_SAFETY_CAP;
  const rows = await findMalformedRecordIds(userId);

  const countsByCategory: Record<MalformedRecordCategory, number> = {
    CASH_LEG_MISIDENTIFIED: 0,
    UNRECOGNIZED_ACTIVITY: 0,
  };
  for (const row of rows) {
    if (row.symbol === "CURRENCY_USD") {
      countsByCategory.CASH_LEG_MISIDENTIFIED += 1;
    } else {
      countsByCategory.UNRECOGNIZED_ACTIVITY += 1;
    }
  }

  return {
    totalMatched: rows.length,
    countsByCategory,
    safetyCapExceeded: rows.length > safetyCap,
    matchToken: computeMatchToken(rows.map((row) => row.id)),
  };
}

/**
 * Deletes only rows matching the exact predicate above, and only if the live matching set at
 * mutation time hashes to the exact same `matchToken` the caller previewed - if anything about
 * the qualifying set has changed since the preview (a row got linked, resolved, deleted, or a
 * new one now qualifies), this refuses and requires a fresh preview rather than silently acting
 * on a different set than what was shown. This re-query is itself the "does every row still
 * qualify" re-check - it never trusts client-supplied ids or a cached list.
 *
 * Delete-then-resync (not update-in-place) is the safe repair here: these rows only ever stored
 * the already-wrong derived values - the raw Schwab payload needed to compute the correct
 * replacement was never persisted, so an in-place patch would need a fresh live Schwab call
 * anyway. Deleting the stale placeholder also clears its identityKey, so a corrected re-sync
 * classifies as a clean "NEW" record instead of colliding into "CONFLICT" against the old one.
 */
export async function repairMalformedSchwabTransactionRecordsForUser(
  userId: string,
  matchToken: string,
  options: { safetyCap?: number } = {},
): Promise<SchwabRecordRepairResult> {
  const safetyCap = options.safetyCap ?? DEFAULT_SAFETY_CAP;
  const rows = await findMalformedRecordIds(userId);
  const ids = rows.map((row) => row.id);

  if (ids.length > safetyCap) {
    throw new Error(`Refusing to repair ${ids.length} records - exceeds the safety cap of ${safetyCap}. Investigate before proceeding.`);
  }
  if (ids.length === 0) {
    return { deletedCount: 0 };
  }

  if (computeMatchToken(ids) !== matchToken) {
    throw new Error("The matching set has changed since you last previewed it. Run Preview again before repairing.");
  }

  // Defense in depth: delete by id AND re-apply the full guard predicate in the same query, so
  // even a hash collision (astronomically unlikely) could never delete a row outside the
  // predicate.
  const result = await prisma.brokerRecord.deleteMany({
    where: { ...malformedSchwabTransactionWhere(userId), id: { in: ids } },
  });
  return { deletedCount: result.count };
}
