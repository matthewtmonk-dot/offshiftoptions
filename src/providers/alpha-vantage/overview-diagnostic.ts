import "server-only";

import { ALPHA_VANTAGE_BASE_URL } from "./config";
import { fetchAlphaVantageJson, type AlphaVantageFetch } from "./client";

export const ALPHA_VANTAGE_OVERVIEW_TICKERS = ["APLD", "RIOT", "CORZ"] as const;
export const ALPHA_VANTAGE_OVERVIEW_FUNCTION = "OVERVIEW";

type FieldGroup = "Identity" | "Classification" | "Valuation" | "Dividend" | "Profitability" | "Growth" | "Analyst" | "Other Fundamental Ratios Checked";

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
  | { state: "PRESENT_UNDISPLAYED"; value: string }
  | { state: "CALL_UNAVAILABLE"; value: null };

export type AlphaVantageDiagnosticRow = {
  group: FieldGroup;
  label: string;
  key: string;
  note?: string;
  values: Record<string, AlphaVantageFieldPresence>;
};

export type AlphaVantageTickerOutcome =
  | { ticker: string; outcome: "SUCCESS"; fields: Record<string, AlphaVantageFieldPresence> }
  | { ticker: string; outcome: "RATE_LIMITED"; message: string }
  | { ticker: string; outcome: "ERROR_MESSAGE"; message: string }
  | { ticker: string; outcome: "EMPTY"; message: string }
  | { ticker: string; outcome: "SKIPPED"; message: string }
  | { ticker: string; outcome: "HTTP_ERROR"; status: number; message: string };

export type AlphaVantageOverviewDiagnosticReport = {
  source: "Alpha Vantage";
  endpointFunction: typeof ALPHA_VANTAGE_OVERVIEW_FUNCTION;
  readOnly: true;
  nothingSaved: true;
  timestamp: string;
  tickers: string[];
  callsConsumed: number;
  maxCallsAllowed: number;
  results: AlphaVantageTickerOutcome[];
  rateLimitHeaderObserved: boolean;
  rateLimitHeaderNames: string[];
  rows: AlphaVantageDiagnosticRow[];
};

// Exactly the fields Matt asked to check, plus a handful of other clearly-fundamental ratio
// fields worth observing while we're here (never inferred - probed via observeField() below,
// same as everything else). Current Ratio and Debt/Equity are included deliberately: OVERVIEW's
// documented schema does not define them, but we verify that against the real response rather
// than assuming it from memory.
const FIELD_DEFINITIONS: FieldDefinition[] = [
  { group: "Identity", label: "Symbol", key: "Symbol" },
  { group: "Identity", label: "Name", key: "Name" },
  { group: "Identity", label: "Description", key: "Description" },
  { group: "Classification", label: "Sector", key: "Sector" },
  { group: "Classification", label: "Industry", key: "Industry" },
  { group: "Valuation", label: "Market Capitalization", key: "MarketCapitalization" },
  { group: "Valuation", label: "P/E Ratio", key: "PERatio" },
  { group: "Valuation", label: "PEG Ratio", key: "PEGRatio" },
  { group: "Valuation", label: "EPS", key: "EPS" },
  { group: "Dividend", label: "Dividend Per Share", key: "DividendPerShare" },
  { group: "Dividend", label: "Dividend Yield", key: "DividendYield" },
  { group: "Profitability", label: "Profit Margin", key: "ProfitMargin" },
  { group: "Profitability", label: "Operating Margin (TTM)", key: "OperatingMarginTTM" },
  { group: "Profitability", label: "Return on Assets (TTM)", key: "ReturnOnAssetsTTM" },
  { group: "Profitability", label: "Return on Equity (TTM)", key: "ReturnOnEquityTTM" },
  { group: "Profitability", label: "Revenue (TTM)", key: "RevenueTTM" },
  { group: "Profitability", label: "Gross Profit (TTM)", key: "GrossProfitTTM" },
  { group: "Growth", label: "Quarterly Earnings Growth YoY", key: "QuarterlyEarningsGrowthYOY" },
  { group: "Growth", label: "Quarterly Revenue Growth YoY", key: "QuarterlyRevenueGrowthYOY" },
  { group: "Analyst", label: "Analyst Target Price", key: "AnalystTargetPrice" },
  { group: "Analyst", label: "Analyst Rating: Strong Buy", key: "AnalystRatingStrongBuy" },
  { group: "Analyst", label: "Analyst Rating: Buy", key: "AnalystRatingBuy" },
  { group: "Analyst", label: "Analyst Rating: Hold", key: "AnalystRatingHold" },
  { group: "Analyst", label: "Analyst Rating: Sell", key: "AnalystRatingSell" },
  { group: "Analyst", label: "Analyst Rating: Strong Sell", key: "AnalystRatingStrongSell" },
  {
    group: "Other Fundamental Ratios Checked",
    label: "Current Ratio",
    key: "CurrentRatio",
    note: "Not in Alpha Vantage's documented OVERVIEW schema - probed directly rather than assumed.",
  },
  {
    group: "Other Fundamental Ratios Checked",
    label: "Quick Ratio",
    key: "QuickRatio",
    note: "Not in Alpha Vantage's documented OVERVIEW schema - probed directly rather than assumed.",
  },
  {
    group: "Other Fundamental Ratios Checked",
    label: "Debt To Equity",
    key: "DebtToEquity",
    note: "Not in Alpha Vantage's documented OVERVIEW schema - probed directly rather than assumed.",
  },
  { group: "Other Fundamental Ratios Checked", label: "Book Value", key: "BookValue" },
  { group: "Other Fundamental Ratios Checked", label: "Price To Book Ratio", key: "PriceToBookRatio" },
  { group: "Other Fundamental Ratios Checked", label: "EV / EBITDA", key: "EVToEBITDA" },
  { group: "Other Fundamental Ratios Checked", label: "Beta", key: "Beta" },
];

const BLOCKED_VALUE_PATTERN = /\b(api[_\s-]*key|access[_\s-]*token|secret|password|credential|authorization|bearer)\b/i;

export type AlphaVantageRawTickerResult =
  | { kind: "FETCHED"; status: number; payload: unknown; headerNames: string[] }
  | { kind: "NETWORK_ERROR" }
  | { kind: "SKIPPED"; reason: string };

export function buildAlphaVantageOverviewDiagnosticReport({
  results,
  tickers = ALPHA_VANTAGE_OVERVIEW_TICKERS,
  timestamp = new Date(),
  apiKey = "",
}: {
  results: Record<string, AlphaVantageRawTickerResult>;
  tickers?: readonly string[];
  timestamp?: Date;
  apiKey?: string;
}): AlphaVantageOverviewDiagnosticReport {
  const normalizedTickers = normalizeTickers(tickers);
  let callsConsumed = 0;
  const rateLimitHeaderNames = new Set<string>();

  const tickerOutcomes: AlphaVantageTickerOutcome[] = normalizedTickers.map((ticker) => {
    const raw = results[ticker] ?? { kind: "SKIPPED" as const, reason: "No result recorded for this ticker." };

    if (raw.kind === "SKIPPED") {
      return { ticker, outcome: "SKIPPED", message: sanitizeMessage(raw.reason, apiKey) };
    }

    if (raw.kind === "NETWORK_ERROR") {
      callsConsumed += 1;
      return {
        ticker,
        outcome: "HTTP_ERROR",
        status: 0,
        message: "Alpha Vantage request failed (network error). No response body was returned.",
      };
    }

    callsConsumed += 1;
    for (const name of raw.headerNames) {
      if (/rate.?limit/i.test(name)) {
        rateLimitHeaderNames.add(name);
      }
    }

    if (raw.status < 200 || raw.status >= 300) {
      return {
        ticker,
        outcome: "HTTP_ERROR",
        status: raw.status,
        message: sanitizeMessage(`Alpha Vantage returned HTTP ${raw.status}.`, apiKey),
      };
    }

    const classification = classifyOverviewPayload(raw.payload, apiKey);
    return { ticker, ...classification };
  });

  return {
    source: "Alpha Vantage",
    endpointFunction: ALPHA_VANTAGE_OVERVIEW_FUNCTION,
    readOnly: true,
    nothingSaved: true,
    timestamp: timestamp.toISOString(),
    tickers: normalizedTickers,
    callsConsumed,
    maxCallsAllowed: normalizedTickers.length,
    results: tickerOutcomes,
    rateLimitHeaderObserved: rateLimitHeaderNames.size > 0,
    rateLimitHeaderNames: [...rateLimitHeaderNames],
    rows: buildRows(normalizedTickers, tickerOutcomes),
  };
}

/**
 * Fetches OVERVIEW for each ticker sequentially (never in parallel - Alpha Vantage's free tier
 * has no burst tolerance to speak of) and stops issuing further calls the moment a rate-limit/
 * throttle signal is seen, to preserve the 25/day budget. Remaining tickers are reported as
 * SKIPPED, not silently dropped.
 */
export async function buildAlphaVantageOverviewDiagnosticFromApiKey({
  apiKey,
  tickers = ALPHA_VANTAGE_OVERVIEW_TICKERS,
  fetchFn,
  baseUrl = ALPHA_VANTAGE_BASE_URL,
  now = new Date(),
}: {
  apiKey: string;
  tickers?: readonly string[];
  fetchFn?: AlphaVantageFetch;
  baseUrl?: string;
  now?: Date;
}): Promise<AlphaVantageOverviewDiagnosticReport> {
  const normalizedTickers = normalizeTickers(tickers);
  const results: Record<string, AlphaVantageRawTickerResult> = {};
  let stopEarly = false;

  for (const ticker of normalizedTickers) {
    if (stopEarly) {
      results[ticker] = {
        kind: "SKIPPED",
        reason: "Skipped to preserve the daily Alpha Vantage quota after an earlier rate-limit/throttle signal this run.",
      };
      continue;
    }

    try {
      const { payload, status, headers } = await fetchAlphaVantageJson({
        apiKey,
        searchParams: new URLSearchParams({ function: ALPHA_VANTAGE_OVERVIEW_FUNCTION, symbol: ticker }),
        fetchFn,
        baseUrl,
      });
      results[ticker] = { kind: "FETCHED", status, payload, headerNames: [...headers.keys()] };

      if (status >= 200 && status < 300 && classifyOverviewPayload(payload, apiKey).outcome === "RATE_LIMITED") {
        stopEarly = true;
      }
    } catch {
      results[ticker] = { kind: "NETWORK_ERROR" };
    }
  }

  return buildAlphaVantageOverviewDiagnosticReport({ results, tickers: normalizedTickers, timestamp: now, apiKey });
}

type OverviewClassification =
  | { outcome: "SUCCESS"; fields: Record<string, AlphaVantageFieldPresence> }
  | { outcome: "RATE_LIMITED"; message: string }
  | { outcome: "ERROR_MESSAGE"; message: string }
  | { outcome: "EMPTY"; message: string };

function classifyOverviewPayload(payload: unknown, apiKey: string): OverviewClassification {
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
      message:
        "Alpha Vantage returned an empty overview object (no Symbol field) - typically an invalid symbol, an invalid/missing API key, or a plan restriction. No fields were inferred.",
    };
  }

  return {
    outcome: "SUCCESS",
    fields: Object.fromEntries(FIELD_DEFINITIONS.map((definition) => [definition.key, observeField(obj, definition.key, apiKey)])),
  };
}

function buildRows(tickers: string[], outcomes: AlphaVantageTickerOutcome[]): AlphaVantageDiagnosticRow[] {
  const outcomeByTicker = new Map(outcomes.map((outcome) => [outcome.ticker, outcome]));
  return FIELD_DEFINITIONS.map((definition) => ({
    group: definition.group,
    label: definition.label,
    key: definition.key,
    note: definition.note,
    values: Object.fromEntries(
      tickers.map((ticker) => {
        const outcome = outcomeByTicker.get(ticker);
        if (outcome?.outcome === "SUCCESS") {
          return [ticker, outcome.fields[definition.key] ?? { state: "ABSENT", value: null }];
        }
        return [ticker, { state: "CALL_UNAVAILABLE", value: null }];
      }),
    ),
  }));
}

/**
 * Preserves ABSENT vs PRESENT_NULL vs PRESENT_VALUE exactly. Alpha Vantage's own null sentinel
 * for a genuinely unavailable fundamental is the literal string "None" (occasionally "-" or an
 * empty string) - those are mapped to PRESENT_NULL (the key IS present, Alpha Vantage itself is
 * saying "no value"), never to 0 and never treated as a real string value. A real "0" passes
 * through untouched as PRESENT_VALUE.
 */
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

function normalizeTickers(tickers: readonly string[]): string[] {
  return [...new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean))];
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
