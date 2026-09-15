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
    Number.isFinite(campaign.expiration.getTime()) && Number.isFinite(campaign.strike) && campaign.strike > 0 &&
    `${campaign.ticker.trim().toUpperCase()}|${campaign.expiration.toISOString().slice(0, 10)}|PUT|${Math.round(campaign.strike * 1000)}` === key,
  );
  // Multiple tracked campaigns or provider rows for one account/contract need review, even
  // if one happens to have the expected quantity. Never pick the first plausible candidate.
  const samePositions = positions.filter((other) => other.accountId === position.accountId && occContractKey(other.symbol) === key);
  if (candidates.length > 1 || (candidates.length && samePositions.length !== 1)) return "AMBIGUOUS";
  return candidates.length === 1 && candidates[0].contracts === -position.quantity ? "EXACT" : "NONE";
}
