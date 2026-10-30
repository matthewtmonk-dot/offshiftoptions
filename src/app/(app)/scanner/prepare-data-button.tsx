"use client";

import { DatabaseZap } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { prepareTechnicalDataAction } from "../actions";
import { runPrepareDataLoop, type PrepareLoopResult } from "./prepare-data-loop";

type State =
  | { status: "idle" }
  | { status: "running"; processed: number; total: number | null; stopping: boolean }
  | { status: "finished"; result: PrepareLoopResult };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * "Prepare data now" - fills in the scanner's RSI / Bollinger data on demand instead of waiting for the
 * scheduled morning run. Each press repeats one bounded server cycle (~125 symbols, ~15 seconds) until the
 * data is complete, so a full refresh takes roughly 5-10 minutes with progress shown. Read-only market
 * data; no orders. The repeat/stop logic lives in prepare-data-loop.ts (unit-tested); this only wires state.
 */
export function PrepareDataButton() {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });
  const stopRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopRef.current = true;
    };
  }, []);

  async function run() {
    if (state.status === "running") return;
    stopRef.current = false;
    const result = await runPrepareDataLoop({
      prepare: prepareTechnicalDataAction,
      sleep,
      shouldStop: () => stopRef.current,
      onProgress: ({ processed, total }) => {
        if (mountedRef.current) setState({ status: "running", processed, total, stopping: stopRef.current });
      },
    });
    if (!mountedRef.current) return;
    setState({ status: "finished", result });
    if (result.processed > 0) router.refresh(); // pick up the newly prepared data in the banner and the results
  }

  const running = state.status === "running";

  return (
    <div className="mt-2 flex flex-col items-start gap-1" data-testid="prepare-data">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={run}
          disabled={running}
          data-testid="prepare-data-button"
          title="Downloads the daily prices the scanner needs for RSI and Bollinger %B. Read-only market data; no orders. Takes roughly 5-10 minutes; you can leave this page open and keep working."
          className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-amber-300/50 bg-amber-300/10 px-2.5 text-xs font-medium text-amber-50 transition hover:border-amber-200 hover:bg-amber-300/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <DatabaseZap className={`size-3.5 ${running ? "motion-safe:animate-pulse" : ""}`} aria-hidden />
          {running ? "Preparing data…" : "Prepare data now"}
        </button>
        {running ? (
          <button
            type="button"
            onClick={() => {
              stopRef.current = true;
              setState((prev) => (prev.status === "running" ? { ...prev, stopping: true } : prev));
            }}
            className="text-xs text-amber-100 underline underline-offset-2 hover:text-white"
          >
            {state.status === "running" && state.stopping ? "Stopping after this step…" : "Stop"}
          </button>
        ) : null}
      </div>
      <div aria-live="polite" className="text-xs empty:hidden">
        {state.status === "running" ? (
          <span className="text-amber-100/90">
            {state.total === null ? "Starting…" : `Prepared ${state.processed.toLocaleString()} of ${state.total.toLocaleString()} stocks…`} Keep this page open.
          </span>
        ) : null}
        {state.status === "finished" && state.result.status === "complete" ? (
          <span className="text-emerald-300">All {state.result.processed.toLocaleString()} stocks prepared. Run Live Scan to see the results.</span>
        ) : null}
        {state.status === "finished" && state.result.status === "paused" ? (
          <span className="text-amber-100">
            Prepared {state.result.processed.toLocaleString()} so far, {state.result.remaining.toLocaleString()} left. {state.result.note}
          </span>
        ) : null}
        {state.status === "finished" && state.result.status === "error" ? <span className="text-red-300">{state.result.message}</span> : null}
      </div>
    </div>
  );
}
