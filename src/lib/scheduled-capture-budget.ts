import "server-only";

/**
 * LST "Bounded Scheduled Position Capture" Phase 2A - a small, SCOPED, process-local provider-
 * request budget for scheduled capture ONLY. Deliberately NOT a database table: this is an
 * efficiency/politeness throttle, not a safety mechanism (the real safety guarantee - no duplicate
 * Schwab work across restarts/concurrent triggers - comes from ScheduledCaptureRun's own durable
 * unique constraint, see scheduled-capture.ts). Mirrors the EXACT same accepted "process-local
 * only" precedent already documented and shipped in refresh-guard.ts: lives in this one Node
 * process's memory, resets on restart/redeploy, never shared across multiple server
 * instances/replicas. Deliberately scoped to scheduled capture alone - the existing manual-refresh/
 * page-render provider call paths (live-quotes.ts, broker-connections.ts) are completely untouched
 * by this module, so "manual refresh behavior must not regress" holds by construction.
 *
 * Budget is spent by ESTIMATE, reserved BEFORE a capture attempt starts (never after) - the same
 * "reserve before the real call" discipline alpha-vantage-budget.ts already established for a
 * different provider. A reservation that would exceed the per-minute ceiling is refused outright;
 * the caller is expected to skip that owner this heartbeat and let a LATER heartbeat retry once the
 * window has rolled over - never a queued backlog, never a burst once the window opens.
 */

const WINDOW_MS = 60_000;

/** Application-level initial ceiling - the ticket's own explicit target, deliberately far below
 * any assumed Schwab per-minute entitlement (never designed around a guessed 120/minute). */
export const MAX_PROVIDER_REQUESTS_PER_MINUTE = 12;

/** A single capture attempt's budget reservation. Deliberately a fixed, conservative constant
 * rather than a precise per-owner prediction: the real formula (accountCount + distinctTickerCount
 * + 1, see this module's sibling scheduled-capture.ts doc comment for the measured basis) depends
 * on how many REAL Schwab accounts the user's OAuth connection reports, which this app cannot know
 * without a live call - predicting it precisely would require either a speculative extra API call
 * (defeating the point of a budget check) or trusting this app's own `TradingAccount` row count,
 * which does not necessarily match the provider's own account count. 10 covers this app's real
 * measured range (a cold-cache cycle costs accountCount + distinctTickerCount + 2 - this app's own
 * two users each have a small number of accounts/tickers) with reasonable margin. */
export const ESTIMATED_PROVIDER_REQUESTS_PER_CAPTURE = 10;

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
