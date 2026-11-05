/**
 * Turns the SEC "Company Facts" JSON (data.sec.gov/api/xbrl/companyfacts/CIK##########.json, free, no key) into the
 * normalized CompanyFacts that companyQuality.ts judges. Pure: no network, no clock reads (the evaluation date is passed
 * in), so every case is unit-testable with a small fixture.
 *
 * The one trap this exists to avoid: cash-flow statements are reported year-to-date, so quarters overlap. A naive sum of
 * "the last four numbers" double counts. The trailing twelve months here is built the standard way:
 *     latest fiscal-year total + latest year-to-date - the same year-to-date one year earlier.
 * Every anchor is matched by period dates, never by array position, and anything that cannot be matched cleanly is
 * returned as null (which the evaluator turns into VERIFY) rather than guessed.
 */
import type { CompanyFacts } from "./companyQuality";

type RawFact = { start?: string; end: string; val: number; form?: string; filed?: string };
type FactsJson = { facts?: Record<string, Record<string, { units?: Record<string, RawFact[]> }>> };

const DAY_MS = 86_400_000;
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const daysBetween = (from: string, to: string) => Math.round((day(to) - day(from)) / DAY_MS);

function series(json: FactsJson, taxonomy: string, concepts: readonly string[], unit: string): RawFact[] {
  for (const concept of concepts) {
    const rows = json.facts?.[taxonomy]?.[concept]?.units?.[unit];
    if (Array.isArray(rows) && rows.length) {
      return rows.filter((row) => row && typeof row.val === "number" && Number.isFinite(row.val) && typeof row.end === "string");
    }
  }
  return [];
}

/** One row per period: if a period was reported more than once (restated), the most recently filed one wins. */
function latestFiledPerPeriod(rows: RawFact[]): RawFact[] {
  const byPeriod = new Map<string, RawFact>();
  for (const row of rows) {
    const key = `${row.start ?? ""}|${row.end}`;
    const existing = byPeriod.get(key);
    if (!existing || (row.filed ?? "") >= (existing.filed ?? "")) byPeriod.set(key, row);
  }
  return [...byPeriod.values()];
}

type Flow = RawFact & { start: string; days: number };

function flows(rows: RawFact[]): Flow[] {
  return latestFiledPerPeriod(rows.filter((row) => typeof row.start === "string")).map((row) => ({ ...row, start: row.start as string, days: daysBetween(row.start as string, row.end) }));
}

const isAnnual = (flow: Flow) => flow.days >= 350 && flow.days <= 380;
const isYtd = (flow: Flow) => flow.days >= 80 && flow.days <= 290;
const within = (value: number, target: number, tolerance: number) => Math.abs(value - target) <= tolerance;

/** Trailing twelve months of a flow concept, plus (when derivable) the last two quarters combined. */
export function trailingTwelveMonths(rows: RawFact[]): { ttm: number | null; last2Q: number | null; latestEnd: string | null } {
  const all = flows(rows);
  const annuals = all.filter(isAnnual).sort((a, b) => (a.end < b.end ? 1 : -1));
  const annual = annuals[0];
  if (!annual) return { ttm: null, last2Q: null, latestEnd: null };

  // Year-to-date periods that start right after that fiscal year ended.
  const ytds = all
    .filter((flow) => isYtd(flow) && flow.end > annual.end && within(daysBetween(annual.end, flow.start), 1, 6))
    .sort((a, b) => (a.end < b.end ? 1 : -1));
  const ytd = ytds[0];
  if (!ytd) return { ttm: annual.val, last2Q: null, latestEnd: annual.end };

  // The same year-to-date window one year earlier (start and end both about 365 days before).
  const prior = all.find(
    (flow) => isYtd(flow) && within(daysBetween(flow.start, ytd.start), 365, 7) && within(daysBetween(flow.end, ytd.end), 365, 7),
  );
  if (!prior) return { ttm: null, last2Q: null, latestEnd: ytd.end };

  // Only a six-month year-to-date figure IS the last two quarters. After one quarter or three quarters the two-quarter
  // figure cannot be derived from year-to-date data alone, so it stays null (the evaluator then relies on the TTM).
  const last2Q = within(ytd.days, 181, 12) ? ytd.val : null;
  return { ttm: annual.val + ytd.val - prior.val, last2Q, latestEnd: ytd.end };
}

function latestInstant(rows: RawFact[]): { value: number; end: string } | null {
  const instants = latestFiledPerPeriod(rows.filter((row) => !row.start)).sort((a, b) => (a.end < b.end ? 1 : -1));
  return instants[0] ? { value: instants[0].val, end: instants[0].end } : null;
}

function instantNear(rows: RawFact[], targetEnd: string, toleranceDays: number): number | null {
  const candidates = latestFiledPerPeriod(rows.filter((row) => !row.start))
    .map((row) => ({ row, gap: Math.abs(daysBetween(row.end, targetEnd)) }))
    .filter((entry) => entry.gap <= toleranceDays)
    .sort((a, b) => a.gap - b.gap);
  return candidates[0]?.row.val ?? null;
}

const CONCEPTS = {
  ocf: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
  capex: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets", "PaymentsForCapitalImprovements"],
  cash: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
  shortInvestments: ["ShortTermInvestments", "MarketableSecuritiesCurrent", "AvailableForSaleSecuritiesDebtSecuritiesCurrent"],
  debtCurrent: ["DebtCurrent", "LongTermDebtCurrent", "ShortTermBorrowings", "ConvertibleNotesPayableCurrent"],
  equity: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  currentAssets: ["AssetsCurrent"],
  currentLiabilities: ["LiabilitiesCurrent"],
} as const;

export function parseCompanyFacts(json: unknown, options: { now: Date; sic?: number | null }): CompanyFacts {
  const data = (json ?? {}) as FactsJson;
  const ocf = trailingTwelveMonths(series(data, "us-gaap", CONCEPTS.ocf, "USD"));
  const capexRows = series(data, "us-gaap", CONCEPTS.capex, "USD");
  const capex = capexRows.length ? trailingTwelveMonths(capexRows) : { ttm: null, last2Q: null, latestEnd: null };

  const cash = latestInstant(series(data, "us-gaap", CONCEPTS.cash, "USD"));
  const balanceEnd = cash?.end ?? null;
  const near = (concepts: readonly string[]) => (balanceEnd ? instantNear(series(data, "us-gaap", concepts, "USD"), balanceEnd, 10) : null);

  // Shares outstanding: the filing cover-page figure, now versus about a year earlier.
  const shareRows = latestFiledPerPeriod(series(data, "dei", ["EntityCommonStockSharesOutstanding"], "shares").filter((row) => !row.start)).sort((a, b) => (a.end < b.end ? 1 : -1));
  const sharesNowRow = shareRows[0];
  const sharesYearAgo = sharesNowRow
    ? shareRows.find((row) => within(daysBetween(row.end, sharesNowRow.end), 365, 45))?.val ?? null
    : null;

  const latestEnd = [ocf.latestEnd, balanceEnd].filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
  const dataAgeDays = latestEnd ? Math.round((options.now.getTime() - day(latestEnd)) / DAY_MS) : null;

  return {
    sic: options.sic ?? null,
    dataAgeDays,
    ocfTtm: ocf.ttm,
    capexTtm: capex.ttm,
    ocfLast2Q: ocf.last2Q,
    capexLast2Q: capex.last2Q,
    cash: cash?.value ?? null,
    liquidInvestments: near(CONCEPTS.shortInvestments),
    debtDue12m: near(CONCEPTS.debtCurrent),
    equity: near(CONCEPTS.equity),
    currentAssets: near(CONCEPTS.currentAssets),
    currentLiabilities: near(CONCEPTS.currentLiabilities),
    sharesNow: sharesNowRow?.val ?? null,
    sharesYearAgo,
    goingConcernDoubt: null,
  };
}
