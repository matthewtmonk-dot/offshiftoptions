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

export function buildScannerFunnel(rows: readonly FunnelRowInput[]): ScannerFunnel {
  const funnel: ScannerFunnel = {
    total: rows.length,
    stockQualified: 0,
    optionChecked: 0,
    pass: 0,
    near: 0,
    awaitingOptionCheck: 0,
    stockScreenFailed: 0,
    incompleteEvidence: 0,
    legacy: 0,
  };
  for (const row of rows) {
    if (row.optionEnrichment === null) funnel.legacy += 1;
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
  }
  return parts.join(" - ");
}

/** Maps a Scanner view row (see ScannerViewResult in scanner/page.tsx) to the funnel's input, so the
 * server-rendered funnel strip and the client-side default filter can never classify a row differently. */
export function funnelInputOf(result: {
  readiness: ScannerReadiness;
  stockScreen: StockScreenVerdict;
  technicalReasonCode: string | null;
  values: { optionEnrichment: string | null; rsi: number | null; bbPercent: number | null };
}): FunnelRowInput {
  return {
    readiness: result.readiness,
    optionEnrichment: result.values.optionEnrichment,
    stockScreen: result.stockScreen,
    technicalIncomplete: result.technicalReasonCode !== null || (result.values.rsi === null && result.values.bbPercent === null),
  };
}
