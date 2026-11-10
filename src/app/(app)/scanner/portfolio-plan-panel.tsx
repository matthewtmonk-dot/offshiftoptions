"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Panel } from "@/components/ui";
import {
  DEFAULT_PLAN_LIMITS,
  candidateBlockers,
  canAdd,
  collateralOf,
  evaluatePlan,
  optimizePlan,
  pickFlags,
  type ExistingExposure,
  type PlanCandidate,
  type PlanEvaluation,
  type PlanLimits,
} from "@/domain/portfolio/portfolioPlan";
import type { TradingCapital } from "@/lib/portfolio-plan";
import { getTradingCapitalAction } from "../actions";

const LIMITS_KEY = "oso.plan.limits.v1";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** "9:41 AM" in New York, so the figure's age is obvious at a glance. */
function easternTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "just now";
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(date) + " ET";
}

function readStored<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private window); the plan still works for this visit.
  }
}

function sanitizeLimits(value: Partial<PlanLimits> | null): PlanLimits {
  const pick = (candidate: unknown, fallback: number) => (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? candidate : fallback);
  return {
    maxPerCompanyPct: pick(value?.maxPerCompanyPct, DEFAULT_PLAN_LIMITS.maxPerCompanyPct),
    maxCommittedPct: pick(value?.maxCommittedPct, DEFAULT_PLAN_LIMITS.maxCommittedPct),
    maxPerTheme: Math.max(1, Math.round(pick(value?.maxPerTheme, DEFAULT_PLAN_LIMITS.maxPerTheme))),
    warnPerSector: Math.max(1, Math.round(pick(value?.warnPerSector, DEFAULT_PLAN_LIMITS.warnPerSector))),
    minReturnPct: pick(value?.minReturnPct, DEFAULT_PLAN_LIMITS.minReturnPct),
  };
}

type Props = {
  candidates: PlanCandidate[];
  existing: ExistingExposure[];
  unknownExposureCount: number;
  /** Set while the scan is still being finished (options unpriced): picks may still change. */
  scanIncompleteNote?: string | null;
  /** Set when the scan's option prices are old enough that they must be refreshed before placing a trade. */
  priceAgeNote?: string | null;
};

/**
 * "This week's picks": the suggested allocation is computed as soon as Schwab's balance arrives, so the page opens on
 * an answer instead of a button. Matt can untick/tick names to try his own mix; every hard rule still applies.
 */
export function PortfolioPlanPanel({ candidates, existing, unknownExposureCount, scanIncompleteNote = null, priceAgeNote = null }: Props) {
  const [limits, setLimits] = useState<PlanLimits>(DEFAULT_PLAN_LIMITS);
  const [capital, setCapital] = useState<TradingCapital | "loading">("loading");
  /** null = follow the planner's suggestion; an array = Matt's own selection. */
  const [manual, setManual] = useState<string[] | null>(null);
  const [showLimits, setShowLimits] = useState(false);

  // Browser-only state (saved limits) and the first Schwab read are loaded after mount; the setters run in async
  // callbacks so the server-rendered markup and the first client render always agree.
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      setLimits(sanitizeLimits(readStored<Partial<PlanLimits>>(LIMITS_KEY)));
    });
    getTradingCapitalAction()
      .then((result) => {
        if (active) setCapital(result);
      })
      .catch(() => {
        if (active) setCapital({ ok: false, message: "Could not reach Schwab. Try again." });
      });
    return () => {
      active = false;
    };
  }, []);

  async function loadCapital() {
    setCapital("loading");
    try {
      setCapital(await getTradingCapitalAction());
    } catch {
      setCapital({ ok: false, message: "Could not reach Schwab. Try again." });
    }
  }

  function updateLimit(key: keyof PlanLimits, raw: string) {
    const next = sanitizeLimits({ ...limits, [key]: Number(raw) });
    setLimits(next);
    writeStored(LIMITS_KEY, next);
    setManual(null);
  }

  const schwab = capital !== "loading" && capital.ok ? capital : null;
  const availableToTrade = schwab?.availableToTrade ?? null;
  const accountValue = schwab?.accountValue ?? null;
  const planCapital = availableToTrade !== null && accountValue !== null ? { accountValue, availableToTrade } : null;

  const { eligible, ineligible } = useMemo(() => {
    const rank = (candidate: PlanCandidate) => (candidate.readiness === "PASS" ? 100 : 0) + candidate.score;
    const sorted = [...candidates].sort((left, right) => rank(right) - rank(left) || left.ticker.localeCompare(right.ticker));
    return {
      eligible: sorted.filter((candidate) => candidateBlockers(candidate, limits).length === 0),
      ineligible: sorted.filter((candidate) => candidateBlockers(candidate, limits).length > 0),
    };
  }, [candidates, limits]);

  const suggested = useMemo(
    () => (planCapital && unknownExposureCount === 0 ? optimizePlan(candidates, existing, planCapital, limits).picks.map((candidate) => candidate.ticker) : []),
    // planCapital is rebuilt every render from the two numbers below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [candidates, existing, limits, availableToTrade, accountValue, unknownExposureCount],
  );

  const selected = manual ?? suggested;
  const byTicker = useMemo(() => new Map(candidates.map((candidate) => [candidate.ticker, candidate])), [candidates]);
  const mine = selected.map((ticker) => byTicker.get(ticker)).filter((c): c is PlanCandidate => Boolean(c));
  const mineEval: PlanEvaluation | null = planCapital ? evaluatePlan(mine, existing, planCapital, limits) : null;
  const picked = eligible.filter((candidate) => selected.includes(candidate.ticker));
  const others = eligible.filter((candidate) => !selected.includes(candidate.ticker));
  // Qualifying trades that cannot fit at all, even alone (e.g. one contract is bigger than the per-company cap).
  const tooBig = planCapital ? others.filter((candidate) => !canAdd(candidate, [], existing, planCapital, limits).ok) : [];
  const alternatives = others.filter((candidate) => !tooBig.includes(candidate));
  // Trades held back ONLY because the company's ethics are not researched yet: shown as provisional, never auto-picked.
  const ETHICS_PENDING = "Ethics not researched yet";
  const needsEthics = ineligible.filter((candidate) => {
    const blockers = candidateBlockers(candidate, limits);
    if (!blockers.includes(ETHICS_PENDING)) return false;
    if (planCapital && !evaluatePlan([candidate], existing, planCapital, limits).valid) return false;
    return blockers.every((blocker) => blocker === ETHICS_PENDING);
  });
  const leftOut = ineligible.filter((candidate) => !needsEthics.includes(candidate));
  /** Every reason, including "too big for your account", which would still apply after the other checks clear. */
  const leftOutReasons = (candidate: PlanCandidate) => {
    const reasons = candidateBlockers(candidate, limits);
    const collateral = collateralOf(candidate);
    if (planCapital && collateral !== null && evaluatePlan([candidate], existing, planCapital, limits).violations.some((violation) => violation.code === "COMPANY")) {
      reasons.push(`one contract holds ${usd0.format(collateral)} (${pct(collateral)}), over your ${limits.maxPerCompanyPct}% per-company limit`);
    }
    return reasons;
  };

  function toggle(ticker: string) {
    setManual((current) => {
      const base = current ?? suggested;
      return base.includes(ticker) ? base.filter((value) => value !== ticker) : [...base, ticker];
    });
  }

  const committedNow = existing.reduce((sum, row) => sum + row.amount, 0);
  const pct = (amount: number) => (accountValue ? `${((amount / accountValue) * 100).toFixed(1)}%` : "");

  const renderRow = (candidate: PlanCandidate, kind: "pick" | "alt" | "ethics") => {
    const isSelected = selected.includes(candidate.ticker);
    const fit = !isSelected && planCapital ? canAdd(candidate, mine, existing, planCapital, limits) : { ok: true as const };
    const collateral = collateralOf(candidate) ?? 0;
    const unavailable = kind === "ethics" || (!isSelected && (!planCapital || !fit.ok));
    const flags = pickFlags(candidate);
    return (
      <li key={candidate.ticker} className={`rounded-md border px-3 py-2 text-sm ${kind === "pick" ? (flags.length ? "border-amber-400/40 bg-zinc-900/60" : "border-emerald-400/50 bg-emerald-400/5") : kind === "ethics" ? "border-sky-400/30 bg-sky-400/5" : "border-zinc-800 bg-zinc-900/40"} ${unavailable && kind !== "ethics" ? "opacity-60" : ""}`}>
        <label className="flex cursor-pointer items-start gap-3">
          <input type="checkbox" checked={isSelected} disabled={unavailable} onChange={() => toggle(candidate.ticker)} className="mt-1 size-4" aria-label={`Include ${candidate.ticker}`} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="text-base font-semibold text-zinc-50">{candidate.ticker}</span>
              <span className="text-zinc-200">Sell 1 × ${candidate.strike} put · {shortExpiry(candidate.expiration)}{candidate.dte !== null ? ` (${candidate.dte}d)` : ""}</span>
              <span className="text-emerald-200">
                {candidate.bidProceedsPerContract === null ? "?" : usd0.format(candidate.bidProceedsPerContract)} premium · {candidate.returnPct === null ? "?" : `${candidate.returnPct.toFixed(2)}%`}
              </span>
              <span className="text-zinc-400">holds {usd0.format(collateral)}{accountValue ? ` (${pct(collateral)})` : ""}</span>
              {candidate.readiness === "NEAR" ? <span className="text-xs font-semibold text-amber-300">NEAR</span> : null}
            </div>
            <div className="mt-0.5 text-xs text-zinc-500">
              {[candidate.companyName, [candidate.sector, candidate.industry].filter(Boolean).join(" / ") || null].filter(Boolean).join(" · ")}
            </div>
            {flags.length ? <div className="mt-0.5 text-xs text-amber-300">{flags.join(" · ")}</div> : null}
            {kind === "ethics" ? (
              <div className="mt-0.5 text-xs text-sky-300">
                Company not researched for ethics yet -{" "}
                <Link href={`/research/ethics?ticker=${encodeURIComponent(candidate.ticker)}`} className="underline underline-offset-2 hover:text-sky-100">review it</Link> to make it pickable.
              </div>
            ) : unavailable && !fit.ok ? <div className="mt-0.5 text-xs text-zinc-400">Doesn&apos;t fit with the picks above: {fit.reasons.join(" ")}</div> : null}
          </div>
        </label>
      </li>
    );
  };

  return (
    <Panel
      title={priceAgeNote ? "Picks from the last scan - reconfirm" : "This week's picks"}
      action={
        <span className="flex items-center gap-3 text-xs text-zinc-500">
          <span className="hidden sm:inline">Suggestions only - you place trades in thinkorswim</span>
          <button type="button" onClick={() => setShowLimits((value) => !value)} aria-expanded={showLimits} className="underline underline-offset-2 hover:text-zinc-200">
            {showLimits ? "Hide limits" : "Limits"}
          </button>
        </span>
      }
    >
      <div className="space-y-3" data-testid="portfolio-plan">
        <p className="text-xs text-zinc-400" data-testid="plan-capital">
          {capital === "loading" ? "Reading your balance from Schwab…" : null}
          {capital !== "loading" && !capital.ok ? (
            <span className="text-red-300">
              {capital.message} <button type="button" onClick={() => void loadCapital()} className="underline underline-offset-2">Try again</button>
            </span>
          ) : null}
          {schwab ? (
            <>
              Available <strong className="text-zinc-100">{usd.format(schwab.availableToTrade)}</strong> · Already committed {usd0.format(committedNow)} ({pct(committedNow)}) · Account {usd0.format(schwab.accountValue)} ·{" "}
              <span title="Schwab's own available-to-trade figure (thinkorswim's Option Buying Power). The order ticket shows the final number.">Schwab {easternTime(schwab.asOf)}</span>{" "}
              <button type="button" onClick={() => void loadCapital()} className="underline underline-offset-2 hover:text-zinc-200">Refresh</button>
              {schwab.unsettledCash ? ` · ${usd0.format(schwab.unsettledCash)} unsettled not counted` : ""}
            </>
          ) : null}
        </p>

        {priceAgeNote || scanIncompleteNote ? (
          <p data-testid="plan-notes" className="text-xs text-amber-300">
            {[priceAgeNote, scanIncompleteNote ? "The scan is still finishing - picks may change." : null].filter(Boolean).join(" ")}
          </p>
        ) : null}
        {unknownExposureCount > 0 ? (
          <p className="text-xs text-amber-300">
            {unknownExposureCount} open position(s) have unknown collateral or cost basis, so no picks are suggested until they are fixed in the Tracker.
          </p>
        ) : null}

        {picked.length > 0 ? (
          <ul className="space-y-2" data-testid="plan-candidates">{picked.map((candidate) => renderRow(candidate, "pick"))}</ul>
        ) : (
          <div className="rounded-md border border-dashed border-zinc-700 p-3 text-sm text-zinc-200" data-testid="plan-empty">
            <p className="font-medium">No trade to place right now - keeping the cash is the plan.</p>
            {leftOut.length + tooBig.length > 0 ? (
              <ul className="mt-1.5 space-y-0.5 text-xs text-zinc-400">
                {tooBig.map((candidate) => (
                  <li key={candidate.ticker}><span className="font-medium text-zinc-200">{candidate.ticker}</span>: one ${candidate.strike} put holds {usd0.format(collateralOf(candidate) ?? 0)} ({pct(collateralOf(candidate) ?? 0)}), over your {limits.maxPerCompanyPct}% per-company limit</li>
                ))}
                {leftOut.map((candidate) => (
                  <li key={candidate.ticker}><span className="font-medium text-zinc-200">{candidate.ticker}</span>: {leftOutReasons(candidate).join("; ")}</li>
                ))}
              </ul>
            ) : needsEthics.length > 0 ? null : (
              <p className="mt-1 text-xs text-zinc-400">Nothing in this scan passed the rules. Prices move during the session - re-scan before giving up; on a weekend quotes are Friday&apos;s close.</p>
            )}
          </div>
        )}

        {mineEval && mine.length > 0 ? (
          <p className={`text-sm ${mineEval.valid ? "text-zinc-300" : "text-red-300"}`} data-testid="plan-compare">
            Total: holds <strong className="text-zinc-50">{usd0.format(mineEval.newCollateral)}</strong> · premium <strong className="text-emerald-200">{usd0.format(mineEval.newPremium)}</strong> · cash left {usd0.format(mineEval.cashRemaining)} · {mineEval.committedAfterPct.toFixed(1)}% of the account committed (ceiling {limits.maxCommittedPct}%)
            {mineEval.violations.map((violation) => <span key={violation.message} className="block text-xs text-red-300">{violation.message}</span>)}
            {mineEval.warnings.map((warning) => <span key={warning} className="block text-xs text-amber-300">{warning}</span>)}
          </p>
        ) : null}

        {manual !== null ? (
          <button type="button" onClick={() => setManual(null)} className="text-xs text-zinc-400 underline underline-offset-2 hover:text-zinc-200">Back to the suggested picks</button>
        ) : null}

        {alternatives.length > 0 ? (
          <details className="text-sm" data-testid="plan-alternatives">
            <summary className="cursor-pointer text-zinc-400 hover:text-zinc-200">{alternatives.length} other trade(s) that qualify</summary>
            <ul className="mt-2 space-y-2">{alternatives.map((candidate) => renderRow(candidate, "alt"))}</ul>
          </details>
        ) : null}

        {needsEthics.length > 0 ? (
          <div data-testid="plan-needs-ethics" className="space-y-2">
            <p className="text-xs font-medium text-sky-200">Would qualify once you OK the company:</p>
            <ul className="space-y-2">{needsEthics.map((candidate) => renderRow(candidate, "ethics"))}</ul>
          </div>
        ) : null}

        {picked.length > 0 && leftOut.length + tooBig.length > 0 ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-zinc-400 hover:text-zinc-200">{leftOut.length + tooBig.length} passing name(s) left out, and why</summary>
            <ul className="mt-2 space-y-1 text-xs text-zinc-400">
              {tooBig.map((candidate) => (
                <li key={candidate.ticker}><span className="font-medium text-zinc-200">{candidate.ticker}</span>: one contract holds {usd0.format(collateralOf(candidate) ?? 0)} ({pct(collateralOf(candidate) ?? 0)}), over your {limits.maxPerCompanyPct}% per-company limit</li>
              ))}
              {leftOut.map((candidate) => (
                <li key={candidate.ticker}><span className="font-medium text-zinc-200">{candidate.ticker}</span>: {leftOutReasons(candidate).join("; ")}</li>
              ))}
            </ul>
          </details>
        ) : null}

        {showLimits ? (
          <div data-testid="plan-limits" className="rounded-md border border-zinc-800 p-2">
            <p className="text-xs text-zinc-500">Limits are saved on this device.</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <LimitField label="Max per company (% of account)" value={limits.maxPerCompanyPct} onChange={(value) => updateLimit("maxPerCompanyPct", value)} />
            <LimitField label="Max committed (% ceiling)" value={limits.maxCommittedPct} onChange={(value) => updateLimit("maxCommittedPct", value)} />
            <LimitField label="Companies per theme" value={limits.maxPerTheme} onChange={(value) => updateLimit("maxPerTheme", value)} />
            <LimitField label="Warn above per sector" value={limits.warnPerSector} onChange={(value) => updateLimit("warnPerSector", value)} />
            <LimitField label="Minimum return per trade (%)" value={limits.minReturnPct} onChange={(value) => updateLimit("minReturnPct", value)} />
          </div>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

/** "Nov 13" from "2026-11-13" (no timezone shift: the date is a calendar date, not an instant). */
function shortExpiry(iso: string | null): string {
  if (!iso) return "?";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))));
}

function LimitField({ label, value, onChange }: { label: string; value: number; onChange: (value: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      {label}
      <input type="number" min={0} step="any" defaultValue={value} key={value} onBlur={(event) => onChange(event.target.value)} className="min-h-8 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-zinc-100" />
    </label>
  );
}
