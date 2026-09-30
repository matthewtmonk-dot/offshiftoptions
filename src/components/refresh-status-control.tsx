"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { refreshPositionEvidenceAction } from "@/app/(app)/actions";
import { formatEtTime } from "@/lib/format";

/**
 * Post-Phase-2 UX follow-up (correctness repair) - a last-resort, CLIENT-only fallback cooldown,
 * used only when the server action itself rejects unexpectedly (a network failure, a thrown
 * exception before the server could even return its own authoritative `availableAgainAt`). In the
 * normal case - success OR a typed failure result - the server's own `availableAgainAt`
 * (refreshPositionEvidenceForUserGuarded, workflows.ts) is authoritative and this constant is not
 * used at all. Matches that same server-side default (see REFRESH_POSITION_EVIDENCE_COOLDOWN_MS) -
 * not a fabricated limit, and not a claimed Schwab quota.
 */
const FALLBACK_COOLDOWN_MS = 15_000;

/**
 * Dashboard V2 Phase 2 follow-up - the ONE manual "Refresh status" control in the authenticated app
 * (rendered once, in the global app header - see layout.tsx). Triggers ONLY
 * refreshPositionEvidenceAction (read-only Schwab positions + the quote/session evidence actually
 * required for a fresh position review, never transactions/campaign history/accounting) and then
 * `router.refresh()` so the already-approved Phase 2 evaluator (resolvePositionReviewsForUser)
 * picks up the newly-uncached evidence on its own next render - this component never computes or
 * duplicates any review/roll logic itself.
 *
 * Always neutral/factual: initial state is "Ready" (no prior click yet), a click shows
 * "Refreshing…", success shows "Last checked <time> · Ready", and failure shows a concise reason
 * without ever implying financial data changed or pretending evidence became fresh. The server is
 * authoritative for cooldown timing (`availableAgainAt`) whenever it returns one - including on a
 * typed failure - so the countdown here reflects the SAME process-local guard the server itself
 * enforces (see refresh-guard.ts), never a client-invented number.
 *
 * Codex correctness repair - explicit try/catch/finally around the server action call: an
 * unexpected rejection (not just a typed `{ ok: false }` result) can no longer leave this component
 * stuck showing "Refreshing…" forever. `pending` always ends, a factual failure message is always
 * shown, and a cooldown always applies (falling back to `FALLBACK_COOLDOWN_MS` only when the
 * rejection happened before any server-authoritative cooldown could be returned at all).
 */
export function RefreshStatusControl() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [availableAt, setAvailableAt] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number | null>(null);

  // Ticks only while a cooldown is actually active, so the "Available again in Ns" countdown
  // updates - never runs at all otherwise.
  useEffect(() => {
    if (availableAt === null) {
      return;
    }
    const tick = () => setNowMs(Date.now());
    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [availableAt]);

  const cooldownActive = availableAt !== null && nowMs !== null && nowMs < availableAt;
  const cooldownRemainingSec = cooldownActive ? Math.max(1, Math.ceil((availableAt! - nowMs!) / 1000)) : 0;
  const disabled = pending || cooldownActive;

  function handleClick() {
    if (disabled) {
      return;
    }
    setErrorMessage(null);
    startTransition(async () => {
      try {
        const result = await refreshPositionEvidenceAction();
        setAvailableAt(new Date(result.availableAgainAt).getTime());
        if (result.ok) {
          setLastRefreshedAt(new Date(result.refreshedAt));
          router.refresh();
        } else {
          setErrorMessage(refreshFailureMessage(result.reason));
        }
      } catch {
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

function refreshFailureMessage(reason: "NO_CONNECTION" | "BROKER_REFRESH_FAILED" | "MARKET_DATA_REFRESH_FAILED"): string {
  if (reason === "NO_CONNECTION") {
    return "Schwab connection needs attention";
  }
  return "Current status could not be refreshed";
}
