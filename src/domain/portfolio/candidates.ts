import type { EthicsGateValue, PlanCandidate } from "./portfolioPlan";
import { themeForTicker } from "./themes";

/** The slice of a Scanner row the plan needs (kept structural so this module stays free of page/server imports). */
export type ScannerRowForPlan = {
  ticker: string;
  readiness: string;
  gatingClear: boolean;
  score: number;
  values: {
    strike: number | null;
    expiration: string | null;
    dte: number | null;
    bidProceedsPerContract: number | null;
    ror: number | null;
    earningsVerifyReason: string | null;
  };
};

export type CompanyClassification = { companyName?: string | null; sector: string | null; industry: string | null };

/**
 * One plan candidate per PASS or NEAR row. Rows that are not actionable (FAIL / NEEDS_DATA) never enter the plan.
 * A company with no ethics research is "UNREVIEWED" - shown, but never recommended.
 */
export function buildPlanCandidates(
  rows: ScannerRowForPlan[],
  ethicsGateByTicker: Record<string, EthicsGateValue | undefined>,
  classificationByTicker: Record<string, CompanyClassification | undefined>,
  qualityByTicker: Record<string, { eligible: boolean; reason: string } | null | undefined> = {},
): PlanCandidate[] {
  return rows.flatMap((row) => {
    if (row.readiness !== "PASS" && row.readiness !== "NEAR") return [];
    const classification = classificationByTicker[row.ticker];
    return [{
      ticker: row.ticker,
      companyName: classification?.companyName ?? null,
      readiness: row.readiness,
      gatingClear: row.gatingClear,
      score: row.score,
      strike: row.values.strike,
      expiration: row.values.expiration,
      dte: row.values.dte,
      bidProceedsPerContract: row.values.bidProceedsPerContract,
      returnPct: row.values.ror,
      sector: classification?.sector ?? null,
      industry: classification?.industry ?? null,
      theme: themeForTicker(row.ticker),
      ethics: ethicsGateByTicker[row.ticker] ?? "UNREVIEWED",
      earningsVerifyReason: row.values.earningsVerifyReason,
      quality: qualityByTicker[row.ticker] ?? null,
    }];
  });
}
