"use client";

import { Fragment, useMemo, useState } from "react";
import {
  ArrowDownUp,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  MessageCircle,
  Plus,
  Save,
  Send,
  Star,
  ThumbsUp,
  Trash2,
} from "lucide-react";
import { EmptyState, FieldLabel } from "@/components/ui";
import { InfoTip } from "@/components/info-tip";
import { RECOMMENDATION_REASON_TAGS } from "@/domain/social/recommendations";
import {
  resolveAutoOrManual,
  RESEARCH_COLUMN_DEFINITIONS,
  RESEARCH_COLUMN_GROUP_LABELS,
  type ResearchColumnGroup,
  type ResearchSortKey,
} from "@/domain/research/columns";
import type { TrackerScope } from "@/lib/app-data";
import { money, shortDateTime, toNumber } from "@/lib/format";
import {
  addReactionAction,
  addWatchlistCommentAction,
  addWatchlistItemAction,
  recommendStockAction,
  removeWatchlistItemAction,
  saveStockNoteAction,
  setResearchStatusAction,
  toggleWatchlistItemVisibilityAction,
  updateResearchColumnsAction,
  updateResearchDetailsAction,
} from "../actions";
import type {
  ResearchBuddy,
  ResearchBuddyItemRecord,
  ResearchCampaignSummary,
  ResearchItemRecord,
  ResearchScanSnapshot,
} from "./page";

type StatusKey = "all" | "LIKE" | "WATCH" | "NEUTRAL" | "AVOID" | "NEVER_TRADE";
type ResearchStatusChoice = Exclude<StatusKey, "all">;
type ResearchStatusOverride = {
  baseItem: ResearchItemRecord;
  baseStatus: ResearchStatusChoice;
  nextStatus: ResearchStatusChoice;
};
type ResearchStatusChange = (item: ResearchItemRecord, status: ResearchStatusChoice) => void;

const statusTabs: { key: StatusKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "LIKE", label: "Like" },
  { key: "WATCH", label: "Watch" },
  { key: "NEUTRAL", label: "Neutral" },
  { key: "AVOID", label: "Avoid" },
  { key: "NEVER_TRADE", label: "Excluded" },
];

const statusChoices: { key: ResearchStatusChoice; label: string }[] = [
  { key: "LIKE", label: "Like" },
  { key: "WATCH", label: "Watch" },
  { key: "NEUTRAL", label: "Neutral" },
  { key: "AVOID", label: "Avoid" },
  { key: "NEVER_TRADE", label: "Never Trade" },
];

const sortOptions: { key: ResearchSortKey; label: string }[] = [
  { key: "added", label: "Recently added" },
  { key: "ticker", label: "Ticker" },
  { key: "score", label: "Scanner score" },
  { key: "price", label: "Price" },
];

const COLUMN_GROUP_ORDER: ResearchColumnGroup[] = ["CORE", "TECHNICAL", "FUNDAMENTALS", "EXTERNAL", "PERSONAL", "HISTORY"];

export function ResearchWorkspace({
  scope,
  buddyName,
  items,
  buddyItems,
  buddies,
  scanByTicker,
  campaignByTicker,
  initialColumns,
  initialSortKey,
  error,
}: {
  scope: TrackerScope;
  buddyName: string;
  items: ResearchItemRecord[];
  buddyItems: ResearchBuddyItemRecord[];
  buddies: ResearchBuddy[];
  scanByTicker: Record<string, ResearchScanSnapshot>;
  campaignByTicker: Record<string, ResearchCampaignSummary>;
  initialColumns: string[];
  initialSortKey: ResearchSortKey;
  error?: string;
}) {
  const [status, setStatus] = useState<StatusKey>("all");
  const [optimisticStatuses, setOptimisticStatuses] = useState<Record<string, ResearchStatusOverride | undefined>>({});
  const [pendingStatuses, setPendingStatuses] = useState<Record<string, ResearchStatusChoice | undefined>>({});
  const [statusError, setStatusError] = useState<string | null>(null);
  const [sort, setSort] = useState<ResearchSortKey>(initialSortKey);
  const [columns, setColumns] = useState<string[]>(initialColumns);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const optimisticItems = useMemo(
    () =>
      items.map((item) => {
        const optimisticStatus = optimisticStatuses[item.id];
        return optimisticStatus && optimisticStatus.baseItem === item && optimisticStatus.baseStatus === item.researchStatus
          ? { ...item, researchStatus: optimisticStatus.nextStatus }
          : item;
      }),
    [items, optimisticStatuses],
  );

  const counts = useMemo(() => {
    const result: Record<StatusKey, number> = { all: optimisticItems.length, LIKE: 0, WATCH: 0, NEUTRAL: 0, AVOID: 0, NEVER_TRADE: 0 };
    for (const item of optimisticItems) {
      result[item.researchStatus] += 1;
    }
    return result;
  }, [optimisticItems]);

  const visible = useMemo(() => {
    const filtered = status === "all" ? optimisticItems : optimisticItems.filter((item) => item.researchStatus === status);
    return [...filtered].sort((left, right) => {
      if (sort === "ticker") {
        return left.ticker.localeCompare(right.ticker);
      }
      if (sort === "price") {
        return (scanByTicker[right.ticker]?.price ?? -Infinity) - (scanByTicker[left.ticker]?.price ?? -Infinity);
      }
      if (sort === "score") {
        return (scanByTicker[right.ticker]?.score ?? -1) - (scanByTicker[left.ticker]?.score ?? -1);
      }
      return new Date(right.addedAt).getTime() - new Date(left.addedAt).getTime();
    });
  }, [optimisticItems, status, sort, scanByTicker]);

  const buddyStatusByTicker = useMemo(() => new Map(buddyItems.map((item) => [item.ticker, item])), [buddyItems]);
  const mineStatusByTicker = useMemo(() => new Map(optimisticItems.map((item) => [item.ticker, item])), [optimisticItems]);

  const activeColumns = useMemo(
    () => columns.map((key) => RESEARCH_COLUMN_DEFINITIONS.find((definition) => definition.key === key)).filter((definition) => definition !== undefined),
    [columns],
  );
  const columnCount = 2 + activeColumns.length;
  const showMine = scope !== "buddy";
  const showBuddy = scope !== "mine";

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

  async function persistColumns(nextColumns: string[], nextSort: ResearchSortKey) {
    try {
      await updateResearchColumnsAction(nextColumns, nextSort);
    } catch {
      // Best-effort background preference save - a transient failure shouldn't interrupt
      // using the page this session; the user's choice still applies locally.
    }
  }

  function toggleColumn(key: string) {
    setColumns((prev) => {
      const next = prev.includes(key) ? prev.filter((existing) => existing !== key) : [...prev, key];
      void persistColumns(next, sort);
      return next;
    });
  }

  function moveColumn(key: string, direction: -1 | 1) {
    setColumns((prev) => {
      const index = prev.indexOf(key);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= prev.length) {
        return prev;
      }
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      void persistColumns(next, sort);
      return next;
    });
  }

  function changeSort(nextSort: ResearchSortKey) {
    setSort(nextSort);
    void persistColumns(columns, nextSort);
  }

  async function changeResearchStatus(item: ResearchItemRecord, nextStatus: ResearchStatusChoice) {
    if (item.researchStatus === nextStatus) {
      return;
    }

    const serverItem = items.find((candidate) => candidate.id === item.id) ?? item;
    const existingOverride = optimisticStatuses[item.id];
    const activeOverride =
      existingOverride?.baseItem === serverItem && existingOverride.baseStatus === serverItem.researchStatus
        ? existingOverride
        : undefined;
    const baseItem = activeOverride?.baseItem ?? serverItem;
    const baseStatus = activeOverride?.baseStatus ?? serverItem.researchStatus;
    const previousStatus = item.researchStatus;
    setStatusError(null);
    setPendingStatuses((prev) => ({ ...prev, [item.ticker]: nextStatus }));
    setOptimisticStatuses((prev) => ({
      ...prev,
      [item.id]: { baseItem, baseStatus, nextStatus },
    }));

    const formData = new FormData();
    formData.set("ticker", item.ticker);
    formData.set("status", nextStatus);
    formData.set("returnTo", "/research");

    try {
      const result = await setResearchStatusAction(formData);
      if (!result.ok) {
        rollBackResearchStatus(item.id, baseItem, baseStatus, previousStatus);
        setStatusError(result.error);
      }
    } catch {
      rollBackResearchStatus(item.id, baseItem, baseStatus, previousStatus);
      setStatusError("Research status could not be saved. Try again in a moment.");
    } finally {
      setPendingStatuses((prev) => {
        const next = { ...prev };
        delete next[item.ticker];
        return next;
      });
    }
  }

  function rollBackResearchStatus(
    itemId: string,
    baseItem: ResearchItemRecord,
    baseStatus: ResearchStatusChoice,
    previousStatus: ResearchStatusChoice,
  ) {
    setOptimisticStatuses((prev) => {
      const next = { ...prev };
      if (previousStatus === baseStatus) {
        delete next[itemId];
      } else {
        next[itemId] = { baseItem, baseStatus, nextStatus: previousStatus };
      }
      return next;
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-zinc-500">
          {scope === "mine"
            ? "Your own research."
            : scope === "buddy"
              ? `${buddyName}'s research shared with you.`
              : `Your research and ${buddyName}'s shared research, side by side - never merged.`}
        </p>
        <form action={addWatchlistItemAction} className="flex gap-2">
          <input type="hidden" name="returnTo" value="/research" />
          <input
            name="ticker"
            placeholder="Ticker"
            pattern="[A-Za-z][A-Za-z0-9.-]{0,9}"
            title="Use 1-10 ticker characters: letters, numbers, dot, or dash."
            className="min-h-9 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-50 outline-none focus:border-emerald-400 sm:w-36"
            required
          />
          <button
            type="submit"
            className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md bg-emerald-400 px-3 text-sm font-semibold text-black hover:bg-emerald-300"
          >
            <Plus className="size-3.5" aria-hidden />
            Add
          </button>
        </form>
      </div>

      {error ? (
        <div className="rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-100">{error}</div>
      ) : null}
      {statusError ? (
        <div className="rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-100">{statusError}</div>
      ) : null}

      {showMine ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {statusTabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setStatus(tab.key)}
                className={`inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition ${
                  status === tab.key
                    ? "border-emerald-400/70 bg-emerald-400/15 text-emerald-100"
                    : "border-zinc-800 bg-zinc-950 text-zinc-300 hover:border-zinc-600 hover:text-zinc-50"
                }`}
              >
                {tab.label}
                <span className="text-[10px] text-zinc-500">{counts[tab.key]}</span>
              </button>
            ))}

            <label className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 text-xs font-medium text-zinc-300">
              <ArrowDownUp className="size-3.5" aria-hidden />
              Sort
              <select
                value={sort}
                onChange={(event) => changeSort(event.target.value as ResearchSortKey)}
                aria-label="Sort research by"
                className="min-h-6 rounded border-none bg-transparent text-xs font-medium text-zinc-100 outline-none"
              >
                {sortOptions.map((option) => (
                  <option key={option.key} value={option.key} className="bg-zinc-900 text-zinc-100">
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <ColumnsMenu columns={columns} onToggle={toggleColumn} onMove={moveColumn} />
          </div>

          <div className="hidden overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950/60 lg:block" data-testid="research-desktop-table">
            <table className="w-full border-separate border-spacing-0 text-left text-xs">
              <thead>
                <tr className="text-[11px] uppercase tracking-normal text-zinc-500">
                  <th className="sticky left-0 z-10 w-16 border-b border-zinc-800 bg-zinc-900 px-3 py-2">Status</th>
                  <th className="sticky left-16 z-10 border-b border-zinc-800 bg-zinc-900 px-3 py-2">Ticker</th>
                  {activeColumns.map((column) => (
                    <th key={column.key} className="border-b border-zinc-800 bg-zinc-900/60 px-3 py-2 whitespace-nowrap">
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => {
                  const isOpen = expanded.has(item.id);
                  const scan = scanByTicker[item.ticker];
                  const history = campaignByTicker[item.ticker];
                  const buddyItem = scope === "both" ? buddyStatusByTicker.get(item.ticker) : undefined;
                  return (
                    <Fragment key={item.id}>
                      <tr onClick={() => toggleExpanded(item.id)} className="cursor-pointer transition hover:bg-zinc-900/55">
                        <td className="sticky left-0 z-10 border-b border-zinc-900 bg-zinc-950 px-3 py-2">
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            aria-label={`${isOpen ? "Collapse" : "Expand"} ${item.ticker} research`}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleExpanded(item.id);
                            }}
                            className="flex items-center gap-1.5 rounded text-left"
                          >
                            {isOpen ? <ChevronDown className="size-3.5 text-zinc-500" aria-hidden /> : <ChevronRight className="size-3.5 text-zinc-500" aria-hidden />}
                            <StatusChip status={item.researchStatus} />
                          </button>
                        </td>
                        <td className="sticky left-16 z-10 border-b border-zinc-900 bg-zinc-950 px-3 py-2">
                          <span className="text-sm font-semibold text-zinc-50">{item.ticker}</span>
                          {item.visibility === "SHARED" ? <Eye className="ml-1.5 inline size-3 text-sky-400" aria-hidden /> : null}
                          {buddyItem ? (
                            <div className="mt-0.5 text-[10px] font-normal text-zinc-500">
                              {buddyName}: <StatusChip status={buddyItem.researchStatus} />
                            </div>
                          ) : null}
                        </td>
                        {activeColumns.map((column) => (
                          <td key={column.key} className="border-b border-zinc-900 px-3 py-2 whitespace-nowrap">
                            {renderResearchCell(column.key, item, scan, history)}
                          </td>
                        ))}
                      </tr>
                      {isOpen ? (
                        <tr>
                          <td colSpan={columnCount} className="border-b border-zinc-900 bg-zinc-950/60 px-3 py-3">
                            <ResearchDetail
                              item={item}
                              buddies={buddies}
                              scan={scan}
                              history={history}
                              pendingStatus={pendingStatuses[item.ticker]}
                              onStatusChange={changeResearchStatus}
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
                <EmptyState>No researched tickers in this view yet.</EmptyState>
              </div>
            ) : null}
          </div>

          <div className="grid gap-3 lg:hidden" data-testid="research-mobile-cards">
            {visible.map((item) => (
              <ResearchMobileCard
                key={item.id}
                item={item}
                buddies={buddies}
                scan={scanByTicker[item.ticker]}
                history={campaignByTicker[item.ticker]}
                pendingStatus={pendingStatuses[item.ticker]}
                onStatusChange={changeResearchStatus}
              />
            ))}
            {!visible.length ? <EmptyState>No researched tickers in this view yet.</EmptyState> : null}
          </div>
        </>
      ) : null}

      {showBuddy ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-normal text-zinc-400">{buddyName}&apos;s Shared Research</h2>
          {buddyItems.length ? (
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {buddyItems.map((item) => {
                const mineForTicker = scope === "both" ? mineStatusByTicker.get(item.ticker) : undefined;
                return (
                  <div key={item.id} className="rounded-md border border-zinc-800 bg-zinc-900 p-2.5 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-zinc-50">{item.ticker}</span>
                      <StatusChip status={item.researchStatus} />
                    </div>
                    <div className="mt-1 text-xs text-zinc-500">{item.companyName ?? `${item.owner.name}'s view`}</div>
                    {item.wouldOwn ? (
                      <div className="mt-1 text-xs text-zinc-400">
                        Would own: {item.wouldOwn === "CONDITIONAL" && item.wouldOwnMaxPrice != null ? `Below ${money(item.wouldOwnMaxPrice)}` : item.wouldOwn}
                      </div>
                    ) : null}
                    {mineForTicker ? (
                      <div className="mt-1.5 border-t border-zinc-800 pt-1.5 text-[11px] text-zinc-500">
                        You: <StatusChip status={mineForTicker.researchStatus} />
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState>{buddyName} hasn&apos;t shared any research with you yet.</EmptyState>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ColumnsMenu({
  columns,
  onToggle,
  onMove,
}: {
  columns: string[];
  onToggle: (key: string) => void;
  onMove: (key: string, direction: -1 | 1) => void;
}) {
  return (
    <details className="group relative">
      <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 text-xs font-medium text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-50">
        Columns
        <ChevronDown className="size-3.5" aria-hidden />
      </summary>
      <div
        data-testid="research-columns-menu"
        className="absolute left-0 top-full z-20 mt-1 max-h-96 w-72 overflow-y-auto space-y-3 rounded-md border border-zinc-800 bg-zinc-900 p-3 shadow-lg shadow-black/30"
      >
        {COLUMN_GROUP_ORDER.map((group) => {
          const definitions = RESEARCH_COLUMN_DEFINITIONS.filter((definition) => definition.group === group);
          if (!definitions.length) {
            return null;
          }
          return (
            <div key={group}>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-normal text-zinc-500">{RESEARCH_COLUMN_GROUP_LABELS[group]}</div>
              <div className="space-y-0.5">
                {definitions.map((definition) => {
                  const index = columns.indexOf(definition.key);
                  const active = index >= 0;
                  return (
                    <div key={definition.key} className="flex min-h-8 items-center gap-1 rounded px-2 text-xs text-zinc-300 hover:bg-zinc-800">
                      <label className="flex flex-1 min-h-8 items-center gap-2">
                        <input
                          type="checkbox"
                          checked={active}
                          onChange={() => onToggle(definition.key)}
                          className="size-3.5 accent-emerald-400"
                        />
                        {definition.label}
                      </label>
                      {active ? (
                        <div className="flex items-center gap-0.5">
                          <button
                            type="button"
                            aria-label={`Move ${definition.label} earlier`}
                            disabled={index === 0}
                            onClick={() => onMove(definition.key, -1)}
                            className="rounded px-1 text-zinc-500 hover:text-zinc-100 disabled:opacity-30"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            aria-label={`Move ${definition.label} later`}
                            disabled={index === columns.length - 1}
                            onClick={() => onMove(definition.key, 1)}
                            className="rounded px-1 text-zinc-500 hover:text-zinc-100 disabled:opacity-30"
                          >
                            ↓
                          </button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}

function ResearchMobileCard({
  item,
  buddies,
  scan,
  history,
  pendingStatus,
  onStatusChange,
}: {
  item: ResearchItemRecord;
  buddies: ResearchBuddy[];
  scan?: ResearchScanSnapshot;
  history?: ResearchCampaignSummary;
  pendingStatus?: ResearchStatusChoice;
  onStatusChange: ResearchStatusChange;
}) {
  return (
    <details className="rounded-lg border border-zinc-800 bg-zinc-900">
      <summary className="flex cursor-pointer list-none flex-col gap-1.5 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <StatusChip status={item.researchStatus} />
            <span className="text-lg font-semibold text-zinc-50">{item.ticker}</span>
          </div>
          {scan?.price != null ? <span className="text-sm font-medium text-zinc-200">{money(scan.price)}</span> : null}
        </div>
        <div className="text-xs text-zinc-400">{resolveAutoOrManual(scan?.companyDescription ?? null, item.companyName) ?? "Company name not entered yet"}</div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-400">
          <span>Would own: {wouldOwnText(item)}</span>
          {history ? <span>{history.count} campaign{history.count === 1 ? "" : "s"}</span> : null}
        </div>
      </summary>
      <div className="border-t border-zinc-800 p-3">
        <ResearchDetail
          item={item}
          buddies={buddies}
          scan={scan}
          history={history}
          pendingStatus={pendingStatus}
          onStatusChange={onStatusChange}
        />
      </div>
    </details>
  );
}

function ResearchDetail({
  item,
  buddies,
  scan,
  history,
  pendingStatus,
  onStatusChange,
}: {
  item: ResearchItemRecord;
  buddies: ResearchBuddy[];
  scan?: ResearchScanSnapshot;
  history?: ResearchCampaignSummary;
  pendingStatus?: ResearchStatusChoice;
  onStatusChange: ResearchStatusChange;
}) {
  const proNotes = item.notes.filter((note) => note.category === "PRO");
  const conNotes = item.notes.filter((note) => note.category === "CON");
  const generalNotes = item.notes.filter((note) => note.category === "GENERAL");

  return (
    <div className="grid gap-5 rounded-md border border-zinc-800 bg-zinc-950 p-4 xl:grid-cols-[1fr_1fr_0.8fr]">
      <section className="space-y-4">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-normal text-zinc-400">My Decision</h3>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {statusChoices.map((choice) => {
              const isActive = item.researchStatus === choice.key;
              return (
                <button
                  key={choice.key}
                  type="button"
                  aria-pressed={isActive}
                  disabled={Boolean(pendingStatus)}
                  onClick={() => onStatusChange(item, choice.key)}
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
          </div>
        </div>

        <form action={updateResearchDetailsAction} className="space-y-4">
          <input type="hidden" name="itemId" value={item.id} />

          <div>
            <h4 className="text-xs font-semibold uppercase tracking-normal text-zinc-400">Company</h4>
            {scan?.companyDescription ? (
              <p className="mt-1 text-[11px] text-zinc-600">
                Schwab Trader API: <span className="text-zinc-400">{scan.companyDescription}</span> - shown above/in the table when
                available. The name below is your own manual entry, used as a fallback if Schwab data isn&apos;t available.
              </p>
            ) : null}
            <div className="mt-2 space-y-2">
              <input
                name="companyName"
                defaultValue={item.companyName ?? ""}
                placeholder="Company name"
                className="min-h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
              />
              <textarea
                name="whatItDoes"
                defaultValue={item.whatItDoes ?? ""}
                placeholder="Industry / what does this company actually do?"
                className="min-h-16 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-2 text-sm text-zinc-100"
              />
            </div>
          </div>

          <div>
            <h4 className="text-xs font-semibold uppercase tracking-normal text-zinc-400">Fundamentals</h4>
            <p className="mt-1 text-[11px] text-zinc-600">
              P/E, EPS, and Dividend use a verified Schwab Trader API value automatically when available
              {item.fundamentalAsOf ? ` (last verified ${shortDateTime(item.fundamentalAsOf)})` : ""}. PEG, Debt/Equity, and Current
              Ratio remain fully manual - Schwab does not provide them. Leave a field blank if unknown - a blank field displays as
              &quot;—&quot;, never as 0.
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <FundamentalInput
                name="manualPeRatio"
                label="P/E"
                value={resolveAutoOrManual(item.fundamentalPeRatio, item.manualPeRatio)}
                tip="Price divided by trailing earnings per share. Schwab can return a negative P/E when a company has negative (net loss) earnings - OSO shows that real negative number rather than hiding it, since it's meaningful (some other financial services instead show 'N/M' for this case). This field is a manual fallback only - Schwab's own verified value is used automatically when available."
              />
              <FundamentalInput
                name="manualPegRatio"
                label="PEG"
                value={resolveAutoOrManual(item.fundamentalPegRatio, item.manualPegRatio)}
                tip="P/E divided by expected earnings growth rate. Like P/E, a negative or zero value isn't meaningful (N/M). Fully manual - Schwab does not provide PEG."
              />
              <FundamentalInput
                name="manualDebtToEquity"
                label="Debt / Equity"
                value={resolveAutoOrManual(item.fundamentalDebtToEquity, item.manualDebtToEquity)}
                tip="Total liabilities divided by shareholder equity. Higher generally means more leverage/risk."
              />
              <FundamentalInput
                name="manualCurrentRatio"
                label="Current Ratio"
                value={resolveAutoOrManual(item.fundamentalCurrentRatio, item.manualCurrentRatio)}
                tip="Current assets divided by current liabilities. Above 1 generally means the company can cover near-term obligations."
              />
            </div>
            {numericOrNull(item.fundamentalEps) !== null ? (
              <div className="mt-2">
                <Datum label="EPS (Schwab Trader API)" value={numericOrNull(item.fundamentalEps)!.toFixed(2)} />
              </div>
            ) : null}
            <div className="mt-2">
              <FieldLabel>Dividend</FieldLabel>
              {numericOrNull(item.fundamentalDividendYield) !== null || numericOrNull(item.fundamentalDividendAmount) !== null ? (
                <p className="mt-1 text-[11px] text-zinc-600">
                  Schwab Trader API reports {money(numericOrNull(item.fundamentalDividendAmount) ?? 0)}/sh ·{" "}
                  {(numericOrNull(item.fundamentalDividendYield) ?? 0).toFixed(2)}% yield
                  {item.fundamentalAsOf ? ` (as of ${shortDateTime(item.fundamentalAsOf)})` : ""} - shown in the table above this
                  manual fallback. $0 / 0% is a real reported value (no dividend), not a missing one.
                </p>
              ) : null}
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <select
                  name="paysDividend"
                  defaultValue={item.paysDividend === true ? "YES" : item.paysDividend === false ? "NO" : ""}
                  className="min-h-9 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
                >
                  <option value="">Pays dividend? Unknown</option>
                  <option value="YES">Pays dividend: Yes</option>
                  <option value="NO">Pays dividend: No</option>
                </select>
                <input
                  name="manualDividendYield"
                  type="number"
                  step="0.01"
                  defaultValue={numericOrNull(resolveAutoOrManual(item.fundamentalDividendYield, item.manualDividendYield)) ?? ""}
                  placeholder="Yield %"
                  className="min-h-9 w-24 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
                />
                <input
                  name="manualDividendAmount"
                  type="number"
                  step="0.01"
                  defaultValue={numericOrNull(resolveAutoOrManual(item.fundamentalDividendAmount, item.manualDividendAmount)) ?? ""}
                  placeholder="Amount $/sh"
                  className="min-h-9 w-28 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
                />
              </div>
            </div>
            <div className="mt-2">
              <FieldLabel>
                Profitability
                <InfoTip label="Profitability" align="start" testId="help-research-profitability">
                  Are they profitable over the past several years? A structured judgment call, not derived from a single year&apos;s EPS -
                  OSO doesn&apos;t have a verified multi-year financial-statements source yet.
                </InfoTip>
              </FieldLabel>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <select
                  name="profitability"
                  defaultValue={item.profitability}
                  className="min-h-9 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
                >
                  <option value="UNKNOWN">Unknown</option>
                  <option value="PROFITABLE">Profitable</option>
                  <option value="MIXED">Mixed</option>
                  <option value="UNPROFITABLE">Unprofitable</option>
                </select>
                <input
                  name="profitabilityNote"
                  defaultValue={item.profitabilityNote ?? ""}
                  placeholder="e.g. Profitable 4 of last 5 years"
                  className="min-h-9 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
                />
              </div>
            </div>
          </div>

          <div>
            <h4 className="text-xs font-semibold uppercase tracking-normal text-zinc-400">External Research (manual)</h4>
            <p className="mt-1 text-[11px] text-zinc-600">Manual · your own read of Schwab/LSEG research. OSO does not fetch or scrape these.</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <input
                name="manualSchwabGrade"
                defaultValue={item.manualSchwabGrade ?? ""}
                placeholder="Schwab rating"
                className="min-h-9 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
              />
              <select
                name="manualLsegRecommendation"
                defaultValue={item.manualLsegRecommendation}
                className="min-h-9 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
              >
                <option value="UNKNOWN">LSEG recommendation: Unknown</option>
                <option value="BUY">LSEG recommendation: Buy</option>
                <option value="HOLD">LSEG recommendation: Hold</option>
                <option value="SELL">LSEG recommendation: Sell</option>
              </select>
              <input
                name="manualLsegRating"
                defaultValue={item.manualLsegRating ?? ""}
                placeholder="LSEG rating"
                className="min-h-9 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
              />
              <div className="flex items-center gap-1">
                <input
                  name="manualLsegTarget"
                  defaultValue={item.manualLsegTarget ?? ""}
                  placeholder="LSEG target price"
                  className="min-h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
                />
                <InfoTip label="LSEG target price" align="end" testId="help-research-lseg-target">
                  A manually-entered analyst target price from your own LSEG research. Not fetched automatically - OSO has no
                  authorized LSEG data feed.
                </InfoTip>
              </div>
            </div>
          </div>

          <div>
            <h4 className="text-xs font-semibold uppercase tracking-normal text-zinc-400">My Decision</h4>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <FieldLabel>
                Would I own this?
                <InfoTip label="Would own" align="start" testId="help-research-would-own">
                  Core cash-secured-put research: would you actually want to be assigned this stock? &quot;Only below $X&quot; records the
                  maximum price you&apos;d accept ownership at.
                </InfoTip>
              </FieldLabel>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <select name="wouldOwn" defaultValue={item.wouldOwn ?? ""} className="min-h-9 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100">
                <option value="">Not decided</option>
                <option value="YES">Yes</option>
                <option value="NO">No</option>
                <option value="CONDITIONAL">Only below $X</option>
              </select>
              <input
                name="wouldOwnMaxPrice"
                type="number"
                step="0.01"
                defaultValue={item.wouldOwnMaxPrice != null ? item.wouldOwnMaxPrice.toString() : ""}
                placeholder="Max price"
                className="min-h-9 w-28 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
              />
            </div>
            <div className="mt-2">
              <label className="flex min-h-9 items-center gap-2 text-sm text-zinc-300">
                <input type="checkbox" name="monthlyPutsOnly" defaultChecked={item.monthlyPutsOnly} className="size-3.5 accent-emerald-400" />
                Monthly puts only
              </label>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <select
                  name="rollFriendliness"
                  defaultValue={item.rollFriendliness}
                  className="min-h-9 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
                >
                  <option value="UNKNOWN">Roll friendliness: Unknown</option>
                  <option value="FRIENDLY">Roll friendliness: Friendly</option>
                  <option value="DIFFICULT">Roll friendliness: Difficult</option>
                </select>
                <input
                  name="rollFriendlinessNote"
                  defaultValue={item.rollFriendlinessNote ?? ""}
                  placeholder="Note (optional)"
                  className="min-h-9 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
                />
              </div>
              {item.researchStatus === "NEVER_TRADE" ? (
                <input
                  name="exclusionReason"
                  defaultValue={item.exclusionReason ?? ""}
                  placeholder="Why never trade this? (optional)"
                  className="mt-2 min-h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
                />
              ) : (
                <input type="hidden" name="exclusionReason" value={item.exclusionReason ?? ""} />
              )}
            </div>
          </div>

          <button type="submit" className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md bg-emerald-400 px-3 text-sm font-semibold text-black hover:bg-emerald-300">
            <Save className="size-3.5" aria-hidden />
            Save research details
          </button>
        </form>
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-normal text-zinc-400">Current Setup</h3>
          {scan ? (
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Datum label="Scanner" value={<ScannerChip score={scan.score} label={scan.label} />} />
              <Datum label="Price" value={scan.price != null ? money(scan.price) : dash()} />
              <Datum label="RSI" value={scan.rsi != null ? scan.rsi.toFixed(1) : dash()} />
              <Datum label="BB %" value={scan.bbPercent != null ? `${scan.bbPercent.toFixed(2)}%` : dash()} />
              {scan.companyDescription ? <Datum label="Company (Schwab)" value={scan.companyDescription} /> : null}
            </dl>
          ) : (
            <p className="mt-2 text-sm text-zinc-500">Not seen in the most recent scan run.</p>
          )}
          {scan ? <p className="mt-1 text-[11px] text-zinc-600">{sourceLabel(scan.source)} · Updated {shortDateTime(scan.asOf)}</p> : null}
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-normal text-zinc-400">Trade History</h3>
          {history ? (
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Datum label="Campaigns" value={String(history.count)} />
              <Datum label="Realized P/L" value={money(history.realizedPL)} />
              <Datum label="Rolls" value={String(history.rollCount)} />
              <Datum label="Assignments" value={String(history.assignmentCount)} />
            </dl>
          ) : (
            <p className="mt-2 text-sm text-zinc-500">No campaign history yet.</p>
          )}
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-normal text-zinc-400">My Notes / Past Experience</h3>
          <div className="mt-2 grid gap-3">
            <NoteEditor itemId={item.id} category="GENERAL" label="Notes / past experience" notes={generalNotes.map((note) => note.body)} />
            <NoteEditor itemId={item.id} category="PRO" label="Pro" notes={proNotes.map((note) => note.body)} />
            <NoteEditor itemId={item.id} category="CON" label="Con" notes={conNotes.map((note) => note.body)} />
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-normal text-zinc-400">Sharing</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            <form action={toggleWatchlistItemVisibilityAction}>
              <input type="hidden" name="itemId" value={item.id} />
              <button type="submit" className="inline-flex min-h-9 items-center gap-2 rounded-md border border-zinc-700 px-2.5 text-xs text-zinc-300 hover:border-zinc-500">
                {item.visibility === "PRIVATE" ? <Eye className="size-3.5" aria-hidden /> : <EyeOff className="size-3.5" aria-hidden />}
                {item.visibility === "PRIVATE" ? "Share" : "Make private"}
              </button>
            </form>
            <form action={removeWatchlistItemAction}>
              <input type="hidden" name="itemId" value={item.id} />
              <button type="submit" className="inline-flex min-h-9 items-center gap-2 rounded-md border border-zinc-700 px-2.5 text-xs text-zinc-300 hover:border-red-400/60 hover:text-red-200">
                <Trash2 className="size-3.5" aria-hidden />
                Remove
              </button>
            </form>
          </div>
        </div>

        <details>
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-normal text-zinc-400">Recommend to buddy</summary>
          <form action={recommendStockAction} className="mt-2 space-y-2">
            <input type="hidden" name="ticker" value={item.ticker} />
            <input type="hidden" name="returnTo" value="/research" />
            <select name="recipientId" className="min-h-9 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100">
              {buddies.map((buddy) => (
                <option key={buddy.id} value={buddy.id}>
                  {buddy.name}
                </option>
              ))}
            </select>
            <div className="grid grid-cols-2 gap-2">
              {RECOMMENDATION_REASON_TAGS.slice(0, 4).map((tag) => (
                <label key={tag} className="flex min-h-8 items-center gap-2 rounded-md border border-zinc-800 px-2 text-xs text-zinc-300">
                  <input type="checkbox" name="reasonTags" value={tag} className="size-3.5 accent-emerald-400" />
                  <span>{tag}</span>
                </label>
              ))}
            </div>
            <button type="submit" className="inline-flex min-h-9 w-full items-center justify-center gap-2 rounded-md bg-emerald-400 px-3 text-sm font-semibold text-black hover:bg-emerald-300">
              <Send className="size-3.5" aria-hidden />
              Recommend
            </button>
          </form>
        </details>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-normal text-zinc-400">Buddy comments</h3>
          <form action={addWatchlistCommentAction} className="mt-2 flex gap-2">
            <input type="hidden" name="itemId" value={item.id} />
            <input name="body" placeholder="Comment" className="min-h-9 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm" />
            <button type="submit" className="inline-flex min-h-9 items-center justify-center rounded-md border border-zinc-700 px-2.5 text-zinc-300 hover:border-zinc-500" aria-label={`Comment on ${item.ticker}`}>
              <MessageCircle className="size-3.5" aria-hidden />
            </button>
          </form>
          <form action={addReactionAction} className="mt-2">
            <input type="hidden" name="targetType" value="WATCHLIST_ITEM" />
            <input type="hidden" name="targetId" value={item.id} />
            <button type="submit" className="inline-flex min-h-8 items-center gap-2 rounded-md border border-zinc-700 px-2.5 text-xs text-zinc-300 hover:border-emerald-400/60 hover:text-emerald-200">
              <ThumbsUp className="size-3.5" aria-hidden />
              Atta Boy
            </button>
          </form>
          {item.comments.length ? (
            <div className="mt-2 space-y-2">
              {item.comments.map((comment) => (
                <div key={comment.id} className="rounded-md border border-zinc-800 bg-zinc-900 p-2 text-sm">
                  <div className="font-medium text-zinc-200">{comment.author.name}</div>
                  <div className="mt-1 text-zinc-400">{comment.body}</div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function FundamentalInput({ name, label, value, tip }: { name: string; label: string; value: unknown; tip: string }) {
  return (
    <label className="text-xs text-zinc-400">
      <span className="mb-1 flex items-center gap-1">
        {label}
        <InfoTip label={label} align="start" testId={`help-research-${name}`}>
          {tip}
        </InfoTip>
      </span>
      <input
        name={name}
        type="number"
        step="0.01"
        defaultValue={numericOrNull(value) ?? ""}
        className="min-h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
      />
    </label>
  );
}

function NoteEditor({ itemId, category, label, notes }: { itemId: string; category: "PRO" | "CON" | "GENERAL"; label: string; notes: string[] }) {
  return (
    <form action={saveStockNoteAction} className="space-y-1.5">
      <input type="hidden" name="itemId" value={itemId} />
      <input type="hidden" name="category" value={category} />
      <FieldLabel>{label}</FieldLabel>
      <div className="flex gap-2">
        <textarea name="body" defaultValue={notes.join("\n")} className="min-h-14 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100" />
        <button type="submit" className="inline-flex min-h-9 items-center justify-center self-start rounded-md border border-zinc-700 px-2.5 text-zinc-300 hover:border-zinc-500" aria-label={`Save ${label} note`}>
          <Save className="size-3.5" aria-hidden />
        </button>
      </div>
    </form>
  );
}

function Datum({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-normal text-zinc-500">{label}</dt>
      <dd className="mt-1 font-medium text-zinc-100">{value}</dd>
    </div>
  );
}

function StatusChip({ status }: { status: ResearchItemRecord["researchStatus"] }) {
  const tone =
    status === "LIKE"
      ? "border-emerald-400/40 bg-emerald-400/15 text-emerald-100"
      : status === "WATCH"
        ? "border-sky-400/40 bg-sky-400/15 text-sky-100"
        : status === "AVOID"
          ? "border-amber-400/40 bg-amber-400/15 text-amber-100"
          : status === "NEVER_TRADE"
            ? "border-red-400/30 bg-red-400/10 text-red-200/80"
            : "border-zinc-600 bg-zinc-800 text-zinc-300";
  const label = status === "NEVER_TRADE" ? "EXCLUDED" : status;

  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${tone}`}>
      {status === "LIKE" ? <Star className="size-3" aria-hidden /> : null}
      {label}
    </span>
  );
}

function ScannerChip({ score, label }: { score: number; label: string }) {
  const tone =
    label === "Verify"
      ? "border-zinc-600 bg-zinc-800 text-zinc-300"
      : label === "Fails" || score < 45
        ? "border-red-400/40 bg-red-400/15 text-red-100"
        : score >= 90
          ? "border-emerald-400/40 bg-emerald-400/15 text-emerald-100"
          : score >= 78
            ? "border-sky-400/40 bg-sky-400/15 text-sky-100"
            : "border-amber-400/40 bg-amber-400/15 text-amber-100";

  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${tone}`}>
      {score} · {label}
    </span>
  );
}

function renderResearchCell(
  key: string,
  item: ResearchItemRecord,
  scan: ResearchScanSnapshot | undefined,
  history: ResearchCampaignSummary | undefined,
) {
  switch (key) {
    case "company": {
      const autoCompany = scan?.companyDescription ?? null;
      const value = resolveAutoOrManual(autoCompany, item.companyName);
      return value ? (
        <span className="block max-w-[200px] truncate" title={autoCompany ? "Schwab Trader API" : "Manual entry"}>
          {value}
        </span>
      ) : (
        dash()
      );
    }
    case "currentPrice":
      return scan?.price != null ? (
        <span title={`${sourceLabel(scan.source)} · Updated ${shortDateTime(scan.asOf)}`}>{money(scan.price)}</span>
      ) : (
        dash()
      );
    case "industry":
      return item.whatItDoes ? (
        <span className="block max-w-[220px] truncate" title={item.whatItDoes}>
          {item.whatItDoes}
        </span>
      ) : (
        dash()
      );
    case "scanner":
      return scan ? <ScannerChip score={scan.score} label={scan.label} /> : dash();
    case "rsiBb":
      return scan ? (
        <span>
          {scan.rsi != null ? scan.rsi.toFixed(1) : "—"} / {scan.bbPercent != null ? `${scan.bbPercent.toFixed(1)}%` : "—"}
        </span>
      ) : (
        dash()
      );
    case "schwabRating":
      return manualCell(item.manualSchwabGrade);
    case "lsegRecommendation":
      return lsegRecommendationChip(item.manualLsegRecommendation);
    case "lsegRating":
      return manualCell(item.manualLsegRating);
    case "lsegTarget":
      return manualCell(item.manualLsegTarget);
    case "debtToEquity":
      return ratioCell(resolveAutoOrManual(item.fundamentalDebtToEquity, item.manualDebtToEquity), { allowZero: true });
    case "currentRatio":
      return ratioCell(resolveAutoOrManual(item.fundamentalCurrentRatio, item.manualCurrentRatio), { allowZero: true });
    case "peRatio":
      return peRatioCell(item.fundamentalPeRatio, item.manualPeRatio);
    case "eps":
      return epsCell(item.fundamentalEps);
    case "pegRatio":
      return ratioCell(resolveAutoOrManual(item.fundamentalPegRatio, item.manualPegRatio), { allowZero: false });
    case "dividend":
      return dividendCell(item, scan);
    case "profitability":
      return profitabilityChip(item.profitability, item.profitabilityNote);
    case "wouldOwn":
      return wouldOwnText(item);
    case "monthlyOnly":
      return item.monthlyPutsOnly ? "Yes" : dash();
    case "rollFriendliness":
      return rollFriendlinessText(item.rollFriendliness);
    case "notes":
      return notesPreview(item);
    case "campaignHistory":
      return history ? `${history.count} · ${money(history.realizedPL)}` : dash();
    default:
      return dash();
  }
}

function manualCell(value: string | null) {
  return value ? <span title="Manual entry">{value}</span> : dash();
}

function ratioCell(value: unknown, options: { allowZero: boolean }) {
  const numeric = numericOrNull(value);
  if (numeric === null) {
    return dash();
  }
  if (!options.allowZero && numeric <= 0) {
    return (
      <span title="Not meaningful (zero or negative)" className="text-zinc-500">
        N/M
      </span>
    );
  }
  return <span title="Manual entry">{numeric.toFixed(2)}</span>;
}

/**
 * P/E is shown as its real, signed value whenever Schwab or a manual entry supplies one -
 * a negative P/E (from negative/loss earnings) is a genuine, meaningful data point, not
 * noise to hide. Only an exact 0 (never a value a real quote should produce) is treated as
 * not meaningful, matching the same convention already used for the other ratio fields.
 */
function peRatioCell(auto: unknown, manual: unknown) {
  const value = resolveAutoOrManual(numericOrNull(auto), numericOrNull(manual));
  if (value === null) {
    return dash();
  }
  if (value === 0) {
    return (
      <span title="Not meaningful (exactly zero)" className="text-zinc-500">
        N/M
      </span>
    );
  }
  return <span title={auto !== null && auto !== undefined ? "Schwab Trader API" : "Manual entry"}>{value.toFixed(2)}</span>;
}

/** EPS has no manual-entry counterpart - it's auto-only (Schwab Trader API) or absent. */
function epsCell(value: unknown) {
  const numeric = numericOrNull(value);
  return numeric === null ? dash() : <span title="Schwab Trader API">{numeric.toFixed(2)}</span>;
}

function dividendCell(item: ResearchItemRecord, scan?: ResearchScanSnapshot) {
  const autoYield = numericOrNull(item.fundamentalDividendYield);
  const autoAmount = numericOrNull(item.fundamentalDividendAmount);
  if (autoYield !== null || autoAmount !== null) {
    // Verified Schwab data exists (even if $0 / 0% - a real, confirmed "no dividend", not an
    // absence) - show it directly as the primary signal. This never writes to or overrides
    // the user's own manual paysDividend judgment, only changes what's displayed here.
    const paysBasedOnAuto = (autoAmount ?? 0) > 0 || (autoYield ?? 0) > 0;
    const freqSuffix = scan?.dividendFrequency != null ? ` · ${scan.dividendFrequency}x/yr` : "";
    return (
      <span title="Schwab Trader API">
        {paysBasedOnAuto ? "Yes" : "No"}
        {autoYield !== null ? ` · ${autoYield.toFixed(2)}%` : ""}
        {freqSuffix}
      </span>
    );
  }

  if (item.paysDividend === null || item.paysDividend === undefined) {
    return dash();
  }
  if (!item.paysDividend) {
    return "No";
  }
  const manualYield = numericOrNull(item.manualDividendYield);
  return (
    <span title="Manual entry">
      Yes{manualYield !== null ? ` · ${manualYield.toFixed(2)}%` : ""}
    </span>
  );
}

function profitabilityChip(value: ResearchItemRecord["profitability"], note?: string | null) {
  if (value === "UNKNOWN") {
    return dash();
  }
  const tone =
    value === "PROFITABLE"
      ? "border-emerald-400/40 bg-emerald-400/15 text-emerald-100"
      : value === "MIXED"
        ? "border-amber-400/40 bg-amber-400/15 text-amber-100"
        : "border-red-400/40 bg-red-400/15 text-red-100";
  return (
    <span title={note ?? undefined} className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${tone}`}>
      {value}
    </span>
  );
}

function lsegRecommendationChip(value: ResearchItemRecord["manualLsegRecommendation"]) {
  if (value === "UNKNOWN") {
    return dash();
  }
  const tone =
    value === "BUY"
      ? "border-emerald-400/40 bg-emerald-400/15 text-emerald-100"
      : value === "SELL"
        ? "border-red-400/40 bg-red-400/15 text-red-100"
        : "border-amber-400/40 bg-amber-400/15 text-amber-100";
  return (
    <span title="Manual entry" className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${tone}`}>
      {value}
    </span>
  );
}

function notesPreview(item: ResearchItemRecord) {
  if (!item.notes.length) {
    return dash();
  }
  const preview = item.notes.map((note) => note.body).join(" · ").slice(0, 80);
  return (
    <span title={preview} className="block max-w-[160px] truncate text-zinc-300">
      {item.notes.length} note{item.notes.length === 1 ? "" : "s"}
    </span>
  );
}

function wouldOwnText(item: ResearchItemRecord) {
  if (!item.wouldOwn) {
    return dash();
  }
  if (item.wouldOwn === "CONDITIONAL") {
    return item.wouldOwnMaxPrice != null ? `Below ${money(item.wouldOwnMaxPrice)}` : "Conditional";
  }
  return item.wouldOwn === "YES" ? "Yes" : "No";
}

function rollFriendlinessText(value: ResearchItemRecord["rollFriendliness"]) {
  if (value === "FRIENDLY") return "Friendly";
  if (value === "DIFFICULT") return "Difficult";
  return dash();
}

function sourceLabel(source: string) {
  return source === "LIVE:SCHWAB" ? "Schwab" : "Demo";
}

function numericOrNull(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return toNumber(value);
}

function dash() {
  return (
    <span title="Not entered yet" className="text-zinc-600">
      —
    </span>
  );
}
