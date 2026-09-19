import "server-only";

import { getCurrentOpenCall, summarizeCampaign } from "@/domain/finance/campaigns";
import { formatOccSymbol } from "@/domain/finance/occOption";
import {
  findCoveredCallCloseEvidence,
  parseOpeningCallTransaction,
  type ReconciliationTransaction,
} from "@/domain/finance/schwabReconciliation";
import { prisma } from "./prisma";
import { closeCoveredCallForUser, sellCoveredCallForUser } from "./workflows";

export type SchwabCoveredCallReconciliationSummary = {
  coveredCallsOpened: number;
  coveredCallsClosed: number;
};

/**
 * Covered Call Phase 3B (see PROJECT_HANDOFF.md's Phase 3A audit): automates ONLY covered-call
 * Sell to Open and Buy to Close. This is a deliberately separate path from
 * reconcileSchwabActivityForUser (put reconciliation) rather than a generalization of it - the
 * two share only genuinely common low-level primitives (formatOccSymbol, isSameOccContract via
 * findCoveredCallCloseEvidence, classifyBrokerTransactionAction), never the put-specific roll,
 * assignment, or expiration logic, none of which is safe to reuse for calls yet:
 *
 *   - Call expiration is NOT automated - evaluateWorthlessExpiration's anti-false-positive guard
 *     only checks for newly ACQUIRED shares (the put failure mode); it has no equivalent check
 *     for shares being REMOVED (the call failure mode, i.e. being called away), so applying it to
 *     calls could misread a called-away assignment as a worthless expiration.
 *   - Call assignment / called-away is NOT automated - the equity transferItem of an assignment
 *     transaction is currently discarded during Schwab normalization (see
 *     src/providers/schwab/broker-read.ts's selectTradedSecurityTransferItem), so there is no
 *     trustworthy evidence yet for exactly which/how many shares left the account.
 *   - Manual and partial stock sales are NOT automated - a plain stock Sell is structurally
 *     indistinguishable from a called-away removal in the current normalized data.
 *
 * Every mutation is server-authoritative: userId/accountId always come from the authenticated
 * caller (see syncSchwabAccountAction), never from client input, and every campaign id used here
 * is one this function itself just queried scoped to that exact user+account - never a
 * client-supplied id. Ambiguous evidence (no compatible campaign, more than one compatible
 * campaign, a close whose quantity doesn't match the full open leg) always leaves the
 * BrokerRecord unlinked for manual review rather than guessing - it is never linked without a
 * CampaignEvent actually having been created from it.
 */
export async function reconcileSchwabCoveredCallActivityForUser(
  userId: string,
  accountId: string,
): Promise<SchwabCoveredCallReconciliationSummary> {
  const summary: SchwabCoveredCallReconciliationSummary = { coveredCallsOpened: 0, coveredCallsClosed: 0 };

  const unlinked = await prisma.brokerRecord.findMany({
    where: { userId, accountId, provider: "SCHWAB", kind: "TRANSACTION", status: "CONFIRMED", linkedCampaignId: null },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
  });
  const candidates: ReconciliationTransaction[] = unlinked.map(toReconciliationTransaction);

  // 1. Close evidence first, against campaigns as they stand BEFORE this sync's opens - closing
  // an existing call is always resolved before a same-sync new call is considered, so a same-day
  // close+reopen on the same campaign correctly frees that campaign's "no open call" slot for
  // step 2 rather than rejecting the new open as "already covered."
  const assignedBeforeCloses = await prisma.campaign.findMany({
    where: { ownerId: userId, accountId, status: "ASSIGNED" },
    include: { events: { orderBy: [{ occurredAt: "asc" }, { sortOrder: "asc" }] } },
  });

  // Precomputed once so the ambiguity check below never has to re-derive it per candidate.
  const openCallsByCampaign = assignedBeforeCloses
    .map((campaign) => ({ campaign, openCall: getCurrentOpenCall(campaign.events) }))
    .filter((entry): entry is { campaign: (typeof assignedBeforeCloses)[number]; openCall: NonNullable<ReturnType<typeof getCurrentOpenCall>> } =>
      entry.openCall !== null,
    );

  for (const { campaign, openCall } of openCallsByCampaign) {
    // Two different ASSIGNED campaigns (same account, same underlying) could in principle each
    // independently hold the exact same open call contract - a real Schwab Buy to Close on that
    // contract would then be equally "compatible" with both, and nothing about the transaction
    // itself says which campaign it actually belongs to. Never guess: only auto-close when this
    // is the campaign's UNIQUE holder of that exact contract.
    const holdersOfThisContract = openCallsByCampaign.filter(
      (entry) =>
        entry.campaign.ticker.toUpperCase() === campaign.ticker.toUpperCase() &&
        entry.openCall.strike === openCall.strike &&
        entry.openCall.expiration.getTime() === openCall.expiration.getTime(),
    );
    if (holdersOfThisContract.length !== 1) {
      continue;
    }

    const symbol = formatOccSymbol(campaign.ticker, openCall.expiration, openCall.strike, "CALL");
    const closing = findCoveredCallCloseEvidence({ symbol, contracts: openCall.contracts }, candidates);
    if (closing.kind !== "CLOSE") {
      continue;
    }

    try {
      const updated = await closeCoveredCallForUser(
        userId,
        campaign.id,
        closing.occurredAt.toISOString().slice(0, 10),
        closing.premium,
        closing.fees,
        null,
      );
      if (!updated) {
        continue;
      }
      await prisma.brokerRecord.update({ where: { id: closing.transactionId }, data: { linkedCampaignId: campaign.id } });
      summary.coveredCallsClosed += 1;
    } catch {
      // Leave unlinked for manual review rather than let one unexpected validation failure
      // abort reconciliation for every other campaign/transaction in this sync.
      continue;
    }
  }

  // 2. Open evidence - re-reads ASSIGNED campaigns fresh so any close just applied in step 1 is
  // reflected (a campaign whose call closed above is now eligible to receive a new one here).
  const assignedForOpens = await prisma.campaign.findMany({
    where: { ownerId: userId, accountId, status: "ASSIGNED" },
    include: { events: { orderBy: [{ occurredAt: "asc" }, { sortOrder: "asc" }] } },
  });

  for (const transaction of unlinked) {
    const opening = parseOpeningCallTransaction(toReconciliationTransaction(transaction));
    if (!opening) {
      continue;
    }

    const compatible = assignedForOpens.filter((campaign) => {
      if (campaign.ticker.toUpperCase() !== opening.underlying.toUpperCase()) {
        return false;
      }
      if (getCurrentOpenCall(campaign.events)) {
        return false; // already covered by another open call - never stack a second one
      }
      const campaignSummary = summarizeCampaign({ status: campaign.status, events: campaign.events });
      return campaignSummary.sharesHeld >= opening.contracts * 100;
    });

    if (compatible.length !== 1) {
      // None, or more than one, compatible ASSIGNED campaign - never guess which one this
      // covered call belongs to. The BrokerRecord stays unlinked for manual review.
      continue;
    }

    const campaign = compatible[0];
    try {
      const updated = await sellCoveredCallForUser(
        userId,
        campaign.id,
        opening.occurredAt.toISOString().slice(0, 10),
        opening.expiration.toISOString().slice(0, 10),
        opening.strike,
        opening.contracts,
        opening.premium,
        opening.fees,
        null,
      );
      if (!updated) {
        continue;
      }
      await prisma.brokerRecord.update({ where: { id: transaction.id }, data: { linkedCampaignId: campaign.id } });
      summary.coveredCallsOpened += 1;
    } catch {
      continue;
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
