import type { CreditKeptSummary } from "@/domain/finance/creditKept";
import { formatEtTime, money } from "@/lib/format";

/**
 * Dashboard "credit kept" meter - how much of the premium collected would still be ours if the put
 * were bought back at its current mark. PRESENTATION ONLY: every figure comes from the already-
 * validated CreditKeptSummary (creditKept.ts); this component never computes or guesses a mark.
 * Negative means buying back now would cost more than was collected (a financial loss on the leg
 * right now), so it - and only it - is red; a positive value is green. A snapshot / unresolved-fee
 * figure carries an explicit "est." tag and its "as of" time, so it is never mistaken for a live
 * confirmed quote. Not a probability and not a recommendation.
 */
export function CreditKeptMeter({ summary }: { summary: CreditKeptSummary }) {
  const negative = summary.keptPercent < 0;
  const fillPercent = Math.min(100, Math.abs(summary.keptPercent));
  const tone = negative ? "text-red-300" : summary.keptPercent === 0 ? "text-zinc-300" : "text-emerald-300";
  const barClass = negative ? "bg-red-400/70" : "bg-emerald-400/70";
  const percentText = `${summary.keptPercent.toFixed(0)}%`;
  const basis = `${summary.verifiedPricingTime ? "Priced" : "Snapshot"} ${formatEtTime(summary.asOf)}`;
  const label = `Credit kept ${percentText}: ${money(summary.costToClose)} to buy back versus ${money(summary.netCredit)} collected. ${basis}${summary.provisional ? " (estimate)" : ""}.`;

  return (
    <div data-testid="credit-kept-meter" role="img" aria-label={label} title={label} className="w-full">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium uppercase tracking-wide text-zinc-500">Credit kept</span>
        <span className={`font-semibold tabular-nums ${tone}`}>
          {percentText}
          {summary.provisional ? <span className="ml-1 font-normal text-zinc-500">est.</span> : null}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
        <div className={`h-full rounded-full ${barClass}`} style={{ width: `${fillPercent}%` }} />
      </div>
      <div className="mt-1 text-[11px] text-zinc-500 tabular-nums">
        {money(summary.costToClose)} to close · {money(summary.netCredit)} collected
      </div>
      <div className="text-[11px] text-zinc-600">{basis}</div>
    </div>
  );
}
