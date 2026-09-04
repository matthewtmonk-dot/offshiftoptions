import { parseOccOptionSymbol } from "./occOption";
import { round } from "./calculations";
import type { BrokerPosition } from "@/providers/broker-read/types";

export type BrokerPositionKind = "SHORT_PUT" | "OTHER_OPTION" | "EQUITY_OR_OTHER" | "UNKNOWN";

export type ClassifiedBrokerPosition = {
  position: BrokerPosition;
  kind: BrokerPositionKind;
  optionType: "PUT" | "CALL" | null;
  strike: number | null;
  expiration: Date | null;
  underlying: string;
};

/**
 * Classifies a broker position for display and for CSP-collateral math. Prefers Schwab's
 * own instrument fields (assetType/putCall/strikePrice) when present - they are the
 * authoritative source - and falls back to parsing the OCC option symbol only when Schwab
 * didn't supply them. A position is only ever "SHORT_PUT" when both the option type is
 * confidently PUT (from one of those two sources) AND the position is actually short
 * (negative quantity). Anything we can't confidently classify comes back "UNKNOWN" rather
 * than being guessed - callers must never invent a classification for it.
 */
export function classifyBrokerPosition(position: BrokerPosition): ClassifiedBrokerPosition {
  const parsed = parseOccOptionSymbol(position.symbol);
  const underlying = position.underlyingSymbol ?? parsed?.underlying ?? position.symbol;
  const strike = position.strikePrice ?? parsed?.strike ?? null;
  const expiration = parsed?.expiration ?? null;
  const isOption = position.assetType === "OPTION" || parsed !== null;

  if (!isOption) {
    return { position, kind: "EQUITY_OR_OTHER", optionType: null, strike: null, expiration: null, underlying };
  }

  const optionType = position.putCall ?? parsed?.optionType ?? null;
  if (optionType === null) {
    return { position, kind: "UNKNOWN", optionType: null, strike, expiration, underlying };
  }

  if (optionType === "PUT" && position.quantity < 0) {
    return { position, kind: "SHORT_PUT", optionType: "PUT", strike, expiration, underlying };
  }

  return { position, kind: "OTHER_OPTION", optionType, strike, expiration, underlying };
}

export type CspSecuredCapitalSummary = {
  /** Sum of strike x 100 x |short contracts| over positions confidently identified as
   * short puts. Never includes long puts, calls, equity, or unclassifiable positions. */
  total: number;
  /** True when at least one position looked like an option but couldn't be confidently
   * classified (no Schwab putCall field and an unparseable symbol) - the total above is a
   * floor, not a complete number, when this is true. The UI must say so rather than
   * silently presenting `total` as exact. */
  hasUnknown: boolean;
};

export function summarizeCspSecuredCapital(positions: BrokerPosition[]): CspSecuredCapitalSummary {
  let total = 0;
  let hasUnknown = false;

  for (const position of positions) {
    const classified = classifyBrokerPosition(position);
    if (classified.kind === "UNKNOWN") {
      hasUnknown = true;
      continue;
    }
    if (classified.kind === "SHORT_PUT" && classified.strike !== null) {
      total += classified.strike * 100 * Math.abs(position.quantity);
    }
  }

  return { total: round(total, 2), hasUnknown };
}

/**
 * Total "open positions" shown on the Dashboard: manually-tracked OSO campaigns plus
 * Schwab broker positions, added together. There is deliberately no reconciliation yet
 * (see the Tracker's "Possible match"/"Unlinked" hint) - an OSO campaign and a Schwab
 * position with no explicit link between them are two separate records, so this is a
 * simple additive count, not a deduplicated one. If the same real-world trade is tracked
 * as both an OSO campaign and a synced Schwab position, it is intentionally counted twice
 * today; this is the safest available interim behavior (never silently merging or
 * guessing a link) until reconciliation ships. See PROJECT_HANDOFF.md.
 */
export function computeOpenPositionsCount(openCampaignCount: number, brokerPositions: BrokerPosition[]): number {
  return openCampaignCount + brokerPositions.length;
}

export type BrokerPositionDisplay = {
  title: string;
  detailLine: string | null;
  /** Neutral "Short 1 put"/"Long 1 put"/"100 sh" phrasing - never a bare signed number, since
   * a negative quantity just means short, not a loss. */
  quantityLabel: string;
  /** "Cost to close" for a short option (Schwab's market value there is a payoff liability,
   * not profit/loss) - "Market value" otherwise. Pair with `value`, and never color either by
   * sign - a verified P/L figure is the only thing allowed red/green treatment. */
  valueLabel: string;
  /** Already sign-adjusted to match `valueLabel`: a short option's liability is shown as a
   * positive cost, everything else is Schwab's raw market value. */
  value: number;
};

function optionQuantityLabel(quantity: number, optionType: "PUT" | "CALL" | null): string {
  const direction = quantity < 0 ? "Short" : "Long";
  const count = Math.abs(quantity);
  const noun = optionType === "PUT" ? "put" : optionType === "CALL" ? "call" : "contract";
  return `${direction} ${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Shared human-readable formatting for a broker position, used by both the Dashboard and
 * Tracker so an option position never renders as a raw OCC symbol, a bare "-1 sh", or a short
 * position's liability styled as a loss.
 */
export function describeBrokerPositionForDisplay(position: BrokerPosition): BrokerPositionDisplay {
  const classified = classifyBrokerPosition(position);
  const isOption = classified.kind !== "EQUITY_OR_OTHER";
  const isShortOption = isOption && position.quantity < 0;
  const quantityLabel = isOption
    ? optionQuantityLabel(position.quantity, classified.optionType)
    : `${position.quantity} sh`;
  const valueLabel = isShortOption ? "Cost to close" : "Market value";
  const value = isShortOption ? Math.abs(position.marketValue) : position.marketValue;

  if (!isOption || classified.strike === null || classified.expiration === null || classified.optionType === null) {
    return { title: classified.underlying, detailLine: null, quantityLabel, valueLabel, value };
  }

  const optionLabel = classified.optionType === "PUT" ? "Put" : "Call";
  const expirationLabel = classified.expiration.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return {
    title: classified.underlying,
    detailLine: `${expirationLabel} · $${classified.strike.toFixed(2)} ${optionLabel}`,
    quantityLabel,
    valueLabel,
    value,
  };
}
