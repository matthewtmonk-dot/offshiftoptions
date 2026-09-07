import "server-only";

import { NextResponse } from "next/server";
import { extractProvidedCronSecret, isValidCronSecret } from "@/lib/cron-auth";
import { runTechnicalPreparationOrchestratorCycle } from "@/lib/technical-preparation-orchestrator";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Protected cron target for the bounded technical-preparation orchestrator - see
 * technical-preparation-orchestrator.ts for the full design. Deliberately accepts NO body/userId
 * from the caller: the request cannot be used to target another user's brokerage-backed work, no
 * matter who or what calls it (as long as they have the shared secret) - the worker itself
 * selects which ONE eligible connected user gets a cycle, always using THAT user's own resolved
 * Schwab market-data connection, never a shared/cross-user one.
 *
 * Auth: identical pattern to /api/internal/alpha-vantage/process and
 * /api/internal/scanner-reference/refresh - a shared secret (OSO_CRON_SECRET) via
 * `Authorization: Bearer <secret>` or `X-OSO-Cron-Secret`, compared in constant time. A missing/
 * wrong secret returns 401 and runs NOTHING - the auth check happens before user selection or any
 * database/provider work.
 *
 * Response is aggregate-only: which generation state resulted, how many of the existing 25-symbol
 * batches ran, and safe counts - never a symbol list, never account/broker data, never a token,
 * never a raw provider response. NOT wired into any GitHub Actions schedule yet - see
 * PROJECT_HANDOFF.md for the proposed (not yet enabled) window/cadence design.
 */
export async function POST(request: Request) {
  const provided = extractProvidedCronSecret(request.headers);
  if (!isValidCronSecret(provided)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const result = await runTechnicalPreparationOrchestratorCycle();
    return NextResponse.json(result);
  } catch {
    // Sanitized - never echoes a raw provider/database error, payload, or ticker-level detail.
    return NextResponse.json({ error: "Technical preparation cycle failed unexpectedly." }, { status: 500 });
  }
}
