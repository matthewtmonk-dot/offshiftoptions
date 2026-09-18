/**
 * Roll Status - a GREEN/AMBER/RED decision-support signal for an open cash-secured put,
 * driven by the user's own configurable Roll Buffer % (UserSettings.rollBufferPercent,
 * default 3.0%). This is explicitly NOT a confirmed proprietary LST numeric rule - it is an
 * OSO decision aid, adjustable per user (Matt and Eric may each choose a different threshold).
 * See PROJECT_HANDOFF.md's Roll Status section.
 *
 * Never uses RED merely because a position is short - only actual moneyness (current stock
 * price vs. strike) drives the color.
 */

import { isPastExpiration, type CampaignCurrentStage } from "./campaigns";

export const DEFAULT_ROLL_BUFFER_PERCENT = 3.0;

export type RollStatusColor = "GREEN" | "AMBER" | "RED";
export type RollStatusLabel = "HOLD" | "NEAR STRIKE" | "ROLL CANDIDATE" | "ROLL";

export type RollStatus = {
  color: RollStatusColor;
  label: RollStatusLabel;
  /** (currentStockPrice - strikePrice) / strikePrice * 100 - signed, positive means above strike. */
  distancePct: number;
  /** Compact display line, e.g. "+19.4% above strike" / "-2.3% below strike" / "At strike". */
  distanceText: string;
  /** Only present for AMBER - e.g. "Inside 3% Roll Buffer". */
  bufferNote: string | null;
  /** Full sentence for tooltips/expanded detail, e.g. "+1.7% above strike · inside your 3% Roll Buffer". */
  reason: string;
};

/**
 * Distinguishes the pre-checkpoint RED label ("ROLL CANDIDATE" - informational, don't panic
 * mid-week) from the at-checkpoint RED label ("ROLL" - the actual Friday management call).
 * Execution itself always stays in Schwab/Thinkorswim; this only changes wording.
 */
export function isPastFridayManagementCheckpoint(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);

  if (weekday === "Sat" || weekday === "Sun") {
    return true;
  }
  return weekday === "Fri" && hour >= 15;
}

/**
 * Once a campaign reaches Expiration Processing, its fate is already decided and only awaiting
 * confirmation (see PROJECT_HANDOFF.md "Tuesday Sep 8" expiration-confirmation step) - HOLD/ROLL
 * decision guidance no longer applies, since there's nothing left to hold or roll. This is an
 * aggregation/rendering guard only: it decides whether to call computeRollStatus() at all, and
 * never changes that function's own price/strike/buffer semantics.
 */
export function isRollGuidanceApplicable(currentStage: CampaignCurrentStage): boolean {
  return currentStage !== "Expiration processing";
}

function formatBufferPercent(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

export function computeRollStatus({
  currentPrice,
  strike,
  rollBufferPercent,
  now = new Date(),
}: {
  currentPrice: number;
  strike: number;
  rollBufferPercent: number;
  now?: Date;
}): RollStatus | null {
  if (!Number.isFinite(currentPrice) || !Number.isFinite(strike) || strike <= 0) {
    return null;
  }

  const distancePct = ((currentPrice - strike) / strike) * 100;
  const bufferLabel = formatBufferPercent(rollBufferPercent);
  const distanceMagnitude = Math.abs(distancePct).toFixed(1);

  if (distancePct > rollBufferPercent) {
    const distanceText = `+${distanceMagnitude}% above strike`;
    return {
      color: "GREEN",
      label: "HOLD",
      distancePct,
      distanceText,
      bufferNote: null,
      reason: `${distanceText} · outside your ${bufferLabel} Roll Buffer`,
    };
  }

  if (distancePct > 0) {
    const distanceText = `+${distanceMagnitude}% above strike`;
    return {
      color: "AMBER",
      label: "NEAR STRIKE",
      distancePct,
      distanceText,
      bufferNote: `Inside ${bufferLabel} Roll Buffer`,
      reason: `${distanceText} · inside your ${bufferLabel} Roll Buffer`,
    };
  }

  const distanceText = distancePct === 0 ? "At strike" : `-${distanceMagnitude}% below strike`;
  const label: RollStatusLabel = isPastFridayManagementCheckpoint(now) ? "ROLL" : "ROLL CANDIDATE";
  return {
    color: "RED",
    label,
    distancePct,
    distanceText,
    bufferNote: null,
    reason: `${distanceText} · put is ITM`,
  };
}

/**
 * Roll Status for an open COVERED CALL - deliberately NOT a mechanical inversion of
 * computeRollStatus's inputs/outputs. `distancePct` keeps the exact same physical meaning as the
 * put side ((currentPrice - strike) / strike * 100, positive = stock trading above strike) so the
 * field means the same real-world thing regardless of option type - but the classification is
 * genuinely different, because assignment pressure on a covered call rises as the stock
 * approaches/crosses the strike from BELOW, the opposite direction from a short put:
 *
 *   - GREEN/HOLD: comfortably below strike, outside the buffer (distancePct < -rollBufferPercent).
 *   - AMBER/NEAR STRIKE: approaching the strike from below, inside the buffer
 *     (-rollBufferPercent <= distancePct < 0).
 *   - RED/ROLL CANDIDATE (or ROLL at/after the same Friday management checkpoint used on puts):
 *     at or above the strike (distancePct >= 0) - the call is ITM.
 *
 * Reuses the exact same RollStatus/RollStatusLabel/RollStatusColor types (so RollStatusBadge needs
 * no changes at all), formatBufferPercent, and isPastFridayManagementCheckpoint - only the
 * classification thresholds and the wording differ.
 */
export function computeCoveredCallRollStatus({
  currentPrice,
  strike,
  rollBufferPercent,
  now = new Date(),
}: {
  currentPrice: number;
  strike: number;
  rollBufferPercent: number;
  now?: Date;
}): RollStatus | null {
  if (!Number.isFinite(currentPrice) || !Number.isFinite(strike) || strike <= 0) {
    return null;
  }

  const distancePct = ((currentPrice - strike) / strike) * 100;
  const bufferLabel = formatBufferPercent(rollBufferPercent);
  const distanceMagnitude = Math.abs(distancePct).toFixed(1);

  if (distancePct < -rollBufferPercent) {
    const distanceText = `-${distanceMagnitude}% below strike`;
    return {
      color: "GREEN",
      label: "HOLD",
      distancePct,
      distanceText,
      bufferNote: null,
      reason: `${distanceText} · outside your ${bufferLabel} Roll Buffer`,
    };
  }

  if (distancePct < 0) {
    const distanceText = `-${distanceMagnitude}% below strike`;
    return {
      color: "AMBER",
      label: "NEAR STRIKE",
      distancePct,
      distanceText,
      bufferNote: `Inside ${bufferLabel} Roll Buffer`,
      reason: `${distanceText} · inside your ${bufferLabel} Roll Buffer`,
    };
  }

  const distanceText = distancePct === 0 ? "At strike" : `+${distanceMagnitude}% above strike`;
  const label: RollStatusLabel = isPastFridayManagementCheckpoint(now) ? "ROLL" : "ROLL CANDIDATE";
  return {
    color: "RED",
    label,
    distancePct,
    distanceText,
    bufferNote: null,
    reason: `${distanceText} · call is ITM`,
  };
}

/**
 * Whether normal covered-call Roll Status guidance should be shown at all - the same "nothing
 * left to hold or roll, only awaiting confirmation" philosophy as isRollGuidanceApplicable uses
 * for puts. A covered call has no dedicated CampaignCurrentStage of its own once a campaign is
 * ASSIGNED (currentStage stays "Covered call" throughout, see campaigns.ts), so this checks the
 * call's own expiration directly via the shared isPastExpiration helper instead of reading
 * currentStage. Like the put side, guidance stays available through expiration day itself and is
 * only suppressed the calendar day after.
 */
export function isCoveredCallRollGuidanceApplicable(callExpiration: Date, asOf: Date = new Date()): boolean {
  return !isPastExpiration(callExpiration, asOf);
}
