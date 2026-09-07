import "server-only";

import { NextResponse } from "next/server";
import { extractProvidedCronSecret, isValidCronSecret } from "@/lib/cron-auth";
import { refreshOccOptionableUniverse, OCC_OPTIONABLE_UNIVERSE_SOURCE } from "@/lib/occ-optionable-universe-refresh";
import { getOptionableUniverseCacheStatus } from "@/lib/optionable-universe-cache";
import { refreshEarningsCalendarCache, getEarningsCalendarCacheStatus } from "@/lib/earnings-calendar-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Protected cron target for refreshing the scanner's shared, public reference data - the Tier 2
 * OCC optionable-universe cache (A) and the Alpha Vantage earnings-calendar cache (B, only when
 * stale). Not wired into any GitHub Actions schedule yet - this slice only builds the safe,
 * manually-invokable endpoint; scheduling is a separate, explicitly-reported follow-up once the
 * cache has been verified once against production.
 *
 * Auth: identical pattern to /api/internal/alpha-vantage/process - a shared secret
 * (OSO_CRON_SECRET) via `Authorization: Bearer <secret>` or `X-OSO-Cron-Secret`, compared in
 * constant time. A missing/wrong secret returns 401 and refreshes NOTHING - the auth check
 * happens before either refresh is attempted.
 *
 * Response is aggregate-only: row/entry counts and refresh status, never a symbol list, never
 * Schwab data, never a secret. Both refreshes are independent - a failure in one never blocks or
 * is masked by the other.
 *
 * On earnings FETCH_FAILED specifically, the response also includes `failureOutcome`
 * (RATE_LIMITED/ERROR_MESSAGE/EMPTY/HTTP_ERROR), an already-sanitized `message` where the
 * provider layer supplied one, and `httpStatus` for HTTP_ERROR - this is the only way to
 * diagnose a real production failure without a database console. Never the API key, an
 * authorization header, a raw URL, a raw response body, a raw exception, or a stack trace -
 * fetchAlphaVantageEarningsCalendar's own sanitizeMessage already redacts the API key and
 * withholds any credential-looking text before this endpoint ever sees it.
 */
export async function POST(request: Request) {
  const provided = extractProvidedCronSecret(request.headers);
  if (!isValidCronSecret(provided)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const [occ, earnings] = await Promise.all([refreshOcc(), refreshEarnings()]);
  return NextResponse.json({ occ, earnings });
}

async function refreshOcc() {
  try {
    const result = await refreshOccOptionableUniverse();
    const cacheStatus = await getOptionableUniverseCacheStatus();
    const current = cacheStatus.lastSuccessfulRefreshBySource.get(OCC_OPTIONABLE_UNIVERSE_SOURCE) ?? null;

    if (result.status === "SUCCESS") {
      return {
        status: "SUCCESS" as const,
        rawRows: result.rawRowCount,
        normalizedSymbols: result.upsertedCount,
        upsertedCount: result.upsertedCount,
        removedCount: result.removedCount,
        currentCount: current?.symbolCount ?? null,
        lastSuccessfulRefreshAt: current?.lastSeenAt.toISOString() ?? null,
      };
    }

    return {
      status: result.status,
      currentCount: current?.symbolCount ?? null,
      lastSuccessfulRefreshAt: current?.lastSeenAt.toISOString() ?? null,
    };
  } catch {
    // Sanitized - never echoes a raw fetch/network error or payload detail.
    return { status: "ERROR" as const };
  }
}

async function refreshEarnings() {
  try {
    const result = await refreshEarningsCalendarCache();
    const status = await getEarningsCalendarCacheStatus();
    const alphaVantageCallUsed = result.status === "SUCCESS" || result.status === "FETCH_FAILED";

    return {
      status: result.status,
      entryCount: status.entryCount,
      alphaVantageCallUsed,
      fresh: !status.isStale,
      lastSuccessfulRefreshAt: status.lastSuccessfulRefreshAt?.toISOString() ?? null,
      // FETCH_FAILED only - already-sanitized (see fetchAlphaVantageEarningsCalendar's
      // sanitizeMessage, which redacts the API key and blocks credential-looking text) failure
      // detail so a real production failure is diagnosable without a database console. Never
      // present on any other status.
      ...(result.status === "FETCH_FAILED"
        ? {
            failureOutcome: result.outcome,
            message: result.message,
            httpStatus: result.outcome === "HTTP_ERROR" ? result.httpStatus : undefined,
          }
        : {}),
    };
  } catch {
    // Sanitized - never echoes a raw fetch/network error or payload detail.
    return { status: "ERROR" as const };
  }
}
