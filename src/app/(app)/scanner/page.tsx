import { RefreshCw, SlidersHorizontal } from "lucide-react";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { Badge } from "@/components/ui";
import {
  buildExclusionDiagnostics,
  getNearMisses,
  honestSetupLabel,
  honestSetupScore,
  primaryConcern,
  type CriterionResult,
  type CriterionStatus,
  type ScanSummary,
  type ScannerOperator,
  type ScannerRule,
} from "@/domain/scanner/scanner";
import { GATING_RULE_KEYS, SCANNER_RULE_DEFINITIONS } from "@/domain/scanner/profile";
import type { ResearchStatus } from "@/generated/prisma/enums";
import { requireCurrentUser } from "@/lib/auth";
import { getScannerPageData } from "@/lib/app-data";
import { prisma } from "@/lib/prisma";
import { shortCalendarDate } from "@/lib/format";
import { getTechnicalCacheFreshnessBreakdownForUser } from "@/lib/technical-indicator-cache";
import { ensureMyLstScannerProfileForUser } from "@/lib/workflows";
import { runDemoScannerAction } from "../actions";
import { LiveScanButton } from "./live-scan-button";
import { ScannerWorkspace } from "./scanner-workspace";

export const dynamic = "force-dynamic";

type ScannerSearchParams = {
  error?: string;
};

const ruleOrder = new Map(SCANNER_RULE_DEFINITIONS.map((definition, index) => [definition.name, index]));
const ruleKeyByName = new Map(SCANNER_RULE_DEFINITIONS.map((definition) => [definition.name, definition.key]));

export type ScannerBuddy = { id: string; name: string };

export type ScannerResult = NonNullable<Awaited<ReturnType<typeof getScannerPageData>>>["scanRuns"][number]["results"][number];

export type ScannerViewResult = {
  record: ScannerResult;
  summary: ScanSummary;
  score: number;
  scoreLabel: ReturnType<typeof honestSetupLabel>;
  nearMisses: ReturnType<typeof getNearMisses>;
  concern: CriterionResult | null;
  researchStatus: ResearchStatus | null;
  values: {
    price: number | null;
    priceChangePercent: number | null;
    stockVolume: number | null;
    strike: number | null;
    expiration: string | null;
    dte: number | null;
    premium: number | null;
    optionBid: number | null;
    optionAsk: number | null;
    midpoint: number | null;
    delta: number | null;
    rsi: number | null;
    bbPercent: number | null;
    distanceOtmPercent: number | null;
    ror: number | null;
    annualizedRor: number | null;
    spreadPercent: number | null;
    openInterest: number | null;
    optionVolume: number | null;
    earningsDate: string | null;
    earningsDistance: number | null;
    /** Explains a blank option column - "no qualifying contract," "stock-stage filter never
     * reached the option chain," or "option-chain data was unavailable" (see live-scan.ts).
     * Null means the row's option values are either fully populated or this run predates the
     * scanNote field existing - never presented as if it were a confirmed empty result either way. */
    scanNote: string | null;
  };
};

/**
 * Plain (non-component) helper, deliberately kept outside ScannerPage's own render body - React's
 * component-purity rule flags Date.now() timing inside a component/hook as an impure render
 * side effect, even for a Server Component's own data-fetching. Safe, sanitized timing
 * (milliseconds only) for the Scanner page's own server-side data load - see PROJECT_HANDOFF.md's
 * "post-scan loading" audit (this is what the /scanner loading.tsx boundary is waiting on,
 * whether from a normal navigation or a revalidatePath-triggered refresh right after Run Live
 * Scan). Logged unconditionally so a real production page load gives real numbers, not a guess.
 */
async function loadScannerPageBundle(userId: string) {
  const startedAt = Date.now();
  const result = await Promise.all([
    getScannerPageData(userId),
    prisma.user.findMany({ where: { id: { not: userId } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.watchlistItem.findMany({
      where: { ownerId: userId },
      select: { ticker: true, researchStatus: true },
    }),
    // DB-only (no Schwab call) - lets the page show an honest, always-current staleness warning
    // even when the visitor never clicks "Run Live Scan" this session (e.g. reloading over a
    // weekend before any scan re-runs) - see PROJECT_HANDOFF.md's weekend-coverage investigation.
    // mostRecentRun: true is required here (not the default "today only" lookup) - otherwise a day
    // with no NEW run yet (early Saturday before the catch-up window opens, or any day the global
    // gate never let one be created at all) would report hasActiveRun: false and silently hide a
    // genuinely stale carried-over technical cache, defeating the whole point of this banner.
    getTechnicalCacheFreshnessBreakdownForUser(userId, new Date(), { mostRecentRun: true }),
  ]);
  console.info("Scanner page data load (ms):", Date.now() - startedAt);
  return result;
}

/** Same materiality threshold as live-scan-button.tsx's own MATERIAL_TECHNICAL_COVERAGE_THRESHOLD
 * - kept as a literal here rather than a shared import since the two live in different
 * client/server boundaries and the constant itself is trivial; keep both in sync if changed. */
const MATERIAL_TECHNICAL_COVERAGE_THRESHOLD = 0.9;

export default async function ScannerPage({
  searchParams,
}: {
  searchParams: Promise<ScannerSearchParams>;
}) {
  const user = await requireCurrentUser();

  const params = await searchParams;
  const [initialProfile, buddies, researchItems, technicalFreshness] = await loadScannerPageBundle(user.id);
  let profile = initialProfile;
  if (!profile) {
    await ensureMyLstScannerProfileForUser(user.id);
    profile = await getScannerPageData(user.id);
  }
  const run = profile?.scanRuns[0];
  const researchByTicker = new Map(researchItems.map((item) => [item.ticker, item.researchStatus]));
  const allResults = (run?.results ?? []).map((result) => toViewResult(result, researchByTicker));
  const isLiveSchwabRun = run?.source === "LIVE:SCHWAB";
  const diagnostics = buildExclusionDiagnostics(
    allResults.map((result) => ({ ticker: result.record.ticker, summary: result.summary })),
  );
  const passCount = allResults.filter((result) => result.summary.status === "PASS").length;
  const nearMatchCount = allResults.filter((result) => result.nearMisses.length === 1).length;
  const unknownCount = allResults.filter((result) => result.summary.status === "UNKNOWN").length;
  const averageScore = allResults.length
    ? Math.round(allResults.reduce((sum, result) => sum + result.score, 0) / allResults.length)
    : 0;

  // Honest, always-current staleness warning (never tied to whether "Run Live Scan" was clicked
  // this session) - only meaningful for a real live scan against a real eligible universe. Uses
  // the exact same freshness rule the live scan itself uses (getTechnicalCacheFreshnessBreakdownForUser),
  // so this can never disagree with what a fresh scan would actually find.
  const showStaleTechnicalWarning =
    isLiveSchwabRun &&
    technicalFreshness.hasActiveRun &&
    technicalFreshness.eligibleCount > 0 &&
    technicalFreshness.freshUsableCount / technicalFreshness.eligibleCount < MATERIAL_TECHNICAL_COVERAGE_THRESHOLD;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold text-zinc-50">My LST Scanner</h1>
          <span
            title={
              isLiveSchwabRun
                ? "Live Schwab market data. OSO still calculates RSI, Bollinger position, returns, scores, and PASS/FAIL/UNKNOWN."
                : "Demo/mock data - not live market or option-chain data. Use Run Live Scan after OAuth and server environment variables are ready."
            }
          >
            <Badge tone={isLiveSchwabRun ? "info" : "warn"}>{isLiveSchwabRun ? "LIVE • SCHWAB" : "DEMO"}</Badge>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <LiveScanButton />
          <IntentPrefetchLink
            href="/scanner/settings"
            title="Scanner Rules"
            aria-label="Scanner Rules"
            className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-zinc-700 px-2.5 text-sm font-medium text-zinc-200 transition hover:border-emerald-400/60 hover:text-emerald-200"
          >
            <SlidersHorizontal className="size-3.5" aria-hidden />
          </IntentPrefetchLink>
          <details className="group relative">
            <summary className="flex min-h-9 cursor-pointer list-none items-center gap-1 rounded-md border border-zinc-700 px-2.5 text-sm font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-50">
              More
            </summary>
            <div className="absolute right-0 top-full z-10 mt-1 w-48 rounded-md border border-zinc-800 bg-zinc-900 p-1.5 shadow-lg shadow-black/30">
              <form action={runDemoScannerAction}>
                <button
                  type="submit"
                  className="flex min-h-9 w-full items-center gap-2 rounded px-2 text-left text-sm text-zinc-300 transition hover:bg-zinc-800 hover:text-zinc-50"
                >
                  <RefreshCw className="size-3.5" aria-hidden />
                  Refresh Demo Scan
                </button>
              </form>
            </div>
          </details>
        </div>
      </div>

      {params.error ? (
        <div className="rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-100">
          {params.error}
        </div>
      ) : null}

      {showStaleTechnicalWarning ? (
        <div
          data-testid="stale-technical-cache-warning"
          className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100"
        >
          <p className="font-medium">Technical cache is not current for this scan.</p>
          <p className="mt-0.5 text-amber-200/90">
            Required market date: {shortCalendarDate(technicalFreshness.requiredMarketDate)} · Fresh technicals:{" "}
            {technicalFreshness.freshUsableCount.toLocaleString()} / {technicalFreshness.eligibleCount.toLocaleString()}
          </p>
          <p className="mt-0.5 text-amber-200/90">Scanner results are incomplete.</p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-sm text-zinc-300">
        <span>
          <strong className="text-zinc-50">{allResults.length}</strong> candidates
        </span>
        <span className="text-emerald-300">
          <strong>{passCount}</strong> pass
        </span>
        <span className="text-amber-300">
          <strong>{nearMatchCount}</strong> near
        </span>
        <span className="text-zinc-400">
          <strong>{unknownCount}</strong> unknown
        </span>
        <span>
          Avg <strong className="text-zinc-50">{allResults.length ? averageScore : "N/A"}</strong>
        </span>
        {run ? <span className="ml-auto text-xs text-zinc-500">Last run: {shortRunTime(run.createdAt)}</span> : null}
      </div>

      <ScannerWorkspace results={allResults} buddies={buddies} diagnostics={diagnostics} modeLabel={run ? "showing" : "found"} />
    </div>
  );
}

function shortRunTime(date: Date) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function toViewResult(result: ScannerResult, researchByTicker: Map<string, ResearchStatus>): ScannerViewResult {
  const summary = toDomainSummary(result);
  const score = honestSetupScore(summary, GATING_RULE_KEYS);

  return {
    record: result,
    summary,
    score,
    scoreLabel: honestSetupLabel(summary, GATING_RULE_KEYS),
    nearMisses: getNearMisses(summary.results),
    concern: primaryConcern(summary.results),
    researchStatus: researchByTicker.get(result.ticker) ?? null,
    values: {
      price: snapshotNumber(result.snapshotJson, "price"),
      priceChangePercent: snapshotNumber(result.snapshotJson, "priceChangePercent"),
      stockVolume: snapshotNumber(result.snapshotJson, "stockVolume"),
      strike: snapshotNumber(result.snapshotJson, "strike"),
      expiration: snapshotString(result.snapshotJson, "expiration"),
      dte: snapshotNumber(result.snapshotJson, "dte"),
      premium: snapshotNumber(result.snapshotJson, "premium"),
      optionBid: snapshotNumber(result.snapshotJson, "optionBid"),
      optionAsk: snapshotNumber(result.snapshotJson, "optionAsk"),
      midpoint: snapshotNumber(result.snapshotJson, "midpoint"),
      delta: snapshotNumber(result.snapshotJson, "delta"),
      rsi: snapshotNumber(result.snapshotJson, "rsi"),
      bbPercent: snapshotNumber(result.snapshotJson, "bbPercent"),
      distanceOtmPercent: snapshotNumber(result.snapshotJson, "distanceOtmPercent"),
      ror: snapshotNumber(result.snapshotJson, "ror"),
      annualizedRor: snapshotNumber(result.snapshotJson, "annualizedRor"),
      spreadPercent: snapshotNumber(result.snapshotJson, "spreadPercent"),
      openInterest: snapshotNumber(result.snapshotJson, "openInterest"),
      optionVolume: snapshotNumber(result.snapshotJson, "optionVolume"),
      earningsDate: snapshotString(result.snapshotJson, "earningsDate"),
      earningsDistance: snapshotNumber(result.snapshotJson, "earningsDistance"),
      scanNote: snapshotString(result.snapshotJson, "scanNote"),
    },
  };
}

function toDomainSummary(result: ScannerResult): ScanSummary {
  const criteria = result.criterionResults
    .map((criterion): CriterionResult => ({
      key: ruleKeyByName.get(criterion.criterionName) ?? criterion.criterionName,
      name: criterion.criterionName,
      actualValue: parseActualValue(criterion.actualValue),
      operator: criterion.operator as ScannerOperator,
      desiredValue: parseDesiredValue(criterion.desiredValue),
      status: criterion.status as CriterionStatus,
      explanation: criterion.explanation,
    }))
    .sort((left, right) => (ruleOrder.get(left.name) ?? 999) - (ruleOrder.get(right.name) ?? 999));

  return {
    status: result.summaryStatus as CriterionStatus,
    passed: criteria.filter((criterion) => criterion.status === "PASS").length,
    total: criteria.length,
    results: criteria,
  };
}

function parseDesiredValue(raw: string): ScannerRule["desired"] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.length === 2 && parsed.every((item) => typeof item === "number")) {
      return [parsed[0], parsed[1]];
    }
    if (typeof parsed === "number" || typeof parsed === "string" || typeof parsed === "boolean") {
      return parsed;
    }
  } catch {
    return raw;
  }

  return raw;
}

function parseActualValue(raw: string | null) {
  if (raw === null || raw === "") {
    return null;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : raw;
}

function snapshotNumber(snapshot: unknown, key: string) {
  if (!snapshot || typeof snapshot !== "object" || !(key in snapshot)) {
    return null;
  }

  const value = (snapshot as Record<string, unknown>)[key];
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function snapshotString(snapshot: unknown, key: string) {
  if (!snapshot || typeof snapshot !== "object" || !(key in snapshot)) {
    return null;
  }

  const value = (snapshot as Record<string, unknown>)[key];
  return value ? String(value) : null;
}
