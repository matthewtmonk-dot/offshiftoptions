"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { InfoTip } from "@/components/info-tip";
import {
  ArrowDownUp,
  ChevronDown,
  Check,
  ChevronRight,
  CircleHelp,
  EyeOff,
  LineChart,
  ListFilter,
  Search,
  Send,
  Star,
  Table2,
} from "lucide-react";
import { EmptyState } from "@/components/ui";
import { AiAdvisorReviewPanel } from "@/components/ai-advisor-review-panel";
import { RECOMMENDATION_REASON_TAGS } from "@/domain/social/recommendations";
import { formatCriterionValue, type CriterionResult, type ExclusionDiagnostic, type ScannerReadiness } from "@/domain/scanner/scanner";
import { OPTION_CHAIN_ENRICHMENT_LIMIT } from "@/domain/scanner/live-scan";
import {
  isNotOptionAssessed as isNotOptionAssessedState,
  scannerRowReasons,
  notOptionAssessedBadge,
} from "@/domain/scanner/option-enrichment";
import { funnelInputOf, isBestAvailable, isWorthALook } from "@/domain/scanner/scannerFunnel";
import { ruleSeverityTone, type SeverityTone } from "@/domain/scanner/severity";
import { TRADINGVIEW_CHART_LINKS, tradingViewChartUrl } from "@/lib/tradingview";
import { formatEtDateTime, money, percent, shortDate, toNumber } from "@/lib/format";
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

type QuickKey = "worth" | "best" | "all" | "pass" | "near" | "watchlist" | "strongest" | "premium" | "liquid" | "low-rsi" | "far-earnings";
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
  { key: "worth", label: "Worth a look" },
  { key: "best", label: "Best available" },
  { key: "pass", label: "Pass" },
  { key: "near", label: "Near" },
  { key: "watchlist", label: "Watchlist" },
  { key: "all", label: "All" },
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
/** In the default view, at most this many not-yet-priced rows are listed; the rest are one summary line. */
const MAX_UNPRICED_ROWS_SHOWN = 5;

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
  // Default to "Worth a look" (PASS/NEAR plus qualified names awaiting an option check) so the page
  // doesn't open on ~100 rows of stock-screen-only noise. A run that predates option-assessment
  // tracking (or a demo run) can't be classified that way, so it keeps showing everything.
  const [quick, setQuick] = useState<QuickKey>(() => (results.some((result) => result.values.optionEnrichment !== null) ? "worth" : "all"));
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
      pass: actionable.filter((result) => result.readiness === "PASS").length,
      near: actionable.filter((result) => result.readiness === "NEAR").length,
      watchlist: actionable.filter((result) => result.researchStatus !== null).length,
      worth: actionable.filter((result) => isWorthALook(funnelInputOf(result))).length,
      best: actionable.filter((result) => isBestAvailable(funnelInputOf(result))).length,
      all: actionable.length,
    }),
    [actionable],
  );

  const sortedVisible = useMemo(() => sortResults(applyQuickFilter(actionable, quick), sort), [actionable, quick, sort]);
  // In the default view, show only the first few names that are still waiting for their option lookup
  // (the rest are summarized in one line) so a hundred un-priced rows can't bury the priced ones.
  const { visible, hiddenWaiting } = useMemo(() => {
    if (quick !== "worth") return { visible: sortedVisible, hiddenWaiting: 0 };
    const rows: ScannerViewResult[] = [];
    let waiting = 0;
    for (const result of sortedVisible) {
      if (result.values.optionEnrichment === "NOT_ENRICHED_BUDGET") {
        waiting += 1;
        if (waiting > MAX_UNPRICED_ROWS_SHOWN) continue;
      }
      rows.push(result);
    }
    return { visible: rows, hiddenWaiting: Math.max(0, waiting - MAX_UNPRICED_ROWS_SHOWN) };
  }, [sortedVisible, quick]);
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
            <span className="text-[10px] text-zinc-500">{counts[filter.key as "worth" | "best" | "pass" | "near" | "watchlist" | "all"]}</span>
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
              <th className="border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">
                <span className="inline-flex items-center gap-1">
                  Premium
                  <InfoTip label="Premium basis" testId="help-scanner-premium-basis">
                    A mark/midpoint estimate, not the bid. Expand a row for the bid-based dollar figure ROR actually uses.
                  </InfoTip>
                </span>
              </th>
              <th className="border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">
                <span className="inline-flex items-center gap-1">
                  ROR
                  <InfoTip label="ROR basis" testId="help-scanner-ror-basis">
                    Calculated from the bid, not the mark/midpoint premium shown to its left.
                  </InfoTip>
                </span>
              </th>
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
                      <ChartIconLink ticker={result.record.ticker} />
                    </td>
                    <td className="border-b border-zinc-900 px-3 py-2">
                      <span className={`inline-flex min-w-9 justify-center rounded-md border px-1.5 py-0.5 text-xs font-semibold ${scoreChipClass(result.score, result.readiness, result.scoreLabel)}`}>
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
                      {status.word === "VERIFY" || isNotOptionAssessed(result) ? <VerifyReasons result={result} /> : null}
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
            <EmptyState>{emptyViewMessage(quick)}</EmptyState>
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
        {!visible.length ? <EmptyState>{emptyViewMessage(quick)}</EmptyState> : null}
      </div>

      {hiddenWaiting > 0 ? (
        <p data-testid="scanner-hidden-waiting" className="text-sm text-zinc-400">
          +{hiddenWaiting} more stocks passed the stock screen but haven&apos;t had their options priced yet. Press <strong className="text-zinc-200">Check options</strong> above to price them.
        </p>
      ) : null}
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
            <span className={`inline-flex min-w-9 justify-center rounded-md border px-1.5 py-0.5 text-xs font-semibold ${scoreChipClass(result.score, result.readiness, result.scoreLabel)}`}>
              {result.score}
            </span>
            <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${status.tone}`}>
              {status.word}
            </span>
          </div>
        </div>
        {status.word === "VERIFY" || isNotOptionAssessed(result) ? <VerifyReasons result={result} /> : null}
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
  const v = result.values;
  const hasContract = v.strike !== null && Boolean(v.expiration);
  const attention = result.summary.results.filter((criterion) => criterion.status !== "PASS");
  const passing = result.summary.results.filter((criterion) => criterion.status === "PASS");

  return (
    <div className="space-y-4 rounded-md border border-zinc-800 bg-zinc-950 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-1.5">
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
        <span className="ml-1 inline-flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-normal text-zinc-500">TradingView</span>
          {TRADINGVIEW_CHART_LINKS.map((link) => {
            const href = tradingViewChartUrl(result.record.ticker, link.interval);
            return href ? (
              <a
                key={link.interval}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                title={link.title}
                className="inline-flex min-h-8 items-center gap-1 rounded-md border border-zinc-700 px-2.5 text-xs font-medium text-zinc-300 hover:border-sky-400/60 hover:text-sky-200"
              >
                <LineChart className="size-3.5" aria-hidden />
                {link.label}
              </a>
            ) : null;
          })}
        </span>
      </div>

      {hasContract ? (
        <section aria-label="Trade summary" className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3">
          <p className="text-sm text-zinc-300">
            Sell the <span className="font-semibold text-zinc-50">{shortDate(v.expiration as string)}</span>{" "}
            <span className="font-semibold text-zinc-50">{money(v.strike as number)}</span> put
            {v.bidProceedsPerContract !== null ? (
              <>
                {" "}
                to collect about <span className="font-semibold text-emerald-300">{money(v.bidProceedsPerContract)}</span> per contract at the bid
              </>
            ) : null}
            .
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
            <Datum label="Strike" value={cell(v.strike, money)} />
            <Datum label="Expires in" value={coloredCell(v.dte, (d) => `${formatCount(d)} days`, ruleSeverityTone(criterionFor(result, "dte")))} />
            <Datum label="Below price" value={cell(v.distanceOtmPercent, percent)} />
            <Datum label="Weekly return" value={coloredCell(v.ror, percent, ruleSeverityTone(criterionFor(result, "ror")))} />
            <Datum label="Annualized" value={cell(v.annualizedRor, percent)} />
            <Datum label="Delta" value={cell(v.delta, (d) => toNumber(d).toFixed(2))} />
          </dl>
          {v.scanNote ? <p className="mt-2 text-xs text-zinc-500">{v.scanNote}</p> : null}
        </section>
      ) : (
        <p className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3 text-sm text-zinc-400">
          {isNotOptionAssessed(result)
            ? "No option contract has been priced for this stock yet. Press Check options above."
            : "No qualifying put contract was found for this stock."}
          {v.scanNote ? <span className="mt-1 block text-xs text-zinc-500">{v.scanNote}</span> : null}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-normal text-zinc-400">Stock</h3>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
            <Datum
              label="Price"
              value={
                <>
                  {coloredCell(v.price, money, ruleSeverityTone(criterionFor(result, "price")))}
                  {v.priceChangePercent !== null ? <span className="ml-1 text-xs text-zinc-500">{signedPercent(v.priceChangePercent)}</span> : null}
                </>
              }
            />
            <Datum label="RSI" value={coloredCell(v.rsi, (r) => toNumber(r).toFixed(1), ruleSeverityTone(criterionFor(result, "rsi")))} />
            <Datum label="Bollinger %B" value={coloredCell(v.bbPercent, percent, ruleSeverityTone(criterionFor(result, "bbPercent")))} />
            <Datum label="Volume" value={cell(v.stockVolume, formatCount)} />
            <Datum
              label="Next earnings"
              value={
                v.earningsDate ? (
                  <>
                    {shortDate(v.earningsDate)}
                    {v.earningsDistance !== null ? (
                      <span className={`ml-1 text-xs ${severityTextClass(ruleSeverityTone(criterionFor(result, "earningsDistance")))}`}>
                        ({formatCount(v.earningsDistance)}d)
                      </span>
                    ) : null}
                  </>
                ) : (
                  dash()
                )
              }
            />
            <Datum
              label="Earnings vs trade"
              value={
                v.earningsWithinHoldingPeriod === null ? (
                  dash()
                ) : v.earningsWithinHoldingPeriod ? (
                  <span className="text-amber-300">Before expiry</span>
                ) : (
                  "After expiry"
                )
              }
            />
          </dl>
        </section>
        <section>
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-normal text-zinc-400">
            Option quote
            <InfoTip label="DTE filtering" testId="help-scanner-dte">
              DTE is colored against your Scanner Rules only when the DTE rule is enabled. It&apos;s shown for reference even when
              disabled, so a wide-ranging value isn&apos;t a bug.
            </InfoTip>
          </h3>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
            <Datum label="Bid" value={coloredCell(v.optionBid, money, ruleSeverityTone(criterionFor(result, "optionBid")))} />
            <Datum label="Ask" value={cell(v.optionAsk, money)} />
            <Datum label="Spread" value={cell(v.spreadPercent, percent)} />
            <Datum
              label="Open interest"
              value={coloredCell(v.openInterest, formatCount, ruleSeverityTone(criterionFor(result, "openInterest")))}
            />
            <Datum
              label="Option volume"
              value={coloredCell(v.optionVolume, formatCount, ruleSeverityTone(criterionFor(result, "optionVolume")))}
            />
            <Datum label="Midpoint" value={cell(v.midpoint, money)} />
          </dl>
          {v.retrievedAt ? (
            <p
              className={`mt-2 text-xs ${v.retrievedOnNonTradingDay ? "text-amber-300/80" : "text-zinc-500"}`}
              title="Schwab does not provide a verified option-quote pricing timestamp, so this is when OSO retrieved the quote - not proof of when the quote itself was priced."
            >
              {v.retrievedOnNonTradingDay
                ? `Fetched ${formatEtDateTime(v.retrievedAt)} while the market was closed - last available quote, not live.`
                : `Retrieved ${formatEtDateTime(v.retrievedAt)}.`}
            </p>
          ) : null}
        </section>
      </div>

      <section aria-label="Criteria">
        <h3 className="flex flex-wrap items-baseline gap-x-2 text-xs font-semibold uppercase tracking-normal text-zinc-400">
          Criteria
          <span className="font-normal normal-case text-zinc-500">
            {passing.length} passing
            {attention.length > 0 ? ` · ${attention.length} need attention` : ""}
          </span>
        </h3>
        {attention.length > 0 ? (
          <ul className="mt-2 grid gap-1.5 lg:grid-cols-2">
            {attention.map((criterion) => (
              <li
                key={criterion.name}
                className={`rounded-md border px-2.5 py-2 text-sm ${
                  criterion.status === "FAIL" ? "border-red-400/30 bg-red-400/10" : "border-zinc-700 bg-zinc-900/70"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-zinc-100">{criterion.name}</span>
                  <span
                    className={`inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${
                      criterion.status === "FAIL"
                        ? "border-red-400/40 bg-red-400/15 text-red-100"
                        : "border-zinc-600 bg-zinc-800 text-zinc-300"
                    }`}
                  >
                    {criterion.status === "FAIL" ? "FAIL" : "UNKNOWN"}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-zinc-400">
                  <span className="text-zinc-300">{formatCriterionValue(criterion.actualValue)}</span> · {criterion.explanation}
                </p>
              </li>
            ))}
          </ul>
        ) : null}
        {passing.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {passing.map((criterion) => (
              <li
                key={criterion.name}
                title={`${formatCriterionValue(criterion.actualValue)} - ${criterion.explanation}`}
                className="inline-flex items-center gap-1 rounded-md border border-emerald-400/25 bg-emerald-400/10 px-2 py-0.5 text-xs text-emerald-100"
              >
                <Check className="size-3" aria-hidden />
                {criterion.name}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <div className="flex flex-wrap items-start gap-3 border-t border-zinc-800 pt-3">
        <div className="min-w-0 flex-1 basis-72">
          <AiAdvisorReviewPanel scanResultId={result.record.id} />
        </div>
        {buddies.length > 0 ? (
          <details className="group min-w-0 max-w-sm flex-1">
            <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 text-xs font-medium text-zinc-300 hover:border-emerald-400/60 hover:text-emerald-200">
              <Send className="size-3.5" aria-hidden />
              Send to a buddy
            </summary>
            <div className="mt-2">
              <RecommendMiniForm ticker={result.record.ticker} buddies={buddies} returnTo="/scanner" />
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}

/** A one-click "open this ticker's chart" icon for the collapsed table row - opens TradingView in a new tab. */
function ChartIconLink({ ticker }: { ticker: string }) {
  const href = tradingViewChartUrl(ticker, "D");
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => event.stopPropagation()}
      title={`Open ${ticker} on TradingView (daily chart)`}
      aria-label={`Open ${ticker} chart on TradingView`}
      className="ml-5 mt-0.5 inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-sky-300"
    >
      <LineChart className="size-3" aria-hidden />
      Chart
    </a>
  );
}

function RecommendMiniForm({ ticker, buddies, returnTo }: { ticker: string; buddies: ScannerBuddy[]; returnTo: string }) {
  return (
    <form action={recommendStockAction} className="space-y-2">
      <input type="hidden" name="ticker" value={ticker} />
      <input type="hidden" name="returnTo" value={returnTo} />
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

/** See option-enrichment.ts: a row OSO never spent a chain request on must not read as though
 * Schwab was asked and came back empty. Defers to that shared vocabulary so the producer
 * (evaluateLiveMarketScan) and this UI can never drift apart on what a state means. */
function isNotOptionAssessed(result: ScannerViewResult): boolean {
  return isNotOptionAssessedState(result.values.optionEnrichment);
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

/** Never make the user guess why a row says VERIFY (or STOCK SCREEN ONLY) - shown right under the
 * badge, not just buried in the row's full expansion. A never-assessed row shows the single true
 * reason its options are blank instead of a list of option inputs that were never requested. */
function VerifyReasons({ result }: { result: ScannerViewResult }) {
  const reasons = scannerRowReasons(result.values.optionEnrichment, unknownReasons(result), OPTION_CHAIN_ENRICHMENT_LIMIT);
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
 * The status badge word/tone reads `result.readiness` (classifyReadiness in scanner.ts)
 * exclusively - the same authoritative PASS/NEAR/NEEDS_DATA/FAIL answer used by the row border,
 * the "Near"/"Pass" one-click filters, and every header count, so none of them can disagree about
 * what "near" or "pass" means. NEEDS_DATA still splits into two badge WORDS for the user's benefit
 * (STOCK SCREEN ONLY vs VERIFY) - that is presentation detail on top of the single NEEDS_DATA
 * classification, not a second competing classification.
 */
function statusInfo(result: ScannerViewResult): { word: string; tone: string } {
  if (result.readiness === "PASS") {
    return { word: "PASS", tone: "border-emerald-400/40 bg-emerald-400/15 text-emerald-100" };
  }
  if (result.readiness === "NEEDS_DATA") {
    // An assessment-stage label, deliberately NOT an option-quality verdict: a muted outline that
    // reads as "not evaluated yet", never as the emerald/amber/red/VERIFY judgments around it.
    if (isNotOptionAssessed(result)) {
      return {
        word: notOptionAssessedBadge(result.values.optionEnrichment),
        // A qualified stock waiting on its option lookup is "one click away" (sky); the rest stay muted.
        tone:
          result.values.optionEnrichment === "NOT_ENRICHED_BUDGET"
            ? "whitespace-nowrap border-dashed border-sky-400/50 bg-transparent text-sky-200"
            : "whitespace-nowrap border-dashed border-zinc-700 bg-transparent text-zinc-400",
      };
    }
    return { word: "VERIFY", tone: "border-zinc-600 bg-zinc-800 text-zinc-300" };
  }
  if (result.readiness === "FAIL") {
    return { word: "FAIL", tone: "border-red-400/40 bg-red-400/15 text-red-100" };
  }
  return { word: "NEAR", tone: "border-amber-400/40 bg-amber-400/15 text-amber-100" };
}

/**
 * Post-Reporting-Phase Scanner polish (presentation only - see PROJECT_HANDOFF.md's Known Active
 * Blockers note this fixes): a NEEDS_DATA row's option-chain evidence was never assessed
 * (`isNotOptionAssessed`) or is still UNKNOWN across some criteria - the numeric score reflects
 * only whatever criteria happen to be known, which can legitimately be high (e.g. a stock-screen-
 * only candidate with just a "price" rule enabled). Checked first, ahead of every label/score
 * branch below, so a NEEDS_DATA row's score always reads as "partial information", never as
 * confident as an actionable PASS/NEAR/FAIL row - regardless of how high that partial score is or
 * what `scoreLabel` says. This does not change `score` itself, `readiness`/classification, or
 * which rows are actionable (`isActionableReadiness`) - purely which CSS classes the existing chip
 * uses. NEAR/PASS/FAIL rows are unaffected: none of them can be NEEDS_DATA by construction
 * (classifyReadiness, scanner.ts), so this new branch never fires for them.
 */
export function scoreChipClass(score: number, readiness: ScannerReadiness, label?: string) {
  if (readiness === "NEEDS_DATA") {
    return "border-zinc-600 bg-zinc-800 text-zinc-300";
  }
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
  if (result.readiness === "PASS") {
    return "border-emerald-400/35";
  }
  if (result.readiness === "FAIL") {
    return "border-red-400/25";
  }
  if (result.readiness === "NEAR") {
    return "border-amber-400/35";
  }
  return "border-zinc-800";
}

function emptyViewMessage(quick: QuickKey): string {
  return quick === "worth"
    ? "Nothing in this scan is worth a look right now: no PASS or NEAR candidates, and no qualified stock still waiting for an option check. Try Best available (priced names that clear every hard rule but miss a preference), choose All to see everything screened, or run a fresh scan after the next data update."
    : quick === "best"
      ? "No priced candidate clears every hard rule (price, volume, open interest, bid, spread, delta, earnings) in this scan. Use Check options to price more names, or run a fresh scan."
      : "No scanner candidates match this view.";
}

function applyQuickFilter(results: ScannerViewResult[], quick: QuickKey) {
  switch (quick) {
    case "worth":
      return results.filter((result) => isWorthALook(funnelInputOf(result)));
    case "best":
      return results.filter((result) => isBestAvailable(funnelInputOf(result)));
    case "pass":
      return results.filter((result) => result.readiness === "PASS");
    case "near":
      return results.filter((result) => result.readiness === "NEAR");
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
  // On the default Score sort, names whose options were actually priced come before names still
  // waiting for their option check - real premiums/returns first, "not looked up yet" after. Other
  // sorts (ticker, price, ...) keep exactly the order the user asked for.
  if (sort === "score") {
    const priced = evaluable.filter((result) => !isNotOptionAssessed(result));
    const unpriced = evaluable.filter(isNotOptionAssessed);
    return [...priced, ...unpriced, ...incomplete];
  }
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
