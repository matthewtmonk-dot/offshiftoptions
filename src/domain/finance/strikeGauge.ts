/**
 * Dashboard visual pass - pure geometry for the "price vs strike" gauge shown on position rows.
 * PRESENTATION ONLY: it never decides an action, status, or lifecycle - those stay owned by
 * positionReview.ts. It only draws the SAME three zones that evaluator already uses, from the
 * SAME inputs it already persisted (strike, observed underlying price, applied roll buffer):
 *
 *   favorableDistancePct = ((price - strike) / strike) * 100 for a put, ((strike - price) / strike) * 100 for a call
 *   <= 0                 -> ITM  (the evaluator's REVIEW_ROLL / REVIEW_CALL zone)
 *   0 < d <= buffer      -> WATCH zone (the evaluator's WITHIN_ROLL_BUFFER)
 *   > buffer             -> comfortable OTM
 *
 * Returns null whenever an input is missing/non-finite/non-positive, so a caller can never draw a
 * gauge from fabricated numbers - missing evidence stays missing.
 */

export type StrikeGaugeInput = {
  optionType: "PUT" | "CALL";
  strike: number | null;
  price: number | null;
  /** The buffer percent the evaluator actually applied (0.1-25). Null draws no watch band. */
  bufferPercent: number | null;
};

export type StrikeGaugeZone = { startPct: number; endPct: number };

export type StrikeGaugeGeometry = {
  /** 0-100 positions along the track, left = lower price. */
  pricePct: number;
  strikePct: number;
  itm: StrikeGaugeZone;
  watch: StrikeGaugeZone | null;
  otm: StrikeGaugeZone;
  moneyness: "ITM" | "ATM" | "OTM";
  /** True when the observed price sits outside the drawn window and the dot was pinned to an edge. */
  priceClamped: boolean;
};

const MIN_HALF_WINDOW_PCT = 6;
const WINDOW_PADDING = 1.6;

export function buildStrikeGaugeGeometry(input: StrikeGaugeInput): StrikeGaugeGeometry | null {
  const { optionType, strike, price, bufferPercent } = input;
  if (strike === null || price === null) return null;
  if (!Number.isFinite(strike) || !Number.isFinite(price) || strike <= 0 || price <= 0) return null;
  const buffer = bufferPercent !== null && Number.isFinite(bufferPercent) && bufferPercent > 0 ? bufferPercent : null;

  // Visible window is centered on the strike, wide enough to hold the price dot and the whole
  // watch band, but never so narrow that a tiny distance looks like a big one.
  const distancePct = (Math.abs(price - strike) / strike) * 100;
  const halfWindowPct = Math.max(MIN_HALF_WINDOW_PCT, distancePct * WINDOW_PADDING, (buffer ?? 0) * 2.2);
  const low = strike * (1 - halfWindowPct / 100);
  const high = strike * (1 + halfWindowPct / 100);
  const span = high - low;
  const toPct = (value: number) => ((value - low) / span) * 100;
  const clamp = (pct: number) => Math.min(100, Math.max(0, pct));

  const strikePct = toPct(strike);
  const rawPricePct = toPct(price);
  const pricePct = clamp(rawPricePct);

  const watchEdge = buffer === null ? null : optionType === "PUT" ? strike * (1 + buffer / 100) : strike * (1 - buffer / 100);
  const watchEdgePct = watchEdge === null ? null : clamp(toPct(watchEdge));

  let itm: StrikeGaugeZone;
  let otm: StrikeGaugeZone;
  let watch: StrikeGaugeZone | null = null;
  if (optionType === "PUT") {
    itm = { startPct: 0, endPct: strikePct };
    watch = watchEdgePct === null ? null : { startPct: strikePct, endPct: watchEdgePct };
    otm = { startPct: watchEdgePct ?? strikePct, endPct: 100 };
  } else {
    itm = { startPct: strikePct, endPct: 100 };
    watch = watchEdgePct === null ? null : { startPct: watchEdgePct, endPct: strikePct };
    otm = { startPct: 0, endPct: watchEdgePct ?? strikePct };
  }

  const signedDiff = price - strike;
  const moneyness = signedDiff === 0 ? "ATM" : optionType === "PUT" ? (signedDiff > 0 ? "OTM" : "ITM") : signedDiff < 0 ? "OTM" : "ITM";

  return { pricePct, strikePct, itm, watch, otm, moneyness, priceClamped: rawPricePct !== pricePct };
}

/** Whole-number days-to-expiration label for a row header ("10d", "today", "expired"). */
export function dteChipLabel(dte: number | null): string | null {
  if (dte === null || !Number.isFinite(dte)) return null;
  if (dte < 0) return "expired";
  if (dte === 0) return "today";
  return `${Math.trunc(dte)}d`;
}

/**
 * How close a short option is to expiring, for color only. <= 1 day is "urgent" (expires today or
 * tomorrow), 2-4 days is "soon", anything further is "normal". An unknown or already-past value gets
 * no urgency at all rather than a guess.
 */
export type DteUrgency = "urgent" | "soon" | "normal" | "unknown";

export function dteUrgency(dte: number | null): DteUrgency {
  if (dte === null || !Number.isFinite(dte) || dte < 0) return "unknown";
  if (dte <= 1) return "urgent";
  if (dte <= 4) return "soon";
  return "normal";
}

/**
 * Good / watch / bad for the "OTM by $0.31 / 2.5%" line. Mirrors the evaluator exactly (positionReview.ts):
 * in the money is bad; out of the money but inside the owner's roll buffer is watch; out of the money
 * beyond the buffer is good; at the strike is watch. Null when the distance isn't known - no color is
 * better than a wrong one.
 */
export type MoneynessTone = "good" | "watch" | "bad";

export function moneynessTone(args: {
  moneyness: "ITM" | "ATM" | "OTM" | null;
  percentageDistance: number | null;
  bufferPercent: number | null;
}): MoneynessTone | null {
  const { moneyness, percentageDistance, bufferPercent } = args;
  if (moneyness === null) return null;
  if (moneyness === "ITM") return "bad";
  if (moneyness === "ATM") return "watch";
  if (percentageDistance === null || !Number.isFinite(percentageDistance)) return null;
  return bufferPercent !== null && Number.isFinite(bufferPercent) && percentageDistance <= bufferPercent ? "watch" : "good";
}
