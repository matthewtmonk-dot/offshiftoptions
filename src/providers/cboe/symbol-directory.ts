import "server-only";

/**
 * Cboe's public, documented, daily-updated Equity & Index Options symbol directory download -
 * confirmed live (2026-09) at this exact URL pattern to return a real CSV (Company Name, Stock
 * Symbol, DPM Name, Post/Station, Global Trading Hours DPM), ~3,000+ rows, including ETFs/ETNs
 * (e.g. "2x Long VIX Futures ETF","UVIX" was present in a live fetch) - not scraped HTML, a
 * genuine documented download link. Cboe states directories are "updated daily using
 * information from the previous business day" and are "furnished without responsibility for
 * accuracy," subject to Cboe's Terms and Conditions - a standard accuracy disclaimer, not an
 * anti-automation restriction, but worth a human glance at those terms before this runs on an
 * unattended daily schedule (see PROJECT_HANDOFF.md "Broad scanner universe").
 *
 * This is TIER 2 of the scanner's universe (see docs/SCANNER_RULES.md) - underlyings with
 * listed options, never every publicly-traded stock. It is never fetched per-scan; a caller is
 * expected to fetch this at most once daily and persist the result (see the pending
 * OptionableUniverseSymbol cache design - not yet implemented/migrated).
 */
export const CBOE_SYMBOL_DIRECTORY_BASE_URL = "https://www.cboe.com/us/options/symboldir/equity-index-options/download/";

export type CboeOptionableSymbol = {
  ticker: string;
  name: string;
};

export type CboeSymbolDirectoryFetchResult =
  | { outcome: "SUCCESS"; symbols: CboeOptionableSymbol[]; asOfDate: string }
  | { outcome: "EMPTY"; message: string }
  | { outcome: "HTTP_ERROR"; status: number; message: string };

export type CboeFetch = typeof fetch;

/**
 * Fetches and parses one day's Cboe optionable-symbol directory. `date` must be a plain
 * `YYYY-MM-DD` string (Cboe's own dated-download URL parameter, e.g. `?dt=2026-09-06`) -
 * callers should pass "today" (UTC) for a fresh daily refresh; Cboe serves the most recent
 * business day's directory regardless of weekend/holiday gaps.
 */
export async function fetchCboeOptionableSymbols({
  date,
  fetchFn = fetch,
  baseUrl = CBOE_SYMBOL_DIRECTORY_BASE_URL,
}: {
  date: string;
  fetchFn?: CboeFetch;
  baseUrl?: string;
}): Promise<CboeSymbolDirectoryFetchResult> {
  const url = new URL(baseUrl);
  url.searchParams.set("dt", date);

  const response = await fetchFn(url);
  if (!response.ok) {
    return { outcome: "HTTP_ERROR", status: response.status, message: `Cboe returned HTTP ${response.status}.` };
  }

  const text = await response.text();
  const symbols = parseCboeSymbolDirectoryCsv(text);
  if (!symbols.length) {
    return { outcome: "EMPTY", message: "Cboe symbol directory response contained no usable rows." };
  }

  return { outcome: "SUCCESS", symbols, asOfDate: date };
}

/**
 * Parses Cboe's own CSV shape: a header row ("Company Name, Stock Symbol, DPM Name, ...")
 * followed by quoted, comma-separated rows. Only Company Name and Stock Symbol are extracted -
 * DPM/Post/GTH fields are exchange-operations detail, not useful for scanner discovery.
 */
export function parseCboeSymbolDirectoryCsv(text: string): CboeOptionableSymbol[] {
  const rows = parseCsvRows(text.trim());
  if (!rows.length) {
    return [];
  }

  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const nameIndex = header.findIndex((cell) => cell.includes("company name"));
  const symbolIndex = header.findIndex((cell) => cell.includes("stock symbol"));
  if (nameIndex === -1 || symbolIndex === -1) {
    return [];
  }

  const seen = new Set<string>();
  return rows.slice(1).flatMap((row) => {
    const ticker = row[symbolIndex]?.trim().toUpperCase();
    const name = row[nameIndex]?.trim();
    if (!ticker || !name || seen.has(ticker)) {
      return [];
    }
    seen.add(ticker);
    return [{ ticker, name }];
  });
}

/** Minimal quoted-CSV row parser - see providers/schwab/csv.ts's parseCsvRows / providers/
 * alpha-vantage/earnings-calendar.ts's own copy for the same shape, kept independent per
 * provider rather than a shared cross-provider utility. */
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
