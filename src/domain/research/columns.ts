/**
 * The Research table's configurable-column registry. Shared by the server (to validate a
 * saved preference before persisting it) and the client (to render the table + Columns
 * menu), so both always agree on the set of valid keys - see PROJECT_HANDOFF.md Research
 * section. Status and Ticker are not in this list: they're always shown and pinned, not
 * part of any user's configurable set.
 */
export type ResearchColumnGroup = "CORE" | "TECHNICAL" | "FUNDAMENTALS" | "EXTERNAL" | "PERSONAL" | "HISTORY";

export type ResearchColumnDefinition = {
  key: string;
  label: string;
  group: ResearchColumnGroup;
};

export const RESEARCH_COLUMN_GROUP_LABELS: Record<ResearchColumnGroup, string> = {
  CORE: "Core",
  TECHNICAL: "Technical",
  FUNDAMENTALS: "Fundamentals",
  EXTERNAL: "External Research",
  PERSONAL: "Personal",
  HISTORY: "History",
};

export const RESEARCH_COLUMN_DEFINITIONS: ResearchColumnDefinition[] = [
  { key: "company", label: "Company", group: "CORE" },
  { key: "currentPrice", label: "Current Price", group: "CORE" },
  { key: "industry", label: "Industry / What", group: "CORE" },
  { key: "scanner", label: "Scanner", group: "TECHNICAL" },
  { key: "rsiBb", label: "RSI / BB", group: "TECHNICAL" },
  { key: "schwabRating", label: "Schwab Rating", group: "EXTERNAL" },
  { key: "lsegRecommendation", label: "LSEG Recommendation", group: "EXTERNAL" },
  { key: "lsegRating", label: "LSEG Rating", group: "EXTERNAL" },
  { key: "lsegTarget", label: "LSEG Target Price", group: "EXTERNAL" },
  { key: "debtToEquity", label: "Debt / Equity", group: "FUNDAMENTALS" },
  { key: "currentRatio", label: "Current Ratio", group: "FUNDAMENTALS" },
  { key: "peRatio", label: "P/E", group: "FUNDAMENTALS" },
  { key: "pegRatio", label: "PEG", group: "FUNDAMENTALS" },
  { key: "dividend", label: "Dividend", group: "FUNDAMENTALS" },
  { key: "profitability", label: "Profitability", group: "FUNDAMENTALS" },
  { key: "wouldOwn", label: "Would Own", group: "PERSONAL" },
  { key: "monthlyOnly", label: "Monthly Only", group: "PERSONAL" },
  { key: "rollFriendliness", label: "Roll Friendliness", group: "PERSONAL" },
  { key: "notes", label: "Notes", group: "PERSONAL" },
  { key: "campaignHistory", label: "Trade History", group: "HISTORY" },
];

export const RESEARCH_COLUMN_KEYS = new Set(RESEARCH_COLUMN_DEFINITIONS.map((definition) => definition.key));

export function isResearchColumnKey(value: unknown): value is string {
  return typeof value === "string" && RESEARCH_COLUMN_KEYS.has(value);
}

/** Matt's (and every other never-customized user's) unchanged default - identical to what
 * the Research table has always shown before per-user column preferences existed. */
export const DEFAULT_RESEARCH_COLUMNS: string[] = ["company", "scanner", "currentPrice", "rsiBb"];

/**
 * A research-heavy column preset available for one-time initialization of any user's saved
 * layout via `scripts/init-research-columns.ts` (generic - takes a target email as a CLI
 * argument, has no built-in notion of which real person that is). Shows every fundamentals/
 * external-research/personal field the Research table supports rather than a trimmed
 * subset: the task this preset was designed for named these fields specifically, horizontal
 * scroll is an accepted release valve for a wide table, and every column stays individually
 * removable/reorderable from Columns by whoever it's applied to. Status and Ticker are
 * always shown ahead of this list and are not repeated here.
 */
export const RESEARCH_HEAVY_COLUMN_PRESET: string[] = [
  "company",
  "currentPrice",
  "industry",
  "schwabRating",
  "lsegRecommendation",
  "lsegRating",
  "lsegTarget",
  "debtToEquity",
  "currentRatio",
  "peRatio",
  "pegRatio",
  "dividend",
  "profitability",
  "wouldOwn",
  "notes",
];

export type ResearchSortKey = "added" | "ticker" | "score" | "price";
export const RESEARCH_SORT_KEYS = new Set<ResearchSortKey>(["added", "ticker", "score", "price"]);

export function isResearchSortKey(value: unknown): value is ResearchSortKey {
  return typeof value === "string" && RESEARCH_SORT_KEYS.has(value as ResearchSortKey);
}

/**
 * The single place that decides auto-vs-manual precedence for an "AUTO + MANUAL FALLBACK"
 * field (P/E, PEG, debt/equity, current ratio, dividend yield/amount - see
 * PROJECT_HANDOFF.md Research section). A verified auto value always wins when present;
 * the manual value is only ever shown as a fallback, never silently overwritten by it.
 */
export function resolveAutoOrManual<T>(auto: T | null | undefined, manual: T | null | undefined): T | null {
  return auto ?? manual ?? null;
}

/** Dedupes and drops unknown keys while preserving order - order IS the column order. */
export function sanitizeResearchColumns(columns: unknown): string[] {
  if (!Array.isArray(columns)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of columns) {
    if (isResearchColumnKey(value) && !seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}
