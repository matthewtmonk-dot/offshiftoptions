"use client";

import { ArrowRight } from "lucide-react";
import type { PositionReviewAction } from "@/domain/finance/positionReview";
import type { PositionAssessmentDisplay } from "@/domain/finance/positionReviewAssessment";
import { nextStepFor } from "@/domain/finance/nextStep";
import { useActiveGuidanceExpired } from "@/components/use-active-guidance-expired";

const TONE_CLASS = {
  ok: "text-zinc-400",
  watch: "text-amber-300",
  act: "font-semibold text-amber-200",
  wait: "text-zinc-500",
} as const;

/**
 * One plain "Next:" sentence under a position. Follows exactly the same live / last-valid / expired
 * decision the Comfortable/Watch/Review badge beside it makes (same display, same expiry hook), so the
 * sentence can never disagree with the badge. See domain/finance/nextStep.ts for the wording rules.
 */
export function NextStepLine({
  display,
  dte,
  settlementPending,
  daysPastExpiration = null,
}: {
  display: PositionAssessmentDisplay | null;
  dte: number | null;
  settlementPending: boolean;
  /** Calendar days since the open leg expired; only used while settlement is pending. */
  daysPastExpiration?: number | null;
}) {
  const expired = useActiveGuidanceExpired(
    display?.state === "CURRENT" ? display.current.explanation.activeGuidanceDeadline : null,
    display?.state === "CURRENT" ? display.current.explanation.evaluatedAt : null,
  );

  let action: PositionReviewAction | null = null;
  let historical = false;
  if (display?.state === "CURRENT" && !expired) {
    action = display.current.action;
  } else if (display?.state === "CURRENT" && display.lastValid) {
    action = display.lastValid.action;
    historical = true;
  } else if (display?.state === "LAST_VALID") {
    action = display.lastValid.action;
    historical = true;
  }

  const step = nextStepFor({ settlementPending, action, dte, historical, daysPastExpiration });
  return (
    <p className={`mt-1 flex items-start gap-1 text-xs ${TONE_CLASS[step.tone]}`} data-testid="next-step">
      <ArrowRight className="mt-0.5 size-3 shrink-0" aria-hidden />
      <span>
        <span className="font-semibold">Next:</span> {step.text}
      </span>
    </p>
  );
}
