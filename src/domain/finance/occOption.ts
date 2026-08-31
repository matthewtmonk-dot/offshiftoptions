/**
 * Parses the OCC-style option symbols Schwab returns for option positions/instruments,
 * e.g. "RIOT 260904P00017500" -> RIOT, 2026-09-04, PUT, strike 17.5. The root symbol is
 * 1-6 letters, optionally padded with spaces (Schwab pads short roots to a fixed width),
 * followed by a 6-digit YYMMDD expiration, a C/P flag, and an 8-digit strike scaled by 1000.
 */
export type ParsedOccOptionSymbol = {
  underlying: string;
  expiration: Date;
  optionType: "PUT" | "CALL";
  strike: number;
  raw: string;
};

const OCC_OPTION_PATTERN = /^([A-Z]{1,6})\s*(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

export function parseOccOptionSymbol(rawSymbol: string): ParsedOccOptionSymbol | null {
  const raw = rawSymbol.trim().toUpperCase();
  const match = raw.match(OCC_OPTION_PATTERN);
  if (!match) {
    return null;
  }

  const [, underlying, yy, mm, dd, putCall, strikeDigits] = match;
  const year = 2000 + Number(yy);
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const expiration = new Date(Date.UTC(year, month - 1, day));
  if (expiration.getUTCFullYear() !== year || expiration.getUTCMonth() !== month - 1 || expiration.getUTCDate() !== day) {
    return null;
  }

  return {
    underlying,
    expiration,
    optionType: putCall === "P" ? "PUT" : "CALL",
    strike: Number(strikeDigits) / 1000,
    raw: rawSymbol.trim(),
  };
}

export function formatOccExpiration(expiration: Date): string {
  return expiration.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function formatOccStrike(strike: number): string {
  return `$${strike.toFixed(2)}`;
}

/** One-line human-readable summary, e.g. "RIOT · Sep 4, 2026 · $17.50 Put". */
export function formatOccOptionSymbol(parsed: ParsedOccOptionSymbol): string {
  const optionLabel = parsed.optionType === "PUT" ? "Put" : "Call";
  return `${parsed.underlying} · ${formatOccExpiration(parsed.expiration)} · ${formatOccStrike(parsed.strike)} ${optionLabel}`;
}
