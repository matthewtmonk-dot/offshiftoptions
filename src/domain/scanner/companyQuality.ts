/**
 * Minimum-viable "is this a financially sound company to own if assigned" check. Pure and deterministic: it takes
 * already-normalized filing facts (see secCompanyFacts.ts) and returns a tier plus plain-English reasons. It is NOT a
 * valuation, NOT a research desk, and it never says a company is a good investment - only whether it clears a minimum.
 *
 * Agreed policy (Claude + ChatGPT review, Nov 5 2026; owner approved building it):
 *  - REJECT only on clear distress: a cash-burning company whose stressed cash runway is under 4 quarters, or a confirmed
 *    substantial-doubt going-concern disclosure.
 *  - CAUTION: runway of 4 to under 8 quarters. Excluded from automatic allocation unless the owner overrides it.
 *  - VERIFY: essential facts are missing or stale, the company is a bank/insurer/REIT (these rules do not fit), or equity
 *    is negative (needs a human look - it can come from buybacks). Never an automatic PASS.
 *  - B: passes the required checks but has a caution flag (weak current ratio, heavy dilution, or burning cash with at
 *    least 8 quarters of runway).
 *  - A: positive free cash flow and no flags.
 *  Tiers describe minimum financial health only. They are not tuned on outcomes; thresholds are provisional.
 */

export type CompanyQualityTier = "A" | "B" | "CAUTION" | "VERIFY" | "REJECT";

export type CompanyFacts = {
  /** SIC code from the SEC submissions data, when known. 6000-6799 = finance, insurance, real estate. */
  sic: number | null;
  /** Days between the latest period covered by the facts and the evaluation date. */
  dataAgeDays: number | null;
  /** Trailing-twelve-month operating cash flow and capital spending (capex as a positive number). */
  ocfTtm: number | null;
  capexTtm: number | null;
  /** Last two quarters combined, when derivable (used to catch accelerating burn). */
  ocfLast2Q: number | null;
  capexLast2Q: number | null;
  cash: number | null;
  liquidInvestments: number | null;
  /** Debt due within 12 months. */
  debtDue12m: number | null;
  equity: number | null;
  currentAssets: number | null;
  currentLiabilities: number | null;
  /** Shares outstanding now and about a year ago (for dilution). */
  sharesNow: number | null;
  sharesYearAgo: number | null;
  /** Substantial-doubt going-concern disclosure. null = not checked (it is not in the structured data). */
  goingConcernDoubt: boolean | null;
};

export type CompanyQuality = {
  tier: CompanyQualityTier;
  reasons: string[];
  /** Quarters of stressed runway for a cash-burning company; null when not burning cash or not computable. */
  runwayQuarters: number | null;
  /** Free cash flow over the trailing twelve months, when computable. */
  fcfTtm: number | null;
  /** Only A and B may flow into automatic allocation. */
  eligibleForAutomaticPass: boolean;
};

export const QUALITY_THRESHOLDS = {
  /** Facts older than this are stale: VERIFY, not a pass. */
  maxDataAgeDays: 460,
  rejectRunwayQuarters: 4,
  cautionRunwayQuarters: 8,
  minCurrentRatio: 1.2,
  /** Share count growth over a year above this is flagged (not rejected). */
  dilutionFlagPct: 10,
} as const;

const isNum = (value: number | null): value is number => typeof value === "number" && Number.isFinite(value);

function result(tier: CompanyQualityTier, reasons: string[], extra: { runwayQuarters?: number | null; fcfTtm?: number | null } = {}): CompanyQuality {
  return { tier, reasons, runwayQuarters: extra.runwayQuarters ?? null, fcfTtm: extra.fcfTtm ?? null, eligibleForAutomaticPass: tier === "A" || tier === "B" };
}

export function evaluateCompanyQuality(facts: CompanyFacts): CompanyQuality {
  const t = QUALITY_THRESHOLDS;
  const reasons: string[] = [];

  if (isNum(facts.sic) && facts.sic >= 6000 && facts.sic <= 6799) {
    return result("VERIFY", ["Bank, insurer, or real-estate company: these cash-flow and debt rules do not fit, so it needs a manual look."]);
  }
  if (facts.goingConcernDoubt === true) {
    return result("REJECT", ["Filing discloses substantial doubt about the company's ability to continue as a going concern."]);
  }

  if (!isNum(facts.ocfTtm) || !isNum(facts.cash) || !isNum(facts.equity)) {
    return result("VERIFY", ["Essential filing data is missing (operating cash flow, cash, or equity), so quality cannot be judged automatically."]);
  }
  if (!isNum(facts.dataAgeDays) || facts.dataAgeDays > t.maxDataAgeDays) {
    return result("VERIFY", ["The latest filing data is more than about 15 months old or has no date, so it may not reflect the company today."]);
  }

  const capexTtm = isNum(facts.capexTtm) ? Math.abs(facts.capexTtm) : null;
  const fcfTtm = facts.ocfTtm - (capexTtm ?? 0);
  if (capexTtm === null) reasons.push("Capital spending was not found in the filing, so free cash flow is treated as operating cash flow.");
  if (facts.equity < 0) {
    return result("VERIFY", ["Shareholders' equity is negative. That can come from buybacks, so it needs a human look rather than an automatic call."], { fcfTtm });
  }

  const last2Q =
    isNum(facts.ocfLast2Q) ? facts.ocfLast2Q - (isNum(facts.capexLast2Q) ? Math.abs(facts.capexLast2Q) : 0) : null;

  // Quarterly cash burn: the worse of the trailing-year average and the most recent two quarters (catches acceleration).
  const burnTtm = -fcfTtm / 4;
  const burnRecent = last2Q === null ? -Infinity : -last2Q / 2;
  const burn = Math.max(burnTtm, burnRecent, 0);

  let runwayQuarters: number | null = null;
  if (burn > 0) {
    const liquid = facts.cash + (isNum(facts.liquidInvestments) ? facts.liquidInvestments : 0) - (isNum(facts.debtDue12m) ? facts.debtDue12m : 0);
    runwayQuarters = Math.max(0, liquid) / burn;
    const rounded = Math.round(runwayQuarters * 10) / 10;
    if (runwayQuarters < t.rejectRunwayQuarters) {
      return result("REJECT", [...reasons, `Burning cash with only about ${rounded} quarters of cash left after debt due within a year (minimum ${t.rejectRunwayQuarters}).`], { runwayQuarters, fcfTtm });
    }
    if (runwayQuarters < t.cautionRunwayQuarters) {
      return result("CAUTION", [...reasons, `Burning cash with about ${rounded} quarters of runway (comfortable is ${t.cautionRunwayQuarters}+). Excluded from automatic picks unless you override it.`], { runwayQuarters, fcfTtm });
    }
    reasons.push(`Burning cash, but with about ${Math.round(runwayQuarters * 10) / 10} quarters of runway.`);
  }

  const flags: string[] = [];
  if (burn > 0) flags.push("cash-burning");
  if (isNum(facts.currentAssets) && isNum(facts.currentLiabilities) && facts.currentLiabilities > 0) {
    const ratio = facts.currentAssets / facts.currentLiabilities;
    if (ratio < t.minCurrentRatio) {
      flags.push("weak current ratio");
      reasons.push(`Current ratio ${ratio.toFixed(2)} is below ${t.minCurrentRatio}.`);
    }
  }
  if (isNum(facts.sharesNow) && isNum(facts.sharesYearAgo) && facts.sharesYearAgo > 0) {
    const growth = ((facts.sharesNow - facts.sharesYearAgo) / facts.sharesYearAgo) * 100;
    if (growth > t.dilutionFlagPct) {
      flags.push("dilution");
      reasons.push(`Share count grew ${growth.toFixed(1)}% in a year (dilution).`);
    }
  }
  reasons.push("Going-concern language is not checked automatically; read the latest annual report's risk section.");

  return result(flags.length === 0 ? "A" : "B", reasons, { runwayQuarters, fcfTtm });
}
