import "server-only";

import { prisma } from "./prisma";
import { dueCaptureSlots, type CaptureSlotKind } from "@/domain/finance/scheduledCaptureSlots";
import { isKnownTransientFallbackReason, type PositionAssessmentDisplay } from "@/domain/finance/positionReviewAssessment";
import { resolvePositionAssessmentDisplaysForUser, type ResolvedPositionAssessmentDisplay } from "./positionAssessmentOrchestration";
import { loadOpenAndAssignedCampaignsForUser } from "./workflows";
import { DEFAULT_ROLL_BUFFER_PERCENT } from "@/domain/finance/rollStatus";
import { estimateProviderCost, tryReserveProviderRequestBudget } from "./scheduled-capture-budget";
import { getEquityMarketSessionEvidenceForUser } from "./live-quotes";
import { isWithinRegularSession, nyCalendarDateOf } from "@/domain/finance/marketSession";

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
 * Codex blocker repair (B1, early close) - before any heavy per-owner work, this module asks this
 * owner's OWN real Schwab session evidence (`getEquityMarketSessionEvidenceForUser`, the exact
 * same evidence the live evaluator itself trusts) whether `now` actually falls inside the regular
 * session. Schwab's own evidence already correctly encodes early closes (e.g. the day after
 * Thanksgiving) - no hardcoded/guessed holiday calendar is added here. When that evidence is
 * AVAILABLE and says the session is closed, this slot completes immediately as SUCCEEDED/
 * SESSION_CLOSED for roughly one request's cost, never entering the heavy resolver - this is what
 * stops an early-close afternoon from repeating a full A+M+2 capture every 15 minutes until FINAL.
 * When the evidence itself is UNAVAILABLE, this gate NEVER guesses "closed" from a failure - it
 * falls through to the heavy path exactly as before, so a session-evidence outage can only ever
 * cost MORE work (safe), never incorrectly suppress a real capture.
 *
 * Measured provider-request cost (see PROJECT_HANDOFF.md for the full measurement): one cold-cache
 * `resolvePositionReviewsForUser` cycle for a user with A Schwab accounts and M distinct tickers
 * needing review costs (1 + A) broker-read calls + M quote calls (one per symbol, NOT batched -
 * this is EXISTING, trust-sensitive provider behavior, deliberately NOT rewritten by this ticket)
 * + 1 session call = A + M + 2 real Schwab requests on the heavy path, PLUS the one cheap B1 gate
 * call above (A + M + 3 total when the session turns out to be open) - see scheduled-capture-
 * budget.ts's own doc comment for the full budget-reservation formula (which adds further
 * headroom on top of this real-cost number).
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
 * Codex blocker repair (B3) - the real, HONORED cancellation deadline for one owner's heavy
 * capture work, enforced via a genuine `AbortController` threaded all the way through
 * `resolvePositionAssessmentDisplaysForUser` -> `resolvePositionReviewsForUser` -> the three
 * provider-touching functions (which already honor an `AbortSignal` for the existing manual-
 * refresh path - this ticket only threads that SAME existing capability into the scheduled read/
 * evaluate path too). This is NOT a `Promise.race` that leaves the underlying fetch running
 * unobserved - the signal is the one actually passed to `fetch`, so an aborted request is actually
 * cancelled network-side. 45s is chosen to comfortably exceed this app's own measured typical
 * capture latency (a handful of sequential/concurrent Schwab requests) while still being short
 * enough that a genuinely hung request does not occupy an owner's "active run" slot for long.
 *
 * Hermes recommendation: the documented `curl --max-time` MUST exceed this server-side deadline
 * plus write/network overhead - recommend `--max-time 60` (45s deadline + 15s margin), replacing
 * the previous, unsafe `--max-time 25` (which could not possibly cover a real capture attempt and
 * would abandon the HTTP request from Hermes's side while the server kept working regardless).
 */
const CAPTURE_TIMEOUT_MS = 45_000;

/** A PROVIDER_UNAVAILABLE slot is not retried sooner than this - gives a transient provider hiccup
 * real recovery time rather than being hammered on the very next 5-minute heartbeat. */
const PROVIDER_RETRY_BACKOFF_MS = 5 * 60_000;
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
  | "UNKNOWN_ERROR"
  | "BUDGET_DEFERRED"
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
 * Codex blocker repair (B4) - this session date's DEFERRED rows whose own backoff has passed,
 * oldest `dueAt` first (the exact "oldest deferred owner first" fairness rule the ticket
 * requires) - never relying on unspecified database row order.
 */
async function eligibleDeferredRuns(now: Date, sessionDate: string) {
  return prisma.scheduledCaptureRun.findMany({
    where: { status: "DEFERRED", sessionDate, nextEligibleRetryAt: { not: null, lte: now } },
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
 * Codex blocker repair (B5) - classifies an ALREADY-resolved, already-fail-closed display set into
 * one of the operational outcome categories, WITHOUT changing or reinterpreting the resolver's own
 * CURRENT/LAST_VALID/UNAVAILABLE trust decision for any individual campaign. The resolver
 * intentionally converts provider/auth failures into safe UNAVAILABLE displays (correct for
 * trading guidance) - this function exists precisely because "the resolver didn't throw" is NOT
 * the same question as "did this capture run actually accomplish anything," which is what the
 * Account-page health indicator needs to answer honestly.
 *
 * Priority order (highest first): a genuine CONTRADICTION always wins (never hidden behind a
 * partially-successful run); then any meaningful display (CURRENT or LAST_VALID - a verified
 * historical fallback is a real operational success, not a failure, and LAST_VALID's own
 * eligibility check already guarantees its reasonCodes are never a contradiction, so it is never
 * re-checked here); then a genuine broker/quote/session PROVIDER problem (split into
 * AUTH_UNAVAILABLE vs PROVIDER_UNAVAILABLE using this owner's OWN `BrokerConnection.status`,
 * re-read AFTER the attempt - `EXPIRED` means the token refresh itself failed, a stronger signal
 * than "merely" a transient provider hiccup); then a resolver-detected closed session (defensive -
 * B1's own gate above should already intercept this before heavy work even starts, but this stays
 * correct if session evidence changes between the gate check and the heavy resolver's own fetch);
 * finally, everything else (only benign reasons, or zero relevant campaigns at all) is legitimately
 * nothing-to-capture, never an error.
 */
export function classifyCaptureOutcome(resolved: readonly { display: PositionAssessmentDisplay }[], authExpired: boolean): CaptureResultCategory {
  if (resolved.length === 0) {
    return "NO_CURRENT_LEGITIMATE";
  }

  let hasMeaningfulDisplay = false;
  let hasContradiction = false;
  let hasProviderIssue = false;
  let hasSessionClosed = false;

  for (const { display } of resolved) {
    if (display.state === "CURRENT" || display.state === "LAST_VALID") {
      hasMeaningfulDisplay = true;
      continue;
    }
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
  if (hasMeaningfulDisplay) return "CURRENT_CAPTURED";
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

async function captureOwnerSlot(ownerId: string, sessionDate: string, slot: CaptureSlotKind, dueAt: Date, now: Date): Promise<OwnerCaptureOutcome> {
  const claim = await claimSlot(ownerId, sessionDate, slot, dueAt, now);
  if (!claim) {
    return "SKIPPED"; // already SUCCEEDED/ABANDONED, still genuinely RUNNING, or FAILED/DEFERRED not yet retry-eligible
  }
  const { id: runId, attemptCount } = claim;

  // Codex blocker repair (B1) - cheap authoritative session gate BEFORE any heavy work. See this
  // module's header doc comment: proceeds to heavy work whenever evidence is UNAVAILABLE, never
  // guesses "closed" from a failed lookup.
  const nyDate = nyCalendarDateOf(now);
  const sessionEvidence = await getEquityMarketSessionEvidenceForUser(ownerId, nyDate);
  if (sessionEvidence.status === "AVAILABLE" && !isWithinRegularSession(sessionEvidence, now)) {
    await completeSucceeded(runId, now, "SESSION_CLOSED", { positionsExamined: 0, currentAssessmentsPersisted: 0, unavailableCount: 0, contradictionCount: 0 }, 1, 0);
    return "SUCCEEDED";
  }

  // Codex blocker repair (B2) - a dynamic, DB-derived cost estimate, reserved against the shared
  // per-minute budget BEFORE any heavy provider work. A denial is BUDGET_DEFERRED, never FAILED -
  // see scheduled-capture-budget.ts's own doc comment for the formula/reasoning.
  const estimatedCost = await estimateProviderCost(ownerId, now);
  if (!tryReserveProviderRequestBudget(estimatedCost, now)) {
    await completeDeferred(runId, now, 0);
    return "DEFERRED";
  }

  // Codex blocker repair (B3) - a real, HONORED AbortController deadline (see CAPTURE_TIMEOUT_MS's
  // own doc comment), never a Promise.race that leaves the underlying fetch running unobserved.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const resolved = await captureOneOwner(ownerId, now, controller.signal);
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
  } catch {
    // Codex blocker repair (B5) - anything that reaches here is genuinely unexpected: the resolver
    // itself already converts every known provider/auth/session failure into safe UNAVAILABLE
    // evidence rather than throwing (see this module's header doc comment). Bounded retry, never
    // an immediate infinite retry.
    const durationMs = Date.now() - startedAt;
    const retryEligible = attemptCount < UNKNOWN_ERROR_MAX_ATTEMPTS;
    await completeFailed(runId, now, "UNKNOWN_ERROR", durationMs, retryEligible ? new Date(now.getTime() + UNKNOWN_ERROR_RETRY_BACKOFF_MS) : null);
    return "FAILED";
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * One bounded heartbeat invocation - called by the protected internal endpoint, never by a page
 * render. "Nothing due" (outside every slot's window, or a non-market day) costs ZERO database
 * writes and ZERO provider calls - the slot-due check runs first, entirely in memory.
 *
 * Codex blocker repair (B4) - fairness/ordering guarantee: this heartbeat FIRST retries this
 * session date's own DEFERRED rows (oldest `dueAt` first - "oldest deferred owner first"), THEN
 * considers any remaining CONNECTED owner not already handled this heartbeat, in least-recently-
 * serviced order (never unspecified DB row order). A newer due slot never supersedes an older
 * deferred one: the deferred queue is always processed before new claims, so a legitimately
 * deferred owner is never starved by a later slot appearing first - exactly the ticket's own
 * 9:35-Matt/9:40-Eric scenario (Eric's DEFERRED row keeps its ORIGINAL 9:35 `dueAt` and is reclaimed
 * at the next heartbeat regardless of whether the 9:35 slot's own due-window has since closed).
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
  if (due.length === 0) {
    return { status: "ok", due: 0, processed: 0, deferred: 0, skipped: 0, failed: 0 };
  }
  const dueSlot = due[0]!;

  await abandonStaleRunningRows(now);
  await abandonStaleDeferredRows(now, dueSlot.sessionDate);

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

  const deferredQueue = await eligibleDeferredRuns(now, dueSlot.sessionDate);
  for (const item of deferredQueue) {
    handledOwnerIds.add(item.ownerId);
    if (await ownerHasActiveRun(item.ownerId)) {
      skipped += 1;
      continue;
    }
    tally(await captureOwnerSlot(item.ownerId, item.sessionDate, item.slot, item.dueAt, now));
  }

  const newOwnerIds = await eligibleOwnerIdsInFairOrder(handledOwnerIds);
  for (const ownerId of newOwnerIds) {
    if (await ownerHasActiveRun(ownerId)) {
      skipped += 1;
      continue;
    }
    tally(await captureOwnerSlot(ownerId, dueSlot.sessionDate, dueSlot.slot, dueSlot.dueAt, now));
  }

  return { status: "ok", due: deferredQueue.length + newOwnerIds.length, processed, deferred: deferredCount, skipped, failed };
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
    return { label: "Catching up - a prior capture was deferred for budget and will run on the next heartbeat.", tone: "neutral" };
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
    case "AUTH_UNAVAILABLE":
      return { label: "Connection attention needed - reconnect Schwab", tone: "attention" };
    case "UNKNOWN_ERROR":
      return { label: "Connection attention needed - unexpected error on last attempt", tone: "attention" };
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
