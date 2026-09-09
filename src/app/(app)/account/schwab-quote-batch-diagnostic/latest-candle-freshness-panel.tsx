"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge, Panel } from "@/components/ui";
import { shortCalendarDate } from "@/lib/format";
import { runLatestCandleFreshnessDiagnosticAction } from "../../actions";
import type { LatestCandleFreshnessDiagnosticActionResult } from "../../actions";

type PanelState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "result"; result: LatestCandleFreshnessDiagnosticActionResult }
  | { status: "unexpected-error" };

export function LatestCandleFreshnessPanel() {
  const [state, setState] = useState<PanelState>({ status: "idle" });
  const busy = state.status === "checking";

  async function check() {
    if (busy) return;
    setState({ status: "checking" });
    try {
      const result = await runLatestCandleFreshnessDiagnosticAction();
      setState({ status: "result", result });
    } catch {
      setState({ status: "unexpected-error" });
    }
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={check}
        disabled={busy}
        data-testid="check-latest-candle-freshness-button"
        className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-wait disabled:opacity-75"
      >
        <RefreshCw className={`size-3.5 ${busy ? "motion-safe:animate-spin" : ""}`} aria-hidden />
        {busy ? "Checking…" : "Check Latest Candle (5 symbols)"}
      </button>

      {state.status === "unexpected-error" ? <p className="text-sm text-red-300">Request failed unexpectedly.</p> : null}
      {state.status === "result" ? <Result result={state.result} /> : null}
    </div>
  );
}

function Result({ result }: { result: LatestCandleFreshnessDiagnosticActionResult }) {
  if (result.status === "UNAVAILABLE") {
    return (
      <Panel title="Latest Candle Freshness Unavailable">
        <p className="text-sm text-zinc-300">{result.message}</p>
      </Panel>
    );
  }
  return (
    <Panel title="Latest Candle Freshness">
      <p className="mb-2 text-xs text-zinc-500">Required market date right now: {shortCalendarDate(result.requiredMarketDate)}</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[320px] text-left text-sm">
          <thead className="text-xs text-zinc-500">
            <tr>
              <th className="py-1 pr-4">Ticker</th>
              <th className="py-1 pr-4">Latest candle</th>
              <th className="py-1">Fresh</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row) => (
              <tr key={row.ticker} className="border-t border-zinc-800">
                <td className="py-1.5 pr-4 font-mono text-zinc-200">{row.ticker}</td>
                <td className="py-1.5 pr-4 text-zinc-300">
                  {row.latestCandleMarketDate ? shortCalendarDate(row.latestCandleMarketDate) : "none"}
                </td>
                <td className="py-1.5">
                  <Badge tone={row.fresh ? "good" : "bad"}>{row.fresh ? "YES" : "NO"}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
