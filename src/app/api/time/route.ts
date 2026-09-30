import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Dashboard V2 Phase 2 - Codex P2 (A, round 3). A minimal same-origin, read-only server-time
 * endpoint that exists for exactly one purpose: letting a client calibrate its own wall clock
 * against this app's server clock before trusting a server-computed active-guidance deadline (see
 * src/components/use-active-guidance-expired.ts). This route deliberately:
 *
 * - Never touches Prisma/the database.
 * - Never touches Schwab (no token refresh, no OAuth, no broker read/sync).
 * - Never reads or requires a session/auth cookie - the current instant is not private data.
 * - Never accepts a body, a write, or any request parameter - GET only, no side effects.
 * - Never changes any financial/application state - it is pure observation of `Date.now()`.
 *
 * `Cache-Control: no-store` is required, not incidental: any cache (browser, CDN, proxy) serving a
 * stale response here would silently poison every client's calibration with a wrong server time.
 */
export async function GET() {
  return NextResponse.json(
    { serverNow: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
