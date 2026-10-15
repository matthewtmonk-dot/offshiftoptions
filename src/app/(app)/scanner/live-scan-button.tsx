"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { describeActionFailure } from "@/lib/action-failure-message";
import { checkMoreScannerOptionsAction, runLiveSchwabScannerAction, type RunLiveScanResult } from "../actions";
import { MAX_ROWS_PER_CLICK, runOptionCheckLoop } from "./option-check-loop";

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

/** The automatic "Check options" step that follows a successful scan - see option-check-loop.ts. */
type PricingState =
  | { status: "idle" }
  | { status: "running"; checked: number; stopping: boolean }
  | { status: "done"; checked: number; pass: number; near: number; remaining: number; note: string | null }
  | { status: "error"; message: string };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  const [pricing, setPricing] = useState<PricingState>({ status: "idle" });
  const stopPricingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopPricingRef.current = true; // leaving the page stops further pricing batches
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
        void priceQualifiedStocks();
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

  async function priceQualifiedStocks() {
    stopPricingRef.current = false;
    setPricing({ status: "running", checked: 0, stopping: false });
    const outcome = await runOptionCheckLoop({
      awaiting: MAX_ROWS_PER_CLICK,
      checkBatch: checkMoreScannerOptionsAction,
      sleep,
      shouldStop: () => stopPricingRef.current,
      onProgress: ({ checked }) => {
        if (mountedRef.current) setPricing({ status: "running", checked, stopping: stopPricingRef.current });
      },
    });
    if (!mountedRef.current) return;
    setPricing(outcome.status === "error" ? { status: "error", message: outcome.message } : { ...outcome });
  }

  const pending = state.status === "pending";
  const pricingRunning = pricing.status === "running";

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={runScan}
        disabled={pending || pricingRunning}
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
          <div className="space-y-0.5">
            <span className="text-emerald-300">
              {state.scanned} scanned · {state.nearMatches} near matches · {(state.elapsedMs / 1000).toFixed(1)}s
            </span>
            <p className="text-zinc-500">
              Universe: {state.universeSymbols}
              {state.universeSource === "LIMITED_FALLBACK" ? " (limited - OCC cache empty)" : ""} · Quoted: {state.successfullyQuoted} ·
              Price/volume survivors: {state.priceAndVolumeSurvivors} · Technical ready: {state.technicalReadyCount}
              {state.technicalPendingCount + state.technicalStaleCount + state.technicalFailedCount > 0
                ? ` (${state.technicalPendingCount + state.technicalStaleCount + state.technicalFailedCount} not ready)`
                : ""}{" "}
              · Option chains checked: {state.optionChainsChecked} · Results: {state.scanned}
            </p>
            {isTechnicalCoverageMaterial(state) ? (
              <p className="text-amber-300">
                Technical preparation still running — results may expand as more symbols become ready.
              </p>
            ) : null}
          </div>
        ) : null}
        {pricing.status === "running" ? (
          <p className="text-sky-300" data-testid="auto-pricing-status">
            Now looking up weekly option prices for the stocks that passed… {pricing.checked} done{" "}
            <button
              type="button"
              onClick={() => {
                stopPricingRef.current = true;
                setPricing((prev) => (prev.status === "running" ? { ...prev, stopping: true } : prev));
              }}
              className="underline underline-offset-2 hover:text-sky-100"
            >
              {pricing.stopping ? "Stopping after this batch…" : "Stop"}
            </button>
          </p>
        ) : null}
        {pricing.status === "done" ? (
          <p className="text-emerald-300" data-testid="auto-pricing-status">
            Option prices looked up for {pricing.checked} stocks · {pricing.pass} pass · {pricing.near} near
            {pricing.remaining > 0 ? ` · ${pricing.remaining} more still waiting (press Check options)` : ""}
            {pricing.note ? <span className="block text-amber-300">{pricing.note}</span> : null}
          </p>
        ) : null}
        {pricing.status === "error" ? <p className="text-amber-300">{pricing.message}</p> : null}
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
