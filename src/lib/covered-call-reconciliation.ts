import "server-only";

import {
  planCoveredCallStep,
  stepTransactionIds,
  type ClosureTransaction,
  type CoveredCallStep,
} from "@/domain/finance/shareClosureReconciliation";
import { recordDiagnostic } from "./diagnostics";
import { prisma } from "./prisma";
import {
  closeCoveredCallForUser,
  expireCoveredCallForUser,
  recordCoveredCallCalledAwayForUser,
  sellCoveredCallForUser,
  sellStockForUser,
} from "./workflows";

export type SchwabCoveredCallReconciliationSummary = {
  coveredCallsOpened: number;
  coveredCallsClosed: number;
  /** Calls Schwab reported as expired worthless (the shares stay held). */
  coveredCallsExpired: number;
  /** Positions closed because a call was assigned and the shares were called away. */
  sharesCalledAway: number;
  /** Positions closed by a stock sale of all the assigned shares. */
  sharesSold: number;
  /** Share-delivery records from a put assignment matched to the campaign (no new event). */
  deliveryRecordsLinked: number;
};

/** More than any real backlog (a few weeks of weekly calls) needs; only a guard against a runaway loop. */
const MAX_STEPS_PER_SYNC = 60;

/**
 * Reconciles the covered-call and share side of every ASSIGNED campaign on one account, one verified step at a
 * time (see src/domain/finance/shareClosureReconciliation.ts for the pure rules and their tests):
 *
 *   - Sell to Open / Buy to Close of covered calls (as before);
 *   - a call that reached expiration - closed out as expired on Schwab's own "Removed due to Expiration" notice
 *     (this was the missing piece: an expired call used to stay "open" forever, which blocked every later
 *     call in the chain from linking and left the Tracker saying "settlement pending");
 *   - a call that was ASSIGNED, matched to the stock sale at the strike, = shares called away, campaign closed;
 *   - the whole assigned position sold in one plain stock sale;
 *   - linking the share-delivery record a put assignment produced.
 *
 * Each pass re-reads the account's unlinked records and campaigns, asks the planner for the next step, applies
 * it through the same validated workflows the manual buttons use, links exactly the records it consumed, and
 * asks again - so a backlog resolves in order within one sync and a second sync finds nothing left to do
 * (idempotent: a consumed record is linked, and every workflow refuses to act on a campaign in the wrong state).
 *
 * Every query is scoped to the authenticated userId + accountId (never a client-supplied id). Anything
 * ambiguous (no match, more than one match, two campaigns in the same ticker, a partial sale, both an
 * expiration and an assignment, a sale at a different price) is left unlinked for manual review - and a step
 * that fails validation is skipped for the rest of this sync instead of retried.
 */
export async function reconcileSchwabCoveredCallActivityForUser(
  userId: string,
  accountId: string,
  asOf: Date = new Date(),
): Promise<SchwabCoveredCallReconciliationSummary> {
  const summary: SchwabCoveredCallReconciliationSummary = {
    coveredCallsOpened: 0,
    coveredCallsClosed: 0,
    coveredCallsExpired: 0,
    sharesCalledAway: 0,
    sharesSold: 0,
    deliveryRecordsLinked: 0,
  };
  const skipped = new Set<string>();

  for (let pass = 0; pass < MAX_STEPS_PER_SYNC; pass += 1) {
    const unlinked = await prisma.brokerRecord.findMany({
      where: { userId, accountId, provider: "SCHWAB", kind: "TRANSACTION", status: "CONFIRMED", linkedCampaignId: null },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    });
    const campaigns = await prisma.campaign.findMany({
      where: { ownerId: userId, accountId, status: "ASSIGNED" },
      include: { events: { orderBy: [{ occurredAt: "asc" }, { sortOrder: "asc" }] } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    const step = planCoveredCallStep({
      campaigns: campaigns.map((campaign) => ({ id: campaign.id, ticker: campaign.ticker, events: campaign.events })),
      candidates: unlinked.filter((record) => !skipped.has(record.id)).map(toClosureTransaction),
      asOf,
    });
    if (!step) {
      break;
    }

    const ticker = campaigns.find((campaign) => campaign.id === step.campaignId)?.ticker ?? "";
    let applied = false;
    try {
      applied = await applyStep(userId, accountId, step, ticker, summary);
    } catch {
      // One unexpected validation failure must not abort reconciliation for everything else.
      applied = false;
    }
    if (!applied) {
      for (const id of stepTransactionIds(step)) skipped.add(id);
    }
  }

  return summary;
}

async function linkRecords(userId: string, accountId: string, campaignId: string, ids: string[]) {
  // Scoped again by user + account (defense in depth) and only ever fills an empty link.
  await prisma.brokerRecord.updateMany({
    where: { id: { in: ids }, userId, accountId, linkedCampaignId: null },
    data: { linkedCampaignId: campaignId },
  });
}

async function applyStep(
  userId: string,
  accountId: string,
  step: CoveredCallStep,
  ticker: string,
  summary: SchwabCoveredCallReconciliationSummary,
): Promise<boolean> {
  const link = (ids: string[]) => linkRecords(userId, accountId, step.campaignId, ids);

  switch (step.kind) {
    case "CLOSE_CALL": {
      const updated = await closeCoveredCallForUser(userId, step.campaignId, step.occurredOn, step.premium, step.fees, null);
      if (!updated) return false;
      await link([step.transactionId]);
      summary.coveredCallsClosed += 1;
      return true;
    }
    case "OPEN_CALL": {
      const updated = await sellCoveredCallForUser(userId, step.campaignId, step.occurredOn, step.expiration, step.strike, step.contracts, step.premium, step.fees, null);
      if (!updated) return false;
      await link([step.transactionId]);
      summary.coveredCallsOpened += 1;
      return true;
    }
    case "EXPIRE_CALL": {
      const updated = await expireCoveredCallForUser(userId, step.campaignId, step.occurredOn, 0, "Expired worthless - Schwab reported the call removed due to expiration.", { brokerConfirmed: true });
      if (!updated) return false;
      await link([step.transactionId]);
      summary.coveredCallsExpired += 1;
      recordDiagnostic({ kind: "action", source: "covered call reconciled", message: `${ticker} covered call expired worthless (${step.occurredOn})` });
      return true;
    }
    case "CALLED_AWAY": {
      const updated = await recordCoveredCallCalledAwayForUser(userId, step.campaignId, {
        assignedOn: step.assignedOn,
        soldOn: step.soldOn,
        shares: step.shares,
        price: step.price,
        assignmentFees: step.assignmentFees,
        saleFees: step.saleFees,
      });
      if (!updated) return false;
      await link([step.assignmentTransactionId, step.saleTransactionId]);
      summary.sharesCalledAway += 1;
      recordDiagnostic({ kind: "action", source: "covered call reconciled", message: `${ticker} covered call assigned - ${step.shares} shares called away at ${step.price} (${step.soldOn})` });
      return true;
    }
    case "SELL_SHARES": {
      const updated = await sellStockForUser(userId, step.campaignId, step.soldOn, step.shares, step.price, step.fees, "Sold at Schwab (matched from your Schwab transaction).");
      if (!updated) return false;
      await link([step.transactionId]);
      summary.sharesSold += 1;
      recordDiagnostic({ kind: "action", source: "share sale reconciled", message: `${ticker} ${step.shares} shares sold at ${step.price} (${step.soldOn})` });
      return true;
    }
    case "LINK_DELIVERY": {
      await link(step.transactionIds);
      summary.deliveryRecordsLinked += step.transactionIds.length;
      return true;
    }
  }
}

function toClosureTransaction(record: {
  id: string;
  symbol: string | null;
  underlyingSymbol: string | null;
  occurredAt: Date | null;
  action: string | null;
  quantity: unknown;
  price: unknown;
  fees: unknown;
}): ClosureTransaction {
  return {
    id: record.id,
    symbol: record.symbol,
    underlyingSymbol: record.underlyingSymbol,
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
