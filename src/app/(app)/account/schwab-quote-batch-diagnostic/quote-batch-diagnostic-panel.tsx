"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge, Panel } from "@/components/ui";
import { shortDateTime } from "@/lib/format";
import { runSchwabQuoteBatchDiagnosticAction } from "../../actions";
import type { SchwabQuoteBatchDiagnosticResult, SchwabQuoteBatchSizeOutcome } from "@/lib/schwab-quote-batch-diagnostic";

type PanelState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "done"; result: SchwabQuoteBatchDiagnosticResult }
  | { status: "unexpected-error" };

export function QuoteBatchDiagnosticPanel() {
  const [state, setState] = useState<PanelState>({ status: "idle" });
  const pending = state.status === "pending";

  async function run() {
    if (pending) return;
    setState({ status: "pending" });
    try {
      const result = await runSchwabQuoteBatchDiagnosticAction();
      setState({ status: "done", result });
    } catch {
      setState({ status: "unexpected-error" });
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={run}
          disabled={pending}
          aria-describedby="schwab-quote-batch-diagnostic-status"
          data-testid="run-schwab-quote-batch-diagnostic-button"
          className="inline-flex min-h-9 w-fit items-center justify-center gap-2 rounded-md border border-sky-400/40 bg-sky-400/10 px-3 text-sm font-medium text-sky-100 transition hover:border-sky-300 hover:bg-sky-400/15 disabled:cursor-wait disabled:opacity-75"
        >
          <RefreshCw className={`size-3.5 ${pending ? "motion-safe:animate-spin" : ""}`} aria-hidden />
          {pending ? "Running…" : "Run Schwab Quote Batch-Size Diagnostic"}
        </button>
        <div id="schwab-quote-batch-diagnostic-status" aria-live="polite" className="text-xs empty:hidden">
          {pending ? <span className="text-zinc-500">Testing 5 → 25 → 50 → 100 symbols against your live connection…</span> : null}
          {state.status === "unexpected-error" ? (
            <span className="text-red-300">
              Diagnostic failed unexpectedly.{" "}
              <button type="button" onClick={run} className="underline underline-offset-2 hover:text-red-100">
                Retry
              </button>
            </span>
          ) : null}
        </div>
      </div>

      {state.status === "done" ? <DiagnosticResult result={state.result} onRetry={run} /> : null}
    </div>
  );
}

function DiagnosticResult({ result, onRetry }: { result: SchwabQuoteBatchDiagnosticResult; onRetry: () => void }) {
  if (result.status === "UNAVAILABLE") {
    return (
      <Panel title="Diagnostic Unavailable">
        <p className="text-sm text-zinc-300">{result.message}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 inline-flex min-h-8 items-center rounded-md border border-zinc-700 px-3 text-xs font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
        >
          Retry
        </button>
      </Panel>
    );
  }

  return (
    <Panel title="Batch-Size Results">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Badge tone="good">Read only</Badge>
          <Badge tone="neutral">Nothing saved</Badge>
          <Badge tone="info">Market data only - no account/position data touched</Badge>
          <Badge tone={result.largestVerifiedBatchSize ? "good" : "bad"}>
            Largest verified batch size: {result.largestVerifiedBatchSize ?? "none"}
          </Badge>
        </div>
        <p className="text-xs text-zinc-500">Timestamp: {shortDateTime(result.timestamp)}</p>
        <div className="space-y-1">
          {result.results.map((outcome) => (
            <BatchSizeRow key={outcome.requestedCount} outcome={outcome} />
          ))}
        </div>
      </div>
    </Panel>
  );
}

function BatchSizeRow({ outcome }: { outcome: SchwabQuoteBatchSizeOutcome }) {
  const tone = outcome.outcome === "SUCCESS" ? "good" : "bad";
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-xs">
      <span className="font-medium text-zinc-200">{outcome.requestedCount} symbols requested</span>
      <Badge tone={tone}>{outcome.outcome}</Badge>
      {outcome.outcome === "SUCCESS" ? (
        <span className="text-zinc-400">
          {outcome.symbolsReturnedCount} of {outcome.distinctSymbolsRequested} distinct symbols returned
          {outcome.missingCount ? ` (${outcome.missingCount} missing)` : ""} · {outcome.elapsedMs}ms
        </span>
      ) : (
        <span className="text-zinc-400">
          {outcome.httpStatus ? `HTTP ${outcome.httpStatus}` : "request failed"} · {outcome.elapsedMs}ms
        </span>
      )}
    </div>
  );
}
