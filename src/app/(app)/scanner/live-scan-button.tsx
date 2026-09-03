"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { runLiveSchwabScannerAction } from "../actions";

type LiveScanButtonState =
  | { status: "idle" }
  | { status: "pending"; elapsedSeconds: number }
  | { status: "done"; scanned: number; nearMatches: number; elapsedMs: number }
  | { status: "error"; message: string };

const COMPLETION_MESSAGE_VISIBLE_MS = 8000;

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
        setState({ status: "done", scanned: result.scanned, nearMatches: result.nearMatches, elapsedMs: result.elapsedMs });
        dismissRef.current = setTimeout(() => setState({ status: "idle" }), COMPLETION_MESSAGE_VISIBLE_MS);
      } else {
        setState({ status: "error", message: result.error });
      }
    } catch {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
      setState({ status: "error", message: "Live scan failed unexpectedly. Try again in a moment." });
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
          <span className="text-emerald-300">
            {state.scanned} scanned · {state.nearMatches} near matches · {(state.elapsedMs / 1000).toFixed(1)}s
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
