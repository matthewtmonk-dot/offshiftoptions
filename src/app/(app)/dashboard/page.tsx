import Link from "next/link";
import { ThumbsUp } from "lucide-react";
import { Badge, EmptyState, Initials, Panel } from "@/components/ui";
import { getDashboardData } from "@/lib/app-data";
import { money, percent } from "@/lib/format";
import { requireCurrentUser } from "@/lib/auth";
import { currentAccountValue, summarizeAccountLedger } from "@/domain/finance/accountLedger";
import { summarizeCampaign } from "@/domain/finance/campaigns";
import { summarizeWeeklyReturns, summarizeWinLoss } from "@/domain/finance/performance";
import { GATING_RULE_KEYS, SCANNER_RULE_DEFINITIONS } from "@/domain/scanner/profile";
import { honestSetupLabel, honestSetupScore, type CriterionResult, type ScanSummary } from "@/domain/scanner/scanner";
import { addReactionAction } from "../actions";

export const dynamic = "force-dynamic";

const WEEKLY_TARGET_PERCENT = 1;
const ruleKeyByName = new Map(SCANNER_RULE_DEFINITIONS.map((definition) => [definition.name, definition.key]));

export default async function DashboardPage() {
  const user = await requireCurrentUser();
  const data = await getDashboardData(user.id);
  const scannerIsLiveSchwab = data.latestScanRun?.source === "LIVE:SCHWAB";

  const completedPLByAccount = new Map<string, number>();
  const completedForPerformance = data.completedCampaigns.map((campaign) => {
    const summary = summarizeCampaign({ status: campaign.status, events: campaign.events });
    const pl = summary.totalCampaignPL ?? summary.realizedPL;
    completedPLByAccount.set(campaign.accountId, (completedPLByAccount.get(campaign.accountId) ?? 0) + (pl ?? 0));
    return {
      campaignId: campaign.id,
      closedAt: campaign.closedAt ?? campaign.updatedAt,
      finalResult: summary.finalResult,
      pl,
      daysActive: summary.daysActive,
    };
  });

  const accountRows = data.ownAccounts.map((account) => {
    const ledger = summarizeAccountLedger(account.ledgerEntries);
    const realized = completedPLByAccount.get(account.id) ?? 0;
    return { account, ledger, realized, current: currentAccountValue(ledger, realized) };
  });
  const totalValue = accountRows.reduce((sum, row) => sum + (row.current.value ?? 0), 0);
  const hasAnyAccountValue = accountRows.some((row) => row.current.value !== null);
  const totalCash = accountRows.reduce((sum, row) => sum + (row.ledger.latestBrokerSnapshot?.cash ?? 0), 0);
  const hasAnyCash = accountRows.some((row) => row.ledger.latestBrokerSnapshot);
  const securedCapital = data.openCampaigns.reduce((sum, campaign) => {
    const summary = summarizeCampaign({ status: campaign.status, events: campaign.events });
    return sum + (summary.collateralCommitted ?? 0);
  }, 0);
  const winLoss = summarizeWinLoss(completedForPerformance);
  const weekly = summarizeWeeklyReturns(completedForPerformance, hasAnyAccountValue ? totalValue : null, WEEKLY_TARGET_PERCENT);

  const topSetups = (data.latestScanRun?.results ?? [])
    .map((result) => {
      const summary = toDomainSummary(result);
      return { result, summary, score: honestSetupScore(summary, GATING_RULE_KEYS), label: honestSetupLabel(summary, GATING_RULE_KEYS) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const dedupedActivities = dedupeActivities(data.activities);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-400">
        <span>
          <h1 className="inline text-sm font-semibold text-zinc-100">Hey {user.name}</h1> ·{" "}
          <Badge tone={scannerIsLiveSchwab ? "info" : "warn"}>{scannerIsLiveSchwab ? "LIVE SCHWAB" : "DEMO SCANNER"}</Badge>{" "}
          {data.openCampaigns.length} open · win rate {winLoss.winRate === null ? "N/A" : `${winLoss.winRate}%`}
        </span>
        <span className="text-xs">No order submission - Off Shift Options never places, changes, or cancels trades.</span>
      </div>

      <section className="grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <Stat label="Account value" value={hasAnyAccountValue ? money(totalValue) : "No data"} />
        <Stat label="Cash" value={hasAnyCash ? money(totalCash) : "No data"} />
        <Stat label="Secured (CSP)" value={money(securedCapital)} />
        <Stat label="Open positions" value={String(data.openCampaigns.length)} />
        <Stat label="Realized trading P/L" value={money(winLoss.realizedTradingPL)} tone={winLoss.realizedTradingPL} />
      </section>

      <section className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        {weekly.status === "INSUFFICIENT_HISTORY" ? (
          <p className="text-sm text-zinc-400">
            <span className="font-medium text-zinc-200">INSUFFICIENT HISTORY</span> - complete at least one campaign to
            start tracking weekly return against the {WEEKLY_TARGET_PERCENT}% target.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span className="text-zinc-300">
              This week <span className={weeklyToneClass(weekly.thisWeekPercent)}>{percent(weekly.thisWeekPercent ?? 0)}</span> of{" "}
              {WEEKLY_TARGET_PERCENT}% target
            </span>
            <span className="text-zinc-500">
              4-wk avg {weekly.trailing4WeekAveragePercent === null ? "N/A" : percent(weekly.trailing4WeekAveragePercent)}
            </span>
            <span className="text-zinc-500">
              {weekly.weeksAtOrAboveTarget ?? 0} of {weekly.totalWeeksTracked ?? 0} weeks at target
            </span>
            <span className="text-zinc-500">
              W-L {winLoss.wins}-{winLoss.losses}
              {winLoss.breakevens ? `-${winLoss.breakevens}` : ""}
            </span>
          </div>
        )}
      </section>

      <div className="grid gap-4 xl:grid-cols-3">
        <Panel
          title="Open Positions"
          action={
            <Link className="text-sm font-medium text-emerald-300 hover:text-emerald-200" href="/positions">
              Tracker
            </Link>
          }
        >
          <div className="space-y-3">
            {data.openCampaigns.slice(0, 4).map((campaign) => {
              const summary = summarizeCampaign({ status: campaign.status, events: campaign.events });
              return (
                <div key={campaign.id} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 p-3">
                  <div>
                    <div className="font-semibold">{campaign.ticker}</div>
                    <div className="text-sm text-zinc-400">{summary.currentStage}</div>
                  </div>
                  <div className="text-right">
                    <div className={(summary.realizedPL ?? 0) >= 0 ? "text-emerald-300" : "text-red-300"}>{money(summary.realizedPL ?? 0)}</div>
                    <Badge tone={campaign.status === "ASSIGNED" ? "warn" : "info"}>{campaign.status}</Badge>
                  </div>
                </div>
              );
            })}
            {data.openCampaigns.length === 0 ? (
              <EmptyState>
                No open campaigns. <Link href="/positions" className="text-emerald-300 hover:text-emerald-200">Start one in the Tracker.</Link>
              </EmptyState>
            ) : null}
          </div>
        </Panel>

        <Panel
          title="Top Setups"
          action={
            <Link className="text-sm font-medium text-emerald-300 hover:text-emerald-200" href="/scanner">
              Scanner
            </Link>
          }
        >
          <div className="space-y-3">
            {topSetups.map(({ result, score, label }) => (
              <div key={result.id} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 p-3">
                <div>
                  <div className="font-semibold">{result.ticker}</div>
                  <div className="text-sm text-zinc-400">
                    {result.passedCriteria} / {result.totalCriteria} criteria
                  </div>
                </div>
                <Badge tone={label === "Fails" ? "bad" : label === "Verify" ? "neutral" : "good"}>
                  {score} · {label}
                </Badge>
              </div>
            ))}
            {topSetups.length === 0 ? <EmptyState>No scan results yet.</EmptyState> : null}
          </div>
        </Panel>

        <Panel
          title="Buddy Activity"
          action={
            <Link className="text-sm font-medium text-emerald-300 hover:text-emerald-200" href="/chat">
              Chat
            </Link>
          }
        >
          <div className="space-y-3">
            {dedupedActivities.map((activity) => (
              <div key={activity.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
                <div className="flex items-start gap-3">
                  <Initials name={activity.actor.name} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-zinc-100">{activity.title}</div>
                    {activity.body ? <div className="mt-1 text-sm text-zinc-400">{activity.body}</div> : null}
                    {activity.actorId !== user.id ? (
                      <form action={addReactionAction} className="mt-2">
                        <input type="hidden" name="targetType" value="ACTIVITY" />
                        <input type="hidden" name="targetId" value={activity.id} />
                        <button
                          type="submit"
                          className="inline-flex min-h-9 items-center gap-2 rounded-md border border-zinc-700 px-3 text-xs text-zinc-300 transition hover:border-emerald-400/60 hover:text-emerald-200"
                        >
                          <ThumbsUp className="size-3.5" aria-hidden />
                          Atta Boy
                        </button>
                      </form>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
            {dedupedActivities.length === 0 ? <EmptyState>No shared activity yet.</EmptyState> : null}
          </div>
        </Panel>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel
          title="Buddy Chat"
          action={
            <Link className="text-sm font-medium text-emerald-300 hover:text-emerald-200" href="/chat">
              Open
            </Link>
          }
        >
          <div className="space-y-3">
            {data.recentMessages.map((message) => (
              <div key={message.id} className="flex gap-3">
                <Initials name={message.sender.name} />
                <div>
                  <div className="text-sm font-medium text-zinc-200">
                    {message.sender.name} {message.ticker ? <span className="text-emerald-300">${message.ticker}</span> : null}
                  </div>
                  <div className="text-sm text-zinc-400">{message.body}</div>
                </div>
              </div>
            ))}
            {data.recentMessages.length === 0 ? <EmptyState>No chat messages yet.</EmptyState> : null}
          </div>
        </Panel>

        <Panel
          title="Recommendations"
          action={
            <Link className="text-sm font-medium text-emerald-300 hover:text-emerald-200" href="/recommendations">
              Open
            </Link>
          }
        >
          <div className="space-y-3">
            {data.incomingRecommendations.map((recommendation) => (
              <div key={recommendation.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold text-zinc-50">{recommendation.sender.name} recommended {recommendation.ticker}</div>
                    <div className="mt-1 text-sm text-zinc-400">&quot;{recommendation.message}&quot;</div>
                  </div>
                  <Badge tone={recommendation.status === "NEW" ? "info" : "good"}>{recommendation.status}</Badge>
                </div>
              </div>
            ))}
            {data.incomingRecommendations.length === 0 ? <EmptyState>No recommendations yet.</EmptyState> : null}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: number }) {
  const toneClass = tone === undefined ? "text-zinc-50" : tone > 0 ? "text-emerald-300" : tone < 0 ? "text-red-300" : "text-zinc-50";
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
      <div className="text-[11px] uppercase tracking-normal text-zinc-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

function weeklyToneClass(percentValue: number | null) {
  if (percentValue === null) {
    return "text-zinc-400";
  }
  return percentValue >= WEEKLY_TARGET_PERCENT ? "text-emerald-300" : "text-amber-300";
}

function dedupeActivities<T extends { actorId: string; type: string; ticker: string | null; title: string }>(activities: T[]) {
  const seen = new Set<string>();
  return activities.filter((activity) => {
    const key = `${activity.actorId}:${activity.type}:${activity.ticker ?? ""}:${activity.title}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

type ScannerResultLike = {
  id: string;
  ticker: string;
  passedCriteria: number;
  totalCriteria: number;
  summaryStatus: string;
  criterionResults: {
    criterionName: string;
    actualValue: string | null;
    operator: string;
    desiredValue: string;
    status: string;
    explanation: string;
  }[];
};

function toDomainSummary(result: ScannerResultLike): ScanSummary {
  const results: CriterionResult[] = result.criterionResults.map((criterion) => ({
    key: ruleKeyByName.get(criterion.criterionName) ?? criterion.criterionName,
    name: criterion.criterionName,
    actualValue: criterion.actualValue,
    operator: criterion.operator as CriterionResult["operator"],
    desiredValue: safeParse(criterion.desiredValue),
    status: criterion.status as CriterionResult["status"],
    explanation: criterion.explanation,
  }));

  return {
    status: result.summaryStatus as ScanSummary["status"],
    passed: result.passedCriteria,
    total: result.totalCriteria,
    results,
  };
}

function safeParse(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
