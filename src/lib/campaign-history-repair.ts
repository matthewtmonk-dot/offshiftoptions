import "server-only";

import { createHash } from "node:crypto";
import { prisma } from "./prisma";
import { classifyBrokerTransactionAction } from "@/domain/finance/brokerTransactionActions";

/** Refuses to repair an implausibly large match count - defense in depth in case the predicate
 * below is ever broadened incorrectly; this specific bug class should only ever affect a
 * handful of campaigns per user. */
const DEFAULT_SAFETY_CAP = 50;

/** Real Schwab expiration-removal description text - the one unambiguous, generic signature
 * that proves a linked "closing" BrokerRecord is actually expiration/removal evidence the old
 * normalizer misclassified, never a real Buy to Close. Matches the same text
 * expirationRemovalActionLabel() in broker-read.ts already recognizes. */
const EXPIRATION_REMOVAL_TEXT = /removed due to expiration|removed - expiration/i;

export type CampaignHistoryRepairCandidate = {
  ticker: string;
  currentStatus: string;
  eventSequence: string[];
  badEventType: string;
  sourceClassification: string;
  proposedAction: string;
};

export type CampaignHistoryRepairPreview = {
  totalMatched: number;
  candidates: CampaignHistoryRepairCandidate[];
  safetyCapExceeded: boolean;
  /** Opaque hash of the exact qualifying (campaign, event, source record) triples at preview
   * time - never the raw ids themselves. The repair call must present this same token; if the
   * live qualifying set has changed at all, the recomputed hash won't match and the repair
   * refuses, requiring a fresh preview. */
  matchToken: string;
};

export type CampaignHistoryRepairResult = {
  repairedCount: number;
};

type QualifyingRepair = {
  campaignId: string;
  ticker: string;
  closePutEventId: string;
  brokerRecordId: string;
  brokerRecordMetadata: unknown;
};

/**
 * The one narrow, generic, user-scoped signature the premature-expiration-close bug produced -
 * never Matt/ticker/account-specific. A campaign only qualifies when ALL of the following hold:
 *
 * - this user's own CASH_SECURED_PUT campaign, on their own Schwab-sourced account
 * - currently CLOSED with EXACTLY two events: SELL_PUT then CLOSE_PUT (nothing else - a roll,
 *   assignment, or any other subsequent event makes the history genuinely different and this
 *   never qualifies as ambiguous)
 * - the CLOSE_PUT event's premium is exactly $0 (the bug's signature - a removal record's price
 *   is always 0, since nothing was actually bought back)
 * - NO linked BrokerRecord classifies as ASSIGNMENT or EXERCISE - a genuine assignment/exercise
 *   is a real settlement, never expiration-removal noise, and disqualifies the campaign outright
 * - exactly one linked BrokerRecord classifies as BUY_TO_CLOSE - if there is more than one, this
 *   is left alone as ambiguous, never guessed at
 * - that one linked record's own description contains real Schwab expiration-removal text -
 *   the unambiguous proof it is expiration evidence, not a real trade, that the OLD normalizer
 *   mislabeled - a legitimate Buy to Close (real trade, no such text) never matches this.
 */
async function findQualifyingRepairs(userId: string): Promise<QualifyingRepair[]> {
  const campaigns = await prisma.campaign.findMany({
    where: { ownerId: userId, strategy: "CASH_SECURED_PUT", status: "CLOSED" },
    include: {
      events: { orderBy: [{ occurredAt: "asc" }, { sortOrder: "asc" }] },
      account: { select: { source: true } },
    },
  });

  const results: QualifyingRepair[] = [];

  for (const campaign of campaigns) {
    if (campaign.account.source !== "SCHWAB") {
      continue;
    }
    if (campaign.events.length !== 2) {
      continue;
    }
    const [openEvent, closeEvent] = campaign.events;
    if (openEvent.type !== "SELL_PUT" || closeEvent.type !== "CLOSE_PUT") {
      continue;
    }
    if (Number(closeEvent.premium ?? -1) !== 0) {
      continue;
    }

    const linkedRecords = await prisma.brokerRecord.findMany({
      where: { linkedCampaignId: campaign.id, userId, provider: "SCHWAB" },
      select: { id: true, action: true, description: true, metadata: true },
    });

    const hasAssignmentOrExerciseEvidence = linkedRecords.some((record) => {
      const kind = classifyBrokerTransactionAction(record.action);
      return kind === "ASSIGNMENT" || kind === "EXERCISE";
    });
    if (hasAssignmentOrExerciseEvidence) {
      continue; // real settlement evidence - never expiration-removal noise, never repaired
    }

    const misclassifiedExpirationRecords = linkedRecords.filter((record) => {
      const kind = classifyBrokerTransactionAction(record.action);
      return kind === "BUY_TO_CLOSE";
    });
    if (misclassifiedExpirationRecords.length !== 1) {
      continue; // no closing evidence, or more than one (ambiguous) - never guess
    }

    const candidate = misclassifiedExpirationRecords[0];
    if (!EXPIRATION_REMOVAL_TEXT.test(candidate.description ?? "")) {
      continue; // a real Buy to Close/assignment never carries this text - leave it alone
    }

    results.push({
      campaignId: campaign.id,
      ticker: campaign.ticker,
      closePutEventId: closeEvent.id,
      brokerRecordId: candidate.id,
      brokerRecordMetadata: candidate.metadata,
    });
  }

  return results;
}

function computeMatchToken(items: QualifyingRepair[]): string {
  const sorted = [...items]
    .map((item) => `${item.campaignId}:${item.closePutEventId}:${item.brokerRecordId}`)
    .sort();
  return createHash("sha256").update(sorted.join(",")).digest("hex");
}

/** Read-only. Safe to call at any time - makes no database writes. */
export async function previewCampaignHistoryRepairForUser(
  userId: string,
  options: { safetyCap?: number } = {},
): Promise<CampaignHistoryRepairPreview> {
  const safetyCap = options.safetyCap ?? DEFAULT_SAFETY_CAP;
  const qualifying = await findQualifyingRepairs(userId);

  return {
    totalMatched: qualifying.length,
    candidates: qualifying.map((item) => ({
      ticker: item.ticker,
      currentStatus: "CLOSED",
      eventSequence: ["SELL_PUT", "CLOSE_PUT"],
      badEventType: "CLOSE_PUT",
      sourceClassification: "BUY_TO_CLOSE (misclassified expiration-removal evidence)",
      proposedAction: "Remove the erroneous CLOSE_PUT event, restore OPEN/Expiration Processing, and correct the linked record to Removed - Expiration (unlinked)",
    })),
    safetyCapExceeded: qualifying.length > safetyCap,
    matchToken: computeMatchToken(qualifying),
  };
}

/**
 * Repairs only the exact previewed set, re-verified live at mutation time (never trusts a
 * cached/client-supplied list) via the same hash-comparison technique as the malformed-
 * BrokerRecord repair tool (see schwab-record-repair.ts). Each qualifying campaign is repaired
 * in its own transaction: the erroneous CLOSE_PUT event is deleted (a narrowly-scoped, one-time
 * correction of software-bug-generated history - not a general "edit campaign history"
 * capability), the campaign is restored to OPEN, and the misclassified BrokerRecord is
 * corrected in place (action -> "Removed - Expiration", unlinked from the campaign - matching
 * exactly what the fixed normalizer + reconciliation engine would have produced) rather than
 * deleted, since its identity/fingerprint were always correct and a future sync would otherwise
 * just re-derive the same fact.
 */
export async function repairCampaignHistoryForUser(
  userId: string,
  matchToken: string,
  options: { safetyCap?: number } = {},
): Promise<CampaignHistoryRepairResult> {
  const safetyCap = options.safetyCap ?? DEFAULT_SAFETY_CAP;
  const qualifying = await findQualifyingRepairs(userId);

  if (qualifying.length > safetyCap) {
    throw new Error(`Refusing to repair ${qualifying.length} campaigns - exceeds the safety cap of ${safetyCap}. Investigate before proceeding.`);
  }
  if (qualifying.length === 0) {
    return { repairedCount: 0 };
  }
  if (computeMatchToken(qualifying) !== matchToken) {
    throw new Error("The matching set has changed since you last previewed it. Run Preview again before repairing.");
  }

  for (const item of qualifying) {
    const existingMetadata =
      item.brokerRecordMetadata && typeof item.brokerRecordMetadata === "object" && !Array.isArray(item.brokerRecordMetadata)
        ? (item.brokerRecordMetadata as Record<string, unknown>)
        : {};

    await prisma.$transaction([
      prisma.campaignEvent.delete({ where: { id: item.closePutEventId } }),
      prisma.campaign.update({ where: { id: item.campaignId }, data: { status: "OPEN", closedAt: null } }),
      prisma.brokerRecord.update({
        where: { id: item.brokerRecordId },
        data: {
          action: "Removed - Expiration",
          linkedCampaignId: null,
          metadata: { ...existingMetadata, activityKind: "OPTION_REMOVED_EXPIRATION" },
        },
      }),
    ]);
  }

  return { repairedCount: qualifying.length };
}
