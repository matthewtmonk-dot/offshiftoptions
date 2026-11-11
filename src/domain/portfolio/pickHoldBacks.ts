import { candidateBlockers, collateralOf, type PlanCandidate, type PlanLimits } from "./portfolioPlan";

const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/**
 * Why a scanner PASS/NEAR row would NOT be offered as a pick - the same hard checks the Scanner's picks panel applies
 * (`candidateBlockers`: ethics, required scanner rules, company quality, earnings date, strike/bid/return), plus the
 * "one contract is bigger than the per-company limit" size check. Empty = nothing holds it back.
 *
 * Used by the Dashboard so its scan preview can never show a name as ready that the Scanner itself leaves out.
 * Display only: it never changes a row's technical PASS/NEAR classification or score.
 *
 * Deliberately simpler than the full planner: it ignores exposure already held in the same company, the theme limit,
 * the total-committed ceiling and available cash (those need the live Schwab balance the Scanner reads in the browser).
 * A name with no reasons here can therefore still be left out on the Scanner; a name WITH reasons here is always left
 * out there, as long as the same limits are in force. `accountValue` null/zero skips the size check.
 */
export function pickHoldBackReasons(candidate: PlanCandidate, limits: PlanLimits, accountValue: number | null): string[] {
  const reasons = candidateBlockers(candidate, limits);
  const collateral = collateralOf(candidate);
  if (collateral !== null && accountValue !== null && accountValue > 0) {
    const pct = (collateral / accountValue) * 100;
    if (pct > limits.maxPerCompanyPct) {
      reasons.push(`one contract holds ${usd0.format(collateral)} (${pct.toFixed(1)}% of the account), over the ${limits.maxPerCompanyPct}% per-company limit`);
    }
  }
  return reasons;
}
