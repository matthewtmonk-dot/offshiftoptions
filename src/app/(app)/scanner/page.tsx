import { Fragment } from "react";
import Link from "next/link";
import {
  ArrowDownUp,
  BarChart3,
  CheckCircle2,
  CircleAlert,
  Gauge,
  RefreshCw,
  Search,
  Send,
  SlidersHorizontal,
  Sparkles,
  Target,
} from "lucide-react";
import { Badge, EmptyState, FieldLabel, Panel, StatusBadge } from "@/components/ui";
import { RECOMMENDATION_REASON_TAGS } from "@/domain/social/recommendations";
import {
  buildExclusionDiagnostics,
  formatCriterionValue,
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
import { requireCurrentUser } from "@/lib/auth";
import { getScannerPageData } from "@/lib/app-data";
import { money, percent, shortDate, shortDateTime, toNumber } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { ensureMyLstScannerProfileForUser } from "@/lib/workflows";
import { recommendStockAction, runDemoScannerAction, runLiveSchwabScannerAction } from "../actions";

export const dynamic = "force-dynamic";

type ScannerSearchParams = {
  error?: string;
  mode?: string;
  quick?: string;
  sort?: string;
};

type BadgeTone = "neutral" | "good" | "bad" | "warn" | "info";
type SortKey =
  | "score"
  | "ticker"
  | "price"
  | "rsi"
  | "bbPercent"
  | "premium"
  | "ror"
  | "annualizedRor"
  | "dte"
  | "delta"
  | "optionVolume"
  | "openInterest"
  | "spreadPercent"
  | "earningsDistance";

type QuickKey = "all" | "strongest" | "premium" | "liquid" | "low-rsi" | "far-earnings" | "near" | "watchlist";
type ScannerResult = NonNullable<Awaited<ReturnType<typeof getScannerPageData>>>["scanRuns"][number]["results"][number];

const sortOptions: { key: SortKey; label: string }[] = [
  { key: "score", label: "Score" },
  { key: "ticker", label: "Ticker" },
  { key: "price", label: "Price" },
  { key: "rsi", label: "RSI" },
  { key: "bbPercent", label: "BB %" },
  { key: "premium", label: "Premium" },
  { key: "ror", label: "ROR" },
  { key: "annualizedRor", label: "Annualized" },
  { key: "dte", label: "DTE" },
  { key: "delta", label: "Delta" },
  { key: "optionVolume", label: "Volume" },
  { key: "openInterest", label: "Open interest" },
  { key: "spreadPercent", label: "Spread" },
  { key: "earningsDistance", label: "Earnings" },
];

const quickFilters: { key: QuickKey; label: string; sort?: SortKey }[] = [
  { key: "all", label: "All setups", sort: "score" },
  { key: "strongest", label: "Strongest", sort: "score" },
  { key: "premium", label: "Best premium", sort: "premium" },
  { key: "liquid", label: "Most liquid", sort: "openInterest" },
  { key: "low-rsi", label: "Lowest RSI", sort: "rsi" },
  { key: "far-earnings", label: "Far from earnings", sort: "earningsDistance" },
  { key: "near", label: "Near matches", sort: "score" },
  { key: "watchlist", label: "Watchlist only", sort: "score" },
];

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const ruleOrder = new Map(SCANNER_RULE_DEFINITIONS.map((definition, index) => [definition.name, index]));
const ruleKeyByName = new Map(SCANNER_RULE_DEFINITIONS.map((definition) => [definition.name, definition.key]));

export default async function ScannerPage({
  searchParams,
}: {
  searchParams: Promise<ScannerSearchParams>;
}) {
  const user = await requireCurrentUser();
  await ensureMyLstScannerProfileForUser(user.id);

  const params = await searchParams;
  const mode = params.mode === "filter" ? "filter" : "score";
  const quick = normalizeQuick(params.quick);
  const sort = normalizeSort(params.sort) ?? quickFilters.find((filter) => filter.key === quick)?.sort ?? "score";
  const [profile, buddies, watchlistItems] = await Promise.all([
    getScannerPageData(user.id),
    prisma.user.findMany({ where: { id: { not: user.id } }, orderBy: { name: "asc" } }),
    prisma.watchlistItem.findMany({
      where: {
        OR: [{ ownerId: user.id }, { visibility: "SHARED" }],
      },
      select: { ticker: true },
    }),
  ]);
  const run = profile?.scanRuns[0];
  const watchlistTickers = new Set(watchlistItems.map((item) => item.ticker));
  const allResults = (run?.results ?? []).map((result) => toViewResult(result, watchlistTickers));
  const isLiveSchwabRun = run?.source === "LIVE:SCHWAB";
  const diagnostics = buildExclusionDiagnostics(
    allResults.map((result) => ({ ticker: result.record.ticker, summary: result.summary })),
  );
  const nearMatchCount = allResults.filter((result) => result.nearMisses.length === 1).length;
  const passCount = allResults.filter((result) => result.summary.status === "PASS").length;
  const unknownCount = allResults.filter((result) => result.summary.status === "UNKNOWN").length;
  const averageScore = allResults.length
    ? Math.round(allResults.reduce((sum, result) => sum + result.score, 0) / allResults.length)
    : 0;
  const filteredResults = sortResults(applyQuickFilter(applyMode(allResults, mode), quick), sort);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-medium text-emerald-300">
            {isLiveSchwabRun ? "Live Schwab market scan" : "Demo scanner profile"}
          </p>
          <h1 className="text-3xl font-semibold text-zinc-50">My LST Scanner</h1>
          <p className="mt-2 max-w-2xl text-sm text-zinc-400">
            Score setups, spot near misses, and see exactly which rule is thinning the list.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <form action={runLiveSchwabScannerAction}>
            <button
              type="submit"
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-sky-400/40 bg-sky-400/10 px-3 text-sm font-medium text-sky-100 transition hover:border-sky-300 hover:bg-sky-400/15"
            >
              <RefreshCw className="size-4" aria-hidden />
              Run live Schwab scan
            </button>
          </form>
          <form action={runDemoScannerAction}>
            <button
              type="submit"
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-200 transition hover:border-sky-400/60 hover:text-sky-200"
            >
              <RefreshCw className="size-4" aria-hidden />
              Refresh demo scan
            </button>
          </form>
          <Link
            href="/scanner/settings"
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-200 transition hover:border-emerald-400/60 hover:text-emerald-200"
          >
            <SlidersHorizontal className="size-4" aria-hidden />
            Scanner Rules
          </Link>
        </div>
      </div>

      {params.error ? (
        <div className="rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-100">
          {params.error}
        </div>
      ) : null}

      {isLiveSchwabRun ? (
        <div className="rounded-md border border-sky-400/30 bg-sky-400/10 px-3 py-2 text-sm text-sky-100">
          LIVE • SCHWAB market data. OSO still calculates RSI, Bollinger position, returns, scores, and PASS/FAIL/UNKNOWN.
        </div>
      ) : (
        <div className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
          Demo/mock data - not live market or option-chain data. Use the live Schwab scan after OAuth and server environment variables are ready.
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <PulseTile icon={BarChart3} label="Candidates" value={allResults.length ? numberFormat.format(allResults.length) : "0"} tone="info" />
        <PulseTile icon={CheckCircle2} label="Clean passes" value={numberFormat.format(passCount)} tone="good" />
        <PulseTile icon={Sparkles} label="Near matches" value={numberFormat.format(nearMatchCount)} tone="warn" />
        <PulseTile icon={CircleAlert} label="Unknowns" value={numberFormat.format(unknownCount)} tone="neutral" />
        <PulseTile icon={Gauge} label="Avg setup score" value={allResults.length ? averageScore : "N/A"} tone={scoreTone(averageScore)} />
      </section>

      <Panel title="Scanner Controls">
        <div className="grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
          <div>
            <FieldLabel>Mode</FieldLabel>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <ControlLink href={scannerHref({ mode: "score", quick, sort })} active={mode === "score"}>
                <Gauge className="size-4" aria-hidden />
                Score
              </ControlLink>
              <ControlLink href={scannerHref({ mode: "filter", quick: quick === "near" ? "all" : quick, sort })} active={mode === "filter"}>
                <Target className="size-4" aria-hidden />
                Filter
              </ControlLink>
            </div>
          </div>
          <div>
            <FieldLabel>Quick filters</FieldLabel>
            <div className="mt-2 flex flex-wrap gap-2">
              {quickFilters.map((filter) => (
                <ControlLink
                  key={filter.key}
                  href={scannerHref({
                    mode: filter.key === "near" ? "score" : mode,
                    quick: filter.key,
                    sort: filter.sort ?? sort,
                  })}
                  active={quick === filter.key}
                  compact
                >
                  {filter.label}
                </ControlLink>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-4">
          <FieldLabel>Sort by</FieldLabel>
          <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
            {sortOptions.map((option) => (
              <ControlLink
                key={option.key}
                href={scannerHref({ mode, quick, sort: option.key })}
                active={sort === option.key}
                compact
              >
                <ArrowDownUp className="size-3.5" aria-hidden />
                {option.label}
              </ControlLink>
            ))}
          </div>
        </div>
      </Panel>

      <Panel title={`Why ${mode === "filter" ? "Filter Mode" : "Score Mode"} Shows ${filteredResults.length}`}>
        <div className="grid gap-4 lg:grid-cols-[0.65fr_1.35fr]">
          <div className="rounded-md border border-zinc-800 bg-zinc-950 p-4">
            <div className="text-sm text-zinc-400">Starting universe</div>
            <div className="mt-1 text-3xl font-semibold text-zinc-50">{diagnostics.startingUniverse}</div>
            <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-zinc-500">Final passes</div>
                <div className="font-semibold text-emerald-200">{diagnostics.finalMatches}</div>
              </div>
              <div>
                <div className="text-zinc-500">Unknown-only</div>
                <div className="font-semibold text-zinc-200">{diagnostics.unknownOnly}</div>
              </div>
            </div>
          </div>
          <div className="space-y-3">
            {diagnostics.removals.map((removal) => (
              <div key={removal.criterionName}>
                <div className="mb-1 flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium text-zinc-200">{removal.criterionName}</span>
                  <span className="text-zinc-400">-{removal.count}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-red-400"
                    style={{ width: `${diagnostics.startingUniverse ? (removal.count / diagnostics.startingUniverse) * 100 : 0}%` }}
                  />
                </div>
                <div className="mt-1 text-xs text-zinc-500">{removal.tickers.slice(0, 5).join(", ")}</div>
              </div>
            ))}
            {diagnostics.removals.length === 0 ? <EmptyState>No rule has removed a candidate in this run.</EmptyState> : null}
          </div>
        </div>
      </Panel>

      <Panel
        title={run ? `${filteredResults.length} Ranked Candidates` : "Latest Run"}
        action={
          <div className="flex items-center gap-2">
            <Badge tone={isLiveSchwabRun ? "info" : "warn"}>{isLiveSchwabRun ? "LIVE • SCHWAB" : "DEMO"}</Badge>
            {run ? <Badge tone="neutral">{shortDateTime(run.createdAt)}</Badge> : null}
          </div>
        }
      >
        <div className="hidden overflow-x-auto lg:block">
          <table className="w-full min-w-[920px] border-separate border-spacing-0 text-left text-xs xl:min-w-0">
            <thead>
              <tr className="text-xs uppercase tracking-normal text-zinc-500">
                <th className="border-b border-zinc-800 px-3 py-3">Ticker</th>
                <th className="border-b border-zinc-800 px-3 py-3">Setup</th>
                <th className="border-b border-zinc-800 px-3 py-3">Status</th>
                <th className="border-b border-zinc-800 px-3 py-3">Price</th>
                <th className="border-b border-zinc-800 px-3 py-3">RSI / BB</th>
                <th className="border-b border-zinc-800 px-3 py-3">DTE</th>
                <th className="border-b border-zinc-800 px-3 py-3">Strike</th>
                <th className="border-b border-zinc-800 px-3 py-3">Premium</th>
                <th className="border-b border-zinc-800 px-3 py-3">ROR</th>
                <th className="border-b border-zinc-800 px-3 py-3">OI / Vol</th>
                <th className="border-b border-zinc-800 px-3 py-3">Spread</th>
                <th className="border-b border-zinc-800 px-3 py-3">Earnings</th>
              </tr>
            </thead>
            <tbody>
              {filteredResults.map((result) => (
                <Fragment key={result.record.id}>
                  <tr className="align-top transition hover:bg-zinc-900/55">
                    <td className="border-b border-zinc-900 px-3 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-lg font-semibold text-zinc-50">{result.record.ticker}</span>
                        {result.inWatchlist ? <Badge tone="info">Watch</Badge> : null}
                      </div>
                    </td>
                    <td className="border-b border-zinc-900 px-3 py-3">
                      <ScoreChip score={result.score} label={result.scoreLabel} />
                    </td>
                    <td className="border-b border-zinc-900 px-3 py-3">
                      <StatusBadge status={result.summary.status} />
                      {result.nearMisses.length === 1 ? (
                        <div className="mt-2">
                          <Badge tone="warn">Near match</Badge>
                        </div>
                      ) : null}
                    </td>
                    <td className="border-b border-zinc-900 px-3 py-3">{moneyOrUnknown(result.values.price)}</td>
                    <td className="border-b border-zinc-900 px-3 py-3">
                      {numberOrUnknown(result.values.rsi, 1)} / {percentOrUnknown(result.values.bbPercent)}
                    </td>
                    <td className="border-b border-zinc-900 px-3 py-3">{plainOrUnknown(result.values.dte)}</td>
                    <td className="border-b border-zinc-900 px-3 py-3">{moneyOrUnknown(result.values.strike)}</td>
                    <td className="border-b border-zinc-900 px-3 py-3">{moneyOrUnknown(result.values.premium)}</td>
                    <td className="border-b border-zinc-900 px-3 py-3">{percentOrUnknown(result.values.ror)}</td>
                    <td className="border-b border-zinc-900 px-3 py-3">
                      {plainOrUnknown(result.values.openInterest)} / {plainOrUnknown(result.values.optionVolume)}
                    </td>
                    <td className="border-b border-zinc-900 px-3 py-3">{percentOrUnknown(result.values.spreadPercent)}</td>
                    <td className="border-b border-zinc-900 px-3 py-3">{plainOrUnknown(result.values.earningsDistance)} days</td>
                  </tr>
                  <tr>
                    <td colSpan={12} className="border-b border-zinc-900 px-3 py-2">
                      <details>
                        <summary className="inline-flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-md border border-zinc-700 px-3 text-xs font-medium text-zinc-300 transition hover:border-emerald-400/60 hover:text-emerald-200">
                          <Search className="size-3.5" aria-hidden />
                          Inspect {result.record.ticker}
                        </summary>
                        <CandidateInspector result={result} buddies={buddies} />
                      </details>
                    </td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid gap-4 lg:hidden">
          {filteredResults.map((result) => (
            <CandidateCard key={result.record.id} result={result} buddies={buddies} />
          ))}
        </div>
        {!filteredResults.length ? <EmptyState>No scanner candidates match this view.</EmptyState> : null}
      </Panel>
    </div>
  );
}

function CandidateCard({
  result,
  buddies,
}: {
  result: ScannerViewResult;
  buddies: Awaited<ReturnType<typeof prisma.user.findMany>>;
}) {
  return (
    <article className={`rounded-lg border bg-zinc-900 p-4 ${resultBorder(result.summary.status, result.nearMisses.length)}`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-semibold text-zinc-50">{result.record.ticker}</h2>
            <StatusBadge status={result.summary.status} />
            {result.nearMisses.length === 1 ? <Badge tone="warn">Near match</Badge> : null}
            {result.inWatchlist ? <Badge tone="info">Watchlist</Badge> : null}
          </div>
          <p className="mt-1 text-sm text-zinc-400">
            {result.summary.passed} / {result.summary.total} criteria passed
          </p>
        </div>
        <ScoreRing score={result.score} label={result.scoreLabel} />
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <Datum label="Price" value={moneyOrUnknown(result.values.price)} />
        <Datum label="Strike" value={moneyOrUnknown(result.values.strike)} />
        <Datum label="DTE" value={plainOrUnknown(result.values.dte)} />
        <Datum label="Premium" value={moneyOrUnknown(result.values.premium)} />
        <Datum label="ROR" value={percentOrUnknown(result.values.ror)} />
        <Datum label="Spread" value={percentOrUnknown(result.values.spreadPercent)} />
        <Datum label="RSI" value={numberOrUnknown(result.values.rsi, 1)} />
        <Datum label="Earnings" value={`${plainOrUnknown(result.values.earningsDistance)} days`} />
      </dl>

      <div className="mt-4 rounded-md border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-300">
        {result.nearMisses[0]?.message ?? result.concern?.explanation ?? "Clean pass. Keep the checklist handy."}
      </div>

      <details className="mt-3">
        <summary className="inline-flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-300 transition hover:border-emerald-400/60 hover:text-emerald-200">
          <Search className="size-4" aria-hidden />
          Inspect setup
        </summary>
        <CandidateInspector result={result} buddies={buddies} />
      </details>
    </article>
  );
}

function CandidateInspector({
  result,
  buddies,
}: {
  result: ScannerViewResult;
  buddies: Awaited<ReturnType<typeof prisma.user.findMany>>;
}) {
  return (
    <div className="mt-4 grid gap-5 rounded-md border border-zinc-800 bg-zinc-950 p-4 xl:grid-cols-[1fr_1fr_0.8fr]">
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-normal text-zinc-400">Stock</h3>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <Datum label="Ticker" value={result.record.ticker} />
          <Datum label="Current price" value={moneyOrUnknown(result.values.price)} />
          <Datum label="Change" value={signedPercent(result.values.priceChangePercent)} />
          <Datum label="RSI" value={numberOrUnknown(result.values.rsi, 1)} />
          <Datum label="BB position" value={percentOrUnknown(result.values.bbPercent)} />
          <Datum label="Volume" value={plainOrUnknown(result.values.stockVolume)} />
          <Datum label="Earnings" value={dateOrUnknown(result.values.earningsDate)} />
          <Datum label="Days to earnings" value={plainOrUnknown(result.values.earningsDistance)} />
        </dl>
      </section>
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-normal text-zinc-400">Option</h3>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <Datum label="Expiration" value={dateOrUnknown(result.values.expiration)} />
          <Datum label="DTE" value={plainOrUnknown(result.values.dte)} />
          <Datum label="Strike" value={moneyOrUnknown(result.values.strike)} />
          <Datum label="Distance OTM" value={percentOrUnknown(result.values.distanceOtmPercent)} />
          <Datum label="Bid" value={moneyOrUnknown(result.values.optionBid)} />
          <Datum label="Ask" value={moneyOrUnknown(result.values.optionAsk)} />
          <Datum label="Midpoint" value={moneyOrUnknown(result.values.midpoint)} />
          <Datum label="Delta" value={numberOrUnknown(result.values.delta, 2)} />
          <Datum label="Open interest" value={plainOrUnknown(result.values.openInterest)} />
          <Datum label="Option volume" value={plainOrUnknown(result.values.optionVolume)} />
          <Datum label="Spread" value={percentOrUnknown(result.values.spreadPercent)} />
          <Datum label="ROR" value={percentOrUnknown(result.values.ror)} />
        </dl>
      </section>
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-normal text-zinc-400">Criteria</h3>
        <div className="mt-3 space-y-2">
          {result.summary.results.map((criterion) => (
            <details key={criterion.name} className="rounded-md border border-zinc-800 bg-zinc-900/70 p-3 text-sm">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                <span className="font-medium text-zinc-100">{criterion.name}</span>
                <StatusBadge status={criterion.status} />
              </summary>
              <dl className="mt-3 grid gap-2 text-sm">
                <Datum label="Actual" value={formatCriterionValue(criterion.actualValue)} />
                <Datum label="Rule" value={`${criterion.operator} ${formatCriterionValue(criterion.desiredValue)}`} />
                <Datum label="Explanation" value={criterion.explanation} />
              </dl>
            </details>
          ))}
        </div>
        <div className="mt-4">
          <RecommendMiniForm ticker={result.record.ticker} buddies={buddies} returnTo="/scanner" />
        </div>
      </section>
    </div>
  );
}

function RecommendMiniForm({
  ticker,
  buddies,
  returnTo,
}: {
  ticker: string;
  buddies: Awaited<ReturnType<typeof prisma.user.findMany>>;
  returnTo: string;
}) {
  return (
    <form action={recommendStockAction} className="space-y-2">
      <input type="hidden" name="ticker" value={ticker} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <FieldLabel>Send to buddy</FieldLabel>
      <select
        name="recipientId"
        className="min-h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100"
        required
        aria-label={`Recommend ${ticker} to buddy`}
      >
        {buddies.map((buddy) => (
          <option key={buddy.id} value={buddy.id}>
            {buddy.name}
          </option>
        ))}
      </select>
      <input
        name="message"
        className="min-h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100"
        defaultValue={`Take a look at ${ticker}.`}
        aria-label={`Recommendation message for ${ticker}`}
      />
      <div className="grid grid-cols-2 gap-2">
        {RECOMMENDATION_REASON_TAGS.slice(0, 4).map((tag) => (
          <label key={tag} className="flex min-h-9 items-center gap-2 rounded-md border border-zinc-800 px-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              name="reasonTags"
              value={tag}
              defaultChecked={tag === "Scanner looks good" || tag === "Worth researching"}
              className="size-3.5 accent-emerald-400"
            />
            <span>{tag}</span>
          </label>
        ))}
      </div>
      <button
        type="submit"
        className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-md bg-emerald-400 px-3 text-sm font-semibold text-zinc-950 hover:bg-emerald-300"
      >
        <Send className="size-4" aria-hidden />
        Recommend
      </button>
    </form>
  );
}

function PulseTile({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof BarChart3;
  label: string;
  value: React.ReactNode;
  tone: BadgeTone;
}) {
  return (
    <div className={`rounded-lg border bg-zinc-900 p-4 ${toneBorder(tone)}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs uppercase tracking-normal text-zinc-500">{label}</div>
        <Icon className={`size-4 ${toneText(tone)}`} aria-hidden />
      </div>
      <div className="mt-2 text-2xl font-semibold text-zinc-50">{value}</div>
    </div>
  );
}

function ControlLink({
  href,
  active,
  compact,
  children,
}: {
  href: string;
  active: boolean;
  compact?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium transition ${
        active
          ? "border-emerald-400/70 bg-emerald-400/15 text-emerald-100"
          : "border-zinc-800 bg-zinc-950 text-zinc-300 hover:border-zinc-600 hover:text-zinc-50"
      } ${compact ? "min-h-9 text-xs" : ""}`}
    >
      {children}
    </Link>
  );
}

function ScoreRing({ score, label }: { score: number; label: string }) {
  const color = scoreColor(score, label);

  return (
    <div className="flex shrink-0 flex-col items-center gap-1">
      <div
        className="grid size-16 place-items-center rounded-full"
        style={{
          background: `conic-gradient(${color} ${score * 3.6}deg, rgb(39 39 42) 0deg)`,
        }}
        aria-label={`Setup score ${score}, ${label}`}
      >
        <div className="grid size-12 place-items-center rounded-full bg-zinc-950 text-lg font-semibold text-zinc-50">
          {score}
        </div>
      </div>
      <span className="text-[11px] font-medium text-zinc-400">{label}</span>
    </div>
  );
}

function ScoreChip({ score, label }: { score: number; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`inline-flex min-w-11 justify-center rounded-md border px-2 py-1 text-sm font-semibold ${scoreChipClass(score, label)}`}>
        {score}
      </span>
      <span className="text-zinc-300">{label}</span>
    </div>
  );
}

function Datum({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-normal text-zinc-500">{label}</dt>
      <dd className="mt-1 break-words font-medium text-zinc-100">{value}</dd>
    </div>
  );
}

type ScannerViewResult = {
  record: ScannerResult;
  summary: ScanSummary;
  score: number;
  scoreLabel: ReturnType<typeof honestSetupLabel>;
  nearMisses: ReturnType<typeof getNearMisses>;
  concern: CriterionResult | null;
  inWatchlist: boolean;
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
  };
};

function toViewResult(result: ScannerResult, watchlistTickers: Set<string>): ScannerViewResult {
  const summary = toDomainSummary(result);
  const score = honestSetupScore(summary, GATING_RULE_KEYS);

  return {
    record: result,
    summary,
    score,
    scoreLabel: honestSetupLabel(summary, GATING_RULE_KEYS),
    nearMisses: getNearMisses(summary.results),
    concern: primaryConcern(summary.results),
    inWatchlist: watchlistTickers.has(result.ticker),
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

function applyMode(results: ScannerViewResult[], mode: "score" | "filter") {
  return mode === "filter" ? results.filter((result) => result.summary.status === "PASS") : results;
}

function applyQuickFilter(results: ScannerViewResult[], quick: QuickKey) {
  switch (quick) {
    case "strongest":
      return results.filter((result) => result.score >= 90);
    case "premium":
      return results.filter((result) => result.values.premium !== null);
    case "liquid":
      return results.filter(
        (result) => (result.values.openInterest ?? 0) >= 500 && (result.values.optionVolume ?? 0) >= 100,
      );
    case "low-rsi":
      return results.filter((result) => result.values.rsi !== null && result.values.rsi <= 50);
    case "far-earnings":
      return results.filter((result) => (result.values.earningsDistance ?? 0) >= 30);
    case "near":
      return results.filter((result) => result.nearMisses.length === 1);
    case "watchlist":
      return results.filter((result) => result.inWatchlist);
    default:
      return results;
  }
}

function sortResults(results: ScannerViewResult[], sort: SortKey) {
  return [...results].sort((left, right) => {
    if (sort === "ticker") {
      return left.record.ticker.localeCompare(right.record.ticker);
    }

    if (sort === "rsi" || sort === "spreadPercent" || sort === "dte" || sort === "price") {
      return compareNumbersAsc(left, right, sort);
    }

    return compareNumbersDesc(left, right, sort);
  });
}

function compareNumbersAsc(left: ScannerViewResult, right: ScannerViewResult, key: SortKey) {
  return valueForSort(left, key) - valueForSort(right, key) || left.record.ticker.localeCompare(right.record.ticker);
}

function compareNumbersDesc(left: ScannerViewResult, right: ScannerViewResult, key: SortKey) {
  return valueForSort(right, key) - valueForSort(left, key) || left.record.ticker.localeCompare(right.record.ticker);
}

function valueForSort(result: ScannerViewResult, key: SortKey) {
  if (key === "score") {
    return result.score;
  }
  if (key === "ticker") {
    return 0;
  }

  return result.values[key] ?? Number.NEGATIVE_INFINITY;
}

function normalizeSort(value: string | undefined): SortKey | null {
  return sortOptions.some((option) => option.key === value) ? (value as SortKey) : null;
}

function normalizeQuick(value: string | undefined): QuickKey {
  return quickFilters.some((filter) => filter.key === value) ? (value as QuickKey) : "all";
}

function scannerHref({ mode, quick, sort }: { mode?: string; quick?: QuickKey; sort?: SortKey }) {
  const params = new URLSearchParams();
  if (mode && mode !== "score") {
    params.set("mode", mode);
  }
  if (quick && quick !== "all") {
    params.set("quick", quick);
  }
  if (sort && sort !== "score") {
    params.set("sort", sort);
  }
  const query = params.toString();
  return query ? `/scanner?${query}` : "/scanner";
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

function moneyOrUnknown(value: number | null) {
  return value === null ? "UNKNOWN" : money(value);
}

function percentOrUnknown(value: number | null) {
  return value === null ? "UNKNOWN" : percent(value);
}

function numberOrUnknown(value: number | null, digits: number) {
  return value === null ? "UNKNOWN" : toNumber(value).toFixed(digits);
}

function plainOrUnknown(value: number | null) {
  return value === null ? "UNKNOWN" : numberFormat.format(value);
}

function dateOrUnknown(value: string | null) {
  return value ? shortDate(value) : "UNKNOWN";
}

function signedPercent(value: number | null) {
  if (value === null) {
    return "UNKNOWN";
  }

  return `${value > 0 ? "+" : ""}${percent(value)}`;
}

function scoreTone(score: number): BadgeTone {
  if (score >= 90) {
    return "good";
  }
  if (score >= 78) {
    return "info";
  }
  if (score >= 45) {
    return "warn";
  }
  return "bad";
}

function toneBorder(tone: BadgeTone) {
  if (tone === "good") {
    return "border-emerald-400/30";
  }
  if (tone === "bad") {
    return "border-red-400/30";
  }
  if (tone === "warn") {
    return "border-amber-400/30";
  }
  if (tone === "info") {
    return "border-sky-400/30";
  }
  return "border-zinc-800";
}

function toneText(tone: BadgeTone) {
  if (tone === "good") {
    return "text-emerald-300";
  }
  if (tone === "bad") {
    return "text-red-300";
  }
  if (tone === "warn") {
    return "text-amber-300";
  }
  if (tone === "info") {
    return "text-sky-300";
  }
  return "text-zinc-400";
}

function scoreColor(score: number, label?: string) {
  if (label === "Verify") {
    return "rgb(161 161 170)";
  }
  if (label === "Fails" || score < 45) {
    return "rgb(248 113 113)";
  }
  if (score >= 90) {
    return "rgb(52 211 153)";
  }
  if (score >= 78) {
    return "rgb(56 189 248)";
  }
  return "rgb(251 191 36)";
}

function scoreChipClass(score: number, label?: string) {
  if (label === "Verify") {
    return "border-zinc-600 bg-zinc-800 text-zinc-300";
  }
  if (label === "Fails" || score < 45) {
    return "border-red-400/40 bg-red-400/15 text-red-100";
  }
  if (score >= 90) {
    return "border-emerald-400/40 bg-emerald-400/15 text-emerald-100";
  }
  if (score >= 78) {
    return "border-sky-400/40 bg-sky-400/15 text-sky-100";
  }
  return "border-amber-400/40 bg-amber-400/15 text-amber-100";
}

function resultBorder(status: CriterionStatus, nearMisses: number) {
  if (status === "PASS") {
    return "border-emerald-400/35";
  }
  if (nearMisses === 1) {
    return "border-amber-400/35";
  }
  if (status === "FAIL") {
    return "border-red-400/25";
  }
  return "border-zinc-800";
}
