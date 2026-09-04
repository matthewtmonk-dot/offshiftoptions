import "server-only";

import { ALPHA_VANTAGE_BASE_URL } from "./config";
import { fetchAlphaVantageJson, type AlphaVantageFetch } from "./client";
import { ALPHA_VANTAGE_OVERVIEW_FUNCTION } from "./overview-diagnostic";

/**
 * Production fetch-and-normalize path for a single ticker's OVERVIEW response, used by the
 * shared fundamentals cache sync (src/lib/alpha-vantage-fundamentals.ts). Distinct from
 * overview-diagnostic.ts, which exists to display raw ABSENT/PRESENT_NULL/PRESENT_VALUE
 * allowlist presence to a human - this module returns typed, normalized values ready to write
 * to TickerFundamentals. Both modules independently apply the same "None"/"-"/"" -> null
 * normalization because they serve different callers (display vs. persistence) and neither
 * should depend on the other's internal shape.
 */
export type NormalizedOverviewFields = {
  name: string | null;
  description: string | null;
  sector: string | null;
  industry: string | null;
  marketCapitalization: number | null;
  peRatio: number | null;
  pegRatio: number | null;
  eps: number | null;
  dividendPerShare: number | null;
  dividendYield: number | null;
  profitMargin: number | null;
  operatingMarginTtm: number | null;
  returnOnAssetsTtm: number | null;
  returnOnEquityTtm: number | null;
  revenueTtm: number | null;
  grossProfitTtm: number | null;
  quarterlyEarningsGrowthYoy: number | null;
  quarterlyRevenueGrowthYoy: number | null;
  analystTargetPrice: number | null;
  analystStrongBuy: number | null;
  analystBuy: number | null;
  analystHold: number | null;
  analystSell: number | null;
  analystStrongSell: number | null;
  bookValue: number | null;
  priceToBookRatio: number | null;
  evToEbitda: number | null;
  beta: number | null;
};

export type AlphaVantageOverviewFetchResult =
  | { outcome: "SUCCESS"; fields: NormalizedOverviewFields }
  | { outcome: "RATE_LIMITED"; message: string }
  | { outcome: "ERROR_MESSAGE"; message: string }
  | { outcome: "EMPTY"; message: string }
  | { outcome: "HTTP_ERROR"; status: number; message: string };

const BLOCKED_VALUE_PATTERN = /\b(api[_\s-]*key|access[_\s-]*token|secret|password|credential|authorization|bearer)\b/i;

export async function fetchAlphaVantageOverviewForTicker({
  apiKey,
  ticker,
  fetchFn,
  baseUrl = ALPHA_VANTAGE_BASE_URL,
}: {
  apiKey: string;
  ticker: string;
  fetchFn?: AlphaVantageFetch;
  baseUrl?: string;
}): Promise<AlphaVantageOverviewFetchResult> {
  const { payload, status } = await fetchAlphaVantageJson({
    apiKey,
    searchParams: new URLSearchParams({ function: ALPHA_VANTAGE_OVERVIEW_FUNCTION, symbol: ticker }),
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

  const symbol = obj["Symbol"];
  if (Object.keys(obj).length === 0 || typeof symbol !== "string" || !symbol.trim()) {
    return {
      outcome: "EMPTY",
      message: "Alpha Vantage returned an empty overview object (no Symbol field) - invalid symbol, key, or plan restriction.",
    };
  }

  return {
    outcome: "SUCCESS",
    fields: {
      name: nullableString(obj["Name"], apiKey),
      description: nullableString(obj["Description"], apiKey, 2000),
      sector: nullableString(obj["Sector"], apiKey),
      industry: nullableString(obj["Industry"], apiKey),
      marketCapitalization: nullableNumber(obj["MarketCapitalization"]),
      peRatio: nullableNumber(obj["PERatio"]),
      pegRatio: nullableNumber(obj["PEGRatio"]),
      eps: nullableNumber(obj["EPS"]),
      dividendPerShare: nullableNumber(obj["DividendPerShare"]),
      dividendYield: nullableNumber(obj["DividendYield"]),
      profitMargin: nullableNumber(obj["ProfitMargin"]),
      operatingMarginTtm: nullableNumber(obj["OperatingMarginTTM"]),
      returnOnAssetsTtm: nullableNumber(obj["ReturnOnAssetsTTM"]),
      returnOnEquityTtm: nullableNumber(obj["ReturnOnEquityTTM"]),
      revenueTtm: nullableNumber(obj["RevenueTTM"]),
      grossProfitTtm: nullableNumber(obj["GrossProfitTTM"]),
      quarterlyEarningsGrowthYoy: nullableNumber(obj["QuarterlyEarningsGrowthYOY"]),
      quarterlyRevenueGrowthYoy: nullableNumber(obj["QuarterlyRevenueGrowthYOY"]),
      analystTargetPrice: nullableNumber(obj["AnalystTargetPrice"]),
      analystStrongBuy: nullableNumber(obj["AnalystRatingStrongBuy"]),
      analystBuy: nullableNumber(obj["AnalystRatingBuy"]),
      analystHold: nullableNumber(obj["AnalystRatingHold"]),
      analystSell: nullableNumber(obj["AnalystRatingSell"]),
      analystStrongSell: nullableNumber(obj["AnalystRatingStrongSell"]),
      bookValue: nullableNumber(obj["BookValue"]),
      priceToBookRatio: nullableNumber(obj["PriceToBookRatio"]),
      evToEbitda: nullableNumber(obj["EVToEBITDA"]),
      beta: nullableNumber(obj["Beta"]),
    },
  };
}

/**
 * Alpha Vantage's own null sentinel for a genuinely unavailable field is the literal string
 * "None" (occasionally "-" or ""). All normalize to null here - never to 0, never treated as a
 * real string value. A real "0" always parses to numeric 0 and survives untouched.
 */
function isNullSentinel(trimmed: string): boolean {
  return trimmed === "" || trimmed === "-" || trimmed.toLowerCase() === "none";
}

/**
 * Redacts the literal API key (and anything token/secret-shaped) from a field value the same
 * way sanitizeMessage() does for provider messages - a SUCCESS response's free-text fields
 * (e.g. Description) are not exempt from this defense-in-depth check just because they came
 * from the "happy path" outcome.
 */
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
