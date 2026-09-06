import "server-only";

import { prisma } from "./prisma";
import { classifyBrokerTransactionAction } from "@/domain/finance/brokerTransactionActions";
import { getCampaignIdsWithUnknownFees } from "./campaign-reconciliation";
import { summarizeCampaign } from "@/domain/finance/campaigns";

export type SanitizedCampaignEvent = {
  type: string;
  occurredAt: string;
  strike: number | null;
  expiration: string | null;
  premium: number | null;
  cashAmount: number | null;
  fees: number;
};

export type SanitizedLinkedRecord = {
  occurredAt: string | null;
  normalizedAction: string | null;
  classification: string;
  feeKnown: boolean;
};

export type SanitizedCampaign = {
  ticker: string;
  strategy: string;
  status: string;
  events: SanitizedCampaignEvent[];
  linkedRecords: SanitizedLinkedRecord[];
  netOptionPremium: number;
  totalPremiumReceived: number;
  optionDebitsPaid: number;
  realizedPL: number | null;
  currentStage: string;
  hasUnknownFee: boolean;
};

export type CampaignEventSequenceReport = {
  readOnly: true;
  nothingSaved: true;
  timestamp: string;
  campaigns: SanitizedCampaign[];
};

/**
 * Sanitized, current-user-scoped, read-only view of this user's own Campaigns and their exact
 * stored CampaignEvent sequence, plus which BrokerRecords fed each campaign and how they were
 * classified - so "why did this campaign close/roll/stay open" can be answered from real stored
 * data instead of guessed at. Pure database read; no Schwab API call, no writes. Never returns
 * campaign/broker-record ids, provider account identifiers, or any raw payload - only the
 * allowlisted fields below.
 */
export async function getSanitizedCampaignEventSequenceForUser(userId: string): Promise<CampaignEventSequenceReport> {
  const campaigns = await prisma.campaign.findMany({
    where: { ownerId: userId },
    orderBy: { openedAt: "asc" },
    include: { events: { orderBy: [{ occurredAt: "asc" }, { sortOrder: "asc" }] } },
  });

  const unknownFeeCampaignIds = await getCampaignIdsWithUnknownFees(campaigns.map((campaign) => campaign.id));

  const linkedRecordsByCampaign = new Map<string, SanitizedLinkedRecord[]>();
  if (campaigns.length > 0) {
    const linkedRecords = await prisma.brokerRecord.findMany({
      where: { linkedCampaignId: { in: campaigns.map((campaign) => campaign.id) } },
      orderBy: [{ occurredAt: "asc" }],
      select: { linkedCampaignId: true, occurredAt: true, action: true, fees: true },
    });
    for (const record of linkedRecords) {
      if (!record.linkedCampaignId) {
        continue;
      }
      const list = linkedRecordsByCampaign.get(record.linkedCampaignId) ?? [];
      list.push({
        occurredAt: record.occurredAt ? record.occurredAt.toISOString() : null,
        normalizedAction: record.action,
        classification: classifyBrokerTransactionAction(record.action),
        feeKnown: record.fees !== null,
      });
      linkedRecordsByCampaign.set(record.linkedCampaignId, list);
    }
  }

  return {
    readOnly: true,
    nothingSaved: true,
    timestamp: new Date().toISOString(),
    campaigns: campaigns.map((campaign) => {
      const summary = summarizeCampaign({ events: campaign.events, status: campaign.status });
      return {
        ticker: campaign.ticker,
        strategy: campaign.strategy,
        status: campaign.status,
        events: campaign.events.map((event) => ({
          type: event.type,
          occurredAt: event.occurredAt.toISOString(),
          strike: event.strike !== null ? Number(event.strike) : null,
          expiration: event.expiration ? event.expiration.toISOString() : null,
          premium: event.premium !== null ? Number(event.premium) : null,
          cashAmount: event.cashAmount !== null ? Number(event.cashAmount) : null,
          fees: Number(event.fees),
        })),
        linkedRecords: linkedRecordsByCampaign.get(campaign.id) ?? [],
        netOptionPremium: summary.netOptionPremium,
        totalPremiumReceived: summary.totalPremiumReceived,
        optionDebitsPaid: summary.optionDebitsPaid,
        realizedPL: summary.realizedPL,
        currentStage: summary.currentStage,
        hasUnknownFee: unknownFeeCampaignIds.has(campaign.id),
      };
    }),
  };
}
