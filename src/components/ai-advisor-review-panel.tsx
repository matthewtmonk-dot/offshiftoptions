"use client";

import { useState, useTransition } from "react";
import { Sparkles } from "lucide-react";
import { Badge } from "@/components/ui";
import { requestAiAdvisorReviewAction } from "@/app/(app)/ai-advisor-actions";
import {
  hardRuleSummaryLabel,
  hardRuleSummaryState,
  resolveAiAdvisorPresentation,
  scannerReadinessPresentation,
  type AiAdvisorReviewResult,
  type AiAdvisorReviewSource,
} from "@/domain/scanner/aiAdvisorReview";
import { shortDateTime } from "@/lib/format";

type AiAdvisorReview = AiAdvisorReviewResult;

type RuleFinding = { ruleId: string; explanation: string };

type AiAdvisorState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "done";
      review: AiAdvisorReview;
      reviewSource: AiAdvisorReviewSource;
      scannerReadiness: string;
      ticker: string;
      evaluatedAt: string;
      unknownHardRules: RuleFinding[];
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
 * UI never claims more authority than the deterministic scanner itself.
 *
 * Final guardrail repair: the deterministic Scanner readiness chip is ALWAYS shown beside the AI/
 * gate result (never only the AI's own badge) - a green CONSIDER is only ever shown when Scanner
 * readiness itself is PASS (see resolveAiAdvisorPresentation); a soft-preference-driven Scanner FAIL
 * with an otherwise-interested model renders as amber "CONSIDER WITH TRADEOFFS", never a plain green
 * CONSIDER. When `reviewSource` is a hard-rule gate (no OpenAI call was made at all - decided purely
 * by deterministic code), the panel labels the result "LST GATE", never "AI Take", so it can never
 * be mistaken for a completed AI model review. The single "Hard rules" summary box always reads
 * exactly one of FAILED / UNKNOWN / ALL PASSED (hardRuleSummaryState) - it can never say "All
 * passed" while a hard rule is still UNKNOWN.
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
        setState({
          status: "done",
          review: outcome.review,
          reviewSource: outcome.reviewSource,
          scannerReadiness: outcome.scannerReadiness,
          ticker: outcome.ticker,
          evaluatedAt: outcome.evaluatedAt,
          unknownHardRules: outcome.unknownHardRules,
        });
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

  const { review, reviewSource, scannerReadiness, ticker, evaluatedAt, unknownHardRules } = state;
  const isDeterministicGate = reviewSource !== "MODEL";
  const presentation = resolveAiAdvisorPresentation({ decision: review.decision, reviewSource, scannerReadiness });
  const scannerChip = scannerReadinessPresentation(scannerReadiness);
  const hardState = hardRuleSummaryState(review.hardRuleFailures.length, unknownHardRules.length);
  // A hard-rule gate's own mainConcerns/unknownCriticalEvidence are just the same rule explanations
  // already rendered in the "Hard rules" box below - hidden here to avoid showing the identical
  // evidence twice under two different headings.
  const showMainConcerns = reviewSource !== "HARD_RULE_GATE";
  const showUnknownCriticalEvidence = reviewSource !== "HARD_UNKNOWN_GATE";

  return (
    <div className="space-y-3 rounded-md border border-zinc-800 bg-zinc-900/60 p-3" data-testid="ai-advisor-review-panel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Scanner</span>
            <Badge tone={scannerChip.tone}>{scannerChip.label}</Badge>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{isDeterministicGate ? "LST Gate" : "AI Take"}</span>
            <Badge tone={presentation.tone}>{presentation.label}</Badge>
            {!isDeterministicGate ? <span className="text-xs text-zinc-500">· {review.confidence} confidence</span> : null}
          </div>
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

      {showMainConcerns && review.mainConcerns.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Watch</p>
          <BulletList items={review.mainConcerns} />
        </div>
      ) : null}

      {/* The ONE hard-rule summary box - exactly FAILED / UNKNOWN / ALL PASSED, never "All passed"
          while a hard rule is still UNKNOWN (hardRuleSummaryState, aiAdvisorReview.ts). A real
          failure or unknown must never be visually smaller or less prominent than a deterministic
          Scanner badge elsewhere on this page. */}
      <div
        className={
          hardState === "FAILED"
            ? "rounded-md border border-red-400/40 bg-red-400/10 p-2"
            : hardState === "UNKNOWN"
              ? "rounded-md border border-sky-400/40 bg-sky-400/10 p-2"
              : "rounded-md border border-zinc-800 p-2"
        }
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{hardRuleSummaryLabel(hardState)}</p>
        {hardState === "ALL_PASSED" ? (
          <p className="mt-1 text-[13px] text-emerald-200">All known hard LST rules passed.</p>
        ) : hardState === "FAILED" ? (
          <ul className="mt-1 space-y-1 text-[13px] text-red-200">
            {review.hardRuleFailures.map((failure) => (
              <li key={failure.ruleId}>
                <span className="font-semibold">{failure.ruleId}:</span> {failure.explanation}
              </li>
            ))}
          </ul>
        ) : (
          <ul className="mt-1 space-y-1 text-[13px] text-sky-200">
            {unknownHardRules.map((finding) => (
              <li key={finding.ruleId}>
                <span className="font-semibold">{finding.ruleId}:</span> {finding.explanation}
              </li>
            ))}
          </ul>
        )}
      </div>

      {review.softPreferenceNotes.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Preference tradeoffs</p>
          <BulletList items={review.softPreferenceNotes} />
        </div>
      ) : null}

      {showUnknownCriticalEvidence && review.unknownCriticalEvidence.length > 0 ? (
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
          {isDeterministicGate ? "Deterministic LST gate - no AI model was called" : "Reviewed from OSO snapshot"} · {ticker} · {shortDateTime(evaluatedAt)}
        </p>
        <p className="mt-0.5">
          {isDeterministicGate
            ? "A hard LST rule already decided this outcome - verify the underlying evidence before placing an order."
            : "AI decision support - verify the trade before placing an order."}
        </p>
      </div>
    </div>
  );
}
