"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { processAlphaVantageFundamentalsQueueAction } from "../actions";

type State =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "done"; message: string }
  | { status: "error"; message: string };

const STOPPED_REASON_LABEL: Record<string, string> = {
  COMPLETE: "queue emptied",
  BUDGET_EXHAUSTED: "today's auto budget is used up",
  RATE_LIMITED: "Alpha Vantage asked us to slow down",
  LOCK_UNAVAILABLE: "another refresh was already in progress",
  NO_API_KEY: "Alpha Vantage is not configured",
};

export function AlphaVantageQueueButton() {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });
  const pending = state.status === "pending";

  async function run() {
    if (pending) return;
    setState({ status: "pending" });
    try {
      const response = await processAlphaVantageFundamentalsQueueAction();
      if (!response.ok) {
        setState({ status: "error", message: response.error });
        return;
      }
      const { summary } = response;
      const reason = STOPPED_REASON_LABEL[summary.stoppedReason] ?? summary.stoppedReason;
      setState({
        status: "done",
        message: `${summary.callsConsumed} call${summary.callsConsumed === 1 ? "" : "s"} used - stopped: ${reason}.`,
      });
      router.refresh();
    } catch {
      setState({ status: "error", message: "Processing the queue failed unexpectedly." });
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        data-testid="process-alpha-vantage-queue-button"
        className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-emerald-400/40 bg-emerald-400/10 px-3 text-xs font-medium text-emerald-100 transition hover:border-emerald-300 hover:bg-emerald-400/15 disabled:cursor-wait disabled:opacity-75"
      >
        <RefreshCw className={`size-3.5 ${pending ? "motion-safe:animate-spin" : ""}`} aria-hidden />
        {pending ? "Processing…" : "Process fundamentals queue"}
      </button>
      <div aria-live="polite" data-testid="alpha-vantage-queue-status" className="text-xs empty:hidden">
        {state.status === "done" ? <span className="text-emerald-300">{state.message}</span> : null}
        {state.status === "error" ? <span className="text-red-300">{state.message}</span> : null}
      </div>
    </div>
  );
}
