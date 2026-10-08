import "server-only";

import { prisma } from "./prisma";
import { dueCaptureSlots, type CaptureSlotKind } from "@/domain/finance/scheduledCaptureSlots";
import { isKnownTransientFallbackReason, type PositionAssessmentDisplay } from "@/domain/finance/positionReviewAssessment";
import { resolvePositionAssessmentDisplaysForUser } from "./positionAssessmentOrchestration";
import { loadOpenAndAssignedCampaignsForUser } from "./workflows";
import { DEFAULT_ROLL_BUFFER_PERCENT } from "@/domain/finance/rollStatus";
import { ESTIMATED_PROVIDER_REQUESTS_PER_CAPTURE, tryReserveProviderRequestBudget } from "./scheduled-capture-budget";

/**
 * LST "Bounded Scheduled Position Capture" Phase 2A - the bounded worker behind
 * `/api/internal/scheduled-capture`. Reuses the EXACT same orchestration Dashboard/Tracker already
 * call for a page render (`resolvePositionAssessmentDisplaysForUser`, positionAssessmentOrchestration.ts)
 * - this module never re-evaluates a position itself, never adds a second persistence path, and
 * never weakens the approved CURRENT/LAST_VALID/UNAVAILABLE trust model. It only decides WHICH
 * owner gets a cycle, WHEN (via scheduledCaptureSlots.ts's pure slot-due computation), and records
 * a small, durable, idempotent record of what happened - "scheduled capture" is purely a
 * SCHEDULING/TRIGGERING concern layered on top of code that was already correct and already
 * approved.
 *
 * Measured provider-request cost (see PROJECT_HANDOFF.md for the full measurement): one cold-cache
 * `resolvePositionReviewsForUser` cycle for a user with A Schwab accounts and M distinct tickers
 * needing review costs (1 + A) broker-read calls + M quote calls (one per symbol, NOT batched -
 * this is EXISTING, trust-sensitive provider behavior, deliberately NOT rewritten by this ticket)
 * + 1 session call = A + M + 2 real Schwab requests. For this app's own two users (small account/
 * ticker counts), a typical capture costs roughly 3-10 requests.
 */

const STALE_RUNNING_THRESHOLD_MS = 2 * 60_000;
/** A FAILED slot is not retried sooner than this - gives a transient provider hiccup real recovery
 * time rather than being hammered on the very next 5-minute heartbeat. */
const TRANSIENT_RETRY_BACKOFF_MS = 5 * 60_000;
/** Generous upper bound on how many owners one invocation will even attempt - this app has 2 users
 * today; never meant to imply this feature scales to an unbounded user base without revisiting. */
const MAX_OWNERS_PER_INVOCATION = 10;

export type ScheduledCaptureHeartbeatResult = {
  status: "ok";
  due: number;
  processed: number;
  skipped: number;
  failed: number;
};

type OwnerCaptureOutcome = "SUCCEEDED" | "FAILED" | "SKIPPED";

/**
 * Atomically claims (or re-claims) exactly one (owner, dueAt) slot via a single
 * INSERT ... ON CONFLICT ... DO UPDATE statement - the ONE idempotency guarantee this whole
 * feature rests on. Two concurrent invocations (or the same invocation triggered twice, or a
 * process restart) racing for the SAME slot can never both succeed: Postgres serializes concurrent
 * writes against the same unique key, and a losing claim simply returns null (no row), meaning
 * "already handled, nothing to do" - never a thrown error, never a second real capture attempt.
 * A row is re-claimable only when it is FAILED and past its own backoff, or RUNNING but stale
 * (implying a crashed process never got to mark it SUCCEEDED/FAILED) - a genuinely SUCCEEDED or
 * still-fresh RUNNING slot is never touched again.
 */
async function claimSlot(ownerId: string, sessionDate: string, slot: CaptureSlotKind, dueAt: Date, now: Date): Promise<string | null> {
  const staleThreshold = new Date(now.getTime() - STALE_RUNNING_THRESHOLD_MS);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO "ScheduledCaptureRun" ("id", "ownerId", "sessionDate", "slot", "dueAt", "status", "attemptCount", "startedAt", "createdAt", "updatedAt")
    VALUES (gen_random_uuid()::text, ${ownerId}, ${sessionDate}, ${slot}::"ScheduledCaptureSlot", ${dueAt}, 'RUNNING', 1, ${now}, ${now}, ${now})
    ON CONFLICT ("ownerId", "dueAt") DO UPDATE SET
      "status" = 'RUNNING',
      "startedAt" = ${now},
      "updatedAt" = ${now},
      "attemptCount" = "ScheduledCaptureRun"."attemptCount" + 1
    WHERE
      ("ScheduledCaptureRun"."status" = 'FAILED' AND ("ScheduledCaptureRun"."nextEligibleRetryAt" IS NULL OR "ScheduledCaptureRun"."nextEligibleRetryAt" <= ${now}))
      OR ("ScheduledCaptureRun"."status" = 'RUNNING' AND "ScheduledCaptureRun"."startedAt" < ${staleThreshold})
    RETURNING "id"
  `;
  return rows[0]?.id ?? null;
}

async function completeSlot(
  runId: string,
  now: Date,
  result:
    | { status: "SUCCEEDED"; positionsExamined: number; currentAssessmentsPersisted: number; unavailableCount: number; contradictionCount: number; providerRequestCountEstimate: number; durationMs: number }
    | { status: "FAILED"; errorCategory: string; durationMs: number; transient: boolean },
): Promise<void> {
  if (result.status === "SUCCEEDED") {
    await prisma.scheduledCaptureRun.update({
      where: { id: runId },
      data: {
        status: "SUCCEEDED",
        completedAt: now,
        positionsExamined: result.positionsExamined,
        currentAssessmentsPersisted: result.currentAssessmentsPersisted,
        unavailableCount: result.unavailableCount,
        contradictionCount: result.contradictionCount,
        providerRequestCountEstimate: result.providerRequestCountEstimate,
        durationMs: result.durationMs,
      },
    });
    return;
  }
  await prisma.scheduledCaptureRun.update({
    where: { id: runId },
    data: {
      status: "FAILED",
      completedAt: now,
      errorCategory: result.errorCategory,
      durationMs: result.durationMs,
      nextEligibleRetryAt: result.transient ? new Date(now.getTime() + TRANSIENT_RETRY_BACKOFF_MS) : null,
    },
  });
}

/**
 * One owner's capture: loads their own open/assigned campaigns and accounts (owner-scoped Prisma
 * queries only - never a cross-user read), and calls the SAME shared orchestration Dashboard/
 * Tracker use. Any eligible CURRENT result is persisted through that orchestration's own existing,
 * unmodified `savePositionReviewAssessmentIfEligible` call - this function adds no second
 * persistence path and performs no evaluation of its own. Counts the resulting displays into the
 * bounded operational summary - never logs a symbol, a price, or a brokerage identifier.
 */
export type CaptureTally = { positionsExamined: number; currentAssessmentsPersisted: number; unavailableCount: number; contradictionCount: number };

/**
 * Pure tally over an ALREADY-resolved display set - no I/O, directly unit-testable without
 * mocking Prisma/the orchestration module. `currentAssessmentsPersisted` counts a CURRENT display
 * as persisted because `resolvePositionAssessmentDisplaysForUser` itself already attempted the
 * approved write (`savePositionReviewAssessmentIfEligible`) for every persistable CURRENT result
 * before returning it - this function never re-decides eligibility, it only counts what the
 * orchestration already decided. `contradictionCount` reuses the exact same transient-vs-
 * contradiction boundary Phase 1's Attention Now filter already established (isKnownTransientFallbackReason)
 * - never a new, independently-invented interpretation.
 */
export function tallyPositionAssessmentDisplays(resolved: readonly { display: PositionAssessmentDisplay }[]): CaptureTally {
  let currentAssessmentsPersisted = 0;
  let unavailableCount = 0;
  let contradictionCount = 0;
  for (const { display } of resolved) {
    if (display.state === "CURRENT") {
      currentAssessmentsPersisted += 1;
    } else if (display.state === "UNAVAILABLE") {
      unavailableCount += 1;
      if (display.currentUnavailable.explanation.reasonCodes.some((code) => !isKnownTransientFallbackReason(code))) {
        contradictionCount += 1;
      }
    }
  }
  return { positionsExamined: resolved.length, currentAssessmentsPersisted, unavailableCount, contradictionCount };
}

async function captureOneOwner(ownerId: string, now: Date): Promise<CaptureTally> {
  const [campaigns, accounts, settings] = await Promise.all([
    loadOpenAndAssignedCampaignsForUser(ownerId),
    prisma.tradingAccount.findMany({ where: { userId: ownerId }, select: { id: true, userId: true, externalAccountId: true, source: true } }),
    prisma.userSettings.findUnique({ where: { userId: ownerId }, select: { rollBufferPercent: true } }),
  ]);
  const rollBufferPercent = Number(settings?.rollBufferPercent ?? DEFAULT_ROLL_BUFFER_PERCENT);

  const resolved = await resolvePositionAssessmentDisplaysForUser(ownerId, campaigns, accounts, rollBufferPercent, now, () => new Date());
  return tallyPositionAssessmentDisplays(resolved);
}

/** True for a category this app considers worth a scheduler-driven retry (provider/network
 * hiccups) rather than a permanent condition (auth failure, programming error) that would just
 * waste a later heartbeat's attempt in the exact same way. */
export function isTransientErrorCategory(category: string): boolean {
  return category === "PROVIDER_UNAVAILABLE";
}

export function categorizeError(error: unknown): string {
  if (error && typeof error === "object" && "name" in error) {
    const name = (error as { name?: string }).name;
    if (name === "AbortError") return "PROVIDER_UNAVAILABLE";
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message?: unknown }).message ?? "");
    if (/auth|token|unauthoriz/i.test(message)) return "AUTH_UNAVAILABLE";
    if (/fetch|network|ECONN|timeout|429/i.test(message)) return "PROVIDER_UNAVAILABLE";
  }
  return "UNKNOWN";
}

/**
 * Owners the scheduler may consider at all - a real, CONNECTED Schwab brokerage connection only
 * (the server choosing eligible owners itself, never trusting a caller-supplied id). A user with
 * no Schwab connection has nothing a scheduled capture could usefully fetch and is never attempted
 * - cheaply skipped before any provider work, exactly like selectNextEligibleUserForTechnicalPreparation's
 * own precedent (technical-preparation-orchestrator.ts).
 */
async function eligibleOwnerIds(): Promise<string[]> {
  const connections = await prisma.brokerConnection.findMany({
    where: { provider: "SCHWAB", status: "CONNECTED", accessTokenCiphertext: { not: null }, refreshTokenCiphertext: { not: null } },
    select: { userId: true },
    distinct: ["userId"],
    take: MAX_OWNERS_PER_INVOCATION,
  });
  return connections.map((connection) => connection.userId);
}

/**
 * One bounded heartbeat invocation - called by the protected internal endpoint, never by a page
 * render. "Nothing due" (outside every slot's window, or a non-market day) costs ZERO database
 * writes and ZERO provider calls - the slot-due check runs first, entirely in memory. Owners are
 * processed strictly SEQUENTIALLY (never Promise.all across owners) - this app has exactly two
 * users, so this trivially keeps cross-owner concurrency at 1, well under the ticket's own 2-
 * concurrent target; the pre-existing internal fan-out WITHIN one owner's own
 * resolvePositionReviewsForUser call (a handful of concurrent per-symbol quote requests) is
 * existing, trust-sensitive provider behavior this ticket deliberately does not rewrite. A single
 * owner's failure is fully isolated (try/catch per owner) and never blocks or corrupts another
 * owner's capture or claim.
 */
export async function runScheduledCaptureHeartbeat(now: Date = new Date()): Promise<ScheduledCaptureHeartbeatResult> {
  const due = dueCaptureSlots(now);
  if (due.length === 0) {
    return { status: "ok", due: 0, processed: 0, skipped: 0, failed: 0 };
  }
  const dueSlot = due[0]!;

  const ownerIds = await eligibleOwnerIds();
  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (const ownerId of ownerIds) {
    const outcome = await captureOwnerSlot(ownerId, dueSlot.sessionDate, dueSlot.slot, dueSlot.dueAt, now);
    if (outcome === "SUCCEEDED") processed += 1;
    else if (outcome === "FAILED") failed += 1;
    else skipped += 1;
  }

  return { status: "ok", due: ownerIds.length, processed, skipped, failed };
}

async function captureOwnerSlot(ownerId: string, sessionDate: string, slot: CaptureSlotKind, dueAt: Date, now: Date): Promise<OwnerCaptureOutcome> {
  const runId = await claimSlot(ownerId, sessionDate, slot, dueAt, now);
  if (!runId) {
    return "SKIPPED"; // already SUCCEEDED, already RUNNING (fresh), or FAILED-but-not-yet-retry-eligible
  }

  if (!tryReserveProviderRequestBudget(ESTIMATED_PROVIDER_REQUESTS_PER_CAPTURE, now)) {
    // Budget exhausted for this minute - release the claim back to FAILED/transient-retryable so a
    // LATER heartbeat (once the window rolls over) can pick this exact same slot back up, rather
    // than silently leaving it stuck RUNNING or spending provider work over budget.
    await completeSlot(runId, now, { status: "FAILED", errorCategory: "PROVIDER_UNAVAILABLE", durationMs: 0, transient: true });
    return "SKIPPED";
  }

  const startedAt = Date.now();
  try {
    const summary = await captureOneOwner(ownerId, now);
    await completeSlot(runId, now, {
      status: "SUCCEEDED",
      ...summary,
      providerRequestCountEstimate: ESTIMATED_PROVIDER_REQUESTS_PER_CAPTURE,
      durationMs: Date.now() - startedAt,
    });
    return "SUCCEEDED";
  } catch (error) {
    const category = categorizeError(error);
    await completeSlot(runId, now, { status: "FAILED", errorCategory: category, durationMs: Date.now() - startedAt, transient: isTransientErrorCategory(category) });
    return "FAILED";
  }
}

export type LatestScheduledCaptureStatus =
  | { known: false }
  | { known: true; status: "SUCCEEDED" | "FAILED" | "RUNNING"; at: Date; slot: CaptureSlotKind };

/**
 * Read-only status for the minimal Account-page indicator ("Automatic capture: Healthy · last
 * success <time>") - the most recent ScheduledCaptureRun row for this owner that has actually
 * concluded (SUCCEEDED or FAILED), never a currently-RUNNING one's half-finished state. Returns
 * `{known:false}` when this owner has never had a scheduled capture attempt at all (e.g. no
 * Schwab connection yet, or the feature hasn't run for them this session) - the UI then shows
 * nothing rather than a fabricated "never" claim.
 */
export async function getLatestScheduledCaptureStatusForUser(ownerId: string): Promise<LatestScheduledCaptureStatus> {
  const row = await prisma.scheduledCaptureRun.findFirst({
    where: { ownerId, status: { in: ["SUCCEEDED", "FAILED"] } },
    orderBy: { completedAt: "desc" },
    select: { status: true, completedAt: true, slot: true },
  });
  if (!row || !row.completedAt) {
    return { known: false };
  }
  return { known: true, status: row.status as "SUCCEEDED" | "FAILED", at: row.completedAt, slot: row.slot };
}
