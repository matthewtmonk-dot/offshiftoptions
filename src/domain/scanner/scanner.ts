export type CriterionStatus = "PASS" | "FAIL" | "UNKNOWN";
export type ScannerOperator = "LTE" | "GTE" | "BETWEEN" | "EQ" | "NEQ" | "EXISTS";

export type ScannerRule = {
  key: string;
  name: string;
  operator: ScannerOperator;
  desired: number | string | boolean | [number, number];
};

export type CriterionResult = {
  name: string;
  actualValue: number | string | boolean | null | undefined;
  operator: ScannerOperator;
  desiredValue: ScannerRule["desired"];
  status: CriterionStatus;
  explanation: string;
};

export type ScanSummary = {
  status: CriterionStatus;
  passed: number;
  total: number;
  results: CriterionResult[];
};

export type CriterionGap = {
  result: CriterionResult;
  near: boolean;
  gapPercent: number | null;
  message: string;
};

export type SetupScoreLabel = "Excellent" | "Strong" | "Borderline" | "Needs work" | "Poor";

export type ExclusionDiagnostic = {
  startingUniverse: number;
  finalMatches: number;
  unknownOnly: number;
  removals: {
    criterionName: string;
    count: number;
    tickers: string[];
  }[];
};

export function evaluateCriterion(rule: ScannerRule, actualValue: CriterionResult["actualValue"]): CriterionResult {
  if (actualValue === null || actualValue === undefined || actualValue === "") {
    return {
      name: rule.name,
      actualValue,
      operator: rule.operator,
      desiredValue: rule.desired,
      status: "UNKNOWN",
      explanation: `${rule.name} is unknown for this candidate.`,
    };
  }

  const passed = compare(rule.operator, actualValue, rule.desired);
  return {
    name: rule.name,
    actualValue,
    operator: rule.operator,
    desiredValue: rule.desired,
    status: passed ? "PASS" : "FAIL",
    explanation: describeCriterionResult(rule, actualValue, passed),
  };
}

export function evaluateCandidate(
  rules: ScannerRule[],
  candidate: Record<string, number | string | boolean | null | undefined>,
): ScanSummary {
  const results = rules.map((rule) => evaluateCriterion(rule, candidate[rule.key]));
  const passed = results.filter((result) => result.status === "PASS").length;
  const unknown = results.some((result) => result.status === "UNKNOWN");
  const failed = results.some((result) => result.status === "FAIL");

  return {
    status: failed ? "FAIL" : unknown ? "UNKNOWN" : "PASS",
    passed,
    total: results.length,
    results,
  };
}

export function setupScore(summary: ScanSummary): number {
  if (summary.total === 0) {
    return 0;
  }

  const earned = summary.results.reduce((points, result) => {
    if (result.status === "PASS") {
      return points + 1;
    }

    if (result.status === "UNKNOWN") {
      return points + 0.45;
    }

    return points + (criterionGap(result)?.near ? 0.72 : 0);
  }, 0);

  return Math.round((earned / summary.total) * 100);
}

export function setupScoreLabel(score: number): SetupScoreLabel {
  if (score >= 90) {
    return "Excellent";
  }
  if (score >= 78) {
    return "Strong";
  }
  if (score >= 65) {
    return "Borderline";
  }
  if (score >= 45) {
    return "Needs work";
  }
  return "Poor";
}

export function getNearMisses(results: CriterionResult[]): CriterionGap[] {
  return results.flatMap((result) => {
    const gap = criterionGap(result);
    return gap?.near ? [gap] : [];
  });
}

export function primaryConcern(results: CriterionResult[]): CriterionResult | null {
  return (
    results.find((result) => result.status === "FAIL") ??
    results.find((result) => result.status === "UNKNOWN") ??
    null
  );
}

export function buildExclusionDiagnostics(
  candidates: { ticker: string; summary: ScanSummary }[],
): ExclusionDiagnostic {
  const removalMap = new Map<string, { criterionName: string; tickers: string[] }>();
  let finalMatches = 0;
  let unknownOnly = 0;

  for (const candidate of candidates) {
    const firstFailure = candidate.summary.results.find((result) => result.status === "FAIL");
    if (firstFailure) {
      const bucket = removalMap.get(firstFailure.name) ?? { criterionName: firstFailure.name, tickers: [] };
      bucket.tickers.push(candidate.ticker);
      removalMap.set(firstFailure.name, bucket);
      continue;
    }

    if (candidate.summary.status === "PASS") {
      finalMatches += 1;
    } else if (candidate.summary.status === "UNKNOWN") {
      unknownOnly += 1;
    }
  }

  return {
    startingUniverse: candidates.length,
    finalMatches,
    unknownOnly,
    removals: [...removalMap.values()]
      .map((removal) => ({
        criterionName: removal.criterionName,
        count: removal.tickers.length,
        tickers: removal.tickers,
      }))
      .sort((left, right) => right.count - left.count || left.criterionName.localeCompare(right.criterionName)),
  };
}

export function formatDesiredValue(operator: ScannerOperator, desired: ScannerRule["desired"]): string {
  if (Array.isArray(desired)) {
    return `between ${formatCriterionValue(desired[0])} and ${formatCriterionValue(desired[1])}`;
  }

  switch (operator) {
    case "LTE":
      return `at most ${formatCriterionValue(desired)}`;
    case "GTE":
      return `at least ${formatCriterionValue(desired)}`;
    case "EQ":
      return `equal to ${formatCriterionValue(desired)}`;
    case "NEQ":
      return `not equal to ${formatCriterionValue(desired)}`;
    case "EXISTS":
      return Boolean(desired) ? "present" : "not present";
    default:
      return String(desired);
  }
}

export function formatCriterionValue(value: ScannerRule["desired"] | CriterionResult["actualValue"]): string {
  if (Array.isArray(value)) {
    return `${value[0]} to ${value[1]}`;
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    return Number.isInteger(value) ? value.toString() : value.toFixed(2).replace(/\.?0+$/, "");
  }

  if (value === null || value === undefined || value === "") {
    return "UNKNOWN";
  }

  return String(value);
}

function compare(operator: ScannerOperator, actual: NonNullable<CriterionResult["actualValue"]>, desired: ScannerRule["desired"]): boolean {
  switch (operator) {
    case "LTE":
      return Number(actual) <= Number(desired);
    case "GTE":
      return Number(actual) >= Number(desired);
    case "BETWEEN": {
      const [low, high] = desired as [number, number];
      return Number(actual) >= low && Number(actual) <= high;
    }
    case "EQ":
      return actual === desired;
    case "NEQ":
      return actual !== desired;
    case "EXISTS":
      return Boolean(actual) === Boolean(desired);
    default:
      return false;
  }
}

function describeCriterionResult(
  rule: ScannerRule,
  actualValue: NonNullable<CriterionResult["actualValue"]>,
  passed: boolean,
): string {
  const actual = formatCriterionValue(actualValue);
  const desired = formatDesiredValue(rule.operator, rule.desired);

  if (passed) {
    return `${rule.name} passed: ${actual} is ${desired}.`;
  }

  return `Flagged because ${rule.name.toLowerCase()} was ${actual}; profile asks for ${desired}.`;
}

function criterionGap(result: CriterionResult): CriterionGap | null {
  if (result.status !== "FAIL") {
    return null;
  }

  const actual = numericValue(result.actualValue);
  const desired = result.desiredValue;
  const desiredText = formatDesiredValue(result.operator, desired);

  if (actual === null) {
    return {
      result,
      near: false,
      gapPercent: null,
      message: `${result.name} was ${formatCriterionValue(result.actualValue)}; profile asks for ${desiredText}.`,
    };
  }

  if (Array.isArray(desired) && result.operator === "BETWEEN") {
    const [low, high] = desired;
    if (actual >= low && actual <= high) {
      return null;
    }

    const distance = actual < low ? low - actual : actual - high;
    const span = Math.max(Math.abs(high - low), 1);
    const gapPercent = (distance / span) * 100;

    return {
      result,
      near: gapPercent <= 12,
      gapPercent,
      message: `${result.name} was ${formatCriterionValue(actual)}; profile asks for ${desiredText}.`,
    };
  }

  const target = numericValue(desired);
  if (target === null) {
    return {
      result,
      near: false,
      gapPercent: null,
      message: `${result.name} was ${formatCriterionValue(result.actualValue)}; profile asks for ${desiredText}.`,
    };
  }

  if (result.operator === "GTE" && actual < target) {
    const gapPercent = ((target - actual) / Math.max(Math.abs(target), 1)) * 100;
    return {
      result,
      near: gapPercent <= 12,
      gapPercent,
      message: `${result.name} was ${formatCriterionValue(actual)}; profile asks for ${desiredText}.`,
    };
  }

  if (result.operator === "LTE" && actual > target) {
    const gapPercent = ((actual - target) / Math.max(Math.abs(target), 1)) * 100;
    return {
      result,
      near: gapPercent <= 12,
      gapPercent,
      message: `${result.name} was ${formatCriterionValue(actual)}; profile asks for ${desiredText}.`,
    };
  }

  return {
    result,
    near: false,
    gapPercent: null,
    message: `${result.name} was ${formatCriterionValue(result.actualValue)}; profile asks for ${desiredText}.`,
  };
}

function numericValue(value: ScannerRule["desired"] | CriterionResult["actualValue"]): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}
