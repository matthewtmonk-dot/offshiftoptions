import "server-only";

import type { BrokerPosition } from "@/providers/broker-read/types";
import type { EquityMarketSessionEvidence, QuoteReviewEvidence } from "@/providers/market-data/types";

/**
 * Codex blocker repair (C, final) - the server-validated replacement for the untrusted
 * `?oso_skip_live=1` URL parameter the prior pass used. That parameter was accepted at face
 * value by Dashboard/Tracker with no proof a refresh had actually failed, and it forced EVERY
 * campaign's position/quote/session evidence to "unavailable" unconditionally - which could
 * suppress a REAL contradiction (a quantity mismatch, an already-ended expiration session) that
 * live broker/session data would otherwise have caught, simply by nulling out evidence that may
 * actually still have been available.
 *
 * This module is a small, process-local (same honest limitation as refresh-guard.ts - resets on
 * restart, never shared across server instances), in-memory store of exactly what a FAILED manual
 * refresh attempt actually retrieved, keyed ONLY by the authenticated owner's userId - never by
 * any client-supplied token, cookie, or URL value. A page can only ever "consume" a receipt for
 * the user its OWN authenticated session (`requireCurrentUser()`) already established; there is
 * no capability here a client request could forge, replay, or redirect to another owner.
 *
 * Ordering/safety guarantees:
 * - `recordRefreshOutcome` is idempotent-safe under refresh-guard.ts's own COALESCED semantics
 *   (every joiner for the same generation may call it; only the first actually mutates state).
 * - A result from an OLDER generation than the last one already recorded for this user is
 *   IGNORED entirely (covers a stale, abandoned, or superseded attempt completing late - Codex's
 *   own "superseded receipts must fail closed" requirement).
 * - A genuine SUCCESS clears any stale receipt outright - fresh live data is now available in the
 *   normal cache, so there is nothing left to "retain."
 * - `consumeFailedRefreshReceipt` is one-shot (deleted on read, valid or not) and additionally
 *   fails closed on an expired receipt - a page that doesn't need it (e.g. Tracker's Performance
 *   tab) should not call this, so the one real resolution opportunity isn't wasted on a render
 *   that never uses it.
 */
export type RetainedPositionEvidence = {
  /** The REAL broker positions actually retrieved during the failed attempt, or `null` only when
   * the broker-positions fetch itself genuinely failed (never a blanket override when positions
   * actually succeeded) - preserving this is what lets a real quantity-mismatch/coverage/
   * assignment contradiction still be detected even though some OTHER piece of evidence failed. */
  brokerPositions: (BrokerPosition & { accountLabel: string })[] | null;
  /** Whatever per-ticker quote evidence was actually obtained - a ticker missing from this map is
   * treated as "not requested" (the same honest fallback resolvePositionReviewsForUser already
   * applies today for any ticker it didn't fetch). */
  quoteEvidenceByTicker: Map<string, QuoteReviewEvidence>;
  /** The REAL session evidence actually obtained - may be AVAILABLE even when the overall attempt
   * failed for an unrelated reason (e.g. one ticker's quote failed while session evidence
   * succeeded), which is exactly what preserves "expiration session already ended" detection. */
  sessionEvidence: EquityMarketSessionEvidence;
};

type Receipt = {
  generation: number;
  expiresAt: number;
  evidence: RetainedPositionEvidence;
};

const lastSeenGenerationByUser = new Map<string, number>();
const receiptsByUser = new Map<string, Receipt>();

/** How long a failed attempt's retained evidence stays available for the ONE subsequent render
 * that will consume it - generous enough to cover a normal client round-trip
 * (result -> router.refresh()) without ever becoming a durable cache. */
export const FAILED_REFRESH_RECEIPT_TTL_MS = 20_000;

function isStaleOrSuperseded(userId: string, generation: number): boolean {
  const lastSeen = lastSeenGenerationByUser.get(userId) ?? 0;
  return generation <= lastSeen;
}

/**
 * Called for every genuinely NEW attempt's outcome (EXECUTED or COALESCED - never COOLDOWN, which
 * performed no new work and has nothing new to record). A result whose `generation` is not
 * strictly newer than the last one already recorded for this user is ignored outright - this is
 * what makes a stale/abandoned attempt's late resolution unable to overwrite a newer attempt's
 * already-recorded state, no matter the arrival order.
 */
export function recordRefreshOutcome(
  userId: string,
  generation: number,
  outcome: { ok: true } | { ok: false; evidence: RetainedPositionEvidence },
  ttlMs: number = FAILED_REFRESH_RECEIPT_TTL_MS,
  now: () => number = Date.now,
): void {
  if (isStaleOrSuperseded(userId, generation)) {
    return;
  }
  lastSeenGenerationByUser.set(userId, generation);

  if (outcome.ok) {
    // A genuine success means fresh live data is already in the normal cache - any stale receipt
    // from an earlier failed attempt for this same user is no longer relevant.
    receiptsByUser.delete(userId);
    return;
  }
  receiptsByUser.set(userId, { generation, expiresAt: now() + ttlMs, evidence: outcome.evidence });
}

/**
 * One-shot, owner-scoped read: returns the retained evidence from this user's most recent failed
 * refresh attempt, or `null` when there is none (no recent failure), it has already been consumed,
 * or it has expired. Always deletes the stored receipt, valid or not - a page that calls this and
 * gets `null` back must proceed with its own normal live-evidence resolution, never retry the read.
 */
export function consumeFailedRefreshReceipt(userId: string, now: () => number = Date.now): RetainedPositionEvidence | null {
  const receipt = receiptsByUser.get(userId);
  if (!receipt) {
    return null;
  }
  receiptsByUser.delete(userId);
  if (now() > receipt.expiresAt) {
    return null;
  }
  return receipt.evidence;
}

export function clearFailedRefreshReceiptsForTests() {
  lastSeenGenerationByUser.clear();
  receiptsByUser.clear();
}
