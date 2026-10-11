import { GATING_RULE_KEYS, SCANNER_RULE_DEFINITIONS } from "./profile";
import { classifyReadiness, honestSetupLabel, honestSetupScore, primaryConcern, type CriterionResult, type CriterionStatus, type ScanSummary } from "./scanner";

/**
 * AI Advisor V1 - the compact, deterministic evidence packet sent to the model. "Code owns facts,
 * rules own pass/fail, AI explains/interprets." This module builds and validates that packet from
 * already-persisted Scanner data (a `ScanResult` row's own `snapshotJson` + its
 * `ScanCriterionResult` rows) - it never recomputes a rule's PASS/FAIL/UNKNOWN itself (that remains
 * `evaluateCriterion`'s job, already run once at scan time) and reuses the SAME scoring functions
 * (`honestSetupScore`/`honestSetupLabel`/`classifyReadiness`/`primaryConcern`) every other Scanner
 * surface already uses - never a second, independently-invented scoring interpretation. Pure, no
 * I/O - the caller (src/lib/ai-advisor.ts) is responsible for loading the real `ScanResult`.
 */

const ruleKeyByName = new Map(SCANNER_RULE_DEFINITIONS.map((definition) => [definition.name, definition.key]));
const ruleOrder = new Map(SCANNER_RULE_DEFINITIONS.map((definition, index) => [definition.name, index]));

export type AiAdvisorRuleClassification = "HARD" | "SOFT";

/** One LST criterion, in the exact shape the ticket's own packet spec calls for. `actualValue`/
 * `thresholdOrRequirement` are pre-formatted, human-readable strings - the model is never handed a
 * raw operator/threshold pair to interpret itself. */
export type AiAdvisorRuleEvidence = {
  ruleId: string;
  label: string;
  status: CriterionStatus;
  actualValue: string;
  thresholdOrRequirement: string;
  explanation: string;
  classification: AiAdvisorRuleClassification;
};

export type AiAdvisorCandidatePacket = {
  schemaVersion: "v1";
  identity: {
    ticker: string;
    /** Schwab's own company description, when the scan captured one - never a guessed name. */
    companyDescription: string | null;
  };
  timing: {
    /** When this candidate was actually evaluated (the scan row's own createdAt) - never the
     * instant the AI Review was requested, which could be long after the scan ran. */
    evaluatedAt: string;
    expiration: string | null;
    dte: number | null;
    retrievedAt: string | null;
    retrievedOnNonTradingDay: boolean | null;
  };
  underlying: {
    stockPrice: number | null;
    priceChangePercent: number | null;
    stockVolume: number | null;
    rsi: number | null;
    bbPercent: number | null;
  };
  option: {
    strike: number | null;
    optionBid: number | null;
    optionAsk: number | null;
    midpoint: number | null;
    /** A mark/midpoint estimate - never the bid-based figure `ror`/`annualizedRor` use (see
     * `premiumBasis`/`bidProceedsPerContract`, mirroring ScannerViewResult's own distinction). */
    premium: number | null;
    premiumBasis: string | null;
    bidProceedsPerContract: number | null;
    delta: number | null;
    openInterest: number | null;
    optionVolume: number | null;
    /** Calculated from the bid, never from `premium` - see `rorBasis`. */
    ror: number | null;
    annualizedRor: number | null;
    rorBasis: string | null;
    distanceOtmPercent: number | null;
    spreadPercent: number | null;
    optionQuotedAt: string | null;
  };
  riskContext: {
    earningsDate: string | null;
    earningsDistance: number | null;
    earningsWithinHoldingPeriod: boolean | null;
    /** Machine-readable OptionEnrichmentState (live-scan.ts) - whether an option-chain request was
     * actually spent on this candidate, and if not, why not - never silently omitted. */
    optionEnrichment: string | null;
    /** The scanner's own honest, already-written explanation of a blank/incomplete option column -
     * never re-explained or reinterpreted by the model as something more certain. */
    scanNote: string | null;
    deterministicScore: number;
    deterministicScoreLabel: string;
    deterministicReadiness: string;
    primaryConcernRuleId: string | null;
  };
  /** Every existing scanner criterion for this candidate - the model is explicitly instructed it
   * may explain these but can never override a status here. */
  rules: AiAdvisorRuleEvidence[];
};

/** The subset of a persisted `ScanCriterionResult` row this module needs - deliberately NOT a
 * Prisma type, so this stays pure/testable with plain fixtures. */
export type AiAdvisorPacketSourceCriterion = {
  criterionName: string;
  actualValue: string | null;
  operator: string;
  desiredValue: string;
  status: CriterionStatus;
  explanation: string;
};

/** The subset of a persisted `ScanResult` row this module needs. */
export type AiAdvisorPacketSource = {
  ticker: string;
  evaluatedAt: Date;
  snapshot: unknown;
  criteria: readonly AiAdvisorPacketSourceCriterion[];
};

function snapshotNumber(snapshot: unknown, key: string): number | null {
  if (!snapshot || typeof snapshot !== "object" || !(key in snapshot)) return null;
  const value = (snapshot as Record<string, unknown>)[key];
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function snapshotString(snapshot: unknown, key: string): string | null {
  if (!snapshot || typeof snapshot !== "object" || !(key in snapshot)) return null;
  const value = (snapshot as Record<string, unknown>)[key];
  return value ? String(value) : null;
}

function snapshotBoolean(snapshot: unknown, key: string): boolean | null {
  if (!snapshot || typeof snapshot !== "object" || !(key in snapshot)) return null;
  const value = (snapshot as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : null;
}

function formatActualValue(raw: string | null): string {
  if (raw === null || raw === "") return "unknown";
  return raw;
}

function formatThreshold(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.length === 2) return `between ${parsed[0]} and ${parsed[1]}`;
    if (typeof parsed === "number" || typeof parsed === "string" || typeof parsed === "boolean") return String(parsed);
  } catch {
    return raw;
  }
  return raw;
}

function buildRuleEvidence(source: AiAdvisorPacketSourceCriterion): AiAdvisorRuleEvidence {
  const ruleId = ruleKeyByName.get(source.criterionName) ?? source.criterionName;
  return {
    ruleId,
    label: source.criterionName,
    status: source.status,
    actualValue: formatActualValue(source.actualValue),
    thresholdOrRequirement: formatThreshold(source.desiredValue),
    explanation: source.explanation,
    classification: GATING_RULE_KEYS.has(ruleId) ? "HARD" : "SOFT",
  };
}

/** Converts the packet's own rule list back into the real `ScanSummary`/`CriterionResult[]` shape
 * so the real `honestSetupScore`/`honestSetupLabel`/`classifyReadiness`/`primaryConcern` (scanner.ts)
 * can be called on it directly - a type-shape bridge only, never a second scoring interpretation. */
function toScanSummary(rules: readonly AiAdvisorRuleEvidence[]): ScanSummary {
  const results: CriterionResult[] = rules.map((rule) => ({
    key: rule.ruleId,
    name: rule.label,
    actualValue: rule.actualValue,
    operator: "EQ",
    desiredValue: rule.thresholdOrRequirement,
    status: rule.status,
    explanation: rule.explanation,
  }));
  return {
    status: results.some((r) => r.status === "FAIL") ? "FAIL" : results.some((r) => r.status === "UNKNOWN") ? "UNKNOWN" : "PASS",
    passed: results.filter((r) => r.status === "PASS").length,
    total: results.length,
    results,
  };
}

/** The one place a hard-rule failure is identified from a packet - the UI renders this list
 * directly (never only the model's own self-reported `hardRuleFailures`), so a real failure can
 * never silently disappear from what the user sees. */
export function hardRuleFailures(packet: AiAdvisorCandidatePacket): AiAdvisorRuleEvidence[] {
  return packet.rules.filter((rule) => rule.classification === "HARD" && rule.status === "FAIL");
}

/** The companion list to `hardRuleFailures` - a hard rule that's UNKNOWN (not FAIL) is a distinct
 * finding ("missing/stale evidence on a gate," never silently treated as a pass) and the UI renders
 * it from the packet directly, same as a failure - never only from the model's own prose. */
export function unknownHardRules(packet: AiAdvisorCandidatePacket): AiAdvisorRuleEvidence[] {
  return packet.rules.filter((rule) => rule.classification === "HARD" && rule.status === "UNKNOWN");
}

export function hasUnknownHardRule(packet: AiAdvisorCandidatePacket): boolean {
  return unknownHardRules(packet).length > 0;
}

export function buildAiAdvisorPacket(source: AiAdvisorPacketSource): AiAdvisorCandidatePacket {
  const snapshot = source.snapshot;
  const optionEnrichment = snapshotString(snapshot, "optionEnrichment");
  const contractReasonCode = snapshotString(snapshot, "contractReasonCode");

  const rules = [...source.criteria]
    .map(buildRuleEvidence)
    .sort((left, right) => (ruleOrder.get(left.label) ?? 999) - (ruleOrder.get(right.label) ?? 999));

  const summary = toScanSummary(rules);
  const score = honestSetupScore(summary, GATING_RULE_KEYS);
  const scoreLabel = honestSetupLabel(summary, GATING_RULE_KEYS);
  const readiness = classifyReadiness(summary, GATING_RULE_KEYS, optionEnrichment, contractReasonCode);
  const concern = primaryConcern(summary.results);

  return {
    schemaVersion: "v1",
    identity: {
      ticker: source.ticker,
      companyDescription: snapshotString(snapshot, "companyDescription"),
    },
    timing: {
      evaluatedAt: source.evaluatedAt.toISOString(),
      expiration: snapshotString(snapshot, "expiration"),
      dte: snapshotNumber(snapshot, "dte"),
      retrievedAt: snapshotString(snapshot, "retrievedAt"),
      retrievedOnNonTradingDay: snapshotBoolean(snapshot, "retrievedOnNonTradingDay"),
    },
    underlying: {
      stockPrice: snapshotNumber(snapshot, "price"),
      priceChangePercent: snapshotNumber(snapshot, "priceChangePercent"),
      stockVolume: snapshotNumber(snapshot, "stockVolume"),
      rsi: snapshotNumber(snapshot, "rsi"),
      bbPercent: snapshotNumber(snapshot, "bbPercent"),
    },
    option: {
      strike: snapshotNumber(snapshot, "strike"),
      optionBid: snapshotNumber(snapshot, "optionBid"),
      optionAsk: snapshotNumber(snapshot, "optionAsk"),
      midpoint: snapshotNumber(snapshot, "midpoint"),
      premium: snapshotNumber(snapshot, "premium"),
      premiumBasis: snapshotString(snapshot, "premiumBasis"),
      bidProceedsPerContract: snapshotNumber(snapshot, "bidProceedsPerContract"),
      delta: snapshotNumber(snapshot, "delta"),
      openInterest: snapshotNumber(snapshot, "openInterest"),
      optionVolume: snapshotNumber(snapshot, "optionVolume"),
      ror: snapshotNumber(snapshot, "ror"),
      annualizedRor: snapshotNumber(snapshot, "annualizedRor"),
      rorBasis: snapshotString(snapshot, "rorBasis"),
      distanceOtmPercent: snapshotNumber(snapshot, "distanceOtmPercent"),
      spreadPercent: snapshotNumber(snapshot, "spreadPercent"),
      optionQuotedAt: snapshotString(snapshot, "optionQuotedAt"),
    },
    riskContext: {
      earningsDate: snapshotString(snapshot, "earningsDate"),
      earningsDistance: snapshotNumber(snapshot, "earningsDistance"),
      earningsWithinHoldingPeriod: snapshotBoolean(snapshot, "earningsWithinHoldingPeriod"),
      optionEnrichment,
      scanNote: snapshotString(snapshot, "scanNote"),
      deterministicScore: score,
      deterministicScoreLabel: scoreLabel,
      deterministicReadiness: readiness,
      primaryConcernRuleId: concern ? (ruleKeyByName.get(concern.name) ?? concern.name) : null,
    },
    rules,
  };
}

export type AiAdvisorPacketValidation = { ok: true } | { ok: false; error: string };

/**
 * Pre-call gating only - rejects an obviously malformed packet BEFORE spending API money, never a
 * judgment about whether the candidate itself is a good trade (that's the model's job, within the
 * rules the packet already carries). Missing/UNKNOWN evidence is explicitly NOT rejected here - a
 * candidate with genuinely unknown option evidence is still a valid request, expected to resolve to
 * an INSUFFICIENT_DATA decision rather than being blocked outright.
 */
export function validateAiAdvisorPacket(packet: AiAdvisorCandidatePacket): AiAdvisorPacketValidation {
  if (!packet.identity.ticker || packet.identity.ticker.trim() === "") {
    return { ok: false, error: "This candidate is missing a ticker and cannot be reviewed." };
  }
  if (packet.rules.length === 0) {
    return { ok: false, error: "This candidate has no LST criteria evaluated yet." };
  }
  if (packet.underlying.stockPrice !== null && packet.underlying.stockPrice <= 0) {
    return { ok: false, error: "This candidate's stock price is invalid." };
  }
  if (packet.option.strike !== null && packet.option.strike <= 0) {
    return { ok: false, error: "This candidate's option strike is invalid." };
  }
  if (packet.option.optionBid !== null && packet.option.optionBid < 0) {
    return { ok: false, error: "This candidate's option bid is invalid." };
  }
  return { ok: true };
}
