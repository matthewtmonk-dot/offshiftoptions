import Link from "next/link";
import { ArrowLeft, SearchCheck, ShieldCheck, TriangleAlert } from "lucide-react";
import { Badge, Panel } from "@/components/ui";
import { requireCurrentUser } from "@/lib/auth";
import { shortDateTime } from "@/lib/format";
import {
  runSchwabFundamentalsDiagnosticForUser,
  type SchwabFundamentalsDiagnosticResult,
} from "@/lib/schwab-fundamentals-diagnostic";
import type { FieldPresence, SchwabDiagnosticRow } from "@/providers/schwab/fundamentals-diagnostic";

export const dynamic = "force-dynamic";

export default async function SchwabFundamentalsDiagnosticPage() {
  const user = await requireCurrentUser();
  const result = await runSchwabFundamentalsDiagnosticForUser(user.id);

  return (
    <div className="space-y-6" data-testid="schwab-fundamentals-diagnostic">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-medium text-sky-300">Temporary engineering diagnostic</p>
          <h1 className="text-3xl font-semibold text-zinc-50">Schwab Fundamental Fields</h1>
          <p className="mt-2 max-w-3xl text-sm text-zinc-400">
            Checks APLD, RIOT, and CORZ through your own Schwab market-data authorization. The table is a strict
            allowlist and does not save anything to Research, Scanner, Tracker, or accounts.
          </p>
        </div>
        <Link
          href="/account"
          prefetch={false}
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Account
        </Link>
      </div>

      {result.status === "OK" ? <DiagnosticReport result={result} /> : <UnavailableState result={result} />}
    </div>
  );
}

function DiagnosticReport({ result }: { result: Extract<SchwabFundamentalsDiagnosticResult, { status: "OK" }> }) {
  const report = result.report;
  const groups = [...new Set(report.rows.map((row) => row.group))];

  return (
    <>
      <Panel title="Run Summary">
        <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Badge tone="info">Source: {report.source}</Badge>
              <Badge tone="good">Read only</Badge>
              <Badge tone="neutral">Nothing saved</Badge>
              <Badge tone={result.usesUserDeveloperApp ? "info" : "neutral"}>{result.label}</Badge>
            </div>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <SummaryDatum label="Timestamp" value={shortDateTime(report.timestamp)} />
              <SummaryDatum label="Schwab call" value={`${report.quoteRequest.path} · fields=${report.quoteRequest.fields}`} />
              <SummaryDatum label="Tickers" value={report.quoteRequest.symbols.join(", ")} />
              <SummaryDatum label="getInstrument()" value={report.instrumentUse.note} />
            </dl>
          </div>
          <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
              <ShieldCheck className="size-4 text-emerald-300" aria-hidden />
              Market and price fallback
            </div>
            <div className="mt-3 space-y-3 text-sm text-zinc-400">
              <p>{marketHoursText(report.marketHours)}</p>
              <div className="grid gap-2">
                {report.priceSources.map((source) => (
                  <div key={source.symbol} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-950/70 px-3 py-2">
                    <span className="font-medium text-zinc-200">{source.symbol}</span>
                    <span className="text-xs text-zinc-400">
                      {source.status === "AVAILABLE" ? `${source.path} -> ${source.value}` : "No usable fallback price"}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-zinc-500">Fallback order: {report.priceFallbackOrder.join(" -> ")}</p>
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="Allowlisted Fields">
        <div className="overflow-x-auto">
          <table className="min-w-[900px] w-full border-separate border-spacing-0 text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-normal text-zinc-500">
                <th className="border-b border-zinc-800 px-3 py-2 font-medium">Field</th>
                {report.quoteRequest.symbols.map((symbol) => (
                  <th key={symbol} className="border-b border-zinc-800 px-3 py-2 font-medium">
                    {symbol}
                  </th>
                ))}
                <th className="border-b border-zinc-800 px-3 py-2 font-medium">Status / Notes</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <FieldGroupRows
                  key={group}
                  group={group}
                  rows={report.rows.filter((row) => row.group === group)}
                  symbols={report.quoteRequest.symbols}
                />
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

function FieldGroupRows({ group, rows, symbols }: { group: string; rows: SchwabDiagnosticRow[]; symbols: string[] }) {
  return (
    <>
      <tr>
        <td colSpan={symbols.length + 2} className="border-b border-zinc-800 bg-zinc-900/80 px-3 py-2 text-xs font-semibold uppercase tracking-normal text-sky-200">
          {group}
        </td>
      </tr>
      {rows.map((row) => (
        <tr key={row.schwabPath} className="align-top">
          <td className="border-b border-zinc-900 px-3 py-3">
            <div className="font-medium text-zinc-100">{row.label}</div>
            <div className="mt-1 font-mono text-xs text-zinc-500">Schwab path: {row.schwabPath}</div>
          </td>
          {symbols.map((symbol) => (
            <td key={symbol} className="border-b border-zinc-900 px-3 py-3">
              <PresenceValue value={row.values[symbol]} />
            </td>
          ))}
          <td className="border-b border-zinc-900 px-3 py-3 text-xs text-zinc-500">{row.note ?? "Allowlisted field only."}</td>
        </tr>
      ))}
    </>
  );
}

function PresenceValue({ value }: { value: FieldPresence }) {
  const stateClass =
    value.state === "PRESENT_VALUE"
      ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
      : value.state === "PRESENT_NULL"
        ? "border-amber-400/30 bg-amber-400/10 text-amber-100"
        : value.state === "PRESENT_UNDISPLAYED"
          ? "border-zinc-700 bg-zinc-800 text-zinc-200"
          : "border-zinc-800 bg-zinc-950 text-zinc-500";
  const label =
    value.state === "PRESENT_VALUE"
      ? "PRESENT"
      : value.state === "PRESENT_NULL"
        ? "PRESENT NULL"
        : value.state === "PRESENT_UNDISPLAYED"
          ? "PRESENT HIDDEN"
          : "ABSENT";

  return (
    <div className={`inline-flex max-w-64 flex-col gap-1 rounded-md border px-2 py-1 ${stateClass}`}>
      <span className="text-[11px] font-semibold uppercase tracking-normal">{label}</span>
      {value.value ? <span className="break-words text-xs">{value.value}</span> : null}
    </div>
  );
}

function UnavailableState({
  result,
}: {
  result: Exclude<SchwabFundamentalsDiagnosticResult, { status: "OK" }>;
}) {
  return (
    <Panel title={result.status === "ERROR" ? "Diagnostic Error" : "Diagnostic Unavailable"}>
      <div className="flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-md border border-amber-400/30 bg-amber-400/10">
          <TriangleAlert className="size-5 text-amber-200" aria-hidden />
        </div>
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap gap-2">
            <Badge tone="info">Source: {result.source}</Badge>
            <Badge tone="good">Read only</Badge>
            <Badge tone="neutral">Nothing saved</Badge>
          </div>
          <p className="text-sm text-zinc-300">{result.message}</p>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <SummaryDatum label="Timestamp" value={shortDateTime(result.timestamp)} />
            <SummaryDatum label="Tickers" value={result.tickers.join(", ")} />
            <SummaryDatum label="Status" value={result.status} />
            {"statusCode" in result && result.statusCode ? (
              <SummaryDatum
                label="Provider status"
                value={result.retryAfter ? `${result.statusCode} · retry after ${result.retryAfter}` : String(result.statusCode)}
              />
            ) : null}
          </dl>
          <Link
            href="/account"
            prefetch={false}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
          >
            <SearchCheck className="size-4" aria-hidden />
            Back to Schwab settings
          </Link>
        </div>
      </div>
    </Panel>
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

function marketHoursText(hours: { available: boolean; isOpen?: boolean; opensAt?: string | null; closesAt?: string | null; note?: string }) {
  if (!hours.available) {
    return hours.note ?? "Market-hours check unavailable.";
  }

  const state = hours.isOpen ? "open" : "closed";
  const windowText =
    hours.opensAt && hours.closesAt ? ` Regular session: ${shortDateTime(hours.opensAt)} to ${shortDateTime(hours.closesAt)}.` : "";
  return `Market currently reports ${state}.${windowText}`;
}
