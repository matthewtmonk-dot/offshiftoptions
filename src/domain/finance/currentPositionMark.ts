import { classifyBrokerPosition } from "./brokerPositions";
import { round } from "./calculations";
import type { CurrentOpenPut } from "./campaigns";
import { classifyMarkFreshness, type MarkFreshness } from "./marketCalendar";
import type { BrokerPosition } from "@/providers/broker-read/types";

/**
 * Ticket 5 (PROJECT_HANDOFF.md): the single source of truth for "is this evidence trustworthy
 * enough to value a campaign's CURRENT open put right now" - used by the Tracker's Performance
 * tab. Extracted into the domain layer (not left as page-local logic) for the same reason Ticket
 * 4 carried completeness through finance/domain outputs rather than UI-only guesses: this is a
 * financial-correctness question, not a presentation concern, and it needs direct unit test
 * coverage independent of Next.js page rendering.
 *
 * Root cause this fixes: a campaign's linked broker POSITION records accumulate over its whole
 * life - including, for a rolled campaign, the PRE-ROLL contract's own historical snapshot,
 * which stays linked. The prior logic accepted the first linked SHORT_PUT record found merely
 * because it belonged to the campaign, with no check that it was the SAME contract as the
 * campaign's current open put. This module never accepts a record as "current" without
 * validating every identity field this domain already models (account, underlying, option type,
 * strike, expiration, quantity) against getCurrentOpenPut's own answer (the single authoritative
 * current-leg definition - see Ticket 1) AND a conservative freshness check.
 */
export type CurrentCostToCloseSource = {
  costToClose: number;
  source: "LINKED_BROKER_POSITION" | "CACHED_OPTION_MARK";
  label: string;
  asOf: Date | null;
  /** CURRENT_SESSION/LAST_SESSION are the only values a source is ever built with - STALE/MISSING
   * marks are rejected before a CurrentCostToCloseSource exists at all (see classifyMarkFreshness,
   * marketCalendar.ts). LAST_SESSION must be labeled "as of last session," never a live quote. */
  freshness: MarkFreshness;
};

export type LinkedPositionRecordInput = {
  /** The campaign's OWN internal TradingAccount id, if the record carries one - compared
   * against the campaign's own accountId; a mismatch (or a record with no account at all) is
   * never accepted, regardless of any other field matching. */
  accountId: string | null;
  symbol: string | null;
  underlyingSymbol?: string | null;
  quantity: unknown;
  /** The position's market value (Schwab's own signed dollar amount) - cost to close a short
   * option is its absolute value. */
  amount: unknown;
  observedAt: Date | null;
  metadata: unknown;
};

export type OptionMarkSnapshotInput = {
  mark: unknown;
  bid: unknown;
  ask: unknown;
  capturedAt: Date | null;
};

/**
 * Resolves the current cost-to-close for an OPEN campaign's current put, or null when no
 * sufficiently-validated evidence exists. Never substitutes a historical/mismatched contract,
 * never fabricates a zero, and never accepts stale or undated evidence - a null result is the
 * honest answer that lets the caller's completeness model (see performance.ts,
 * CampaignProgressSummary.currentPLStatus) correctly show PENDING/INCOMPLETE rather than a
 * confident but wrong number.
 */
export function resolveCurrentCostToClose({
  campaignStatus,
  campaignAccountId,
  campaignTicker,
  activePut,
  linkedRecords,
  optionMark,
  now,
}: {
  campaignStatus: string;
  campaignAccountId: string;
  campaignTicker: string;
  /** getCurrentOpenPut's own result for this campaign - null means there is no current open put
   * to value at all (already closed, or evidence incomplete - see getOpenPutEvidenceState). */
  activePut: CurrentOpenPut | null;
  linkedRecords: LinkedPositionRecordInput[];
  optionMark: OptionMarkSnapshotInput | null;
  now: Date;
}): CurrentCostToCloseSource | null {
  if (campaignStatus !== "OPEN" || !activePut) {
    return null;
  }

  const linked = resolveCurrentLinkedShortPut({ campaignAccountId, campaignTicker, activePut, linkedRecords }, now);
  if (linked) {
    return linked;
  }

  if (!optionMark) {
    return null;
  }
  const freshness = classifyMarkFreshness(optionMark.capturedAt, now);
  if (freshness === "STALE" || freshness === "MISSING") {
    return null;
  }

  const mark = toNullableNumber(optionMark.mark);
  const bid = toNullableNumber(optionMark.bid);
  const ask = toNullableNumber(optionMark.ask);
  const midpoint = bid === null || ask === null ? null : (bid + ask) / 2;
  const markPerShare = mark !== null && mark > 0 ? mark : midpoint;
  if (markPerShare === null) {
    return null;
  }

  return {
    costToClose: round(markPerShare * activePut.contracts * 100, 2),
    source: "CACHED_OPTION_MARK",
    label: "Cached option mark",
    asOf: optionMark.capturedAt,
    freshness,
  };
}

/** Validates every linked POSITION record against the campaign's own account, underlying,
 * option type, strike, expiration, short quantity, and observation freshness before ever
 * accepting it as the source for a CURRENT cost-to-close. Owner/user scoping is the caller's
 * responsibility (the query that produces `linkedRecords` must already be scoped to the
 * authenticated user - see src/lib/app-data.ts) - this function only validates the identity
 * fields that distinguish one contract/account from another once ownership is already assured. */
function resolveCurrentLinkedShortPut(
  {
    campaignAccountId,
    campaignTicker,
    activePut,
    linkedRecords,
  }: {
    campaignAccountId: string;
    campaignTicker: string;
    activePut: CurrentOpenPut;
    linkedRecords: LinkedPositionRecordInput[];
  },
  now: Date,
): CurrentCostToCloseSource | null {
  for (const record of linkedRecords) {
    if (record.accountId !== campaignAccountId) {
      continue; // wrong brokerage account - never value one account's campaign from another's position
    }

    const position = brokerPositionFromRecord(record);
    if (!position) {
      continue;
    }

    const classified = classifyBrokerPosition(position);
    if (classified.kind !== "SHORT_PUT") {
      continue; // wrong option type, long instead of short, or unclassifiable
    }
    if (classified.underlying.trim().toUpperCase() !== campaignTicker.trim().toUpperCase()) {
      continue; // wrong underlying ticker
    }
    if (classified.strike === null || !sameMoneyValue(classified.strike, activePut.strike)) {
      continue; // wrong strike - e.g. the pre-roll contract's own strike
    }
    if (classified.expiration === null || !sameUtcCalendarDate(classified.expiration, activePut.expiration)) {
      continue; // wrong expiration - e.g. the pre-roll contract's own expiration
    }
    if (position.quantity !== -activePut.contracts) {
      continue; // wrong quantity/contracts - never assume a partial or mismatched size still applies
    }

    const freshness = classifyMarkFreshness(record.observedAt, now);
    if (freshness === "STALE" || freshness === "MISSING") {
      continue; // an identity match with no usable freshness is still not a current mark
    }

    return {
      costToClose: round(Math.abs(position.marketValue), 2),
      source: "LINKED_BROKER_POSITION",
      label: "Linked Schwab position",
      asOf: record.observedAt,
      freshness,
    };
  }

  return null;
}

function brokerPositionFromRecord(record: LinkedPositionRecordInput): BrokerPosition | null {
  const symbol = record.symbol;
  const quantity = toNullableNumber(record.quantity);
  const marketValue = toNullableNumber(record.amount);
  if (!symbol || quantity === null || marketValue === null) {
    return null;
  }

  const metadata = objectValue(record.metadata);
  const putCallRaw = stringValue(metadata?.putCall);
  return {
    accountId: record.accountId ?? stringValue(metadata?.accountId) ?? "linked-broker-record",
    symbol,
    quantity,
    marketValue,
    assetType: stringValue(metadata?.assetType),
    putCall: putCallRaw === "PUT" || putCallRaw === "CALL" ? putCallRaw : null,
    strikePrice: toNullableNumber(metadata?.strikePrice),
    underlyingSymbol: record.underlyingSymbol ?? stringValue(metadata?.underlyingSymbol),
  };
}

function sameMoneyValue(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

function sameUtcCalendarDate(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const candidate = value as { toNumber?: () => number };
  const parsed = typeof candidate.toNumber === "function" ? candidate.toNumber() : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
