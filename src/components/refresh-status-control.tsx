"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { refreshPositionEvidenceAction } from "@/app/(app)/actions";
import { formatEtTime } from "@/lib/format";

/**
 * Codex blocker repair (C) - the tab-scoped (never a cookie, which would leak to other tabs or an
 * unrelated prefetch hitting the same page within a TTL window) one-shot signal telling Dashboard/
 * Tracker's next server render "the live Schwab/market-data fetch just failed - skip it entirely
 * this once and resolve from durable historical data only" (see resolvePositionReviewsForUser's
 * own `skipLiveEvidence` option). Lives only in THIS navigation's URL, driven entirely by this
 * tab's own client JS - never a shared cookie jar.
 */
const SKIP_LIVE_EVIDENCE_PARAM = "oso_skip_live";

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
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [availableAt, setAvailableAt] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number | null>(null);

  // Codex blocker repair (C) - strips the one-shot skip-live-evidence marker from the visible URL
  // as soon as it's observed client-side (a plain history-API call, no network, no second
  // navigation) - the server already consumed it for the render that just happened.
  useEffect(() => {
    if (searchParams.has(SKIP_LIVE_EVIDENCE_PARAM)) {
      const remaining = new URLSearchParams(searchParams.toString());
      remaining.delete(SKIP_LIVE_EVIDENCE_PARAM);
      const query = remaining.toString();
      window.history.replaceState(null, "", query ? `${pathname}?${query}` : pathname);
    }
  }, [pathname, searchParams]);

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
    setErrorMessage(null);
    startTransition(async () => {
      try {
        const result = await refreshPositionEvidenceAction();
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
          setErrorMessage(refreshFailureMessage(result.reason));
        }
        if (result.shouldRefreshClient) {
          if (result.ok) {
            router.refresh();
          } else {
            // Codex blocker repair (C) - a genuine failure still deserves a chance to resolve a
            // durable LAST_VALID fallback, but a plain router.refresh() here would re-run the
            // page's own live evaluator against the cache this SAME failed attempt just cleared -
            // a guaranteed second real provider call for one click. Instead, navigate with the
            // tab-scoped skip-live-evidence marker so the next render resolves from durable
            // historical data only (zero further provider calls) - see
            // resolvePositionReviewsForUser's own `skipLiveEvidence` option.
            const next = new URLSearchParams(searchParams.toString());
            next.set(SKIP_LIVE_EVIDENCE_PARAM, "1");
            router.replace(`${pathname}?${next.toString()}`, { scroll: false });
          }
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

function refreshFailureMessage(reason: "NO_CONNECTION" | "BROKER_REFRESH_FAILED" | "MARKET_DATA_REFRESH_FAILED" | "TIMEOUT"): string {
  if (reason === "NO_CONNECTION") {
    return "Schwab connection needs attention";
  }
  if (reason === "TIMEOUT") {
    return "Refresh timed out";
  }
  return "Current status could not be refreshed";
}
