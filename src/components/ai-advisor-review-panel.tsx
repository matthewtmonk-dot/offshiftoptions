"use client";

import { useState, useTransition } from "react";
import { Sparkles } from "lucide-react";
import { Badge } from "@/components/ui";
import { requestAiAdvisorReviewAction } from "@/app/(app)/ai-advisor-actions";
import type { AiAdvisorReviewResult } from "@/domain/scanner/aiAdvisorReview";
import { shortDateTime } from "@/lib/format";

type AiAdvisorReview = AiAdvisorReviewResult;

type RuleFinding = { ruleId: string; explanation: string };

type AiAdvisorState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; review: AiAdvisorReview; ticker: string; evaluatedAt: string; unknownHardRules: RuleFinding[] };

const decisionTone: Record<AiAdvisorReview["decision"], "good" | "warn" | "neutral" | "info"> = {
  CONSIDER: "good",
  WATCH: "warn",
  PASS: "neutral",
  INSUFFICIENT_DATA: "info",
};

const decisionLabel: Record<AiAdvisorReview["decision"], string> = {
  CONSIDER: "CONSIDER",
  WATCH: "WATCH",
  PASS: "PASS",
  INSUFFICIENT_DATA: "INSUFFICIENT DATA",
};

function BulletList({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-1 space-y-1 text-[13px] text-zinc-300">
      {items.map((item, index) => (
        <li key={index} className="flex gap-1.5">
          <span className="text-zinc-600" aria-hidden>
            •
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * AI Advisor V1 - Scanner's "AI Review" trigger + inline result panel. Decision support only: the
 * UI never claims more authority than the deterministic scanner itself, and a hard LST rule failure
 * is always shown prominently regardless of what the model's own prose says (`hardRuleFailures`
 * comes back from the server already enforced to be the packet's own authoritative list - see
 * enforceHardRuleConsistency, domain/scanner/aiAdvisorReview.ts). A failed/unavailable AI call
 * never changes or hides any deterministic Scanner data on this page.
 */
export function AiAdvisorReviewPanel({ scanResultId }: { scanResultId: string }) {
  const [state, setState] = useState<AiAdvisorState>({ status: "idle" });
  const [isPending, startTransition] = useTransition();

  // isPending already prevents a duplicate request while one is in flight (the button is disabled
  // below), but this is an extra, explicit guard against a rapid double-click racing ahead of
  // React's own pending-state update.
  const requestInFlight = isPending || state.status === "loading";

  function handleClick() {
    if (requestInFlight) return;
    setState({ status: "loading" });
    startTransition(async () => {
      const outcome = await requestAiAdvisorReviewAction(scanResultId);
      if (outcome.ok) {
        setState({ status: "done", review: outcome.review, ticker: outcome.ticker, evaluatedAt: outcome.evaluatedAt, unknownHardRules: outcome.unknownHardRules });
      } else {
        setState({ status: "error", message: outcome.error });
      }
    });
  }

  if (state.status === "idle" || state.status === "error") {
    return (
      <div className="space-y-1.5">
        <button
          type="button"
          onClick={handleClick}
          disabled={requestInFlight}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 text-xs font-medium text-zinc-300 transition hover:border-sky-400/60 hover:text-sky-100 disabled:cursor-wait disabled:opacity-75"
        >
          <Sparkles className="size-3.5" aria-hidden />
          AI Review
        </button>
        {state.status === "error" ? <p className="text-xs text-zinc-500">{state.message}</p> : null}
      </div>
    );
  }

  if (state.status === "loading") {
    return (
      <button type="button" disabled className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 text-xs font-medium text-zinc-500 opacity-75">
        <Sparkles className="size-3.5 animate-pulse" aria-hidden />
        Reviewing…
      </button>
    );
  }

  const { review, ticker, evaluatedAt, unknownHardRules } = state;
  return (
    <div className="space-y-3 rounded-md border border-zinc-800 bg-zinc-900/60 p-3" data-testid="ai-advisor-review-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">AI Take</span>
          <Badge tone={decisionTone[review.decision]}>{decisionLabel[review.decision]}</Badge>
          <span className="text-xs text-zinc-500">· {review.confidence} confidence</span>
        </div>
        <button type="button" onClick={handleClick} disabled={requestInFlight} className="text-xs text-zinc-500 hover:text-sky-300 disabled:cursor-wait disabled:opacity-75">
          Re-run
        </button>
      </div>

      <p className="text-sm font-medium text-zinc-100">{review.headline}</p>
      <p className="text-[13px] text-zinc-400">{review.summary}</p>

      {review.strongestReasons.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Why</p>
          <BulletList items={review.strongestReasons} />
        </div>
      ) : null}

      {review.mainConcerns.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Watch</p>
          <BulletList items={review.mainConcerns} />
        </div>
      ) : null}

      {/* Hard rules are always shown, never only on failure - "All passed" is itself meaningful
          confirmation, and a real failure must never be visually smaller or less prominent than a
          deterministic Scanner badge elsewhere on this page. */}
      <div className={review.hardRuleFailures.length > 0 ? "rounded-md border border-red-400/40 bg-red-400/10 p-2" : ""}>
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Hard rules</p>
        {review.hardRuleFailures.length === 0 ? (
          <p className="mt-1 text-[13px] text-emerald-200">All passed</p>
        ) : (
          <ul className="mt-1 space-y-1 text-[13px] text-red-200">
            {review.hardRuleFailures.map((failure) => (
              <li key={failure.ruleId}>
                <span className="font-semibold">{failure.ruleId}:</span> {failure.explanation}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Companion to "Hard rules" above, same reliability guarantee - a hard rule that's UNKNOWN
          (missing/stale evidence on a gate) is a distinct finding from a FAIL, computed directly
          from the deterministic packet, never only from the model's own prose. Only rendered when
          non-empty - "All passed" above already covers the common, fully-known case. */}
      {unknownHardRules.length > 0 ? (
        <div className="rounded-md border border-sky-400/40 bg-sky-400/10 p-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Hard rules - unknown</p>
          <ul className="mt-1 space-y-1 text-[13px] text-sky-200">
            {unknownHardRules.map((finding) => (
              <li key={finding.ruleId}>
                <span className="font-semibold">{finding.ruleId}:</span> {finding.explanation}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {review.softPreferenceNotes.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Preference tradeoffs</p>
          <BulletList items={review.softPreferenceNotes} />
        </div>
      ) : null}

      {review.unknownCriticalEvidence.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Missing evidence</p>
          <BulletList items={review.unknownCriticalEvidence} />
        </div>
      ) : null}

      {review.whatWouldChangeDecision.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">What would change this</p>
          <BulletList items={review.whatWouldChangeDecision} />
        </div>
      ) : null}

      {review.riskNotes.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Risk notes</p>
          <BulletList items={review.riskNotes} />
        </div>
      ) : null}

      <div className="border-t border-zinc-800 pt-2 text-xs text-zinc-500">
        <p>
          Reviewed from OSO snapshot · {ticker} · {shortDateTime(evaluatedAt)}
        </p>
        <p className="mt-0.5">AI decision support - verify the trade before placing an order.</p>
      </div>
    </div>
  );
}
