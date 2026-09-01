import { createHash } from "node:crypto";

import { classifyBrokerTransactionAction } from "@/domain/finance/brokerTransactionActions";
import { parseOccOptionSymbol } from "@/domain/finance/occOption";
import type { BrokerPosition, BrokerTransaction } from "@/providers/broker-read/types";

export type NormalizedBrokerRecordKind = "TRANSACTION" | "POSITION" | "REALIZED_GAIN_LOSS";
export type NormalizedBrokerRecordSource =
  | "SCHWAB_API"
  | "SCHWAB_TRANSACTIONS_CSV"
  | "SCHWAB_POSITIONS_CSV"
  | "SCHWAB_GAINLOSS_CSV";

export type NormalizedBrokerRecord = {
  provider: "SCHWAB";
  kind: NormalizedBrokerRecordKind;
  /** Identifies the exact economic fact - includes financial attributes (amount/quantity/
   * price). Two records with the same fingerprint are the same fact and dedupe to one row. */
  fingerprint: string;
  /** Identifies "the same real-world event slot" WITHOUT financial attributes (e.g. same
   * account+date+symbol+action, or the same stable API id). Two records sharing an
   * identityKey but NOT a fingerprint are a CONFLICT (same slot, disagreeing data) - see
   * classifyIncomingBrokerRecord in src/lib/broker-import.ts. Positions intentionally
   * include the observed-at moment in identityKey, since a later snapshot is a new slot
   * (superseding state), not a conflict with an earlier one. */
  identityKey: string;
  reconciliationKey: string | null;
  occurredAt: Date | null;
  observedAt: Date | null;
  symbol: string | null;
  underlyingSymbol: string | null;
  action: string | null;
  description: string | null;
  quantity: number | null;
  price: number | null;
  fees: number | null;
  amount: number | null;
  sources: NormalizedBrokerRecordSource[];
  sourceIds: string[];
  metadata: Record<string, unknown>;
};

export type BrokerRecordReconciliation = {
  key: string;
  status: "CURRENT_POSITION_CONFIRMED" | "REALIZED_RESULT_CONFIRMED";
  recordFingerprints: string[];
  sources: NormalizedBrokerRecordSource[];
  realizedPLDelta: number;
};

export type BrokerRecordReconciliationResult = {
  records: NormalizedBrokerRecord[];
  links: BrokerRecordReconciliation[];
  campaignRealizedPLDelta: number;
};

type CsvParseOptions = {
  accountHint?: string;
};

type ParsedSymbol = {
  symbol: string;
  underlyingSymbol: string | null;
  optionType?: "PUT" | "CALL";
  expiration?: Date;
  strike?: number;
  rawSymbol: string;
};

export type InvalidCsvRow = { rowIndex: number; reason: string };
export type CsvParseWithDiagnostics = { records: NormalizedBrokerRecord[]; invalidRows: InvalidCsvRow[] };

const KNOWN_NON_POSITION_ROW_LABELS = new Set(["Cash & Cash Investments", "Positions Total"]);

export function parseSchwabPositionsCsv(input: string, options: CsvParseOptions = {}): NormalizedBrokerRecord[] {
  return parseSchwabPositionsCsvWithDiagnostics(input, options).records;
}

export function parseSchwabPositionsCsvWithDiagnostics(
  input: string,
  options: CsvParseOptions = {},
): CsvParseWithDiagnostics {
  const rows = parseCsvRows(input);
  const title = firstNonEmptyRow(rows)?.[0] ?? "";
  const observedAt = parsePositionsObservedAt(title);
  const headerIndex = findHeaderIndex(rows, ["Symbol", "Qty (Quantity)", "Mkt Val (Market Value)", "Asset Type"]);
  const columns = headerMap(rows[headerIndex]);
  const invalidRows: InvalidCsvRow[] = [];

  const records = rows.slice(headerIndex + 1).flatMap((row, offset) => {
    const rawSymbol = textAt(row, columns, "Symbol");
    const quantity = numberAt(row, columns, "Qty (Quantity)");
    const assetType = textAt(row, columns, "Asset Type");
    const isBlankRow = row.every((value) => !value.trim());
    if (isBlankRow) {
      return [];
    }
    if (!rawSymbol || (assetType !== "Cash and Money Market" && !KNOWN_NON_POSITION_ROW_LABELS.has(rawSymbol) && quantity === null)) {
      invalidRows.push({ rowIndex: headerIndex + 1 + offset, reason: "Missing or unreadable symbol/quantity" });
      return [];
    }
    if (KNOWN_NON_POSITION_ROW_LABELS.has(rawSymbol) || assetType === "Cash and Money Market") {
      return [];
    }

    const parsed = parseSchwabSymbol(rawSymbol);
    const accountKey = accountKeyFor(options.accountHint);
    const fingerprint = positionFingerprint(accountKey, parsed.symbol);
    const record: NormalizedBrokerRecord = {
      provider: "SCHWAB",
      kind: "POSITION",
      fingerprint,
      identityKey: positionIdentityKey(accountKey, parsed.symbol, observedAt),
      reconciliationKey: positionReconciliationKey(accountKey, parsed.symbol),
      occurredAt: null,
      observedAt,
      symbol: parsed.symbol,
      underlyingSymbol: parsed.underlyingSymbol,
      action: null,
      description: textAt(row, columns, "Description"),
      quantity,
      price: numberAt(row, columns, "Price"),
      fees: null,
      amount: numberAt(row, columns, "Mkt Val (Market Value)"),
      sources: ["SCHWAB_POSITIONS_CSV"],
      sourceIds: [sourceId("positions-csv", fingerprintSourceMaterial(row))],
      metadata: {
        accountHint: options.accountHint ?? null,
        rawSymbol,
        assetType,
        costBasis: numberAt(row, columns, "Cost Basis"),
        dayChange: numberAt(row, columns, "Day Chng $ (Day Change $)"),
        gainLoss: numberAt(row, columns, "Gain $ (Gain/Loss $)"),
        economicEffect: "CURRENT_POSITION",
      },
    };

    return [record];
  });

  return { records, invalidRows };
}

export function parseSchwabTransactionsCsv(input: string, options: CsvParseOptions = {}): NormalizedBrokerRecord[] {
  return parseSchwabTransactionsCsvWithDiagnostics(input, options).records;
}

export function parseSchwabTransactionsCsvWithDiagnostics(
  input: string,
  options: CsvParseOptions = {},
): CsvParseWithDiagnostics {
  const rows = parseCsvRows(input);
  const headerIndex = findHeaderIndex(rows, ["Date", "Action", "Description", "Amount"]);
  const columns = headerMap(rows[headerIndex]);
  const invalidRows: InvalidCsvRow[] = [];

  const records = rows.slice(headerIndex + 1).flatMap((row, offset) => {
    const isBlankRow = row.every((value) => !value.trim());
    if (isBlankRow) {
      return [];
    }
    const action = textAt(row, columns, "Action");
    const description = textAt(row, columns, "Description");
    const dateText = textAt(row, columns, "Date");
    const amount = numberAt(row, columns, "Amount");
    if (!dateText) {
      invalidRows.push({ rowIndex: headerIndex + 1 + offset, reason: "Missing or unreadable date" });
      return [];
    }
    if (!action && !description && amount === null) {
      return [];
    }

    const parsedDate = parseSchwabDateCell(dateText);
    const rawSymbol = textAt(row, columns, "Symbol");
    const parsedSymbol = rawSymbol ? parseSchwabSymbol(rawSymbol) : null;
    const accountKey = accountKeyFor(options.accountHint);
    const fingerprint = transactionFingerprint({
      accountKey,
      occurredAt: parsedDate.occurredAt,
      symbol: parsedSymbol?.symbol ?? null,
      action,
      description,
      amount,
    });

    const record: NormalizedBrokerRecord = {
      provider: "SCHWAB",
      kind: "TRANSACTION",
      fingerprint,
      identityKey: transactionIdentityKey({
        accountKey,
        occurredAt: parsedDate.occurredAt,
        symbol: parsedSymbol?.symbol ?? null,
        action,
        description,
      }),
      reconciliationKey: parsedSymbol ? optionReconciliationKey(parsedSymbol.symbol) : cashReconciliationKey(parsedDate.occurredAt, action, amount),
      occurredAt: parsedDate.occurredAt,
      observedAt: null,
      symbol: parsedSymbol?.symbol ?? null,
      underlyingSymbol: parsedSymbol?.underlyingSymbol ?? null,
      action,
      description,
      quantity: numberAt(row, columns, "Quantity"),
      price: numberAt(row, columns, "Price"),
      fees: numberAt(row, columns, "Fees & Comm"),
      amount,
      sources: ["SCHWAB_TRANSACTIONS_CSV"],
      sourceIds: [sourceId("transactions-csv", fingerprintSourceMaterial(row))],
      metadata: {
        accountHint: options.accountHint ?? null,
        rawSymbol,
        reportedDate: dateText,
        asOfDate: parsedDate.asOfDate?.toISOString() ?? null,
        economicEffect: "ACTIVITY",
        activityKind: classifyBrokerTransactionAction(action),
      },
    };

    return [record];
  });

  return { records, invalidRows };
}

export function parseSchwabGainLossCsv(input: string, options: CsvParseOptions = {}): NormalizedBrokerRecord[] {
  return parseSchwabGainLossCsvWithDiagnostics(input, options).records;
}

export function parseSchwabGainLossCsvWithDiagnostics(
  input: string,
  options: CsvParseOptions = {},
): CsvParseWithDiagnostics {
  const rows = parseCsvRows(input);
  const headerIndex = findHeaderIndex(rows, ["Symbol", "Closed Date", "Opened Date", "Gain/Loss ($)"]);
  const columns = headerMap(rows[headerIndex]);
  const invalidRows: InvalidCsvRow[] = [];

  const records = rows.slice(headerIndex + 1).flatMap((row, offset) => {
    const isBlankRow = row.every((value) => !value.trim());
    if (isBlankRow) {
      return [];
    }
    const rawSymbol = textAt(row, columns, "Symbol");
    const closedAt = dateAt(row, columns, "Closed Date");
    const openedAt = dateAt(row, columns, "Opened Date");
    if (!rawSymbol || !closedAt) {
      invalidRows.push({ rowIndex: headerIndex + 1 + offset, reason: "Missing symbol or closed date" });
      return [];
    }

    const parsedSymbol = parseSchwabSymbol(rawSymbol);
    const accountKey = accountKeyFor(options.accountHint);
    const realizedGainLoss = numberAt(row, columns, "Gain/Loss ($)");
    const fingerprint = realizedGainLossFingerprint({
      accountKey,
      symbol: parsedSymbol.symbol,
      closedAt,
      openedAt,
      quantity: numberAt(row, columns, "Quantity"),
      proceeds: numberAt(row, columns, "Proceeds"),
      costBasis: numberAt(row, columns, "Cost Basis (CB)"),
      realizedGainLoss,
      term: textAt(row, columns, "Term"),
    });

    const record: NormalizedBrokerRecord = {
      provider: "SCHWAB",
      kind: "REALIZED_GAIN_LOSS",
      fingerprint,
      identityKey: realizedGainLossIdentityKey(accountKey, parsedSymbol.symbol, closedAt, openedAt),
      reconciliationKey: optionReconciliationKey(parsedSymbol.symbol),
      occurredAt: closedAt,
      observedAt: null,
      symbol: parsedSymbol.symbol,
      underlyingSymbol: parsedSymbol.underlyingSymbol,
      action: "REALIZED_GAIN_LOSS",
      description: textAt(row, columns, "Name"),
      quantity: numberAt(row, columns, "Quantity"),
      price: null,
      fees: null,
      amount: null,
      sources: ["SCHWAB_GAINLOSS_CSV"],
      sourceIds: [sourceId("gainloss-csv", fingerprintSourceMaterial(row))],
      metadata: {
        accountHint: options.accountHint ?? null,
        rawSymbol,
        openedAt: openedAt?.toISOString() ?? null,
        proceedsPerShare: numberAt(row, columns, "Proceeds Per Share"),
        costPerShare: numberAt(row, columns, "Cost Per Share"),
        proceeds: numberAt(row, columns, "Proceeds"),
        costBasis: numberAt(row, columns, "Cost Basis (CB)"),
        realizedGainLoss,
        realizedGainLossPercent: numberAt(row, columns, "Gain/Loss (%)"),
        term: textAt(row, columns, "Term"),
        washSale: textAt(row, columns, "Wash Sale?"),
        economicEffect: "RECONCILIATION_ONLY",
      },
    };

    return [record];
  });

  return { records, invalidRows };
}

export function normalizeSchwabApiPosition(position: BrokerPosition, observedAt = new Date()): NormalizedBrokerRecord {
  const parsed = parseSchwabSymbol(position.symbol);
  const accountKey = accountKeyFor(position.accountId);
  const symbol = parsed.symbol;
  return {
    provider: "SCHWAB",
    kind: "POSITION",
    fingerprint: positionFingerprint(accountKey, symbol),
    identityKey: positionIdentityKey(accountKey, symbol, observedAt),
    reconciliationKey: positionReconciliationKey(accountKey, symbol),
    occurredAt: null,
    observedAt,
    symbol,
    underlyingSymbol: position.underlyingSymbol ?? parsed.underlyingSymbol,
    action: null,
    description: null,
    quantity: position.quantity,
    price: null,
    fees: null,
    amount: position.marketValue,
    sources: ["SCHWAB_API"],
    sourceIds: [sourceId("api-position", `${accountKey}|${symbol}`)],
    metadata: {
      accountId: position.accountId,
      assetType: position.assetType ?? null,
      putCall: position.putCall ?? parsed.optionType ?? null,
      strikePrice: position.strikePrice ?? parsed.strike ?? null,
      marketValue: position.marketValue,
      economicEffect: "CURRENT_POSITION",
    },
  };
}

export function normalizeSchwabApiTransaction(transaction: BrokerTransaction): NormalizedBrokerRecord {
  const parsed = transaction.symbol ? parseSchwabSymbol(transaction.symbol) : null;
  const accountKey = accountKeyFor(transaction.accountId);
  const fingerprint = transactionFingerprint({
    accountKey,
    occurredAt: transaction.occurredAt,
    symbol: parsed?.symbol ?? null,
    action: null,
    description: transaction.description,
    amount: transaction.amount,
  });

  return {
    provider: "SCHWAB",
    kind: "TRANSACTION",
    fingerprint,
    // The API gives us a real stable ID - use it directly as the strongest-tier identity
    // instead of the attribute-based fallback used for CSV rows.
    identityKey: `api-transaction:${accountKey}:${transaction.id}`,
    reconciliationKey: parsed ? optionReconciliationKey(parsed.symbol) : cashReconciliationKey(transaction.occurredAt, null, transaction.amount),
    occurredAt: transaction.occurredAt,
    observedAt: null,
    symbol: parsed?.symbol ?? null,
    underlyingSymbol: parsed?.underlyingSymbol ?? null,
    action: null,
    description: transaction.description,
    quantity: null,
    price: null,
    fees: null,
    amount: transaction.amount,
    sources: ["SCHWAB_API"],
    sourceIds: [`schwab-api-transaction:${transaction.id}`],
    metadata: {
      accountId: transaction.accountId,
      brokerTransactionId: transaction.id,
      economicEffect: "ACTIVITY",
    },
  };
}

export function mergeBrokerRecords(records: NormalizedBrokerRecord[]): NormalizedBrokerRecord[] {
  const merged = new Map<string, NormalizedBrokerRecord>();
  for (const record of records) {
    const key = `${record.kind}:${record.fingerprint}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, cloneRecord(record));
      continue;
    }

    merged.set(key, {
      ...existing,
      reconciliationKey: existing.reconciliationKey ?? record.reconciliationKey,
      occurredAt: latestDate(existing.occurredAt, record.occurredAt),
      observedAt: latestDate(existing.observedAt, record.observedAt),
      symbol: existing.symbol ?? record.symbol,
      underlyingSymbol: existing.underlyingSymbol ?? record.underlyingSymbol,
      action: existing.action ?? record.action,
      description: existing.description ?? record.description,
      quantity: existing.quantity ?? record.quantity,
      price: existing.price ?? record.price,
      fees: existing.fees ?? record.fees,
      amount: existing.amount ?? record.amount,
      sources: unique([...existing.sources, ...record.sources]),
      sourceIds: unique([...existing.sourceIds, ...record.sourceIds]),
      metadata: {
        ...existing.metadata,
        ...record.metadata,
        mergedSources: unique([...existing.sources, ...record.sources]),
      },
    });
  }

  return [...merged.values()];
}

export function reconcileBrokerRecords(records: NormalizedBrokerRecord[]): BrokerRecordReconciliationResult {
  const merged = mergeBrokerRecords(records);
  const groups = new Map<string, NormalizedBrokerRecord[]>();
  for (const record of merged) {
    if (!record.reconciliationKey) {
      continue;
    }
    groups.set(record.reconciliationKey, [...(groups.get(record.reconciliationKey) ?? []), record]);
  }

  const links: BrokerRecordReconciliation[] = [];
  for (const [key, group] of groups) {
    const sources = unique(group.flatMap((record) => record.sources));
    const recordFingerprints = unique(group.map((record) => record.fingerprint));
    if (group.some((record) => record.kind === "POSITION" && hasSources(record, ["SCHWAB_API", "SCHWAB_POSITIONS_CSV"]))) {
      links.push({
        key,
        status: "CURRENT_POSITION_CONFIRMED",
        recordFingerprints,
        sources,
        realizedPLDelta: 0,
      });
    }

    if (group.some((record) => record.kind === "TRANSACTION") && group.some((record) => record.kind === "REALIZED_GAIN_LOSS")) {
      links.push({
        key,
        status: "REALIZED_RESULT_CONFIRMED",
        recordFingerprints,
        sources,
        realizedPLDelta: 0,
      });
    }
  }

  return {
    records: merged,
    links,
    campaignRealizedPLDelta: 0,
  };
}

export type SchwabCsvExportType = "POSITIONS" | "TRANSACTIONS" | "REALIZED_GAIN_LOSS";

/**
 * Detects which of the three Schwab exports a CSV file is by looking for each export's
 * distinctive required header set, never by filename. Returns null when nothing matches -
 * callers must treat that as an invalid/unsupported file, not guess.
 */
export function detectSchwabCsvExportType(input: string): SchwabCsvExportType | null {
  const rows = parseCsvRows(input);
  if (hasHeaderRow(rows, ["Symbol", "Closed Date", "Opened Date", "Gain/Loss ($)"])) {
    return "REALIZED_GAIN_LOSS";
  }
  if (hasHeaderRow(rows, ["Symbol", "Qty (Quantity)", "Mkt Val (Market Value)", "Asset Type"])) {
    return "POSITIONS";
  }
  if (hasHeaderRow(rows, ["Date", "Action", "Description", "Amount"])) {
    return "TRANSACTIONS";
  }
  return null;
}

function hasHeaderRow(rows: string[][], requiredHeaders: string[]) {
  return rows.some((row) => requiredHeaders.every((header) => row.includes(header)));
}

/** Deterministic content fingerprint for an uploaded file - never the filename. */
export function fingerprintCsvContent(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

export function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        value += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(value);
      value = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
      continue;
    }

    value += char;
  }

  if (value.length || row.length) {
    row.push(value);
    rows.push(row);
  }

  return rows;
}

function findHeaderIndex(rows: string[][], requiredHeaders: string[]) {
  const index = rows.findIndex((row) => requiredHeaders.every((header) => row.includes(header)));
  if (index === -1) {
    throw new Error(`Schwab CSV is missing expected headers: ${requiredHeaders.join(", ")}`);
  }
  return index;
}

function headerMap(headerRow: string[]) {
  const map = new Map<string, number>();
  headerRow.forEach((header, index) => {
    const normalized = header.trim();
    if (normalized) {
      map.set(normalized, index);
    }
  });
  return map;
}

function firstNonEmptyRow(rows: string[][]) {
  return rows.find((row) => row.some((value) => value.trim()));
}

function textAt(row: string[], columns: Map<string, number>, header: string) {
  const index = columns.get(header);
  if (index === undefined) {
    return null;
  }
  const value = row[index]?.trim() ?? "";
  return value && value !== "--" && value !== "N/A" ? value : null;
}

function numberAt(row: string[], columns: Map<string, number>, header: string) {
  const text = textAt(row, columns, header);
  return parseSchwabNumber(text);
}

function dateAt(row: string[], columns: Map<string, number>, header: string) {
  const text = textAt(row, columns, header);
  return text ? parseSlashDate(text) : null;
}

function parseSchwabNumber(value: string | null) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === "--" || trimmed === "N/A") {
    return null;
  }

  const negative = trimmed.startsWith("-") || (trimmed.startsWith("(") && trimmed.endsWith(")"));
  const cleaned = trimmed.replace(/[$,%()]/g, "").replace(/^-/, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? (negative ? -parsed : parsed) : null;
}

function parseSchwabDateCell(value: string) {
  const matches = [...value.matchAll(/(\d{1,2}\/\d{1,2}\/\d{4})/g)].map((match) => parseSlashDate(match[1]));
  return {
    occurredAt: matches[0] ?? null,
    asOfDate: matches[1] ?? null,
  };
}

function parseSlashDate(value: string) {
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) {
    return null;
  }
  const [, month, day, year] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

function parsePositionsObservedAt(title: string) {
  const match = title.match(/as of\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s*ET,\s*(\d{4})\/(\d{2})\/(\d{2})/i);
  if (!match) {
    return null;
  }
  const [, hourText, minuteText, meridiem, year, month, day] = match;
  let hour = Number(hourText) % 12;
  if (meridiem.toUpperCase() === "PM") {
    hour += 12;
  }
  return easternWallTimeToUtc(Number(year), Number(month), Number(day), hour, Number(minuteText));
}

function easternWallTimeToUtc(year: number, month: number, day: number, hour: number, minute: number) {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(utcGuess);
  const valueFor = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  const zonedAsUtc = Date.UTC(
    valueFor("year"),
    valueFor("month") - 1,
    valueFor("day"),
    valueFor("hour"),
    valueFor("minute"),
  );
  const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  return new Date(utcGuess.getTime() + (desiredAsUtc - zonedAsUtc));
}

function parseSchwabSymbol(rawSymbol: string): ParsedSymbol {
  const raw = rawSymbol.trim();
  const occ = parseOccOptionSymbol(raw);
  if (occ) {
    return {
      symbol: occSymbol({
        underlying: occ.underlying,
        expiration: occ.expiration,
        optionType: occ.optionType,
        strike: occ.strike,
      }),
      underlyingSymbol: occ.underlying,
      optionType: occ.optionType,
      expiration: occ.expiration,
      strike: occ.strike,
      rawSymbol: raw,
    };
  }

  const displayOption = raw.match(/^([A-Z]{1,6})\s+(\d{2})\/(\d{2})\/(\d{4})\s+(\d+(?:\.\d+)?)\s+([PC])$/i);
  if (displayOption) {
    const [, underlying, month, day, year, strike, putCall] = displayOption;
    const expiration = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    const optionType = putCall.toUpperCase() === "P" ? "PUT" : "CALL";
    return {
      symbol: occSymbol({ underlying, expiration, optionType, strike: Number(strike) }),
      underlyingSymbol: underlying.toUpperCase(),
      optionType,
      expiration,
      strike: Number(strike),
      rawSymbol: raw,
    };
  }

  const symbol = raw.toUpperCase().replace(/\s+/g, " ");
  return {
    symbol,
    underlyingSymbol: symbol.split(/\s+/)[0] ?? null,
    rawSymbol: raw,
  };
}

function occSymbol(input: { underlying: string; expiration: Date; optionType: "PUT" | "CALL"; strike: number }) {
  const year = String(input.expiration.getUTCFullYear() % 100).padStart(2, "0");
  const month = String(input.expiration.getUTCMonth() + 1).padStart(2, "0");
  const day = String(input.expiration.getUTCDate()).padStart(2, "0");
  const putCall = input.optionType === "PUT" ? "P" : "C";
  const strike = String(Math.round(input.strike * 1000)).padStart(8, "0");
  return `${input.underlying.toUpperCase()} ${year}${month}${day}${putCall}${strike}`;
}

function accountKeyFor(accountHint: string | undefined | null) {
  return normalizeText(accountHint ?? "unknown-account");
}

function positionFingerprint(accountKey: string, symbol: string) {
  return sourceId("position", `${accountKey}|${symbol}`);
}

function positionIdentityKey(accountKey: string, symbol: string, observedAt: Date | null) {
  return `position:${accountKey}:${symbol}:${observedAt ? observedAt.toISOString() : "unknown-time"}`;
}

function transactionIdentityKey(input: {
  accountKey: string;
  occurredAt: Date | null;
  symbol: string | null;
  action: string | null;
  description: string | null;
}) {
  return `transaction:${[
    input.accountKey,
    dateKey(input.occurredAt),
    input.symbol ?? "",
    normalizeText([input.action, input.description].filter(Boolean).join(" ")),
  ].join("|")}`;
}

function realizedGainLossIdentityKey(accountKey: string, symbol: string, closedAt: Date, openedAt: Date | null) {
  return `realized-gain-loss:${[accountKey, symbol, dateKey(closedAt), dateKey(openedAt)].join("|")}`;
}

function transactionFingerprint(input: {
  accountKey: string;
  occurredAt: Date | null;
  symbol: string | null;
  action: string | null;
  description: string | null;
  amount: number | null;
}) {
  return sourceId(
    "transaction",
    [
      input.accountKey,
      dateKey(input.occurredAt),
      input.symbol ?? "",
      moneyKey(input.amount),
      normalizeText([input.action, input.description].filter(Boolean).join(" ")),
    ].join("|"),
  );
}

function realizedGainLossFingerprint(input: {
  accountKey: string;
  symbol: string;
  closedAt: Date;
  openedAt: Date | null;
  quantity: number | null;
  proceeds: number | null;
  costBasis: number | null;
  realizedGainLoss: number | null;
  term: string | null;
}) {
  return sourceId(
    "realized-gain-loss",
    [
      input.accountKey,
      input.symbol,
      dateKey(input.closedAt),
      dateKey(input.openedAt),
      moneyKey(input.quantity),
      moneyKey(input.proceeds),
      moneyKey(input.costBasis),
      moneyKey(input.realizedGainLoss),
      normalizeText(input.term ?? ""),
    ].join("|"),
  );
}

function optionReconciliationKey(symbol: string) {
  return `option:${symbol}`;
}

function positionReconciliationKey(accountKey: string, symbol: string) {
  return `position:${accountKey}:${symbol}`;
}

function cashReconciliationKey(occurredAt: Date | null, action: string | null, amount: number | null) {
  return `cash:${dateKey(occurredAt)}:${normalizeText(action ?? "")}:${moneyKey(amount)}`;
}

function sourceId(prefix: string, material: string) {
  return `${prefix}:${hash(material)}`;
}

function fingerprintSourceMaterial(row: string[]) {
  return row.map((value) => value.trim()).join("|");
}

function hash(material: string) {
  return createHash("sha256").update(material).digest("hex").slice(0, 24);
}

function normalizeText(value: string) {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

function dateKey(value: Date | null) {
  return value ? value.toISOString().slice(0, 10) : "";
}

function moneyKey(value: number | null) {
  return value === null ? "" : value.toFixed(4);
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function hasSources(record: NormalizedBrokerRecord, sources: NormalizedBrokerRecordSource[]) {
  return sources.every((source) => record.sources.includes(source));
}

function latestDate(left: Date | null, right: Date | null) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left.getTime() >= right.getTime() ? left : right;
}

function cloneRecord(record: NormalizedBrokerRecord): NormalizedBrokerRecord {
  return {
    ...record,
    sources: [...record.sources],
    sourceIds: [...record.sourceIds],
    metadata: { ...record.metadata },
  };
}
