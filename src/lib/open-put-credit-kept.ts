import "server-only";

import { getCurrentOpenPut } from "@/domain/finance/campaigns";
import { summarizeOpenPutCreditKept, type CreditKeptSummary } from "@/domain/finance/creditKept";
import type { LinkedPositionRecordInput } from "@/domain/finance/currentPositionMark";
import { loadLatestOptionMarksForCampaigns, optionContractKey } from "./app-data";
import { getCampaignIdsWithUnknownFees } from "./campaign-reconciliation";
import { prisma } from "./prisma";

type OpenCampaignForCredit = {
  id: string;
  ownerId: string;
  accountId: string;
  ticker: string;
  status: string;
  events: Parameters<typeof getCurrentOpenPut>[0];
};

/**
 * Owner-scoped "credit kept" for the viewer's own OPEN short put campaigns, keyed by campaign id.
 * Only reads data this app already persisted (the latest confirmed Schwab POSITION records linked
 * to each campaign, cached option marks, and the unresolved-fee flag) - it makes NO Schwab call and
 * writes nothing. All matching/freshness/provenance rules live in the pure domain functions
 * (resolveCurrentCostToClose, summarizeCampaignProgress) the Tracker already uses; a campaign with
 * no trustworthy mark simply has no entry, so the UI shows nothing rather than a guess.
 *
 * Presentation-only enrichment: any failure returns an empty map (logged without data) so a
 * mark-lookup problem can never take the Dashboard down. The Tracker keeps its own, separate
 * assembly of the same domain calls (positions/page.tsx) - not touched here.
 */
export async function getOpenPutCreditKeptForUser(userId: string, campaigns: OpenCampaignForCredit[], now: Date): Promise<Map<string, CreditKeptSummary>> {
  const result = new Map<string, CreditKeptSummary>();
  // Never trust the caller's list for ownership: a buddy's campaign can never get a mark here.
  const own = campaigns.filter((campaign) => campaign.ownerId === userId && campaign.status === "OPEN" && getCurrentOpenPut(campaign.events) !== null);
  if (own.length === 0) return result;

  try {
    const ids = own.map((campaign) => campaign.id);
    const [records, marks, unknownFeeIds] = await Promise.all([
      prisma.brokerRecord.findMany({
        where: { userId, provider: "SCHWAB", kind: "POSITION", status: "CONFIRMED", linkedCampaignId: { in: ids } },
        orderBy: [{ observedAt: "desc" }, { updatedAt: "desc" }],
        select: { linkedCampaignId: true, accountId: true, symbol: true, underlyingSymbol: true, quantity: true, amount: true, observedAt: true, metadata: true },
      }),
      // The loader only reads each campaign's ticker to pick which underlyings to look up.
      loadLatestOptionMarksForCampaigns(own.map((campaign) => ({ ticker: campaign.ticker, events: [] }))),
      getCampaignIdsWithUnknownFees(ids),
    ]);

    const recordsByCampaign = new Map<string, LinkedPositionRecordInput[]>();
    for (const record of records) {
      if (!record.linkedCampaignId) continue;
      const list = recordsByCampaign.get(record.linkedCampaignId) ?? [];
      list.push(record);
      recordsByCampaign.set(record.linkedCampaignId, list);
    }
    const marksByKey = new Map(marks.map((snapshot) => [optionContractKey(snapshot.underlyingSymbol, snapshot.expiration, snapshot.strike, snapshot.optionType), snapshot]));

    for (const campaign of own) {
      const activePut = getCurrentOpenPut(campaign.events)!;
      const snapshot = marksByKey.get(optionContractKey(campaign.ticker, activePut.expiration, activePut.strike, "PUT")) ?? null;
      const summary = summarizeOpenPutCreditKept({
        campaign,
        linkedRecords: recordsByCampaign.get(campaign.id) ?? [],
        // Same as the Tracker: this table only records insertion time, never a verified price time.
        optionMark: snapshot ? { mark: snapshot.mark, bid: snapshot.bid, ask: snapshot.ask, capturedAt: snapshot.capturedAt, valuationAsOf: null } : null,
        feesFullyKnown: !unknownFeeIds.has(campaign.id),
        now,
      });
      if (summary) result.set(campaign.id, summary);
    }
  } catch (error) {
    console.error("Credit-kept lookup failed; Dashboard continues without it.", error instanceof Error ? error.name : "unknown error");
    return new Map();
  }
  return result;
}
