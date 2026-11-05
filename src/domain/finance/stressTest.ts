/**
 * Worst-case "what if every position drops at once" table shown next to the capital numbers.
 *
 * Deliberately simple and deliberately pessimistic, so it can be read at a glance:
 *  - Every tracked position (open put collateral and assigned shares at cost) is assumed to fall by the same percent
 *    FROM ITS STRIKE OR COST, at the same moment, with no premium credited. For a short put held to expiry, the loss
 *    is (strike - price) x 100, so a fall of x% from the strike is a loss of x% of the collateral before premium.
 *  - Premium already collected is ignored (it would soften the loss), and a position that is already below its strike
 *    is counted as if it were still at the strike (so the table slightly overstates it).
 *  - It is NOT a forecast and NOT an options-repricing model. It answers one question: how bad would a broad drop
 *    be for the capital currently at work?
 * Pure and read-only: no thresholds anywhere else in the app depend on it.
 */

export const STRESS_SHOCKS = [0.2, 0.3, 0.5] as const;

export type StressRow = {
  shockPercent: number;
  lossDollars: number;
  /** Loss as a percent of total account value. */
  lossPercentOfAccount: number;
};

export type StressTable = {
  rows: StressRow[];
  /** True when some open campaigns have unknown collateral/cost, so the real exposure may be larger than shown. */
  isFloor: boolean;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

export function buildStressTable(input: {
  committed: number | null;
  accountValue: number | null;
  hasUnknownExposure: boolean;
  shocks?: readonly number[];
}): StressTable | null {
  const { committed, accountValue } = input;
  if (committed === null || accountValue === null) return null;
  if (!Number.isFinite(committed) || !Number.isFinite(accountValue) || accountValue <= 0 || committed < 0) return null;
  const shocks = input.shocks ?? STRESS_SHOCKS;
  const rows = shocks
    .filter((shock) => Number.isFinite(shock) && shock > 0 && shock <= 1)
    .map((shock) => {
      const lossDollars = round2(committed * shock);
      return { shockPercent: Math.round(shock * 100), lossDollars, lossPercentOfAccount: round2((lossDollars / accountValue) * 100) };
    });
  return { rows, isFloor: input.hasUnknownExposure };
}
