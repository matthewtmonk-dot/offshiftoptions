import "server-only";

import { prisma } from "./prisma";
import { classifyBrokerTransactionActivity, type BrokerTransactionActivityKind } from "@/domain/finance/brokerTransactionActions";
import { parseOpeningPutTransaction } from "@/domain/finance/schwabReconciliation";

export type BrokerRecordCategory =
  | "ALREADY_LINKED"
  | "CAMPAIGN_READY"
  | "EXPIRATION_EVIDENCE"
  | "NON_CAMPAIGN_ACTIVITY"
  | "NEEDS_REVIEW";

export type SanitizedBrokerRecordClassification = {
  ticker: string | null;
  assetType: "OPTION" | "OTHER";
  putCall: "PUT" | "CALL" | null;
  strike: number | null;
  expiration: string | null;
  quantity: number | null;
  normalizedAction: string | null;
  description: string | null;
  price: number | null;
  feeKnown: boolean;
  classification: BrokerTransactionActivityKind;
  reconciliationEligible: boolean;
  category: BrokerRecordCategory;
  reason: string | null;
};

export type BrokerRecordClassificationReport = {
  readOnly: true;
  nothingSaved: true;
  timestamp: string;
  totalRecords: number;
  countsByCategory: Record<BrokerRecordCategory, number>;
  records: SanitizedBrokerRecordClassification[];
};

/** Recognized, but intentionally never turned into a campaign event on their own - a dividend
 * or a plain stock trade must never read to Matt as "a trade failed to reconcile." */
const NON_CAMPAIGN_ACTIVITY_KINDS: BrokerTransactionActivityKind[] = ["DIVIDEND", "INTEREST", "FEE", "TRANSFER", "STOCK_BUY", "STOCK_SELL"];

/** Real evidence that an option reached expiration, removal, assignment, or exercise -
 * meaningful for eventual campaign lifecycle tracking, but never a signal to declare a win or
 * a loss on its own (that stays gated on the existing NYSE-market-day confirmation rule). */
const EXPIRATION_EVIDENCE_KINDS: BrokerTransactionActivityKind[] = ["ASSIGNMENT", "EXERCISE", "OPTION_REMOVED_EXPIRATION"];

const OPENING_OR_CLOSING_KINDS: BrokerTransactionActivityKind[] = ["SELL_TO_OPEN", "BUY_TO_CLOSE", "BUY_TO_OPEN", "SELL_TO_CLOSE"];

/**
 * Sanitized, current-user-scoped, read-only view of this user's already-persisted Schwab
 * TRANSACTION BrokerRecords, re-classified live using the production transaction activity
 * classifier and campaign opening-put parser (classifyBrokerTransactionActivity,
 * parseOpeningPutTransaction) - never a re-implementation that could drift from the real
 * engine's behavior. Pure database
 * read; makes no live Schwab API call and needs no active Schwab connection. Never returns
 * ids/fingerprints/account identifiers/Schwab activity ids or any raw payload - only the
 * allowlisted fields below.
 */
export async function getSanitizedBrokerRecordClassificationForUser(userId: string): Promise<BrokerRecordClassificationReport> {
  const rows = await prisma.brokerRecord.findMany({
    where: { userId, provider: "SCHWAB", kind: "TRANSACTION" },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    select: {
      linkedCampaignId: true,
      symbol: true,
      underlyingSymbol: true,
      action: true,
      description: true,
      quantity: true,
      price: true,
      fees: true,
      occurredAt: true,
      metadata: true,
    },
  });

  const records = rows.map(classifyRow);
  const countsByCategory: Record<BrokerRecordCategory, number> = {
    ALREADY_LINKED: 0,
    CAMPAIGN_READY: 0,
    EXPIRATION_EVIDENCE: 0,
    NON_CAMPAIGN_ACTIVITY: 0,
    NEEDS_REVIEW: 0,
  };
  for (const record of records) {
    countsByCategory[record.category] += 1;
  }

  return {
    readOnly: true,
    nothingSaved: true,
    timestamp: new Date().toISOString(),
    totalRecords: records.length,
    countsByCategory,
    records,
  };
}

export function classifyRow(row: {
  linkedCampaignId: string | null;
  symbol: string | null;
  underlyingSymbol: string | null;
  action: string | null;
  description: string | null;
  quantity: unknown;
  price: unknown;
  fees: unknown;
  occurredAt: Date | null;
  metadata: unknown;
}): SanitizedBrokerRecordClassification {
  const metadata = objectValue(row.metadata);
  const quantity = numericOrNull(row.quantity);
  const price = numericOrNull(row.price);
  const fees = numericOrNull(row.fees);
  const optionTypeRaw = metadata?.optionType;
  const putCall = optionTypeRaw === "PUT" || optionTypeRaw === "CALL" ? optionTypeRaw : null;
  const strike = numericOrNull(metadata?.strikePrice);
  const expiration = typeof metadata?.expiration === "string" ? metadata.expiration : null;

  const activityKind = classifyBrokerTransactionActivity({ action: row.action, description: row.description });
  const eligible =
    parseOpeningPutTransaction({
      id: "diagnostic",
      symbol: row.symbol,
      occurredAt: row.occurredAt,
      action: row.action,
      quantity,
      price,
      fees,
    }) !== null;

  let category: BrokerRecordCategory;
  let reason: string | null = null;

  if (row.linkedCampaignId) {
    category = "ALREADY_LINKED";
  } else if (EXPIRATION_EVIDENCE_KINDS.includes(activityKind)) {
    category = "EXPIRATION_EVIDENCE";
  } else if (putCall) {
    // This record IS an option instrument - only a recognized opening/closing instruction
    // makes it safely campaign-relevant. A generic/unknown action on an option instrument is a
    // real ambiguity, never silently bucketed as ordinary non-campaign activity just because
    // the raw action string happened to look like a plain stock buy/sell.
    if (OPENING_OR_CLOSING_KINDS.includes(activityKind) && (activityKind !== "SELL_TO_OPEN" || eligible)) {
      category = "CAMPAIGN_READY";
    } else {
      category = "NEEDS_REVIEW";
      reason =
        activityKind === "SELL_TO_OPEN"
          ? "Recognized as an opening sale, but the option symbol, price, or quantity could not be parsed confidently."
          : `This is an option instrument, but the action ("${row.action ?? "none"}") was not recognized as an opening/closing instruction.`;
    }
  } else if (activityKind === "UNKNOWN") {
    category = "NEEDS_REVIEW";
    reason = `Unrecognized transaction action "${row.action ?? "(none)"}"`;
  } else if (NON_CAMPAIGN_ACTIVITY_KINDS.includes(activityKind)) {
    category = "NON_CAMPAIGN_ACTIVITY";
  } else {
    category = "CAMPAIGN_READY";
  }

  return {
    ticker: row.underlyingSymbol,
    assetType: putCall ? "OPTION" : "OTHER",
    putCall,
    strike,
    expiration,
    quantity,
    normalizedAction: row.action,
    description: row.description,
    price,
    feeKnown: fees !== null,
    classification: activityKind,
    reconciliationEligible: eligible,
    category,
    reason,
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function numericOrNull(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
