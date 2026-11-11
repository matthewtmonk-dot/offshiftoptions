/**
 * Portfolio-aware trade planning (pure, deterministic - no server imports, so the browser's what-if clicks and the
 * server-side "Suggest allocation" run the very same rules).
 *
 * Principles (agreed with Matt):
 *  - Recommendations only; the app never places orders.
 *  - Hard safety rules are pass/fail, never traded off against premium: ethics, earnings/scanner gates, per-company
 *    limit, total-committed ceiling, one position per theme, cash actually available.
 *  - Quality first. Premium is only a tiebreaker. Idle cash is fine: nothing is added just to use money.
 *  - Capital base is Schwab's own available-to-trade figure. Schwab already holds back the collateral of open puts,
 *    so existing put collateral is NEVER subtracted from it again - it only counts toward the exposure limits.
 */

export type PlanLimits = {
  /** Max exposure to one company (open put collateral + share cost basis + new put), % of account value. */
  maxPerCompanyPct: number;
  /**
   * ONE company at a time may exceed maxPerCompanyPct, up to this % of account value ("one larger position").
   * A value at or below maxPerCompanyPct switches the exception off. Every other hard rule (cash, total-committed
   * ceiling, theme, ethics, quality, earnings) still applies to that position.
   */
  maxLargePositionPct: number;
  /** Ceiling on total capital committed (existing + new), % of account value. A ceiling, not a target. */
  maxCommittedPct: number;
  /** Max distinct companies in one theme (existing + new). */
  maxPerTheme: number;
  /** Warn (not block) when more than this many distinct companies share a sector. */
  warnPerSector: number;
  /** A trade whose bid-based return on collateral is below this is not eligible (a floor, not a target). */
  minReturnPct: number;
  /**
   * The per-company size limits (maxPerCompanyPct and maxLargePositionPct) only BLOCK a trade once the account is
   * worth at least this many dollars; below it they are shown as a concentration warning instead. 0 = always enforce.
   * Why: on a small account one contract is a large share of equity no matter what is picked, so a percentage cap
   * mostly decides which stock PRICES are allowed rather than adding diversification. Cash, the total-committed
   * ceiling, the theme limit and every company check (ethics, quality, earnings) are NOT affected by this.
   */
  sizeLimitsFromAccountValue: number;
};

export const DEFAULT_PLAN_LIMITS: PlanLimits = {
  // Tightened from 25 / 80 on Nov 5 2026 (Matt: yes to the Claude + ChatGPT review's provisional 20 / 60). On a roughly
  // $10k account one contract is already 10-20% of equity, so these are ceilings, not targets. Saved per-browser limits
  // (the panel's own inputs) still override these defaults.
  maxPerCompanyPct: 20,
  // Nov 11 2026 (Matt): keep scanning stocks up to $50 and allow ONE larger position. A $50 strike is $5,000 of
  // collateral, about 47% of a ~$10.7k account, so the single exception is capped at 50%. The 20% limit still governs
  // every other position, and the 60% total-committed ceiling still applies on top.
  maxLargePositionPct: 50,
  maxCommittedPct: 60,
  maxPerTheme: 1,
  warnPerSector: 2,
  minReturnPct: 0.6,
  // Nov 11 2026 (Matt: "maybe those would only start to apply when I have more money"). $25,000 is the account size at
  // which the 20% per-company limit stops excluding part of the scanner's own price range: one $50 contract is $5,000,
  // exactly 20% of $25,000. Below that the size limits warn instead of block.
  sizeLimitsFromAccountValue: 25_000,
};

/** The keys, in display order, with the bounds a saved value must sit inside. Shared by the settings form and the store. */
export const PLAN_LIMIT_FIELDS: readonly { key: keyof PlanLimits; label: string; help: string; min: number; max: number; integer: boolean }[] = [
  { key: "maxCommittedPct", label: "Most of the account in use at once (%)", help: "Put collateral plus shares held, as a share of the account. Always enforced.", min: 1, max: 100, integer: false },
  { key: "maxPerTheme", label: "Companies per theme", help: "How many companies in the same theme (for example miners) may be held together. Always enforced.", min: 1, max: 20, integer: true },
  { key: "warnPerSector", label: "Warn above this many per sector", help: "A warning only - never blocks a pick.", min: 1, max: 20, integer: true },
  { key: "minReturnPct", label: "Minimum return per trade (%)", help: "A trade paying less than this on its collateral is not offered.", min: 0, max: 20, integer: false },
  { key: "maxPerCompanyPct", label: "Normal limit per company (%)", help: "Size limit. Applies only once the account reaches the amount below.", min: 1, max: 100, integer: false },
  { key: "maxLargePositionPct", label: "One larger position, up to (%)", help: "Size limit. One company at a time may go above the normal limit, up to this. Applies only once the account reaches the amount below.", min: 1, max: 100, integer: false },
  { key: "sizeLimitsFromAccountValue", label: "Size limits start when the account reaches ($)", help: "Below this the two size limits above only warn. Enter 0 to always enforce them.", min: 0, max: 100_000_000, integer: true },
];

/** Fills any missing / invalid field from the defaults and clamps each value to its allowed range. Never throws. */
export function sanitizePlanLimits(value: Partial<Record<keyof PlanLimits, unknown>> | null | undefined): PlanLimits {
  const result = { ...DEFAULT_PLAN_LIMITS };
  for (const field of PLAN_LIMIT_FIELDS) {
    const raw = value?.[field.key];
    const parsed = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
    if (!Number.isFinite(parsed)) continue;
    const clamped = Math.min(field.max, Math.max(field.min, parsed));
    result[field.key] = field.integer ? Math.round(clamped) : clamped;
  }
  return result;
}

/** True when the per-company size limits block trades for an account of this value (see sizeLimitsFromAccountValue). */
export function sizeLimitsApply(accountValue: number | null, limits: PlanLimits): boolean {
  return accountValue !== null && accountValue >= limits.sizeLimitsFromAccountValue;
}

const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export type EthicsGateValue = "OK" | "REVIEW" | "BLOCKED" | "UNREVIEWED";

export type PlanCandidate = {
  ticker: string;
  companyName: string | null;
  readiness: "PASS" | "NEAR";
  /** Every enabled hard scanner rule (including earnings) is a definite PASS. */
  gatingClear: boolean;
  /** Scanner setup score, 0-100. */
  score: number;
  strike: number | null;
  expiration: string | null;
  dte: number | null;
  /** Bid x 100: what a seller receives per contract at the current bid. */
  bidProceedsPerContract: number | null;
  /** Bid-based return on collateral for this contract, percent. */
  returnPct: number | null;
  sector: string | null;
  industry: string | null;
  /** Hand-maintained theme tag, falling back to the industry (see themeKeyOf). */
  theme: string | null;
  ethics: EthicsGateValue;
  earningsVerifyReason: string | null;
  /**
   * Company-quality verdict (see scanner/qualityGate.ts). undefined / null = the check is not set up, so nothing is gated.
   * When present and not eligible, the candidate is excluded from automatic picks and the reason is shown.
   */
  quality?: { eligible: boolean; reason: string } | null;
};

/** Existing exposure by company. `amount` is open put collateral, or share cost basis for assigned shares. */
export type ExistingExposure = {
  ticker: string;
  kind: "PUT" | "SHARES";
  amount: number;
  theme: string | null;
  sector: string | null;
};

export type PlanCapital = {
  /** Total account value (liquidation value). */
  accountValue: number;
  /** Schwab's cash available for trading (already net of open-put collateral). */
  availableToTrade: number;
};

export type PlanViolation = { code: "CASH" | "COMMITTED" | "COMPANY" | "THEME"; message: string };

export type PlanEvaluation = {
  newCollateral: number;
  newPremium: number;
  cashRemaining: number;
  committedBefore: number;
  committedAfter: number;
  committedAfterPct: number;
  /** Total exposure per company after the selection, as % of account value. */
  companyPct: Record<string, number>;
  violations: PlanViolation[];
  warnings: string[];
  valid: boolean;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

export function collateralOf(candidate: Pick<PlanCandidate, "strike">): number | null {
  return candidate.strike === null || !Number.isFinite(candidate.strike) ? null : round2(candidate.strike * 100);
}

/** Theme tag, else industry, else sector: the broadest key that still groups look-alike companies. */
export function themeKeyOf(input: { theme: string | null; industry: string | null; sector: string | null }): string | null {
  return input.theme ?? input.industry ?? input.sector ?? null;
}

/** Why a candidate cannot be part of a recommendation (empty = eligible). Shown to Matt, never hidden. */
export function candidateBlockers(candidate: PlanCandidate, limits: PlanLimits): string[] {
  const blockers: string[] = [];
  if (candidate.ethics === "BLOCKED") blockers.push("Excluded by ethics");
  else if (candidate.ethics === "REVIEW") blockers.push("Ethics needs your review");
  else if (candidate.ethics === "UNREVIEWED") blockers.push("Ethics not researched yet");
  if (!candidate.gatingClear) blockers.push("A required scanner rule is not a clear pass");
  if (candidate.quality && !candidate.quality.eligible) blockers.push(candidate.quality.reason);
  if (candidate.earningsVerifyReason) blockers.push("Earnings date needs checking");
  if (collateralOf(candidate) === null) blockers.push("No strike");
  if (candidate.bidProceedsPerContract === null || candidate.bidProceedsPerContract <= 0) blockers.push("No bid to sell into");
  if (candidate.returnPct === null) blockers.push("Return could not be calculated");
  else if (candidate.returnPct < limits.minReturnPct) blockers.push(`Return ${candidate.returnPct.toFixed(2)}% is below your ${limits.minReturnPct}% floor`);
  return blockers;
}

/** Above this weekly-equivalent return a premium is a risk signal (a volatile or struggling company), not a bargain. */
export const RICH_PREMIUM_WEEKLY_PCT = 2;

/**
 * Cautions shown on a trade that is otherwise eligible. They never block or re-rank anything - they tell Matt what to
 * look at before he places it.
 */
export function pickFlags(candidate: Pick<PlanCandidate, "returnPct" | "dte" | "readiness">): string[] {
  const flags: string[] = [];
  if (candidate.returnPct !== null && candidate.dte !== null && candidate.dte > 0) {
    const weekly = (candidate.returnPct / candidate.dte) * 7;
    if (weekly > RICH_PREMIUM_WEEKLY_PCT) {
      flags.push(`Rich premium (about ${weekly.toFixed(1)}% a week) - the market sees real risk here; read the company check before selling`);
    }
  }
  if (candidate.readiness === "NEAR") flags.push("A preference rule (RSI, Bollinger or return) is just outside your target");
  return flags;
}

/**
 * Checks any set of new one-contract puts against the cash and the limits. Existing exposure counts toward the
 * limits only; cash is checked against Schwab's available figure, which already excludes existing put collateral.
 */
export function evaluatePlan(selected: PlanCandidate[], existing: ExistingExposure[], capital: PlanCapital, limits: PlanLimits): PlanEvaluation {
  const newCollateral = round2(selected.reduce((sum, candidate) => sum + (collateralOf(candidate) ?? 0), 0));
  const newPremium = round2(selected.reduce((sum, candidate) => sum + (candidate.bidProceedsPerContract ?? 0), 0));
  const committedBefore = round2(existing.reduce((sum, row) => sum + row.amount, 0));
  const committedAfter = round2(committedBefore + newCollateral);
  const account = capital.accountValue > 0 ? capital.accountValue : 0;
  const pct = (amount: number) => (account > 0 ? round2((amount / account) * 100) : Number.POSITIVE_INFINITY);

  const violations: PlanViolation[] = [];
  const warnings: string[] = [];

  const cashRemaining = round2(capital.availableToTrade - newCollateral);
  if (cashRemaining < 0) violations.push({ code: "CASH", message: `Needs $${newCollateral.toLocaleString("en-US")} but only $${capital.availableToTrade.toLocaleString("en-US")} is available to trade.` });

  const committedAfterPct = pct(committedAfter);
  if (committedAfterPct > limits.maxCommittedPct) violations.push({ code: "COMMITTED", message: `Total committed would be ${committedAfterPct.toFixed(1)}% of the account (ceiling ${limits.maxCommittedPct}%).` });

  const exposureByTicker = new Map<string, number>();
  for (const row of existing) exposureByTicker.set(row.ticker, (exposureByTicker.get(row.ticker) ?? 0) + row.amount);
  for (const candidate of selected) exposureByTicker.set(candidate.ticker, (exposureByTicker.get(candidate.ticker) ?? 0) + (collateralOf(candidate) ?? 0));
  const companyPct: Record<string, number> = {};
  for (const [ticker, amount] of exposureByTicker) companyPct[ticker] = pct(amount);
  // Per-company size: everything at or under maxPerCompanyPct is fine; ONE company may sit above it, up to
  // maxLargePositionPct. A company above the larger cap, or a second company above the normal limit, is a violation -
  // but only once the account is big enough for the size limits to apply (sizeLimitsFromAccountValue); below that the
  // same situations are reported as concentration warnings and never block.
  const enforceSize = sizeLimitsApply(capital.accountValue, limits);
  const largeCap = Math.max(limits.maxLargePositionPct, limits.maxPerCompanyPct);
  const overNormal = Object.entries(companyPct)
    .filter(([, value]) => value > limits.maxPerCompanyPct)
    .sort(([left], [right]) => left.localeCompare(right));
  const selectedTickers = new Set(selected.map((candidate) => candidate.ticker));
  if (!enforceSize) {
    for (const [ticker, value] of overNormal) {
      if (!selectedTickers.has(ticker)) continue;
      warnings.push(`${ticker} would be ${value.toFixed(1)}% of the account. A 20% drop in it alone is about ${(value * 0.2).toFixed(1)}% of the account. (Per-company size limits start at ${usd0.format(limits.sizeLimitsFromAccountValue)}.)`);
    }
  } else {
    for (const [ticker, value] of overNormal) {
      if (value > largeCap) {
        violations.push({ code: "COMPANY", message: `${ticker} would be ${value.toFixed(1)}% of the account (limit ${largeCap}%${largeCap > limits.maxPerCompanyPct ? " for the one larger position" : ""}).` });
      }
    }
    const usingLargeSlot = overNormal.filter(([, value]) => value <= largeCap);
    if (usingLargeSlot.length > 1) {
      violations.push({
        code: "COMPANY",
        message: `Only one position may be above ${limits.maxPerCompanyPct}% of the account; this would make ${usingLargeSlot.length}: ${usingLargeSlot.map(([ticker, value]) => `${ticker} (${value.toFixed(1)}%)`).join(", ")}.`,
      });
    } else if (usingLargeSlot.length === 1 && selectedTickers.has(usingLargeSlot[0][0])) {
      const [ticker, value] = usingLargeSlot[0];
      warnings.push(`${ticker} would be ${value.toFixed(1)}% of the account - your one larger position (normal limit ${limits.maxPerCompanyPct}%). A 20% drop in it alone is about ${(value * 0.2).toFixed(1)}% of the account.`);
    }
  }

  // Distinct companies per theme / sector across what is already held and what is being added.
  const themeMembers = new Map<string, Set<string>>();
  const sectorMembers = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string | null, ticker: string) => {
    if (!key) return;
    const members = map.get(key) ?? new Set<string>();
    members.add(ticker);
    map.set(key, members);
  };
  for (const row of existing) {
    add(themeMembers, row.theme, row.ticker);
    add(sectorMembers, row.sector, row.ticker);
  }
  for (const candidate of selected) {
    add(themeMembers, themeKeyOf(candidate), candidate.ticker);
    add(sectorMembers, candidate.sector, candidate.ticker);
  }
  for (const [theme, members] of themeMembers) {
    if (members.size > limits.maxPerTheme && [...members].some((ticker) => selectedTickers.has(ticker))) {
      violations.push({ code: "THEME", message: `Theme "${theme}" would hold ${members.size} companies (${[...members].sort().join(", ")}); limit is ${limits.maxPerTheme}.` });
    }
  }
  for (const [sector, members] of sectorMembers) {
    if (members.size > limits.warnPerSector && [...members].some((ticker) => selectedTickers.has(ticker))) {
      warnings.push(`${members.size} companies in ${sector}: ${[...members].sort().join(", ")}.`);
    }
  }
  for (const candidate of selected) {
    if (themeKeyOf(candidate) === null) warnings.push(`${candidate.ticker} has no sector, industry or theme on file, so the diversification checks cannot see it.`);
  }

  return { newCollateral, newPremium, cashRemaining, committedBefore, committedAfter, committedAfterPct, companyPct, violations, warnings, valid: violations.length === 0 };
}

/** Whether adding `candidate` to the current selection would still pass every hard rule, and if not, why. */
export function canAdd(candidate: PlanCandidate, selected: PlanCandidate[], existing: ExistingExposure[], capital: PlanCapital, limits: PlanLimits): { ok: true } | { ok: false; reasons: string[] } {
  const blockers = candidateBlockers(candidate, limits);
  if (blockers.length) return { ok: false, reasons: blockers };
  const evaluation = evaluatePlan([...selected, candidate], existing, capital, limits);
  return evaluation.valid ? { ok: true } : { ok: false, reasons: evaluation.violations.map((violation) => violation.message) };
}

export const OPTIMIZER_MAX_CANDIDATES = 14;
export const OPTIMIZER_MAX_TRADES = 4;
/** How many trades that need the one larger-position slot stay in the optimizer's search (only one can be picked). */
export const OPTIMIZER_MAX_LARGE_CANDIDATES = 3;

/** What a candidate is worth to the optimizer: quality only. A NEAR trade counts for less than a PASS. */
function qualityOf(candidate: PlanCandidate): number {
  return candidate.readiness === "PASS" ? 100 + candidate.score : candidate.score;
}

export type OptimizeResult = { picks: PlanCandidate[]; evaluation: PlanEvaluation; considered: number };

/**
 * "Suggest allocation": tries every combination of up to OPTIMIZER_MAX_TRADES eligible trades (from the best
 * OPTIMIZER_MAX_CANDIDATES), keeps only combinations that satisfy every hard rule, and picks the best by quality,
 * then premium, then the smaller commitment. Nothing is added merely to use cash: only eligible trades are in play.
 */
export function optimizePlan(candidates: PlanCandidate[], existing: ExistingExposure[], capital: PlanCapital, limits: PlanLimits): OptimizeResult {
  const pool = candidates
    .filter((candidate) => candidateBlockers(candidate, limits).length === 0)
    // Drop trades that cannot fit even on their own (e.g. one contract is bigger than the per-company limit) BEFORE the
    // top-N cut, so unaffordable high scorers never crowd affordable trades out of the search.
    .filter((candidate) => evaluatePlan([candidate], existing, capital, limits).valid)
    // One contract per company: two strikes on the same company would double its exposure for no diversification.
    .sort((left, right) => qualityOf(right) - qualityOf(left) || (right.returnPct ?? 0) - (left.returnPct ?? 0) || left.ticker.localeCompare(right.ticker))
    .filter((candidate, index, all) => all.findIndex((other) => other.ticker === candidate.ticker) === index)
    // Only ONE trade can ever use the larger-position exception, so keep just the best few that need it. Otherwise a
    // week full of high-scoring $40-50 names fills the whole top-N cut and no normal-size trade is even considered.
    .filter(
      (() => {
        let largeKept = 0;
        return (candidate: PlanCandidate) => {
          const pctAlone = evaluatePlan([candidate], existing, capital, limits).companyPct[candidate.ticker] ?? 0;
          if (pctAlone <= limits.maxPerCompanyPct) return true;
          largeKept += 1;
          return largeKept <= OPTIMIZER_MAX_LARGE_CANDIDATES;
        };
      })(),
    )
    .slice(0, OPTIMIZER_MAX_CANDIDATES);

  let best: { picks: PlanCandidate[]; quality: number; premium: number; committed: number } | null = null;
  let considered = 0;

  const consider = (picks: PlanCandidate[]) => {
    considered += 1;
    const evaluation = evaluatePlan(picks, existing, capital, limits);
    if (!evaluation.valid) return;
    const quality = picks.reduce((sum, candidate) => sum + qualityOf(candidate), 0);
    const candidateBest = { picks: [...picks], quality, premium: evaluation.newPremium, committed: evaluation.newCollateral };
    if (
      !best ||
      quality > best.quality ||
      (quality === best.quality && evaluation.newPremium > best.premium) ||
      (quality === best.quality && evaluation.newPremium === best.premium && evaluation.newCollateral < best.committed)
    ) {
      best = candidateBest;
    }
  };

  const walk = (start: number, picks: PlanCandidate[]) => {
    if (picks.length > 0) consider(picks);
    if (picks.length >= OPTIMIZER_MAX_TRADES) return;
    for (let index = start; index < pool.length; index += 1) {
      picks.push(pool[index]);
      // A prefix that already breaks a hard rule cannot be repaired by adding more trades.
      if (evaluatePlan(picks, existing, capital, limits).valid) walk(index + 1, picks);
      picks.pop();
    }
  };
  walk(0, []);

  const picks = (best as { picks: PlanCandidate[] } | null)?.picks ?? [];
  return { picks, evaluation: evaluatePlan(picks, existing, capital, limits), considered };
}
