import "server-only";

import { ALPHA_VANTAGE_BASE_URL } from "./config";
import { fetchAlphaVantageText, type AlphaVantageFetch } from "./client";

export const ALPHA_VANTAGE_EARNINGS_CALENDAR_FUNCTION = "EARNINGS_CALENDAR";

/**
 * Alpha Vantage's default reporting window when no `horizon` is given, and the smallest of the
 * three the endpoint accepts (3month/6month/12month) - the least amount of unused future data
 * to cache for a scanner whose own earnings-distance rule cares about the next few weeks, not
 * next year.
 */
export const ALPHA_VANTAGE_EARNINGS_CALENDAR_HORIZON = "3month";

export type EarningsCalendarEntry = {
  ticker: string;
  reportDate: Date;
};

export type AlphaVantageEarningsCalendarFetchResult =
  | { outcome: "SUCCESS"; entries: EarningsCalendarEntry[] }
  | { outcome: "RATE_LIMITED"; message: string }
  | { outcome: "ERROR_MESSAGE"; message: string }
  | { outcome: "EMPTY"; message: string }
  | { outcome: "HTTP_ERROR"; status: number; message: string };

const BLOCKED_VALUE_PATTERN = /\b(api[_\s-]*key|access[_\s-]*token|secret|password|credential|authorization|bearer)\b/i;

/**
 * Fetches Alpha Vantage's EARNINGS_CALENDAR endpoint WITHOUT a `symbol` parameter - confirmed
 * live against Alpha Vantage's own demo key (2026-09) that this is supported and returns the
 * full expected-earnings list across ~1,400+ companies for the given horizon as CSV, not a
 * per-symbol response. This is the entire reason a single shared daily call can populate
 * earnings dates for every ticker a scan might touch, rather than spending one Alpha Vantage
 * call per ticker (see refreshEarningsCalendarCacheForToday in the caller). Costs exactly ONE
 * reservation against the shared 25/day budget (see alpha-vantage-budget.ts) - the same as any
 * other Alpha Vantage endpoint; there is no per-symbol multiplier.
 *
 * Only `symbol`, `reportDate`, and `fiscalDateEnding` are extracted - `name`/`estimate`/
 * `currency`/`timeOfTheDay` are not needed for the scanner's earnings-distance rule and are
 * left unparsed to keep this function's contract minimal.
 */
export async function fetchAlphaVantageEarningsCalendar({
  apiKey,
  horizon = ALPHA_VANTAGE_EARNINGS_CALENDAR_HORIZON,
  fetchFn,
  baseUrl = ALPHA_VANTAGE_BASE_URL,
}: {
  apiKey: string;
  horizon?: "3month" | "6month" | "12month";
  fetchFn?: AlphaVantageFetch;
  baseUrl?: string;
}): Promise<AlphaVantageEarningsCalendarFetchResult> {
  const { text, status } = await fetchAlphaVantageText({
    apiKey,
    searchParams: new URLSearchParams({ function: ALPHA_VANTAGE_EARNINGS_CALENDAR_FUNCTION, horizon }),
    fetchFn,
    baseUrl,
  });

  if (status < 200 || status >= 300) {
    return { outcome: "HTTP_ERROR", status, message: sanitizeMessage(`Alpha Vantage returned HTTP ${status}.`, apiKey) };
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return { outcome: "EMPTY", message: "Alpha Vantage returned an empty earnings calendar response." };
  }

  // Alpha Vantage signals throttling/errors on CSV endpoints via an HTTP 200 with a JSON body
  // instead of CSV - same "Note"/"Information"/"Error Message" shape as the JSON endpoints.
  if (trimmed.startsWith("{")) {
    return classifyJsonErrorBody(trimmed, apiKey);
  }

  const rows = parseCsvRows(trimmed);
  const header = (rows[0] ?? []).map((cell) => cell.trim().toLowerCase());
  const symbolIndex = header.indexOf("symbol");
  const reportDateIndex = header.indexOf("reportdate");
  if (symbolIndex === -1 || reportDateIndex === -1) {
    return { outcome: "ERROR_MESSAGE", message: "Alpha Vantage earnings calendar response did not include the expected columns." };
  }

  const entries = rows.slice(1).flatMap((row) => {
    const ticker = row[symbolIndex]?.trim().toUpperCase();
    const reportDateText = row[reportDateIndex]?.trim();
    if (!ticker || !reportDateText) {
      return [];
    }
    const reportDate = parseIsoDateOnly(reportDateText);
    if (!reportDate) {
      return [];
    }
    return [{ ticker, reportDate }];
  });

  if (!entries.length) {
    return { outcome: "EMPTY", message: "Alpha Vantage earnings calendar contained no usable rows." };
  }

  return { outcome: "SUCCESS", entries };
}

function classifyJsonErrorBody(text: string, apiKey: string): AlphaVantageEarningsCalendarFetchResult {
  let obj: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text);
    obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    obj = null;
  }

  if (obj && typeof obj["Note"] === "string") {
    return { outcome: "RATE_LIMITED", message: sanitizeMessage(obj["Note"], apiKey) };
  }
  if (obj && typeof obj["Information"] === "string") {
    return { outcome: "RATE_LIMITED", message: sanitizeMessage(obj["Information"], apiKey) };
  }
  if (obj && typeof obj["Error Message"] === "string") {
    return { outcome: "ERROR_MESSAGE", message: sanitizeMessage(obj["Error Message"], apiKey) };
  }

  return { outcome: "ERROR_MESSAGE", message: "Alpha Vantage returned an unexpected JSON response instead of CSV." };
}

/** Alpha Vantage's earnings calendar reports plain `YYYY-MM-DD` calendar dates (a date-only
 * financial concept, like an option expiration - see shortCalendarDate in format.ts) - parsed
 * as UTC midnight, never local-timezone-shifted. */
function parseIsoDateOnly(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return Number.isNaN(date.getTime()) ? null : date;
}

function sanitizeMessage(message: string, apiKey: string): string {
  const withoutKey = apiKey ? message.split(apiKey).join("[REDACTED]") : message;
  if (BLOCKED_VALUE_PATTERN.test(withoutKey)) {
    return "Alpha Vantage returned a message that was withheld by the safety filter.";
  }
  return withoutKey.length > 300 ? `${withoutKey.slice(0, 297)}...` : withoutKey;
}

/** Minimal quoted-CSV row parser - mirrors providers/schwab/csv.ts's parseCsvRows, kept as its
 * own copy rather than a cross-provider shared utility (each provider's CSV quirks are its
 * own). Handles quoted fields (company names sometimes contain commas) and CRLF/LF/CR line
 * endings. */
function parseCsvRows(input: string): string[][] {
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
