"use client";

import { Fragment, useMemo, useState } from "react";
import {
  ArrowDownUp,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ListFilter,
  Send,
  Star,
  Table2,
} from "lucide-react";
import { EmptyState, FieldLabel } from "@/components/ui";
import { RECOMMENDATION_REASON_TAGS } from "@/domain/social/recommendations";
import { formatCriterionValue, type ExclusionDiagnostic } from "@/domain/scanner/scanner";
import { money, percent, shortDate, toNumber } from "@/lib/format";
import { recommendStockAction } from "../actions";
import type { ScannerBuddy, ScannerViewResult } from "./page";

type SortKey =
  | "score"
  | "ticker"
  | "price"
  | "rsi"
  | "bbPercent"
  | "premium"
  | "ror"
  | "annualizedRor"
  | "dte"
  | "delta"
  | "optionVolume"
  | "openInterest"
  | "spreadPercent"
  | "earningsDistance";

type QuickKey = "all" | "pass" | "near" | "watchlist" | "strongest" | "premium" | "liquid" | "low-rsi" | "far-earnings";

type OptionalColumnKey = "delta" | "annualizedRor" | "spreadPercent" | "distanceOtm";

const sortOptions: { key: SortKey; label: string }[] = [
  { key: "score", label: "Score" },
  { key: "ticker", label: "Ticker" },
  { key: "price", label: "Price" },
  { key: "rsi", label: "RSI" },
  { key: "bbPercent", label: "BB %" },
  { key: "premium", label: "Premium" },
  { key: "ror", label: "ROR" },
  { key: "annualizedRor", label: "Annualized ROR" },
  { key: "dte", label: "DTE" },
  { key: "delta", label: "Delta" },
  { key: "optionVolume", label: "Option volume" },
  { key: "openInterest", label: "Open interest" },
  { key: "spreadPercent", label: "Spread" },
  { key: "earningsDistance", label: "Earnings distance" },
];

const oneClickFilters: { key: QuickKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pass", label: "Pass" },
  { key: "near", label: "Near" },
  { key: "watchlist", label: "Watchlist" },
];

const advancedFilters: { key: QuickKey; label: string }[] = [
  { key: "strongest", label: "Strongest" },
  { key: "premium", label: "Best premium" },
  { key: "liquid", label: "Most liquid" },
  { key: "low-rsi", label: "Lowest RSI" },
  { key: "far-earnings", label: "Far from earnings" },
];

const optionalColumns: { key: OptionalColumnKey; label: string }[] = [
  { key: "delta", label: "Delta" },
  { key: "annualizedRor", label: "Annualized ROR" },
  { key: "spreadPercent", label: "Spread" },
  { key: "distanceOtm", label: "Distance to strike" },
];

const BASE_COLUMN_COUNT = 11;

export function ScannerWorkspace({
  results,
  buddies,
  diagnostics,
  modeLabel,
}: {
  results: ScannerViewResult[];
  buddies: ScannerBuddy[];
  diagnostics: ExclusionDiagnostic;
  modeLabel: string;
}) {
  const [quick, setQuick] = useState<QuickKey>("all");
  const [sort, setSort] = useState<SortKey>("score");
  const [columns, setColumns] = useState<Record<OptionalColumnKey, boolean>>({
    delta: false,
    annualizedRor: false,
    spreadPercent: false,
    distanceOtm: false,
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const counts = useMemo(
    () => ({
      pass: results.filter((result) => result.summary.status === "PASS").length,
      near: results.filter((result) => result.nearMisses.length === 1).length,
      watchlist: results.filter((result) => result.inWatchlist).length,
    }),
    [results],
  );

  const visible = useMemo(() => sortResults(applyQuickFilter(results, quick), sort), [results, quick, sort]);
  const activeOptionalColumns = optionalColumns.filter((column) => columns[column.key]);
  const columnCount = BASE_COLUMN_COUNT + activeOptionalColumns.length;

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {oneClickFilters.map((filter) => (
          <button
            key={filter.key}
            type="button"
            onClick={() => setQuick(filter.key)}
            className={`inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition ${
              quick === filter.key
                ? "border-emerald-400/70 bg-emerald-400/15 text-emerald-100"
                : "border-zinc-800 bg-zinc-950 text-zinc-300 hover:border-zinc-600 hover:text-zinc-50"
            }`}
          >
            {filter.label}
            {filter.key !== "all" ? (
              <span className="text-[10px] text-zinc-500">
                {filter.key === "pass" ? counts.pass : filter.key === "near" ? counts.near : counts.watchlist}
              </span>
            ) : null}
          </button>
        ))}

        <details className="group relative">
          <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 text-xs font-medium text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-50">
            <ListFilter className="size-3.5" aria-hidden />
            Filters
            <ChevronDown className="size-3.5" aria-hidden />
          </summary>
          <div className="absolute left-0 top-full z-10 mt-1 w-48 space-y-1 rounded-md border border-zinc-800 bg-zinc-900 p-2 shadow-lg shadow-black/30">
            {advancedFilters.map((filter) => (
              <button
                key={filter.key}
                type="button"
                onClick={() => setQuick(filter.key)}
                className={`flex min-h-8 w-full items-center rounded px-2 text-left text-xs transition ${
                  quick === filter.key ? "bg-emerald-400/15 text-emerald-100" : "text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </details>

        <label className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 text-xs font-medium text-zinc-300">
          <ArrowDownUp className="size-3.5" aria-hidden />
          Sort
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as SortKey)}
            aria-label="Sort candidates by"
            className="min-h-6 rounded border-none bg-transparent text-xs font-medium text-zinc-100 outline-none"
          >
            {sortOptions.map((option) => (
              <option key={option.key} value={option.key} className="bg-zinc-900 text-zinc-100">
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <details className="group relative">
          <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 text-xs font-medium text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-50">
            <Table2 className="size-3.5" aria-hidden />
            Columns
            <ChevronDown className="size-3.5" aria-hidden />
          </summary>
          <div className="absolute left-0 top-full z-10 mt-1 w-48 space-y-1 rounded-md border border-zinc-800 bg-zinc-900 p-2 shadow-lg shadow-black/30">
            {optionalColumns.map((column) => (
              <label key={column.key} className="flex min-h-8 items-center gap-2 rounded px-2 text-xs text-zinc-300 hover:bg-zinc-800">
                <input
                  type="checkbox"
                  checked={columns[column.key]}
                  onChange={(event) => setColumns((prev) => ({ ...prev, [column.key]: event.target.checked }))}
                  className="size-3.5 accent-emerald-400"
                />
                {column.label}
              </label>
            ))}
          </div>
        </details>

        <details className="ml-auto">
          <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 text-xs font-medium text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-200">
            <CircleHelp className="size-3.5" aria-hidden />
            Why {modeLabel} {results.length}?
          </summary>
          <div className="mt-2 grid gap-4 rounded-md border border-zinc-800 bg-zinc-950 p-4 lg:grid-cols-[0.65fr_1.35fr]">
            <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3">
              <div className="text-xs text-zinc-500">Starting universe</div>
              <div className="mt-1 text-2xl font-semibold text-zinc-50">{diagnostics.startingUniverse}</div>
              <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <div className="text-zinc-500">Final passes</div>
                  <div className="font-semibold text-emerald-200">{diagnostics.finalMatches}</div>
                </div>
                <div>
                  <div className="text-zinc-500">Unknown-only</div>
                  <div className="font-semibold text-zinc-200">{diagnostics.unknownOnly}</div>
                </div>
              </div>
            </div>
            <div className="space-y-3">
              {diagnostics.removals.map((removal) => (
                <div key={removal.criterionName}>
                  <div className="mb-1 flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium text-zinc-200">{removal.criterionName}</span>
                    <span className="text-zinc-400">-{removal.count}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className="h-full rounded-full bg-red-400"
                      style={{ width: `${diagnostics.startingUniverse ? (removal.count / diagnostics.startingUniverse) * 100 : 0}%` }}
                    />
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">{removal.tickers.slice(0, 5).join(", ")}</div>
                </div>
              ))}
              {diagnostics.removals.length === 0 ? <EmptyState>No rule has removed a candidate in this run.</EmptyState> : null}
            </div>
          </div>
        </details>
      </div>

      <div data-testid="scanner-desktop-table" className="hidden overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950/60 lg:block">
        <table className="w-full min-w-[960px] border-separate border-spacing-0 text-left text-xs">
          <thead>
            <tr className="text-[11px] uppercase tracking-normal text-zinc-500">
              <th className="border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">Ticker</th>
              <th className="border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">Score</th>
              <th className="border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">Status</th>
              <th className="border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">Price</th>
              <th className="border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">RSI / BB</th>
              <th className="border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">Strike</th>
              <th className="border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">Premium</th>
              <th className="border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">ROR</th>
              <th className="border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">DTE</th>
              <th className="border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">OI / Vol</th>
              <th className="border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">Earnings</th>
              {activeOptionalColumns.map((column) => (
                <th key={column.key} className="border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((result) => {
              const isOpen = expanded.has(result.record.id);
              const status = statusInfo(result);
              return (
                <Fragment key={result.record.id}>
                  <tr onClick={() => toggleExpanded(result.record.id)} className="cursor-pointer transition hover:bg-zinc-900/55">
                    <td className="border-b border-zinc-900 px-3 py-2">
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        aria-label={`${isOpen ? "Collapse" : "Expand"} ${result.record.ticker} details`}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleExpanded(result.record.id);
                        }}
                        className="flex w-full items-center gap-1.5 rounded text-left"
                      >
                        {isOpen ? (
                          <ChevronDown className="size-3.5 shrink-0 text-zinc-500" aria-hidden />
                        ) : (
                          <ChevronRight className="size-3.5 shrink-0 text-zinc-500" aria-hidden />
                        )}
                        <span className="text-sm font-semibold text-zinc-50">{result.record.ticker}</span>
                        {result.inWatchlist ? <Star className="size-3.5 shrink-0 fill-emerald-300 text-emerald-300" aria-hidden /> : null}
                      </button>
                    </td>
                    <td className="border-b border-zinc-900 px-3 py-2">
                      <span className={`inline-flex min-w-9 justify-center rounded-md border px-1.5 py-0.5 text-xs font-semibold ${scoreChipClass(result.score, result.scoreLabel)}`}>
                        {result.score}
                      </span>
                    </td>
                    <td className="border-b border-zinc-900 px-3 py-2">
                      <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${status.tone}`}>
                        {status.word}
                      </span>
                    </td>
                    <td className="border-b border-zinc-900 px-3 py-2">{cell(result.values.price, money)}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">
                      {cell(result.values.rsi, (value) => toNumber(value).toFixed(1))} / {cell(result.values.bbPercent, percent)}
                    </td>
                    <td className="border-b border-zinc-900 px-3 py-2">{cell(result.values.strike, money)}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">{cell(result.values.premium, money)}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">{cell(result.values.ror, percent)}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">{cell(result.values.dte, (value) => `${value}d`)}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">
                      {cell(result.values.openInterest, formatCount)} / {cell(result.values.optionVolume, formatCount)}
                    </td>
                    <td className="border-b border-zinc-900 px-3 py-2">{cell(result.values.earningsDistance, (value) => `${value}d`)}</td>
                    {activeOptionalColumns.map((column) => (
                      <td key={column.key} className="border-b border-zinc-900 px-3 py-2">
                        {column.key === "delta" ? cell(result.values.delta, (value) => toNumber(value).toFixed(2)) : null}
                        {column.key === "annualizedRor" ? cell(result.values.annualizedRor, percent) : null}
                        {column.key === "spreadPercent" ? cell(result.values.spreadPercent, percent) : null}
                        {column.key === "distanceOtm" ? cell(result.values.distanceOtmPercent, percent) : null}
                      </td>
                    ))}
                  </tr>
                  {isOpen ? (
                    <tr>
                      <td colSpan={columnCount} className="border-b border-zinc-900 bg-zinc-950/60 px-3 py-3">
                        <CandidateInspector result={result} buddies={buddies} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {!visible.length ? (
          <div className="p-4">
            <EmptyState>No scanner candidates match this view.</EmptyState>
          </div>
        ) : null}
      </div>

      <div data-testid="scanner-mobile-cards" className="grid gap-3 lg:hidden">
        {visible.map((result) => (
          <CandidateCard key={result.record.id} result={result} buddies={buddies} />
        ))}
        {!visible.length ? <EmptyState>No scanner candidates match this view.</EmptyState> : null}
      </div>
    </div>
  );
}

function CandidateCard({ result, buddies }: { result: ScannerViewResult; buddies: ScannerBuddy[] }) {
  const status = statusInfo(result);

  return (
    <details className={`rounded-lg border bg-zinc-900 ${resultBorder(result)}`}>
      <summary className="flex cursor-pointer list-none flex-col gap-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold text-zinc-50">{result.record.ticker}</span>
            {result.inWatchlist ? <Star className="size-4 fill-emerald-300 text-emerald-300" aria-hidden /> : null}
          </div>
          <div className="flex items-center gap-2">
            <span className={`inline-flex min-w-9 justify-center rounded-md border px-1.5 py-0.5 text-xs font-semibold ${scoreChipClass(result.score, result.scoreLabel)}`}>
              {result.score}
            </span>
            <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${status.tone}`}>
              {status.word}
            </span>
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-x-2 gap-y-1 text-xs">
          <MobileDatum label="Price" value={cell(result.values.price, money)} />
          <MobileDatum label="RSI / BB" value={<>{cell(result.values.rsi, (v) => toNumber(v).toFixed(1))} / {cell(result.values.bbPercent, percent)}</>} />
          <MobileDatum label="Strike" value={cell(result.values.strike, money)} />
          <MobileDatum label="Premium" value={cell(result.values.premium, money)} />
          <MobileDatum label="ROR" value={cell(result.values.ror, percent)} />
          <MobileDatum label="DTE" value={cell(result.values.dte, (v) => `${v}d`)} />
        </dl>
      </summary>
      <div className="border-t border-zinc-800 p-3">
        <CandidateInspector result={result} buddies={buddies} />
      </div>
    </details>
  );
}

function MobileDatum({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-normal text-zinc-500">{label}</dt>
      <dd className="font-medium text-zinc-100">{value}</dd>
    </div>
  );
}

function CandidateInspector({ result, buddies }: { result: ScannerViewResult; buddies: ScannerBuddy[] }) {
  return (
    <div className="grid gap-5 rounded-md border border-zinc-800 bg-zinc-950 p-4 xl:grid-cols-[1fr_1fr_0.8fr]">
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-normal text-zinc-400">Stock</h3>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <Datum label="Ticker" value={result.record.ticker} />
          <Datum label="Current price" value={cell(result.values.price, money)} />
          <Datum label="Change" value={signedPercent(result.values.priceChangePercent)} />
          <Datum label="RSI" value={cell(result.values.rsi, (v) => toNumber(v).toFixed(1))} />
          <Datum label="BB position" value={cell(result.values.bbPercent, percent)} />
          <Datum label="Volume" value={cell(result.values.stockVolume, formatCount)} />
          <Datum label="Earnings" value={result.values.earningsDate ? shortDate(result.values.earningsDate) : dash()} />
          <Datum label="Days to earnings" value={cell(result.values.earningsDistance, formatCount)} />
        </dl>
      </section>
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-normal text-zinc-400">Option</h3>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <Datum label="Expiration" value={result.values.expiration ? shortDate(result.values.expiration) : dash()} />
          <Datum label="DTE" value={cell(result.values.dte, formatCount)} />
          <Datum label="Strike" value={cell(result.values.strike, money)} />
          <Datum label="Distance OTM" value={cell(result.values.distanceOtmPercent, percent)} />
          <Datum label="Bid" value={cell(result.values.optionBid, money)} />
          <Datum label="Ask" value={cell(result.values.optionAsk, money)} />
          <Datum label="Midpoint" value={cell(result.values.midpoint, money)} />
          <Datum label="Delta" value={cell(result.values.delta, (v) => toNumber(v).toFixed(2))} />
          <Datum label="Open interest" value={cell(result.values.openInterest, formatCount)} />
          <Datum label="Option volume" value={cell(result.values.optionVolume, formatCount)} />
          <Datum label="Spread" value={cell(result.values.spreadPercent, percent)} />
          <Datum label="ROR" value={cell(result.values.ror, percent)} />
          <Datum label="Annualized ROR" value={cell(result.values.annualizedRor, percent)} />
        </dl>
      </section>
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-normal text-zinc-400">Criteria</h3>
        <div className="mt-3 space-y-2">
          {result.summary.results.map((criterion) => (
            <details key={criterion.name} className="rounded-md border border-zinc-800 bg-zinc-900/70 p-3 text-sm">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                <span className="font-medium text-zinc-100">{criterion.name}</span>
                <span
                  className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${
                    criterion.status === "PASS"
                      ? "border-emerald-400/40 bg-emerald-400/15 text-emerald-100"
                      : criterion.status === "FAIL"
                        ? "border-red-400/40 bg-red-400/15 text-red-100"
                        : "border-zinc-600 bg-zinc-800 text-zinc-300"
                  }`}
                >
                  {criterion.status}
                </span>
              </summary>
              <dl className="mt-3 grid gap-2 text-sm">
                <Datum label="Actual" value={formatCriterionValue(criterion.actualValue)} />
                <Datum label="Rule" value={criterion.explanation} />
              </dl>
            </details>
          ))}
        </div>
        <div className="mt-4">
          <RecommendMiniForm ticker={result.record.ticker} buddies={buddies} returnTo="/scanner" />
        </div>
      </section>
    </div>
  );
}

function RecommendMiniForm({ ticker, buddies, returnTo }: { ticker: string; buddies: ScannerBuddy[]; returnTo: string }) {
  return (
    <form action={recommendStockAction} className="space-y-2">
      <input type="hidden" name="ticker" value={ticker} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <FieldLabel>Send to buddy</FieldLabel>
      <select
        name="recipientId"
        className="min-h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100"
        required
        aria-label={`Recommend ${ticker} to buddy`}
      >
        {buddies.map((buddy) => (
          <option key={buddy.id} value={buddy.id}>
            {buddy.name}
          </option>
        ))}
      </select>
      <input
        name="message"
        className="min-h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100"
        defaultValue={`Take a look at ${ticker}.`}
        aria-label={`Recommendation message for ${ticker}`}
      />
      <div className="grid grid-cols-2 gap-2">
        {RECOMMENDATION_REASON_TAGS.slice(0, 4).map((tag) => (
          <label key={tag} className="flex min-h-9 items-center gap-2 rounded-md border border-zinc-800 px-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              name="reasonTags"
              value={tag}
              defaultChecked={tag === "Scanner looks good" || tag === "Worth researching"}
              className="size-3.5 accent-emerald-400"
            />
            <span>{tag}</span>
          </label>
        ))}
      </div>
      <button
        type="submit"
        className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-md bg-emerald-400 px-3 text-sm font-semibold text-black hover:bg-emerald-300"
      >
        <Send className="size-4" aria-hidden />
        Recommend
      </button>
    </form>
  );
}

function Datum({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-normal text-zinc-500">{label}</dt>
      <dd className="mt-1 break-words font-medium text-zinc-100">{value}</dd>
    </div>
  );
}

function dash() {
  return (
    <span title="Data unavailable" className="text-zinc-600">
      —
    </span>
  );
}

function cell(value: number | null, format: (value: number) => string) {
  return value === null ? dash() : format(value);
}

function formatCount(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function signedPercent(value: number | null) {
  if (value === null) {
    return dash();
  }
  return `${value > 0 ? "+" : ""}${percent(value)}`;
}

function statusInfo(result: ScannerViewResult): { word: string; tone: string } {
  if (result.summary.status === "PASS") {
    return { word: "PASS", tone: "border-emerald-400/40 bg-emerald-400/15 text-emerald-100" };
  }
  if (result.nearMisses.length === 1) {
    return { word: "NEAR", tone: "border-amber-400/40 bg-amber-400/15 text-amber-100" };
  }
  if (result.scoreLabel === "Verify") {
    return { word: "VERIFY", tone: "border-zinc-600 bg-zinc-800 text-zinc-300" };
  }
  if (result.scoreLabel === "Fails" || result.score < 45) {
    return { word: "FAIL", tone: "border-red-400/40 bg-red-400/15 text-red-100" };
  }
  if (result.score >= 78) {
    return { word: result.scoreLabel.toUpperCase(), tone: "border-sky-400/40 bg-sky-400/15 text-sky-100" };
  }
  return { word: result.scoreLabel.toUpperCase(), tone: "border-amber-400/40 bg-amber-400/15 text-amber-100" };
}

function scoreChipClass(score: number, label?: string) {
  if (label === "Verify") {
    return "border-zinc-600 bg-zinc-800 text-zinc-300";
  }
  if (label === "Fails" || score < 45) {
    return "border-red-400/40 bg-red-400/15 text-red-100";
  }
  if (score >= 90) {
    return "border-emerald-400/40 bg-emerald-400/15 text-emerald-100";
  }
  if (score >= 78) {
    return "border-sky-400/40 bg-sky-400/15 text-sky-100";
  }
  return "border-amber-400/40 bg-amber-400/15 text-amber-100";
}

function resultBorder(result: ScannerViewResult) {
  if (result.summary.status === "PASS") {
    return "border-emerald-400/35";
  }
  if (result.nearMisses.length === 1) {
    return "border-amber-400/35";
  }
  if (result.summary.status === "FAIL") {
    return "border-red-400/25";
  }
  return "border-zinc-800";
}

function applyQuickFilter(results: ScannerViewResult[], quick: QuickKey) {
  switch (quick) {
    case "pass":
      return results.filter((result) => result.summary.status === "PASS");
    case "near":
      return results.filter((result) => result.nearMisses.length === 1);
    case "watchlist":
      return results.filter((result) => result.inWatchlist);
    case "strongest":
      return results.filter((result) => result.score >= 90);
    case "premium":
      return results.filter((result) => result.values.premium !== null);
    case "liquid":
      return results.filter((result) => (result.values.openInterest ?? 0) >= 500 && (result.values.optionVolume ?? 0) >= 100);
    case "low-rsi":
      return results.filter((result) => result.values.rsi !== null && result.values.rsi <= 50);
    case "far-earnings":
      return results.filter((result) => (result.values.earningsDistance ?? 0) >= 30);
    default:
      return results;
  }
}

function sortResults(results: ScannerViewResult[], sort: SortKey) {
  return [...results].sort((left, right) => {
    if (sort === "ticker") {
      return left.record.ticker.localeCompare(right.record.ticker);
    }
    if (sort === "rsi" || sort === "spreadPercent" || sort === "dte" || sort === "price") {
      return compareAsc(left, right, sort);
    }
    return compareDesc(left, right, sort);
  });
}

function compareAsc(left: ScannerViewResult, right: ScannerViewResult, key: SortKey) {
  return valueForSort(left, key) - valueForSort(right, key) || left.record.ticker.localeCompare(right.record.ticker);
}

function compareDesc(left: ScannerViewResult, right: ScannerViewResult, key: SortKey) {
  return valueForSort(right, key) - valueForSort(left, key) || left.record.ticker.localeCompare(right.record.ticker);
}

function valueForSort(result: ScannerViewResult, key: SortKey) {
  if (key === "score") {
    return result.score;
  }
  if (key === "ticker") {
    return 0;
  }
  return result.values[key] ?? Number.NEGATIVE_INFINITY;
}
