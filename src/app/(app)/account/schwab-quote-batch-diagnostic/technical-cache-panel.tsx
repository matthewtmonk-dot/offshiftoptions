"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge, Panel } from "@/components/ui";
import { shortCalendarDate, shortDateTime } from "@/lib/format";
import {
  getTechnicalCacheFreshnessBreakdownAction,
  getTechnicalCacheReadinessAction,
  getTechnicalPreparationRunAggregatesAction,
  warmTechnicalIndicatorCacheAction,
} from "../../actions";
import type {
  TechnicalCacheFreshnessBreakdownActionResult,
  TechnicalCacheReadinessActionResult,
  TechnicalCacheWarmActionResult,
  TechnicalPreparationRunAggregatesActionResult,
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

type RunAggregatesState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "result"; result: TechnicalPreparationRunAggregatesActionResult }
  | { status: "unexpected-error" };

export function TechnicalCachePanel() {
  const [state, setState] = useState<PanelState>({ status: "idle" });
  const [freshness, setFreshness] = useState<FreshnessState>({ status: "idle" });
  const [runAggregates, setRunAggregates] = useState<RunAggregatesState>({ status: "idle" });
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

  async function checkRunAggregates() {
    if (runAggregates.status === "checking") return;
    setRunAggregates({ status: "checking" });
    try {
      const result = await getTechnicalPreparationRunAggregatesAction();
      setRunAggregates({ status: "result", result });
    } catch {
      setRunAggregates({ status: "unexpected-error" });
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
        <button
          type="button"
          onClick={checkRunAggregates}
          disabled={runAggregates.status === "checking"}
          data-testid="check-technical-preparation-runs-button"
          className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-wait disabled:opacity-75"
        >
          <RefreshCw className={`size-3.5 ${runAggregates.status === "checking" ? "motion-safe:animate-spin" : ""}`} aria-hidden />
          {runAggregates.status === "checking" ? "Checking…" : "Run Detail (DB only)"}
        </button>
      </div>

      {state.status === "unexpected-error" ? <p className="text-sm text-red-300">Request failed unexpectedly.</p> : null}

      {state.status === "readiness" ? <ReadinessResult result={state.result} /> : null}
      {state.status === "warmed" ? <WarmResult result={state.result} /> : null}
      {freshness.status === "unexpected-error" ? <p className="text-sm text-red-300">Request failed unexpectedly.</p> : null}
      {freshness.status === "result" ? <FreshnessResult result={freshness.result} /> : null}
      {runAggregates.status === "unexpected-error" ? <p className="text-sm text-red-300">Request failed unexpectedly.</p> : null}
      {runAggregates.status === "result" ? <RunAggregatesResult result={runAggregates.result} /> : null}
    </div>
  );
}

function DailyCandleNotReadyResult({
  result,
}: {
  result: {
    status: "DAILY_CANDLE_NOT_READY" | "CANDLE_GATE_INCONCLUSIVE";
    requiredMarketDate: string;
    freshProbeCount: number;
    staleProbeCount: number;
    unavailableProbeCount: number;
  };
}) {
  const inconclusive = result.status === "CANDLE_GATE_INCONCLUSIVE";
  return (
    <Panel title={inconclusive ? "Provider Readiness Inconclusive" : "Provider Not Ready Yet"}>
      <p className="text-sm text-zinc-300">
        {inconclusive
          ? `Fewer than 3 public probe symbols returned usable history for the required market date (${shortCalendarDate(
              result.requiredMarketDate,
            )}) - skipped bulk preparation this click because readiness could not be proven.`
          : `The provider has not yet published the required market date's (${shortCalendarDate(
              result.requiredMarketDate,
            )}) daily candle for the public probe sample - skipped bulk preparation this click rather than creating thousands of items that would all wait on the same real cause.`}
      </p>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <Badge tone="good">{result.freshProbeCount} fresh probe(s)</Badge>
        <Badge tone="warn">{result.staleProbeCount} stale probe(s)</Badge>
        {result.unavailableProbeCount > 0 ? <Badge tone="neutral">{result.unavailableProbeCount} unavailable probe(s)</Badge> : null}
      </div>
    </Panel>
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
  if (result.status !== "OK") {
    return <DailyCandleNotReadyResult result={result} />;
  }
  return (
    <Panel title="Technical Cache Readiness">
      <div className="flex flex-wrap gap-2">
        <Badge tone="good">
          Fresh usable: {result.readyCount} / {result.eligibleCount}
        </Badge>
        <Badge tone="neutral">Pending: {result.pendingCount}</Badge>
        {result.deferredCount > 0 ? <Badge tone="warn">Waiting for latest daily candle: {result.deferredCount}</Badge> : null}
        {result.failedCount > 0 ? <Badge tone="bad">Failed: {result.failedCount}</Badge> : null}
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
        {result.deferredCount > 0 ? <Badge tone="warn">{result.deferredCount} waiting for latest daily candle</Badge> : null}
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

function RunAggregatesResult({ result }: { result: TechnicalPreparationRunAggregatesActionResult }) {
  return (
    <Panel title="Preparation Runs">
      <p className="mb-3 text-xs text-zinc-500">
        Current market date: {shortCalendarDate(result.currentMarketDate)} - Required candle date:{" "}
        {shortCalendarDate(result.requiredMarketDate)}
      </p>
      {result.runs.length === 0 ? (
        <p className="text-sm text-zinc-300">No technical preparation runs found for your user.</p>
      ) : (
        <div className="space-y-3">
          {result.runs.map((run) => (
            <div key={`${run.marketDate}-${run.createdAt}`} className="border-t border-zinc-800 pt-3 first:border-t-0 first:pt-0">
              <div className="mb-2 flex flex-wrap gap-2">
                <Badge tone="info">Market date: {shortCalendarDate(run.marketDate)}</Badge>
                <Badge tone={run.runStatus === "COMPLETE" ? "good" : "warn"}>{run.runStatus}</Badge>
                <Badge tone="neutral">Eligible: {run.eligibleCount ?? "creating"}</Badge>
                <Badge tone="neutral">Items: {run.itemCount}</Badge>
                {run.isCurrentRunIdentity ? <Badge tone="good">Current rules</Badge> : <Badge tone="neutral">Prior rules/date</Badge>}
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge tone="good">Ready: {run.readyCount}</Badge>
                <Badge tone="neutral">Pending: {run.pendingCount}</Badge>
                {run.processingCount > 0 ? <Badge tone="info">Processing: {run.processingCount}</Badge> : null}
                {run.deferredCount > 0 ? <Badge tone="warn">Deferred: {run.deferredCount}</Badge> : null}
                {run.failedCount > 0 ? <Badge tone="bad">Failed: {run.failedCount}</Badge> : null}
                <Badge tone="info">Updated: {shortDateTime(run.updatedAt)}</Badge>
              </div>
            </div>
          ))}
        </div>
      )}
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
  if (result.status !== "OK") {
    return <DailyCandleNotReadyResult result={result} />;
  }
  return (
    <Panel title="Warm-Up Result">
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge tone="neutral">{result.processedCount} selected</Badge>
        <Badge tone="good">{result.succeededCount} refreshed</Badge>
        {result.deferredCount > 0 ? <Badge tone="warn">{result.deferredCount} waiting for latest daily candle</Badge> : null}
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
