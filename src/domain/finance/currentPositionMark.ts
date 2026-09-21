import { round } from "./calculations";
import type { CurrentOpenPut } from "./campaigns";
import { classifyMarkFreshness } from "./marketCalendar";
import { parseOccOptionSymbol } from "./occOption";

export type CurrentCostToCloseSource = {
  costToClose: number;
  source: "LINKED_BROKER_POSITION" | "CACHED_OPTION_MARK";
  label: string;
  asOf: Date;
  freshness: "CURRENT_SESSION" | "LAST_SESSION";
};

export type LinkedPositionRecordInput = {
  accountId: string | null;
  symbol: string | null;
  underlyingSymbol?: string | null;
  quantity: unknown;
  amount: unknown;
  /** Retrieval/export observation time: orders observations, but does not date their valuation. */
  observedAt: Date | null;
  /** valuationAsOf may contain a verified provider valuation timestamp. Absent for legacy rows. */
  metadata: unknown;
};

export type OptionMarkSnapshotInput = {
  mark: unknown;
  bid: unknown;
  ask: unknown;
  capturedAt: Date | null;
  /** Must come from the price source, not the database insertion time. */
  valuationAsOf?: Date | null;
};

/** Inclusive half-cent tolerance, with only floating point representation error allowed. */
export function sameStrike(a: number, b: number): boolean {
  return Number.isFinite(a) && Number.isFinite(b) &&
    Math.abs(a - b) <= 0.005 + Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)) * 2;
}

/** The owner-scoped caller supplies getCurrentOpenPut's result. Select the latest observation
 * for the account/contract BEFORE checking its quantity/value. A contradiction cannot be
 * repaired by selecting older evidence or a generic quote for a different-sized obligation.
 */
export function resolveCurrentCostToClose({
  campaignStatus, campaignAccountId, campaignTicker, activePut, linkedRecords, optionMark, now,
}: {
  campaignStatus: string;
  campaignAccountId: string;
  campaignTicker: string;
  activePut: CurrentOpenPut | null;
  linkedRecords: LinkedPositionRecordInput[];
  optionMark: OptionMarkSnapshotInput | null;
  now: Date;
}): CurrentCostToCloseSource | null {
  if (campaignStatus !== "OPEN" || !activePut || !Number.isInteger(activePut.contracts) || activePut.contracts <= 0 ||
      !Number.isFinite(activePut.expiration.getTime()) || !Number.isFinite(activePut.strike) || activePut.strike <= 0) return null;
  const ticker = campaignTicker.trim().toUpperCase();
  const candidates = linkedRecords.filter((record) => {
    if (record.accountId !== campaignAccountId || !record.symbol) return false;
    const contract = parseOccOptionSymbol(record.symbol);
    return contract !== null && contract.optionType === "PUT" && contract.underlying === ticker &&
      sameStrike(contract.strike, activePut.strike) && sameUtcCalendarDate(contract.expiration, activePut.expiration);
  });

  if (candidates.length) {
    // Undated or future observations cannot be safely ordered against the dated ones.
    if (candidates.some((record) => !record.observedAt || !Number.isFinite(record.observedAt.getTime()) || record.observedAt > now)) return null;
    const newestTime = Math.max(...candidates.map((record) => record.observedAt!.getTime()));
    const newest = candidates.filter((record) => record.observedAt!.getTime() === newestTime);
    const values = newest.map((record) => {
      const metadata = objectValue(record.metadata);
      return {
        record,
        metadata,
        quantity: toNullableNumber(record.quantity),
        amount: toNullableNumber(record.amount),
        valuationAsOf: dateValue(metadata?.valuationAsOf),
      };
    });
    // Equal-time conflicting observations have no authoritative winner (including missing vs known).
    const signature = (value: typeof values[number]) => JSON.stringify([
      value.quantity, value.amount, value.valuationAsOf?.getTime() ?? null,
      value.record.symbol?.trim().replace(/\s+/g, "").toUpperCase(),
      value.record.underlyingSymbol ?? null, value.metadata?.putCall ?? null,
      value.metadata?.assetType ?? null, value.metadata?.strikePrice ?? null,
      value.metadata?.underlyingSymbol ?? null, value.metadata?.observationConflict ?? false,
    ]);
    if (new Set(values.map(signature)).size !== 1) return null;
    const latest = values[0];
    const { metadata, record } = latest;
    if (metadata?.observationConflict === true || latest.quantity !== -activePut.contracts ||
        (metadata?.putCall != null && metadata.putCall !== "PUT") ||
        (metadata?.assetType != null && metadata.assetType !== "OPTION" && metadata.assetType !== "Option") ||
        (record.underlyingSymbol != null && record.underlyingSymbol.trim().toUpperCase() !== ticker) ||
        (metadata?.underlyingSymbol != null && String(metadata.underlyingSymbol).trim().toUpperCase() !== ticker) ||
        (metadata?.strikePrice != null && !sameStrike(toNullableNumber(metadata.strikePrice) ?? NaN, activePut.strike))) return null;
    const freshness = classifyMarkFreshness(latest.valuationAsOf, now);
    if (latest.amount !== null && latest.valuationAsOf && latest.valuationAsOf <= record.observedAt! &&
        (freshness === "CURRENT_SESSION" || freshness === "LAST_SESSION")) {
      return {
        costToClose: round(Math.abs(latest.amount), 2), source: "LINKED_BROKER_POSITION",
        label: "Linked Schwab position", asOf: latest.valuationAsOf, freshness,
      };
    }
    // Identity and quantity agree, but a missing/stale value may use an independently dated quote.
  }

  if (!optionMark) return null;
  if (optionMark.capturedAt && (!Number.isFinite(optionMark.capturedAt.getTime()) || optionMark.capturedAt > now ||
      (optionMark.valuationAsOf && optionMark.valuationAsOf > optionMark.capturedAt))) return null;
  const freshness = classifyMarkFreshness(optionMark.valuationAsOf ?? null, now);
  if (freshness !== "CURRENT_SESSION" && freshness !== "LAST_SESSION") return null;
  const mark = toNullableNumber(optionMark.mark);
  const bid = toNullableNumber(optionMark.bid);
  const ask = toNullableNumber(optionMark.ask);
  // Reject corrupt supplied numbers even when another field looks usable.
  if ([optionMark.mark, optionMark.bid, optionMark.ask].some((raw) =>
    raw != null && raw !== "" && (toNullableNumber(raw) === null || toNullableNumber(raw)! < 0))) return null;
  if (bid !== null && ask !== null && (ask < bid || (bid === 0 && ask === 0))) return null;
  const midpoint = bid !== null && ask !== null && ask > 0 ? (bid + ask) / 2 : null;
  const markPerShare = mark !== null && mark > 0 ? mark : midpoint;
  // An empty/zero quote is not proof of a worthless contract. A verified broker $0 above is different.
  if (markPerShare === null || markPerShare <= 0) return null;
  return {
    costToClose: round(markPerShare * activePut.contracts * 100, 2), source: "CACHED_OPTION_MARK",
    label: "Cached option mark", asOf: optionMark.valuationAsOf!, freshness,
  };
}

function sameUtcCalendarDate(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function dateValue(value: unknown): Date | null {
  if (!(value instanceof Date) && typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim()) || typeof value === "boolean") return null;
  const candidate = value as { toNumber?: () => number };
  const parsed = typeof candidate.toNumber === "function" ? candidate.toNumber() : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
