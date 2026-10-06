"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { refreshPositionEvidenceAction } from "@/app/(app)/actions";
import { formatEtTime } from "@/lib/format";

/**
 * Post-Phase-2 UX follow-up (correctness repair) - a last-resort, CLIENT-only fallback cooldown,
 * used only when the server action itself rejects unexpectedly (a network failure, a thrown
 * exception before the server could even return its own authoritative `availableAgainAt`). In the
 * normal case - success, a typed failure, or a cooldown reuse - the server's own `availableAgainAt`
 * (refreshPositionEvidenceForUserGuarded, workflows.ts) is authoritative and this constant is not
 * used at all. Matches that same server-side default (see REFRESH_POSITION_EVIDENCE_COOLDOWN_MS) -
 * not a fabricated limit, and not a claimed Schwab quota.
 */
const FALLBACK_COOLDOWN_MS = 15_000;

/**
 * Dashboard V2 Phase 2 follow-up - the ONE manual "Refresh status" control in the authenticated app
 * (rendered once, in the global app header - see layout.tsx). Triggers ONLY
 * refreshPositionEvidenceAction (read-only Schwab positions + the quote/session evidence actually
 * required for a fresh position review, never transactions/campaign history/accounting) - this
 * component never computes or duplicates any review/roll logic itself.
 *
 * Always neutral/factual: initial state is "Ready" (no prior click yet), a click shows
 * "Refreshing…", success shows "Last checked <time> · Ready", and failure shows a concise reason
 * without ever implying financial data changed or pretending evidence became fresh.
 *
 * Final correctness fixes:
 * 1. The server is authoritative for BOTH cooldown timing (`availableAgainAt`) AND whether the
 *    client should call `router.refresh()` at all (`shouldRefreshClient`) - this component never
 *    re-derives either from the raw `ok`/timestamps itself. A `COOLDOWN` disposition (this app's
 *    15-second manual-refresh cooldown is still active - see refresh-guard.ts) never triggers
 *    `router.refresh()` and never overwrites the "Last checked" time already shown: it only updates
 *    the countdown. Only a genuinely fresh result (`EXECUTED`, or `COALESCED` - this click's own
 *    request joined an already-running refresh someone else triggered and received its real,
 *    completed outcome) updates "Last checked" and refreshes the page's own data.
 * 2. Explicit try/catch around the server action call: an unexpected rejection (not just a typed
 *    `{ ok: false }` result) can no longer leave this component stuck showing "Refreshing…" forever.
 *    `pending` always ends, a factual failure message is always shown, and a cooldown always applies
 *    (falling back to `FALLBACK_COOLDOWN_MS` only when the rejection happened before any
 *    server-authoritative cooldown could be returned at all).
 * 3. The countdown interval stops itself once it reaches zero, rather than ticking forever.
 */
export function RefreshStatusControl() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [availableAt, setAvailableAt] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number | null>(null);
  // V1 client safety - a click's own async result must never publish state once a NEWER click
  // has started (e.g. the first click's own promise settles late, after the user already clicked
  // again), and never after this component has unmounted. A ref, not state, so the check below
  // always reads the LATEST value rather than one captured in a stale closure. This has no
  // bearing on data correctness (the server's own per-user generation fencing in refresh-guard.ts
  // already independently guarantees a stale attempt's result is never confused with a newer
  // one's) - it only prevents this component's OWN displayed text/countdown from momentarily
  // flashing a superseded click's outcome, or updating state after unmount.
  const latestClickToken = useRef(0);
  useEffect(() => {
    return () => {
      latestClickToken.current = -1;
    };
  }, []);

  // Ticks only while a cooldown is actually active, and stops itself once it reaches zero.
  useEffect(() => {
    if (availableAt === null) {
      return;
    }
    const target = availableAt;
    const interval = setInterval(tick, 250);
    function tick() {
      const current = Date.now();
      setNowMs(current);
      if (current >= target) {
        clearInterval(interval);
      }
    }
    tick();
    return () => clearInterval(interval);
  }, [availableAt]);

  const cooldownActive = availableAt !== null && nowMs !== null && nowMs < availableAt;
  const cooldownRemainingSec = cooldownActive ? Math.max(1, Math.ceil((availableAt! - nowMs!) / 1000)) : 0;
  const disabled = pending || cooldownActive;

  function handleClick() {
    if (disabled) {
      return;
    }
    const myToken = ++latestClickToken.current;
    setErrorMessage(null);
    startTransition(async () => {
      try {
        const result = await refreshPositionEvidenceAction();
        if (latestClickToken.current !== myToken) {
          // A newer click has since started, or this component has unmounted - this stale
          // completion must never publish its own state over whatever is current now.
          return;
        }
        setAvailableAt(new Date(result.availableAgainAt).getTime());

        if (result.disposition === "COOLDOWN") {
          // Codex correctness fix - a COOLDOWN result performed no new work at all: never overwrite
          // the "Last checked" time or error state already shown, and never refresh the page's data
          // for it - only the countdown above updates.
          return;
        }

        if (result.ok) {
          setLastRefreshedAt(new Date(result.refreshedAt));
          setErrorMessage(null);
        } else {
          // V1 scope decision - a failed attempt reports the failure and stops there: no
          // automatic retry, no navigation, no attempt to resolve a historical fallback from
          // this click. The currently displayed page/data is left exactly as it was. Opening
          // Dashboard/Tracker fresh afterward already resolves LAST_VALID correctly server-side
          // when a real eligible historical assessment exists (see positionAssessmentOrchestration.ts) -
          // a failed manual refresh click just doesn't trigger that render by itself in V1.
          setErrorMessage(refreshFailureMessage(result.reason));
        }
        if (result.shouldRefreshClient) {
          router.refresh();
        }
      } catch {
        if (latestClickToken.current !== myToken) {
          return;
        }
        // The server action rejected outright (network failure, unexpected exception before it
        // could return its own authoritative cooldown) - never leave the button stuck disabled
        // forever showing "Refreshing…", and never claim a false success.
        setAvailableAt(Date.now() + FALLBACK_COOLDOWN_MS);
        setErrorMessage("Current status could not be refreshed");
      }
    });
  }

  let secondary: string;
  if (pending) {
    secondary = "Checking current status…";
  } else if (errorMessage) {
    secondary = cooldownActive ? `${errorMessage} · Available again in ${cooldownRemainingSec}s` : errorMessage;
  } else if (cooldownActive) {
    secondary = `Available again in ${cooldownRemainingSec}s`;
  } else if (lastRefreshedAt) {
    secondary = `Last checked ${formatEtTime(lastRefreshedAt)} · Ready`;
  } else {
    secondary = "Ready";
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 text-xs font-medium text-zinc-100 transition hover:border-sky-400 disabled:opacity-60"
      >
        <RefreshCw className={`size-3.5 ${pending ? "animate-spin" : ""}`} aria-hidden />
        {pending ? "Refreshing…" : "Refresh status"}
      </button>
      <span className={`text-[11px] ${errorMessage ? "text-amber-400" : "text-zinc-500"}`}>{secondary}</span>
    </div>
  );
}

function refreshFailureMessage(reason: "NO_CONNECTION" | "BROKER_REFRESH_FAILED" | "MARKET_DATA_REFRESH_FAILED" | "TIMEOUT"): string {
  if (reason === "NO_CONNECTION") {
    return "Schwab connection needs attention";
  }
  if (reason === "TIMEOUT") {
    return "Refresh timed out";
  }
  return "Current status could not be refreshed";
}
