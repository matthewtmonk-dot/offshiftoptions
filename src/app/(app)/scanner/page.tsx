import { RefreshCw, SlidersHorizontal } from "lucide-react";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { Badge, secondaryButtonClass } from "@/components/ui";
import {
  buildExclusionDiagnostics,
  classifyReadiness,
  honestSetupLabel,
  honestSetupScore,
  primaryConcern,
  type CriterionResult,
  type CriterionStatus,
  type ScannerReadiness,
  type ScanSummary,
  type ScannerOperator,
  type ScannerRule,
} from "@/domain/scanner/scanner";
import { GATING_RULE_KEYS, resultsPredateCurrentSettings, SCANNER_RULE_DEFINITIONS } from "@/domain/scanner/profile";
import { STOCK_STAGE_RULE_KEYS } from "@/domain/scanner/live-scan";
import { buildScannerFunnel, describeOptionOutcomes, describeScanIncomplete, describeScannerFunnel, funnelInputOf, isWorthALook, summarizeOptionOutcomes, type StockScreenVerdict } from "@/domain/scanner/scannerFunnel";
import { scannerTimingGuide, technicalReadyHint } from "@/domain/scanner/timingGuide";
import type { ResearchStatus } from "@/generated/prisma/enums";
import { requireCurrentUser } from "@/lib/auth";
import { getScannerPageData } from "@/lib/app-data";
import { getEthicsSummariesForUser } from "@/lib/ethics";
import { getCompanyQualityForUser, tickersNeedingQualityRefresh, type CompanyQualityView } from "@/lib/company-quality";
import { CheckQualityButton } from "./check-quality-button";
import { prisma } from "@/lib/prisma";
import { getTechnicalCacheFreshnessBreakdownForUser } from "@/lib/technical-indicator-cache";
import { ensureMyLstScannerProfileForUser, MAX_DISPLAYED_STOCK_STAGE_RESULTS } from "@/lib/workflows";
import { getCoveredCallScanForUser } from "@/lib/covered-call-scanner";
import { MAX_SCAN_AGE_MS } from "@/lib/scanner-option-check";
import { buildPlanCandidates } from "@/domain/portfolio/candidates";
import { getClassificationForTickers, getPlanExposureForUser } from "@/lib/portfolio-plan";
import { runDemoScannerAction } from "../actions";
import { CoveredCallScannerSection } from "./covered-call-scanner-section";
import { LiveScanButton } from "./live-scan-button";
import { OptionCheckButton } from "./option-check-button";
import { PortfolioPlanPanel } from "./portfolio-plan-panel";
import { PrepareDataButton } from "./prepare-data-button";
import { ScanAutoFinisher } from "./scan-auto-finisher";
import { ScannerModeTabs, type ScannerMode } from "./scanner-mode-tabs";
import { ScannerWorkspace } from "./scanner-workspace";

export const dynamic = "force-dynamic";

type ScannerSearchParams = {
  error?: string;
  mode?: string;
  ticker?: string;
};

const ruleOrder = new Map(SCANNER_RULE_DEFINITIONS.map((definition, index) => [definition.name, index]));
const ruleKeyByName = new Map(SCANNER_RULE_DEFINITIONS.map((definition) => [definition.name, definition.key]));

export type ScannerBuddy = { id: string; name: string };

export type ScannerResult = NonNullable<Awaited<ReturnType<typeof getScannerPageData>>>["scanRuns"][number]["results"][number];

export type ScannerViewResult = {
  /** Only the identity the browser needs. The full database row (snapshot JSON + every criterion row) is read on the
   * server in toViewResult and must NOT be passed to the client: it duplicated `summary`/`values` and made the page
   * ship over 1 MB of HTML for ~100 rows. */
  record: Pick<ScannerResult, "id" | "ticker">;
  summary: ScanSummary;
  score: number;
  scoreLabel: ReturnType<typeof honestSetupLabel>;
  /** The one authoritative PASS/NEAR/NEEDS_DATA/FAIL classification (see classifyReadiness in
   * scanner.ts) - every row badge, one-click filter, and header count must read this field rather
   * than re-deriving its own notion of "near" or "pass". */
  readiness: ScannerReadiness;
  /** Verdict over ONLY the enabled stock-level rules (price, volume, RSI, %B, earnings...) - lets the
   * funnel tell "failed the stock screen" apart from "qualified but options not priced yet". */
  stockScreen: StockScreenVerdict;
  /** Every enabled hard (gating) rule is a definite PASS - see isBestAvailable in scannerFunnel.ts. */
  gatingClear: boolean;
  /** Why no option contract was selected for this row, if none was (see live-scan.ts). */
  contractReasonCode: string | null;
  /** Set when RSI/Bollinger weren't ready (pending/stale/failed technical cache) for this row. */
  technicalReasonCode: string | null;
  concern: CriterionResult | null;
  researchStatus: ResearchStatus | null;
  values: {
    price: number | null;
    priceChangePercent: number | null;
    stockVolume: number | null;
    strike: number | null;
    expiration: string | null;
    dte: number | null;
    /** A mark/midpoint estimate (option.mark, falling back to the bid/ask midpoint) - never the
     * bid-based figure `ror`/`annualizedRor` actually use (see `premiumBasis`/`bidProceedsPerContract`). */
    premium: number | null;
    /** Always "MARK_MIDPOINT" when `premium` is non-null - documents what `premium` represents so
     * it is never mistaken for the bid-based amount ROR is calculated from. */
    premiumBasis: "MARK_MIDPOINT" | null;
    optionBid: number | null;
    optionAsk: number | null;
    midpoint: number | null;
    /** The actual dollars a seller would receive per contract if filled at the current bid
     * (bid * 100) - the real basis for `ror`/`annualizedRor`, distinct from the mark/midpoint
     * `premium` shown alongside it. */
    bidProceedsPerContract: number | null;
    delta: number | null;
    rsi: number | null;
    bbPercent: number | null;
    distanceOtmPercent: number | null;
    /** Calculated from the bid, never from `premium` - see `rorBasis`. */
    ror: number | null;
    annualizedRor: number | null;
    /** Always "BID" when `ror`/`annualizedRor` are non-null. */
    rorBasis: "BID" | null;
    spreadPercent: number | null;
    openInterest: number | null;
    optionVolume: number | null;
    earningsDate: string | null;
    earningsDistance: number | null;
    /** True only when a real earnings date and this contract's own DTE are both known and the
     * earnings date falls on or before expiration - never guessed from just one of the two. */
    earningsWithinHoldingPeriod: boolean | null;
    /** Earnings-free calendar days between this contract's expiration and the report date (negative = on/before expiry). */
    earningsFreeDaysAfterExpiry: number | null;
    /** Full NYSE trading sessions between expiration and earnings. */
    earningsExitSessions: number | null;
    /** Why the earnings date itself needs checking (none on file, out of date, or conflicting); null when it is current. */
    earningsVerifyReason: string | null;
    /** No option-chain provider used here has ever supplied a verified per-quote pricing
     * timestamp (same finding as Tickets 4/5's valuationAsOf) - always null today, kept explicit
     * so its absence is machine-readable rather than silently omitted. */
    optionQuotedAt: string | null;
    /** When this contract's data was actually fetched - the only timing fact genuinely known,
     * distinct from a verified provider pricing time (see `optionQuotedAt`). Null when no
     * option-chain request was made for this ticker at all. */
    retrievedAt: string | null;
    /** A coarse NYSE-trading-day check on `retrievedAt` (not exact session hours) - true means
     * the retrieval fell on a day the exchange was closed, so this reflects the last available
     * quote, not a live one, regardless of how recently it was fetched. */
    retrievedOnNonTradingDay: boolean | null;
    /** Machine-readable OptionEnrichmentState (see live-scan.ts) - whether an option-chain
     * request was actually spent on this row, and if not, why not. Null for runs that predate the
     * field; the UI then falls back to its pre-existing behavior rather than guessing. Never
     * inferred from scanNote prose, which a more specific technical reason can legitimately take. */
    optionEnrichment: string | null;
    /** Explains a blank option column - "no qualifying contract," "options not checked," or
     * "option-chain data was unavailable" (see live-scan.ts). Null means the row's option values
     * are either fully populated or this run predates the scanNote field existing - never
     * presented as if it were a confirmed empty result either way. */
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

/** Plain helper outside the component so render stays pure (same reason as loadScannerPageBundle). */
function currentTimingGuide() {
  return scannerTimingGuide(new Date());
}

/** Option prices older than this are shown as "re-scan before placing" on the picks. */
const PICKS_PRICE_MAX_AGE_MS = 60 * 60 * 1000;

/** Plain helper outside the component (render purity): a short note when the picks are built from old option prices. */
function picksPriceAgeNote(runCreatedAt: Date | null): string | null {
  if (!runCreatedAt) return null;
  if (Date.now() - runCreatedAt.getTime() <= PICKS_PRICE_MAX_AGE_MS) return null;
  return `Option prices are from ${shortRunTime(runCreatedAt)}. Run Live Scan again before placing anything - premiums move.`;
}

/**
 * Plain helper outside the component (render purity). Once a scan is older than the option-check cutoff its remaining
 * rows can no longer be priced, so the page stops trying (and stops saying "still finishing") and the single
 * "run Live Scan again" note is the only message.
 */
function scanTooOldToFinish(runCreatedAt: Date | null): boolean {
  return runCreatedAt !== null && Date.now() - runCreatedAt.getTime() > MAX_SCAN_AGE_MS;
}

function currentTechnicalReadyHint() {
  return technicalReadyHint(new Date());
}

export default async function ScannerPage({
  searchParams,
}: {
  searchParams: Promise<ScannerSearchParams>;
}) {
  const user = await requireCurrentUser();

  const params = await searchParams;
  const mode: ScannerMode = params.mode === "covered-calls" ? "covered-calls" : "csp";

  // Covered Call mode is a deliberately separate path (see PROJECT_HANDOFF.md's Covered Call
  // Phase 4) - it never loads the CSP scanner's own data bundle (loadScannerPageBundle below),
  // so viewing one mode never makes the other mode's Schwab/DB calls.
  if (mode === "covered-calls") {
    const scan = await getCoveredCallScanForUser(user.id);
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold text-zinc-50">Scanner</h1>
          <ScannerModeTabs mode={mode} />
        </div>
        <CoveredCallScannerSection scan={scan} highlightTicker={params.ticker ?? null} />
      </div>
    );
  }

  const [initialProfile, buddies, researchItems, technicalFreshness] = await loadScannerPageBundle(user.id);
  let profile = initialProfile;
  if (!profile) {
    await ensureMyLstScannerProfileForUser(user.id);
    profile = await getScannerPageData(user.id);
  }
  const run = profile?.scanRuns[0];
  // Astra follow-up: the settings revision this run actually evaluated against was captured at
  // scan-read time (see withSettingsRevision in workflows.ts) and travels with each persisted
  // result - comparing it here, rather than run.createdAt (a persist-time value that can land
  // AFTER a settings save that happened mid-scan, silently hiding a real earlier-settings case).
  // Falls back to run.createdAt only for a run with no results, or one that predates this field.
  const settingsRevisionAsOfRaw = run?.results[0] ? snapshotString(run.results[0].snapshotJson, "settingsRevisionAsOf") : null;
  const runEvaluatedAt = settingsRevisionAsOfRaw ? new Date(settingsRevisionAsOfRaw) : (run?.createdAt ?? null);
  const settingsChangedAfterRun = Boolean(run && profile && runEvaluatedAt && resultsPredateCurrentSettings(profile.updatedAt, runEvaluatedAt));
  const researchByTicker = new Map(researchItems.map((item) => [item.ticker, item.researchStatus]));
  const allResults = (run?.results ?? []).map((result) => toViewResult(result, researchByTicker));
  const isLiveSchwabRun = run?.source === "LIVE:SCHWAB";
  // Ethics research for just the tickers on screen; Record (not Map) because it crosses to a client component.
  const ethics = Object.fromEntries(await getEthicsSummariesForUser(user.id, allResults.map((result) => result.record.ticker)));
  // Company quality (SEC filings). Not set up (no table yet, or no SEC contact on the server) = nothing shown, nothing gated.
  const qualityState = await getCompanyQualityForUser(user.id, allResults.map((result) => result.record.ticker)).catch(() => ({ configured: false, secReady: false, byTicker: {} as Record<string, CompanyQualityView> }));
  const staleQualityTickers = qualityState.configured
    ? await tickersNeedingQualityRefresh(allResults.filter((result) => isWorthALook(funnelInputOf(result))).map((result) => result.record.ticker)).catch(() => [] as string[])
    : [];
  const planData = await loadPlanData(user.id, allResults, ethics, qualityState.configured ? Object.fromEntries(Object.entries(qualityState.byTicker).map(([ticker, view]) => [ticker, view.gate ? { eligible: view.gate.eligible, reason: view.gate.reason } : null])) : {});
  const diagnostics = buildExclusionDiagnostics(
    allResults.map((result) => ({ ticker: result.record.ticker, summary: result.summary })),
  );
  // These must use the same classifyReadiness answer as ScannerWorkspace's own filter chips/badges
  // (readiness, computed once in toViewResult) - two independent re-derivations of "near"/"pass"
  // here is exactly how this page's header count and its own "Near" filter used to disagree.
  const passCount = allResults.filter((result) => result.readiness === "PASS").length;
  const nearMatchCount = allResults.filter((result) => result.readiness === "NEAR").length;
  const unknownCount = allResults.filter((result) => result.readiness === "NEEDS_DATA").length;
  const funnel = buildScannerFunnel(allResults.map(funnelInputOf));
  // The saved list is capped (MAX_DISPLAYED_STOCK_STAGE_RESULTS non-Research rows), so when it's full
  // the funnel counts are a floor, not an exact total.
  const funnelTruncated = allResults.filter((result) => !researchByTicker.has(result.record.ticker)).length >= MAX_DISPLAYED_STOCK_STAGE_RESULTS;
  const scanIncomplete = describeScanIncomplete(funnel, { truncated: funnelTruncated });
  const optionOutcomes = summarizeOptionOutcomes(
    allResults.map((result) => ({
      readiness: result.readiness,
      optionEnrichment: result.values.optionEnrichment,
      contractReasonCode: result.contractReasonCode,
      criteria: result.summary.results,
    })),
  );
  const timingGuide = currentTimingGuide();
  const tooOldToFinish = scanTooOldToFinish(run?.createdAt ?? null);
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
          <ScannerModeTabs mode={mode} />
          <LiveScanButton />
          <IntentPrefetchLink
            href="/scanner/settings"
            title="Scanner Rules"
            aria-label="Scanner Rules"
            className={secondaryButtonClass}
          >
            <SlidersHorizontal className="size-3.5" aria-hidden />
          </IntentPrefetchLink>
          <details className="group relative">
            <summary className={`${secondaryButtonClass} list-none`}>
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

      <div data-testid="scanner-status-line" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-zinc-400">
        {run ? (
          <span>
            Scanned {shortRunTime(run.createdAt)} · <strong className="text-emerald-300">{passCount} pass</strong> · <strong className="text-amber-300">{nearMatchCount} near</strong>
          </span>
        ) : (
          <span>No scan yet - press Run Live Scan.</span>
        )}
        <span
          data-testid="scanner-timing-guide"
          data-phase={timingGuide.phase}
          title={timingGuide.detail}
          className={timingGuide.tone === "caution" ? "text-amber-300" : "text-sky-300"}
        >
          {timingGuide.headline}
        </span>
        <ScanAutoFinisher runId={isLiveSchwabRun && run ? run.id : null} awaitingOptionCheck={funnel.awaitingOptionCheck} qualityTickers={staleQualityTickers} enabled={isLiveSchwabRun && !settingsChangedAfterRun && !tooOldToFinish} />
      </div>

      {settingsChangedAfterRun ? (
        <div data-testid="settings-changed-after-run-warning" className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
          Your rules changed after this scan. Run Live Scan again to see results under the new rules.
        </div>
      ) : null}

      {showStaleTechnicalWarning ? (
        <div data-testid="stale-technical-cache-warning" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
          <span>
            Only {technicalFreshness.freshUsableCount.toLocaleString()} of {technicalFreshness.eligibleCount.toLocaleString()} stocks have today&apos;s RSI/Bollinger data, so this scan is missing names.{" "}
            <span className="text-amber-200/90" data-testid="technical-ready-hint">{currentTechnicalReadyHint()}</span>
          </span>
          <PrepareDataButton />
        </div>
      ) : null}

      {planData ? <PortfolioPlanPanel candidates={planData.candidates} existing={planData.existing} unknownExposureCount={planData.unknownCount} scanIncompleteNote={isLiveSchwabRun && scanIncomplete && !tooOldToFinish ? scanIncomplete.detail : null} priceAgeNote={isLiveSchwabRun ? picksPriceAgeNote(run?.createdAt ?? null) : null} /> : null}

      <details data-testid="scan-details" className="group rounded-md border border-zinc-800 bg-zinc-900/30 px-3 py-2 text-sm text-zinc-300">
        <summary className="cursor-pointer list-none text-zinc-400 hover:text-zinc-200">
          <span className="group-open:hidden">▸</span><span className="hidden group-open:inline">▾</span> Scan details
          {run ? <span className="text-zinc-500"> · {allResults.length} stocks listed · {funnel.awaitingOptionCheck > 0 ? `${funnel.awaitingOptionCheck} still to price` : "all qualifying options priced"}</span> : null}
        </summary>
        <div className="mt-2 space-y-2">
          <p className="text-zinc-300">{timingGuide.detail}</p>
          <ol className="list-decimal space-y-0.5 pl-5 text-xs text-zinc-400">
            <li><strong>Saturday afternoon or Sunday:</strong> run a scan to build the shortlist (RSI/Bollinger use Friday&apos;s close).</li>
            <li><strong>Monday 10:30 AM-12:30 PM ET:</strong> run a fresh scan; only names that still pass at live prices are worth placing.</li>
            <li><strong>Mon-Thu around 3:00 PM ET:</strong> check open positions on the Dashboard.</li>
            <li><strong>Friday around 3:00 PM ET:</strong> roll call on expiring positions.</li>
          </ol>
          {isLiveSchwabRun && allResults.length > 0 ? (
            <div data-testid="scanner-funnel" className="space-y-1">
              <p>{describeScannerFunnel(funnel, { truncated: funnelTruncated })}</p>
              {optionOutcomes.length > 0 ? (
                <p className="text-xs text-zinc-400" data-testid="scanner-option-outcomes">
                  Why priced names didn&apos;t pass: {describeOptionOutcomes(optionOutcomes)}
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-wrap items-start gap-3">
            {isLiveSchwabRun && funnel.awaitingOptionCheck > 0 && !tooOldToFinish ? <OptionCheckButton awaiting={funnel.awaitingOptionCheck} /> : null}
            {qualityState.configured && staleQualityTickers.length > 0 ? <CheckQualityButton tickers={staleQualityTickers} /> : null}
          </div>
          <p className="text-xs text-zinc-500">
            {allResults.length} candidates · {passCount} pass · {nearMatchCount} near · {unknownCount} missing data · average score {allResults.length ? averageScore : "N/A"}
          </p>
        </div>
      </details>

      <ScannerWorkspace results={allResults} buddies={buddies} diagnostics={diagnostics} modeLabel={run ? "showing" : "found"} ethics={ethics} quality={qualityState.byTicker} qualityEnabled={qualityState.configured} />
    </div>
  );
}

function shortRunTime(date: Date) {
  return `${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).format(date)} ET`;
}

function toViewResult(result: ScannerResult, researchByTicker: Map<string, ResearchStatus>): ScannerViewResult {
  const summary = toDomainSummary(result);
  const score = honestSetupScore(summary, GATING_RULE_KEYS);
  const optionEnrichment = snapshotString(result.snapshotJson, "optionEnrichment");
  const contractReasonCode = snapshotString(result.snapshotJson, "contractReasonCode");

  return {
    record: { id: result.id, ticker: result.ticker },
    summary,
    score,
    scoreLabel: honestSetupLabel(summary, GATING_RULE_KEYS),
    readiness: classifyReadiness(summary, GATING_RULE_KEYS, optionEnrichment, contractReasonCode),
    stockScreen: stockScreenVerdictOf(summary),
    gatingClear: !summary.results.some((criterion) => GATING_RULE_KEYS.has(criterion.key) && criterion.status !== "PASS"),
    contractReasonCode,
    technicalReasonCode: snapshotString(result.snapshotJson, "technicalReasonCode"),
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
      premiumBasis: snapshotString(result.snapshotJson, "premiumBasis") as "MARK_MIDPOINT" | null,
      optionBid: snapshotNumber(result.snapshotJson, "optionBid"),
      optionAsk: snapshotNumber(result.snapshotJson, "optionAsk"),
      midpoint: snapshotNumber(result.snapshotJson, "midpoint"),
      bidProceedsPerContract: snapshotNumber(result.snapshotJson, "bidProceedsPerContract"),
      delta: snapshotNumber(result.snapshotJson, "delta"),
      rsi: snapshotNumber(result.snapshotJson, "rsi"),
      bbPercent: snapshotNumber(result.snapshotJson, "bbPercent"),
      distanceOtmPercent: snapshotNumber(result.snapshotJson, "distanceOtmPercent"),
      ror: snapshotNumber(result.snapshotJson, "ror"),
      annualizedRor: snapshotNumber(result.snapshotJson, "annualizedRor"),
      rorBasis: snapshotString(result.snapshotJson, "rorBasis") as "BID" | null,
      spreadPercent: snapshotNumber(result.snapshotJson, "spreadPercent"),
      openInterest: snapshotNumber(result.snapshotJson, "openInterest"),
      optionVolume: snapshotNumber(result.snapshotJson, "optionVolume"),
      earningsDate: snapshotString(result.snapshotJson, "earningsDate"),
      earningsDistance: snapshotNumber(result.snapshotJson, "earningsDistance"),
      earningsWithinHoldingPeriod: snapshotBoolean(result.snapshotJson, "earningsWithinHoldingPeriod"),
      earningsFreeDaysAfterExpiry: snapshotNumber(result.snapshotJson, "earningsFreeDaysAfterExpiry"),
      earningsExitSessions: snapshotNumber(result.snapshotJson, "earningsExitSessions"),
      earningsVerifyReason: snapshotString(result.snapshotJson, "earningsVerifyReason"),
      optionQuotedAt: snapshotString(result.snapshotJson, "optionQuotedAt"),
      retrievedAt: snapshotString(result.snapshotJson, "retrievedAt"),
      retrievedOnNonTradingDay: snapshotBoolean(result.snapshotJson, "retrievedOnNonTradingDay"),
      optionEnrichment,
      scanNote: snapshotString(result.snapshotJson, "scanNote"),
    },
  };
}

/**
 * Inputs for the "Monday plan" panel: PASS/NEAR rows plus what is already committed. Wrapped so a problem here can
 * never take the whole Scanner page down - the panel simply does not render.
 */
async function loadPlanData(
  userId: string,
  results: ScannerViewResult[],
  ethics: Record<string, { gate: "OK" | "REVIEW" | "BLOCKED" | "UNREVIEWED" }>,
  qualityGates: Record<string, { eligible: boolean; reason: string } | null>,
) {
  try {
    const actionable = results.filter((result) => result.readiness === "PASS" || result.readiness === "NEAR");
    const [exposure, classification] = await Promise.all([getPlanExposureForUser(userId), getClassificationForTickers(actionable.map((result) => result.record.ticker))]);
    const gates = Object.fromEntries(Object.entries(ethics).map(([ticker, summary]) => [ticker, summary.gate]));
    const candidates = buildPlanCandidates(
      actionable.map((result) => ({
        ticker: result.record.ticker,
        readiness: result.readiness,
        gatingClear: result.gatingClear,
        score: result.score,
        values: {
          strike: result.values.strike,
          expiration: result.values.expiration,
          dte: result.values.dte,
          bidProceedsPerContract: result.values.bidProceedsPerContract,
          ror: result.values.ror,
          earningsVerifyReason: result.values.earningsVerifyReason,
        },
      })),
      gates,
      classification,
      qualityGates,
    );
    return { candidates, existing: exposure.existing, unknownCount: exposure.unknownCount };
  } catch {
    return null;
  }
}

/** Verdict over ONLY the stock-level criteria (the same STOCK_STAGE_RULE_KEYS the scan shortlists on). */
function stockScreenVerdictOf(summary: ScanSummary): StockScreenVerdict {
  const stock = summary.results.filter((criterion) => STOCK_STAGE_RULE_KEYS.has(criterion.key));
  if (stock.some((criterion) => criterion.status === "FAIL")) return "FAIL";
  if (stock.some((criterion) => criterion.status === "UNKNOWN")) return "UNKNOWN";
  return "PASS";
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

/** Unlike snapshotString/snapshotNumber, `false` is a real, meaningful value here (e.g.
 * "earnings do NOT fall within the holding period") - only a genuinely missing/non-boolean value
 * reads as unknown (null), never coerced from a truthy/falsy check the way the other two do. */
function snapshotBoolean(snapshot: unknown, key: string) {
  if (!snapshot || typeof snapshot !== "object" || !(key in snapshot)) {
    return null;
  }

  const value = (snapshot as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : null;
}
