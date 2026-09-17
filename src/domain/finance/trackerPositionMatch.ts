import { occContractKey, parseOccOptionSymbol } from "./occOption";
import type { BrokerPosition } from "@/providers/broker-read/types";

type Position = Pick<BrokerPosition, "accountId" | "symbol" | "quantity" | "assetType" | "putCall" | "strikePrice" | "underlyingSymbol">;
type Account = { id: string; userId: string; externalAccountId: string | null };
export type TrackedPut = {
  id: string;
  ownerId: string;
  accountId: string;
  ticker: string;
  status: string;
  strike: number;
  expiration: Date;
  contracts: number;
};

/** Same OCC-style key as occContractKey, computed from a tracked campaign's own current-put
 * fields instead of a raw broker symbol - the two are compared directly in matchTrackedPut below.
 * Extracted so a caller that already knows a position is EXACT (see exactMatchedCampaignId) can
 * find which specific campaign that was, without re-deriving this template separately. */
function campaignContractKey(campaign: TrackedPut): string | null {
  if (!Number.isFinite(campaign.expiration.getTime()) || !Number.isFinite(campaign.strike) || campaign.strike <= 0) {
    return null;
  }
  return `${campaign.ticker.trim().toUpperCase()}|${campaign.expiration.toISOString().slice(0, 10)}|PUT|${Math.round(campaign.strike * 1000)}`;
}

/** Display-only identity check. Never writes a link or changes accounting/deduplication. */
export function matchTrackedPut(
  userId: string,
  position: Position,
  positions: Position[],
  accounts: Account[],
  campaigns: TrackedPut[],
): "EXACT" | "AMBIGUOUS" | "NONE" {
  const key = occContractKey(position.symbol);
  const contract = parseOccOptionSymbol(position.symbol);
  if (!key || !key.includes("|PUT|") || !Number.isInteger(position.quantity) || position.quantity >= 0) return "NONE";
  if ((position.assetType && position.assetType !== "OPTION") || (position.putCall && position.putCall !== "PUT") ||
    (position.strikePrice != null && position.strikePrice !== contract?.strike) ||
    (position.underlyingSymbol && position.underlyingSymbol.trim().toUpperCase() !== contract?.underlying)) return "NONE";
  const ownAccounts = accounts.filter((account) => account.userId === userId && account.externalAccountId === position.accountId);
  if (ownAccounts.length !== 1) return ownAccounts.length ? "AMBIGUOUS" : "NONE";
  const candidates = campaigns.filter((campaign) =>
    campaign.ownerId === userId && campaign.accountId === ownAccounts[0].id && campaign.status === "OPEN" &&
    campaignContractKey(campaign) === key,
  );
  // Multiple tracked campaigns or provider rows for one account/contract need review, even
  // if one happens to have the expected quantity. Never pick the first plausible candidate.
  const samePositions = positions.filter((other) => other.accountId === position.accountId && occContractKey(other.symbol) === key);
  if (candidates.length > 1 || (candidates.length && samePositions.length !== 1)) return "AMBIGUOUS";
  return candidates.length === 1 && candidates[0].contracts === -position.quantity ? "EXACT" : "NONE";
}

/**
 * Which specific campaign an EXACT match corresponds to - matchTrackedPut itself only returns the
 * match tier, not attribution, because most callers (the Tracker's own position badge) only need
 * to know the tier. A caller that needs to mark one particular campaign as broker-confirmed (e.g.
 * the Dashboard) calls this only after matchTrackedPut has already returned "EXACT" for the same
 * position; it re-derives nothing about uniqueness or ownership, it only reports which of the
 * already-guaranteed-unique candidates that was. Returns null for anything other than a genuine
 * EXACT match, so a caller can never mistake an ambiguous or absent match for a specific id.
 */
export function exactMatchedCampaignId(
  userId: string,
  position: Position,
  positions: Position[],
  accounts: Account[],
  campaigns: TrackedPut[],
): string | null {
  if (matchTrackedPut(userId, position, positions, accounts, campaigns) !== "EXACT") {
    return null;
  }
  const key = occContractKey(position.symbol);
  const ownAccount = accounts.find((account) => account.userId === userId && account.externalAccountId === position.accountId);
  return campaigns.find((campaign) => campaign.accountId === ownAccount?.id && campaignContractKey(campaign) === key)?.id ?? null;
}

export type TrackerPositionMatchState = "LINKED" | "EXACT" | "AMBIGUOUS" | "NONE";

/**
 * A persisted BrokerRecord link (confirmed under Accounts -> Broker Activity Awaiting Review)
 * always takes precedence over this file's display-only inference - including when the linked
 * campaign is no longer OPEN, since matchTrackedPut would otherwise return NONE for it.
 */
export function resolveTrackerPositionMatchState(
  isLinked: boolean,
  inferredMatch: "EXACT" | "AMBIGUOUS" | "NONE",
): TrackerPositionMatchState {
  return isLinked ? "LINKED" : inferredMatch;
}

/** A broker position joined with its persisted link, if any - the caller (e.g. the Dashboard)
 * does that join (see getLinkedCampaignIdsBySymbolForUser), since normalizing a raw Schwab symbol
 * for the link lookup is a lib-layer concern, not something this pure domain module should need
 * to import. `null` means no persisted BrokerRecord.linkedCampaignId exists for this position. */
export type DashboardPositionInput = Position & { linkedCampaignId: string | null };

export type DashboardPositionMatch<P extends DashboardPositionInput> = {
  position: P;
  disposition: TrackerPositionMatchState;
  /** Which campaign this position confirms, for a LINKED or EXACT disposition - null for
   * AMBIGUOUS/NONE, and also null for a LINKED position whose linkedCampaignId doesn't resolve to
   * one of the given campaigns (never guessed - see exactMatchedCampaignId's own contract). */
  confirmedCampaignId: string | null;
};

/**
 * Applies the Tracker's own persisted-link-then-EXACT-match precedence across a full set of
 * broker positions at once, for a caller that must decide, for every position, whether it is
 * already represented by a tracked campaign (the Dashboard's duplicate-position cleanup). Not a
 * new matching algorithm - it only assembles matchTrackedPut/resolveTrackerPositionMatchState/
 * exactMatchedCampaignId's existing per-position results into one pass, with the exact same
 * user-scoped/account-scoped/contract-specific/quantity-aware/unique guarantees. Pure: makes no
 * database or network call, creates no persisted link, and never mutates any input.
 */
export function matchDashboardPositions<P extends DashboardPositionInput>(
  userId: string,
  positions: P[],
  accounts: Account[],
  campaigns: TrackedPut[],
): DashboardPositionMatch<P>[] {
  return positions.map((position) => {
    const inferredMatch = matchTrackedPut(userId, position, positions, accounts, campaigns);
    const disposition = resolveTrackerPositionMatchState(Boolean(position.linkedCampaignId), inferredMatch);
    const confirmedCampaignId =
      disposition === "LINKED"
        ? position.linkedCampaignId
        : disposition === "EXACT"
          ? exactMatchedCampaignId(userId, position, positions, accounts, campaigns)
          : null;
    return { position, disposition, confirmedCampaignId };
  });
}
