import "server-only";

import { Prisma } from "@/generated/prisma/client";
import type { BrokerRecordKind, BrokerRecordStatus } from "@/generated/prisma/enums";
import { classifyBrokerTransactionActivity, isReviewedBrokerTransactionActivity } from "@/domain/finance/brokerTransactionActions";
import {
  detectSchwabCsvExportType,
  fingerprintCsvContent,
  parseSchwabGainLossCsvWithDiagnostics,
  parseSchwabPositionsCsvWithDiagnostics,
  parseSchwabTransactionsCsvWithDiagnostics,
  type NormalizedBrokerRecord,
  type SchwabCsvExportType,
} from "@/providers/schwab/csv";
import { prisma } from "./prisma";
import { ValidationError } from "./tickers";

const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024; // 5 MB - Schwab per-account exports are small text files.
const MAX_IMPORT_ROWS = 20_000;

export type BrokerImportRowClassification = "NEW" | "DUPLICATE" | "CONFLICT" | "NEEDS_REVIEW" | "INVALID";

export type BrokerImportPreviewRow = {
  classification: BrokerImportRowClassification;
  reason: string | null;
  symbol: string | null;
  occurredAt: string | null;
  observedAt: string | null;
  action: string | null;
  quantity: number | null;
  amount: number | null;
};

export type BrokerImportBatchCounts = {
  rowCount: number;
  newCount: number;
  duplicateCount: number;
  conflictCount: number;
  reviewCount: number;
  invalidCount: number;
};

export type BrokerImportPreviewResult = {
  batchId: string;
  exportType: SchwabCsvExportType;
  safeOriginalFilename: string;
  counts: BrokerImportBatchCounts;
  rows: BrokerImportPreviewRow[];
};

/**
 * Validates and safely derives a display filename. Never used as economic identity -
 * only for showing the user which file a batch came from.
 */
function safeDisplayFilename(rawName: string) {
  const base = rawName.split(/[\\/]/).pop() ?? "upload.csv";
  const stripped = base.replace(/[\x00-\x1f\x7f]/g, "").trim();
  const safe = stripped || "upload.csv";
  return safe.length > 150 ? `${safe.slice(0, 147)}...` : safe;
}

async function readUploadedCsv(file: File): Promise<string> {
  if (!(file instanceof File) || file.size === 0) {
    throw new ValidationError("Choose a Schwab CSV export file to import.");
  }
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    throw new ValidationError("That file is larger than the 5 MB CSV import limit.");
  }
  const name = file.name ?? "";
  if (!name.toLowerCase().endsWith(".csv")) {
    throw new ValidationError("Only .csv files are supported for Schwab import.");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  // Reject obvious binary content (a real CSV export never legitimately contains a NUL byte).
  if (bytes.includes(0)) {
    throw new ValidationError("That file does not look like a plain-text CSV export.");
  }

  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const lineCount = text.split(/\r\n|\r|\n/).length;
  if (lineCount > MAX_IMPORT_ROWS) {
    throw new ValidationError(`That file has more than ${MAX_IMPORT_ROWS.toLocaleString()} rows, which is above the import limit.`);
  }

  return text;
}

function parseByExportType(exportType: SchwabCsvExportType, text: string, accountHint: string) {
  if (exportType === "POSITIONS") {
    return parseSchwabPositionsCsvWithDiagnostics(text, { accountHint });
  }
  if (exportType === "TRANSACTIONS") {
    return parseSchwabTransactionsCsvWithDiagnostics(text, { accountHint });
  }
  return parseSchwabGainLossCsvWithDiagnostics(text, { accountHint });
}

function toPrismaKind(exportType: SchwabCsvExportType): BrokerRecordKind {
  return exportType === "POSITIONS" ? "POSITION" : exportType === "TRANSACTIONS" ? "TRANSACTION" : "REALIZED_GAIN_LOSS";
}

function financiallyEqual(a: NormalizedBrokerRecord, b: { quantity: Prisma.Decimal | null; amount: Prisma.Decimal | null }) {
  return numbersEqual(a.quantity, decimalToNumber(b.quantity)) && numbersEqual(a.amount, decimalToNumber(b.amount));
}

function numbersEqual(a: number | null, b: number | null) {
  if (a === null || b === null) {
    return a === b;
  }
  return Math.abs(a - b) < 1e-6;
}

function decimalToNumber(value: Prisma.Decimal | null): number | null {
  return value === null ? null : Number(value);
}

type ExistingRecordRow = {
  id: string;
  fingerprint: string;
  identityKey: string;
  quantity: Prisma.Decimal | null;
  amount: Prisma.Decimal | null;
  observedAt: Date | null;
};

type Classified = {
  record: NormalizedBrokerRecord;
  classification: BrokerImportRowClassification;
  reason: string | null;
  existingId: string | null;
};

/**
 * Classifies each normalized candidate against the user's existing BrokerRecord rows for
 * this provider/kind. Never mutates the database - pure classification, safe to call at
 * both preview and confirm time. See NormalizedBrokerRecord.identityKey for the
 * fingerprint-vs-identityKey distinction this relies on.
 */
async function classifyCandidates(
  userId: string,
  kind: BrokerRecordKind,
  candidates: NormalizedBrokerRecord[],
): Promise<Classified[]> {
  const existing = await prisma.brokerRecord.findMany({
    where: { userId, provider: "SCHWAB", kind },
    select: { id: true, fingerprint: true, identityKey: true, quantity: true, amount: true, observedAt: true },
  });
  const byFingerprint = new Map<string, ExistingRecordRow>(existing.map((row) => [row.fingerprint, row]));
  const byIdentityKey = new Map<string, ExistingRecordRow>(existing.map((row) => [row.identityKey, row]));

  return candidates.map((record) => {
    const activityKind =
      record.kind === "TRANSACTION"
        ? classifyBrokerTransactionActivity({ action: record.action, description: record.description })
        : null;
    const needsReview = activityKind !== null && !isReviewedBrokerTransactionActivity(activityKind);

    const matchByFingerprint = byFingerprint.get(record.fingerprint);
    if (matchByFingerprint) {
      if (record.kind === "POSITION") {
        const existingObservedAt = matchByFingerprint.observedAt?.getTime() ?? 0;
        const candidateObservedAt = record.observedAt?.getTime() ?? 0;
        if (candidateObservedAt > existingObservedAt && !financiallyEqual(record, matchByFingerprint)) {
          return { record, classification: "NEW", reason: "Newer position snapshot supersedes the stored one", existingId: matchByFingerprint.id };
        }
        return { record, classification: "DUPLICATE", reason: "Same or older position snapshot already recorded", existingId: matchByFingerprint.id };
      }
      return { record, classification: "DUPLICATE", reason: "Identical record already imported", existingId: matchByFingerprint.id };
    }

    const matchByIdentity = byIdentityKey.get(record.identityKey);
    if (matchByIdentity) {
      return {
        record,
        classification: "CONFLICT",
        reason: "Same date/symbol/action already recorded with different quantity, price, or amount",
        existingId: matchByIdentity.id,
      };
    }

    return {
      record,
      classification: needsReview ? "NEEDS_REVIEW" : "NEW",
      reason: needsReview ? `Unrecognized transaction action "${record.action ?? ""}"` : null,
      existingId: null,
    };
  });
}

function statusForClassification(classification: BrokerImportRowClassification): BrokerRecordStatus {
  if (classification === "CONFLICT") {
    return "CONFLICT";
  }
  if (classification === "NEEDS_REVIEW") {
    return "NEEDS_REVIEW";
  }
  return "CONFIRMED";
}

function toPreviewRow(item: Classified): BrokerImportPreviewRow {
  return {
    classification: item.classification,
    reason: item.reason,
    symbol: item.record.symbol,
    occurredAt: item.record.occurredAt?.toISOString() ?? null,
    observedAt: item.record.observedAt?.toISOString() ?? null,
    action: item.record.action,
    quantity: item.record.quantity,
    amount: item.record.amount,
  };
}

function countRows(classified: { classification: BrokerImportRowClassification }[], invalidCount: number): BrokerImportBatchCounts {
  return {
    rowCount: classified.length + invalidCount,
    newCount: classified.filter((row) => row.classification === "NEW").length,
    duplicateCount: classified.filter((row) => row.classification === "DUPLICATE").length,
    conflictCount: classified.filter((row) => row.classification === "CONFLICT").length,
    reviewCount: classified.filter((row) => row.classification === "NEEDS_REVIEW").length,
    invalidCount,
  };
}

/**
 * Step 1 of the import flow: receive -> validate -> parse -> classify -> store a preview
 * batch. This NEVER creates/updates a BrokerRecord - only a PENDING_PREVIEW
 * BrokerImportBatch holding the classified candidate rows. Raw file bytes are never
 * persisted; only already-normalized field values (no free-form raw row text) go into
 * the batch's temporary preview payload, which is cleared once the batch is
 * confirmed/discarded.
 */
export async function previewBrokerImportForUser(
  userId: string,
  file: File,
  accountId: string | null,
): Promise<BrokerImportPreviewResult> {
  const text = await readUploadedCsv(file);
  const exportType = detectSchwabCsvExportType(text);
  if (!exportType) {
    throw new ValidationError("This doesn't look like a Schwab Positions, Transactions, or Realized Gain/Loss export.");
  }

  if (accountId) {
    const owns = await prisma.tradingAccount.findFirst({ where: { id: accountId, userId }, select: { id: true } });
    if (!owns) {
      throw new ValidationError("Choose one of your own accounts.");
    }
  }

  const accountHint = accountId ?? userId;
  const { records, invalidRows } = parseByExportType(exportType, text, accountHint);
  const kind = toPrismaKind(exportType);
  const classified = await classifyCandidates(userId, kind, records);
  const counts = countRows(classified, invalidRows.length);

  const batch = await prisma.brokerImportBatch.create({
    data: {
      userId,
      provider: "SCHWAB",
      exportType,
      safeOriginalFilename: safeDisplayFilename(file.name ?? "upload.csv"),
      fileFingerprint: fingerprintCsvContent(text),
      asOfAt: records.find((record) => record.observedAt)?.observedAt ?? null,
      status: "PENDING_PREVIEW",
      accountId: accountId ?? undefined,
      ...counts,
      previewPayload: serializePreviewPayload(accountHint, classified),
    } as Prisma.BrokerImportBatchUncheckedCreateInput,
  });

  return {
    batchId: batch.id,
    exportType,
    safeOriginalFilename: batch.safeOriginalFilename,
    counts,
    rows: classified.map(toPreviewRow),
  };
}

type SerializedPreviewRecord = Omit<NormalizedBrokerRecord, "occurredAt" | "observedAt"> & {
  occurredAt: string | null;
  observedAt: string | null;
};

function serializePreviewPayload(accountHint: string, classified: Classified[]): Prisma.InputJsonValue {
  return {
    accountHint,
    rows: classified.map((item) => ({
      classification: item.classification,
      record: {
        ...item.record,
        occurredAt: item.record.occurredAt?.toISOString() ?? null,
        observedAt: item.record.observedAt?.toISOString() ?? null,
      } satisfies SerializedPreviewRecord,
    })),
  } as unknown as Prisma.InputJsonValue;
}

function deserializePreviewPayload(payload: unknown): { accountHint: string; records: NormalizedBrokerRecord[] } | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const value = payload as { accountHint?: unknown; rows?: unknown };
  if (typeof value.accountHint !== "string" || !Array.isArray(value.rows)) {
    return null;
  }

  const records = value.rows.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = (entry as { record?: SerializedPreviewRecord }).record;
    if (!record) {
      return [];
    }
    return [
      {
        ...record,
        occurredAt: record.occurredAt ? new Date(record.occurredAt) : null,
        observedAt: record.observedAt ? new Date(record.observedAt) : null,
      } as NormalizedBrokerRecord,
    ];
  });

  return { accountHint: value.accountHint, records };
}

export type BrokerImportBatchSummary = {
  id: string;
  status: string;
  exportType: string;
  safeOriginalFilename: string;
  createdAt: Date;
} & BrokerImportBatchCounts;

export async function getPendingBrokerImportBatchForUser(userId: string, batchId: string) {
  const batch = await prisma.brokerImportBatch.findFirst({ where: { id: batchId, userId } });
  if (!batch) {
    return null;
  }

  const payload = deserializePreviewPayload(batch.previewPayload);
  const classified = payload ? await classifyCandidates(userId, toPrismaKind(batch.exportType), payload.records) : [];

  return { batch, rows: classified.map(toPreviewRow) };
}

/**
 * Step 2: persist only after the user confirms. Re-classifies against the CURRENT
 * database state (not just what preview saw) so a race between preview and confirm can
 * never silently double-insert or clobber a conflicting row. Discards the batch's raw
 * preview payload once persisted - the BrokerRecord rows themselves are the durable
 * result from this point on.
 */
export async function confirmBrokerImportForUser(userId: string, batchId: string): Promise<BrokerImportBatchSummary> {
  const batch = await prisma.brokerImportBatch.findFirst({ where: { id: batchId, userId } });
  if (!batch) {
    throw new ValidationError("Import batch not found.");
  }
  if (batch.status !== "PENDING_PREVIEW") {
    throw new ValidationError("This import has already been confirmed or discarded.");
  }

  const payload = deserializePreviewPayload(batch.previewPayload);
  if (!payload) {
    throw new ValidationError("This import's preview data is no longer available. Please upload the file again.");
  }

  const kind = toPrismaKind(batch.exportType);
  const classified = await classifyCandidates(userId, kind, payload.records);
  await persistClassifiedBrokerRecords(userId, batch.accountId ?? null, batch.id, kind, classified);

  const counts = countRows(classified, batch.invalidCount);
  return prisma.brokerImportBatch.update({
    where: { id: batch.id },
    data: { status: "CONFIRMED", previewPayload: Prisma.JsonNull, ...counts },
  });
}

export async function discardBrokerImportForUser(userId: string, batchId: string) {
  const batch = await prisma.brokerImportBatch.findFirst({ where: { id: batchId, userId } });
  if (!batch) {
    throw new ValidationError("Import batch not found.");
  }
  if (batch.status !== "PENDING_PREVIEW") {
    throw new ValidationError("This import has already been confirmed or discarded.");
  }

  return prisma.brokerImportBatch.update({
    where: { id: batch.id },
    data: { status: "DISCARDED", previewPayload: Prisma.JsonNull },
  });
}

export async function getBrokerImportBatchesForUser(userId: string) {
  return prisma.brokerImportBatch.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "P2002");
}

/** Aggregate, non-sensitive counts only - never raw payload content - safe to log/display to
 * the authenticated user for sync auditability (see PROJECT_HANDOFF.md "First real sync
 * auditability"). */
export type PersistBrokerRecordsSummary = {
  inserted: number;
  duplicatesSkipped: number;
  /** NEEDS_REVIEW or CONFLICT rows written - the automatic reconciler leaves these for the
   * existing manual "awaiting review" flow rather than guessing. */
  unresolved: number;
  /** Among TRANSACTION-kind rows written this call: how many had a real (possibly zero) fee
   * value vs. how many had `fees: null` (Schwab didn't report one, or it couldn't be parsed) -
   * see getCampaignIdsWithUnknownFees for why this distinction must never collapse to $0. */
  feeKnownTransactions: number;
  feeUnknownTransactions: number;
};

/**
 * Writes already-classified candidates as BrokerRecord rows - the shared dedupe-safe
 * persistence step behind both CSV import confirm (a real BrokerImportBatch) and live Schwab
 * API sync (no batch - importBatchId stays null). NEW+existingId supersedes a stored POSITION
 * snapshot in place; everything else is a plain create, guarded against a concurrent
 * duplicate insert via the (userId, provider, kind, fingerprint) unique constraint.
 */
export async function persistClassifiedBrokerRecords(
  userId: string,
  accountId: string | null,
  importBatchId: string | null,
  kind: BrokerRecordKind,
  classified: Classified[],
): Promise<PersistBrokerRecordsSummary> {
  const summary: PersistBrokerRecordsSummary = {
    inserted: 0,
    duplicatesSkipped: 0,
    unresolved: 0,
    feeKnownTransactions: 0,
    feeUnknownTransactions: 0,
  };

  for (const item of classified) {
    if (item.classification === "DUPLICATE" || item.classification === "INVALID") {
      summary.duplicatesSkipped += 1;
      continue;
    }
    if (item.classification === "NEEDS_REVIEW" || item.classification === "CONFLICT") {
      summary.unresolved += 1;
    }

    const status = statusForClassification(item.classification);
    const data = {
      userId,
      accountId: accountId ?? undefined,
      importBatchId: importBatchId ?? undefined,
      provider: "SCHWAB" as const,
      kind,
      status,
      fingerprint: item.record.fingerprint,
      identityKey: item.record.identityKey,
      reconciliationKey: item.record.reconciliationKey ?? undefined,
      occurredAt: item.record.occurredAt ?? undefined,
      observedAt: item.record.observedAt ?? undefined,
      symbol: item.record.symbol ?? undefined,
      underlyingSymbol: item.record.underlyingSymbol ?? undefined,
      action: item.record.action ?? undefined,
      description: item.record.description ?? undefined,
      quantity: item.record.quantity ?? undefined,
      price: item.record.price ?? undefined,
      fees: item.record.fees ?? undefined,
      amount: item.record.amount ?? undefined,
      sources: item.record.sources,
      sourceIds: item.record.sourceIds,
      metadata: item.record.metadata as Prisma.InputJsonValue,
    };

    try {
      if (item.classification === "NEW" && item.existingId) {
        // Position supersede: update the existing current-position row in place.
        await prisma.brokerRecord.update({ where: { id: item.existingId }, data });
      } else {
        await prisma.brokerRecord.create({ data });
      }
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        // Another concurrent confirm/sync already inserted this exact fact - treat as a duplicate, not a failure.
        summary.duplicatesSkipped += 1;
        continue;
      }
      throw error;
    }

    summary.inserted += 1;
    if (kind === "TRANSACTION") {
      if (item.record.fees === null) {
        summary.feeUnknownTransactions += 1;
      } else {
        summary.feeKnownTransactions += 1;
      }
    }
  }

  return summary;
}

/**
 * Classifies and persists live Schwab API data (positions + transactions) as BrokerRecord
 * rows, reusing the exact CSV import dedupe scheme (fingerprint/identityKey) so a repeated
 * sync can never create duplicate rows - see persistClassifiedBrokerRecords. Never routes
 * through BrokerImportBatch; there is no uploaded file behind these rows.
 */
export async function persistNormalizedBrokerRecordsForUser(
  userId: string,
  accountId: string,
  records: NormalizedBrokerRecord[],
): Promise<PersistBrokerRecordsSummary> {
  const total: PersistBrokerRecordsSummary = {
    inserted: 0,
    duplicatesSkipped: 0,
    unresolved: 0,
    feeKnownTransactions: 0,
    feeUnknownTransactions: 0,
  };

  const byKind = new Map<BrokerRecordKind, NormalizedBrokerRecord[]>();
  for (const record of records) {
    byKind.set(record.kind, [...(byKind.get(record.kind) ?? []), record]);
  }

  for (const [kind, kindRecords] of byKind) {
    const classified = await classifyCandidates(userId, kind, kindRecords);
    const summary = await persistClassifiedBrokerRecords(userId, accountId, null, kind, classified);
    total.inserted += summary.inserted;
    total.duplicatesSkipped += summary.duplicatesSkipped;
    total.unresolved += summary.unresolved;
    total.feeKnownTransactions += summary.feeKnownTransactions;
    total.feeUnknownTransactions += summary.feeUnknownTransactions;
  }

  return total;
}
