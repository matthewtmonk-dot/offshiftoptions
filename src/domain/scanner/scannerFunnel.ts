import type { ScannerReadiness } from "./scanner";

/**
 * Scanner funnel + "worth a look" classification - PURE and PRESENTATION-ONLY. It reads facts the
 * scanner already persisted per row (stock-screen verdict, option-assessment state, the one
 * authoritative readiness answer) and groups them for display. It never re-scores, re-ranks or
 * re-labels anything, and never changes PASS/NEAR/FAIL.
 *
 * Why this exists: a live scan examines thousands of stocks, narrows them to the few that pass the
 * stock screen (price, volume, RSI, Bollinger %B, earnings), then can only price options for some of
 * them. Without a funnel, the page shows ~100 rows where most are "stock screen only" - noise that
 * buries the handful of real candidates and hides the actual bottleneck (how many qualified stocks
 * still have no option check).
 */
export type StockScreenVerdict = "PASS" | "FAIL" | "UNKNOWN";

export type FunnelRowInput = {
  readiness: ScannerReadiness;
  /** Persisted optionEnrichment state; null for a run that predates the field. */
  optionEnrichment: string | null;
  /** Verdict over this row's enabled stock-level criteria only (price, volume, RSI, %B, earnings...). */
  stockScreen: StockScreenVerdict;
  /** True when RSI/Bollinger weren't ready for this row (pending/stale/failed technical cache). */
  technicalIncomplete: boolean;
  /** Every enabled HARD (gating) rule - price, volume, open interest, bid, spread, delta, earnings,
   * do-not-trade - is a definite PASS. An UNKNOWN or FAIL on any of them is not "clear". */
  gatingClear: boolean;
  /** A real option contract was selected for this row (no "no contract" reason code). */
  contractSelected: boolean;
};

export type ScannerFunnel = {
  /** Rows persisted for this run (not the whole universe - see MAX_DISPLAYED_STOCK_STAGE_RESULTS). */
  total: number;
  /** Passed every enabled stock-level criterion with complete evidence. */
  stockQualified: number;
  /** Stock-qualified AND had their options priced. */
  optionChecked: number;
  pass: number;
  near: number;
  /** Priced rows that clear every hard rule - may still miss a preference (RSI, %B, ROR). The pool
   * "Best available" draws from when nothing PASSes, so capital isn't left idle on a thin week. */
  bestAvailable: number;
  /** Stock-qualified but options not priced yet - the bottleneck the "Check options" action clears. */
  awaitingOptionCheck: number;
  /** Failed the stock screen (RSI/%B/price/earnings...) - never worth a user's time. */
  stockScreenFailed: number;
  /** RSI/Bollinger or other stock evidence missing - can't be judged yet. */
  incompleteEvidence: number;
  /** Rows from a run that predates option-assessment tracking; can't be classified, shown only under All. */
  legacy: number;
};

export function isStockQualified(row: FunnelRowInput): boolean {
  return row.stockScreen === "PASS" && !row.technicalIncomplete && row.optionEnrichment !== "NOT_ENRICHED_STOCK_FILTER" && row.optionEnrichment !== "NOT_ENRICHED_DATA_UNAVAILABLE";
}

/** A qualified stock whose options have not been priced yet. */
export function isAwaitingOptionCheck(row: FunnelRowInput): boolean {
  return isStockQualified(row) && row.optionEnrichment === "NOT_ENRICHED_BUDGET";
}

/**
 * The default Scanner view: only what deserves a human's time - a PASS or NEAR with real option
 * evidence, or a stock-qualified name still waiting for its option check. Everything else (failed
 * the stock screen, data unavailable, priced but not close) stays one click away under "All".
 */
export function isWorthALook(row: FunnelRowInput): boolean {
  return row.readiness === "PASS" || row.readiness === "NEAR" || isAwaitingOptionCheck(row);
}

/**
 * "Best available": a priced row with a real contract that clears EVERY hard safety rule, whether or
 * not it also meets every preference. Never promotes a row with a hard-rule FAIL or UNKNOWN - that is
 * the line that keeps "best available" from quietly overriding a safety blocker. Includes PASS and
 * NEAR (they clear the hard rules by definition) so the list reads best-first when sorted by score.
 */
export function isBestAvailable(row: FunnelRowInput): boolean {
  return row.optionEnrichment === "ENRICHED" && row.contractSelected && row.gatingClear;
}

export function buildScannerFunnel(rows: readonly FunnelRowInput[]): ScannerFunnel {
  const funnel: ScannerFunnel = {
    total: rows.length,
    stockQualified: 0,
    optionChecked: 0,
    bestAvailable: 0,
    pass: 0,
    near: 0,
    awaitingOptionCheck: 0,
    stockScreenFailed: 0,
    incompleteEvidence: 0,
    legacy: 0,
  };
  for (const row of rows) {
    if (row.optionEnrichment === null) funnel.legacy += 1;
    if (isBestAvailable(row)) funnel.bestAvailable += 1;
    if (row.readiness === "PASS") funnel.pass += 1;
    if (row.readiness === "NEAR") funnel.near += 1;
    if (isStockQualified(row)) {
      funnel.stockQualified += 1;
      if (row.optionEnrichment === "ENRICHED") funnel.optionChecked += 1;
      if (row.optionEnrichment === "NOT_ENRICHED_BUDGET") funnel.awaitingOptionCheck += 1;
    } else if (row.stockScreen === "FAIL") {
      funnel.stockScreenFailed += 1;
    } else {
      funnel.incompleteEvidence += 1;
    }
  }
  return funnel;
}

/** One plain-English sentence for the funnel strip. Never claims more than the counts show. */
export function describeScannerFunnel(funnel: ScannerFunnel, options: { truncated?: boolean } = {}): string {
  if (funnel.total === 0) return "No scan results yet.";
  const plus = options.truncated ? "+" : "";
  const parts = [`${funnel.stockQualified}${plus} passed the stock screen`];
  if (funnel.stockQualified > 0) {
    parts.push(`${funnel.optionChecked} had options priced`);
    parts.push(`${funnel.pass} pass, ${funnel.near} near`);
    if (funnel.awaitingOptionCheck > 0) parts.push(`${funnel.awaitingOptionCheck}${plus} still waiting for an option check`);
    if (funnel.pass === 0 && funnel.bestAvailable > 0) parts.push(`${funnel.bestAvailable} clear every hard rule (see Best available)`);
  }
  return parts.join(" - ");
}

/** Maps a Scanner view row (see ScannerViewResult in scanner/page.tsx) to the funnel's input, so the
 * server-rendered funnel strip and the client-side default filter can never classify a row differently. */
export function funnelInputOf(result: {
  readiness: ScannerReadiness;
  stockScreen: StockScreenVerdict;
  technicalReasonCode: string | null;
  gatingClear: boolean;
  values: { optionEnrichment: string | null; rsi: number | null; bbPercent: number | null; strike: number | null };
  contractReasonCode: string | null;
}): FunnelRowInput {
  return {
    readiness: result.readiness,
    optionEnrichment: result.values.optionEnrichment,
    stockScreen: result.stockScreen,
    technicalIncomplete: result.technicalReasonCode !== null || (result.values.rsi === null && result.values.bbPercent === null),
    gatingClear: result.gatingClear,
    contractSelected: result.contractReasonCode === null && result.values.strike !== null,
  };
}

export type OptionOutcomeRow = {
  readiness: ScannerReadiness;
  optionEnrichment: string | null;
  contractReasonCode: string | null;
  criteria: readonly { key: string; status: string }[];
};

/** Why a row whose options WERE priced still didn't PASS - ordered by what a user would act on. */
const CONTRACT_REASON_LABELS: Record<string, string> = {
  NO_WEEKLY_EXPIRATION: "no weekly option in your expiration window",
  NO_EXPIRATIONS_IN_CONFIGURED_RANGE: "no weekly option in your expiration window",
  NO_PUT_CONTRACTS: "no put options listed",
  NO_ACCEPTABLE_STRIKE: "no strike below the stock price",
  NO_CONTRACT_WITH_POSITIVE_BID: "no put with a bid",
  CHAIN_UNAVAILABLE: "Schwab returned no option data",
};

/** Hard (gating) option rules first - a FAIL there is the real blocker - then preferences. */
const BLOCKING_CRITERION_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["openInterest", "open interest too low"],
  ["optionBid", "bid below your minimum"],
  ["spreadPercent", "bid/ask spread too wide"],
  ["delta", "delta outside your range"],
  ["earningsDistance", "earnings too close"],
  ["dte", "outside your expiration window"],
  ["ror", "return below your target"],
  ["annualizedRor", "annualized return below target"],
  ["optionVolume", "option volume too low"],
];

/**
 * For priced rows that did NOT pass, the single most important reason each one failed, counted and
 * sorted - so a thin week reads "5 had no weekly option, 2 returned under your target" instead of a
 * wall of near-identical rows. Presentation only: it reads the criteria the scanner already stored.
 */
export function summarizeOptionOutcomes(rows: readonly OptionOutcomeRow[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.optionEnrichment !== "ENRICHED" || row.readiness === "PASS") continue;
    let label: string | undefined = row.contractReasonCode ? CONTRACT_REASON_LABELS[row.contractReasonCode] : undefined;
    if (!label && row.contractReasonCode) label = "no usable option contract";
    if (!label) {
      const failed = new Set(row.criteria.filter((criterion) => criterion.status === "FAIL").map((criterion) => criterion.key));
      label = BLOCKING_CRITERION_LABELS.find(([key]) => failed.has(key))?.[1];
    }
    if (!label) label = row.readiness === "NEAR" ? "just under one preference" : "missing option data";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => ({ label, count })).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

/** "5 no weekly option in your expiration window · 2 return below your target" */
export function describeOptionOutcomes(outcomes: readonly { label: string; count: number }[]): string {
  return outcomes.map((outcome) => `${outcome.count} ${outcome.label}`).join(" · ");
}
