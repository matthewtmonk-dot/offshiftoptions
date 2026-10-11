import { round } from "./calculations";

/**
 * Covered Call Outcome Planner - a deterministic, client-side "what-if" calculator for an
 * ASSIGNED campaign: "if I sell a covered call at this strike for this premium, and the shares
 * are called away, what is my TOTAL campaign profit or loss?" Pure math only - no provider calls,
 * no AI, no persistence, no mutation, and never infers a final broker outcome (assignment,
 * exercise, called away, expired worthless). `assignedPrice`/`shares`/`priorOptionCashFlow` are
 * expected to come from the SAME authoritative campaign summary the rest of Tracker already shows
 * (latestAssignmentEvent.strike / summary.sharesHeld / summary.netOptionPremium -
 * campaigns.ts/positions page) - this module never re-derives them from raw events itself, so it
 * can never drift from (or double-count against) the campaign's own already-computed cash flow.
 *
 * Rounding: every returned numeric field is rounded to 4 decimal places (`round`, calculations.ts
 * - this module's own established "full enough precision, no binary-float noise" convention,
 * already used throughout calculations.ts) from FULL-PRECISION intermediates - never a value
 * already rounded to 2 decimals feeding into a later formula. Callers format for DISPLAY (2
 * decimals for money/percent/per-share) separately, via money()/percent() (lib/format.ts) - this
 * module never performs display formatting itself.
 */
export type CoveredCallOutcomeInput = {
  /** Cost basis per assigned share (the ASSIGNMENT event's own strike) - never already cash-flow-
   * adjusted (that would double-count against `priorOptionCashFlow` below). */
  assignedPrice: number;
  /** Currently held assigned share count. */
  shares: number;
  /** Cumulative tracked option cash flow ALREADY recorded for this campaign (put premium, any
   * roll credits/debits, and any covered-call premium already sold - including a currently OPEN
   * call's premium, received at the time it was sold) - never re-derived here, always the
   * campaign's own existing net figure. This is cash flow, not a fully fee-adjusted realized
   * profit figure - callers must preserve that distinction in their own labeling. */
  priorOptionCashFlow: number;
  /** The strike the user is evaluating - may or may not match an existing open call's strike. */
  proposedStrike: number;
  /** The NEW, not-yet-recorded premium per share the user expects for `proposedStrike` - never an
   * already-recorded premium (that would double-count against `priorOptionCashFlow`). Zero when
   * the user is only evaluating an already-open call's own strike with nothing further collected. */
  proposedPremiumPerShare: number;
  /** The user's target total campaign return, as a percent (e.g. 1 for 1.00%). */
  targetReturnPct: number;
  /** A current or last-valid stock price, when a trustworthy one exists - never fabricated.
   * `null`/`undefined` when no usable snapshot exists at all, which simply omits the hypothetical
   * share-exit figure below rather than guessing one. */
  currentStockPrice?: number | null;
};

export type CoveredCallOutcomeResult = {
  shareCost: number;
  stockGainLossIfCalled: number;
  newPremiumTotal: number;
  campaignProfitIfCalled: number;
  campaignReturnPct: number;
  /** Effective per-share break-even after prior tracked option cash flow: `assignedPrice -
   * priorOptionCashFlow / shares`. */
  effectiveBreakEven: number;
  /** New premium per share still needed, at `proposedStrike`, to reach a $0 campaign result if
   * called away - never negative (floored at 0: a strike/prior-cash-flow combination that already
   * clears break-even on its own needs no further premium). */
  premiumRequiredToBreakEven: number;
  /** New premium per share still needed, at `proposedStrike`, to reach `targetReturnPct` if called
   * away - never negative, for the same reason as above. */
  premiumRequiredForTarget: number;
  /** `(currentStockPrice - assignedPrice) * shares + priorOptionCashFlow` - a hypothetical "what
   * if I exited the shares at today's price right now" figure, never implying the shares can
   * actually be sold today (an open or settlement-pending call's own disposition is unconfirmed -
   * callers must show their own caveat for that). `null` whenever no current stock price was
   * supplied, never a guessed/fabricated price. */
  hypotheticalShareExitProfit: number | null;
  /** `campaignReturnPct - targetReturnPct` - positive once/once the target is exceeded. */
  targetDifferencePct: number;
};

export function calculateCoveredCallOutcome(input: CoveredCallOutcomeInput): CoveredCallOutcomeResult {
  const { assignedPrice, shares, priorOptionCashFlow, proposedStrike, proposedPremiumPerShare, targetReturnPct, currentStockPrice } = input;

  const shareCost = assignedPrice * shares;
  const stockGainLossIfCalled = (proposedStrike - assignedPrice) * shares;
  const newPremiumTotal = proposedPremiumPerShare * shares;
  const campaignProfitIfCalled = stockGainLossIfCalled + priorOptionCashFlow + newPremiumTotal;
  const campaignReturnPct = shareCost !== 0 ? (campaignProfitIfCalled / shareCost) * 100 : 0;

  const effectiveBreakEven = shares !== 0 ? assignedPrice - priorOptionCashFlow / shares : assignedPrice;

  const premiumRequiredToBreakEven = shares !== 0 ? Math.max(0, (shareCost - proposedStrike * shares - priorOptionCashFlow) / shares) : 0;

  const targetProfitDollars = shareCost * (targetReturnPct / 100);
  const premiumRequiredForTarget = shares !== 0 ? Math.max(0, (targetProfitDollars - stockGainLossIfCalled - priorOptionCashFlow) / shares) : 0;

  const hypotheticalShareExitProfit =
    currentStockPrice === null || currentStockPrice === undefined ? null : (currentStockPrice - assignedPrice) * shares + priorOptionCashFlow;

  const targetDifferencePct = campaignReturnPct - targetReturnPct;

  return {
    shareCost: round(shareCost, 4),
    stockGainLossIfCalled: round(stockGainLossIfCalled, 4),
    newPremiumTotal: round(newPremiumTotal, 4),
    campaignProfitIfCalled: round(campaignProfitIfCalled, 4),
    campaignReturnPct: round(campaignReturnPct, 4),
    effectiveBreakEven: round(effectiveBreakEven, 4),
    premiumRequiredToBreakEven: round(premiumRequiredToBreakEven, 4),
    premiumRequiredForTarget: round(premiumRequiredForTarget, 4),
    hypotheticalShareExitProfit: hypotheticalShareExitProfit === null ? null : round(hypotheticalShareExitProfit, 4),
    targetDifferencePct: round(targetDifferencePct, 4),
  };
}

export type CoveredCallOutcomeTone = "bad" | "warn" | "good";

/**
 * Color represents the TOTAL CAMPAIGN OUTCOME, never merely whether the new premium itself is
 * positive - a positive new premium that still locks in a net campaign loss (once prior cash flow
 * and the stock gain/loss are both considered) must read RED, not green. RED: a net campaign loss
 * if called away. AMBER: break-even or better, but short of the user's own target return. GREEN:
 * the target return is met or exceeded.
 */
export function coveredCallOutcomeTone(result: Pick<CoveredCallOutcomeResult, "campaignProfitIfCalled" | "campaignReturnPct">, targetReturnPct: number): CoveredCallOutcomeTone {
  if (result.campaignProfitIfCalled < 0) return "bad";
  if (result.campaignReturnPct >= targetReturnPct) return "good";
  return "warn";
}
