import "server-only";

import { classifyBrokerPosition } from "@/domain/finance/brokerPositions";
import { parseOccOptionSymbol } from "@/domain/finance/occOption";
import type { BrokerPosition } from "@/providers/broker-read/types";
import { prisma } from "./prisma";
import { createCampaignForUser } from "./workflows";
import { ValidationError } from "./tickers";

export type BrokerActivityAwaitingReview = {
  brokerRecordId: string;
  symbol: string;
  underlyingSymbol: string | null;
  accountId: string | null;
  quantity: number;
  optionType: "PUT" | "CALL" | null;
  strike: number | null;
  expiration: string | null;
  transactionEvidenceCount: number;
  likelyCsp: boolean;
  suggestedTicker: string;
  suggestedStrike: number | null;
  suggestedExpiration: string | null;
  suggestedPremium: number | null;
  suggestedTradeDate: string | null;
  suggestedContracts: number;
};

/**
 * Surfaces the user's own confirmed, currently-open broker POSITION records that have
 * never been linked to an OSO Campaign (and haven't been explicitly skipped), so the
 * Tracker can show "Broker activity awaiting review." Only the latest snapshot per
 * (account, symbol) is treated as "current" - an older superseded snapshot is not shown
 * even if it happens to still be quantity != 0 in isolation.
 */
export async function getBrokerActivityAwaitingReviewForUser(userId: string): Promise<BrokerActivityAwaitingReview[]> {
  const positions = await prisma.brokerRecord.findMany({
    where: { userId, provider: "SCHWAB", kind: "POSITION", linkedCampaignId: null, reconciliationDismissedAt: null, status: "CONFIRMED" },
    orderBy: { observedAt: "desc" },
  });

  const latestBySymbol = new Map<string, (typeof positions)[number]>();
  for (const position of positions) {
    const key = `${position.accountId ?? "none"}|${position.symbol ?? ""}`;
    const existing = latestBySymbol.get(key);
    if (!existing || (position.observedAt?.getTime() ?? 0) > (existing.observedAt?.getTime() ?? 0)) {
      latestBySymbol.set(key, position);
    }
  }

  const openPositions = [...latestBySymbol.values()].filter((position) => Number(position.quantity ?? 0) !== 0);
  const evidenceByPositionId = await loadBrokerTransactionEvidenceForPositions(userId, openPositions);
  const results: BrokerActivityAwaitingReview[] = [];

  for (const position of openPositions) {
    const evidence = evidenceByPositionId.get(position.id) ?? { transactionEvidenceCount: 0, openingTransaction: null };

    const classified = classifyBrokerPosition({
      accountId: position.accountId ?? "unknown",
      symbol: position.symbol ?? "",
      quantity: Number(position.quantity ?? 0),
      marketValue: Number(position.amount ?? 0),
    });

    results.push({
      brokerRecordId: position.id,
      symbol: position.symbol ?? "",
      underlyingSymbol: position.underlyingSymbol,
      accountId: position.accountId,
      quantity: Number(position.quantity ?? 0),
      optionType: classified.optionType,
      strike: classified.strike,
      expiration: classified.expiration?.toISOString() ?? null,
      transactionEvidenceCount: evidence.transactionEvidenceCount,
      likelyCsp: classified.kind === "SHORT_PUT",
      suggestedTicker: position.underlyingSymbol ?? classified.underlying,
      suggestedStrike: classified.strike,
      suggestedExpiration: classified.expiration ? classified.expiration.toISOString().slice(0, 10) : null,
      suggestedPremium:
        evidence.openingTransaction?.price !== null && evidence.openingTransaction?.price !== undefined
          ? Math.abs(Number(evidence.openingTransaction.price))
          : null,
      suggestedTradeDate: evidence.openingTransaction?.occurredAt
        ? evidence.openingTransaction.occurredAt.toISOString().slice(0, 10)
        : null,
      suggestedContracts: Math.abs(Number(position.quantity ?? 0)) || 1,
    });
  }

  return results;
}

type BrokerRecordPosition = Awaited<ReturnType<typeof prisma.brokerRecord.findMany>>[number];
type BrokerTransactionEvidence = {
  transactionEvidenceCount: number;
  openingTransaction: BrokerRecordPosition | null;
};

async function loadBrokerTransactionEvidenceForPositions(
  userId: string,
  positions: BrokerRecordPosition[],
): Promise<Map<string, BrokerTransactionEvidence>> {
  const evidenceByPositionId = new Map<string, BrokerTransactionEvidence>();
  if (positions.length === 0) {
    return evidenceByPositionId;
  }

  const symbols = [...new Set(positions.map((position) => position.symbol).filter((symbol): symbol is string => symbol !== null))];
  const [counts, openingTransactions] =
    symbols.length === 0
      ? [[], []]
      : await Promise.all([
          prisma.brokerRecord.groupBy({
            by: ["symbol"],
            where: { userId, provider: "SCHWAB", kind: "TRANSACTION", symbol: { in: symbols } },
            _count: { _all: true },
          }),
          prisma.brokerRecord.findMany({
            where: { userId, provider: "SCHWAB", kind: "TRANSACTION", symbol: { in: symbols }, action: "Sell to Open" },
            orderBy: { occurredAt: "asc" },
          }),
        ]);
  const countBySymbol = new Map(counts.flatMap((row) => (row.symbol === null ? [] : [[row.symbol, row._count._all]])));
  const openingBySymbol = new Map<string, BrokerRecordPosition>();
  for (const transaction of openingTransactions) {
    if (transaction.symbol !== null && !openingBySymbol.has(transaction.symbol)) {
      openingBySymbol.set(transaction.symbol, transaction);
    }
  }

  for (const position of positions) {
    if (position.symbol !== null) {
      evidenceByPositionId.set(position.id, {
        transactionEvidenceCount: countBySymbol.get(position.symbol) ?? 0,
        openingTransaction: openingBySymbol.get(position.symbol) ?? null,
      });
      continue;
    }

    const [transactionEvidenceCount, openingTransaction] = await Promise.all([
      prisma.brokerRecord.count({ where: { userId, provider: "SCHWAB", kind: "TRANSACTION" } }),
      prisma.brokerRecord.findFirst({
        where: { userId, provider: "SCHWAB", kind: "TRANSACTION", action: "Sell to Open" },
        orderBy: { occurredAt: "asc" },
      }),
    ]);
    evidenceByPositionId.set(position.id, { transactionEvidenceCount, openingTransaction });
  }

  return evidenceByPositionId;
}

/**
 * Confirms a piece of broker evidence as a real Campaign. Reuses the existing Campaign
 * creation workflow (never a second P/L engine) and then durably links the broker
 * position record to the resulting Campaign so it is counted once, not twice, on the
 * Dashboard/Tracker (see getLinkedCampaignSymbolsForUser).
 */
export async function confirmBrokerPositionAsCampaignForUser(
  userId: string,
  brokerRecordId: string,
  accountId: string,
  tickerInput: unknown,
  tradeDateInput: unknown,
  expirationInput: unknown,
  strikeInput: unknown,
  contractsInput: unknown,
  premiumInput: unknown,
  feesInput: unknown,
  notesInput: unknown,
  visibilityInput: unknown,
) {
  const position = await prisma.brokerRecord.findFirst({ where: { id: brokerRecordId, userId, provider: "SCHWAB", kind: "POSITION" } });
  if (!position) {
    throw new ValidationError("Broker position not found.");
  }
  if (position.linkedCampaignId) {
    throw new ValidationError("This position is already linked to a campaign.");
  }

  const campaign = await createCampaignForUser(
    userId,
    accountId,
    tickerInput,
    tradeDateInput,
    expirationInput,
    strikeInput,
    contractsInput,
    premiumInput,
    feesInput,
    notesInput,
    visibilityInput,
  );

  await prisma.brokerRecord.update({ where: { id: position.id }, data: { linkedCampaignId: campaign.id } });
  return campaign;
}

/** Links a piece of broker evidence to an existing (already-tracked) campaign instead of creating a new one. */
export async function linkBrokerPositionToExistingCampaignForUser(userId: string, brokerRecordId: string, campaignId: string) {
  const [position, campaign] = await Promise.all([
    prisma.brokerRecord.findFirst({ where: { id: brokerRecordId, userId, provider: "SCHWAB", kind: "POSITION" } }),
    prisma.campaign.findFirst({ where: { id: campaignId, ownerId: userId } }),
  ]);
  if (!position) {
    throw new ValidationError("Broker position not found.");
  }
  if (position.linkedCampaignId) {
    throw new ValidationError("This position is already linked to a campaign.");
  }
  if (!campaign) {
    throw new ValidationError("Choose one of your own campaigns.");
  }

  return prisma.brokerRecord.update({ where: { id: position.id }, data: { linkedCampaignId: campaign.id } });
}

/** "Skip / Leave unlinked" - never silently creates Campaign history; just stops nagging. */
export async function skipBrokerReconciliationForUser(userId: string, brokerRecordId: string) {
  const position = await prisma.brokerRecord.findFirst({ where: { id: brokerRecordId, userId, provider: "SCHWAB", kind: "POSITION" } });
  if (!position) {
    throw new ValidationError("Broker position not found.");
  }

  return prisma.brokerRecord.update({ where: { id: position.id }, data: { reconciliationDismissedAt: new Date() } });
}

/**
 * Bridges the LIVE Schwab positions (`getSchwabOpenPositionsForUser`, fetched fresh on
 * every page load, never persisted) against the persisted, reconciled `BrokerRecord`
 * table: returns the set of option symbols the user has already linked to a Campaign, so
 * the Dashboard/Tracker can count a linked live position once (via its Campaign) instead
 * of twice (Campaign + raw broker position). Matches on the normalized OCC-style option
 * symbol itself - deliberately NOT the internal per-source account key - since the same
 * option contract must be recognized as "the same position" whether it was originally
 * reconciled from a live sync or a CSV import.
 */
export async function getLinkedCampaignSymbolsForUser(userId: string, positions: BrokerPosition[]): Promise<Set<string>> {
  const symbols = positions
    .map((position) => normalizeSymbolForLinking(position.symbol))
    .filter((symbol): symbol is string => Boolean(symbol));
  if (symbols.length === 0) {
    return new Set();
  }

  const linked = await prisma.brokerRecord.findMany({
    where: { userId, provider: "SCHWAB", kind: "POSITION", symbol: { in: symbols }, linkedCampaignId: { not: null } },
    select: { symbol: true },
  });

  return new Set(linked.flatMap((row) => (row.symbol ? [row.symbol] : [])));
}

export type BrokerPositionDedupeResult = {
  unlinked: BrokerPosition[];
  linked: BrokerPosition[];
};

/**
 * Splits a user's live broker positions into those already reconciled to an open
 * Campaign (and so already represented in the Dashboard's campaign-derived numbers) and
 * those that are not - so callers never count a linked position a second time. See
 * getLinkedCampaignSymbolsForUser for the matching rule.
 */
export async function splitBrokerPositionsByCampaignLink(userId: string, positions: BrokerPosition[]): Promise<BrokerPositionDedupeResult> {
  const linkedSymbols = await getLinkedCampaignSymbolsForUser(userId, positions);
  const unlinked: BrokerPosition[] = [];
  const linked: BrokerPosition[] = [];
  for (const position of positions) {
    const symbol = normalizeSymbolForLinking(position.symbol);
    if (symbol && linkedSymbols.has(symbol)) {
      linked.push(position);
    } else {
      unlinked.push(position);
    }
  }
  return { unlinked, linked };
}

function normalizeSymbolForLinking(rawSymbol: string): string | null {
  const parsed = parseOccOptionSymbol(rawSymbol);
  if (!parsed) {
    return null;
  }
  const year = String(parsed.expiration.getUTCFullYear() % 100).padStart(2, "0");
  const month = String(parsed.expiration.getUTCMonth() + 1).padStart(2, "0");
  const day = String(parsed.expiration.getUTCDate()).padStart(2, "0");
  const putCall = parsed.optionType === "PUT" ? "P" : "C";
  const strike = String(Math.round(parsed.strike * 1000)).padStart(8, "0");
  return `${parsed.underlying} ${year}${month}${day}${putCall}${strike}`;
}
