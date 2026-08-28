import Link from "next/link";
import { Send, SlidersHorizontal } from "lucide-react";
import { Badge, EmptyState, FieldLabel, Metric, Panel, StatusBadge } from "@/components/ui";
import { RECOMMENDATION_REASON_TAGS } from "@/domain/social/recommendations";
import {
  formatRuleDesired,
  getRuleDesired,
  getScannerRuleDefinition,
} from "@/domain/scanner/profile";
import { requireCurrentUser } from "@/lib/auth";
import { getScannerPageData } from "@/lib/app-data";
import { money, percent, shortDate, toNumber } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { recommendStockAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function ScannerPage() {
  const user = await requireCurrentUser();
  const [profile, buddies] = await Promise.all([
    getScannerPageData(user.id),
    prisma.user.findMany({ where: { id: { not: user.id } }, orderBy: { name: "asc" } }),
  ]);
  const run = profile?.scanRuns[0];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-medium text-emerald-300">Demo scanner profile</p>
          <h1 className="text-3xl font-semibold text-zinc-50">My LST Scanner</h1>
        </div>
        <Link
          href="/scanner/settings"
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 text-sm font-medium text-zinc-200 transition hover:border-emerald-400/60 hover:text-emerald-200"
        >
          <SlidersHorizontal className="size-4" aria-hidden />
          Settings
        </Link>
      </div>

      <div className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
        Demo/mock data — not live market or option-chain data. Results will switch to real Schwab data once that
        integration is connected.
      </div>

      <Panel title="Rules">
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {profile?.rules.map((rule) => {
            const definition = getScannerRuleDefinition(rule.key);
            const desired = getRuleDesired(rule.valueJson, definition?.defaultDesired ?? "");
            return (
              <div key={rule.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="font-medium text-zinc-100">{rule.name}</div>
                  <Badge tone={rule.enabled ? "info" : "neutral"}>{rule.enabled ? "ON" : "OFF"}</Badge>
                </div>
                <div className="mt-1 text-sm text-zinc-400">{formatRuleDesired(rule.operator, desired)}</div>
                {definition ? <div className="mt-2 text-xs text-zinc-500">{definition.explanation}</div> : null}
              </div>
            );
          })}
          {!profile?.rules.length ? <EmptyState>No scanner rules are seeded yet.</EmptyState> : null}
        </div>
      </Panel>

      <Panel title={run ? `Run ${run.source}` : "Latest Run"}>
        <div className="grid gap-4 xl:grid-cols-2">
          {run?.results.map((result) => (
            <ScannerResultCard key={result.id} result={result} buddies={buddies} />
          ))}
          {!run?.results.length ? <EmptyState>No scan results are seeded yet.</EmptyState> : null}
        </div>
      </Panel>

      <Panel title="Scanner Notes">
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <FieldLabel>Values</FieldLabel>
            <p className="mt-1 text-sm text-zinc-400">Phase 1 values are demo/manual, not live option-chain data.</p>
          </div>
          <div>
            <FieldLabel>Outcome</FieldLabel>
            <p className="mt-1 text-sm text-zinc-400">The summary is derived from individual criterion results.</p>
          </div>
          <div>
            <FieldLabel>Unknown</FieldLabel>
            <p className="mt-1 text-sm text-zinc-400">Missing data remains UNKNOWN instead of being forced into a pass/fail bucket.</p>
          </div>
        </div>
      </Panel>
    </div>
  );
}

type ScannerResult = NonNullable<Awaited<ReturnType<typeof getScannerPageData>>>["scanRuns"][number]["results"][number];

function ScannerResultCard({
  result,
  buddies,
}: {
  result: ScannerResult;
  buddies: Awaited<ReturnType<typeof prisma.user.findMany>>;
}) {
  const snapshot = result.snapshotJson;
  const stockPrice = snapshotValue(snapshot, "price");
  const strike = snapshotValue(snapshot, "strike");
  const expiration = snapshotString(snapshot, "expiration");
  const dte = snapshotValue(snapshot, "dte");
  const premium = snapshotValue(snapshot, "premium");
  const delta = snapshotValue(snapshot, "delta");
  const ror = snapshotValue(snapshot, "ror");
  const rsi = snapshotValue(snapshot, "rsi");
  const bbPercent = snapshotValue(snapshot, "bbPercent");

  return (
    <article className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-semibold text-zinc-50">{result.ticker}</h2>
            <StatusBadge status={result.summaryStatus} />
            <Badge tone="warn">DEMO</Badge>
          </div>
          <p className="mt-1 text-sm text-zinc-400">
            {result.passedCriteria} / {result.totalCriteria} criteria passed
          </p>
        </div>
        <RecommendMiniForm ticker={result.ticker} buddies={buddies} returnTo="/scanner" />
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Stock price" value={stockPrice === null ? "UNKNOWN" : money(stockPrice)} />
        <Metric label="Strike" value={strike === null ? "UNKNOWN" : money(strike)} />
        <Metric label="Expiration" value={expiration ? shortDate(expiration) : "UNKNOWN"} />
        <Metric label="DTE" value={dte === null ? "UNKNOWN" : dte} />
        <Metric label="Premium" value={premium === null ? "UNKNOWN" : money(premium)} />
        <Metric label="Abs delta" value={delta === null ? "UNKNOWN" : toNumber(delta).toFixed(2)} />
        <Metric label="ROR" value={ror === null ? "UNKNOWN" : percent(ror)} />
        <Metric label="RSI / BB %" value={`${rsi === null ? "UNKNOWN" : toNumber(rsi).toFixed(1)} / ${bbPercent === null ? "UNKNOWN" : percent(bbPercent)}`} />
      </div>

      <div className="mt-4 space-y-2">
        {result.criterionResults.map((criterion) => (
          <details key={criterion.id} className="rounded-md border border-zinc-800 bg-zinc-950 p-3 text-sm">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
              <span className="font-medium text-zinc-100">{criterion.criterionName}</span>
              <StatusBadge status={criterion.status} />
            </summary>
            <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
              <div>
                <dt className="text-zinc-500">Actual</dt>
                <dd className="font-medium text-zinc-200">{criterion.actualValue ?? "UNKNOWN"}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Rule</dt>
                <dd className="font-medium text-zinc-200">
                  {criterion.operator} {criterion.desiredValue}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">Result</dt>
                <dd>
                  <StatusBadge status={criterion.status} />
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">Explanation</dt>
                <dd className="font-medium text-zinc-200">{criterion.explanation}</dd>
              </div>
            </dl>
          </details>
        ))}
      </div>
    </article>
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
    <form action={recommendStockAction} className="flex flex-col gap-2 sm:w-72">
      <input type="hidden" name="ticker" value={ticker} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <select
        name="recipientId"
        className="min-h-10 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100"
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
        className="min-h-10 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100"
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
            {tag}
          </label>
        ))}
      </div>
      <button
        type="submit"
        className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-emerald-400 px-3 text-sm font-semibold text-zinc-950 hover:bg-emerald-300"
      >
        <Send className="size-4" aria-hidden />
        Recommend
      </button>
    </form>
  );
}

function snapshotValue(snapshot: unknown, key: string) {
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
