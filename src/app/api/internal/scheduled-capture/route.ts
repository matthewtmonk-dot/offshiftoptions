import "server-only";

import { NextResponse } from "next/server";
import { extractProvidedScheduledCaptureSecret, isValidScheduledCaptureSecret } from "@/lib/cron-auth";
import { runScheduledCaptureHeartbeat } from "@/lib/scheduled-capture";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * LST "Bounded Scheduled Position Capture" Phase 2A - protected heartbeat target for an external
 * trigger (Hermes, the user's always-on home-server agent - see PROJECT_HANDOFF.md for the exact
 * cron/curl recommendation; NOT wired into anything yet). Deliberately accepts NO body/userId from
 * the caller: this request can never be used to target another user's brokerage-backed work, no
 * matter who or what calls it (as long as they have the shared secret) - the worker itself
 * determines which owners are due and processes each with its own owner-scoped Schwab connection,
 * identical precedent to /api/internal/scanner-technical/process.
 *
 * Auth: Codex blocker repair (B6) - a DEDICATED secret, `OSO_SCHEDULED_CAPTURE_SECRET`, separate
 * from the broader `OSO_CRON_SECRET` the other /api/internal/* endpoints share (Alpha Vantage
 * queue work, scanner reference-data refresh, scanner technical preparation) - Hermes holds only
 * the smallest credential that does its one job. Via `Authorization: Bearer <secret>` or
 * `X-OSO-Scheduled-Capture-Secret`, compared in constant time. There is NO fallback to
 * `OSO_CRON_SECRET` - presenting that old shared secret here is rejected exactly like any other
 * wrong guess. A missing/wrong secret returns 401 and runs NOTHING - the auth check happens before
 * any database or provider work, before even computing which slot (if any) is due.
 *
 * Hermes may call this endpoint on a short, simple heartbeat (e.g. every 5 minutes) - that does
 * NOT mean Schwab is called every 5 minutes. The worker decides server-side whether a capture slot
 * is actually due (dueCaptureSlots, scheduledCaptureSlots.ts) and returns `{due:0,...}` with ZERO
 * database writes and ZERO provider calls on every heartbeat where nothing is due.
 *
 * Response is aggregate-only (due/processed/skipped/failed counts) - never brokerage data, never a
 * symbol, never a token, never a raw provider response.
 */
export async function POST(request: Request) {
  const provided = extractProvidedScheduledCaptureSecret(request.headers);
  if (!isValidScheduledCaptureSecret(provided)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const result = await runScheduledCaptureHeartbeat();
    return NextResponse.json(result);
  } catch {
    // Sanitized - never echoes a raw provider/database error.
    return NextResponse.json({ error: "Scheduled capture heartbeat failed unexpectedly." }, { status: 500 });
  }
}
