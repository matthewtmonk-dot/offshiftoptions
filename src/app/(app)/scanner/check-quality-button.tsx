"use client";

import { ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { refreshCompanyQualityAction } from "./company-quality-actions";

const MAX_ROUNDS = 12;

type State =
  | { status: "idle" }
  | { status: "running"; done: number; total: number }
  | { status: "done"; done: number; notFound: number }
  | { status: "error"; message: string };

/**
 * "Check company quality" - reads each listed company's SEC filings (a few at a time, each batch its own server call so
 * progress is visible and the page can be left at any time) and stores the result. Read-only toward everything.
 */
export function CheckQualityButton({ tickers }: { tickers: string[] }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "idle" });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function run() {
    if (state.status === "running") return;
    const total = tickers.length;
    let done = 0;
    let notFound = 0;
    setState({ status: "running", done, total });
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      let outcome;
      try {
        outcome = await refreshCompanyQualityAction(tickers);
      } catch {
        if (mounted.current) setState({ status: "error", message: "Something went wrong. Try again." });
        return;
      }
      if (!mounted.current) return;
      if (!outcome.ok) {
        setState({ status: "error", message: outcome.error });
        return;
      }
      done += outcome.processed;
      notFound += outcome.notFound;
      setState({ status: "running", done, total });
      if (outcome.remaining === 0 || outcome.processed === 0) break;
    }
    if (!mounted.current) return;
    setState({ status: "done", done, notFound });
    router.refresh();
  }

  const running = state.status === "running";
  return (
    <div className="flex flex-col items-start gap-1" data-testid="check-quality">
      <button
        type="button"
        onClick={run}
        disabled={running || tickers.length === 0}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-sky-400/40 bg-sky-400/10 px-3 text-sm font-medium text-sky-100 hover:border-sky-300 disabled:cursor-not-allowed disabled:opacity-60"
        title="Reads each listed company's SEC filings to judge minimum financial health. Read-only."
      >
        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        {running ? "Checking…" : `Check company quality (${tickers.length})`}
      </button>
      {state.status === "running" ? <span className="text-xs text-zinc-400">Checked {state.done} of {state.total}…</span> : null}
      {state.status === "done" ? <span className="text-xs text-zinc-400">Checked {state.done}. {state.notFound > 0 ? `${state.notFound} had no SEC filings (funds or foreign companies) and need a manual look.` : ""}</span> : null}
      {state.status === "error" ? <span className="text-xs text-red-300">{state.message}</span> : null}
    </div>
  );
}
