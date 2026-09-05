import "server-only";

import { ALPHA_VANTAGE_BASE_URL } from "./config";
import { fetchAlphaVantageJson, type AlphaVantageFetch } from "./client";

export const ALPHA_VANTAGE_BALANCE_SHEET_FUNCTION = "BALANCE_SHEET" as const;

/**
 * Production fetch-and-normalize path for a single ticker's BALANCE_SHEET response, used by the
 * shared fundamentals cache sync (src/lib/alpha-vantage-fundamentals.ts). Both Current Ratio and
 * Debt/Equity are computed from the SAME single request - no extra Alpha Vantage call is needed
 * to get both.
 *
 * Debt/Equity formula - verified 2026-09 against a real production APLD BALANCE_SHEET response
 * via the (now-removed) temporary one-ticker diagnostic:
 *   debtToEquity = shortLongTermDebtTotal / totalShareholderEquity
 * `shortLongTermDebtTotal` is Alpha Vantage's own pre-combined short+long-term debt figure and
 * is used as-is - it is NEVER added to `shortTermDebt`/`currentDebt`/`longTermDebt`/etc, which
 * would double-count overlapping debt components already folded into it. `totalLiabilities` is
 * NOT used as the numerator (it includes non-debt liabilities like accounts payable and deferred
 * revenue, which is a different, less precise metric). If `shortLongTermDebtTotal` itself is
 * absent for a given ticker/quarter, Debt/Equity is left null rather than synthesized from the
 * other overlapping fields - see PROJECT_HANDOFF.md's Alpha Vantage API section.
 */
export type NormalizedBalanceSheetFields = {
  /** ISO date string (Alpha Vantage's own "YYYY-MM-DD" format), e.g. "2026-06-30". */
  fiscalDateEnding: string | null;
  /** totalCurrentAssets / totalCurrentLiabilities from the latest quarterly report - null
   * whenever either input is missing/unparseable or the denominator isn't a real positive
   * number. Never guessed, never substituted from an annual report. */
  currentRatio: number | null;
  /** shortLongTermDebtTotal / totalShareholderEquity from the latest quarterly report - null
   * whenever the numerator is missing or the denominator isn't a real positive number (a
   * company with zero or negative shareholder equity has no meaningful D/E ratio). A real
   * numeric zero debt value correctly survives as 0, never collapsed to null. */
  debtToEquity: number | null;
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

  const shortLongTermDebtTotal = nullableNumber(latest["shortLongTermDebtTotal"]);
  const totalShareholderEquity = nullableNumber(latest["totalShareholderEquity"]);
  const debtToEquity =
    shortLongTermDebtTotal !== null && totalShareholderEquity !== null && totalShareholderEquity > 0
      ? shortLongTermDebtTotal / totalShareholderEquity
      : null;

  return {
    outcome: "SUCCESS",
    fields: {
      fiscalDateEnding: nullableString(latest["fiscalDateEnding"], apiKey),
      currentRatio,
      debtToEquity,
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
