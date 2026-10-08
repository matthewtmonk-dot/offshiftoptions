import "server-only";

import { prisma } from "./prisma";
import { resolveRelevantCampaignLegs, tickersNeedingReviewQuotes } from "./position-review-scope";
import { loadOpenAndAssignedCampaignsForUser } from "./workflows";

/**
 * LST "Bounded Scheduled Position Capture" Phase 2A - a small, SCOPED, process-local provider-
 * request budget for scheduled capture ONLY. Deliberately NOT a database table: this is an
 * efficiency/politeness throttle, not a safety mechanism (the real safety guarantee - no duplicate
 * Schwab work across restarts/concurrent triggers - comes from ScheduledCaptureRun's own durable
 * unique constraint, see scheduled-capture.ts). Mirrors the EXACT same accepted "process-local
 * only" precedent already documented and shipped in refresh-guard.ts: lives in this one Node
 * process's memory, resets on restart/redeploy, never shared across multiple server
 * instances/replicas - this module's own doc comment on the MULTI-INSTANCE limitation applies
 * here too. Deliberately scoped to scheduled capture alone - the existing manual-refresh/
 * page-render provider call paths (live-quotes.ts, broker-connections.ts) are completely untouched
 * by this module, so "manual refresh behavior must not regress" holds by construction.
 *
 * Codex blocker repair (B2) - the budget reservation is now a DYNAMIC estimate derived from LOCAL
 * DATABASE STATE (never a live provider call just to measure cost), replacing the original fixed
 * 10-unit guess that could not actually enforce a real ceiling once an owner had more than a
 * handful of accounts/tickers.
 */

const WINDOW_MS = 60_000;

/**
 * Codex blocker repair (B2) - raised from the original 12 to a realistic, JUSTIFIED ceiling. 12
 * was a conservative design target, never an external Schwab-reported limit - but it could not
 * even admit one ordinary single-owner capture once that owner had more than ~10 combined
 * accounts+tickers (the measured real formula, see estimateProviderCost below, already reaches 13
 * for 1 account + 10 tickers). 20 is chosen because it comfortably covers this app's own realistic
 * single-owner captures (small account/ticker counts for OSO's 2 real users) including the token-
 * refresh reserve below, remains FAR below any Schwab-reported per-minute ceiling (this app never
 * designs around an assumed 120/minute entitlement), and is still nowhere near enough headroom for
 * uncontrolled parallel/duplicate captures to run unchecked.
 */
export const MAX_PROVIDER_REQUESTS_PER_MINUTE = 20;

/** OAuth token refresh is NOT deterministically measurable from local state alone (it only
 * happens when a token is missing an expiry or has under 60s remaining - see
 * providers/schwab/tokens.ts) - this app does not pretend to predict it. Instead a FIXED,
 * conservative reserve covers the measured worst case (up to 3 concurrent token-refresh POSTs
 * across the broker-read/quote/session branches, since each resolves its own connection/token
 * independently with no in-flight dedup across them). */
const TOKEN_REFRESH_RESERVE = 3;
/** Codex blocker repair (B1) adds its own cheap session-evidence gate call BEFORE the heavy path
 * even starts; when the session turns out to be open, the heavy path's own session-evidence fetch
 * runs too - so a capture that actually proceeds spends TWO session calls, not one, plus the
 * accounts-list call: B1's gate (1) + the heavy path's accounts-list call (1) + the heavy path's
 * own session call (1) = 3 fixed requests regardless of account/ticker count. */
const FIXED_REQUEST_OVERHEAD = 3;

/**
 * Codex blocker repair (B2) - the real cost estimate, derived ENTIRELY from local database state
 * (zero provider calls just to measure cost): the owner's own Schwab account count (`A` in the
 * measured formula) plus the distinct ticker count their OPEN/ASSIGNED campaigns actually need
 * reviewed (`M`) - the SAME `resolveRelevantCampaignLegs`/`tickersNeedingReviewQuotes` scoping
 * logic the real capture itself uses (position-review-scope.ts), never a second, independently-
 * guessed interpretation of "which tickers need a quote." `A + M + FIXED_REQUEST_OVERHEAD +
 * TOKEN_REFRESH_RESERVE` - the ticket's own worked examples (1 account + 5 tickers = 8 real data
 * requests; 1 account + 10 tickers = 13) describe the formula BEFORE this ticket's own B1 gate
 * call was added (A + M + 2); this estimate reflects the real cost AFTER B1 (A + M + 3, see
 * FIXED_REQUEST_OVERHEAD's own doc comment) plus an honest, documented reserve on top for the
 * token-refresh traffic this app cannot predict in advance - so for 1 account + 5 tickers this
 * reserves 1+5+3+3=12, and for 1 account + 10 tickers it reserves 1+10+3+3=17, both comfortably
 * under MAX_PROVIDER_REQUESTS_PER_MINUTE.
 */
export async function estimateProviderCost(ownerId: string, now: Date): Promise<number> {
  const [accountCount, campaigns] = await Promise.all([
    prisma.tradingAccount.count({ where: { userId: ownerId, source: "SCHWAB" } }),
    loadOpenAndAssignedCampaignsForUser(ownerId),
  ]);
  const { relevant, legByCampaignId } = resolveRelevantCampaignLegs(campaigns, now);
  const tickerCount = tickersNeedingReviewQuotes(relevant, legByCampaignId).length;
  return accountCount + tickerCount + FIXED_REQUEST_OVERHEAD + TOKEN_REFRESH_RESERVE;
}

let windowStartedAtMs = 0;
let usedInWindow = 0;

/**
 * Atomically (within this one process - no cross-request race is possible in a single-threaded
 * Node event loop between the window check and the increment, since neither awaits anything)
 * reserves `estimatedRequests` units of this minute's budget, or refuses if doing so would exceed
 * MAX_PROVIDER_REQUESTS_PER_MINUTE. The window is a simple fixed per-minute bucket (not a true
 * sliding window) - the same bucketing precedent alpha-vantage-budget.ts already uses (there,
 * per-UTC-day; here, per-rolling-60s-from-first-use) - good enough for a conservative efficiency
 * throttle, not claimed to be a precise real-time-accounting mechanism.
 *
 * MULTI-INSTANCE LIMITATION (documented, not solved by this ticket): this budget is process-local.
 * If this app is ever deployed across multiple concurrent server instances/replicas, each would
 * enforce its OWN independent 20/minute ceiling, so the TRUE aggregate ceiling across all
 * instances could exceed 20/minute. This app's current Hostinger deployment is a single persistent
 * Node process (not a multi-replica/serverless fleet), so this is a documented, accepted scope
 * limitation rather than an active risk today - a true cross-instance ceiling would need a durable
 * (database-backed) counter, the same upgrade path refresh-guard.ts's own doc comment already
 * flags for itself.
 */
export function tryReserveProviderRequestBudget(estimatedRequests: number, now: Date = new Date()): boolean {
  const nowMs = now.getTime();
  if (nowMs - windowStartedAtMs >= WINDOW_MS) {
    windowStartedAtMs = nowMs;
    usedInWindow = 0;
  }
  if (usedInWindow + estimatedRequests > MAX_PROVIDER_REQUESTS_PER_MINUTE) {
    return false;
  }
  usedInWindow += estimatedRequests;
  return true;
}

/** Test-only reset - mirrors refresh-guard.ts's clearRefreshGuardsForTests precedent exactly. */
export function resetScheduledCaptureBudgetForTests(): void {
  windowStartedAtMs = 0;
  usedInWindow = 0;
}
