import "server-only";
import { buildPlanCandidates, type ScannerRowForPlan } from "@/domain/portfolio/candidates";
import { pickHoldBackReasons } from "@/domain/portfolio/pickHoldBacks";
import { getCompanyQualityForUser } from "@/lib/company-quality";
import { getEthicsSummariesForUser } from "@/lib/ethics";
import { getPlanLimitsForUser } from "@/lib/plan-limits";
import { getClassificationForTickers } from "@/lib/portfolio-plan";

/**
 * For the Dashboard's scan preview: why each PASS/NEAR name would be held back from the Scanner's picks (ethics,
 * company quality, earnings date, a required rule, one contract bigger than the per-company limit).
 *
 * Reads the same ethics / company-quality / classification data, and builds candidates with the same
 * `buildPlanCandidates`, as the Scanner page's own loadPlanData - so the two pages cannot describe the same saved
 * scan differently. Read-only, owner-scoped, no provider call.
 *
 * Limits: the user's own saved portfolio limits (lib/plan-limits.ts) - the same ones the Scanner's picks panel uses.
 *
 * Fails soft: returns null (the Dashboard then shows the plain technical result with a "check Scanner" note) instead of
 * taking the Dashboard down.
 */
export async function getScannerInsightHoldBacksForUser(userId: string, rows: ScannerRowForPlan[], accountValue: number | null): Promise<Record<string, string[]> | null> {
  if (rows.length === 0) return {};
  try {
    const tickers = rows.map((row) => row.ticker);
    const [limits, ethics, quality, classification] = await Promise.all([
      getPlanLimitsForUser(userId),
      getEthicsSummariesForUser(userId, tickers),
      getCompanyQualityForUser(userId, tickers).catch(() => ({ configured: false, secReady: false, byTicker: {} })),
      getClassificationForTickers(tickers),
    ]);
    const gates = Object.fromEntries([...ethics].map(([ticker, summary]) => [ticker, summary.gate]));
    const qualityGates = quality.configured
      ? Object.fromEntries(Object.entries(quality.byTicker).map(([ticker, view]) => [ticker, view.gate ? { eligible: view.gate.eligible, reason: view.gate.reason } : null]))
      : {};
    const candidates = buildPlanCandidates(rows, gates, classification, qualityGates);
    return Object.fromEntries(candidates.map((candidate) => [candidate.ticker, pickHoldBackReasons(candidate, limits, accountValue)]));
  } catch (error) {
    console.warn("Scanner insight hold-backs unavailable:", error instanceof Error ? error.name : "unknown error");
    return null;
  }
}
