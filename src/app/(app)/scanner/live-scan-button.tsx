"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { describeActionFailure } from "@/lib/action-failure-message";
import { runLiveSchwabScannerAction, type RunLiveScanResult } from "../actions";

type LiveScanButtonState =
  | { status: "idle" }
  | { status: "pending"; elapsedSeconds: number }
  | ({ status: "done" } & Extract<RunLiveScanResult, { ok: true }>)
  | { status: "error"; message: string };

/** Below this fraction of quote+volume survivors having READY technical data, the scan summary
 * shows a compact caution rather than presenting incomplete coverage as if the scan were fully
 * settled - never an error, just an honest "more may show up later" note (see
 * PROJECT_HANDOFF.md's "partial technical cache behavior" design). */
const MATERIAL_TECHNICAL_COVERAGE_THRESHOLD = 0.9;

const COMPLETION_MESSAGE_VISIBLE_MS = 8000;

function isTechnicalCoverageMaterial(state: Extract<RunLiveScanResult, { ok: true }>): boolean {
  const notReady = state.technicalPendingCount + state.technicalStaleCount + state.technicalFailedCount;
  const total = state.technicalReadyCount + notReady;
  if (total === 0 || notReady === 0) {
    return false; // nothing pending/stale/failed - never a caution when there's nothing incomplete
  }
  return state.technicalReadyCount / total < MATERIAL_TECHNICAL_COVERAGE_THRESHOLD;
}

export function LiveScanButton() {
  const [state, setState] = useState<LiveScanButtonState>({ status: "idle" });
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (tickRef.current) {
        clearInterval(tickRef.current);
      }
      if (dismissRef.current) {
        clearTimeout(dismissRef.current);
      }
    };
  }, []);

  async function runScan() {
    if (state.status === "pending") {
      return;
    }
    if (dismissRef.current) {
      clearTimeout(dismissRef.current);
      dismissRef.current = null;
    }

    setState({ status: "pending", elapsedSeconds: 0 });
    tickRef.current = setInterval(() => {
      setState((prev) => (prev.status === "pending" ? { status: "pending", elapsedSeconds: prev.elapsedSeconds + 1 } : prev));
    }, 1000);

    try {
      const result = await runLiveSchwabScannerAction();
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
      if (result.ok) {
        setState({ status: "done", ...result });
        dismissRef.current = setTimeout(() => setState({ status: "idle" }), COMPLETION_MESSAGE_VISIBLE_MS);
        // The scan only auto-prices options for a handful of names. Price the rest of the qualified
        // stocks right away so the user never has to know a second step exists. Bounded (60 names),
        // paced, stoppable, and read-only market data - see scanner-option-check.ts.
        // Pricing the remaining options and the company-quality check now happen on the page itself
        // (ScanAutoFinisher), which picks up the refreshed scan - one path, whether or not this button ran it.
      } else {
        setState({ status: "error", message: result.error });
      }
    } catch (error) {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
      setState({ status: "error", message: describeActionFailure(error, "Live scan failed unexpectedly. Try again in a moment.") });
    }
  }

  const pending = state.status === "pending";

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={runScan}
        disabled={pending}
        aria-describedby="live-scan-status"
        data-testid="run-live-scan-button"
        className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-sky-400/40 bg-sky-400/10 px-3 text-sm font-medium text-sky-100 transition hover:border-sky-300 hover:bg-sky-400/15 disabled:cursor-wait disabled:opacity-75"
      >
        <RefreshCw className={`size-3.5 ${pending ? "motion-safe:animate-spin" : ""}`} aria-hidden />
        {pending ? "Scanning…" : "Run Live Scan"}
      </button>
      <div id="live-scan-status" aria-live="polite" data-testid="live-scan-status" className="text-xs empty:hidden">
        {state.status === "pending" ? (
          <span className="text-zinc-500">Checking live market data and option chains… Elapsed: {state.elapsedSeconds}s</span>
        ) : null}
        {state.status === "done" ? (
          <span className="text-emerald-300" title={`Universe ${state.universeSymbols}${state.universeSource === "LIMITED_FALLBACK" ? " (limited - OCC cache empty)" : ""} · quoted ${state.successfullyQuoted} · price/volume survivors ${state.priceAndVolumeSurvivors} · technical ready ${state.technicalReadyCount} · option chains checked ${state.optionChainsChecked}`}>
            Scan done in {(state.elapsedMs / 1000).toFixed(0)}s
            {isTechnicalCoverageMaterial(state) ? <span className="block text-amber-300">Some stocks&apos; RSI/Bollinger data is still being prepared - more may appear later.</span> : null}
          </span>
        ) : null}
        {state.status === "error" ? (
          <span className="text-red-300">
            {state.message}{" "}
            <button type="button" onClick={runScan} className="underline underline-offset-2 hover:text-red-100">
              Retry
            </button>
          </span>
        ) : null}
      </div>
    </div>
  );
}
