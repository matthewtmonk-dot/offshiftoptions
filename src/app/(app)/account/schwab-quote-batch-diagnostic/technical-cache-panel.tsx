"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge, Panel } from "@/components/ui";
import { shortCalendarDate, shortDateTime } from "@/lib/format";
import {
  getTechnicalCacheFreshnessBreakdownAction,
  getTechnicalCacheReadinessAction,
  warmTechnicalIndicatorCacheAction,
} from "../../actions";
import type {
  TechnicalCacheFreshnessBreakdownActionResult,
  TechnicalCacheReadinessActionResult,
  TechnicalCacheWarmActionResult,
} from "../../actions";

type PanelState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "warming" }
  | { status: "readiness"; result: TechnicalCacheReadinessActionResult }
  | { status: "warmed"; result: TechnicalCacheWarmActionResult }
  | { status: "unexpected-error" };

type FreshnessState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "result"; result: TechnicalCacheFreshnessBreakdownActionResult }
  | { status: "unexpected-error" };

export function TechnicalCachePanel() {
  const [state, setState] = useState<PanelState>({ status: "idle" });
  const [freshness, setFreshness] = useState<FreshnessState>({ status: "idle" });
  const busy = state.status === "checking" || state.status === "warming";

  async function checkReadiness() {
    if (busy) return;
    setState({ status: "checking" });
    try {
      const result = await getTechnicalCacheReadinessAction();
      setState({ status: "readiness", result });
    } catch {
      setState({ status: "unexpected-error" });
    }
  }

  async function checkFreshness() {
    if (freshness.status === "checking") return;
    setFreshness({ status: "checking" });
    try {
      const result = await getTechnicalCacheFreshnessBreakdownAction();
      setFreshness({ status: "result", result });
    } catch {
      setFreshness({ status: "unexpected-error" });
    }
  }

  async function warm() {
    if (busy) return;
    setState({ status: "warming" });
    try {
      const result = await warmTechnicalIndicatorCacheAction();
      setState({ status: "warmed", result });
    } catch {
      setState({ status: "unexpected-error" });
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={checkReadiness}
          disabled={busy}
          data-testid="check-technical-cache-readiness-button"
          className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-wait disabled:opacity-75"
        >
          <RefreshCw className={`size-3.5 ${state.status === "checking" ? "motion-safe:animate-spin" : ""}`} aria-hidden />
          {state.status === "checking" ? "Checking…" : "Check Readiness"}
        </button>
        <button
          type="button"
          onClick={warm}
          disabled={busy}
          data-testid="warm-technical-cache-button"
          className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-sky-400/40 bg-sky-400/10 px-3 text-sm font-medium text-sky-100 transition hover:border-sky-300 hover:bg-sky-400/15 disabled:cursor-wait disabled:opacity-75"
        >
          <RefreshCw className={`size-3.5 ${state.status === "warming" ? "motion-safe:animate-spin" : ""}`} aria-hidden />
          {state.status === "warming" ? "Warming…" : "Warm Cache (up to 25 symbols)"}
        </button>
        <button
          type="button"
          onClick={checkFreshness}
          disabled={freshness.status === "checking"}
          data-testid="check-technical-cache-freshness-button"
          className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-wait disabled:opacity-75"
        >
          <RefreshCw className={`size-3.5 ${freshness.status === "checking" ? "motion-safe:animate-spin" : ""}`} aria-hidden />
          {freshness.status === "checking" ? "Checking…" : "Freshness Detail (DB only)"}
        </button>
      </div>

      {state.status === "unexpected-error" ? <p className="text-sm text-red-300">Request failed unexpectedly.</p> : null}

      {state.status === "readiness" ? <ReadinessResult result={state.result} /> : null}
      {state.status === "warmed" ? <WarmResult result={state.result} /> : null}
      {freshness.status === "unexpected-error" ? <p className="text-sm text-red-300">Request failed unexpectedly.</p> : null}
      {freshness.status === "result" ? <FreshnessResult result={freshness.result} /> : null}
    </div>
  );
}

function ReadinessResult({ result }: { result: TechnicalCacheReadinessActionResult }) {
  if (result.status === "UNAVAILABLE") {
    return (
      <Panel title="Readiness Unavailable">
        <p className="text-sm text-zinc-300">{result.message}</p>
      </Panel>
    );
  }
  return (
    <Panel title="Technical Cache Readiness">
      <div className="flex flex-wrap gap-2">
        <Badge tone="good">
          {result.readyCount} / {result.eligibleCount} ready
        </Badge>
        <Badge tone="neutral">{result.pendingCount} pending</Badge>
        <Badge tone="info">Last prepared: {result.lastPreparedAt ? shortDateTime(result.lastPreparedAt) : "never"}</Badge>
      </div>
    </Panel>
  );
}

function FreshnessResult({ result }: { result: TechnicalCacheFreshnessBreakdownActionResult }) {
  if (result.status === "NO_ACTIVE_RUN") {
    return (
      <Panel title="Freshness Detail">
        <p className="text-sm text-zinc-300">No active preparation run yet for today - check readiness or warm the cache first.</p>
      </Panel>
    );
  }
  return (
    <Panel title="Freshness Detail">
      <p className="mb-2 text-xs text-zinc-500">
        Workflow complete: {result.workflowReadyCount} / {result.eligibleCount} - refined against the same freshness rule the live scan
        itself uses.
      </p>
      <div className="flex flex-wrap gap-2">
        <Badge tone="good">{result.freshUsableCount} fresh usable now</Badge>
        {result.staleSnapshotCount > 0 ? <Badge tone="bad">{result.staleSnapshotCount} stale</Badge> : null}
        {result.failedSnapshotCount > 0 ? <Badge tone="bad">{result.failedSnapshotCount} failed</Badge> : null}
        {result.missingSnapshotCount > 0 ? <Badge tone="bad">{result.missingSnapshotCount} missing snapshot</Badge> : null}
        <Badge tone="neutral">{result.pendingCount} pending</Badge>
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-xs text-zinc-400">
        <span>Required market date right now: {shortCalendarDate(result.requiredMarketDate)}</span>
        <span>·</span>
        <span>Newest snapshot market date: {result.newestSnapshotMarketDate ? shortCalendarDate(result.newestSnapshotMarketDate) : "none"}</span>
        <span>·</span>
        <span>
          Oldest fresh snapshot market date:{" "}
          {result.oldestFreshSnapshotMarketDate ? shortCalendarDate(result.oldestFreshSnapshotMarketDate) : "none"}
        </span>
      </div>
    </Panel>
  );
}

function WarmResult({ result }: { result: TechnicalCacheWarmActionResult }) {
  if (result.status === "UNAVAILABLE") {
    return (
      <Panel title="Warm-Up Unavailable">
        <p className="text-sm text-zinc-300">{result.message}</p>
      </Panel>
    );
  }
  return (
    <Panel title="Warm-Up Result">
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge tone="neutral">{result.processedCount} selected</Badge>
        <Badge tone="good">{result.succeededCount} refreshed</Badge>
        {result.failedCount > 0 ? <Badge tone="bad">{result.failedCount} failed</Badge> : null}
        <Badge tone="neutral">{result.remainingEligibleCount} remaining after this batch</Badge>
        <Badge tone="info">{result.elapsedMs}ms elapsed</Badge>
      </div>
      {result.remainingEligibleCount > 0 ? (
        <p className="mt-2 text-xs text-zinc-500">Click &quot;Warm Cache&quot; again to process the next batch.</p>
      ) : null}
    </Panel>
  );
}
