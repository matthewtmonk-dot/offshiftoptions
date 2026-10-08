import "server-only";

import { prisma } from "./prisma";
import { dueCaptureSlots, type CaptureSlotKind } from "@/domain/finance/scheduledCaptureSlots";
import { isKnownTransientFallbackReason, type PositionAssessmentDisplay } from "@/domain/finance/positionReviewAssessment";
import { resolvePositionAssessmentDisplaysForUser, type ResolvedPositionAssessmentDisplay } from "./positionAssessmentOrchestration";
import { loadOpenAndAssignedCampaignsForUser } from "./workflows";
import { DEFAULT_ROLL_BUFFER_PERCENT } from "@/domain/finance/rollStatus";
import { estimateProviderCost, MAX_PROVIDER_REQUESTS_PER_MINUTE, tryReserveProviderRequestBudget } from "./scheduled-capture-budget";
import { getEquityMarketSessionEvidenceForUser } from "./live-quotes";
import { isWithinRegularSession, nyCalendarDateOf } from "@/domain/finance/marketSession";
import { isAbortError } from "@/providers/schwab/client";

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
 * Codex blocker repair (B1, early close - round 2) - before any heavy per-owner work, this module
 * asks this owner's OWN real Schwab session evidence (`getEquityMarketSessionEvidenceForUser`, the
 * exact same evidence the live evaluator itself trusts) whether `now` actually falls inside the
 * regular session. Schwab's own evidence already correctly encodes early closes (e.g. the day
 * after Thanksgiving) - no hardcoded/guessed holiday calendar is added here. Scheduled capture
 * FAILS CLOSED on every non-open outcome:
 *   AVAILABLE + OPEN      -> proceed to the heavy resolver
 *   AVAILABLE + CLOSED    -> SUCCEEDED / SESSION_CLOSED, heavy resolver never entered
 *   UNAVAILABLE           -> FAILED / SESSION_UNAVAILABLE, heavy resolver never entered either
 * The first Codex round left the UNAVAILABLE case falling through to the heavy resolver "just in
 * case," which defeated the whole gate on exactly the connectivity-degraded days it exists for.
 * Manual Refresh is a SEPARATE, unaffected code path (`refreshPositionEvidenceForUser`,
 * workflows.ts) that may still try harder because a human explicitly asked for it right now - this
 * module's own principle is the opposite: a missing scheduled snapshot is preferable to
 * uncontrolled/duplicate provider traffic, so an inconclusive preflight is never a license to
 * proceed anyway.
 *
 * Measured provider-request cost (see PROJECT_HANDOFF.md for the full measurement): one cold-cache
 * `resolvePositionReviewsForUser` cycle for a user with A Schwab accounts and M distinct tickers
 * needing review costs (1 + A) broker-read calls + M quote calls (one per symbol, NOT batched -
 * this is EXISTING, trust-sensitive provider behavior, deliberately NOT rewritten by this ticket)
 * + 1 session call = A + M + 2 real Schwab requests on the heavy path, PLUS the one cheap B1 gate
 * call above (A + M + 3 total when the session turns out to be open). A SESSION_CLOSED or
 * SESSION_UNAVAILABLE outcome costs only that single preflight request - never A+M+3 - see
 * scheduled-capture-budget.ts's own doc comment for the full budget-reservation formula (which
 * adds further headroom on top of this real-cost number).
 */

/** Codex blocker repair (B3) - a RUNNING row older than this is no longer trusted to still be a
 * genuinely in-flight attempt; it is marked ABANDONED for operational visibility ONLY (see
 * abandonStaleRunningRows below) - its own exact (owner, dueAt) slot is never automatically
 * reclaimed/re-run (the original attempt may still be executing; re-running it could duplicate
 * real provider work - see claimSlot's own doc comment for why the old 2-minute stale-RUNNING
 * reclaim was unsafe and has been removed entirely). Chosen to comfortably exceed CAPTURE_TIMEOUT_MS
 * below (the real, honored cancellation deadline this app now enforces) with a wide safety margin
 * for process/DB-write latency around that deadline. */
const ABANDON_STALE_RUNNING_THRESHOLD_MS = 10 * 60_000;

/**
 * Codex blocker repair (B3, round 2) - the real, HONORED, END-TO-END cancellation deadline for one
 * owner's ENTIRE scheduled attempt - created BEFORE the first provider call of any kind (the B1
 * session preflight included, not just the heavy resolver) and threaded as the SAME `AbortSignal`
 * through every subsequent provider-touching step: the preflight session call, token acquisition/
 * refresh (`providers/schwab/tokens.ts`), accounts, positions, quotes, and the heavy resolver's
 * own session-evidence fetch. The first Codex round created this controller only around the heavy
 * resolver call, AFTER the preflight had already run un-cancellable and with token refresh never
 * wired to any signal at all - so the "45-second deadline" was never actually a complete-provider-
 * work deadline. This is NOT a `Promise.race` that leaves the underlying fetch running unobserved -
 * the signal is the one actually passed to every real `fetch` in the chain, so an aborted request
 * is actually cancelled network-side (verified by dedicated fetch-level tests - see
 * scheduled-capture.test.ts and tokens.test.ts). 45s is chosen to comfortably exceed this app's own
 * measured typical capture latency (a handful of sequential/concurrent Schwab requests) while
 * still being short enough that a genuinely hung request does not occupy an owner's "active run"
 * slot for long.
 *
 * Hermes recommendation: the documented `curl --max-time` MUST exceed this server-side deadline
 * plus write/network overhead - recommend `--max-time 60` (45s deadline + 15s margin). This is
 * now genuinely justified: the 45s deadline is end-to-end across every scheduled provider call,
 * not merely the heavy resolver, so 60s is a real, complete upper bound on server-side work.
 */
const CAPTURE_TIMEOUT_MS = 45_000;

/** A PROVIDER_UNAVAILABLE or SESSION_UNAVAILABLE slot is not retried sooner than this - gives a
 * transient provider hiccup real recovery time rather than being hammered on the very next
 * 5-minute heartbeat. */
const PROVIDER_RETRY_BACKOFF_MS = 5 * 60_000;
/** Codex blocker repair (B4) - a TIMEOUT (the 45s end-to-end deadline fired) backs off on the SAME
 * schedule as a plain provider hiccup: a timeout is itself evidence of a slow/unresponsive
 * provider, not a distinct failure mode needing its own longer cooldown, and 5 minutes already
 * gives real recovery time before the next heartbeat retries. Documented explicitly per the
 * ticket's own "choose and document" instruction (the alternative considered was 15 minutes,
 * rejected as needlessly conservative for what is often transient network/provider slowness). */
const TIMEOUT_RETRY_BACKOFF_MS = PROVIDER_RETRY_BACKOFF_MS;
/** Codex blocker repair (B5) - an AUTH_UNAVAILABLE slot backs off far longer than a plain provider
 * hiccup: a broken/expired Schwab connection needs the owner to actually reconnect (Account page),
 * which will not happen in the next 5 minutes - hammering it every heartbeat wastes a request and
 * teaches nothing new. 60 minutes gives ample time for the owner to notice and reconnect, while
 * still recovering automatically within the trading day if they do. */
const AUTH_RETRY_BACKOFF_MS = 60 * 60_000;
/** Codex blocker repair (B5) - an UNKNOWN_ERROR (anything thrown that was not already safely
 * converted to UNAVAILABLE evidence by the existing fail-closed resolver) gets a BOUNDED retry
 * policy, never an immediate infinite retry: a short backoff for the first couple of attempts,
 * then `nextEligibleRetryAt = null` (never auto-retried again) once UNKNOWN_ERROR_MAX_ATTEMPTS is
 * reached - a genuinely broken/unexpected condition should surface for a human, not spin forever. */
const UNKNOWN_ERROR_RETRY_BACKOFF_MS = 15 * 60_000;
const UNKNOWN_ERROR_MAX_ATTEMPTS = 3;

/** Generous upper bound on how many owners one invocation will even attempt - this app has 2 users
 * today; never meant to imply this feature scales to an unbounded user base without revisiting. */
const MAX_OWNERS_PER_INVOCATION = 10;

export type ScheduledCaptureHeartbeatResult = {
  status: "ok";
  due: number;
  processed: number;
  /** Codex blocker repair (B4) - budget-deferred, NOT a failure; see runScheduledCaptureHeartbeat's
   * own doc comment for the fairness/ordering guarantee this count reflects. */
  deferred: number;
  skipped: number;
  failed: number;
};

type OwnerCaptureOutcome = "SUCCEEDED" | "FAILED" | "SKIPPED" | "DEFERRED";

/**
 * Codex blocker repair (B5) - the fine-grained operational classification for one completed
 * capture attempt, independent of the resolver's own (unchanged, fail-closed) CURRENT/LAST_VALID/
 * UNAVAILABLE display model. See classifyCaptureOutcome below for how this is derived.
 */
export type CaptureResultCategory =
  | "CURRENT_CAPTURED"
  | "NO_CURRENT_LEGITIMATE"
  | "SESSION_CLOSED"
  | "CONTRADICTION_DETECTED"
  | "PROVIDER_UNAVAILABLE"
  | "AUTH_UNAVAILABLE"
  /** Codex blocker repair (B1, round 2) - the preflight session-evidence gate itself returned
   * UNAVAILABLE (never "closed," never "open" - genuinely unknown). Scheduled capture now fails
   * closed on this outcome instead of falling through to the heavy resolver "just in case." */
  | "SESSION_UNAVAILABLE"
  /** Codex blocker repair (B3/B4, round 2) - this attempt's own 45s end-to-end deadline fired.
   * Takes priority over whatever the resolver's own fail-closed catches turned the resulting
   * abort into (ordinary-looking UNAVAILABLE/LAST_VALID evidence) - see captureOwnerSlot's
   * explicit `controller.signal.aborted` check before classification. */
  | "TIMEOUT"
  | "UNKNOWN_ERROR"
  | "BUDGET_DEFERRED"
  /** Codex blocker repair (B2, round 2) - this owner's OWN estimated cost exceeds the ENTIRE
   * per-minute ceiling by itself, not merely "no capacity this minute." Terminal: never executed,
   * never auto-retried (nextEligibleRetryAt is always null) - distinct from BUDGET_DEFERRED, which
   * remains retryable once capacity frees up. Requires operator attention (reduce this owner's
   * tracked campaigns/tickers, or revisit the ceiling) rather than an indefinite retry loop. */
  | "BUDGET_BLOCKED"
  | "ABANDONED_STALE";

/**
 * Atomically claims (or re-claims) exactly one (owner, dueAt) slot via a single
 * INSERT ... ON CONFLICT ... DO UPDATE statement - the ONE idempotency guarantee this whole
 * feature rests on. Two concurrent invocations (or the same invocation triggered twice, or a
 * process restart) racing for the SAME slot can never both succeed: Postgres serializes concurrent
 * writes against the same unique key, and a losing claim simply returns null (no row), meaning
 * "already handled, nothing to do" - never a thrown error, never a second real capture attempt.
 *
 * Codex blocker repair (B3) - a RUNNING row is NEVER automatically reclaimed here, no matter how
 * old it is (the original 2-minute stale-RUNNING reclaim is REMOVED entirely): a Schwab provider
 * call has no guaranteed server-side cancellation deadline, so a "stale" RUNNING row's original
 * attempt might genuinely still be executing - reclaiming it could run the SAME capture twice,
 * concurrently, against the SAME brokerage connection. A RUNNING row that truly crashed is instead
 * marked ABANDONED by abandonStaleRunningRows (operational visibility only) and its owner-level
 * active-run guard is released that way - this exact (owner, dueAt) row is still never re-claimed.
 *
 * Codex blocker repair (B5, null-retry fix) - a FAILED row is reclaimable ONLY when
 * `nextEligibleRetryAt` is a NON-NULL instant that has already passed. NULL explicitly means "do
 * not auto-retry" and must never be read as "eligible now" (the exact defect Codex found in the
 * original `nextEligibleRetryAt IS NULL OR ... <= now` condition).
 *
 * Codex blocker repair (B4) - a DEFERRED row (this owner's own prior attempt lost the per-minute
 * provider-request budget race) is reclaimable under the identical non-null-and-past-due rule,
 * letting a LATER heartbeat pick the SAME original slot back up without requiring the slot's own
 * due-window to still be open (see runScheduledCaptureHeartbeat's deferred-retry queue).
 */
async function claimSlot(ownerId: string, sessionDate: string, slot: CaptureSlotKind, dueAt: Date, now: Date): Promise<{ id: string; attemptCount: number } | null> {
  const rows = await prisma.$queryRaw<{ id: string; attemptCount: number }[]>`
    INSERT INTO "ScheduledCaptureRun" ("id", "ownerId", "sessionDate", "slot", "dueAt", "status", "attemptCount", "startedAt", "createdAt", "updatedAt")
    VALUES (gen_random_uuid()::text, ${ownerId}, ${sessionDate}, ${slot}::"ScheduledCaptureSlot", ${dueAt}, 'RUNNING', 1, ${now}, ${now}, ${now})
    ON CONFLICT ("ownerId", "dueAt") DO UPDATE SET
      "status" = 'RUNNING',
      "startedAt" = ${now},
      "updatedAt" = ${now},
      "attemptCount" = "ScheduledCaptureRun"."attemptCount" + 1
    WHERE
      ("ScheduledCaptureRun"."status" = 'FAILED' AND "ScheduledCaptureRun"."nextEligibleRetryAt" IS NOT NULL AND "ScheduledCaptureRun"."nextEligibleRetryAt" <= ${now})
      OR ("ScheduledCaptureRun"."status" = 'DEFERRED' AND "ScheduledCaptureRun"."nextEligibleRetryAt" IS NOT NULL AND "ScheduledCaptureRun"."nextEligibleRetryAt" <= ${now})
    RETURNING "id", "attemptCount"
  `;
  return rows[0] ?? null;
}

/**
 * Codex blocker repair (B3) - operational-visibility-only sweep: any row still RUNNING past
 * ABANDON_STALE_RUNNING_THRESHOLD_MS is marked ABANDONED. This never re-executes that exact
 * (owner, dueAt) slot (claimSlot's own WHERE clause has no ABANDONED branch - it is a dead end by
 * design), but it DOES release that owner's "active run" guard (see ownerHasActiveRun) so a LATER,
 * DIFFERENT due slot for the same owner can proceed instead of being blocked forever by a crashed
 * process's orphaned row.
 */
async function abandonStaleRunningRows(now: Date): Promise<void> {
  const staleThreshold = new Date(now.getTime() - ABANDON_STALE_RUNNING_THRESHOLD_MS);
  await prisma.scheduledCaptureRun.updateMany({
    where: { status: "RUNNING", startedAt: { lt: staleThreshold } },
    data: { status: "ABANDONED", resultCategory: "ABANDONED_STALE", completedAt: now, nextEligibleRetryAt: null },
  });
}

/**
 * Codex blocker repair (B4) - bounds how long a DEFERRED row can accumulate: a DEFERRED row from a
 * PRIOR session date (never today's) is abandoned rather than retried forever. Today's own
 * DEFERRED rows are deliberately left alone here - they are retried through the deferred-retry
 * queue in runScheduledCaptureHeartbeat, not abandoned just for being old within the same day.
 */
async function abandonStaleDeferredRows(now: Date, sessionDate: string): Promise<void> {
  await prisma.scheduledCaptureRun.updateMany({
    where: { status: "DEFERRED", sessionDate: { not: sessionDate } },
    data: { status: "ABANDONED", resultCategory: "ABANDONED_STALE", completedAt: now, nextEligibleRetryAt: null },
  });
}

/**
 * Codex blocker repair (B3) - the owner-level active-run guard: an owner with ANY currently-RUNNING
 * row (regardless of which `dueAt` it targets) is never claimed for a NEW or DEFERRED slot this
 * heartbeat. claimSlot's own unique-key conflict only protects the EXACT SAME (owner, dueAt) pair -
 * this guard is what additionally prevents a slow-but-still-genuinely-running attempt for slot A
 * from overlapping a fresh attempt for a DIFFERENT slot B for the same owner. A benign, documented
 * race exists between this check and the later claimSlot call (no cross-process lock covers the
 * gap) - acceptable because the ONLY consequence is two owner captures briefly overlapping, never a
 * duplicate attempt at the SAME (owner, dueAt) slot, which remains impossible by construction.
 */
async function ownerHasActiveRun(ownerId: string): Promise<boolean> {
  const running = await prisma.scheduledCaptureRun.findFirst({ where: { ownerId, status: "RUNNING" }, select: { id: true } });
  return running !== null;
}

/**
 * Codex blocker repair (B5, round 2) - this session date's DEFERRED **and** FAILED-but-retry-
 * eligible rows, oldest `dueAt` first (the exact "oldest deferred/retryable owner first" fairness
 * rule the ticket requires) - never relying on unspecified database row order. Broadened from
 * DEFERRED-only in the first Codex round: a FAILED row whose own backoff has passed (e.g.
 * PROVIDER_UNAVAILABLE 5 minutes later) is now ALSO retried through this SAME queue, every
 * heartbeat, rather than only incidentally when a brand-new schedule slot happens to target the
 * exact same `dueAt` again. `nextEligibleRetryAt IS NOT NULL AND <= now` already excludes every
 * terminal row (BUDGET_BLOCKED/ABANDONED_STALE/exhausted UNKNOWN_ERROR all store `null`) - a
 * terminal row can never sit at the head of this queue forever, by construction.
 */
async function eligibleRetryableRuns(now: Date, sessionDate: string) {
  return prisma.scheduledCaptureRun.findMany({
    where: { status: { in: ["DEFERRED", "FAILED"] }, sessionDate, nextEligibleRetryAt: { not: null, lte: now } },
    orderBy: { dueAt: "asc" },
    select: { ownerId: true, sessionDate: true, slot: true, dueAt: true },
    take: MAX_OWNERS_PER_INVOCATION,
  });
}

/**
 * Owners the scheduler may consider at all - a real, CONNECTED Schwab brokerage connection only
 * (the server choosing eligible owners itself, never trusting a caller-supplied id), excluding any
 * owner already handled this same heartbeat via the deferred-retry queue above. A user with no
 * Schwab connection has nothing a scheduled capture could usefully fetch and is never attempted -
 * cheaply skipped before any provider work.
 *
 * Codex blocker repair (B4) - deterministic fair ordering: owners are sorted by their own most
 * recent COMPLETED run ascending (an owner who has never completed a run sorts first), with a
 * final deterministic tiebreak on `ownerId` - the LEAST-recently-serviced owner always goes first,
 * never relying on unspecified database row order for fairness between two equally-due owners.
 */
async function eligibleOwnerIdsInFairOrder(excludeOwnerIds: ReadonlySet<string>): Promise<string[]> {
  const connections = await prisma.brokerConnection.findMany({
    where: { provider: "SCHWAB", status: "CONNECTED", accessTokenCiphertext: { not: null }, refreshTokenCiphertext: { not: null } },
    select: { userId: true },
    distinct: ["userId"],
  });
  const ownerIds = connections.map((connection) => connection.userId).filter((id) => !excludeOwnerIds.has(id));
  if (ownerIds.length === 0) {
    return [];
  }

  const lastRuns = await prisma.scheduledCaptureRun.findMany({
    where: { ownerId: { in: ownerIds }, completedAt: { not: null } },
    orderBy: { completedAt: "desc" },
    distinct: ["ownerId"],
    select: { ownerId: true, completedAt: true },
  });
  const lastCompletedMsByOwner = new Map(lastRuns.map((run) => [run.ownerId, run.completedAt!.getTime()]));

  return [...ownerIds]
    .sort((a, b) => {
      const aMs = lastCompletedMsByOwner.get(a) ?? -Infinity;
      const bMs = lastCompletedMsByOwner.get(b) ?? -Infinity;
      return aMs !== bMs ? aMs - bMs : a.localeCompare(b);
    })
    .slice(0, MAX_OWNERS_PER_INVOCATION);
}

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

/** The known-transient reasonCodes that specifically indicate a BROKER/QUOTE/SESSION PROVIDER
 * problem (as opposed to a benign "nothing to do right now" reason like POSITION_AWAITING_CONFIRMATION
 * or QUOTE_STALE_TIMESTAMP) - see classifyCaptureOutcome below. */
const PROVIDER_ISSUE_REASONS = new Set(["POSITION_BROKER_UNAVAILABLE", "QUOTE_EVIDENCE_UNAVAILABLE", "QUOTE_SESSION_EVIDENCE_UNAVAILABLE"]);

/**
 * Codex blocker repair (B5, B4 round 2) - classifies an ALREADY-resolved, already-fail-closed
 * display set into one of the operational outcome categories, WITHOUT changing or reinterpreting
 * the resolver's own CURRENT/LAST_VALID/UNAVAILABLE trust decision for any individual campaign.
 * The resolver intentionally converts provider/auth failures into safe UNAVAILABLE displays
 * (correct for trading guidance) - this function exists precisely because "the resolver didn't
 * throw" is NOT the same question as "did this capture run actually accomplish anything," which
 * is what the Account-page health indicator needs to answer honestly.
 *
 * Codex blocker repair (B4, round 2) - CURRENT_CAPTURED now requires at least one display.state
 * === "CURRENT" produced by THIS invocation. A verified LAST_VALID historical fallback is real and
 * valuable for the FINANCIAL PRESENTATION (Dashboard/Tracker correctly show it to the user - that
 * is unchanged and correct) but it must NEVER count as an operationally successful SCHEDULED
 * capture: if the live attempt failed, the automatic background job did not succeed, regardless of
 * what historical data happens to still be on display elsewhere. A LAST_VALID display's own
 * `currentUnavailable.explanation.reasonCodes` is inspected exactly like an UNAVAILABLE display's -
 * both share the same shape, and LAST_VALID's own eligibility gate already guarantees those
 * reasonCodes are never a genuine contradiction, so a LAST_VALID entry correctly flows into
 * PROVIDER_UNAVAILABLE/AUTH_UNAVAILABLE/SESSION_CLOSED/NO_CURRENT_LEGITIMATE based on the REAL
 * reason the live attempt did not produce CURRENT - never silently treated as a success.
 *
 * Priority order (highest first): a genuine CONTRADICTION always wins (never hidden behind a
 * partially-successful run); then at least one genuine live CURRENT display; then a genuine
 * broker/quote/session PROVIDER problem (split into AUTH_UNAVAILABLE vs PROVIDER_UNAVAILABLE
 * using this owner's OWN `BrokerConnection.status`, re-read AFTER the attempt - `EXPIRED` means
 * the token refresh itself failed, a stronger signal than "merely" a transient provider hiccup);
 * then a resolver-detected closed session (defensive - B1's own gate above should already
 * intercept this before heavy work even starts, but this stays correct if session evidence
 * changes between the gate check and the heavy resolver's own fetch); finally, everything else
 * (only benign reasons, or zero relevant campaigns at all) is legitimately nothing-to-capture,
 * never an error. NOTE: an aborted/timed-out attempt is classified as TIMEOUT by captureOwnerSlot
 * BEFORE this function is even called (see its own `controller.signal.aborted` check) - timeout
 * always takes priority over whatever this function would otherwise conclude from the resulting
 * (possibly abort-truncated) display set.
 */
export function classifyCaptureOutcome(resolved: readonly { display: PositionAssessmentDisplay }[], authExpired: boolean): CaptureResultCategory {
  if (resolved.length === 0) {
    return "NO_CURRENT_LEGITIMATE";
  }

  let hasCurrent = false;
  let hasContradiction = false;
  let hasProviderIssue = false;
  let hasSessionClosed = false;

  for (const { display } of resolved) {
    if (display.state === "CURRENT") {
      hasCurrent = true;
      continue;
    }
    // LAST_VALID and UNAVAILABLE both carry `currentUnavailable` describing WHY the live attempt
    // itself did not produce CURRENT - a historical fallback existing (LAST_VALID) never changes
    // that underlying reason's own classification.
    for (const code of display.currentUnavailable.explanation.reasonCodes) {
      if (!isKnownTransientFallbackReason(code)) {
        hasContradiction = true;
      } else if (PROVIDER_ISSUE_REASONS.has(code)) {
        hasProviderIssue = true;
      } else if (code === "MARKET_CLOSED") {
        hasSessionClosed = true;
      }
    }
  }

  if (hasContradiction) return "CONTRADICTION_DETECTED";
  if (hasCurrent) return "CURRENT_CAPTURED";
  if (hasProviderIssue) return authExpired ? "AUTH_UNAVAILABLE" : "PROVIDER_UNAVAILABLE";
  if (hasSessionClosed) return "SESSION_CLOSED";
  return "NO_CURRENT_LEGITIMATE";
}

/**
 * One owner's heavy capture work: loads their own open/assigned campaigns and accounts (owner-
 * scoped Prisma queries only - never a cross-user read), and calls the SAME shared orchestration
 * Dashboard/Tracker use. Any eligible CURRENT result is persisted through that orchestration's own
 * existing, unmodified `savePositionReviewAssessmentIfEligible` call - this function adds no
 * second persistence path and performs no evaluation of its own.
 */
async function captureOneOwner(ownerId: string, now: Date, signal: AbortSignal): Promise<ResolvedPositionAssessmentDisplay[]> {
  const [campaigns, accounts, settings] = await Promise.all([
    loadOpenAndAssignedCampaignsForUser(ownerId),
    prisma.tradingAccount.findMany({ where: { userId: ownerId }, select: { id: true, userId: true, externalAccountId: true, source: true } }),
    prisma.userSettings.findUnique({ where: { userId: ownerId }, select: { rollBufferPercent: true } }),
  ]);
  const rollBufferPercent = Number(settings?.rollBufferPercent ?? DEFAULT_ROLL_BUFFER_PERCENT);

  return resolvePositionAssessmentDisplaysForUser(ownerId, campaigns, accounts, rollBufferPercent, now, () => new Date(), signal);
}

/** Re-reads this owner's Schwab connection status AFTER a capture attempt - `EXPIRED` is set by
 * providers/schwab/tokens.ts on a failed token refresh, a free, already-existing, DB-only signal
 * for distinguishing a genuine auth problem from a plain provider hiccup without adding any new
 * provider call or touching the trust-sensitive token-refresh code at all. */
async function ownerAuthExpired(ownerId: string): Promise<boolean> {
  const connection = await prisma.brokerConnection.findFirst({ where: { userId: ownerId, provider: "SCHWAB" }, select: { status: true } });
  return connection?.status === "EXPIRED";
}

async function completeSucceeded(runId: string, now: Date, resultCategory: CaptureResultCategory, tally: CaptureTally, providerRequestCountEstimate: number, durationMs: number): Promise<void> {
  await prisma.scheduledCaptureRun.update({
    where: { id: runId },
    data: { status: "SUCCEEDED", completedAt: now, resultCategory, ...tally, providerRequestCountEstimate, durationMs, nextEligibleRetryAt: null },
  });
}

async function completeDeferred(runId: string, now: Date, durationMs: number): Promise<void> {
  await prisma.scheduledCaptureRun.update({
    where: { id: runId },
    data: { status: "DEFERRED", completedAt: now, resultCategory: "BUDGET_DEFERRED", durationMs, nextEligibleRetryAt: now },
  });
}

async function completeFailed(runId: string, now: Date, resultCategory: CaptureResultCategory, durationMs: number, nextEligibleRetryAt: Date | null): Promise<void> {
  await prisma.scheduledCaptureRun.update({
    where: { id: runId },
    data: { status: "FAILED", completedAt: now, resultCategory, durationMs, nextEligibleRetryAt },
  });
}

const ZERO_TALLY: CaptureTally = { positionsExamined: 0, currentAssessmentsPersisted: 0, unavailableCount: 0, contradictionCount: 0 };

async function captureOwnerSlot(ownerId: string, sessionDate: string, slot: CaptureSlotKind, dueAt: Date, now: Date): Promise<OwnerCaptureOutcome> {
  const claim = await claimSlot(ownerId, sessionDate, slot, dueAt, now);
  if (!claim) {
    return "SKIPPED"; // already SUCCEEDED/ABANDONED, still genuinely RUNNING, or FAILED/DEFERRED not yet retry-eligible
  }
  const { id: runId, attemptCount } = claim;
  const startedAt = Date.now();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // Codex blocker repair (B1, round 3) - the ABSOLUTE per-owner budget check runs BEFORE any
    // provider call of any kind, including the cheap B1 preflight session request. Derived
    // entirely from LOCAL DATABASE STATE (`estimateProviderCost` - account/ticker counts only,
    // zero Schwab/account/position/quote/session/token calls, verified by inspection and by the
    // dedicated regression test asserting every provider-function call count is zero for this
    // branch). An owner whose OWN estimated cost exceeds the ENTIRE per-minute ceiling can never
    // fit no matter when it runs - that is BUDGET_BLOCKED, a terminal, non-retryable state, and it
    // must cost ZERO Schwab requests, not merely avoid the heavy resolver. The previous round
    // computed this AFTER the preflight call had already run, which let a permanently-over-budget
    // owner generate real provider traffic before being blocked - fixed here by moving this check
    // first and only creating the end-to-end deadline/controller once it passes.
    const estimatedCost = await estimateProviderCost(ownerId, now);
    if (estimatedCost > MAX_PROVIDER_REQUESTS_PER_MINUTE) {
      await completeFailed(runId, now, "BUDGET_BLOCKED", Date.now() - startedAt, null);
      return "FAILED";
    }

    // Codex blocker repair (B3, round 2) - the ONE end-to-end deadline for this entire attempt,
    // created BEFORE the first provider call of any kind (the B1 preflight included) - see
    // CAPTURE_TIMEOUT_MS's own doc comment. Created only now, AFTER the absolute-budget check
    // passes - there is no reason to arm a deadline for work that will never execute.
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);

    // Codex blocker repair (B1, round 2) - the preflight session gate FAILS CLOSED on every
    // non-open outcome, including UNAVAILABLE (see this module's header doc comment for the exact
    // AVAILABLE+OPEN / AVAILABLE+CLOSED / UNAVAILABLE three-way contract).
    const nyDate = nyCalendarDateOf(now);
    const sessionEvidence = await getEquityMarketSessionEvidenceForUser(ownerId, nyDate, controller.signal);

    // Codex blocker repair (B2, round 3) - the deadline is checked FIRST, before trusting
    // whatever the preflight wrapper returned. The real wrapper safely converts its own
    // AbortError into `{status:"UNAVAILABLE"}` (correct, fail-closed behavior for that module) -
    // but that must never let a genuine scheduled TIMEOUT be misclassified as SESSION_UNAVAILABLE
    // just because the wrapper's own catch got there first. A timeout always wins, regardless of
    // what the preflight call itself returned.
    if (controller.signal.aborted) {
      await completeFailed(runId, now, "TIMEOUT", Date.now() - startedAt, new Date(now.getTime() + TIMEOUT_RETRY_BACKOFF_MS));
      return "FAILED";
    }

    if (sessionEvidence.status === "UNAVAILABLE") {
      await completeFailed(runId, now, "SESSION_UNAVAILABLE", Date.now() - startedAt, new Date(now.getTime() + PROVIDER_RETRY_BACKOFF_MS));
      return "FAILED";
    }
    if (!isWithinRegularSession(sessionEvidence, now)) {
      await completeSucceeded(runId, now, "SESSION_CLOSED", ZERO_TALLY, 1, Date.now() - startedAt);
      return "SUCCEEDED";
    }

    // Normal per-minute SHARED-capacity reservation (unchanged position/logic from round 2) - an
    // owner who individually fits the absolute ceiling but has no capacity THIS MINUTE because
    // another owner already consumed it remains ordinary, retryable DEFERRED - never conflated
    // with the permanent BUDGET_BLOCKED case above.
    if (!tryReserveProviderRequestBudget(estimatedCost, now)) {
      await completeDeferred(runId, now, Date.now() - startedAt);
      return "DEFERRED";
    }

    const resolved = await captureOneOwner(ownerId, now, controller.signal);

    // Codex blocker repair (B4, round 2) - an abort that fired DURING this capture takes priority
    // over whatever the resolver's own fail-closed catches turned it into (ordinary-looking
    // UNAVAILABLE/LAST_VALID evidence for whichever branches hadn't resolved yet) - a timeout must
    // never be reported as a successful or merely-benign capture just because some other branch
    // happened to finish first, or a historical fallback happened to already be on file.
    if (controller.signal.aborted) {
      await completeFailed(runId, now, "TIMEOUT", Date.now() - startedAt, new Date(now.getTime() + TIMEOUT_RETRY_BACKOFF_MS));
      return "FAILED";
    }

    const tally = tallyPositionAssessmentDisplays(resolved);
    const authExpired = await ownerAuthExpired(ownerId);
    const category = classifyCaptureOutcome(resolved, authExpired);
    const durationMs = Date.now() - startedAt;

    if (category === "PROVIDER_UNAVAILABLE" || category === "AUTH_UNAVAILABLE") {
      const backoffMs = category === "AUTH_UNAVAILABLE" ? AUTH_RETRY_BACKOFF_MS : PROVIDER_RETRY_BACKOFF_MS;
      await completeFailed(runId, now, category, durationMs, new Date(now.getTime() + backoffMs));
      return "FAILED";
    }

    await completeSucceeded(runId, now, category, tally, estimatedCost, durationMs);
    return "SUCCEEDED";
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    // Codex blocker repair (B3, round 2) - with the deadline now created before every provider
    // call, an abort can also surface as a THROWN AbortError rather than a safely-caught
    // UNAVAILABLE evidence object (e.g. if it fires between two steps neither of which has its own
    // catch) - classify it as TIMEOUT, not UNKNOWN_ERROR, and apply TIMEOUT's own retry policy.
    if (isAbortError(error)) {
      await completeFailed(runId, now, "TIMEOUT", durationMs, new Date(now.getTime() + TIMEOUT_RETRY_BACKOFF_MS));
      return "FAILED";
    }
    // Codex blocker repair (B5) - anything else that reaches here is genuinely unexpected: the
    // resolver itself already converts every known provider/auth/session failure into safe
    // UNAVAILABLE evidence rather than throwing (see this module's header doc comment). Bounded
    // retry, never an immediate infinite retry.
    const retryEligible = attemptCount < UNKNOWN_ERROR_MAX_ATTEMPTS;
    await completeFailed(runId, now, "UNKNOWN_ERROR", durationMs, retryEligible ? new Date(now.getTime() + UNKNOWN_ERROR_RETRY_BACKOFF_MS) : null);
    return "FAILED";
  } finally {
    // `timeout` is never set when the absolute-budget check above returns BEFORE the controller
    // is even created - `clearTimeout(undefined)` is a documented no-op, never a throw.
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * One bounded heartbeat invocation - called by the protected internal endpoint, never by a page
 * render.
 *
 * Codex blocker repair (B5, round 2) - the NOTHING-DUE contract is revised: a NEW schedule slot
 * being due is no longer the only reason this heartbeat does any work. EVERY heartbeat now ALSO
 * checks for this session date's own retryable/deferred work (`eligibleRetryableRuns`), regardless
 * of whether a brand-new slot is currently due - this is what lets an intermediate, no-new-slot
 * heartbeat (e.g. 9:40 or 9:45, when the 15-minute baseline cadence has nothing new to offer) still
 * service a 9:35 DEFERRED or FAILED-retry-eligible row. The ORIGINAL contract still holds exactly
 * when there is truly nothing to do: no new slot AND no retryable/deferred row means ZERO provider
 * calls and ZERO writes (the maintenance sweeps below are skipped too) - only the one minimal,
 * already-narrowly-scoped retry-queue SELECT runs, never a broad owner-discovery query.
 *
 * Fairness/ordering guarantee (unchanged from the first Codex round, now exercised every
 * heartbeat rather than only when a new slot happens to coincide): retryable/deferred work is
 * ALWAYS processed before any new claim (oldest `dueAt` first - "oldest deferred/retryable owner
 * first"), then any remaining CONNECTED owner not already handled this heartbeat is considered in
 * least-recently-serviced order (never unspecified DB row order). A newer due slot never
 * supersedes an older deferred/retryable one - exactly the ticket's own 9:35-Matt/9:40-Eric
 * scenario (Eric's DEFERRED row keeps its ORIGINAL 9:35 `dueAt` and is reclaimed at the next
 * heartbeat regardless of whether the 9:35 slot's own due-window has since closed, and regardless
 * of whether a NEW slot is also due that same heartbeat).
 *
 * Owners are processed strictly SEQUENTIALLY (never Promise.all across owners) - this app has
 * exactly two users, so this trivially keeps cross-owner concurrency at 1, well under the ticket's
 * own 2-concurrent target; the pre-existing internal fan-out WITHIN one owner's own
 * resolvePositionReviewsForUser call (a handful of concurrent per-symbol quote requests) is
 * existing, trust-sensitive provider behavior this ticket deliberately does not rewrite. A single
 * owner's failure is fully isolated (try/catch per owner, inside captureOwnerSlot) and never blocks
 * or corrupts another owner's capture or claim.
 */
export async function runScheduledCaptureHeartbeat(now: Date = new Date()): Promise<ScheduledCaptureHeartbeatResult> {
  const due = dueCaptureSlots(now);
  const sessionDate = nyCalendarDateOf(now);

  const retryQueue = await eligibleRetryableRuns(now, sessionDate);
  if (due.length === 0 && retryQueue.length === 0) {
    return { status: "ok", due: 0, processed: 0, deferred: 0, skipped: 0, failed: 0 };
  }

  await abandonStaleRunningRows(now);
  await abandonStaleDeferredRows(now, sessionDate);

  let processed = 0;
  let deferredCount = 0;
  let skipped = 0;
  let failed = 0;
  const handledOwnerIds = new Set<string>();

  const tally = (outcome: OwnerCaptureOutcome) => {
    if (outcome === "SUCCEEDED") processed += 1;
    else if (outcome === "DEFERRED") deferredCount += 1;
    else if (outcome === "FAILED") failed += 1;
    else skipped += 1;
  };

  for (const item of retryQueue) {
    handledOwnerIds.add(item.ownerId);
    if (await ownerHasActiveRun(item.ownerId)) {
      skipped += 1;
      continue;
    }
    tally(await captureOwnerSlot(item.ownerId, item.sessionDate, item.slot, item.dueAt, now));
  }

  let newOwnerCount = 0;
  if (due.length > 0) {
    const dueSlot = due[0]!;
    const newOwnerIds = await eligibleOwnerIdsInFairOrder(handledOwnerIds);
    newOwnerCount = newOwnerIds.length;
    for (const ownerId of newOwnerIds) {
      if (await ownerHasActiveRun(ownerId)) {
        skipped += 1;
        continue;
      }
      tally(await captureOwnerSlot(ownerId, dueSlot.sessionDate, dueSlot.slot, dueSlot.dueAt, now));
    }
  }

  return { status: "ok", due: retryQueue.length + newOwnerCount, processed, deferred: deferredCount, skipped, failed };
}

/**
 * Codex blocker repair (B5) - pure presentation mapping for the Account-page indicator: never
 * "Healthy" merely because the endpoint returned without throwing (the resolver's own fail-closed
 * behavior means a benign-looking SUCCEEDED row can still mean nothing was actually captured, or
 * that an attention-worthy contradiction was found). Only CURRENT_CAPTURED is ever "healthy" -
 * SESSION_CLOSED/NO_CURRENT_LEGITIMATE/BUDGET_DEFERRED are "neutral" (true, legitimate, not a
 * problem, but not a claim that fresh guidance was captured either); everything else that needs a
 * human to look (contradiction, provider/auth outage, unknown error, an attempt that never
 * finished) is "attention".
 */
export function describeScheduledCaptureStatus(status: LatestScheduledCaptureStatus): { label: string; tone: "healthy" | "neutral" | "attention" } {
  if (!status.known) {
    return { label: "No runs yet.", tone: "neutral" };
  }
  const { status: runStatus, resultCategory } = status;
  if (runStatus === "DEFERRED") {
    return { label: "Deferred - waiting for scheduler capacity, will run on the next heartbeat", tone: "neutral" };
  }
  if (runStatus === "ABANDONED") {
    return { label: "Previous attempt did not finish in time - next scheduled slot will try again.", tone: "attention" };
  }
  switch (resultCategory) {
    case "CURRENT_CAPTURED":
      return { label: "Healthy - last successful current capture", tone: "healthy" };
    case "NO_CURRENT_LEGITIMATE":
      return { label: "No current assessment captured - no eligible positions at last check", tone: "neutral" };
    case "SESSION_CLOSED":
      return { label: "No current assessment captured - market closed at last check", tone: "neutral" };
    case "CONTRADICTION_DETECTED":
      return { label: "Connection attention needed - evidence contradiction found", tone: "attention" };
    case "PROVIDER_UNAVAILABLE":
      return { label: "No current assessment captured - provider unavailable", tone: "attention" };
    case "SESSION_UNAVAILABLE":
      return { label: "No current assessment captured - session status unavailable", tone: "attention" };
    case "AUTH_UNAVAILABLE":
      return { label: "Connection attention needed - reconnect Schwab", tone: "attention" };
    case "TIMEOUT":
      return { label: "Provider timeout - automatic capture did not complete; last known position data remains available on Dashboard/Tracker", tone: "attention" };
    case "UNKNOWN_ERROR":
      return { label: "Connection attention needed - unexpected error on last attempt", tone: "attention" };
    case "BUDGET_BLOCKED":
      return { label: "Budget blocked - automatic capture needs attention", tone: "attention" };
    default:
      return runStatus === "SUCCEEDED"
        ? { label: "No current assessment captured", tone: "neutral" }
        : { label: "Connection attention needed - last attempt failed", tone: "attention" };
  }
}

export type LatestScheduledCaptureStatus =
  | { known: false }
  | { known: true; status: "SUCCEEDED" | "FAILED" | "DEFERRED" | "ABANDONED"; resultCategory: string | null; at: Date; slot: CaptureSlotKind };

/**
 * Read-only status for the minimal Account-page indicator - the most recent ScheduledCaptureRun
 * row for this owner that has actually concluded (never a currently-RUNNING one's half-finished
 * state). Returns `{known:false}` when this owner has never had a scheduled capture attempt at all
 * - the UI then shows nothing rather than a fabricated "never" claim.
 *
 * Codex blocker repair (B5) - deliberately returns the raw `status`/`resultCategory` pair rather
 * than a pre-flattened "healthy/unhealthy" boolean: the caller (account/page.tsx) must not display
 * "Healthy" merely because this endpoint returned without throwing - only a genuine CURRENT_CAPTURED
 * result means that. This function also makes no claim about whether Hermes is actually calling the
 * scheduled-capture endpoint at all - `{known:false}` covers "never configured" identically to
 * "configured but nothing due yet," which is the honest, currently-available distinction.
 */
export async function getLatestScheduledCaptureStatusForUser(ownerId: string): Promise<LatestScheduledCaptureStatus> {
  const row = await prisma.scheduledCaptureRun.findFirst({
    where: { ownerId, status: { in: ["SUCCEEDED", "FAILED", "DEFERRED", "ABANDONED"] } },
    orderBy: { completedAt: "desc" },
    select: { status: true, resultCategory: true, completedAt: true, slot: true },
  });
  if (!row || !row.completedAt) {
    return { known: false };
  }
  return { known: true, status: row.status as "SUCCEEDED" | "FAILED" | "DEFERRED" | "ABANDONED", resultCategory: row.resultCategory, at: row.completedAt, slot: row.slot };
}
