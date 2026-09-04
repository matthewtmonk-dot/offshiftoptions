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
