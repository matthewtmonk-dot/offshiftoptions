import { evaluateCandidate, type ScannerRule as EngineScannerRule, type ScannerOperator } from "./scanner";

type RuleInput =
  | {
      kind: "single";
      label: string;
      step?: string;
      min?: number;
      max?: number;
    }
  | {
      kind: "range";
      minLabel: string;
      maxLabel: string;
      step?: string;
      min?: number;
      max?: number;
    }
  | {
      kind: "boolean";
      label: string;
    };

export type ScannerRuleDefinition = {
  key: string;
  name: string;
  operator: ScannerOperator;
  defaultDesired: EngineScannerRule["desired"];
  explanation: string;
  input: RuleInput;
};

export type DemoScannerCandidate = {
  ticker: string;
  values: Record<string, number | string | boolean | null | undefined>;
};

export const SCANNER_RULE_DEFINITIONS: ScannerRuleDefinition[] = [
  {
    key: "price",
    name: "Stock price",
    operator: "BETWEEN",
    defaultDesired: [10, 80],
    explanation: "The stock price range the scanner should evaluate for cash-secured put candidates.",
    input: {
      kind: "range",
      minLabel: "Stock minimum price",
      maxLabel: "Stock maximum price",
      step: "0.01",
      min: 0,
    },
  },
  {
    key: "rsi",
    name: "RSI",
    operator: "LTE",
    defaultDesired: 55,
    explanation: "A momentum indicator. This app uses Wilder's RSI calculation.",
    input: { kind: "single", label: "Maximum RSI", step: "0.1", min: 0, max: 100 },
  },
  {
    key: "bbPercent",
    name: "BB %",
    operator: "LTE",
    defaultDesired: 70,
    explanation: "Where the stock price sits between the lower and upper Bollinger Bands.",
    input: { kind: "single", label: "Maximum Bollinger Band position / BB %", step: "0.1", min: 0, max: 100 },
  },
  {
    key: "dte",
    name: "DTE",
    operator: "BETWEEN",
    defaultDesired: [14, 45],
    explanation: "Days To Expiration - how many calendar days remain until the option expires.",
    input: {
      kind: "range",
      minLabel: "Minimum DTE",
      maxLabel: "Maximum DTE",
      step: "1",
      min: 0,
    },
  },
  {
    key: "delta",
    name: "Absolute delta",
    operator: "BETWEEN",
    defaultDesired: [0.12, 0.3],
    explanation:
      "How sensitive the option is to movement in the stock. For the put scanner, absolute delta is shown for easier comparison.",
    input: {
      kind: "range",
      minLabel: "Minimum absolute Delta",
      maxLabel: "Maximum absolute Delta",
      step: "0.01",
      min: 0,
      max: 1,
    },
  },
  {
    key: "ror",
    name: "Put ROR",
    operator: "GTE",
    defaultDesired: 1,
    explanation: "Premium relative to the cash-secured capital required by the put.",
    input: { kind: "single", label: "Minimum Put Return on Risk", step: "0.1", min: 0 },
  },
  {
    key: "annualizedRor",
    name: "Annualized ROR",
    operator: "GTE",
    defaultDesired: 15,
    explanation: "Return on risk scaled to a yearly rate for comparison. It is educational context, not a target recommendation.",
    input: { kind: "single", label: "Minimum annualized ROR", step: "0.1", min: 0 },
  },
  {
    key: "optionBid",
    name: "Option bid",
    operator: "GTE",
    defaultDesired: 0.05,
    explanation: "The current option bid. Missing quotes remain UNKNOWN.",
    input: { kind: "single", label: "Minimum option bid", step: "0.01", min: 0 },
  },
  {
    key: "spreadPercent",
    name: "Bid/ask spread",
    operator: "LTE",
    defaultDesired: 25,
    explanation: "The difference between the current bid and ask. Wider spreads generally mean less efficient entry/exit pricing.",
    input: { kind: "single", label: "Maximum bid/ask spread %", step: "0.1", min: 0 },
  },
  {
    key: "openInterest",
    name: "Open interest",
    operator: "GTE",
    defaultDesired: 100,
    explanation: "The number of open option contracts currently outstanding for that contract.",
    input: { kind: "single", label: "Minimum open interest", step: "1", min: 0 },
  },
  {
    key: "optionVolume",
    name: "Option volume",
    operator: "GTE",
    defaultDesired: 25,
    explanation: "How many contracts traded during the session.",
    input: { kind: "single", label: "Minimum option volume", step: "1", min: 0 },
  },
  {
    key: "earningsDistance",
    name: "Earnings distance",
    operator: "GTE",
    defaultDesired: 14,
    explanation: "Minimum days until earnings. If earnings timing is unavailable, the criterion remains UNKNOWN.",
    input: { kind: "single", label: "Minimum days until earnings", step: "1", min: 0 },
  },
  {
    key: "doNotTrade",
    name: "Do Not Trade filter",
    operator: "EQ",
    defaultDesired: false,
    explanation: "Flags candidates marked as Do Not Trade. UNKNOWN stays UNKNOWN when this data is unavailable.",
    input: { kind: "boolean", label: "Require Do Not Trade flag to be false" },
  },
  {
    key: "debtToEquity",
    name: "Debt/equity",
    operator: "LTE",
    defaultDesired: 1.2,
    explanation: "A simple Phase 1 fundamental rule. Missing fundamentals remain UNKNOWN.",
    input: { kind: "single", label: "Maximum debt/equity", step: "0.1", min: 0 },
  },
];

export const DEMO_SCAN_CANDIDATES: DemoScannerCandidate[] = [
  {
    ticker: "IONQ",
    values: {
      price: 28.1,
      priceChange: 0.42,
      priceChangePercent: 1.52,
      stockVolume: 18_400_000,
      strike: 27,
      expiration: "2026-09-18",
      dte: 21,
      premium: 0.32,
      optionBid: 0.28,
      optionAsk: 0.36,
      midpoint: 0.32,
      rsi: 44,
      bbPercent: 36,
      delta: 0.22,
      distanceOtmPercent: 3.91,
      ror: 1.35,
      annualizedRor: 23.46,
      spreadPercent: 25,
      openInterest: 225,
      optionVolume: 54,
      earningsDate: "2026-10-08",
      earningsDistance: 41,
      doNotTrade: false,
      debtToEquity: 0.2,
    },
  },
  {
    ticker: "HOOD",
    values: {
      price: 35.64,
      priceChange: 0.58,
      priceChangePercent: 1.65,
      stockVolume: 22_100_000,
      strike: 34,
      expiration: "2026-09-18",
      dte: 21,
      premium: 0.46,
      optionBid: 0.42,
      optionAsk: 0.5,
      midpoint: 0.46,
      rsi: 49.6,
      bbPercent: 48,
      delta: 0.23,
      distanceOtmPercent: 4.6,
      ror: 1.35,
      annualizedRor: 23.48,
      spreadPercent: 17.39,
      openInterest: 1420,
      optionVolume: 380,
      earningsDate: "2026-10-23",
      earningsDistance: 56,
      doNotTrade: false,
      debtToEquity: 0.55,
    },
  },
  {
    ticker: "PLTR",
    values: {
      price: 75.35,
      priceChange: -0.68,
      priceChangePercent: -0.89,
      stockVolume: 41_500_000,
      strike: 72,
      expiration: "2026-09-18",
      dte: 21,
      premium: 0.93,
      optionBid: 0.88,
      optionAsk: 0.98,
      midpoint: 0.93,
      rsi: 53.2,
      bbPercent: 56,
      delta: 0.25,
      distanceOtmPercent: 4.45,
      ror: 1.29,
      annualizedRor: 22.43,
      spreadPercent: 10.75,
      openInterest: 3890,
      optionVolume: 1125,
      earningsDate: "2026-09-30",
      earningsDistance: 33,
      doNotTrade: false,
      debtToEquity: 0.48,
    },
  },
  {
    ticker: "RIVN",
    values: {
      price: 15.38,
      priceChange: -0.09,
      priceChangePercent: -0.58,
      stockVolume: 27_600_000,
      strike: 15,
      expiration: "2026-09-18",
      dte: 21,
      premium: 0.18,
      optionBid: 0.15,
      optionAsk: 0.21,
      midpoint: 0.18,
      rsi: 39.4,
      bbPercent: 29,
      delta: 0.2,
      distanceOtmPercent: 2.47,
      ror: 1.2,
      annualizedRor: 20.86,
      spreadPercent: 24.24,
      openInterest: 650,
      optionVolume: 180,
      earningsDate: "2026-09-14",
      earningsDistance: 17,
      doNotTrade: false,
      debtToEquity: 1.1,
    },
  },
  {
    ticker: "AAP",
    values: {
      price: 49.8,
      priceChange: -0.35,
      priceChangePercent: -0.7,
      stockVolume: 3_200_000,
      strike: 48,
      expiration: "2026-09-18",
      dte: 21,
      premium: 0.55,
      optionBid: 0.5,
      optionAsk: 0.6,
      midpoint: 0.55,
      rsi: 56,
      bbPercent: 52,
      delta: 0.24,
      distanceOtmPercent: 3.61,
      ror: 1.15,
      annualizedRor: 19.98,
      spreadPercent: 18.18,
      openInterest: 180,
      optionVolume: 46,
      earningsDate: "2026-09-25",
      earningsDistance: 28,
      doNotTrade: false,
      debtToEquity: 1.0,
    },
  },
  {
    ticker: "SNAP",
    values: {
      price: 12.44,
      priceChange: 0.04,
      priceChangePercent: 0.32,
      stockVolume: 11_900_000,
      strike: 12,
      expiration: "2026-09-18",
      dte: 21,
      premium: 0.14,
      optionBid: 0.12,
      optionAsk: 0.16,
      midpoint: 0.14,
      rsi: 47.8,
      bbPercent: 44,
      delta: 0.19,
      distanceOtmPercent: 3.54,
      ror: 1.17,
      annualizedRor: 20.29,
      spreadPercent: 22.22,
      openInterest: 410,
      optionVolume: 96,
      earningsDate: "2026-09-10",
      earningsDistance: 13,
      doNotTrade: false,
      debtToEquity: 0.7,
    },
  },
  {
    ticker: "F",
    values: {
      price: 11.82,
      priceChange: -0.03,
      priceChangePercent: -0.25,
      stockVolume: 55_300_000,
      strike: 11.5,
      expiration: "2026-09-18",
      dte: 21,
      premium: 0.13,
      optionBid: 0.11,
      optionAsk: 0.15,
      midpoint: 0.13,
      rsi: 42.5,
      bbPercent: 40,
      delta: 0.17,
      distanceOtmPercent: 2.71,
      ror: 1.13,
      annualizedRor: 19.65,
      spreadPercent: 23.08,
      openInterest: 1020,
      optionVolume: 23,
      earningsDate: "2026-10-16",
      earningsDistance: 49,
      doNotTrade: false,
      debtToEquity: 1.05,
    },
  },
  {
    ticker: "CORZ",
    values: {
      price: 16.89,
      priceChange: 0.21,
      priceChangePercent: 1.26,
      stockVolume: 9_800_000,
      strike: 16.5,
      expiration: "2026-09-18",
      dte: 21,
      premium: 0.06,
      optionBid: 0.04,
      optionAsk: 0.08,
      midpoint: 0.06,
      rsi: 48,
      bbPercent: 42,
      delta: 0.18,
      distanceOtmPercent: 2.31,
      ror: 1.58,
      annualizedRor: 27.46,
      spreadPercent: 40,
      openInterest: 840,
      optionVolume: 126,
      earningsDate: "2026-10-02",
      earningsDistance: 35,
      doNotTrade: false,
      debtToEquity: 1.5,
    },
  },
  {
    ticker: "SOFI",
    values: {
      price: 18.42,
      priceChange: -0.14,
      priceChangePercent: -0.75,
      stockVolume: 35_700_000,
      strike: 18,
      expiration: "2026-09-18",
      dte: 21,
      premium: 0.18,
      optionBid: 0.14,
      optionAsk: 0.22,
      midpoint: 0.18,
      rsi: 62,
      bbPercent: 76,
      delta: 0.34,
      distanceOtmPercent: 2.28,
      ror: 1.1,
      annualizedRor: 19.12,
      spreadPercent: 18,
      openInterest: 1240,
      optionVolume: 410,
      earningsDate: "2026-09-19",
      earningsDistance: 22,
      doNotTrade: false,
      debtToEquity: 0.9,
    },
  },
  {
    ticker: "AMD",
    values: {
      price: 156.2,
      priceChange: 1.88,
      priceChangePercent: 1.22,
      stockVolume: 49_100_000,
      strike: 150,
      expiration: "2026-09-18",
      dte: 21,
      premium: null,
      optionBid: null,
      optionAsk: null,
      midpoint: null,
      rsi: 51,
      bbPercent: 58,
      delta: null,
      distanceOtmPercent: 3.97,
      ror: null,
      annualizedRor: null,
      spreadPercent: 21,
      openInterest: 3220,
      optionVolume: 884,
      earningsDate: "2026-09-06",
      earningsDistance: 9,
      doNotTrade: null,
      debtToEquity: 0.4,
    },
  },
  {
    ticker: "ROKU",
    values: {
      price: 66.2,
      priceChange: -1.42,
      priceChangePercent: -2.1,
      stockVolume: 5_600_000,
      strike: 62,
      expiration: "2026-09-18",
      dte: 21,
      premium: 0.62,
      optionBid: 0.52,
      optionAsk: 0.72,
      midpoint: 0.62,
      rsi: 53.8,
      bbPercent: 62,
      delta: 0.27,
      distanceOtmPercent: 6.34,
      ror: 1,
      annualizedRor: 17.38,
      spreadPercent: 32.26,
      openInterest: 70,
      optionVolume: 38,
      earningsDate: "2026-10-21",
      earningsDistance: 54,
      doNotTrade: false,
      debtToEquity: 0.35,
    },
  },
  {
    ticker: "T",
    values: {
      price: 27.14,
      priceChange: 0.11,
      priceChangePercent: 0.41,
      stockVolume: 29_400_000,
      strike: 26.5,
      expiration: "2026-09-18",
      dte: 21,
      premium: 0.2,
      optionBid: 0.17,
      optionAsk: 0.23,
      midpoint: 0.2,
      rsi: 38.1,
      bbPercent: 31,
      delta: 0.16,
      distanceOtmPercent: 2.36,
      ror: 0.75,
      annualizedRor: 13.1,
      spreadPercent: 30,
      openInterest: 980,
      optionVolume: 140,
      earningsDate: "2026-10-31",
      earningsDistance: 64,
      doNotTrade: false,
      debtToEquity: 1.05,
    },
  },
  {
    ticker: "WBD",
    values: {
      price: 14.22,
      priceChange: -0.18,
      priceChangePercent: -1.25,
      stockVolume: 19_200_000,
      strike: 14,
      expiration: "2026-09-18",
      dte: 21,
      premium: 0.1,
      optionBid: 0.08,
      optionAsk: 0.12,
      midpoint: 0.1,
      rsi: 57,
      bbPercent: 74,
      delta: 0.31,
      distanceOtmPercent: 1.55,
      ror: 0.71,
      annualizedRor: 12.34,
      spreadPercent: 40,
      openInterest: 260,
      optionVolume: 52,
      earningsDate: "2026-09-04",
      earningsDistance: 7,
      doNotTrade: true,
      debtToEquity: 2.15,
    },
  },
];

export function defaultScannerRules(): EngineScannerRule[] {
  return SCANNER_RULE_DEFINITIONS.map((definition) => ({
    key: definition.key,
    name: definition.name,
    operator: definition.operator,
    desired: definition.defaultDesired,
  }));
}

export function getRuleDesired(valueJson: unknown, fallback: EngineScannerRule["desired"]) {
  if (valueJson && typeof valueJson === "object" && "desired" in valueJson) {
    return (valueJson as { desired?: EngineScannerRule["desired"] }).desired ?? fallback;
  }

  return fallback;
}

export function getScannerRuleDefinition(key: string) {
  return SCANNER_RULE_DEFINITIONS.find((definition) => definition.key === key);
}

export function scannerRulesFromRecords(
  records: { key: string; name: string; operator: ScannerOperator; valueJson: unknown; enabled: boolean }[],
) {
  const recordsByKey = new Map(records.map((record) => [record.key, record]));

  return SCANNER_RULE_DEFINITIONS.flatMap((definition) => {
    const record = recordsByKey.get(definition.key);
    if (record && !record.enabled) {
      return [];
    }

    return {
      key: definition.key,
      name: definition.name,
      operator: definition.operator,
      desired: getRuleDesired(record?.valueJson, definition.defaultDesired),
    };
  });
}

export function evaluateDemoScan(rules: EngineScannerRule[]) {
  return DEMO_SCAN_CANDIDATES.map((candidate) => ({
    ticker: candidate.ticker,
    values: candidate.values,
    summary: evaluateCandidate(rules, candidate.values),
  }));
}

export function formatRuleDesired(operator: ScannerOperator, desired: EngineScannerRule["desired"]) {
  if (Array.isArray(desired)) {
    return `${operator} ${desired[0]} to ${desired[1]}`;
  }

  return `${operator} ${String(desired)}`;
}

export function parseScannerDesiredFromForm(definition: ScannerRuleDefinition, formData: FormData) {
  if (definition.input.kind === "boolean") {
    return false;
  }

  if (definition.input.kind === "range") {
    const minValue = parseFiniteNumber(formData.get(`${definition.key}:min`));
    const maxValue = parseFiniteNumber(formData.get(`${definition.key}:max`));
    if (minValue === null || maxValue === null || minValue > maxValue) {
      throw new Error(`Enter a valid range for ${definition.name}.`);
    }

    return [minValue, maxValue] as [number, number];
  }

  const value = parseFiniteNumber(formData.get(`${definition.key}:value`));
  if (value === null) {
    throw new Error(`Enter a valid value for ${definition.name}.`);
  }

  return value;
}

function parseFiniteNumber(value: FormDataEntryValue | null) {
  const parsed = Number(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}
