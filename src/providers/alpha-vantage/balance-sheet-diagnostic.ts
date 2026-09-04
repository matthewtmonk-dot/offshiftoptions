import "server-only";

import { ALPHA_VANTAGE_BASE_URL } from "./config";
import { fetchAlphaVantageJson, type AlphaVantageFetch } from "./client";
import { ALPHA_VANTAGE_BALANCE_SHEET_FUNCTION } from "./balance-sheet";

/**
 * TEMPORARY, one-ticker verification tool (2026-09 slice) - NOT part of the production
 * Balance Sheet pipeline. Its only purpose is to let Matt see exactly which Alpha Vantage
 * BALANCE_SHEET debt-related fields are actually populated for a real ticker, so a future
 * slice can choose a verified Debt/Equity formula instead of guessing one from documentation
 * alone. Hardcoded to APLD, costs at most one real Alpha Vantage call, and never writes to any
 * database table (see runAlphaVantageBalanceSheetDiagnostic in src/lib/alpha-vantage-diagnostic.ts
 * for the budget/lock-reserving wrapper that calls this). Delete this file (and its wiring) once
 * Debt/Equity has been verified and implemented for real.
 */
export const ALPHA_VANTAGE_BALANCE_SHEET_DIAGNOSTIC_TICKER = "APLD";

type FieldGroup = "Report" | "Current Ratio Inputs" | "Debt/Equity Candidate Inputs";

type FieldDefinition = {
  group: FieldGroup;
  label: string;
  key: string;
  note?: string;
};

export type AlphaVantageFieldPresence =
  | { state: "ABSENT"; value: null }
  | { state: "PRESENT_NULL"; value: null; raw?: string }
  | { state: "PRESENT_VALUE"; value: string }
  | { state: "PRESENT_UNDISPLAYED"; value: string };

export type AlphaVantageBalanceSheetDiagnosticRow = {
  group: FieldGroup;
  label: string;
  key: string;
  note?: string;
  presence: AlphaVantageFieldPresence;
};

export type AlphaVantageBalanceSheetDiagnosticOutcome = "SUCCESS" | "RATE_LIMITED" | "ERROR_MESSAGE" | "EMPTY" | "HTTP_ERROR" | "NETWORK_ERROR";

export type AlphaVantageBalanceSheetDiagnosticReport = {
  source: "Alpha Vantage";
  endpointFunction: typeof ALPHA_VANTAGE_BALANCE_SHEET_FUNCTION;
  readOnly: true;
  nothingSaved: true;
  timestamp: string;
  ticker: string;
  outcome: AlphaVantageBalanceSheetDiagnosticOutcome;
  message?: string;
  /** Verified Current Ratio formula applied to whatever this real response actually contained -
   * null if the required fields weren't both present as real numbers. */
  computedCurrentRatio: number | null;
  rows: AlphaVantageBalanceSheetDiagnosticRow[];
};

// Only the fields needed to (a) compute the verified Current Ratio formula and (b) let a human
// see which debt/equity-adjacent fields Alpha Vantage actually returns for a real ticker, so
// Debt/Equity can be implemented later without guessing. Never the full balance sheet.
const FIELD_DEFINITIONS: FieldDefinition[] = [
  { group: "Report", label: "Fiscal Date Ending", key: "fiscalDateEnding" },
  { group: "Report", label: "Reported Currency", key: "reportedCurrency" },
  { group: "Current Ratio Inputs", label: "Total Current Assets", key: "totalCurrentAssets" },
  { group: "Current Ratio Inputs", label: "Total Current Liabilities", key: "totalCurrentLiabilities" },
  { group: "Debt/Equity Candidate Inputs", label: "Short Term Debt", key: "shortTermDebt" },
  { group: "Debt/Equity Candidate Inputs", label: "Current Debt", key: "currentDebt" },
  { group: "Debt/Equity Candidate Inputs", label: "Current Portion of Long-Term Debt", key: "currentLongTermDebt" },
  { group: "Debt/Equity Candidate Inputs", label: "Long Term Debt", key: "longTermDebt" },
  { group: "Debt/Equity Candidate Inputs", label: "Long Term Debt (Noncurrent)", key: "longTermDebtNoncurrent" },
  { group: "Debt/Equity Candidate Inputs", label: "Short + Long Term Debt Total", key: "shortLongTermDebtTotal" },
  { group: "Debt/Equity Candidate Inputs", label: "Total Liabilities", key: "totalLiabilities" },
  { group: "Debt/Equity Candidate Inputs", label: "Total Shareholder Equity", key: "totalShareholderEquity" },
];

const BLOCKED_VALUE_PATTERN = /\b(api[_\s-]*key|access[_\s-]*token|secret|password|credential|authorization|bearer)\b/i;

export async function buildAlphaVantageBalanceSheetDiagnosticFromApiKey({
  apiKey,
  ticker = ALPHA_VANTAGE_BALANCE_SHEET_DIAGNOSTIC_TICKER,
  fetchFn,
  baseUrl = ALPHA_VANTAGE_BASE_URL,
  now = new Date(),
}: {
  apiKey: string;
  ticker?: string;
  fetchFn?: AlphaVantageFetch;
  baseUrl?: string;
  now?: Date;
}): Promise<AlphaVantageBalanceSheetDiagnosticReport> {
  const normalizedTicker = ticker.trim().toUpperCase();
  const base = {
    source: "Alpha Vantage" as const,
    endpointFunction: ALPHA_VANTAGE_BALANCE_SHEET_FUNCTION,
    readOnly: true as const,
    nothingSaved: true as const,
    timestamp: now.toISOString(),
    ticker: normalizedTicker,
  };

  let payload: unknown;
  let status: number;
  try {
    const response = await fetchAlphaVantageJson({
      apiKey,
      searchParams: new URLSearchParams({ function: ALPHA_VANTAGE_BALANCE_SHEET_FUNCTION, symbol: normalizedTicker }),
      fetchFn,
      baseUrl,
    });
    payload = response.payload;
    status = response.status;
  } catch {
    return {
      ...base,
      outcome: "NETWORK_ERROR",
      message: "Alpha Vantage request failed (network error). No response body was returned.",
      computedCurrentRatio: null,
      rows: absentRows(),
    };
  }

  if (status < 200 || status >= 300) {
    return {
      ...base,
      outcome: "HTTP_ERROR",
      message: sanitizeMessage(`Alpha Vantage returned HTTP ${status}.`, apiKey),
      computedCurrentRatio: null,
      rows: absentRows(),
    };
  }

  const obj = objectValue(payload);
  if (!obj) {
    return { ...base, outcome: "ERROR_MESSAGE", message: "Alpha Vantage returned a non-object response.", computedCurrentRatio: null, rows: absentRows() };
  }
  if (typeof obj["Note"] === "string") {
    return { ...base, outcome: "RATE_LIMITED", message: sanitizeMessage(obj["Note"], apiKey), computedCurrentRatio: null, rows: absentRows() };
  }
  if (typeof obj["Information"] === "string") {
    return { ...base, outcome: "RATE_LIMITED", message: sanitizeMessage(obj["Information"], apiKey), computedCurrentRatio: null, rows: absentRows() };
  }
  if (typeof obj["Error Message"] === "string") {
    return { ...base, outcome: "ERROR_MESSAGE", message: sanitizeMessage(obj["Error Message"], apiKey), computedCurrentRatio: null, rows: absentRows() };
  }

  const symbol = obj["symbol"];
  const quarterlyReports = Array.isArray(obj["quarterlyReports"]) ? obj["quarterlyReports"] : [];
  const latest = objectValue(quarterlyReports[0]);
  if (typeof symbol !== "string" || !symbol.trim() || !latest) {
    return {
      ...base,
      outcome: "EMPTY",
      message: "Alpha Vantage returned no usable quarterly balance sheet report for this ticker.",
      computedCurrentRatio: null,
      rows: absentRows(),
    };
  }

  const rows: AlphaVantageBalanceSheetDiagnosticRow[] = FIELD_DEFINITIONS.map((definition) => ({
    group: definition.group,
    label: definition.label,
    key: definition.key,
    note: definition.note,
    presence: observeField(latest, definition.key, apiKey),
  }));

  const totalCurrentAssets = numericFromPresence(rows.find((row) => row.key === "totalCurrentAssets")?.presence);
  const totalCurrentLiabilities = numericFromPresence(rows.find((row) => row.key === "totalCurrentLiabilities")?.presence);
  const computedCurrentRatio =
    totalCurrentAssets !== null && totalCurrentLiabilities !== null && totalCurrentLiabilities > 0
      ? totalCurrentAssets / totalCurrentLiabilities
      : null;

  return { ...base, outcome: "SUCCESS", computedCurrentRatio, rows };
}

function absentRows(): AlphaVantageBalanceSheetDiagnosticRow[] {
  return FIELD_DEFINITIONS.map((definition) => ({
    group: definition.group,
    label: definition.label,
    key: definition.key,
    note: definition.note,
    presence: { state: "ABSENT" as const, value: null },
  }));
}

function numericFromPresence(presence: AlphaVantageFieldPresence | undefined): number | null {
  if (!presence || presence.state !== "PRESENT_VALUE") {
    return null;
  }
  const parsed = Number(presence.value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Same ABSENT/PRESENT_NULL/PRESENT_VALUE preservation as overview-diagnostic.ts's observeField. */
function observeField(record: Record<string, unknown>, key: string, apiKey: string): AlphaVantageFieldPresence {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    return { state: "ABSENT", value: null };
  }

  const raw = record[key];
  if (raw === null || raw === undefined) {
    return { state: "PRESENT_NULL", value: null };
  }

  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
    return { state: "PRESENT_UNDISPLAYED", value: "Present, but not a primitive display value." };
  }

  const asString = typeof raw === "string" ? raw : String(raw);
  const trimmed = asString.trim();
  if (trimmed === "" || trimmed === "-" || trimmed.toLowerCase() === "none") {
    return { state: "PRESENT_NULL", value: null, raw: trimmed || "(empty string)" };
  }

  if (BLOCKED_VALUE_PATTERN.test(trimmed)) {
    return { state: "PRESENT_UNDISPLAYED", value: "Value hidden by safety filter." };
  }

  return { state: "PRESENT_VALUE", value: sanitizeMessage(trimmed, apiKey) };
}

function sanitizeMessage(message: string, apiKey: string): string {
  const withoutKey = apiKey ? message.split(apiKey).join("[REDACTED]") : message;
  return withoutKey.length > 300 ? `${withoutKey.slice(0, 297)}...` : withoutKey;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
