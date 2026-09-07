import "server-only";

import { isValidTicker } from "@/lib/tickers";

/**
 * OCC's (The Options Clearing Corporation) publicly documented Directory of Listed Products
 * (DLP) HTTP Download - confirmed live (2026-09) at this exact URL pattern to return a real,
 * tab-delimited text file, 6,354 real rows in a live fetch, no authentication required.
 *
 * Unlike Cboe's site-wide Terms (see the retired src/providers/cboe/symbol-directory.ts, kept
 * only for historical reference and not wired into anything), OCC's own Batch Processing
 * documentation (theocc.com/market-data/market-data-reports/other-market-data-info/batch-
 * processing/dlp-download-batch-processing) explicitly documents this URL/parameter shape and
 * tells users to use it to "set up scripts" - an affirmative invitation to automated/scripted
 * use, not an ambiguous restriction. This is TIER 2 of the scanner's universe (see
 * docs/SCANNER_RULES.md).
 *
 * The functional download endpoint lives on a separate subdomain (marketdata.theocc.com) from
 * OCC's documentation site (www.theocc.com) - the two are otherwise unrelated hosts.
 *
 * Record layout (confirmed via OCC's own published "Directory of Listed Products HTTP Download
 * Record Layout" PDF, live-fetched 2026-09): 6 tab-separated fields per row, no header row -
 * Options Symbol, Underlying Symbol, Symbol Name, Trading Exchanges, Position Limit, Product
 * Type - though this download only returns the 5 fields requested via `downloadFields`
 * (OS;US;SN;EXCH;ONN) plus one always-present trailing empty field. "ONN" is OCC's field code
 * for Product Type; live-verified by removing it from downloadFields and observing the "EU"
 * column disappear, then confirmed against the official record layout's enumerated Product Type
 * values (EU = Equity Underlying, EB = Equity Bounds, EL = Equity Long Term, EF = Equity FLEX,
 * CU/CL/CM/CF = Currency variants, IL/IU/IF = Index variants, GF/SF/FC/FP = Futures variants,
 * TU/TL = Treasury variants).
 *
 * Product-type filtering rule: query ONLY prodType=EU ("Equity Underlying"). Live-verified
 * (2026-09) this single product type already includes ordinary equities AND ETFs/ETNs (e.g.
 * AAAU, UVIX, UVXY, VXX, SCO are all present under EU) - never exclude ETF/ETN merely for not
 * being an ordinary corporation. EL/EF ("Long Term"/"FLEX" equity variants) were checked and
 * introduce zero underlyings beyond EU's own set - they are alternate contract-term listings on
 * the same underlyings, not a separate universe, so fetching them adds nothing. IU ("Index
 * Underlying") is a genuinely separate, non-overlapping 65-row set (e.g. MRUT, XDN) that must
 * stay excluded per the "no index-only products" rule; CU/TU/GF currently return "No data
 * exists" at OCC but are structurally distinct product types regardless. Querying only prodType
 * =EU makes accidental inclusion of currency/index/futures/treasury products structurally
 * impossible, rather than relying on our own guess at a ticker-shape heuristic.
 */
export const OCC_DLP_HTTP_DOWNLOAD_BASE_URL = "https://marketdata.theocc.com/delo-download";
export const OCC_DLP_PRODUCT_TYPE = "EU";

export type OccOptionableSymbol = {
  ticker: string;
  name: string | null;
};

export type OccDlpFetchResult =
  | { outcome: "SUCCESS"; symbols: OccOptionableSymbol[]; rawRowCount: number; excludedRowCount: number }
  | { outcome: "EMPTY"; message: string }
  | { outcome: "HTTP_ERROR"; status: number; message: string };

export type OccFetch = typeof fetch;

/**
 * Fetches and parses OCC's Directory of Listed Products HTTP Download for ordinary optionable
 * equity/ETF/ETN underlyings (prodType=EU). No date parameter - OCC's DLP HTTP Download always
 * returns the current directory as of the request.
 */
export async function fetchOccOptionableSymbols({
  fetchFn = fetch,
  baseUrl = OCC_DLP_HTTP_DOWNLOAD_BASE_URL,
}: {
  fetchFn?: OccFetch;
  baseUrl?: string;
} = {}): Promise<OccDlpFetchResult> {
  const url = new URL(baseUrl);
  url.searchParams.set("prodType", OCC_DLP_PRODUCT_TYPE);
  url.searchParams.set("downloadFields", "OS;US;SN;EXCH;ONN");
  url.searchParams.set("format", "txt");

  const response = await fetchFn(url);
  if (!response.ok) {
    return { outcome: "HTTP_ERROR", status: response.status, message: `OCC DLP HTTP Download returned HTTP ${response.status}.` };
  }

  const text = await response.text();
  const audit = auditOccDlpText(text);
  if (!audit.symbols.length) {
    return { outcome: "EMPTY", message: "OCC DLP HTTP Download response contained no usable rows." };
  }

  return { outcome: "SUCCESS", symbols: audit.symbols, rawRowCount: audit.rawRowCount, excludedRowCount: audit.excludedRowCount };
}

/**
 * Parses OCC's DLP HTTP Download tab-delimited text (no header row): Options Symbol, Underlying
 * Symbol, Symbol Name, Trading Exchanges, Product Type, [trailing empty field]. Defense in
 * depth: re-checks Product Type === "EU" per row even though it was also requested via the URL,
 * and re-validates each underlying ticker via isValidTicker before trusting it.
 *
 * A single underlying can have more than one Options Symbol root (e.g. a legacy, split-adjusted
 * contract class alongside the current one - live-verified for BYND/BYND1, UVIX/UVIX1/UVIX3,
 * SCO/SCO1, UVXY/UVXY1). These dedupe to one underlying, keyed on Underlying Symbol, preferring
 * the canonical row whose Options Symbol equals its Underlying Symbol (the unadjusted contract)
 * for the display name - never an arbitrary "last row wins" that could pick up a name annotated
 * with a stale split ratio like "(1:30)".
 */
export function parseOccDlpText(text: string): OccOptionableSymbol[] {
  const audit = auditOccDlpText(text);
  return audit.symbols;
}

export type OccDlpAudit = {
  rawRowCount: number;
  normalizedSymbolCount: number;
  excludedRowCount: number;
  exclusionReasons: { reason: string; count: number }[];
  symbols: OccOptionableSymbol[];
};

/**
 * Reports exactly what parsing did with a file - raw row count, how many became usable
 * normalized (deduplicated) underlyings, and a breakdown of why the rest were excluded. Mirrors
 * the retired Cboe module's auditCboeSymbolDirectoryCsv shape.
 */
export function auditOccDlpText(text: string): OccDlpAudit {
  const trimmed = text.trim();
  if (!trimmed) {
    return { rawRowCount: 0, normalizedSymbolCount: 0, excludedRowCount: 0, exclusionReasons: [], symbols: [] };
  }

  const lines = trimmed.split(/\r\n|\r|\n/);
  const reasonCounts = new Map<string, number>();
  // Underlying ticker -> chosen row, tracking whether the current choice is already "canonical"
  // (Options Symbol === Underlying Symbol) so a later non-canonical duplicate never overwrites it.
  const byUnderlying = new Map<string, { name: string | null; canonical: boolean }>();

  for (const line of lines) {
    const fields = line.split("\t");
    const [rawOs, rawUs, rawSn, , rawOnn] = fields;
    const os = rawOs?.trim();
    const us = rawUs?.trim().toUpperCase();
    const sn = rawSn?.trim() || null;
    const productType = rawOnn?.trim().toUpperCase();

    const reason = fields.length < 5
      ? "Malformed row (fewer than 5 fields)"
      : !us
        ? "Blank underlying symbol"
        : productType !== OCC_DLP_PRODUCT_TYPE
          ? `Excluded product type (${productType || "unknown"})`
          : !isValidTicker(us)
            ? "Failed OSO ticker format rule (isValidTicker)"
            : null;

    if (reason) {
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      continue;
    }

    const existing = byUnderlying.get(us!);
    const isCanonical = os === us;
    if (!existing) {
      byUnderlying.set(us!, { name: sn, canonical: isCanonical });
    } else if (isCanonical && !existing.canonical) {
      byUnderlying.set(us!, { name: sn, canonical: true });
    }
    // else: keep the existing entry - either it's already canonical, or neither is and the
    // first-seen (alphabetically-first Options Symbol) row wins, matching OCC's own file order.
  }

  const symbols: OccOptionableSymbol[] = [...byUnderlying.entries()].map(([ticker, { name }]) => ({ ticker, name }));
  const exclusionReasons = [...reasonCounts.entries()].map(([reason, count]) => ({ reason, count }));
  const excludedRowCount = exclusionReasons.reduce((sum, r) => sum + r.count, 0);

  return {
    rawRowCount: lines.length,
    normalizedSymbolCount: symbols.length,
    excludedRowCount,
    exclusionReasons,
    symbols,
  };
}
