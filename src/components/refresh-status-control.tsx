"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { refreshPositionEvidenceAction } from "@/app/(app)/actions";
import { formatEtTime } from "@/lib/format";

/**
 * Post-Phase-2 UX follow-up - a modest client-side spam-prevention cooldown, reusing this app's own
 * already-established broker positions/accounts cache TTL default (see withBrokerReadCache in
 * providers/broker-read/cache.ts) rather than inventing a new arbitrary delay. This is NOT a
 * server-enforced or persisted rate limit - no trustworthy Schwab-provided request-quota evidence
 * exists to build one on (see this component's own return-receipt note) - it exists purely so a
 * user cannot fire off rapid duplicate manual refreshes from the UI.
 */
const COOLDOWN_MS = 15_000;

/**
 * Dashboard V2 Phase 2 follow-up - the ONE shared "Refresh status" control, rendered both in the
 * global app header (every authenticated page) and Tracker's own toolbar, so the two can never
 * drift into two different refresh implementations/wordings. Triggers ONLY
 * refreshPositionEvidenceAction (read-only Schwab positions + quote/session evidence, never
 * transactions/campaign history/accounting) and then `router.refresh()` so the already-approved
 * Phase 2 evaluator (resolvePositionReviewsForUser) picks up the newly-uncached evidence on its own
 * next render - this component never computes or duplicates any review/roll logic itself.
 *
 * Always neutral/factual: initial state is "Ready" (no prior click yet), a click shows
 * "Refreshing…", success shows "Last checked <time> · Ready", and failure shows a concise reason
 * without ever implying financial data changed or pretending evidence became fresh.
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
      const result = await refreshPositionEvidenceAction();
      // Codex UX follow-up - a cooldown applies after EVERY attempt (success or failure), never
      // just success - this is spam protection against rapid clicks, not a success reward.
      setAvailableAt(Date.now() + COOLDOWN_MS);
      if (result.ok) {
        setLastRefreshedAt(new Date(result.refreshedAt));
        router.refresh();
      } else {
        setErrorMessage(result.reason === "NO_CONNECTION" ? "Schwab connection needs attention" : "Current status could not be refreshed");
      }
    });
  }

  let secondary: string;
  if (pending) {
    secondary = "Checking current status…";
  } else if (errorMessage) {
    secondary = errorMessage;
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
