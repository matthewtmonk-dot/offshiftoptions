import "server-only";

import { SCHWAB_MARKET_DATA_BASE_URL } from "./config";
import { schwabGetJson, type SchwabFetch } from "./client";
import { SchwabMarketDataProvider } from "./market-data";

export const SCHWAB_FUNDAMENTALS_DIAGNOSTIC_TICKERS = ["APLD", "RIOT", "CORZ"] as const;
export const SCHWAB_FUNDAMENTALS_DIAGNOSTIC_FIELDS = "quote,reference,regular,fundamental";
export const SCHWAB_FUNDAMENTALS_DIAGNOSTIC_PATH = "GET /marketdata/v1/quotes";

type DiagnosticGroup = "Reference" | "Fundamental" | "Price diagnostics" | "Instrument fallback";

type FieldDefinition = {
  group: DiagnosticGroup;
  label: string;
  path: string[];
  note?: string;
};

export type FieldPresence =
  | {
      state: "ABSENT";
      value: null;
    }
  | {
      state: "PRESENT_NULL";
      value: null;
    }
  | {
      state: "PRESENT_VALUE";
      value: string;
    }
  | {
      state: "PRESENT_UNDISPLAYED";
      value: string;
    };

export type SchwabDiagnosticRow = {
  group: DiagnosticGroup;
  label: string;
  schwabPath: string;
  values: Record<string, FieldPresence>;
  note?: string;
};

export type SchwabDiagnosticPriceSource = {
  symbol: string;
  path: string | null;
  value: string | null;
  status: "AVAILABLE" | "UNAVAILABLE";
};

export type SchwabDiagnosticInstrumentUse = {
  used: boolean;
  symbols: string[];
  note: string;
};

export type SchwabDiagnosticMarketHours =
  | {
      available: true;
      isOpen: boolean;
      opensAt: string | null;
      closesAt: string | null;
    }
  | {
      available: false;
      note: string;
    };

export type SchwabFundamentalsDiagnosticReport = {
  source: "Schwab Trader API";
  readOnly: true;
  nothingSaved: true;
  timestamp: string;
  quoteRequest: {
    path: typeof SCHWAB_FUNDAMENTALS_DIAGNOSTIC_PATH;
    fields: typeof SCHWAB_FUNDAMENTALS_DIAGNOSTIC_FIELDS;
    symbols: string[];
  };
  priceFallbackOrder: string[];
  priceSources: SchwabDiagnosticPriceSource[];
  marketHours: SchwabDiagnosticMarketHours;
  instrumentUse: SchwabDiagnosticInstrumentUse;
  rows: SchwabDiagnosticRow[];
};

type BuildDiagnosticOptions = {
  payload: unknown;
  symbols?: readonly string[];
  timestamp?: Date;
  marketHours?: SchwabDiagnosticMarketHours;
  instruments?: Record<string, { description?: string | null; assetType?: string | null }>;
};

type FetchDiagnosticOptions = {
  accessToken: string;
  symbols?: readonly string[];
  fetchFn?: SchwabFetch;
  baseUrl?: string;
  now?: Date;
};

const REFERENCE_FIELDS: FieldDefinition[] = [
  { group: "Reference", label: "Description", path: ["reference", "description"] },
  { group: "Reference", label: "Exchange", path: ["reference", "exchange"] },
  { group: "Reference", label: "Exchange name", path: ["reference", "exchangeName"] },
  { group: "Reference", label: "Sector", path: ["reference", "sector"] },
  { group: "Reference", label: "Industry", path: ["reference", "industry"] },
];

const FUNDAMENTAL_FIELDS: FieldDefinition[] = [
  { group: "Fundamental", label: "P/E", path: ["fundamental", "peRatio"] },
  { group: "Fundamental", label: "EPS", path: ["fundamental", "eps"] },
  { group: "Fundamental", label: "PEG", path: ["fundamental", "peg"] },
  { group: "Fundamental", label: "PEG ratio", path: ["fundamental", "pegRatio"] },
  { group: "Fundamental", label: "Debt / Equity", path: ["fundamental", "debtToEquity"] },
  { group: "Fundamental", label: "Current ratio", path: ["fundamental", "currentRatio"] },
  { group: "Fundamental", label: "Dividend amount", path: ["fundamental", "divAmount"] },
  { group: "Fundamental", label: "Dividend pay amount", path: ["fundamental", "divPayAmount"] },
  { group: "Fundamental", label: "Dividend yield", path: ["fundamental", "divYield"] },
  { group: "Fundamental", label: "Dividend frequency", path: ["fundamental", "divFreq"] },
  { group: "Fundamental", label: "Dividend ex-date", path: ["fundamental", "divExDate"] },
  { group: "Fundamental", label: "Next dividend ex-date", path: ["fundamental", "nextDivExDate"] },
  { group: "Fundamental", label: "Dividend pay date", path: ["fundamental", "divPayDate"] },
  { group: "Fundamental", label: "Next dividend pay date", path: ["fundamental", "nextDivPayDate"] },
  { group: "Fundamental", label: "Declaration date", path: ["fundamental", "declarationDate"] },
  { group: "Fundamental", label: "Average 10-day volume", path: ["fundamental", "avg10DaysVolume"] },
  { group: "Fundamental", label: "Average 1-year volume", path: ["fundamental", "avg1YearVolume"] },
  { group: "Fundamental", label: "Net income", path: ["fundamental", "netIncome"] },
  {
    group: "Fundamental",
    label: "Net income common shares",
    path: ["fundamental", "netIncomeApplicableToCommonShares"],
  },
  { group: "Fundamental", label: "Net profit margin", path: ["fundamental", "netProfitMargin"] },
  { group: "Fundamental", label: "Profit margin", path: ["fundamental", "profitMargin"] },
  { group: "Fundamental", label: "Operating margin", path: ["fundamental", "operatingMargin"] },
  { group: "Fundamental", label: "Gross margin", path: ["fundamental", "grossMargin"] },
  { group: "Fundamental", label: "Return on equity", path: ["fundamental", "returnOnEquity"] },
  { group: "Fundamental", label: "Return on assets", path: ["fundamental", "returnOnAssets"] },
  { group: "Fundamental", label: "Profitability", path: ["fundamental", "profitability"] },
  { group: "Fundamental", label: "Rating", path: ["fundamental", "rating"] },
  { group: "Fundamental", label: "Grade", path: ["fundamental", "grade"] },
  { group: "Fundamental", label: "Analyst rating", path: ["fundamental", "analystRating"] },
  { group: "Fundamental", label: "Analyst grade", path: ["fundamental", "analystGrade"] },
  { group: "Fundamental", label: "Schwab rating", path: ["fundamental", "schwabRating"] },
  { group: "Fundamental", label: "Schwab grade", path: ["fundamental", "schwabGrade"] },
  { group: "Fundamental", label: "Research rating", path: ["fundamental", "researchRating"] },
  { group: "Fundamental", label: "Consensus rating", path: ["fundamental", "consensusRating"] },
  { group: "Fundamental", label: "Recommendation", path: ["fundamental", "recommendation"] },
  { group: "Fundamental", label: "Analyst recommendation", path: ["fundamental", "analystRecommendation"] },
  { group: "Fundamental", label: "LSEG rating", path: ["fundamental", "lsegRating"] },
  { group: "Fundamental", label: "LSEG recommendation", path: ["fundamental", "lsegRecommendation"] },
];

export const PRICE_FIELD_DEFINITIONS: FieldDefinition[] = [
  { group: "Price diagnostics", label: "quote.lastPrice", path: ["quote", "lastPrice"], note: "OSO price fallback #1." },
  {
    group: "Price diagnostics",
    label: "regular.regularMarketLastPrice",
    path: ["regular", "regularMarketLastPrice"],
    note: "OSO price fallback #2.",
  },
  { group: "Price diagnostics", label: "quote.mark", path: ["quote", "mark"], note: "OSO price fallback #3." },
  { group: "Price diagnostics", label: "quote.closePrice", path: ["quote", "closePrice"], note: "OSO price fallback #4." },
];

const INSTRUMENT_FIELDS: FieldDefinition[] = [
  {
    group: "Instrument fallback",
    label: "Instrument description",
    path: ["instrument", "description"],
    note: "Fetched only when reference.description is absent or null.",
  },
  {
    group: "Instrument fallback",
    label: "Instrument asset type",
    path: ["instrument", "assetType"],
    note: "Fetched only when reference.description is absent or null.",
  },
];

const ALL_FIELD_DEFINITIONS = [
  ...REFERENCE_FIELDS,
  ...FUNDAMENTAL_FIELDS,
  ...PRICE_FIELD_DEFINITIONS,
  ...INSTRUMENT_FIELDS,
];

const BLOCKED_VALUE_PATTERN =
  /\b(access[_\s-]*token|refresh[_\s-]*token|client[_\s-]*secret|authorization|bearer|account[_\s-]*(number|hash)|database[_\s-]*url|encryption[_\s-]*key|password|credential)\b/i;

export async function fetchSchwabFundamentalsDiagnosticPayload({
  accessToken,
  symbols = SCHWAB_FUNDAMENTALS_DIAGNOSTIC_TICKERS,
  fetchFn,
  baseUrl = SCHWAB_MARKET_DATA_BASE_URL,
}: FetchDiagnosticOptions) {
  const normalizedSymbols = normalizeSymbols(symbols);

  return schwabGetJson<unknown>({
    accessToken,
    baseUrl,
    path: "/quotes",
    searchParams: new URLSearchParams({
      symbols: normalizedSymbols.join(","),
      fields: SCHWAB_FUNDAMENTALS_DIAGNOSTIC_FIELDS,
    }),
    fetchFn,
  });
}

export async function buildSchwabFundamentalsDiagnosticFromToken({
  accessToken,
  symbols = SCHWAB_FUNDAMENTALS_DIAGNOSTIC_TICKERS,
  fetchFn,
  baseUrl = SCHWAB_MARKET_DATA_BASE_URL,
  now = new Date(),
}: FetchDiagnosticOptions): Promise<SchwabFundamentalsDiagnosticReport> {
  const normalizedSymbols = normalizeSymbols(symbols);
  const provider = new SchwabMarketDataProvider({ accessToken, fetchFn, baseUrl });
  const payload = await fetchSchwabFundamentalsDiagnosticPayload({ accessToken, symbols: normalizedSymbols, fetchFn, baseUrl });
  const records = recordsBySymbol(payload, normalizedSymbols);
  const instruments = await fetchMissingInstrumentDescriptions(provider, records, normalizedSymbols);
  const marketHours = await fetchMarketHours(provider, now);

  return buildSchwabFundamentalsDiagnosticReport({
    payload,
    symbols: normalizedSymbols,
    timestamp: now,
    marketHours,
    instruments: instruments.values,
  });
}

export function buildSchwabFundamentalsDiagnosticReport({
  payload,
  symbols = SCHWAB_FUNDAMENTALS_DIAGNOSTIC_TICKERS,
  timestamp = new Date(),
  marketHours = { available: false, note: "Market-hours check was not run." },
  instruments = {},
}: BuildDiagnosticOptions): SchwabFundamentalsDiagnosticReport {
  const normalizedSymbols = normalizeSymbols(symbols);
  const records = recordsBySymbol(payload, normalizedSymbols);
  const mergedRecords = Object.fromEntries(
    normalizedSymbols.map((symbol) => [
      symbol,
      {
        ...(records[symbol] ?? {}),
        instrument: instruments[symbol] ?? null,
      },
    ]),
  );
  const instrumentSymbols = normalizedSymbols.filter((symbol) => Boolean(instruments[symbol]));

  return {
    source: "Schwab Trader API",
    readOnly: true,
    nothingSaved: true,
    timestamp: timestamp.toISOString(),
    quoteRequest: {
      path: SCHWAB_FUNDAMENTALS_DIAGNOSTIC_PATH,
      fields: SCHWAB_FUNDAMENTALS_DIAGNOSTIC_FIELDS,
      symbols: normalizedSymbols,
    },
    priceFallbackOrder: PRICE_FIELD_DEFINITIONS.map((definition) => definition.path.join(".")),
    priceSources: normalizedSymbols.map((symbol) => priceSourceForSymbol(symbol, mergedRecords[symbol])),
    marketHours,
    instrumentUse: {
      used: instrumentSymbols.length > 0,
      symbols: instrumentSymbols,
      note: instrumentSymbols.length
        ? `getInstrument() used for ${instrumentSymbols.join(", ")} because reference.description was absent or null.`
        : "getInstrument() was not used because reference.description was present with a value for every ticker.",
    },
    rows: ALL_FIELD_DEFINITIONS.map((definition) => ({
      group: definition.group,
      label: definition.label,
      schwabPath: definition.path.join("."),
      values: Object.fromEntries(
        normalizedSymbols.map((symbol) => [symbol, observePath(mergedRecords[symbol], definition.path)]),
      ),
      note: definition.note,
    })),
  };
}

export function referenceDescriptionNeedsInstrument(payload: unknown, symbols: readonly string[]) {
  const normalizedSymbols = normalizeSymbols(symbols);
  const records = recordsBySymbol(payload, normalizedSymbols);
  return normalizedSymbols.filter((symbol) => observePath(records[symbol], ["reference", "description"]).state !== "PRESENT_VALUE");
}

async function fetchMissingInstrumentDescriptions(
  provider: SchwabMarketDataProvider,
  records: Record<string, Record<string, unknown> | null>,
  symbols: string[],
) {
  const values: Record<string, { description?: string | null; assetType?: string | null }> = {};
  const missing = symbols.filter((symbol) => observePath(records[symbol], ["reference", "description"]).state !== "PRESENT_VALUE");

  for (const symbol of missing) {
    try {
      const instrument = await provider.getInstrument(symbol);
      values[symbol] = {
        description: instrument.description,
        assetType: instrument.assetType,
      };
    } catch {
      values[symbol] = {
        description: null,
        assetType: null,
      };
    }
  }

  return { values, missing };
}

async function fetchMarketHours(provider: SchwabMarketDataProvider, now: Date): Promise<SchwabDiagnosticMarketHours> {
  try {
    const hours = await provider.getMarketHours(now);
    return {
      available: true,
      isOpen: hours.isOpen,
      opensAt: hours.opensAt?.toISOString() ?? null,
      closesAt: hours.closesAt?.toISOString() ?? null,
    };
  } catch {
    return {
      available: false,
      note: "Market-hours check failed safely. No raw Schwab response was returned.",
    };
  }
}

function priceSourceForSymbol(symbol: string, record: unknown): SchwabDiagnosticPriceSource {
  for (const definition of PRICE_FIELD_DEFINITIONS) {
    const observed = observePath(record, definition.path);
    if (observed.state === "PRESENT_VALUE") {
      const parsed = Number(observed.value);
      if (Number.isFinite(parsed)) {
        return {
          symbol,
          path: definition.path.join("."),
          value: formatPrimitive(parsed),
          status: "AVAILABLE",
        };
      }
    }
  }

  return {
    symbol,
    path: null,
    value: null,
    status: "UNAVAILABLE",
  };
}

function observePath(record: unknown, path: string[]): FieldPresence {
  let current: unknown = record;
  for (const part of path) {
    const object = objectValue(current);
    if (!object || !Object.prototype.hasOwnProperty.call(object, part)) {
      return { state: "ABSENT", value: null };
    }
    current = object[part];
  }

  if (current === null || current === undefined) {
    return { state: "PRESENT_NULL", value: null };
  }

  if (typeof current === "string" || typeof current === "number" || typeof current === "boolean") {
    const value = formatPrimitive(current);
    return BLOCKED_VALUE_PATTERN.test(value)
      ? { state: "PRESENT_UNDISPLAYED", value: "Value hidden by safety filter." }
      : { state: "PRESENT_VALUE", value };
  }

  return { state: "PRESENT_UNDISPLAYED", value: "Present, but not a primitive display value." };
}

function recordsBySymbol(payload: unknown, symbols: string[]) {
  const root = objectValue(payload);
  return Object.fromEntries(
    symbols.map((symbol) => {
      const direct = objectValue(root?.[symbol]);
      if (direct || !root) {
        return [symbol, direct];
      }
      const matchedKey = Object.keys(root).find((key) => key.toUpperCase() === symbol);
      return [symbol, matchedKey ? objectValue(root[matchedKey]) : null];
    }),
  ) as Record<string, Record<string, unknown> | null>;
}

function normalizeSymbols(symbols: readonly string[]) {
  return [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
}

function formatPrimitive(value: string | number | boolean) {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value.toString() : value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  const trimmed = value.trim();
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
