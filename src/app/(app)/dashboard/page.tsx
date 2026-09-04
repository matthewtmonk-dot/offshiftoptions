import { cache, Suspense, type ReactNode } from "react";
import { ThumbsUp } from "lucide-react";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { Badge, EmptyState, Initials, Panel } from "@/components/ui";
import { RollStatusBadge, RollStatusUnavailableBadge } from "@/components/roll-status-badge";
import { getDashboardData } from "@/lib/app-data";
import { money, percent } from "@/lib/format";
import { requireCurrentUser } from "@/lib/auth";
import { getLiveQuotePricesForUser } from "@/lib/live-quotes";
import { getSchwabOpenPositionsForUser } from "@/lib/workflows";
import { splitBrokerPositionsByCampaignLink } from "@/lib/broker-reconciliation";
import { currentAccountValue, summarizeAccountLedger } from "@/domain/finance/accountLedger";
import { computeOpenPositionsCount, describeBrokerPositionForDisplay, summarizeCspSecuredCapital } from "@/domain/finance/brokerPositions";
import { getCurrentOpenPut, summarizeCampaign } from "@/domain/finance/campaigns";
import { summarizeWeeklyReturns, summarizeWinLoss } from "@/domain/finance/performance";
import { computeRollStatus, DEFAULT_ROLL_BUFFER_PERCENT } from "@/domain/finance/rollStatus";
import { GATING_RULE_KEYS, SCANNER_RULE_DEFINITIONS } from "@/domain/scanner/profile";
import { honestSetupLabel, honestSetupScore, type CriterionResult, type ScanSummary } from "@/domain/scanner/scanner";
import { addReactionAction } from "../actions";

export const dynamic = "force-dynamic";

const WEEKLY_TARGET_PERCENT = 1;
const ruleKeyByName = new Map(SCANNER_RULE_DEFINITIONS.map((definition) => [definition.name, definition.key]));

const loadDashboardBrokerData = cache(async (userId: string) => {
  const schwabPositions = await getSchwabOpenPositionsForUser(userId);
  const { unlinked: brokerPositions } = await splitBrokerPositionsByCampaignLink(userId, schwabPositions ?? []);
  return { schwabPositions, brokerPositions };
});

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
  const latestBrokerSnapshotAt = latestSnapshotAt(
    accountRows.map((row) => row.ledger.latestBrokerSnapshot?.asOf ?? null),
  );
  const campaignSecuredCapital = data.openCampaigns.reduce((sum, campaign) => {
    const summary = summarizeCampaign({ status: campaign.status, events: campaign.events });
    return sum + (summary.collateralCommitted ?? 0);
  }, 0);
  const openCampaignCount = data.openCampaigns.length;
  const winLoss = summarizeWinLoss(completedForPerformance);
  const weekly = summarizeWeeklyReturns(completedForPerformance, hasAnyAccountValue ? totalValue : null, WEEKLY_TARGET_PERCENT);

  const hasManualAccountData = accountRows.some((row) => row.ledger.startingValue !== null && !row.ledger.latestBrokerSnapshot);
  const hasSchwabAccountData = accountRows.some((row) => row.account.source === "SCHWAB" || row.ledger.latestBrokerSnapshot);
  const accountDataSource: "LIVE SCHWAB" | "MANUAL" | "MIXED" | null = hasSchwabAccountData
    ? hasManualAccountData
      ? "MIXED"
      : "LIVE SCHWAB"
    : hasManualAccountData
      ? "MANUAL"
      : null;

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
          <h1 className="inline text-sm font-semibold text-zinc-100">Hey {user.name}</h1> -{" "}
          <Badge tone={scannerIsLiveSchwab ? "info" : "warn"}>{scannerIsLiveSchwab ? "LIVE SCHWAB" : "DEMO SCANNER"}</Badge>{" "}
          <Suspense fallback={<>{openCampaignCount} tracked open</>}>
            <DashboardOpenCountSummary userId={user.id} openCampaignCount={openCampaignCount} />
          </Suspense>{" "}
          - win rate {winLoss.winRate === null ? "N/A" : `${winLoss.winRate}%`}
        </span>
        <span className="text-xs">No order submission - Off Shift Options never places, changes, or cancels trades.</span>
      </div>

      <section className="grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <Stat
          label="Account value"
          value={hasAnyAccountValue ? money(totalValue) : "No data"}
          badge={accountDataSource}
          detail={latestBrokerSnapshotAt ? `Schwab snapshot ${formatAge(latestBrokerSnapshotAt)}` : undefined}
        />
        <Stat
          label="Cash"
          value={hasAnyCash ? money(totalCash) : "No data"}
          detail={latestBrokerSnapshotAt ? `Schwab snapshot ${formatAge(latestBrokerSnapshotAt)}` : undefined}
        />
        <Suspense fallback={<DashboardBrokerStatsFallback openCampaignCount={openCampaignCount} securedCapital={campaignSecuredCapital} />}>
          <DashboardBrokerStats
            userId={user.id}
            openCampaignCount={openCampaignCount}
            campaignSecuredCapital={campaignSecuredCapital}
          />
        </Suspense>
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
            <IntentPrefetchLink className="text-sm font-medium text-emerald-300 hover:text-emerald-200" href="/positions">
              Tracker
            </IntentPrefetchLink>
          }
        >
          <div className="space-y-3">
            <Suspense
              fallback={data.openCampaigns.slice(0, 4).map((campaign) => (
                <DashboardOpenPositionRow key={campaign.id} campaign={campaign} rollStatusSlot={null} />
              ))}
            >
              <DashboardOpenPositionsWithRollStatus
                userId={user.id}
                campaigns={data.openCampaigns.slice(0, 4)}
                rollBufferPercent={Number(data.settings?.rollBufferPercent ?? DEFAULT_ROLL_BUFFER_PERCENT)}
              />
            </Suspense>
            <Suspense fallback={<DashboardBrokerPositionsFallback openCampaignCount={openCampaignCount} />}>
              <DashboardBrokerPositions userId={user.id} openCampaignCount={openCampaignCount} />
            </Suspense>
          </div>
        </Panel>

        <Panel
          title="Top Setups"
          action={
            <IntentPrefetchLink className="text-sm font-medium text-emerald-300 hover:text-emerald-200" href="/scanner">
              Scanner
            </IntentPrefetchLink>
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
                  {score} - {label}
                </Badge>
              </div>
            ))}
            {topSetups.length === 0 ? <EmptyState>No scan results yet.</EmptyState> : null}
          </div>
        </Panel>

        <Panel
          title="Buddy Activity"
          action={
            <IntentPrefetchLink className="text-sm font-medium text-emerald-300 hover:text-emerald-200" href="/chat">
              Chat
            </IntentPrefetchLink>
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
            <IntentPrefetchLink className="text-sm font-medium text-emerald-300 hover:text-emerald-200" href="/chat">
              Open
            </IntentPrefetchLink>
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
            <IntentPrefetchLink className="text-sm font-medium text-emerald-300 hover:text-emerald-200" href="/recommendations">
              Open
            </IntentPrefetchLink>
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

async function DashboardOpenCountSummary({
  userId,
  openCampaignCount,
}: {
  userId: string;
  openCampaignCount: number;
}) {
  const { schwabPositions, brokerPositions } = await loadDashboardBrokerData(userId);
  if (schwabPositions === null) {
    return <>{openCampaignCount} tracked open</>;
  }

  return <>{computeOpenPositionsCount(openCampaignCount, brokerPositions)} open</>;
}

type DashboardOpenCampaign = Awaited<ReturnType<typeof getDashboardData>>["openCampaigns"][number];

function DashboardOpenPositionRow({
  campaign,
  rollStatusSlot,
}: {
  campaign: DashboardOpenCampaign;
  rollStatusSlot: ReactNode;
}) {
  const summary = summarizeCampaign({ status: campaign.status, events: campaign.events });
  const openPut = getCurrentOpenPut(campaign.events);

  return (
    <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 p-3">
      <div>
        <div className="font-semibold">{campaign.ticker}</div>
        <div className="text-sm text-zinc-400">
          {summary.currentStage}
          {openPut ? ` · ${money(openPut.strike)} Put` : ""}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {rollStatusSlot}
        <div className="text-right">
          <div className={(summary.realizedPL ?? 0) >= 0 ? "text-emerald-300" : "text-red-300"}>{money(summary.realizedPL ?? 0)}</div>
          <Badge tone={campaign.status === "ASSIGNED" ? "warn" : "info"}>{campaign.status}</Badge>
        </div>
      </div>
    </div>
  );
}

/**
 * Fetches live quotes once for every distinct ticker with a currently-open put across the
 * given campaigns, then renders each row with its Roll Status badge (see
 * src/domain/finance/rollStatus.ts). Falls back to an honest "unavailable" badge - never a
 * guessed status - when the viewer has no live Schwab connection or a quote lookup fails.
 */
async function DashboardOpenPositionsWithRollStatus({
  userId,
  campaigns,
  rollBufferPercent,
}: {
  userId: string;
  campaigns: DashboardOpenCampaign[];
  rollBufferPercent: number;
}) {
  const openPutsByCampaignId = new Map(campaigns.map((campaign) => [campaign.id, getCurrentOpenPut(campaign.events)]));
  const tickersNeedingQuotes = campaigns
    .filter((campaign) => openPutsByCampaignId.get(campaign.id))
    .map((campaign) => campaign.ticker);
  const prices = await getLiveQuotePricesForUser(userId, tickersNeedingQuotes);

  return (
    <>
      {campaigns.map((campaign) => {
        const openPut = openPutsByCampaignId.get(campaign.id) ?? null;
        const price = openPut ? (prices.get(campaign.ticker.toUpperCase()) ?? null) : null;
        const rollStatus =
          openPut && price !== null
            ? computeRollStatus({ currentPrice: price, strike: openPut.strike, rollBufferPercent })
            : null;
        const rollStatusSlot = openPut ? rollStatus ? <RollStatusBadge status={rollStatus} /> : <RollStatusUnavailableBadge /> : null;
        return <DashboardOpenPositionRow key={campaign.id} campaign={campaign} rollStatusSlot={rollStatusSlot} />;
      })}
    </>
  );
}

function DashboardBrokerStatsFallback({
  openCampaignCount,
  securedCapital,
}: {
  openCampaignCount: number;
  securedCapital: number;
}) {
  return (
    <>
      <Stat
        label="Secured (CSP)"
        value={openCampaignCount > 0 ? `${money(securedCapital)}+` : "Checking"}
        detail="Refreshing Schwab positions"
      />
      <Stat
        label="Open positions"
        value={openCampaignCount > 0 ? `${openCampaignCount}+` : "Checking"}
        detail="Stored campaigns shown first"
      />
    </>
  );
}

async function DashboardBrokerStats({
  userId,
  openCampaignCount,
  campaignSecuredCapital,
}: {
  userId: string;
  openCampaignCount: number;
  campaignSecuredCapital: number;
}) {
  const { schwabPositions, brokerPositions } = await loadDashboardBrokerData(userId);

  if (schwabPositions === null) {
    return (
      <>
        <Stat
          label="Secured (CSP)"
          value={openCampaignCount > 0 ? money(campaignSecuredCapital) : "No broker data"}
          detail="Schwab unavailable; stored campaigns only"
        />
        <Stat
          label="Open positions"
          value={openCampaignCount > 0 ? String(openCampaignCount) : "No broker data"}
          detail="Schwab unavailable; stored campaigns only"
        />
      </>
    );
  }

  // Additive, not guessed: reconciled Schwab positions are represented by their
  // Campaigns, while unlinked live positions remain separate until the user links them.
  const brokerCsp = summarizeCspSecuredCapital(brokerPositions);
  const securedCapital = campaignSecuredCapital + brokerCsp.total;
  const openPositionsCount = computeOpenPositionsCount(openCampaignCount, brokerPositions);

  return (
    <>
      <Stat
        label="Secured (CSP)"
        value={brokerCsp.hasUnknown ? `${money(securedCapital)}+` : money(securedCapital)}
        detail="Campaigns + unlinked Schwab"
      />
      <Stat label="Open positions" value={String(openPositionsCount)} detail="Campaigns + unlinked Schwab" />
    </>
  );
}

function DashboardBrokerPositionsFallback({ openCampaignCount }: { openCampaignCount: number }) {
  if (openCampaignCount === 0) {
    return <EmptyState>No stored open campaigns. Refreshing Schwab positions...</EmptyState>;
  }

  return <p className="text-sm text-zinc-500">Refreshing Schwab positions...</p>;
}

async function DashboardBrokerPositions({
  userId,
  openCampaignCount,
}: {
  userId: string;
  openCampaignCount: number;
}) {
  const { schwabPositions, brokerPositions } = await loadDashboardBrokerData(userId);

  if (schwabPositions === null) {
    if (openCampaignCount > 0) {
      return <p className="text-sm text-zinc-500">Live Schwab positions are unavailable right now.</p>;
    }

    return (
      <EmptyState>
        No stored open campaigns.{" "}
        <IntentPrefetchLink href="/positions" className="text-emerald-300 hover:text-emerald-200">
          Start one in the Tracker.
        </IntentPrefetchLink>
      </EmptyState>
    );
  }

  if (brokerPositions.length === 0) {
    if (openCampaignCount > 0) {
      return null;
    }

    return (
      <EmptyState>
        No open campaigns or available Schwab positions.{" "}
        <IntentPrefetchLink href="/positions" className="text-emerald-300 hover:text-emerald-200">
          Start one in the Tracker.
        </IntentPrefetchLink>
      </EmptyState>
    );
  }

  return (
    <>
      {brokerPositions.slice(0, 4).map((position) => {
        const display = describeBrokerPositionForDisplay(position);
        return (
          <div
            key={`${position.accountId}-${position.symbol}`}
            className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 p-3"
          >
            <div>
              <div className="font-semibold">{display.title}</div>
              <div className="text-sm text-zinc-400">{display.detailLine ?? display.quantityLabel}</div>
            </div>
            <div className="text-right">
              <div className="text-zinc-200">{display.quantityLabel}</div>
              <div className="text-xs text-zinc-500">
                {display.valueLabel}: {money(display.value)}
              </div>
              <Badge tone="info">SCHWAB</Badge>
            </div>
          </div>
        );
      })}
    </>
  );
}

function Stat({
  label,
  value,
  tone,
  badge,
  detail,
}: {
  label: string;
  value: string;
  tone?: number;
  badge?: "LIVE SCHWAB" | "MANUAL" | "MIXED" | null;
  detail?: string;
}) {
  const toneClass = tone === undefined ? "text-zinc-50" : tone > 0 ? "text-emerald-300" : tone < 0 ? "text-red-300" : "text-zinc-50";
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] uppercase tracking-normal text-zinc-500">{label}</div>
        {badge ? (
          <span
            className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-normal ${
              badge === "LIVE SCHWAB"
                ? "bg-sky-400/15 text-sky-300"
                : badge === "MIXED"
                  ? "bg-amber-400/15 text-amber-300"
                  : "bg-zinc-700/50 text-zinc-400"
            }`}
          >
            {badge}
          </span>
        ) : null}
      </div>
      <div className={`mt-1 text-xl font-semibold ${toneClass}`}>{value}</div>
      {detail ? <div className="mt-1 text-xs text-zinc-500">{detail}</div> : null}
    </div>
  );
}

function latestSnapshotAt(dates: (Date | null)[]) {
  return dates.reduce<Date | null>((latest, date) => {
    if (!date) {
      return latest;
    }
    return !latest || date > latest ? date : latest;
  }, null);
}

function formatAge(date: Date) {
  const elapsedMs = Math.max(0, Date.now() - date.getTime());
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 1) {
    return "just now";
  }
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays}d ago`;
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
