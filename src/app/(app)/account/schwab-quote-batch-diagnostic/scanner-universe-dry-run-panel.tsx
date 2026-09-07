"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge, Panel } from "@/components/ui";
import { runScannerUniverseDryRunAction } from "../../actions";
import type { ScannerUniverseDryRunActionResult } from "../../actions";

type PanelState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "done"; result: ScannerUniverseDryRunActionResult }
  | { status: "unexpected-error" };

export function ScannerUniverseDryRunPanel() {
  const [state, setState] = useState<PanelState>({ status: "idle" });
  const pending = state.status === "pending";

  async function run() {
    if (pending) return;
    setState({ status: "pending" });
    try {
      const result = await runScannerUniverseDryRunAction();
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
          aria-describedby="scanner-universe-dry-run-status"
          data-testid="run-scanner-universe-dry-run-button"
          className="inline-flex min-h-9 w-fit items-center justify-center gap-2 rounded-md border border-sky-400/40 bg-sky-400/10 px-3 text-sm font-medium text-sky-100 transition hover:border-sky-300 hover:bg-sky-400/15 disabled:cursor-wait disabled:opacity-75"
        >
          <RefreshCw className={`size-3.5 ${pending ? "motion-safe:animate-spin" : ""}`} aria-hidden />
          {pending ? "Measuring…" : "Run Scanner Universe Dry Run"}
        </button>
        <div id="scanner-universe-dry-run-status" aria-live="polite" className="text-xs empty:hidden">
          {pending ? <span className="text-zinc-500">Quoting your full universe with your own connection - no history, no chains, no scan saved…</span> : null}
          {state.status === "unexpected-error" ? (
            <span className="text-red-300">
              Measurement failed unexpectedly.{" "}
              <button type="button" onClick={run} className="underline underline-offset-2 hover:text-red-100">
                Retry
              </button>
            </span>
          ) : null}
        </div>
      </div>

      {state.status === "done" ? <DryRunResult result={state.result} onRetry={run} /> : null}
    </div>
  );
}

function DryRunResult({ result, onRetry }: { result: ScannerUniverseDryRunActionResult; onRetry: () => void }) {
  if (result.status === "UNAVAILABLE") {
    return (
      <Panel title="Measurement Unavailable">
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
    <Panel title="Stage 1 Funnel">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Badge tone="good">Read only</Badge>
          <Badge tone="neutral">No ScanRun created</Badge>
          <Badge tone="neutral">No history or option-chain calls</Badge>
          <Badge tone="info">Your own Schwab connection only</Badge>
        </div>
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Datum label="Universe symbols" value={result.universeSymbols} />
          <Datum label="Successfully quoted" value={result.successfullyQuoted} />
          <Datum label="Quote failures" value={result.quoteFailures} />
          <Datum label="Price survivors" value={result.priceSurvivors} />
          <Datum label="Price + volume survivors" value={result.priceAndVolumeSurvivors} />
          <Datum label="Estimated history calls" value={result.estimatedHistoryCallsRequired} />
          <Datum label="Estimated option-chain calls" value={result.estimatedOptionChainCallsRequired} />
          <Datum label="Earnings known" value={result.earningsKnown} />
          <Datum label="Earnings unknown" value={result.earningsUnknown} />
        </dl>
      </div>
    </Panel>
  );
}

function Datum({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-normal text-zinc-500">{label}</dt>
      <dd className="mt-1 font-medium text-zinc-100">{value.toLocaleString()}</dd>
    </div>
  );
}
