"use client";

import { useEffect, useMemo, useState } from "react";
import { Panel } from "@/components/ui";
import {
  DEFAULT_PLAN_LIMITS,
  candidateBlockers,
  canAdd,
  collateralOf,
  evaluatePlan,
  optimizePlan,
  themeKeyOf,
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

const ETHICS_LABEL: Record<PlanCandidate["ethics"], string> = {
  OK: "Ethics OK",
  REVIEW: "Ethics: review",
  BLOCKED: "Ethics: excluded",
  UNREVIEWED: "Ethics: not researched",
};

type Props = {
  candidates: PlanCandidate[];
  existing: ExistingExposure[];
  unknownExposureCount: number;
};

export function PortfolioPlanPanel({ candidates, existing, unknownExposureCount }: Props) {
  const [limits, setLimits] = useState<PlanLimits>(DEFAULT_PLAN_LIMITS);
  const [capital, setCapital] = useState<TradingCapital | "loading">("loading");
  const [selected, setSelected] = useState<string[]>([]);
  const [suggested, setSuggested] = useState<string[] | null>(null);

  // Browser-only state (saved limits, today's confirmation) and the first Schwab read are loaded after mount; the
  // setters run in async callbacks so the server-rendered markup and the first client render always agree.
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
    setSelected([]);
    setSuggested(null);
  }

  const schwab = capital !== "loading" && capital.ok ? capital : null;
  const availableToTrade = schwab?.availableToTrade ?? null;
  const accountValue = schwab?.accountValue ?? null;
  const ready = availableToTrade !== null && accountValue !== null;
  const planCapital = ready ? { accountValue, availableToTrade } : null;

  const { eligible, ineligible } = useMemo(() => {
    const quality = (candidate: PlanCandidate) => (candidate.readiness === "PASS" ? 100 : 0) + candidate.score;
    const sorted = [...candidates].sort((left, right) => quality(right) - quality(left) || left.ticker.localeCompare(right.ticker));
    return {
      eligible: sorted.filter((candidate) => candidateBlockers(candidate, limits).length === 0),
      ineligible: sorted.filter((candidate) => candidateBlockers(candidate, limits).length > 0),
    };
  }, [candidates, limits]);

  const byTicker = useMemo(() => new Map(candidates.map((candidate) => [candidate.ticker, candidate])), [candidates]);
  const pick = (tickers: string[]) => tickers.map((ticker) => byTicker.get(ticker)).filter((c): c is PlanCandidate => Boolean(c));
  const mine = pick(selected);
  const mineEval: PlanEvaluation | null = planCapital ? evaluatePlan(mine, existing, planCapital, limits) : null;
  const suggestedEval: PlanEvaluation | null = planCapital && suggested ? evaluatePlan(pick(suggested), existing, planCapital, limits) : null;

  function toggle(ticker: string) {
    setSelected((current) => (current.includes(ticker) ? current.filter((value) => value !== ticker) : [...current, ticker]));
  }

  function suggest() {
    if (!planCapital) return;
    const result = optimizePlan(candidates, existing, planCapital, limits);
    const tickers = result.picks.map((candidate) => candidate.ticker);
    setSuggested(tickers);
    setSelected(tickers);
  }

  const committedNow = existing.reduce((sum, row) => sum + row.amount, 0);

  return (
    <Panel title="Monday plan" action={<span className="text-xs text-zinc-500">Recommendations only - you place every trade yourself</span>}>
      <div className="space-y-4" data-testid="portfolio-plan">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Account value" value={accountValue === null ? "-" : usd.format(accountValue)} />
          <Stat
            label="Available to trade"
            value={availableToTrade === null ? "-" : usd.format(availableToTrade)}
            note={schwab ? `Read from Schwab at ${easternTime(schwab.asOf)}` : undefined}
          />
          <Stat label="Already committed" value={usd.format(committedNow)} note={accountValue ? `${((committedNow / accountValue) * 100).toFixed(1)}% of the account (puts + shares at cost)` : undefined} />
          <Stat
            label="Cash left after your picks"
            value={mineEval ? usd.format(mineEval.cashRemaining) : "-"}
            note={mineEval ? `${mineEval.committedAfterPct.toFixed(1)}% committed (ceiling ${limits.maxCommittedPct}%)` : undefined}
            tone={mineEval && !mineEval.valid ? "bad" : undefined}
          />
        </div>

        {capital === "loading" ? <p className="text-xs text-zinc-500">Reading your balance from Schwab…</p> : null}
        {capital !== "loading" && !capital.ok ? (
          <p className="text-xs text-red-300">
            {capital.message}{" "}
            <button type="button" onClick={() => void loadCapital()} className="underline underline-offset-2 hover:text-red-100">Try again</button>
          </p>
        ) : null}
        {schwab && schwab.unsettledCash ? (
          <p className="text-xs text-zinc-500">{usd.format(schwab.unsettledCash)} is shown by Schwab as unsettled/held and is not counted as available.</p>
        ) : null}

        {schwab ? (
          <p className="text-xs text-zinc-500">
            This is Schwab&apos;s own &quot;available to trade&quot; figure (the same number thinkorswim shows as Option Buying Power).{" "}
            <button type="button" onClick={() => void loadCapital()} className="underline underline-offset-2 hover:text-zinc-300">Refresh</button>
            {" "}before placing a trade; thinkorswim&apos;s order ticket shows the final number at that moment.
          </p>
        ) : null}

        {unknownExposureCount > 0 ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">
            {unknownExposureCount} open position(s) have unknown collateral or cost basis, so what is already committed is incomplete. Fix those in the Tracker before relying on a suggestion.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={suggest}
            disabled={!planCapital || unknownExposureCount > 0}
            data-testid="plan-suggest"
            className="min-h-9 rounded-md border border-emerald-400/40 bg-emerald-400/10 px-3 text-sm font-medium text-emerald-100 hover:border-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Suggest allocation
          </button>
          <button type="button" onClick={() => { setSelected([]); setSuggested(null); }} className="min-h-9 rounded-md border border-zinc-700 px-3 text-sm text-zinc-300 hover:border-zinc-500">Clear picks</button>
          <span className="text-xs text-zinc-500">One contract per company. Cash left idle is fine - nothing is added just to use money.</span>
        </div>

        {eligible.length === 0 ? (
          <p className="rounded-md border border-dashed border-zinc-800 p-3 text-sm text-zinc-300" data-testid="plan-empty">
            No trade in this scan clears every rule right now, so the plan is to leave the cash available. Prices move during the session, so re-scan before acting - on a weekend the quotes are Friday&apos;s close, so wait for Monday after 10:30 AM ET.
          </p>
        ) : (
          <ul className="space-y-2" data-testid="plan-candidates">
            {eligible.map((candidate) => {
              const isSelected = selected.includes(candidate.ticker);
              const fit = !isSelected && planCapital ? canAdd(candidate, mine, existing, planCapital, limits) : { ok: true as const };
              const collateral = collateralOf(candidate) ?? 0;
              const unavailable = !isSelected && (!planCapital || !fit.ok);
              return (
                <li key={candidate.ticker} className={`rounded-md border p-2.5 text-sm ${isSelected ? "border-emerald-400/50 bg-emerald-400/5" : "border-zinc-800 bg-zinc-900/40"} ${unavailable ? "opacity-60" : ""}`}>
                  <label className="flex cursor-pointer items-start gap-3">
                    <input type="checkbox" checked={isSelected} disabled={unavailable} onChange={() => toggle(candidate.ticker)} className="mt-1 size-4" aria-label={`Select ${candidate.ticker}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                        <span className="font-semibold text-zinc-50">{candidate.ticker}</span>
                        <span className="text-zinc-300">${candidate.strike} put · {candidate.expiration ?? "?"}{candidate.dte !== null ? ` (${candidate.dte}d)` : ""}</span>
                        <span className="text-zinc-300">premium {candidate.bidProceedsPerContract === null ? "?" : usd0.format(candidate.bidProceedsPerContract)} · {candidate.returnPct === null ? "?" : `${candidate.returnPct.toFixed(2)}%`}</span>
                        <span className="text-zinc-300">needs {usd0.format(collateral)}{accountValue ? ` (${((collateral / accountValue) * 100).toFixed(1)}%)` : ""}</span>
                        <span className={candidate.readiness === "PASS" ? "text-emerald-300" : "text-amber-300"}>{candidate.readiness}</span>
                      </div>
                      <div className="mt-0.5 text-xs text-zinc-500">
                        {candidate.companyName ? `${candidate.companyName} · ` : ""}
                        {[candidate.sector, candidate.industry].filter(Boolean).join(" / ") || "sector unknown"} · theme: {themeKeyOf(candidate) ?? "none on file"} · {ETHICS_LABEL[candidate.ethics]}
                      </div>
                      {unavailable && !fit.ok ? <div className="mt-0.5 text-xs text-amber-300">Doesn&apos;t fit with your picks: {fit.reasons.join(" ")}</div> : null}
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        {mineEval && (mine.length > 0 || suggestedEval) ? (
          <div className="grid gap-3 sm:grid-cols-2" data-testid="plan-compare">
            {suggestedEval ? <Summary title="Suggested by the planner" evaluation={suggestedEval} tickers={suggested ?? []} /> : null}
            <Summary title="Your picks" evaluation={mineEval} tickers={selected} />
          </div>
        ) : null}

        {ineligible.length > 0 ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-zinc-400 hover:text-zinc-200">{ineligible.length} PASS/NEAR name(s) not eligible for the plan</summary>
            <ul className="mt-2 space-y-1 text-xs text-zinc-400">
              {ineligible.map((candidate) => (
                <li key={candidate.ticker}>
                  <span className="font-medium text-zinc-200">{candidate.ticker}</span>: {candidateBlockers(candidate, limits).join("; ")}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        <details className="text-sm">
          <summary className="cursor-pointer text-zinc-400 hover:text-zinc-200">Limits (saved on this device)</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <LimitField label="Max per company (% of account)" value={limits.maxPerCompanyPct} onChange={(value) => updateLimit("maxPerCompanyPct", value)} />
            <LimitField label="Max committed (% ceiling)" value={limits.maxCommittedPct} onChange={(value) => updateLimit("maxCommittedPct", value)} />
            <LimitField label="Companies per theme" value={limits.maxPerTheme} onChange={(value) => updateLimit("maxPerTheme", value)} />
            <LimitField label="Warn above per sector" value={limits.warnPerSector} onChange={(value) => updateLimit("warnPerSector", value)} />
            <LimitField label="Minimum return per trade (%)" value={limits.minReturnPct} onChange={(value) => updateLimit("minReturnPct", value)} />
          </div>
        </details>
      </div>
    </Panel>
  );
}

function Stat({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "good" | "warn" | "bad" }) {
  const toneClass = tone === "good" ? "text-emerald-300" : tone === "warn" ? "text-amber-300" : tone === "bad" ? "text-red-300" : "text-zinc-500";
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/50 p-2.5">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-lg font-semibold text-zinc-50">{value}</div>
      {note ? <div className={`text-xs ${toneClass}`}>{note}</div> : null}
    </div>
  );
}

function Summary({ title, evaluation, tickers }: { title: string; evaluation: PlanEvaluation; tickers: string[] }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/50 p-2.5 text-sm">
      <div className="font-medium text-zinc-100">{title}</div>
      <div className="mt-1 text-zinc-300">{tickers.length ? tickers.join(", ") : "No trades - cash stays available"}</div>
      <dl className="mt-1 grid grid-cols-2 gap-x-3 text-xs text-zinc-400">
        <dt>Capital required</dt><dd className="text-right text-zinc-200">{usd.format(evaluation.newCollateral)}</dd>
        <dt>Premium at the bid</dt><dd className="text-right text-zinc-200">{usd.format(evaluation.newPremium)}</dd>
        <dt>Cash left</dt><dd className="text-right text-zinc-200">{usd.format(evaluation.cashRemaining)}</dd>
        <dt>Total committed</dt><dd className="text-right text-zinc-200">{evaluation.committedAfterPct.toFixed(1)}%</dd>
      </dl>
      {evaluation.violations.map((violation) => (
        <p key={violation.message} className="mt-1 text-xs text-red-300">{violation.message}</p>
      ))}
      {evaluation.warnings.map((warning) => (
        <p key={warning} className="mt-1 text-xs text-amber-300">{warning}</p>
      ))}
    </div>
  );
}

function LimitField({ label, value, onChange }: { label: string; value: number; onChange: (value: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      {label}
      <input type="number" min={0} step="any" defaultValue={value} key={value} onBlur={(event) => onChange(event.target.value)} className="min-h-8 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-zinc-100" />
    </label>
  );
}
