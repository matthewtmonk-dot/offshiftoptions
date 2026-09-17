/**
 * Whether a scanner row's options were actually assessed, and when they weren't, WHY not.
 *
 * This is a different question from OptionScanReasonCode (see live-scan.ts), which only ever
 * describes what a chain OSO DID fetch turned out to contain. Option-chain enrichment is budgeted
 * (OPTION_CHAIN_ENRICHMENT_LIMIT), so in a broad universe scan most rows are stock-screened only:
 * their option criteria read UNKNOWN because nobody ever asked Schwab about them, not because
 * Schwab was asked and had no answer. Those two facts must never render the same way - "Option bid
 * unavailable" on a ticker OSO never requested is simply false.
 *
 * Kept in its own module (zero React/Next/provider imports) because both the producer
 * (evaluateLiveMarketScan) and the consumer (the Scanner UI) have to agree on the exact vocabulary,
 * and because that agreement is then directly testable without rendering anything.
 */
export type OptionEnrichmentState =
  /** An option-chain request was actually spent on this ticker - whether or not it then succeeded.
   * A failed request is still an assessment attempt (see CHAIN_UNAVAILABLE), so such a row keeps
   * real VERIFY/UNKNOWN option semantics rather than being called "not assessed". */
  | "ENRICHED"
  /** Eligible for the shortlist, but ranked outside the per-scan chain budget. The only honest
   * reading is "OSO ran out of budget", never "Schwab had no data". */
  | "NOT_ENRICHED_BUDGET"
  /** A known stock-level FAIL (quote-stage price/volume, or any enabled stock rule) disqualified
   * it before its options were worth pricing - it never competed for the budget at all. */
  | "NOT_ENRICHED_STOCK_FILTER"
  /** The quote or price history needed to even evaluate the stock screen failed, so this row never
   * reached a state where enrichment could be decided. Distinct from STOCK_FILTER, which is a real
   * (and deliberate) screening judgment rather than missing evidence. */
  | "NOT_ENRICHED_DATA_UNAVAILABLE";

export type NotEnrichedState = Exclude<OptionEnrichmentState, "ENRICHED">;

const NOT_ENRICHED_STATES = new Set<string>([
  "NOT_ENRICHED_BUDGET",
  "NOT_ENRICHED_STOCK_FILTER",
  "NOT_ENRICHED_DATA_UNAVAILABLE",
]);

/**
 * True only for a row OSO is KNOWN never to have requested options for. A run predating this field
 * (null/undefined - the value arrives from persisted snapshot JSON) is deliberately NOT treated as
 * un-assessed: the honest answer there is "this run didn't record it", so such a row keeps its
 * pre-existing display rather than being relabelled on a guess.
 */
export function isNotOptionAssessed(state: unknown): boolean {
  return typeof state === "string" && NOT_ENRICHED_STATES.has(state);
}

/** Long-form reason persisted as the row's scanNote when nothing more specific already claimed it. */
export function notEnrichedScanNote(state: NotEnrichedState, chainBudget: number): string {
  switch (state) {
    case "NOT_ENRICHED_BUDGET":
      return `Options not checked - this ticker ranked outside the top ${chainBudget} option-chain enrichment budget for this scan.`;
    case "NOT_ENRICHED_STOCK_FILTER":
      return "Options not checked - this stock did not qualify on the stock-level screen.";
    case "NOT_ENRICHED_DATA_UNAVAILABLE":
      return "Options not checked - stock data needed to screen this ticker was unavailable.";
  }
}

/**
 * The badge word for a never-assessed row. Deliberately NOT one of PASS/NEAR/FAIL/VERIFY: those
 * are option-quality verdicts, and this is an assessment-stage fact about work OSO has not done.
 */
export const NOT_OPTION_ASSESSED_BADGE = "STOCK SCREEN ONLY";

/**
 * What a scanner row should actually list as the reason its option columns are blank.
 *
 * For a never-assessed row this is exactly one truthful line - never the per-criterion
 * "Option bid unavailable / Open interest unavailable / Put ROR unknown" phrasing, which asserts
 * that Schwab was asked and had no answer. Any row whose chain WAS requested (including one whose
 * request failed) keeps its real per-criterion reasons, so genuine option UNKNOWNs stay visible.
 */
export function scannerRowReasons(state: unknown, unknownCriterionReasons: string[], chainBudget: number): string[] {
  const label = notOptionAssessedLabel(state, chainBudget);
  return label ? [label] : unknownCriterionReasons;
}

/**
 * The one concise line shown under that badge. Returns null for ENRICHED rows and for rows whose
 * run predates the field, so callers can fall back to their existing per-criterion reasons.
 */
export function notOptionAssessedLabel(state: unknown, chainBudget: number): string | null {
  switch (state) {
    case "NOT_ENRICHED_BUDGET":
      return `Options not checked — outside top-${chainBudget} enrichment budget`;
    case "NOT_ENRICHED_STOCK_FILTER":
      return "Options not checked — stock screen did not qualify";
    case "NOT_ENRICHED_DATA_UNAVAILABLE":
      return "Options not checked — stock data unavailable";
    default:
      return null;
  }
}
