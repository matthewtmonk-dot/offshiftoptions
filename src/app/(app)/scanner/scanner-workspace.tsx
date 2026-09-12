"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { InfoTip } from "@/components/info-tip";
import {
  ArrowDownUp,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  EyeOff,
  ListFilter,
  Search,
  Send,
  Star,
  Table2,
} from "lucide-react";
import { EmptyState, FieldLabel } from "@/components/ui";
import { RECOMMENDATION_REASON_TAGS } from "@/domain/social/recommendations";
import { formatCriterionValue, type CriterionResult, type ExclusionDiagnostic } from "@/domain/scanner/scanner";
import { ruleSeverityTone, type SeverityTone } from "@/domain/scanner/severity";
import { money, percent, shortDate, toNumber } from "@/lib/format";
import { recommendStockAction, setResearchStatusAction } from "../actions";
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
type QuickResearchStatus = "LIKE" | "WATCH" | "NEUTRAL" | "AVOID" | "NEVER_TRADE";
type ScannerStatusOverride = {
  baseResult: ScannerViewResult;
  baseStatus: QuickResearchStatus | null;
  nextStatus: QuickResearchStatus;
};
type ScannerResearchStatusChange = (result: ScannerViewResult, status: QuickResearchStatus) => void;

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
  const [optimisticStatuses, setOptimisticStatuses] = useState<Record<string, ScannerStatusOverride | undefined>>({});
  const [pendingStatuses, setPendingStatuses] = useState<Record<string, QuickResearchStatus | undefined>>({});
  const [statusError, setStatusError] = useState<string | null>(null);
  const [quick, setQuick] = useState<QuickKey>("all");
  const [sort, setSort] = useState<SortKey>("score");
  const [showExcluded, setShowExcluded] = useState(false);
  const [columns, setColumns] = useState<Record<OptionalColumnKey, boolean>>({
    delta: false,
    annualizedRor: false,
    spreadPercent: false,
    distanceOtm: false,
  });
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const columnsMenuRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Same outside-click/Escape shell as Research's ColumnsMenu (research-workspace.tsx) - a
  // click on a checkbox inside the menu stays open (it's inside columnsMenuRef), an outside
  // click or Escape closes it, and repeated open/close cycles stay stable since the listeners
  // are only registered while open.
  useEffect(() => {
    if (!columnsMenuOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (columnsMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      setColumnsMenuOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setColumnsMenuOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [columnsMenuOpen]);

  const optimisticResults = useMemo(
    () =>
      results.map((result) => {
        const optimisticStatus = optimisticStatuses[result.record.id];
        return optimisticStatus && optimisticStatus.baseResult === result && optimisticStatus.baseStatus === result.researchStatus
          ? { ...result, researchStatus: optimisticStatus.nextStatus }
          : result;
      }),
    [results, optimisticStatuses],
  );

  const excludedCount = useMemo(() => optimisticResults.filter((result) => result.researchStatus === "NEVER_TRADE").length, [optimisticResults]);
  const actionable = useMemo(
    () => (showExcluded ? optimisticResults : optimisticResults.filter((result) => result.researchStatus !== "NEVER_TRADE")),
    [optimisticResults, showExcluded],
  );
  const counts = useMemo(
    () => ({
      pass: actionable.filter((result) => result.summary.status === "PASS").length,
      near: actionable.filter(isNearMatch).length,
      watchlist: actionable.filter((result) => result.researchStatus !== null).length,
    }),
    [actionable],
  );

  const visible = useMemo(() => sortResults(applyQuickFilter(actionable, quick), sort), [actionable, quick, sort]);
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

  async function changeResearchStatus(result: ScannerViewResult, nextStatus: QuickResearchStatus) {
    if (result.researchStatus === nextStatus) {
      return;
    }

    const serverResult = results.find((candidate) => candidate.record.id === result.record.id) ?? result;
    const existingOverride = optimisticStatuses[result.record.id];
    const activeOverride =
      existingOverride?.baseResult === serverResult && existingOverride.baseStatus === serverResult.researchStatus
        ? existingOverride
        : undefined;
    const baseResult = activeOverride?.baseResult ?? serverResult;
    const baseStatus = activeOverride?.baseStatus ?? serverResult.researchStatus;
    const previousStatus = result.researchStatus;
    setStatusError(null);
    setPendingStatuses((prev) => ({ ...prev, [result.record.ticker]: nextStatus }));
    setOptimisticStatuses((prev) => ({
      ...prev,
      [result.record.id]: { baseResult, baseStatus, nextStatus },
    }));

    const formData = new FormData();
    formData.set("ticker", result.record.ticker);
    formData.set("status", nextStatus);
    formData.set("returnTo", "/scanner");

    try {
      const actionResult = await setResearchStatusAction(formData);
      if (!actionResult.ok) {
        rollBackScannerStatus(result.record.id, baseResult, baseStatus, previousStatus);
        setStatusError(actionResult.error);
      }
    } catch {
      rollBackScannerStatus(result.record.id, baseResult, baseStatus, previousStatus);
      setStatusError("Research status could not be saved. Try again in a moment.");
    } finally {
      setPendingStatuses((prev) => {
        const next = { ...prev };
        delete next[result.record.ticker];
        return next;
      });
    }
  }

  function rollBackScannerStatus(
    resultId: string,
    baseResult: ScannerViewResult,
    baseStatus: QuickResearchStatus | null,
    previousStatus: QuickResearchStatus | null,
  ) {
    setOptimisticStatuses((prev) => {
      const next = { ...prev };
      if (previousStatus === baseStatus) {
        delete next[resultId];
      } else if (previousStatus) {
        next[resultId] = { baseResult, baseStatus, nextStatus: previousStatus };
      } else {
        delete next[resultId];
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

        <div ref={columnsMenuRef} className="relative">
          <button
            type="button"
            aria-haspopup="true"
            aria-expanded={columnsMenuOpen}
            onClick={() => setColumnsMenuOpen((value) => !value)}
            className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 text-xs font-medium text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-50"
          >
            <Table2 className="size-3.5" aria-hidden />
            Columns
            <ChevronDown className="size-3.5" aria-hidden />
          </button>
          {columnsMenuOpen ? (
            <div
              data-testid="scanner-columns-menu"
              className="absolute left-0 top-full z-10 mt-1 w-48 space-y-1 rounded-md border border-zinc-800 bg-zinc-900 p-2 shadow-lg shadow-black/30"
            >
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
          ) : null}
        </div>

        {excludedCount > 0 ? (
          <button
            type="button"
            onClick={() => setShowExcluded((prev) => !prev)}
            className={`inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition ${
              showExcluded
                ? "border-zinc-500 bg-zinc-800 text-zinc-100"
                : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
            }`}
          >
            <EyeOff className="size-3.5" aria-hidden />
            {showExcluded ? "Hide" : "Show"} Excluded
            <span className="text-[10px] text-zinc-500">{excludedCount}</span>
          </button>
        ) : null}

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

      {statusError ? (
        <div className="rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-100">{statusError}</div>
      ) : null}

      <div className="flex items-center gap-1.5 text-xs text-zinc-500">
        <span>Cell colors compare each metric with your active Scanner Rules.</span>
        <InfoTip label="Cell colors" testId="help-scanner-cell-colors">
          Green meets the rule, amber is near the threshold, red misses it, and gray/neutral means unavailable or
          informational (the rule is disabled, or OSO doesn&apos;t have this value yet).
        </InfoTip>
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
                        <ResearchBadge status={result.researchStatus} />
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
                      {result.researchStatus === "NEVER_TRADE" ? (
                        <span className="ml-1.5 inline-flex items-center text-[10px] font-semibold text-red-300/70">EXCLUDED BY YOU</span>
                      ) : null}
                      {isTechnicallyIncomplete(result) ? (
                        <span
                          data-testid="technical-data-pending-label"
                          className="ml-1.5 inline-flex items-center text-[10px] font-semibold text-zinc-500"
                        >
                          Technical data pending
                        </span>
                      ) : null}
                      {status.word === "VERIFY" ? <VerifyReasons result={result} /> : null}
                    </td>
                    <td className="border-b border-zinc-900 px-3 py-2">
                      {coloredCell(result.values.price, money, ruleSeverityTone(criterionFor(result, "price")))}
                    </td>
                    <td className="border-b border-zinc-900 px-3 py-2">
                      {coloredCell(result.values.rsi, (value) => toNumber(value).toFixed(1), ruleSeverityTone(criterionFor(result, "rsi")))} /{" "}
                      {coloredCell(result.values.bbPercent, percent, ruleSeverityTone(criterionFor(result, "bbPercent")))}
                    </td>
                    <td className="border-b border-zinc-900 px-3 py-2">{cell(result.values.strike, money)}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">
                      {coloredCell(result.values.premium, money, ruleSeverityTone(criterionFor(result, "optionBid")))}
                    </td>
                    <td className="border-b border-zinc-900 px-3 py-2">
                      {coloredCell(result.values.ror, percent, ruleSeverityTone(criterionFor(result, "ror")))}
                    </td>
                    <td className="border-b border-zinc-900 px-3 py-2">
                      {coloredCell(result.values.dte, (value) => `${value}d`, ruleSeverityTone(criterionFor(result, "dte")))}
                    </td>
                    <td className="border-b border-zinc-900 px-3 py-2">
                      {coloredCell(result.values.openInterest, formatCount, ruleSeverityTone(criterionFor(result, "openInterest")))} /{" "}
                      {coloredCell(result.values.optionVolume, formatCount, ruleSeverityTone(criterionFor(result, "optionVolume")))}
                    </td>
                    <td className="border-b border-zinc-900 px-3 py-2">
                      {coloredCell(result.values.earningsDistance, (value) => `${value}d`, ruleSeverityTone(criterionFor(result, "earningsDistance")))}
                    </td>
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
                        <CandidateInspector
                          result={result}
                          buddies={buddies}
                          pendingStatus={pendingStatuses[result.record.ticker]}
                          onResearchStatusChange={changeResearchStatus}
                        />
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
          <CandidateCard
            key={result.record.id}
            result={result}
            buddies={buddies}
            pendingStatus={pendingStatuses[result.record.ticker]}
            onResearchStatusChange={changeResearchStatus}
          />
        ))}
        {!visible.length ? <EmptyState>No scanner candidates match this view.</EmptyState> : null}
      </div>
    </div>
  );
}

function CandidateCard({
  result,
  buddies,
  pendingStatus,
  onResearchStatusChange,
}: {
  result: ScannerViewResult;
  buddies: ScannerBuddy[];
  pendingStatus?: QuickResearchStatus;
  onResearchStatusChange: ScannerResearchStatusChange;
}) {
  const status = statusInfo(result);

  return (
    <details className={`rounded-lg border bg-zinc-900 ${resultBorder(result)}`}>
      <summary className="flex cursor-pointer list-none flex-col gap-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold text-zinc-50">{result.record.ticker}</span>
            <ResearchBadge status={result.researchStatus} />
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
        {status.word === "VERIFY" ? <VerifyReasons result={result} /> : null}
        <dl className="grid grid-cols-3 gap-x-2 gap-y-1 text-xs">
          <MobileDatum label="Price" value={coloredCell(result.values.price, money, ruleSeverityTone(criterionFor(result, "price")))} />
          <MobileDatum
            label="RSI / BB"
            value={
              <>
                {coloredCell(result.values.rsi, (v) => toNumber(v).toFixed(1), ruleSeverityTone(criterionFor(result, "rsi")))} /{" "}
                {coloredCell(result.values.bbPercent, percent, ruleSeverityTone(criterionFor(result, "bbPercent")))}
              </>
            }
          />
          <MobileDatum label="Strike" value={cell(result.values.strike, money)} />
          <MobileDatum label="Premium" value={coloredCell(result.values.premium, money, ruleSeverityTone(criterionFor(result, "optionBid")))} />
          <MobileDatum label="ROR" value={coloredCell(result.values.ror, percent, ruleSeverityTone(criterionFor(result, "ror")))} />
          <MobileDatum label="DTE" value={coloredCell(result.values.dte, (v) => `${v}d`, ruleSeverityTone(criterionFor(result, "dte")))} />
        </dl>
      </summary>
      <div className="border-t border-zinc-800 p-3">
        <CandidateInspector
          result={result}
          buddies={buddies}
          pendingStatus={pendingStatus}
          onResearchStatusChange={onResearchStatusChange}
        />
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

const quickResearchChoices: { key: QuickResearchStatus; label: string }[] = [
  { key: "LIKE", label: "Like" },
  { key: "WATCH", label: "Watch" },
  { key: "NEUTRAL", label: "Neutral" },
  { key: "AVOID", label: "Avoid" },
  { key: "NEVER_TRADE", label: "Exclude" },
];

function CandidateInspector({
  result,
  buddies,
  pendingStatus,
  onResearchStatusChange,
}: {
  result: ScannerViewResult;
  buddies: ScannerBuddy[];
  pendingStatus?: QuickResearchStatus;
  onResearchStatusChange: ScannerResearchStatusChange;
}) {
  return (
    <div className="grid gap-5 rounded-md border border-zinc-800 bg-zinc-950 p-4 xl:grid-cols-[1fr_1fr_0.8fr]">
      <div className="flex flex-wrap items-center gap-1.5 xl:col-span-3">
        <span className="text-xs font-semibold uppercase tracking-normal text-zinc-500">Research</span>
        {quickResearchChoices.map((choice) => {
          const isActive = result.researchStatus === choice.key;
          return (
            <button
              key={choice.key}
              type="button"
              aria-pressed={isActive}
              disabled={Boolean(pendingStatus)}
              onClick={() => onResearchStatusChange(result, choice.key)}
              className={`inline-flex min-h-8 items-center rounded-md border px-2.5 text-xs font-medium transition ${
                isActive
                  ? "border-emerald-400/70 bg-emerald-400/15 text-emerald-100"
                  : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500"
              } ${pendingStatus === choice.key ? "animate-pulse" : ""} disabled:cursor-wait disabled:opacity-75`}
            >
              {choice.label}
            </button>
          );
        })}
        <IntentPrefetchLink
          href="/research"
          className="ml-1 inline-flex min-h-8 items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 text-xs font-medium text-zinc-300 hover:border-emerald-400/60 hover:text-emerald-200"
        >
          <Search className="size-3.5" aria-hidden />
          Open in Research
        </IntentPrefetchLink>
      </div>
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-normal text-zinc-400">Stock</h3>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <Datum label="Ticker" value={result.record.ticker} />
          <Datum label="Current price" value={coloredCell(result.values.price, money, ruleSeverityTone(criterionFor(result, "price")))} />
          <Datum label="Change" value={signedPercent(result.values.priceChangePercent)} />
          <Datum label="RSI" value={coloredCell(result.values.rsi, (v) => toNumber(v).toFixed(1), ruleSeverityTone(criterionFor(result, "rsi")))} />
          <Datum label="BB position" value={coloredCell(result.values.bbPercent, percent, ruleSeverityTone(criterionFor(result, "bbPercent")))} />
          <Datum label="Volume" value={cell(result.values.stockVolume, formatCount)} />
          <Datum label="Earnings" value={result.values.earningsDate ? shortDate(result.values.earningsDate) : dash()} />
          <Datum
            label="Days to earnings"
            value={coloredCell(result.values.earningsDistance, formatCount, ruleSeverityTone(criterionFor(result, "earningsDistance")))}
          />
        </dl>
      </section>
      <section>
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-normal text-zinc-400">
          Option
          <InfoTip label="DTE filtering" testId="help-scanner-dte">
            DTE is colored against your Scanner Rules only when the DTE rule is enabled. It&apos;s shown for reference even when
            disabled, so a wide-ranging value isn&apos;t a bug.
          </InfoTip>
        </h3>
        {result.values.scanNote ? <p className="mt-2 text-xs text-zinc-500">{result.values.scanNote}</p> : null}
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <Datum label="Expiration" value={result.values.expiration ? shortDate(result.values.expiration) : dash()} />
          <Datum label="DTE" value={coloredCell(result.values.dte, formatCount, ruleSeverityTone(criterionFor(result, "dte")))} />
          <Datum label="Strike" value={cell(result.values.strike, money)} />
          <Datum label="Distance OTM" value={cell(result.values.distanceOtmPercent, percent)} />
          <Datum label="Bid" value={coloredCell(result.values.optionBid, money, ruleSeverityTone(criterionFor(result, "optionBid")))} />
          <Datum label="Ask" value={cell(result.values.optionAsk, money)} />
          <Datum label="Midpoint" value={cell(result.values.midpoint, money)} />
          <Datum label="Delta" value={cell(result.values.delta, (v) => toNumber(v).toFixed(2))} />
          <Datum
            label="Open interest"
            value={coloredCell(result.values.openInterest, formatCount, ruleSeverityTone(criterionFor(result, "openInterest")))}
          />
          <Datum
            label="Option volume"
            value={coloredCell(result.values.optionVolume, formatCount, ruleSeverityTone(criterionFor(result, "optionVolume")))}
          />
          <Datum label="Spread" value={cell(result.values.spreadPercent, percent)} />
          <Datum label="ROR" value={coloredCell(result.values.ror, percent, ruleSeverityTone(criterionFor(result, "ror")))} />
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

/** Looks up this row's evaluated criterion for a Scanner Rule key, straight off the already-
 * computed `summary.results` - a miss means the rule is disabled (or doesn't apply to this
 * metric, e.g. "strike"), which `ruleSeverityTone` renders as neutral, never a hard pass/fail. */
function criterionFor(result: ScannerViewResult, key: string): CriterionResult | undefined {
  return result.summary.results.find((criterion) => criterion.key === key);
}

/** Reuses the same color families as the shared `Badge` tones (src/components/ui.tsx) -
 * green/amber/red/neutral - so cell coloring never introduces a new palette. */
function severityTextClass(tone: SeverityTone): string {
  switch (tone) {
    case "good":
      return "text-emerald-300";
    case "warn":
      return "text-amber-300";
    case "bad":
      return "text-red-300";
    default:
      return "text-zinc-200";
  }
}

/** Same contract as `cell()`, but colors the rendered value by severity tone when present.
 * Never colors a dash - an unavailable value stays neutral, not a false red/green. */
function coloredCell(value: number | null, format: (value: number) => string, tone: SeverityTone) {
  if (value === null) {
    return dash();
  }
  return <span className={severityTextClass(tone)}>{format(value)}</span>;
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

function ResearchBadge({ status }: { status: ScannerViewResult["researchStatus"] }) {
  if (!status || status === "NEUTRAL") {
    return null;
  }
  if (status === "LIKE") {
    return (
      <span title="Liked" className="inline-flex shrink-0 items-center gap-0.5 text-[10px] font-semibold text-emerald-300">
        <Star className="size-3 fill-emerald-300" aria-hidden />
        LIKE
      </span>
    );
  }
  if (status === "WATCH") {
    return (
      <span title="Watching" className="shrink-0 text-[10px] font-semibold text-sky-300">
        WATCH
      </span>
    );
  }
  if (status === "AVOID") {
    return (
      <span title="Avoid" className="shrink-0 text-[10px] font-semibold text-amber-300">
        AVOID
      </span>
    );
  }
  return (
    <span title="Excluded by you" className="shrink-0 text-[10px] font-semibold text-red-300/70">
      EXCLUDED
    </span>
  );
}

/** Friendlier phrasing for the rules most likely to be VERIFY's cause in practice - falls back
 * to the criterion's own (already correct, just more verbose) `explanation` for anything else,
 * so a row is never left with no reason shown at all. */
const UNKNOWN_REASON_PHRASES: Record<string, string> = {
  earningsDistance: "Earnings date unavailable",
  optionVolume: "Option volume unavailable",
  stockVolume: "Underlying volume unavailable",
  openInterest: "Open interest unavailable",
  optionBid: "Option bid unavailable",
  debtToEquity: "Debt/equity unavailable",
};

function unknownReasons(result: ScannerViewResult): string[] {
  return result.summary.results
    .filter((criterion) => criterion.status === "UNKNOWN")
    .map((criterion) => UNKNOWN_REASON_PHRASES[criterion.key] ?? criterion.explanation);
}

/** Never make the user guess why a row says VERIFY - shown right under the badge, not just
 * buried in the row's full expansion. */
function VerifyReasons({ result }: { result: ScannerViewResult }) {
  const reasons = unknownReasons(result);
  if (reasons.length === 0) {
    return null;
  }

  return (
    <div className="mt-1 text-[10px] leading-snug text-zinc-500" title={reasons.join("; ")}>
      {reasons.length === 1 ? reasons[0] : `${reasons.length} inputs need verification: ${reasons.join(", ")}`}
    </div>
  );
}

/**
 * The domain's own classification (honestSetupLabel: a gating FAIL always reads "Fails," any
 * UNKNOWN criterion always reads "Verify") must win before the "NEAR" heuristic ever gets a
 * say - otherwise a candidate that fails a gating rule by a small margin can render the amber
 * "NEAR" badge instead of "FAIL"/"VERIFY," directly contradicting the domain's own answer.
 * getNearMisses doesn't distinguish gating from preference criteria, so it cannot be trusted
 * to override either of those on its own. Shared by the status badge, the row border, the
 * "Near" one-click filter, and its count chip, so all four always agree on what "near" means.
 */
function isNearMatch(result: ScannerViewResult): boolean {
  if (result.summary.status === "PASS") {
    return false;
  }
  if (result.scoreLabel === "Verify" || result.scoreLabel === "Fails" || result.score < 45) {
    return false;
  }
  return result.nearMisses.length === 1;
}

function statusInfo(result: ScannerViewResult): { word: string; tone: string } {
  if (result.summary.status === "PASS") {
    return { word: "PASS", tone: "border-emerald-400/40 bg-emerald-400/15 text-emerald-100" };
  }
  if (result.scoreLabel === "Verify") {
    return { word: "VERIFY", tone: "border-zinc-600 bg-zinc-800 text-zinc-300" };
  }
  if (result.scoreLabel === "Fails" || result.score < 45) {
    return { word: "FAIL", tone: "border-red-400/40 bg-red-400/15 text-red-100" };
  }
  if (isNearMatch(result)) {
    return { word: "NEAR", tone: "border-amber-400/40 bg-amber-400/15 text-amber-100" };
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
  // A real FAIL (see isNearMatch's comment on precedence) must win over the "near" heuristic.
  if (result.summary.status === "FAIL") {
    return "border-red-400/25";
  }
  if (isNearMatch(result)) {
    return "border-amber-400/35";
  }
  return "border-zinc-800";
}

function applyQuickFilter(results: ScannerViewResult[], quick: QuickKey) {
  switch (quick) {
    case "pass":
      return results.filter((result) => result.summary.status === "PASS");
    case "near":
      return results.filter(isNearMatch);
    case "watchlist":
      return results.filter((result) => result.researchStatus !== null);
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

/** Both critical technical inputs are unknown - the exact condition that lets hundreds of
 * candidates tie on the active sort key (most commonly Score) and fall through to raw
 * alphabetical order, looking like a meaningful ranking when it isn't one. See
 * PROJECT_HANDOFF.md's weekend-coverage investigation. */
function isTechnicallyIncomplete(result: ScannerViewResult) {
  return result.values.rsi === null && result.values.bbPercent === null;
}

function sortComparator(sort: SortKey) {
  return (left: ScannerViewResult, right: ScannerViewResult) => {
    if (sort === "ticker") {
      return left.record.ticker.localeCompare(right.record.ticker);
    }
    if (sort === "rsi" || sort === "spreadPercent" || sort === "dte" || sort === "price") {
      return compareAsc(left, right, sort);
    }
    return compareDesc(left, right, sort);
  };
}

function sortResults(results: ScannerViewResult[], sort: SortKey) {
  const comparator = sortComparator(sort);
  // Technically-evaluable candidates are grouped ahead of technically-incomplete ones - ordering
  // WITHIN each group still uses the exact same comparator/tie-break as before (deterministic,
  // never an invented score) - this only changes which of two TIED groups comes first, never how
  // a real, known value compares to another.
  const evaluable = results.filter((result) => !isTechnicallyIncomplete(result)).sort(comparator);
  const incomplete = results.filter(isTechnicallyIncomplete).sort(comparator);
  return [...evaluable, ...incomplete];
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
