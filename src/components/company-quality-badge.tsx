"use client";

import { useState, useTransition } from "react";
import { removeCompanyQualityReviewAction, saveCompanyQualityReviewAction } from "@/app/(app)/scanner/company-quality-actions";
import type { CompanyQualityTier } from "@/domain/scanner/companyQuality";

/** The slice of a cached reading this chip needs (structural, so it does not import the server-only module). */
export type CompanyQualityChipData = {
  status: "OK" | "NOT_FOUND" | "FAILED";
  tier: CompanyQualityTier | null;
  reasons: string[];
  runwayQuarters: number | null;
  fetchedAt: string;
  reviewed: { note: string; at: string } | null;
  gate: { eligible: boolean; label: string; reason: string } | null;
};

const CHIP: Record<string, string> = {
  A: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200",
  B: "border-lime-400/40 bg-lime-400/10 text-lime-200",
  CAUTION: "border-amber-400/50 bg-amber-400/10 text-amber-200",
  VERIFY: "border-amber-400/30 bg-zinc-900 text-amber-200",
  REJECT: "border-red-500/60 bg-red-500/15 text-red-100",
  NONE: "border-zinc-700 bg-zinc-900 text-zinc-500",
};

const MEANING: Record<string, string> = {
  A: "Positive free cash flow and no warning flags.",
  B: "Passes the minimum checks but has a caution flag (see below).",
  CAUTION: "Excluded from automatic picks unless you review it.",
  VERIFY: "The numbers can't be judged automatically (missing data, a bank or lender, or an unclear industry). Excluded unless you review it.",
  REJECT: "Clear distress. Cannot be overridden while it persists.",
};

/**
 * Company-quality chip (financial health from SEC filings) with a click-to-open panel: the reasons, and for a CAUTION or
 * VERIFY company a written "I've looked at this" that lets the allocation tool consider it. A REJECT cannot be overridden.
 * Shown only when the check is set up. Minimum financial health only - never a valuation or a recommendation.
 */
export function CompanyQualityBadge({ ticker, data }: { ticker: string; data: CompanyQualityChipData | undefined }) {
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const tier = data?.tier ?? null;
  const key = tier ?? "NONE";
  const text = data?.gate?.label.startsWith(tier ?? "?") && data?.reviewed ? `Q:${tier}*` : tier ? `Q:${tier}` : "Q?";
  const canReview = (tier === "CAUTION" || tier === "VERIFY") && !data?.reviewed;

  function save() {
    setMessage(null);
    startTransition(async () => {
      const result = await saveCompanyQualityReviewAction(ticker, note);
      setMessage(result.ok ? "Saved. This company can now be considered." : result.error);
      if (result.ok) setNote("");
    });
  }

  function remove() {
    setMessage(null);
    startTransition(async () => {
      const result = await removeCompanyQualityReviewAction(ticker);
      setMessage(result.ok ? "Review removed." : result.error);
    });
  }

  return (
    <details className="relative inline-block" data-testid={`company-quality-${ticker}`}>
      <summary
        className={`inline-flex cursor-pointer list-none items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold ${CHIP[key]}`}
        title="Company financial health from SEC filings. Click for details."
        aria-label={`Company quality for ${ticker}: ${tier ?? "not checked yet"}`}
      >
        {text}
      </summary>
      <div className="absolute left-0 z-30 mt-1 w-72 space-y-2 rounded-md border border-zinc-700 bg-zinc-950 p-2.5 text-left text-xs font-normal text-zinc-300 shadow-xl">
        {!data || tier === null ? (
          <p>Not checked yet. Use <strong>Check company quality</strong> above the list.</p>
        ) : (
          <>
            <p className="font-semibold text-zinc-100">Company quality {tier}</p>
            <p className="text-zinc-400">{MEANING[tier]}</p>
            <ul className="list-disc space-y-1 pl-4">
              {data.reasons.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
            {data.runwayQuarters !== null ? <p className="text-zinc-400">Stressed cash runway: about {data.runwayQuarters.toFixed(1)} quarters.</p> : null}
            <p className="text-zinc-500">From SEC filings, checked {data.fetchedAt ? new Date(data.fetchedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "never"}. Minimum financial health only - not a valuation and not a recommendation.</p>
            {data.reviewed ? (
              <div className="rounded border border-emerald-400/30 bg-emerald-400/5 p-2">
                <p className="font-medium text-emerald-200">You reviewed this</p>
                <p className="mt-0.5 text-zinc-300">{data.reviewed.note}</p>
                <button type="button" onClick={remove} disabled={pending} className="mt-1 underline underline-offset-2 hover:text-zinc-100 disabled:opacity-50">
                  Remove my review
                </button>
              </div>
            ) : null}
            {canReview ? (
              <div className="space-y-1">
                <label className="block text-zinc-400" htmlFor={`q-note-${ticker}`}>
                  I&apos;ve looked at this. Why am I comfortable? (required)
                </label>
                <textarea
                  id={`q-note-${ticker}`}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  rows={3}
                  maxLength={600}
                  className="w-full rounded border border-zinc-700 bg-zinc-900 p-1.5 text-zinc-100"
                />
                <button
                  type="button"
                  onClick={save}
                  disabled={pending || note.trim().length < 10}
                  className="rounded border border-sky-400/40 bg-sky-400/10 px-2 py-1 text-sky-100 hover:border-sky-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Save my review
                </button>
              </div>
            ) : null}
            {tier === "REJECT" ? <p className="text-red-200">This cannot be overridden.</p> : null}
          </>
        )}
        {message ? <p className="text-amber-200">{message}</p> : null}
      </div>
    </details>
  );
}
