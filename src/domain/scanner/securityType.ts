/**
 * Funds the weekly cash-secured-put scan must never treat as a candidate. The scanner has no security-type field, so
 * this reads Schwab's own description of the symbol (MarketQuote.companyDescription) and falls back to a short list of
 * well-known tickers when the description is missing. Plain diversified ETFs and ordinary stocks are NOT excluded.
 *
 * A fund keyword alone is never enough: "Ultra Clean Holdings" and "Preferred Bank" are ordinary companies, so every
 * description match also needs a fund marker (ETF, ETN, FUND, TRUST, SHARES, ...) or a fund-issuer name.
 */
export type ExcludedSecurityKind = "LEVERAGED" | "INVERSE" | "OPTION_INCOME" | "PREFERRED" | "ETF";

export type ExcludedSecurity = { kind: ExcludedSecurityKind; reason: string };

const REASONS: Record<ExcludedSecurityKind, string> = {
  LEVERAGED: "Excluded: leveraged fund (moves 2-3x the index each day and decays over time, so a put on it is not a normal weekly put).",
  INVERSE: "Excluded: inverse fund (rises when the market falls; not a company you would be willing to own).",
  OPTION_INCOME: "Excluded: option-income fund (its price erodes as it pays out premium, so oversold readings do not mean what they do for a stock).",
  PREFERRED: "Excluded: preferred-stock fund (trades like a bond; the scanner's stock rules do not apply).",
  ETF: "Excluded: exchange-traded fund (it has no earnings date and cannot be ethics-reviewed, so it can never pass this stock scanner).",
};

/**
 * Policy switch (Nov 5 2026). A live scan showed commodity, emerging-market and similar ETFs filling the list: they can
 * never PASS (no earnings date, no ethics review) and they use up the option-pricing budget. When Schwab's own asset
 * sub-type says ETF/ETN, the symbol is excluded. Set to false to let plain ETFs through again.
 */
export const EXCLUDE_ALL_ETFS = true;
const ETF_ASSET_SUBTYPES = new Set(["ETF", "ETN", "ETP", "CEF", "OEF", "MUTUAL_FUND", "MUTUAL FUND"]);

const FUND_MARKER = /\b(ETF|ETN|ETP|FUND|TRUST|SHARES|INDEX|PORTFOLIO|NOTES|ISHARES|PROSHARES|DIREXION|SPDR|INVESCO|VANECK|WISDOMTREE|GRANITESHARES|ROUNDHILL|DEFIANCE|GLOBAL X)\b/i;
const LEVERAGED_FUND_ISSUER = /\b(DIREXION DAILY|LEVERAGE SHARES|T-REX|GRANITESHARES [A-Z0-9 ]*2X|DEFIANCE DAILY TARGET)\b/i;

const PATTERNS: Array<{ kind: ExcludedSecurityKind; pattern: RegExp; needsFundMarker: boolean }> = [
  { kind: "OPTION_INCOME", pattern: /\b(YIELDMAX|WEEKLYPAY|OPTION INCOME|COVERED CALL|BUY[- ]WRITE|PREMIUM INCOME|0DTE|XDTE)\b/i, needsFundMarker: false },
  { kind: "INVERSE", pattern: /\b(INVERSE|ULTRASHORT|BEAR)\b|(^|[\s(])-\s?[123](\.\d+)?X\b/i, needsFundMarker: true },
  { kind: "LEVERAGED", pattern: /\b[23](\.\d+)?X\b|\b(ULTRAPRO|ULTRA|LEVERAGED|LEVERAGE|BULL)\b/i, needsFundMarker: true },
  { kind: "PREFERRED", pattern: /\b(PREFERRED|PFD)\b/i, needsFundMarker: true },
];

/** Safety net for a missing description: widely traded funds of the kinds above (not exhaustive). */
const KNOWN_EXCLUDED_TICKERS: Record<Exclude<ExcludedSecurityKind, "ETF">, readonly string[]> = {
  LEVERAGED: ["PLTU", "TSMG", "NVDG", "TQQQ", "SOXL", "SPXL", "UPRO", "TNA", "LABU", "FNGU", "BITX", "ETHU", "NVDL", "TSLL", "CONL", "MSTU", "AGQ", "UGL", "GOOX", "HOOW", "ROBN", "UVXY", "UVIX", "BOIL", "NUGT", "JNUG", "FAS", "YINN"],
  INVERSE: ["SQQQ", "SOXS", "SPXU", "SPXS", "SDOW", "TZA", "LABD", "FNGD", "TSLQ", "MSTZ", "SVXY", "SH", "PSQ", "DOG", "BITI", "SCO", "ZSL", "DUST", "JDST", "FAZ"],
  OPTION_INCOME: ["FEPI", "ULTY", "QQQY", "CONY", "TSLY", "NVDY", "MSTY", "YMAX", "YMAG", "OARK", "APLY", "AMZY", "GOOGY", "FBY", "GPTY", "SQY", "XYLD", "QYLD", "RYLD", "JEPI", "JEPQ", "DIVO", "SVOL"],
  PREFERRED: ["PFF", "PFFD", "PGX", "PSK", "PFXF", "FPE", "VRP", "SPFF"],
};

const KNOWN_KIND_BY_TICKER: ReadonlyMap<string, ExcludedSecurityKind> = new Map(
  (Object.entries(KNOWN_EXCLUDED_TICKERS) as Array<[ExcludedSecurityKind, readonly string[]]>).flatMap(([kind, tickers]) => tickers.map((ticker) => [ticker, kind] as const)),
);

export function excludedSecurityFor(ticker: string, description: string | null | undefined, assetSubType?: string | null): ExcludedSecurity | null {
  const subType = typeof assetSubType === "string" ? assetSubType.trim().toUpperCase() : "";
  const text = typeof description === "string" ? description.trim() : "";
  if (text) {
    const isFund = FUND_MARKER.test(text) || LEVERAGED_FUND_ISSUER.test(text);
    for (const { kind, pattern, needsFundMarker } of PATTERNS) {
      if (pattern.test(text) && (!needsFundMarker || isFund)) return { kind, reason: REASONS[kind] };
    }
    if (LEVERAGED_FUND_ISSUER.test(text)) return { kind: "LEVERAGED", reason: REASONS.LEVERAGED };
  }
  const known = KNOWN_KIND_BY_TICKER.get(ticker.trim().toUpperCase());
  if (known) return { kind: known, reason: REASONS[known] };
  // Specific fund kinds above win (their reason is more useful); any other ETF/ETN is excluded by its asset sub-type.
  if (EXCLUDE_ALL_ETFS && ETF_ASSET_SUBTYPES.has(subType)) return { kind: "ETF", reason: REASONS.ETF };
  return null;
}
