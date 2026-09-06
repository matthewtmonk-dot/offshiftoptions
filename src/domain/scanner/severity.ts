import { numericValue, type CriterionResult } from "./scanner";

export type SeverityTone = "good" | "warn" | "bad" | "neutral";

/**
 * Per-rule amber cutoff, expressed as a percentage gap beyond the user's configured
 * threshold - the same gap-percent formula shape as scanner.ts's criterionGap (distance to
 * threshold / threshold-or-span), but with its own cutoffs and applied only to *this* purpose:
 * informational cell shading, never scoring or near-miss credit. Deliberately kept as a
 * separate concept from criterionGap's 12% near-miss cutoff (which only ever looks at FAILs
 * for score partial-credit) rather than reusing that exact number, so the two never silently
 * drift into contradicting each other if one is tuned later.
 *
 * The GREEN/FAIL boundary itself always comes from the criterion's own `desiredValue` (the
 * user's actual stored rule) - never hardcoded. Only the amber-vs-red split within the FAIL
 * zone is a fixed percentage, chosen so it reproduces the task's own worked examples when a
 * rule sits at its LST Core default:
 *   - rsi (max 40): amber through 50 -> (50-40)/40 = 25%
 *   - bbPercent (max 33): amber through 50 -> (50-33)/33 ~= 51.5%
 *   - ror (min 1%): amber down to 75% of threshold -> 25% gap
 *   - openInterest (min 100): amber down to 50 -> 50% gap
 *   - optionBid (min 0.10): amber down to 0.05 -> 50% gap
 *   - earningsDistance (min 10 days): amber down to 5 -> 50% gap
 *   - price ($10-$50 range): amber within ~20% beyond either boundary -> 20% gap
 * The cutoff percentage scales with whatever threshold the user has actually configured -
 * changing a rule's desired value never requires touching this table.
 */
const AMBER_CUTOFF_PERCENT: Record<string, number> = {
  price: 20,
  rsi: 25,
  bbPercent: (17 / 33) * 100,
  ror: 25,
  openInterest: 50,
  optionBid: 50,
  earningsDistance: 50,
};

/** Any numeric rule not explicitly tuned above (stockVolume, annualizedRor, spreadPercent,
 * debtToEquity, delta, dte) still gets a reasonable, documented amber band rather than being
 * left uncolored. */
const GENERIC_AMBER_CUTOFF_PERCENT = 20;

/**
 * Maps a candidate's evaluated criterion for one Scanner Rule to a presentational severity
 * tone. Pure and read-only: never calls, and is never called by, evaluateCandidate/setupScore/
 * honestSetupLabel/criterionGap - this must never change what a row scores or how it's
 * classified, only how a cell is shaded.
 *
 * - `criterion` undefined means the rule is disabled (or doesn't apply to this metric at all,
 *   e.g. "strike") - never presented as a hard pass/fail, always neutral.
 * - `status === "UNKNOWN"` (the value itself is unavailable) is always neutral, never a false
 *   red - this is exactly the VERIFY condition.
 * - `status === "PASS"` is always green, uniformly - matches every one of the task's worked
 *   examples (e.g. RSI at exactly 40 is green, not an edge-case amber).
 * - `status === "FAIL"` is split into amber/red by the gap-percent cutoff above.
 */
export function ruleSeverityTone(criterion: CriterionResult | undefined): SeverityTone {
  if (!criterion || criterion.status === "UNKNOWN") {
    return "neutral";
  }
  if (criterion.status === "PASS") {
    return "good";
  }

  const gapPercent = failGapPercent(criterion);
  if (gapPercent === null) {
    return "bad";
  }

  const cutoff = AMBER_CUTOFF_PERCENT[criterion.key] ?? GENERIC_AMBER_CUTOFF_PERCENT;
  return gapPercent <= cutoff ? "warn" : "bad";
}

function failGapPercent(result: CriterionResult): number | null {
  const actual = numericValue(result.actualValue);
  if (actual === null) {
    return null;
  }

  if (result.operator === "BETWEEN" && Array.isArray(result.desiredValue)) {
    const [low, high] = result.desiredValue;
    if (actual >= low && actual <= high) {
      return 0;
    }
    const distance = actual < low ? low - actual : actual - high;
    const span = Math.max(Math.abs(high - low), 1);
    return (distance / span) * 100;
  }

  const target = numericValue(result.desiredValue);
  if (target === null) {
    return null;
  }

  if (result.operator === "GTE" && actual < target) {
    return ((target - actual) / Math.max(Math.abs(target), 1)) * 100;
  }
  if (result.operator === "LTE" && actual > target) {
    return ((actual - target) / Math.max(Math.abs(target), 1)) * 100;
  }

  return null;
}
