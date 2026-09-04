import "server-only";

import { ALPHA_VANTAGE_BASE_URL } from "./config";
import { fetchAlphaVantageJson, type AlphaVantageFetch } from "./client";

export const ALPHA_VANTAGE_BALANCE_SHEET_FUNCTION = "BALANCE_SHEET" as const;

/**
 * Production fetch-and-normalize path for a single ticker's BALANCE_SHEET response, used by the
 * shared fundamentals cache sync (src/lib/alpha-vantage-fundamentals.ts). Only Current Ratio is
 * computed here - Debt/Equity is deliberately NOT derived anywhere in this file. Alpha Vantage's
 * BALANCE_SHEET exposes several overlapping debt fields (shortTermDebt, currentDebt,
 * longTermDebt, currentLongTermDebt, longTermDebtNoncurrent, shortLongTermDebtTotal) whose exact
 * overlap/composition has not been verified against a real response (see
 * balance-sheet-diagnostic.ts, the one-ticker APLD verification tool) - inventing a formula from
 * documentation alone risks double-counting debt components, so this stays unimplemented until
 * verified. See PROJECT_HANDOFF.md's Alpha Vantage API section.
 */
export type NormalizedBalanceSheetFields = {
  /** ISO date string (Alpha Vantage's own "YYYY-MM-DD" format), e.g. "2026-06-30". */
  fiscalDateEnding: string | null;
  /** totalCurrentAssets / totalCurrentLiabilities from the latest quarterly report - null
   * whenever either input is missing/unparseable or the denominator isn't a real positive
   * number. Never guessed, never substituted from an annual report. */
  currentRatio: number | null;
};

export type AlphaVantageBalanceSheetFetchResult =
  | { outcome: "SUCCESS"; fields: NormalizedBalanceSheetFields }
  | { outcome: "RATE_LIMITED"; message: string }
  | { outcome: "ERROR_MESSAGE"; message: string }
  | { outcome: "EMPTY"; message: string }
  | { outcome: "HTTP_ERROR"; status: number; message: string };

const BLOCKED_VALUE_PATTERN = /\b(api[_\s-]*key|access[_\s-]*token|secret|password|credential|authorization|bearer)\b/i;

export async function fetchAlphaVantageBalanceSheetForTicker({
  apiKey,
  ticker,
  fetchFn,
  baseUrl = ALPHA_VANTAGE_BASE_URL,
}: {
  apiKey: string;
  ticker: string;
  fetchFn?: AlphaVantageFetch;
  baseUrl?: string;
}): Promise<AlphaVantageBalanceSheetFetchResult> {
  const { payload, status } = await fetchAlphaVantageJson({
    apiKey,
    searchParams: new URLSearchParams({ function: ALPHA_VANTAGE_BALANCE_SHEET_FUNCTION, symbol: ticker }),
    fetchFn,
    baseUrl,
  });

  if (status < 200 || status >= 300) {
    return { outcome: "HTTP_ERROR", status, message: sanitizeMessage(`Alpha Vantage returned HTTP ${status}.`, apiKey) };
  }

  const obj = objectValue(payload);
  if (!obj) {
    return { outcome: "ERROR_MESSAGE", message: "Alpha Vantage returned a non-object response." };
  }
  if (typeof obj["Note"] === "string") {
    return { outcome: "RATE_LIMITED", message: sanitizeMessage(obj["Note"], apiKey) };
  }
  if (typeof obj["Information"] === "string") {
    return { outcome: "RATE_LIMITED", message: sanitizeMessage(obj["Information"], apiKey) };
  }
  if (typeof obj["Error Message"] === "string") {
    return { outcome: "ERROR_MESSAGE", message: sanitizeMessage(obj["Error Message"], apiKey) };
  }

  const symbol = obj["symbol"];
  const quarterlyReports = Array.isArray(obj["quarterlyReports"]) ? obj["quarterlyReports"] : [];
  const latest = objectValue(quarterlyReports[0]);
  if (typeof symbol !== "string" || !symbol.trim() || !latest) {
    return {
      outcome: "EMPTY",
      message:
        "Alpha Vantage returned no usable quarterly balance sheet report - invalid symbol, invalid/missing API key, plan restriction, or no quarterly data available.",
    };
  }

  const totalCurrentAssets = nullableNumber(latest["totalCurrentAssets"]);
  const totalCurrentLiabilities = nullableNumber(latest["totalCurrentLiabilities"]);
  const currentRatio =
    totalCurrentAssets !== null && totalCurrentLiabilities !== null && totalCurrentLiabilities > 0
      ? totalCurrentAssets / totalCurrentLiabilities
      : null;

  return {
    outcome: "SUCCESS",
    fields: {
      fiscalDateEnding: nullableString(latest["fiscalDateEnding"], apiKey),
      currentRatio,
    },
  };
}

function isNullSentinel(trimmed: string): boolean {
  return trimmed === "" || trimmed === "-" || trimmed.toLowerCase() === "none";
}

function nullableString(value: unknown, apiKey: string, maxLength = 500): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (isNullSentinel(trimmed)) {
    return null;
  }
  const withoutKey = apiKey ? trimmed.split(apiKey).join("[REDACTED]") : trimmed;
  if (BLOCKED_VALUE_PATTERN.test(withoutKey)) {
    return "Value hidden by safety filter.";
  }
  return withoutKey.length > maxLength ? `${withoutKey.slice(0, maxLength - 3)}...` : withoutKey;
}

function nullableNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const trimmed = String(value).trim();
  if (isNullSentinel(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeMessage(message: string, apiKey: string): string {
  const withoutKey = apiKey ? message.split(apiKey).join("[REDACTED]") : message;
  if (BLOCKED_VALUE_PATTERN.test(withoutKey)) {
    return "Alpha Vantage returned a message that was withheld by the safety filter.";
  }
  return withoutKey.length > 300 ? `${withoutKey.slice(0, 297)}...` : withoutKey;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
