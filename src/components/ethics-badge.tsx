"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { ETHICS_CATEGORY_LABELS, ethicsRatingLabel, type EthicsRating } from "@/domain/ethics/ethicalCompatibility";
import type { EthicsSummary } from "@/lib/ethics";

const RATING_CHIP: Record<EthicsRating, string> = {
  GREEN: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200",
  LIGHT_GREEN: "border-lime-400/40 bg-lime-400/10 text-lime-200",
  YELLOW: "border-amber-400/50 bg-amber-400/10 text-amber-200",
  RED: "border-red-400/50 bg-red-400/10 text-red-200",
  EXCLUDED: "border-red-500/60 bg-red-500/15 text-red-100",
  UNREVIEWED: "border-zinc-700 bg-zinc-900 text-zinc-500",
};

/** What the chip itself says: the score, "EX" for excluded, "?" when nothing has been researched yet. */
function chipText(summary: EthicsSummary | undefined): string {
  if (!summary) return "?";
  if (summary.gate === "BLOCKED") return "EX";
  if (summary.score === null) return "?";
  // A leading ~ marks a score that rests on unverified evidence ("no concerns found yet", not "verified acceptable").
  return summary.verified ? String(summary.score) : `~${summary.score}`;
}

/**
 * Compact, color-coded ethical-compatibility chip with a click-to-expand panel (categories, confidence, Matt's
 * decision) and a link to the evidence page. Evidence confidence is shown separately from the score. An unresearched
 * company shows a grey "?" - never green - so "not reviewed" is always visible.
 */
export function EthicsBadge({ ticker, summary }: { ticker: string; summary: EthicsSummary | undefined }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") setOpen(false);
        return;
      }
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const rating: EthicsRating = summary?.gate === "BLOCKED" ? "EXCLUDED" : (summary?.rating ?? "UNREVIEWED");
  const label = summary ? `${ethicsRatingLabel(rating, summary)}${summary.decision === "APPROVED" ? " (approved by you)" : ""}` : "Not yet reviewed";

  return (
    <span ref={rootRef} className="relative inline-flex" onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Ethical compatibility for ${ticker}: ${label}`}
        title={`Ethics: ${label}`}
        data-testid={`ethics-badge-${ticker}`}
        data-rating={rating}
        className={`inline-flex min-w-7 items-center justify-center rounded-md border px-1 py-0.5 text-[11px] font-semibold leading-none ${RATING_CHIP[rating]}`}
      >
        {chipText(summary)}
        {summary?.gate === "REVIEW" ? <span aria-hidden className="ml-0.5 text-[9px]">!</span> : null}
      </button>
      {open ? (
        <div id={panelId} role="dialog" aria-label={`Ethical compatibility: ${ticker}`} className="absolute left-0 top-full z-30 mt-1 w-72 rounded-md border border-zinc-700 bg-zinc-950 p-3 text-left text-xs shadow-xl">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-semibold text-zinc-50">{ticker}</span>
            <span className={`rounded border px-1.5 py-0.5 text-[11px] font-semibold ${RATING_CHIP[rating]}`}>{label}</span>
          </div>
          {!summary ? (
            <p className="mt-2 text-zinc-400">Not researched yet. Ask Claude to research this company and import the result - it is saved, so it only has to be done once.</p>
          ) : (
            <>
              <p className="mt-1 text-zinc-400">
                Score {summary.score ?? "n/a"} / 100 · evidence confidence <strong className="text-zinc-200">{summary.confidence?.toLowerCase() ?? "n/a"}</strong>
                {summary.incomplete ? " · not every category reviewed" : summary.verified ? " · verified from primary sources" : " · not independently verified"}
              </p>
              {summary.summary ? <p className="mt-1 text-zinc-300">{summary.summary}</p> : null}
              {summary.recheckNeeded ? <p className="mt-1 text-amber-300">{summary.recheckReason ?? "Needs a second look."}</p> : null}
              {summary.reviewDue ? <p className="mt-1 text-amber-300">Research is due to be refreshed.</p> : null}
              <ul className="mt-2 space-y-0.5">
                {summary.assessments.map((a) => (
                  <li key={a.category} className="flex justify-between gap-2">
                    <span className="text-zinc-400">{ETHICS_CATEGORY_LABELS[a.category]}</span>
                    <span className={a.level === "NONE" || a.level === "INCIDENTAL" ? "text-zinc-300" : "font-medium text-amber-200"}>
                      {a.level.toLowerCase()}
                      {a.revenueSharePercent != null ? ` (~${a.revenueSharePercent}%)` : ""} · {a.confidence.toLowerCase()}
                    </span>
                  </li>
                ))}
              </ul>
              {summary.decision ? <p className="mt-2 text-zinc-300">Your decision: <strong>{summary.decision.replace("_", " ").toLowerCase()}</strong></p> : null}
            </>
          )}
          <Link href={`/research/ethics?ticker=${encodeURIComponent(ticker)}`} className="mt-2 inline-block text-sky-300 underline underline-offset-2 hover:text-sky-200">
            {summary ? "Evidence and your decision" : "Open Ethics"}
          </Link>
        </div>
      ) : null}
    </span>
  );
}
