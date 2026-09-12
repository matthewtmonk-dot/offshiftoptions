"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { Badge, Panel } from "@/components/ui";
import { shortCalendarDate } from "@/lib/format";
import { compareScannerTickersAction } from "../../actions";
import type { ScannerTickerComparisonActionResult } from "../../actions";

type PanelState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "result"; result: ScannerTickerComparisonActionResult }
  | { status: "unexpected-error" };

export function ScannerTickerComparisonPanel() {
  const [input, setInput] = useState("");
  const [state, setState] = useState<PanelState>({ status: "idle" });
  const busy = state.status === "checking";

  async function check() {
    if (busy) return;
    const tickers = input
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (!tickers.length) return;

    setState({ status: "checking" });
    try {
      const result = await compareScannerTickersAction(tickers);
      setState({ status: "result", result });
    } catch {
      setState({ status: "unexpected-error" });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="AAL, AEO, BYND, CCL, CELH, PINS, PL, UPST, UUUU, XPEV"
          data-testid="scanner-ticker-comparison-input"
          className="min-h-9 w-full max-w-md rounded-md border border-zinc-700 bg-zinc-950 px-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-400/60 focus:outline-none"
        />
        <button
          type="button"
          onClick={check}
          disabled={busy || !input.trim()}
          data-testid="scanner-ticker-comparison-button"
          className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-wait disabled:opacity-75"
        >
          <Search className="size-3.5" aria-hidden />
          {busy ? "Checking…" : "Compare (up to 25)"}
        </button>
      </div>

      {state.status === "unexpected-error" ? <p className="text-sm text-red-300">Request failed unexpectedly.</p> : null}
      {state.status === "result" ? <Result result={state.result} /> : null}
    </div>
  );
}

function Result({ result }: { result: ScannerTickerComparisonActionResult }) {
  if (result.status === "UNAVAILABLE") {
    return (
      <Panel title="Comparison Unavailable">
        <p className="text-sm text-zinc-300">{result.message}</p>
      </Panel>
    );
  }
  return (
    <Panel title="Ticker Comparison">
      <p className="mb-2 text-xs text-zinc-500">Required market date: {shortCalendarDate(result.requiredMarketDate)}</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="text-xs text-zinc-500">
            <tr>
              <th className="py-1 pr-3">Ticker</th>
              <th className="py-1 pr-3">Universe</th>
              <th className="py-1 pr-3">Quote</th>
              <th className="py-1 pr-3">Price/Vol</th>
              <th className="py-1 pr-3">Technical</th>
              <th className="py-1 pr-3">RSI / BB%</th>
              <th className="py-1 pr-3">Earnings</th>
              <th className="py-1">Why</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row) => (
              <tr key={row.ticker} className="border-t border-zinc-800 align-top">
                <td className="py-1.5 pr-3 font-mono text-zinc-200">
                  {row.ticker}
                  {row.inResearchTier1 ? <span className="ml-1 text-[10px] text-sky-300">TIER1</span> : null}
                </td>
                <td className="py-1.5 pr-3">
                  <Badge tone={row.inOccUniverse || row.inResearchTier1 ? "good" : "bad"}>
                    {row.inOccUniverse || row.inResearchTier1 ? "YES" : "NO"}
                  </Badge>
                </td>
                <td className="py-1.5 pr-3 text-zinc-300">
                  {row.quoteError ? <span className="text-red-300">error</span> : row.quote ? `$${row.quote.price.toFixed(2)}` : "—"}
                </td>
                <td className="py-1.5 pr-3">
                  <span className={row.survivesPriceRule === false ? "text-red-300" : "text-zinc-300"}>
                    {row.survivesPriceRule === null ? "—" : row.survivesPriceRule ? "price OK" : "price FAIL"}
                  </span>
                  {" / "}
                  <span className={row.survivesVolumeRule === false ? "text-red-300" : "text-zinc-300"}>
                    {row.survivesVolumeRule === null ? "—" : row.survivesVolumeRule ? "vol OK" : "vol FAIL"}
                  </span>
                </td>
                <td className="py-1.5 pr-3">
                  <Badge tone={row.technicalState === "READY" ? "good" : "warn"}>{row.technicalState}</Badge>
                </td>
                <td className="py-1.5 pr-3 text-zinc-300">
                  {row.rsi ?? "—"} / {row.bbPercent === null ? "—" : `${row.bbPercent.toFixed(0)}%`}
                </td>
                <td className="py-1.5 pr-3 text-zinc-300">
                  {row.earnings ? `${row.earnings.daysUntilReport}d (${shortCalendarDate(row.earnings.reportDate)})` : "—"}
                </td>
                <td className="py-1.5 text-xs text-zinc-400">{row.reasonSummary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
