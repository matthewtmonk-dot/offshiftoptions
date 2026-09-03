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
import { RECOMMENDATION_REASON_TAGS } from "@/domain/social/recommendations";
import { money, percent } from "@/lib/format";
import {
  addReactionAction,
  addWatchlistCommentAction,
  addWatchlistItemAction,
  recommendStockAction,
  removeWatchlistItemAction,
  saveStockNoteAction,
  setResearchStatusAction,
  toggleWatchlistItemVisibilityAction,
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
type SortKey = "added" | "ticker" | "score" | "price";
type OptionalColumnKey = "wouldOwn" | "monthlyOnly" | "rollFriendliness" | "grades" | "history";
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

const sortOptions: { key: SortKey; label: string }[] = [
  { key: "added", label: "Recently added" },
  { key: "ticker", label: "Ticker" },
  { key: "score", label: "Scanner score" },
  { key: "price", label: "Price" },
];

const optionalColumns: { key: OptionalColumnKey; label: string }[] = [
  { key: "wouldOwn", label: "Would own" },
  { key: "monthlyOnly", label: "Monthly only" },
  { key: "rollFriendliness", label: "Roll friendliness" },
  { key: "grades", label: "Manual grades" },
  { key: "history", label: "Trade history" },
];

export function ResearchWorkspace({
  items,
  buddyItems,
  buddies,
  scanByTicker,
  campaignByTicker,
  error,
}: {
  items: ResearchItemRecord[];
  buddyItems: ResearchBuddyItemRecord[];
  buddies: ResearchBuddy[];
  scanByTicker: Record<string, ResearchScanSnapshot>;
  campaignByTicker: Record<string, ResearchCampaignSummary>;
  error?: string;
}) {
  const [status, setStatus] = useState<StatusKey>("all");
  const [optimisticStatuses, setOptimisticStatuses] = useState<Record<string, ResearchStatusOverride | undefined>>({});
  const [pendingStatuses, setPendingStatuses] = useState<Record<string, ResearchStatusChoice | undefined>>({});
  const [statusError, setStatusError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("added");
  const [columns, setColumns] = useState<Record<OptionalColumnKey, boolean>>({
    wouldOwn: false,
    monthlyOnly: false,
    rollFriendliness: false,
    grades: false,
    history: false,
  });
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

  const activeColumns = optionalColumns.filter((column) => columns[column.key]);
  const columnCount = 6 + activeColumns.length;

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
        <h1 className="text-2xl font-semibold text-zinc-50">Research</h1>
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
            onChange={(event) => setSort(event.target.value as SortKey)}
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

        <details className="group relative">
          <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 text-xs font-medium text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-50">
            Columns
            <ChevronDown className="size-3.5" aria-hidden />
          </summary>
          <div className="absolute left-0 top-full z-10 mt-1 w-52 space-y-1 rounded-md border border-zinc-800 bg-zinc-900 p-2 shadow-lg shadow-black/30">
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
      </div>

      <div className="hidden overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950/60 lg:block" data-testid="research-desktop-table">
        <table className="w-full min-w-[900px] border-separate border-spacing-0 text-left text-xs">
          <thead>
            <tr className="text-[11px] uppercase tracking-normal text-zinc-500">
              <th className="border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">Status</th>
              <th className="border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">Ticker</th>
              <th className="border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">Company</th>
              <th className="border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">Scanner</th>
              <th className="border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">Price</th>
              <th className="border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">RSI / BB</th>
              {activeColumns.map((column) => (
                <th key={column.key} className="border-b border-zinc-800 bg-zinc-900/60 px-3 py-2">
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
              return (
                <Fragment key={item.id}>
                  <tr onClick={() => toggleExpanded(item.id)} className="cursor-pointer transition hover:bg-zinc-900/55">
                    <td className="border-b border-zinc-900 px-3 py-2">
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
                    <td className="border-b border-zinc-900 px-3 py-2">
                      <span className="text-sm font-semibold text-zinc-50">{item.ticker}</span>
                      {item.visibility === "SHARED" ? <Eye className="ml-1.5 inline size-3 text-sky-400" aria-hidden /> : null}
                    </td>
                    <td className="max-w-[200px] truncate border-b border-zinc-900 px-3 py-2 text-zinc-300">{item.companyName ?? dash()}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">{scan ? <ScannerChip score={scan.score} label={scan.label} /> : dash()}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">{scan?.price != null ? money(scan.price) : dash()}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">
                      {scan?.rsi != null ? scan.rsi.toFixed(1) : dash()} / {scan?.bbPercent != null ? percent(scan.bbPercent) : dash()}
                    </td>
                    {activeColumns.map((column) => (
                      <td key={column.key} className="border-b border-zinc-900 px-3 py-2">
                        {column.key === "wouldOwn" ? wouldOwnText(item) : null}
                        {column.key === "monthlyOnly" ? (item.monthlyPutsOnly ? "Yes" : dash()) : null}
                        {column.key === "rollFriendliness" ? rollFriendlinessText(item.rollFriendliness) : null}
                        {column.key === "grades" ? item.manualSchwabGrade || item.manualLsegRating || dash() : null}
                        {column.key === "history" ? (history ? `${history.count} · ${money(history.realizedPL)}` : dash()) : null}
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

      {buddyItems.length ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-normal text-zinc-400">Buddy Shared Research</h2>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {buddyItems.map((item) => (
              <div key={item.id} className="rounded-md border border-zinc-800 bg-zinc-900 p-2.5 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-zinc-50">{item.ticker}</span>
                  <StatusChip status={item.researchStatus} />
                </div>
                <div className="mt-1 text-xs text-zinc-500">{item.owner.name}&apos;s view</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
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
          {scan ? <ScannerChip score={scan.score} label={scan.label} /> : null}
        </div>
        <div className="text-xs text-zinc-400">{item.companyName ?? "Company name not entered yet"}</div>
        <div className="grid grid-cols-3 gap-x-2 text-xs">
          <MobileDatum label="Price" value={scan?.price != null ? money(scan.price) : dash()} />
          <MobileDatum label="RSI" value={scan?.rsi != null ? scan.rsi.toFixed(1) : dash()} />
          <MobileDatum label="BB %" value={scan?.bbPercent != null ? percent(scan.bbPercent) : dash()} />
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

function MobileDatum({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-normal text-zinc-500">{label}</dt>
      <dd className="font-medium text-zinc-100">{value}</dd>
    </div>
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
  const canEdit = true;

  return (
    <div className="grid gap-5 rounded-md border border-zinc-800 bg-zinc-950 p-4 xl:grid-cols-[1fr_1fr_0.8fr]">
      <section className="space-y-4">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-normal text-zinc-400">Status</h3>
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

        <form action={updateResearchDetailsAction} className="space-y-3">
          <input type="hidden" name="itemId" value={item.id} />
          <div>
            <FieldLabel>What is this? (company / business)</FieldLabel>
            <input
              name="companyName"
              defaultValue={item.companyName ?? ""}
              placeholder="Company name"
              className="mt-1 min-h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
            />
            <textarea
              name="whatItDoes"
              defaultValue={item.whatItDoes ?? ""}
              placeholder="What does this company actually do?"
              className="mt-2 min-h-16 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-2 text-sm text-zinc-100"
            />
          </div>

          <div>
            <FieldLabel>Would I own this?</FieldLabel>
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
          </div>

          <div>
            <FieldLabel>Any special rule?</FieldLabel>
            <label className="mt-1 flex min-h-9 items-center gap-2 text-sm text-zinc-300">
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

          <div>
            <FieldLabel>Is the company financially healthy? (manual)</FieldLabel>
            <div className="mt-1 grid grid-cols-2 gap-2">
              <input
                name="manualSchwabGrade"
                defaultValue={item.manualSchwabGrade ?? ""}
                placeholder="Schwab grade"
                className="min-h-9 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
              />
              <input
                name="manualLsegRating"
                defaultValue={item.manualLsegRating ?? ""}
                placeholder="LSEG rating"
                className="min-h-9 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
              />
              <input
                name="manualLsegScore"
                defaultValue={item.manualLsegScore ?? ""}
                placeholder="LSEG score"
                className="min-h-9 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
              />
              <input
                name="manualLsegTarget"
                defaultValue={item.manualLsegTarget ?? ""}
                placeholder="LSEG target"
                className="min-h-9 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100"
              />
            </div>
            <p className="mt-1 text-xs text-zinc-600">
              Verified auto-fetched fundamentals (P/E, PEG, D/E, etc.) aren&apos;t populated yet - see PROJECT_HANDOFF.md Research section.
            </p>
          </div>

          <button type="submit" className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md bg-emerald-400 px-3 text-sm font-semibold text-black hover:bg-emerald-300">
            <Save className="size-3.5" aria-hidden />
            Save research details
          </button>
        </form>
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-normal text-zinc-400">Current setup</h3>
          {scan ? (
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Datum label="Scanner" value={<ScannerChip score={scan.score} label={scan.label} />} />
              <Datum label="Price" value={scan.price != null ? money(scan.price) : dash()} />
              <Datum label="RSI" value={scan.rsi != null ? scan.rsi.toFixed(1) : dash()} />
              <Datum label="BB %" value={scan.bbPercent != null ? percent(scan.bbPercent) : dash()} />
            </dl>
          ) : (
            <p className="mt-2 text-sm text-zinc-500">Not seen in the most recent scan run.</p>
          )}
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-normal text-zinc-400">What I&apos;ve done with this stock</h3>
          {history ? (
            <dl className="mt-2 grid grid-cols-3 gap-x-4 gap-y-2 text-sm">
              <Datum label="Campaigns" value={String(history.count)} />
              <Datum label="Realized P/L" value={money(history.realizedPL)} />
              <Datum label="Rolls" value={String(history.rollCount)} />
            </dl>
          ) : (
            <p className="mt-2 text-sm text-zinc-500">No campaign history yet.</p>
          )}
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-normal text-zinc-400">What I&apos;ve learned</h3>
          <div className="mt-2 grid gap-3">
            <NoteEditor itemId={item.id} category="PRO" label="Pro" notes={proNotes.map((note) => note.body)} />
            <NoteEditor itemId={item.id} category="CON" label="Con" notes={conNotes.map((note) => note.body)} />
            <NoteEditor itemId={item.id} category="GENERAL" label="General" notes={generalNotes.map((note) => note.body)} />
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-normal text-zinc-400">Sharing</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {canEdit ? (
              <>
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
              </>
            ) : null}
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

function dash() {
  return (
    <span title="Not entered yet" className="text-zinc-600">
      —
    </span>
  );
}
