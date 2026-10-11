"use client";

import { useId, useMemo, useState } from "react";
import { ChevronDown, Info } from "lucide-react";
import { calculateCoveredCallOutcome, coveredCallOutcomeTone, type CoveredCallOutcomeResult } from "@/domain/finance/coveredCallOutcome";
import { money } from "@/lib/format";

const toneBorder: Record<"bad" | "warn" | "good", string> = {
  bad: "border-red-400/40 bg-red-400/10",
  warn: "border-amber-400/40 bg-amber-400/10",
  good: "border-emerald-400/40 bg-emerald-400/10",
};
const toneText: Record<"bad" | "warn" | "good", string> = {
  bad: "text-red-200",
  warn: "text-amber-200",
  good: "text-emerald-200",
};

function signed(value: number, digits = 2) {
  return `${value > 0 ? "+" : ""}${money(value, digits)}`;
}

function roundToStep(value: number, step: number) {
  return Math.round(value / step) * step;
}

/**
 * Covered Call Outcome Planner (V1) - a deterministic, client-side "what-if" calculator, inline in
 * Tracker for any ASSIGNED campaign: "if I sell a covered call at this strike for this premium,
 * and the shares are called away, what is my TOTAL campaign profit or loss?" All math is
 * calculateCoveredCallOutcome (domain/finance/coveredCallOutcome.ts, pure, fully unit-tested) -
 * this component only owns input state and formats that function's own output for display. No
 * provider calls, no AI, no persistence, no mutation - closed by default so the compact Tracker
 * row it lives inside never grows until the user actually opens it.
 *
 * Every auto-filled value (`assignedPrice`/`shares`/`priorOptionCashFlow`/`existingCallStrike`/
 * `currentStockPrice`) is a prop the caller (CampaignCard, positions/page.tsx) already computed
 * from the SAME authoritative campaign summary the rest of Tracker shows (latestAssignmentEvent/
 * summary.sharesHeld/summary.netOptionPremium/getCurrentOpenCall/quoteSnapshot) - this component
 * never re-derives or re-fetches any of them itself, so it can never drift from (or double-count
 * against) the campaign's own already-recorded cash flow.
 */
export function CoveredCallOutcomePlanner({
  ticker,
  assignedPrice,
  shares,
  priorOptionCashFlow,
  feesFullyKnown,
  existingCallStrike,
  hasOpenCall,
  settlementPending,
  currentStockPrice,
  currentStockPriceAsOf,
}: {
  ticker: string;
  assignedPrice: number | null;
  shares: number;
  priorOptionCashFlow: number;
  /** Whether the campaign's own tracked cash flow is fully fee-adjusted - mirrors the same
   * feesFullyKnown/netPLExact flag the rest of this card already uses. When false, this is still
   * cash flow, not a confirmed final net figure - fees may still be pending. */
  feesFullyKnown: boolean;
  existingCallStrike: number | null;
  hasOpenCall: boolean;
  /** True once the currently (or most recently) open call's own expiration has passed with no
   * resolving event yet recorded - the same SETTLEMENT PENDING / Awaiting Settlement
   * classification the rest of Tracker already shows (isAwaitingSettlement,
   * domain/finance/positionActivity.ts). Never infers assignment/exercise/called-away/expired-
   * worthless - only that confirmation is still pending. */
  settlementPending: boolean;
  currentStockPrice: number | null;
  currentStockPriceAsOf: Date | null;
}) {
  const [open, setOpen] = useState(false);
  const strikeId = useId();
  const premiumId = useId();
  const targetId = useId();

  const referencePrices = [assignedPrice, currentStockPrice, existingCallStrike].filter((price): price is number => price !== null && price > 0);
  const fallbackReference = assignedPrice ?? currentStockPrice ?? existingCallStrike ?? 10;
  const defaultStrike = existingCallStrike ?? (referencePrices.length > 0 ? roundToStep(referencePrices.reduce((sum, p) => sum + p, 0) / referencePrices.length, 0.5) : fallbackReference);

  const [strikeInput, setStrikeInput] = useState(() => defaultStrike.toFixed(2));
  const [premiumInput, setPremiumInput] = useState(""); // never pre-filled with a fabricated quote
  const [targetInput, setTargetInput] = useState("1.00");

  const strike = Number(strikeInput);
  const premium = premiumInput === "" ? 0 : Number(premiumInput);
  const targetPct = targetInput === "" ? 0 : Number(targetInput);

  const sliderBasis = referencePrices.length > 0 ? referencePrices : [fallbackReference];
  const sliderMin = Math.max(0.5, roundToStep(Math.min(...sliderBasis) - Math.max(Math.min(...sliderBasis) * 0.25, 2), 0.5));
  const sliderMax = roundToStep(Math.max(...sliderBasis) + Math.max(Math.max(...sliderBasis) * 0.25, 2), 0.5);

  const validInputs = assignedPrice !== null && shares > 0 && Number.isFinite(strike) && strike > 0 && Number.isFinite(premium) && premium >= 0 && Number.isFinite(targetPct);

  const result: CoveredCallOutcomeResult | null = useMemo(() => {
    if (!validInputs || assignedPrice === null) return null;
    return calculateCoveredCallOutcome({
      assignedPrice,
      shares,
      priorOptionCashFlow,
      proposedStrike: strike,
      proposedPremiumPerShare: premium,
      targetReturnPct: targetPct,
      currentStockPrice,
    });
  }, [validInputs, assignedPrice, shares, priorOptionCashFlow, strike, premium, targetPct, currentStockPrice]);

  const tone = result ? coveredCallOutcomeTone(result, targetPct) : "warn";

  if (assignedPrice === null || shares <= 0) {
    // Defensive only - every ASSIGNED campaign eligible to render this component has a real
    // assignment event and a positive share count; never guess either one.
    return null;
  }

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/40" data-testid="covered-call-outcome-planner">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-2 p-3 text-left text-sm font-semibold uppercase tracking-normal text-zinc-300"
        data-testid="covered-call-outcome-planner-toggle"
        aria-label={`${open ? "Collapse" : "Expand"} the covered call outcome planner for ${ticker}`}
      >
        <span>Covered Call Outcome Planner</span>
        <ChevronDown className={`size-4 text-zinc-500 transition ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>

      {open ? (
        <div className="space-y-4 border-t border-zinc-800 p-4">
          <p className="flex items-start gap-1.5 text-xs text-zinc-500">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            What-if calculator only - not a trade recommendation and places no orders. Enter your own expected premium; OSO does not fetch live option quotes.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            {/* Left: auto-filled context + editable inputs */}
            <div className="space-y-4">
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                <div>
                  <dt className="uppercase tracking-wide text-zinc-500">Assigned basis</dt>
                  <dd className="mt-0.5 font-medium text-zinc-200">{money(assignedPrice)}/share</dd>
                </div>
                <div>
                  <dt className="uppercase tracking-wide text-zinc-500">Shares held</dt>
                  <dd className="mt-0.5 font-medium text-zinc-200">{shares}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="uppercase tracking-wide text-zinc-500">Tracked prior option cash flow</dt>
                  <dd className={`mt-0.5 font-medium ${priorOptionCashFlow < 0 ? "text-red-200" : "text-emerald-200"}`}>
                    {signed(priorOptionCashFlow)}
                    {!feesFullyKnown ? <span className="ml-1.5 font-normal text-zinc-500">Fees may still be pending</span> : null}
                  </dd>
                </div>
              </dl>
              {hasOpenCall && existingCallStrike !== null ? (
                <p className="text-xs text-zinc-500">
                  An existing {money(existingCallStrike)} call&apos;s premium is already included in the tracked cash flow above. Leave the premium below at $0.00 unless this represents a new or different call.
                </p>
              ) : null}

              <div>
                <label htmlFor={strikeId} className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                  Proposed call strike
                </label>
                <div className="mt-1.5 flex items-center gap-3">
                  <input
                    id={strikeId}
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0.01"
                    value={strikeInput}
                    onChange={(event) => setStrikeInput(event.target.value)}
                    className="w-24 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 tabular-nums"
                  />
                  <input
                    type="range"
                    aria-label="Proposed call strike slider"
                    min={sliderMin}
                    max={sliderMax}
                    step={0.5}
                    value={Number.isFinite(strike) ? Math.min(Math.max(strike, sliderMin), sliderMax) : sliderMin}
                    onChange={(event) => setStrikeInput(Number(event.target.value).toFixed(2))}
                    className="h-1.5 flex-1 accent-sky-400"
                  />
                </div>
              </div>

              <div>
                <label htmlFor={premiumId} className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                  Expected net call premium ($/share)
                </label>
                <input
                  id={premiumId}
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  value={premiumInput}
                  onChange={(event) => setPremiumInput(event.target.value)}
                  className="mt-1.5 w-28 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 tabular-nums"
                />
              </div>

              <div>
                <label htmlFor={targetId} className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                  Target total campaign return
                </label>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <input
                    id={targetId}
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    value={targetInput}
                    onChange={(event) => setTargetInput(event.target.value)}
                    className="w-20 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 tabular-nums"
                  />
                  <span className="text-sm text-zinc-400">%</span>
                </div>
              </div>
            </div>

            {/* Right: result + target status */}
            <div className="space-y-3">
              {result ? (
                <>
                  <div className={`rounded-md border p-3 ${toneBorder[tone]}`} data-testid="covered-call-outcome-result">
                    <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">If called away at {money(strike)}</p>
                    <dl className="mt-2 space-y-1.5 text-[13px]">
                      <div className="flex items-center justify-between">
                        <dt className="text-zinc-400">Stock gain/loss</dt>
                        <dd className={`tabular-nums ${result.stockGainLossIfCalled < 0 ? "text-red-200" : "text-emerald-200"}`}>{signed(result.stockGainLossIfCalled)}</dd>
                      </div>
                      <div className="flex items-center justify-between">
                        <dt className="text-zinc-400">Prior tracked option cash flow</dt>
                        <dd className={`tabular-nums ${priorOptionCashFlow < 0 ? "text-red-200" : "text-emerald-200"}`}>{signed(priorOptionCashFlow)}</dd>
                      </div>
                      <div className="flex items-center justify-between">
                        <dt className="text-zinc-400">New call premium</dt>
                        <dd className="tabular-nums text-emerald-200">{signed(result.newPremiumTotal)}</dd>
                      </div>
                    </dl>
                    <div className={`mt-3 border-t border-zinc-800 pt-2 ${toneText[tone]}`}>
                      <div className="flex items-baseline justify-between">
                        <span className="text-xs font-semibold uppercase tracking-wide">Final campaign P/L</span>
                        <span className="text-xl font-bold tabular-nums">{signed(result.campaignProfitIfCalled)}</span>
                      </div>
                      <div className="mt-0.5 flex items-baseline justify-between">
                        <span className="text-xs font-semibold uppercase tracking-wide">Total return</span>
                        <span className="text-base font-semibold tabular-nums">{signed(result.campaignReturnPct)}%</span>
                      </div>
                    </div>
                  </div>

                  <div className={`rounded-md border p-2.5 text-xs ${toneBorder[tone]} ${toneText[tone]}`} data-testid="covered-call-outcome-target">
                    <span className="font-semibold uppercase tracking-wide">Target: {signed(targetPct)}%</span>{" "}
                    {tone === "bad"
                      ? `Below target by ${Math.abs(result.targetDifferencePct).toFixed(2)} percentage points`
                      : tone === "warn"
                        ? `Positive, but ${Math.abs(result.targetDifferencePct).toFixed(2)} points below target`
                        : `Target exceeded by ${Math.abs(result.targetDifferencePct).toFixed(2)} points`}
                  </div>

                  <dl className="space-y-2 text-xs">
                    <div className="flex items-center justify-between border-t border-zinc-800 pt-2">
                      <dt className="text-zinc-500">Effective break-even after prior option cash flow</dt>
                      <dd className="tabular-nums text-zinc-200">{money(result.effectiveBreakEven)}/share</dd>
                    </div>
                    <div className="flex items-center justify-between">
                      <dt className="text-zinc-500">Premium needed to break even at {money(strike)} strike</dt>
                      <dd className="tabular-nums text-zinc-200">{money(result.premiumRequiredToBreakEven)}/share</dd>
                    </div>
                    <div className="flex items-center justify-between">
                      <dt className="text-zinc-500">Premium needed for {signed(targetPct)}% total campaign return</dt>
                      <dd className="tabular-nums text-zinc-200">{money(result.premiumRequiredForTarget)}/share</dd>
                    </div>
                  </dl>

                  {result.hypotheticalShareExitProfit !== null && currentStockPrice !== null ? (
                    <div className="rounded-md border border-zinc-800 bg-zinc-950/50 p-2.5 text-xs" data-testid="covered-call-outcome-share-exit">
                      <p className="font-semibold uppercase tracking-wide text-zinc-400">
                        Hypothetical share exit at {money(currentStockPrice)}
                      </p>
                      <p className={`mt-1 text-sm font-semibold tabular-nums ${result.hypotheticalShareExitProfit < 0 ? "text-red-200" : "text-emerald-200"}`}>
                        {signed(result.hypotheticalShareExitProfit)}
                      </p>
                      {currentStockPriceAsOf ? <p className="mt-1 text-zinc-500">Snapshot - may be delayed or from the last session.</p> : null}
                      <p className="mt-1.5 text-amber-200/90">
                        {settlementPending
                          ? "Settlement pending - final share disposition is not yet confirmed."
                          : hasOpenCall
                            ? "Open covered call - this is a hypothetical campaign value, not an available share-sale action."
                            : "Hypothetical only - selling shares is a decision to make in Schwab/Thinkorswim, not an action this planner can take."}
                      </p>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="text-xs text-zinc-500">Enter a valid strike, premium, and target to see the outcome.</p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
