import "server-only";

import { NextResponse } from "next/server";
import { processAlphaVantageQueues, type ProcessQueueStoppedReason } from "@/lib/alpha-vantage-fundamentals";
import { extractProvidedCronSecret, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Protected cron target for the AUTO fundamentals queue - see PROJECT_HANDOFF.md Alpha Vantage
 * API section. Calls `processAlphaVantageQueues()`, the unified OVERVIEW+BALANCE_SHEET work
 * queue (`src/lib/alpha-vantage-fundamentals.ts`) - NOT two sequential single-endpoint queues.
 * Running OVERVIEW to completion and then BALANCE_SHEET (the original wiring) let a broad
 * OVERVIEW pass consume the entire day's AUTO budget before BALANCE_SHEET ever got a call, even
 * for a Research ticker missing both - the unified queue interleaves both endpoints by priority
 * (Research completeness first, across both endpoints, before any Scanner-only work) so that
 * can't happen. Every existing protection (22/day auto cap, 3-call manual reserve, global
 * single-flight lock with 5-minute stale recovery, 1300ms pacing, 7-day freshness, throttle
 * handling) still applies - the budget/lock/pacing primitives are unchanged, only the ordering
 * of work items drawing from them changed.
 *
 * Auth: a shared secret (OSO_CRON_SECRET) via `Authorization: Bearer <secret>` or
 * `X-OSO-Cron-Secret`, compared in constant time. A missing/wrong secret returns 401 and makes
 * ZERO Alpha Vantage calls - the auth check happens before anything else in this handler, and
 * `processAlphaVantageQueues()` is never invoked on that path.
 */
const REASON_LABEL: Record<ProcessQueueStoppedReason, string> = {
  COMPLETE: "queue_empty_or_complete",
  BUDGET_EXHAUSTED: "budget_exhausted",
  RATE_LIMITED: "provider_throttled",
  LOCK_UNAVAILABLE: "lock_unavailable",
  NO_API_KEY: "not_configured",
};

export async function POST(request: Request) {
  const provided = extractProvidedCronSecret(request.headers);
  if (!isValidCronSecret(provided)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const summary = await processAlphaVantageQueues();
    const reason = summary.callsConsumed === 0 && summary.stoppedReason === "COMPLETE" ? "queue_empty" : REASON_LABEL[summary.stoppedReason];
    const overviewProcessed = summary.outcomes.filter((outcome) => outcome.endpoint === "OVERVIEW").length;
    const balanceSheetProcessed = summary.outcomes.filter((outcome) => outcome.endpoint === "BALANCE_SHEET").length;

    return NextResponse.json({
      processed: summary.callsConsumed,
      callsUsed: summary.callsConsumed,
      reason,
      overview: { processed: overviewProcessed },
      balanceSheet: { processed: balanceSheetProcessed },
      usage: {
        autoCount: summary.usage.autoCount,
        manualCount: summary.usage.manualCount,
        totalCount: summary.usage.totalCount,
        autoRemaining: summary.usage.autoRemaining,
        totalRemaining: summary.usage.totalRemaining,
      },
    });
  } catch {
    // Sanitized - never echoes a raw provider error, payload, or ticker-level detail.
    return NextResponse.json({ error: "Processing the fundamentals queue failed unexpectedly." }, { status: 500 });
  }
}
