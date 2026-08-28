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
    ticker: "CORZ",
    values: {
      price: 16.89,
      strike: 16.5,
      expiration: "2026-09-18",
      dte: 21,
      premium: 0.06,
      optionBid: 0.04,
      rsi: 48,
      bbPercent: 42,
      delta: 0.18,
      ror: 1.58,
      annualizedRor: 27.46,
      spreadPercent: 40,
      openInterest: 840,
      optionVolume: 126,
      earningsDistance: 35,
      doNotTrade: false,
      debtToEquity: 1.5,
    },
  },
  {
    ticker: "SOFI",
    values: {
      price: 18.42,
      strike: 18,
      expiration: "2026-09-18",
      dte: 21,
      premium: 0.18,
      optionBid: 0.14,
      rsi: 62,
      bbPercent: 76,
      delta: 0.34,
      ror: 1.1,
      annualizedRor: 19.12,
      spreadPercent: 18,
      openInterest: 1240,
      optionVolume: 410,
      earningsDistance: 22,
      doNotTrade: false,
      debtToEquity: 0.9,
    },
  },
  {
    ticker: "AMD",
    values: {
      price: 156.2,
      strike: 150,
      expiration: "2026-09-18",
      dte: 21,
      premium: null,
      optionBid: null,
      rsi: 51,
      bbPercent: 58,
      delta: null,
      ror: null,
      annualizedRor: null,
      spreadPercent: 21,
      openInterest: 3220,
      optionVolume: 884,
      earningsDistance: 9,
      doNotTrade: null,
      debtToEquity: 0.4,
    },
  },
  {
    ticker: "IONQ",
    values: {
      price: 28.1,
      strike: 27,
      expiration: "2026-09-18",
      dte: 21,
      premium: 0.32,
      optionBid: 0.28,
      rsi: 44,
      bbPercent: 36,
      delta: 0.22,
      ror: 1.35,
      annualizedRor: 23.46,
      spreadPercent: 19,
      openInterest: 225,
      optionVolume: 54,
      earningsDistance: 41,
      doNotTrade: false,
      debtToEquity: 0.2,
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
