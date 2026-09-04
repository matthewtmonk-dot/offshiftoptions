export type CriterionStatus = "PASS" | "FAIL" | "UNKNOWN";
export type ScannerOperator = "LTE" | "GTE" | "BETWEEN" | "EQ" | "NEQ" | "EXISTS";

export type ScannerRule = {
  key: string;
  name: string;
  operator: ScannerOperator;
  desired: number | string | boolean | [number, number];
};

export type CriterionResult = {
  key: string;
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

export type SetupScoreLabel = "Excellent" | "Strong" | "Borderline" | "Needs work" | "Poor" | "Fails" | "Verify";

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
      key: rule.key,
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
    key: rule.key,
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

/**
 * A gating criterion defines whether the setup is even tradeable under the strategy
 * (price band, liquidity, delta shape, earnings risk, an explicit do-not-trade flag).
 * A preference criterion is a quality/timing signal (RSI, BB position, ROR, etc.) that
 * can be missed by a little without making the trade impossible or unsafe.
 *
 * A FAIL on a gating criterion must cap the score and force a non-positive label - it
 * must never read "Strong"/"Excellent" regardless of how well the rest of the row scores.
 * Any UNKNOWN criterion (gating or preference) must also block a positive label, since a
 * score computed only on what's known cannot certify a setup as ready.
 */
export const GATING_SCORE_CAP = 49;

export function hasGatingFailure(results: CriterionResult[], gatingKeys: ReadonlySet<string>): boolean {
  return results.some((result) => result.status === "FAIL" && gatingKeys.has(result.key));
}

export function honestSetupScore(summary: ScanSummary, gatingKeys: ReadonlySet<string>): number {
  const raw = setupScore(summary);
  return hasGatingFailure(summary.results, gatingKeys) ? Math.min(raw, GATING_SCORE_CAP) : raw;
}

/**
 * The label a user actually reads. Never derived from the numeric score alone:
 * - a gating FAIL always reads "Fails", regardless of score
 * - any UNKNOWN criterion always reads "Verify", regardless of score
 * - only a fully-resolved, non-gating-failed row uses the graded 0-100 scale
 */
export function honestSetupLabel(summary: ScanSummary, gatingKeys: ReadonlySet<string>): SetupScoreLabel {
  if (hasGatingFailure(summary.results, gatingKeys)) {
    return "Fails";
  }

  if (summary.status === "UNKNOWN") {
    return "Verify";
  }

  return setupScoreLabel(honestSetupScore(summary, gatingKeys));
}

/**
 * Reconstructs a persisted `ScanCriterionResult.actualValue` (always stored as a string or
 * null - see persistScannerRun in workflows.ts) back into the typed value `CriterionResult`
 * expects. Shared by every reader of persisted scan criteria (Research's scan snapshot, the
 * Alpha Vantage queue's Near-tier classification) so there is exactly one definition of how a
 * stored criterion round-trips, not a copy per caller.
 */
export function parseStoredCriterionActualValue(raw: string | null): CriterionResult["actualValue"] {
  if (raw === null || raw === "") {
    return null;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : raw;
}

/**
 * Reconstructs a persisted `ScanCriterionResult.desiredValue` back into the typed value
 * `CriterionResult` expects. It's stored via `JSON.stringify(result.desiredValue)`
 * (persistScannerRun in workflows.ts) specifically so a BETWEEN rule's `[low, high]` tuple
 * survives as a real array, not a string - `criterionGap()`'s `Array.isArray(desired)` check
 * depends on this. Falls back to the raw string if it somehow isn't valid JSON (defensive,
 * matches the guarded-parse convention already used for scan snapshot JSON elsewhere).
 */
export function parseStoredCriterionDesiredValue(raw: string): CriterionResult["desiredValue"] {
  try {
    return JSON.parse(raw) as CriterionResult["desiredValue"];
  } catch {
    return raw;
  }
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
