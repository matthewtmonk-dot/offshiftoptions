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
    explanation: `${rule.name} ${passed ? "met" : "missed"} the ${describeRule(rule)} rule.`,
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

function describeRule(rule: ScannerRule): string {
  if (Array.isArray(rule.desired)) {
    return `${rule.operator} ${rule.desired[0]}-${rule.desired[1]}`;
  }

  return `${rule.operator} ${String(rule.desired)}`;
}
