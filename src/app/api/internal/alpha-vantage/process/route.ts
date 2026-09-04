import "server-only";

import { NextResponse } from "next/server";
import { processAlphaVantageFundamentalsQueue, type ProcessQueueStoppedReason } from "@/lib/alpha-vantage-fundamentals";
import { extractProvidedCronSecret, isValidCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Protected cron target for the AUTO fundamentals queue - see PROJECT_HANDOFF.md Alpha Vantage
 * API section. Reuses `processAlphaVantageFundamentalsQueue()` unchanged (the same function the
 * Account "Process fundamentals queue" button calls) - every existing protection (22/day auto
 * cap, 3-call manual reserve, global single-flight lock with 5-minute stale recovery, 1300ms
 * pacing, deduped priority queue, 7-day freshness, throttle handling) applies automatically.
 * This is not a second queue implementation.
 *
 * Auth: a shared secret (OSO_CRON_SECRET) via `Authorization: Bearer <secret>` or
 * `X-OSO-Cron-Secret`, compared in constant time. A missing/wrong secret returns 401 and makes
 * ZERO Alpha Vantage calls - the auth check happens before anything else in this handler, and
 * `processAlphaVantageFundamentalsQueue()` is never invoked on that path.
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
    const summary = await processAlphaVantageFundamentalsQueue();
    const reason = summary.callsConsumed === 0 && summary.stoppedReason === "COMPLETE" ? "queue_empty" : REASON_LABEL[summary.stoppedReason];

    return NextResponse.json({
      processed: summary.callsConsumed,
      callsUsed: summary.callsConsumed,
      reason,
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
