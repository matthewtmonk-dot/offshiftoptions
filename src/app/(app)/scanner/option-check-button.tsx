"use client";

import { ListChecks } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { checkMoreScannerOptionsAction } from "../actions";
import { MAX_ROWS_PER_CLICK, runOptionCheckLoop } from "./option-check-loop";

type State =
  | { status: "idle" }
  | { status: "running"; checked: number; target: number; stopping: boolean }
  | { status: "done"; checked: number; pass: number; near: number; remaining: number; note: string | null }
  | { status: "error"; message: string };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * "Check options" - prices the options of stock-qualified candidates the last scan didn't have room
 * to check (see scanner-option-check.ts for the safety rules). Each batch is its own server call, so
 * progress is visible, the user can stop at any time, and nothing keeps running after they leave the
 * page. The batching/stop logic lives in option-check-loop.ts (unit-tested); this only wires state.
 */
export function OptionCheckButton({ awaiting }: { awaiting: number }) {
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
    const result = await runOptionCheckLoop({
      awaiting,
      checkBatch: checkMoreScannerOptionsAction,
      sleep,
      shouldStop: () => stopRef.current,
      onProgress: ({ checked, target }) => {
        if (mountedRef.current) setState({ status: "running", checked, target, stopping: stopRef.current });
      },
    });
    if (!mountedRef.current) return;
    setState(result.status === "error" ? { status: "error", message: result.message } : { ...result });
  }

  const running = state.status === "running";
  const label = awaiting > MAX_ROWS_PER_CLICK ? `Check options (${MAX_ROWS_PER_CLICK} of ${awaiting})` : `Check options (${awaiting})`;

  return (
    <div className="flex flex-col items-start gap-1" data-testid="option-check">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={run}
          disabled={running || awaiting === 0}
          data-testid="option-check-button"
          title="Prices the weekly put options for qualified stocks that haven't been option-checked yet. Read-only market data; no orders."
          className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-sky-400/40 bg-sky-400/10 px-2.5 text-xs font-medium text-sky-100 transition hover:border-sky-300 hover:bg-sky-400/15 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <ListChecks className={`size-3.5 ${running ? "motion-safe:animate-pulse" : ""}`} aria-hidden />
          {running ? "Checking options…" : label}
        </button>
        {running ? (
          <button
            type="button"
            onClick={() => {
              stopRef.current = true;
              setState((prev) => (prev.status === "running" ? { ...prev, stopping: true } : prev));
            }}
            className="text-xs text-zinc-400 underline underline-offset-2 hover:text-zinc-200"
          >
            {state.status === "running" && state.stopping ? "Stopping after this batch…" : "Stop"}
          </button>
        ) : null}
      </div>
      <div aria-live="polite" className="text-xs empty:hidden">
        {state.status === "running" ? <span className="text-zinc-500">Priced {state.checked} of {state.target}…</span> : null}
        {state.status === "done" ? (
          <span className="text-emerald-300">
            Priced {state.checked} · {state.pass} pass · {state.near} near · {state.remaining} still waiting
            {state.note ? <span className="block text-amber-300">{state.note}</span> : null}
          </span>
        ) : null}
        {state.status === "error" ? <span className="text-red-300">{state.message}</span> : null}
      </div>
    </div>
  );
}
