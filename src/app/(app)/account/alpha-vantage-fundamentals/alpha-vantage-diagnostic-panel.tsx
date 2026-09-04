"use client";

import { useState } from "react";
import { PlayCircle, TriangleAlert } from "lucide-react";
import { Badge, Panel } from "@/components/ui";
import { shortDateTime } from "@/lib/format";
import { runAlphaVantageOverviewDiagnosticAction, runAlphaVantageRemainingTickersDiagnosticAction } from "../../actions";
import type { AlphaVantageDiagnosticResult } from "@/lib/alpha-vantage-diagnostic";
import type { AlphaVantageFieldPresence, AlphaVantageTickerOutcome } from "@/providers/alpha-vantage/overview-diagnostic";

type RunVariant = "ALL" | "REMAINING";
type PanelState =
  | { status: "idle" }
  | { status: "pending"; variant: RunVariant }
  | { status: "done"; result: AlphaVantageDiagnosticResult }
  | { status: "error"; message: string };

export function AlphaVantageDiagnosticPanel() {
  const [state, setState] = useState<PanelState>({ status: "idle" });
  const pending = state.status === "pending";

  async function run(variant: RunVariant) {
    if (pending) return;
    setState({ status: "pending", variant });
    try {
      const response = variant === "ALL" ? await runAlphaVantageOverviewDiagnosticAction() : await runAlphaVantageRemainingTickersDiagnosticAction();
      if (response.ok) {
        setState({ status: "done", result: response.result });
      } else {
        setState({ status: "error", message: response.error });
      }
    } catch {
      setState({ status: "error", message: "Diagnostic failed unexpectedly. Try again in a moment." });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-3 text-sm text-amber-100">
        <TriangleAlert className="size-4 shrink-0" aria-hidden />
        <span>
          Each run below costs up to the number of Alpha Vantage requests shown on its button, paced roughly 1.3s apart, out of the 25
          allowed today. This panel never runs on page load, navigation, or link prefetch - only these buttons make a request.
          Don&apos;t click repeatedly.
        </span>
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => run("ALL")}
          disabled={pending}
          data-testid="run-alpha-vantage-diagnostic-button"
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-sky-400/40 bg-sky-400/10 px-4 text-sm font-medium text-sky-100 transition hover:border-sky-300 hover:bg-sky-400/15 disabled:cursor-wait disabled:opacity-75"
        >
          <PlayCircle className={`size-4 ${state.status === "pending" && state.variant === "ALL" ? "motion-safe:animate-pulse" : ""}`} aria-hidden />
          {state.status === "pending" && state.variant === "ALL" ? "Calling Alpha Vantage…" : "Run Full Diagnostic (APLD, RIOT, CORZ - up to 3 calls)"}
        </button>

        <button
          type="button"
          onClick={() => run("REMAINING")}
          disabled={pending}
          data-testid="run-alpha-vantage-remaining-diagnostic-button"
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-emerald-400/40 bg-emerald-400/10 px-4 text-sm font-medium text-emerald-100 transition hover:border-emerald-300 hover:bg-emerald-400/15 disabled:cursor-wait disabled:opacity-75"
        >
          <PlayCircle className={`size-4 ${state.status === "pending" && state.variant === "REMAINING" ? "motion-safe:animate-pulse" : ""}`} aria-hidden />
          {state.status === "pending" && state.variant === "REMAINING" ? "Calling Alpha Vantage…" : "Verify remaining tickers (RIOT, CORZ - up to 2 calls)"}
        </button>
      </div>
      <p className="text-xs text-zinc-500">
        Use &quot;Verify remaining tickers&quot; if APLD already returned a real result in an earlier run - it never re-calls APLD.
      </p>

      {state.status === "error" ? (
        <div className="rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-100">{state.message}</div>
      ) : null}

      {state.status === "done" ? <DiagnosticOutcome result={state.result} /> : null}
    </div>
  );
}

function DiagnosticOutcome({ result }: { result: AlphaVantageDiagnosticResult }) {
  if (result.status === "UNAVAILABLE") {
    return (
      <Panel title="Diagnostic Unavailable">
        <div className="space-y-2 text-sm text-zinc-300">
          <p>{result.message}</p>
          <p className="text-xs text-zinc-500">Timestamp: {shortDateTime(result.timestamp)} - Tickers: {result.tickers.join(", ")}</p>
        </div>
      </Panel>
    );
  }

  if (result.status === "ERROR") {
    return (
      <Panel title="Diagnostic Error">
        <div className="space-y-2 text-sm text-zinc-300">
          <p>{result.message}</p>
          <p className="text-xs text-zinc-500">Timestamp: {shortDateTime(result.timestamp)} - Tickers: {result.tickers.join(", ")}</p>
        </div>
      </Panel>
    );
  }

  const report = result.report;
  const groups = [...new Set(report.rows.map((row) => row.group))];

  return (
    <>
      <Panel title="Run Summary">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Badge tone="info">Source: {report.source}</Badge>
            <Badge tone="info">function={report.endpointFunction}</Badge>
            <Badge tone="good">Read only</Badge>
            <Badge tone="neutral">Nothing saved</Badge>
            <Badge tone={report.callsConsumed >= report.maxCallsAllowed ? "neutral" : "warn"}>
              {report.callsConsumed} of {report.maxCallsAllowed} calls used this run
            </Badge>
          </div>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <SummaryDatum label="Timestamp" value={shortDateTime(report.timestamp)} />
            <SummaryDatum label="Tickers" value={report.tickers.join(", ")} />
            <SummaryDatum
              label="Remaining-calls signal in headers"
              value={
                report.rateLimitHeaderObserved
                  ? `Observed: ${report.rateLimitHeaderNames.join(", ")}`
                  : "Not observed - Alpha Vantage's free tier does not expose a remaining-calls header/field here. OSO must track its own daily counter."
              }
            />
          </dl>
          <div className="space-y-1">
            {report.results.map((outcome) => (
              <TickerOutcomeRow key={outcome.ticker} outcome={outcome} />
            ))}
          </div>
        </div>
      </Panel>

      <Panel title="Allowlisted Fields">
        <div className="overflow-x-auto">
          <table className="min-w-[900px] w-full border-separate border-spacing-0 text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-normal text-zinc-500">
                <th className="border-b border-zinc-800 px-3 py-2 font-medium">Field</th>
                {report.tickers.map((ticker) => (
                  <th key={ticker} className="border-b border-zinc-800 px-3 py-2 font-medium">
                    {ticker}
                  </th>
                ))}
                <th className="border-b border-zinc-800 px-3 py-2 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <FieldGroupRows key={group} group={group} rows={report.rows.filter((row) => row.group === group)} tickers={report.tickers} />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

function TickerOutcomeRow({ outcome }: { outcome: AlphaVantageTickerOutcome }) {
  const tone = outcome.outcome === "SUCCESS" ? "good" : outcome.outcome === "SKIPPED" ? "neutral" : outcome.outcome === "RATE_LIMITED" ? "warn" : "bad";
  const message = "message" in outcome ? outcome.message : "OK";
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/70 px-3 py-2 text-xs">
      <span className="font-medium text-zinc-200">{outcome.ticker}</span>
      <Badge tone={tone}>{outcome.outcome}</Badge>
      {outcome.outcome !== "SUCCESS" ? <span className="text-zinc-400">{message}</span> : null}
    </div>
  );
}

function FieldGroupRows({ group, rows, tickers }: { group: string; rows: { label: string; key: string; note?: string; values: Record<string, AlphaVantageFieldPresence> }[]; tickers: string[] }) {
  return (
    <>
      <tr>
        <td colSpan={tickers.length + 2} className="border-b border-zinc-800 bg-zinc-900/80 px-3 py-2 text-xs font-semibold uppercase tracking-normal text-sky-200">
          {group}
        </td>
      </tr>
      {rows.map((row) => (
        <tr key={row.key} className="align-top">
          <td className="border-b border-zinc-900 px-3 py-3">
            <div className="font-medium text-zinc-100">{row.label}</div>
            <div className="mt-1 font-mono text-xs text-zinc-500">{row.key}</div>
          </td>
          {tickers.map((ticker) => (
            <td key={ticker} className="border-b border-zinc-900 px-3 py-3">
              <PresenceValue value={row.values[ticker]} />
            </td>
          ))}
          <td className="border-b border-zinc-900 px-3 py-3 text-xs text-zinc-500">{row.note ?? "Allowlisted field only."}</td>
        </tr>
      ))}
    </>
  );
}

function SummaryDatum({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-normal text-zinc-500">{label}</dt>
      <dd className="mt-1 break-words font-medium text-zinc-100">{value}</dd>
    </div>
  );
}

function PresenceValue({ value }: { value: AlphaVantageFieldPresence }) {
  const stateClass =
    value.state === "PRESENT_VALUE"
      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
      : value.state === "PRESENT_NULL"
        ? "border-amber-400/30 bg-amber-400/10 text-amber-100"
        : value.state === "PRESENT_UNDISPLAYED"
          ? "border-zinc-700 bg-zinc-800 text-zinc-200"
          : value.state === "CALL_UNAVAILABLE"
            ? "border-red-400/20 bg-red-400/5 text-red-200"
            : "border-zinc-800 bg-zinc-950 text-zinc-500";
  const label =
    value.state === "PRESENT_VALUE"
      ? "PRESENT"
      : value.state === "PRESENT_NULL"
        ? "PRESENT NULL"
        : value.state === "PRESENT_UNDISPLAYED"
          ? "PRESENT HIDDEN"
          : value.state === "CALL_UNAVAILABLE"
            ? "CALL UNAVAILABLE"
            : "ABSENT";
  const displayValue = value.state === "PRESENT_VALUE" ? value.value : value.state === "PRESENT_NULL" ? value.raw : null;

  return (
    <div className={`inline-flex max-w-64 flex-col gap-1 rounded-md border px-2 py-1 ${stateClass}`}>
      <span className="text-[11px] font-semibold uppercase tracking-normal">{label}</span>
      {displayValue ? <span className="break-words text-xs">{displayValue}</span> : null}
    </div>
  );
}
