import "server-only";

import { getCurrentOpenPut } from "@/domain/finance/campaigns";
import { classifyBrokerTransactionActivity } from "@/domain/finance/brokerTransactionActions";
import { isSameOccContract, occContractKey } from "@/domain/finance/occOption";
import {
  findClosingEvidence,
  findRollPairedOpeningTransactionIds,
  evaluateWorthlessExpiration,
  parseOpeningPutTransaction,
  type ReconciliationTransaction,
  type SchwabReconciliationEvidence,
} from "@/domain/finance/schwabReconciliation";
import { prisma } from "./prisma";
import {
  assignCampaignPutForUser,
  closeCampaignPutForUser,
  createCampaignForUser,
  expireCampaignPutForUser,
  rollCampaignPutForUser,
} from "./workflows";

export type SchwabReconciliationSummary = {
  campaignsOpened: number;
  campaignsClosed: number;
  campaignsRolled: number;
  campaignsAssigned: number;
  campaignsExpired: number;
  expirationsDeferred: number;
  expirationDeferralReason: "EXPIRATION_EVIDENCE_INCOMPLETE" | null;
};

/**
 * Which of these campaigns have at least one Schwab-sourced transaction whose fee Schwab
 * either didn't report or this code couldn't confidently parse (`BrokerRecord.fees IS NULL` -
 * already distinct from a real, reported $0 fee across both the CSV and live-API ingestion
 * paths - see providers/schwab/csv.ts and broker-read.ts). A manually-created campaign has no
 * linked BrokerRecord at all and is never flagged here - its human-entered fee (defaulting to
 * $0 when left blank) has always been treated as "known" by product design. This never changes
 * any P/L number - it only tells the caller whether a campaign's realized/net figure is exact
 * or still has an unresolved fee baked in as an assumed $0, so the UI can say so honestly
 * instead of presenting an unverified number as a confirmed "Net P/L."
 */
export async function getCampaignIdsWithUnknownFees(campaignIds: string[]): Promise<Set<string>> {
  if (campaignIds.length === 0) {
    return new Set();
  }

  const rows = await prisma.brokerRecord.findMany({
    where: { linkedCampaignId: { in: campaignIds }, kind: "TRANSACTION", fees: null },
    select: { linkedCampaignId: true },
  });

  return new Set(rows.flatMap((row) => (row.linkedCampaignId ? [row.linkedCampaignId] : [])));
}

/**
 * Runs at the end of every Schwab sync (see syncSchwabAccountForUser). Turns this account's
 * unlinked, confirmed broker transactions into campaign history automatically, and closes any
 * open campaign whose put has genuinely expired - so a Schwab-connected user never has to
 * hand-enter what Schwab already reported. Everything is scoped to the authenticated user's
 * own account; nothing here ever trusts a client-supplied id. Idempotent by construction: an
 * opening transaction is only ever consumed once it's linked to a campaign (linkedCampaignId),
 * and closeCampaignPutForUser/rollCampaignPutForUser/assignCampaignPutForUser/
 * expireCampaignPutForUser all refuse to act on a campaign that isn't OPEN - so re-running this
 * against the same synced data can never create a duplicate campaign or a duplicate event.
 */
export async function reconcileSchwabActivityForUser(
  userId: string,
  accountId: string,
  evidence: SchwabReconciliationEvidence,
  asOf: Date = new Date(),
): Promise<SchwabReconciliationSummary> {
  const summary: SchwabReconciliationSummary = {
    campaignsOpened: 0,
    campaignsClosed: 0,
    campaignsRolled: 0,
    campaignsAssigned: 0,
    campaignsExpired: 0,
    expirationsDeferred: 0,
    expirationDeferralReason: null,
  };

  const unlinked = await prisma.brokerRecord.findMany({
    where: { userId, accountId, provider: "SCHWAB", kind: "TRANSACTION", status: "CONFIRMED", linkedCampaignId: null },
    // `id` as a tiebreaker guarantees deterministic ordering even when two transactions share
    // the exact same occurredAt timestamp - occurredAt alone is not a stable sort key.
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
  });
  const candidates: ReconciliationTransaction[] = unlinked.map(toReconciliationTransaction);
  const rollPairedIds = findRollPairedOpeningTransactionIds(candidates);
  const unresolvedRecords = await prisma.brokerRecord.findMany({
    where: { userId, accountId, provider: "SCHWAB", kind: "TRANSACTION", status: { not: "CONFIRMED" } },
    select: { symbol: true, underlyingSymbol: true },
  });

  // 1. Open new campaigns from unlinked "Sell to Open" put transactions (or link to an
  // already-tracked campaign for the exact same contract, e.g. one a CSV import created).
  // Skip anything that's actually a roll's new leg - that gets paired with its old leg by
  // findClosingEvidence below instead of becoming its own campaign.
  for (const transaction of unlinked) {
    if (rollPairedIds.has(transaction.id)) {
      continue;
    }
    const opening = parseOpeningPutTransaction(toReconciliationTransaction(transaction));
    if (!opening) {
      continue;
    }

    const existing = await prisma.campaign.findFirst({
      where: {
        ownerId: userId,
        accountId,
        ticker: opening.underlying,
        events: { some: { type: "SELL_PUT", strike: opening.strike, expiration: opening.expiration } },
      },
    });

    if (existing) {
      await prisma.brokerRecord.update({ where: { id: transaction.id }, data: { linkedCampaignId: existing.id } });
      continue;
    }

    const campaign = await createCampaignForUser(
      userId,
      accountId,
      opening.underlying,
      opening.occurredAt.toISOString().slice(0, 10),
      opening.expiration.toISOString().slice(0, 10),
      opening.strike,
      opening.contracts,
      opening.premium,
      opening.fees,
      null,
      "INHERIT",
    );
    await prisma.brokerRecord.update({ where: { id: transaction.id }, data: { linkedCampaignId: campaign.id } });
    summary.campaignsOpened += 1;
  }

  // 2. Resolve closing evidence (close / roll / assignment) or confirmed expiration for every
  // still-open cash-secured-put campaign on this account.
  const openCampaigns = await prisma.campaign.findMany({
    where: { ownerId: userId, accountId, status: "OPEN", strategy: "CASH_SECURED_PUT" },
    include: { events: { orderBy: [{ occurredAt: "asc" }, { sortOrder: "asc" }] } },
  });

  for (const campaign of openCampaigns) {
    const openPut = getCurrentOpenPut(campaign.events);
    if (!openPut) {
      continue;
    }

    const symbol = formatOccPutSymbol(campaign.ticker, openPut.expiration, openPut.strike);
    const closing = findClosingEvidence({ symbol, underlying: campaign.ticker, strike: openPut.strike, expiration: openPut.expiration }, candidates);

    if (closing.kind === "CLOSE") {
      await closeCampaignPutForUser(userId, campaign.id, closing.occurredAt.toISOString().slice(0, 10), closing.premium, closing.fees, null);
      await prisma.brokerRecord.update({ where: { id: closing.transactionId }, data: { linkedCampaignId: campaign.id } });
      summary.campaignsClosed += 1;
      continue;
    }

    if (closing.kind === "ROLL") {
      await rollCampaignPutForUser(
        userId,
        campaign.id,
        closing.occurredAt.toISOString().slice(0, 10),
        closing.closePremium,
        closing.newExpiration.toISOString().slice(0, 10),
        closing.newStrike,
        closing.newPremium,
        closing.closeFees,
        null,
        closing.openFees,
      );
      await prisma.brokerRecord.updateMany({
        where: { id: { in: [closing.closeTransactionId, closing.openTransactionId] } },
        data: { linkedCampaignId: campaign.id },
      });
      summary.campaignsRolled += 1;
      continue;
    }

    if (closing.kind === "ASSIGNMENT") {
      await assignCampaignPutForUser(userId, campaign.id, closing.occurredAt.toISOString().slice(0, 10), undefined, closing.fees, null);
      await prisma.brokerRecord.update({ where: { id: closing.transactionId }, data: { linkedCampaignId: campaign.id } });
      summary.campaignsAssigned += 1;
      continue;
    }

    // Even an incomplete explicit close/exercise row is contrary evidence, never a synthetic
    // zero-cost expiration. Opening and administrative expiration-removal rows are not closes.
    const hasUnresolvedActivity = unlinked.some((transaction) => {
      const action = classifyBrokerTransactionActivity(transaction);
      if (isSameOccContract(transaction.symbol, symbol)) {
        return action !== "SELL_TO_OPEN" && action !== "OPTION_REMOVED_EXPIRATION";
      }
      // An unidentifiable close/assignment cannot establish absence for an affected account.
      return !occContractKey(transaction.symbol) &&
        ["BUY_TO_CLOSE", "ASSIGNMENT", "EXERCISE", "UNKNOWN"].includes(action) &&
        (!transaction.underlyingSymbol || transaction.underlyingSymbol.toUpperCase() === campaign.ticker.toUpperCase());
    }) || unresolvedRecords.some((record) =>
      isSameOccContract(record.symbol, symbol) || record.underlyingSymbol?.toUpperCase() === campaign.ticker.toUpperCase() ||
      (!record.symbol && !record.underlyingSymbol),
    );
    const expiration = evaluateWorthlessExpiration({
      expiration: openPut.expiration,
      symbol,
      underlying: campaign.ticker,
      evidence: hasUnresolvedActivity
        ? { ...evidence, transactions: { ...evidence.transactions, status: "PARTIAL" } }
        : evidence,
      hasClosingEvidence: false, // All actionable explicit evidence took precedence above.
      asOf,
    });
    if (expiration.status === "CONFIRMED") {
      const expired = await expireCampaignPutForUser(userId, campaign.id, asOf.toISOString().slice(0, 10), 0, null);
      if (expired) summary.campaignsExpired += 1;
    } else if (expiration.reason === "EXPIRATION_EVIDENCE_INCOMPLETE") {
      summary.expirationsDeferred += 1;
      summary.expirationDeferralReason = expiration.reason;
    }
  }

  return summary;
}

function toReconciliationTransaction(record: {
  id: string;
  symbol: string | null;
  occurredAt: Date | null;
  action: string | null;
  quantity: unknown;
  price: unknown;
  fees: unknown;
}): ReconciliationTransaction {
  return {
    id: record.id,
    symbol: record.symbol,
    occurredAt: record.occurredAt,
    action: record.action,
    quantity: numericOrNull(record.quantity),
    price: numericOrNull(record.price),
    fees: numericOrNull(record.fees),
  };
}

function numericOrNull(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Reconstructs the canonical OCC-style symbol (see providers/schwab/csv.ts's occSymbol) for an
 * already-tracked campaign's open put leg, so it can be matched against BrokerRecord.symbol
 * values, which are always stored in this same normalized form. */
function formatOccPutSymbol(underlying: string, expiration: Date, strike: number) {
  const year = String(expiration.getUTCFullYear() % 100).padStart(2, "0");
  const month = String(expiration.getUTCMonth() + 1).padStart(2, "0");
  const day = String(expiration.getUTCDate()).padStart(2, "0");
  const strikeDigits = String(Math.round(strike * 1000)).padStart(8, "0");
  return `${underlying} ${year}${month}${day}P${strikeDigits}`;
}
