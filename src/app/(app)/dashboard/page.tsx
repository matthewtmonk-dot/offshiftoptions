import { cache, Suspense, type ReactNode } from "react";
import { ThumbsUp } from "lucide-react";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { Badge, EmptyState, Initials, Panel } from "@/components/ui";
import { EventTime } from "@/components/event-time";
import { RollStatusBadge, RollStatusUnavailableBadge } from "@/components/roll-status-badge";
import { getDashboardData } from "@/lib/app-data";
import { money } from "@/lib/format";
import { requireCurrentUser } from "@/lib/auth";
import { getLiveQuotePricesForUser } from "@/lib/live-quotes";
import { getSchwabOpenPositionsForUser } from "@/lib/workflows";
import { getSchwabConnectionSummaryForUser } from "@/lib/broker-connections";
import { getLinkedCampaignIdsBySymbolForUser, brokerPositionLinkKey } from "@/lib/broker-reconciliation";
import { summarizeAccountPerformance, summarizeAccountsPerformance } from "@/domain/finance/accountLedger";
import { getCampaignIdsWithUnknownFees } from "@/lib/campaign-reconciliation";
import { describeBrokerPositionForDisplay, summarizeCampaignExposure, summarizeCspSecuredCapital } from "@/domain/finance/brokerPositions";
import { getCurrentOpenCall, getCurrentOpenPut, summarizeCampaign } from "@/domain/finance/campaigns";
import { matchDashboardPositions, type TrackedPut } from "@/domain/finance/trackerPositionMatch";
import { summarizeWinLoss } from "@/domain/finance/performance";
import { getNextLstCheckpointLabel } from "@/domain/finance/lstCheckpoint";
import { computeRollStatus, DEFAULT_ROLL_BUFFER_PERCENT, isRollGuidanceApplicable } from "@/domain/finance/rollStatus";
import { GATING_RULE_KEYS, SCANNER_RULE_DEFINITIONS } from "@/domain/scanner/profile";
import { classifyReadiness, honestSetupLabel, honestSetupScore, isActionableReadiness, type CriterionResult, type ScanSummary } from "@/domain/scanner/scanner";
import { contractReasonCodeFromSnapshot, optionEnrichmentFromSnapshot } from "@/domain/scanner/option-enrichment";
import { addReactionAction } from "../actions";

export const dynamic = "force-dynamic";

const ruleKeyByName = new Map(SCANNER_RULE_DEFINITIONS.map((definition) => [definition.name, definition.key]));

type DashboardAccount = Awaited<ReturnType<typeof getDashboardData>>["ownAccounts"][number];
type DashboardSchwabPosition = NonNullable<Awaited<ReturnType<typeof getSchwabOpenPositionsForUser>>>[number];

/** Builds the same TrackedPut shape the Tracker's own matchTrackedPut/exactMatchedCampaignId
 * expect, from this page's already-loaded open campaigns - mirrors positions/page.tsx's
 * identical construction so the two pages can never define "current open put" differently. */
function buildTrackedPuts(campaigns: DashboardOpenCampaign[]): TrackedPut[] {
  return campaigns.flatMap((campaign) => {
    const openPut = getCurrentOpenPut(campaign.events);
    return openPut
      ? [{ id: campaign.id, ownerId: campaign.ownerId, accountId: campaign.accountId, ticker: campaign.ticker, status: campaign.status, ...openPut }]
      : [];
  });
}

/**
 * Resolves, once per request (cache() dedupes by argument identity, and ownAccounts/openCampaigns
 * are the same object references across this request's Suspense boundaries), which Schwab
 * positions are already represented by a tracked campaign and must never be shown or counted a
 * second time. Precedence exactly matches the Tracker's own position badge:
 *   1. A persisted BrokerRecord.linkedCampaignId (see getLinkedCampaignIdsBySymbolForUser).
 *   2. Otherwise a unique, user/account/contract/quantity-exact matchTrackedPut result.
 * Both are display/calculation inference only - neither ever creates or persists a new link.
 * Anything AMBIGUOUS or NONE remains a genuinely separate, additive Schwab position: OSO does not
 * guess at collapsing two records it cannot uniquely prove are the same real-world trade.
 */
const loadDashboardBrokerData = cache(async (userId: string, ownAccounts: DashboardAccount[], openCampaigns: DashboardOpenCampaign[]) => {
  const schwabPositions = await getSchwabOpenPositionsForUser(userId);
  if (schwabPositions === null) {
    return {
      schwabPositions: null as DashboardSchwabPosition[] | null,
      additivePositions: [] as { position: DashboardSchwabPosition; disposition: "AMBIGUOUS" | "NONE" }[],
      confirmedCampaignIds: new Set<string>(),
    };
  }

  const linkedCampaignIdBySymbol = await getLinkedCampaignIdsBySymbolForUser(userId, schwabPositions);
  const positionsWithLink = schwabPositions.map((position) => {
    const normalizedSymbol = brokerPositionLinkKey(position.accountId, position.symbol);
    return { ...position, linkedCampaignId: (normalizedSymbol && linkedCampaignIdBySymbol.get(normalizedSymbol)) || null };
  });
  const trackedPuts = buildTrackedPuts(openCampaigns);
  const accounts = ownAccounts.map((account) => ({ id: account.id, userId: account.userId, externalAccountId: account.externalAccountId }));

  const matches = matchDashboardPositions(userId, positionsWithLink, accounts, trackedPuts);
  const confirmedCampaignIds = new Set(matches.flatMap((match) => (match.confirmedCampaignId ? [match.confirmedCampaignId] : [])));
  const additivePositions = matches
    .filter((match): match is typeof match & { disposition: "AMBIGUOUS" | "NONE" } => match.disposition === "AMBIGUOUS" || match.disposition === "NONE")
    .map((match) => ({ position: match.position, disposition: match.disposition }));

  return { schwabPositions, additivePositions, confirmedCampaignIds };
});

export default async function DashboardPage() {
  const user = await requireCurrentUser();
  const data = await getDashboardData(user.id);
  const renderedAt = new Date();
  const scannerIsLiveSchwab = data.latestScanRun?.source === "LIVE:SCHWAB";

  // Fees Schwab didn't report (or this code couldn't parse) must never silently present as a
  // confirmed $0 in a Trading P/L figure - see getCampaignIdsWithUnknownFees.
  const unknownFeeCampaignIds = await getCampaignIdsWithUnknownFees(data.completedCampaigns.map((campaign) => campaign.id));
  // Read-only: the same persisted BrokerConnection.lastAccountSyncAt the Tracker's "Your
  // brokerage last synced" already shows (see positions/page.tsx) - never triggers a sync.
  const schwabConnection = await getSchwabConnectionSummaryForUser(user.id);

  const completedPLByAccount = new Map<string, number>();
  const completedForPerformance = data.completedCampaigns.map((campaign) => {
    const summary = summarizeCampaign({ status: campaign.status, events: campaign.events });
    const pl = summary.unknowns.length ? null : summary.totalCampaignPL ?? summary.realizedPL;
    completedPLByAccount.set(campaign.accountId, (completedPLByAccount.get(campaign.accountId) ?? 0) + (pl ?? 0));
    return {
      campaignId: campaign.id,
      closedAt: campaign.closedAt ?? campaign.updatedAt,
      finalResult: summary.finalResult,
      cashFlowsFullyKnown: summary.unknowns.length === 0,
      pl,
      feesFullyKnown: !unknownFeeCampaignIds.has(campaign.id),
      daysActive: summary.daysActive,
    };
  });

  const accountRows = data.ownAccounts.map((account) => {
    const realized = completedPLByAccount.get(account.id) ?? 0;
    const performance = summarizeAccountPerformance({
      ledgerEntries: account.ledgerEntries,
      brokerRecords: account.brokerRecords,
      fallbackTradingPL: realized,
    });
    return { account, ledger: performance.ledger, realized, current: { value: performance.currentValue }, performance };
  });
  const accountPerformance = summarizeAccountsPerformance(
    data.ownAccounts.map((account) => ({
      ledgerEntries: account.ledgerEntries,
      brokerRecords: account.brokerRecords,
      fallbackTradingPL: completedPLByAccount.get(account.id) ?? 0,
    })),
  );
  const totalValue = accountPerformance.currentValue ?? 0;
  const hasAnyAccountValue = accountPerformance.currentValue !== null;
  const totalCash = accountRows.reduce((sum, row) => sum + (row.ledger.latestBrokerSnapshot?.cash ?? 0), 0);
  const hasAnyCash = accountRows.some((row) => row.ledger.latestBrokerSnapshot);
  const latestBrokerSnapshotAt = latestSnapshotAt(
    accountRows.map((row) => row.ledger.latestBrokerSnapshot?.asOf ?? null),
  );
  // Awaiting-expiration is a lifecycle-stage breakdown of the SAME open-campaign count, never a
  // broker position count - an Expiration Processing campaign has no corresponding Schwab
  // position once its option expires, so it must never be labeled or summed as one.
  let awaitingExpirationCount = 0;
  const campaignSummaries = data.openCampaigns.map((campaign) => ({
    campaign,
    summary: summarizeCampaign({ status: campaign.status, events: campaign.events }),
  }));
  for (const { summary } of campaignSummaries) {
    if (summary.currentStage === "Expiration processing") {
      awaitingExpirationCount += 1;
    }
  }
  // Ticket 5: keeps open put collateral, assigned-share capital, and covered-call coverage as
  // three explicitly separate facts - see summarizeCampaignExposure (brokerPositions.ts) for the
  // real bug this fixes (an ASSIGNED campaign's historical put collateral no longer silently
  // stays inside "Secured (CSP)" after the put is gone).
  const exposure = summarizeCampaignExposure(
    campaignSummaries.map(({ campaign, summary }) => ({
      status: campaign.status,
      currentCollateralCommitted: summary.currentCollateralCommitted,
      remainingShareBasis: summary.remainingShareBasis,
      hasOpenCoveredCall: campaign.status === "ASSIGNED" && getCurrentOpenCall(campaign.events) !== null,
    })),
  );
  const campaignSecuredCapital = exposure.securedPutCollateral;
  const openCampaignCount = data.openCampaigns.length;
  const winLoss = summarizeWinLoss(completedForPerformance);

  const hasManualAccountData = accountRows.some((row) => row.performance.currentValueSource === "MANUAL");
  const hasSchwabAccountData = accountRows.some((row) => row.account.source === "SCHWAB" || row.performance.currentValueSource === "SCHWAB");
  const accountDataSource: "SCHWAB" | "MANUAL" | "MIXED" | null = hasSchwabAccountData
    ? hasManualAccountData
      ? "MIXED"
      : "SCHWAB"
    : hasManualAccountData
      ? "MANUAL"
      : null;

  const scannedSetups = (data.latestScanRun?.results ?? []).map((result) => {
    const summary = toDomainSummary(result);
    const optionEnrichment = optionEnrichmentFromSnapshot(result.snapshotJson);
    const contractReasonCode = contractReasonCodeFromSnapshot(result.snapshotJson);
    return {
      result,
      summary,
      score: honestSetupScore(summary, GATING_RULE_KEYS),
      label: honestSetupLabel(summary, GATING_RULE_KEYS),
      readiness: classifyReadiness(summary, GATING_RULE_KEYS, optionEnrichment, contractReasonCode),
    };
  });
  // Only a technically complete, actionable candidate (PASS or NEAR - see classifyReadiness) may
  // appear as a "Top setup": a NEEDS_DATA row (unassessed options, unresolved criteria) or a known
  // FAIL must never be promoted here just because it happens to carry a high historical score.
  const topSetups = scannedSetups.filter((setup) => isActionableReadiness(setup.readiness)).sort((a, b) => b.score - a.score).slice(0, 3);

  const dedupedActivities = dedupeActivities(data.activities);
  const checkpointLabel = getNextLstCheckpointLabel();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-400">
        <span>
          <h1 className="inline text-lg font-semibold text-zinc-100">Hey {user.name}</h1> -{" "}
          <Badge tone={scannerIsLiveSchwab ? "info" : "warn"}>{scannerIsLiveSchwab ? "SCHWAB SCAN" : "DEMO SCANNER"}</Badge>{" "}
          {openCampaignCount} campaign{openCampaignCount === 1 ? "" : "s"} open
          {awaitingExpirationCount > 0 ? ` (${awaitingExpirationCount} awaiting expiration)` : ""} - win rate{" "}
          {winLoss.winRate === null ? "N/A" : `${winLoss.winRate}%`}
        </span>
        <span className="flex flex-col items-end gap-0.5 text-right">
          <span className="text-xs font-medium text-zinc-300" title="Timing aid only - not an instruction to place a trade. Execution stays in Schwab/Thinkorswim.">
            {checkpointLabel}
          </span>
          <span className="text-xs">No order submission - Off Shift Options never places, changes, or cancels trades.</span>
        </span>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500" data-testid="dashboard-freshness">
        <Suspense fallback={<span>Market snapshot: checking…</span>}>
          <DashboardMarketSnapshotFreshness
            userId={user.id}
            ownAccounts={data.ownAccounts}
            openCampaigns={data.openCampaigns}
            renderedAt={renderedAt}
          />
        </Suspense>
        {data.latestScanRun ? (
          <span>
            Scanner run: <EventTime value={data.latestScanRun.createdAt} asOf={renderedAt} />
          </span>
        ) : (
          <span>Scanner run: never</span>
        )}
        {schwabConnection?.lastAccountSyncAt ? (
          <span>
            Brokerage activity synced: <EventTime value={new Date(schwabConnection.lastAccountSyncAt)} asOf={renderedAt} />
          </span>
        ) : (
          <span>Brokerage activity synced: never</span>
        )}
        {latestBrokerSnapshotAt ? (
          <span>
            Account balance snapshot: <EventTime value={latestBrokerSnapshotAt} asOf={renderedAt} />
          </span>
        ) : (
          <span>Account balance snapshot: never</span>
        )}
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
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
        <Stat
          label="Open campaigns"
          value={String(openCampaignCount)}
          detail={dashboardOpenCampaignsDetail(awaitingExpirationCount, exposure)}
        />
        <Suspense fallback={<DashboardBrokerStatsFallback openCampaignCount={openCampaignCount} securedCapital={campaignSecuredCapital} />}>
          <DashboardBrokerStats
            userId={user.id}
            ownAccounts={data.ownAccounts}
            openCampaigns={data.openCampaigns}
            openCampaignCount={openCampaignCount}
            campaignSecuredCapital={campaignSecuredCapital}
            unknownCampaignCollateral={exposure.openCampaignsWithUnknownCollateral}
          />
        </Suspense>
        <Stat
          label="Trading Cash Flow"
          value={accountPerformance.tradingPL === null ? "No data" : money(accountPerformance.tradingPL)}
          tone={accountPerformance.tradingPL ?? undefined}
          detail={dashboardTradingDetail(accountPerformance.tradingPLSource, winLoss.realizedTradingPLExact)}
        />
      </section>

      <section className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span className="text-zinc-400">Trade-return goal reporting is being rebuilt from verified account and trade data.</span>
          <span className="text-zinc-500">
            W-L {winLoss.wins}-{winLoss.losses}
            {winLoss.breakevens ? `-${winLoss.breakevens}` : ""}
            {winLoss.pendingCount > 0 ? ` (+${winLoss.pendingCount} pending)` : ""}
          </span>
        </div>
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
                ownAccounts={data.ownAccounts}
                allOpenCampaigns={data.openCampaigns}
                campaigns={data.openCampaigns.slice(0, 4)}
                rollBufferPercent={Number(data.settings?.rollBufferPercent ?? DEFAULT_ROLL_BUFFER_PERCENT)}
              />
            </Suspense>
            <Suspense fallback={<DashboardBrokerPositionsFallback openCampaignCount={openCampaignCount} />}>
              <DashboardBrokerPositions
                userId={user.id}
                ownAccounts={data.ownAccounts}
                openCampaigns={data.openCampaigns}
                openCampaignCount={openCampaignCount}
              />
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
                  <div className="text-lg font-semibold">{result.ticker}</div>
                  <div className="text-sm text-zinc-400">
                    {result.passedCriteria} / {result.totalCriteria} criteria
                  </div>
                </div>
                <Badge tone={label === "Fails" ? "bad" : label === "Verify" ? "neutral" : "good"}>
                  {score} - {label}
                </Badge>
              </div>
            ))}
            {data.latestScanRun ? <p className="text-sm text-zinc-400" data-testid="dashboard-scan-time">Scan run: <EventTime value={data.latestScanRun.createdAt} asOf={renderedAt} />. Saved results; check Scanner for current readiness.</p> : null}
            {topSetups.length === 0 ? (
              <EmptyState>
                {scannedSetups.length === 0 ? "No scan results yet." : "No actionable setups from the latest scan yet - check Scanner for candidates still needing data."}
              </EmptyState>
            ) : null}
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
                    <div className="text-base font-medium text-zinc-100">{activity.title}</div>
                    <EventTime value={activity.createdAt} asOf={renderedAt} />
                    {activity.body ? <div className="mt-1 text-sm leading-relaxed text-zinc-300">{activity.body}</div> : null}
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
                <div className="min-w-0">
                  <div className="text-base font-medium text-zinc-100">
                    {message.sender.name}{" "}
                    {message.ticker ? (
                      <IntentPrefetchLink href="/research" className="text-emerald-300 hover:text-emerald-200" title={`Open ${message.ticker} in Research`}>
                        ${message.ticker}
                      </IntentPrefetchLink>
                    ) : null}
                  </div>
                  <EventTime value={message.createdAt} asOf={renderedAt} />
                  <div className="break-words whitespace-pre-wrap text-base leading-relaxed text-zinc-300">{message.body || "Shared an image — open Chat to view."}</div>
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
                    <EventTime value={recommendation.createdAt} asOf={renderedAt} />
                    <div className="mt-1 text-base leading-relaxed text-zinc-300">&quot;{recommendation.message}&quot;</div>
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

type DashboardOpenCampaign = Awaited<ReturnType<typeof getDashboardData>>["openCampaigns"][number];

function DashboardOpenPositionRow({
  campaign,
  rollStatusSlot,
  confirmed = false,
}: {
  campaign: DashboardOpenCampaign;
  rollStatusSlot: ReactNode;
  /** True only when this campaign's current put is either persisted-linked to a Schwab position
   * or a unique, safe matchTrackedPut EXACT match (see loadDashboardBrokerData) - never a guess. */
  confirmed?: boolean;
}) {
  const summary = summarizeCampaign({ status: campaign.status, events: campaign.events });
  const openPut = getCurrentOpenPut(campaign.events);

  return (
    <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 p-3">
      <div>
        <div className="flex items-center gap-2">
          <span className="text-lg font-semibold">{campaign.ticker}</span>
          {confirmed ? (
            <span
              className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-normal text-sky-300 bg-sky-400/15"
              title="This position is also visible in your Schwab account - shown once here rather than as a separate broker card."
            >
              Schwab confirmed
            </span>
          ) : null}
        </div>
        {openPut ? <div className="text-base font-medium text-zinc-100">{money(openPut.strike)} Put</div> : null}
        <div className="text-sm text-zinc-400">{summary.currentStage}</div>
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
  ownAccounts,
  allOpenCampaigns,
  campaigns,
  rollBufferPercent,
}: {
  userId: string;
  ownAccounts: DashboardAccount[];
  /** Every open campaign, for correct broker-position matching - a position can match a campaign
   * outside the first four actually rendered below. */
  allOpenCampaigns: DashboardOpenCampaign[];
  campaigns: DashboardOpenCampaign[];
  rollBufferPercent: number;
}) {
  // Once a campaign is in Expiration Processing, its fate is already decided and just awaiting
  // confirmation - HOLD/ROLL guidance no longer applies, and the lifecycle stage itself
  // (rendered alongside this slot in DashboardOpenPositionRow) is the correct guidance instead.
  const rollEligibleCampaignIds = new Set(
    campaigns
      .filter((campaign) => isRollGuidanceApplicable(summarizeCampaign({ status: campaign.status, events: campaign.events }).currentStage))
      .map((campaign) => campaign.id),
  );
  const openPutsByCampaignId = new Map(campaigns.map((campaign) => [campaign.id, getCurrentOpenPut(campaign.events)]));
  const tickersNeedingQuotes = campaigns
    .filter((campaign) => rollEligibleCampaignIds.has(campaign.id) && openPutsByCampaignId.get(campaign.id))
    .map((campaign) => campaign.ticker);
  const [prices, { confirmedCampaignIds }] = await Promise.all([
    getLiveQuotePricesForUser(userId, tickersNeedingQuotes),
    loadDashboardBrokerData(userId, ownAccounts, allOpenCampaigns),
  ]);

  return (
    <>
      {campaigns.map((campaign) => {
        const rollEligible = rollEligibleCampaignIds.has(campaign.id);
        const openPut = rollEligible ? (openPutsByCampaignId.get(campaign.id) ?? null) : null;
        const price = openPut ? (prices.get(campaign.ticker.toUpperCase()) ?? null) : null;
        const rollStatus =
          openPut && price !== null
            ? computeRollStatus({ currentPrice: price, strike: openPut.strike, rollBufferPercent })
            : null;
        const rollStatusSlot = openPut ? rollStatus ? <RollStatusBadge status={rollStatus} /> : <RollStatusUnavailableBadge /> : null;
        return (
          <DashboardOpenPositionRow
            key={campaign.id}
            campaign={campaign}
            rollStatusSlot={rollStatusSlot}
            confirmed={confirmedCampaignIds.has(campaign.id)}
          />
        );
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
      <Stat label="Broker positions" value="Checking" detail="Actual Schwab positions - separate from campaign count" />
    </>
  );
}

async function DashboardBrokerStats({
  userId,
  ownAccounts,
  openCampaigns,
  openCampaignCount,
  campaignSecuredCapital,
  unknownCampaignCollateral,
}: {
  userId: string;
  ownAccounts: DashboardAccount[];
  openCampaigns: DashboardOpenCampaign[];
  openCampaignCount: number;
  campaignSecuredCapital: number;
  unknownCampaignCollateral: number;
}) {
  const { schwabPositions, additivePositions } = await loadDashboardBrokerData(userId, ownAccounts, openCampaigns);

  if (schwabPositions === null) {
    return (
      <>
        <Stat
          label="Secured (CSP)"
          value={unknownCampaignCollateral ? (campaignSecuredCapital > 0 ? `${money(campaignSecuredCapital)} - partial` : "Unavailable") : openCampaignCount > 0 ? money(campaignSecuredCapital) : "No broker data"}
          detail="Schwab unavailable; stored campaigns only"
        />
        <Stat label="Broker positions" value="No broker data" detail="Schwab unavailable" />
      </>
    );
  }

  // Additive, not guessed: a Schwab position already confirmed by a tracked campaign (persisted
  // link, or a unique matchTrackedPut EXACT match) contributes zero collateral here - it is
  // already inside campaignSecuredCapital. Only genuinely AMBIGUOUS/NONE positions (see
  // loadDashboardBrokerData) still add - this is dollar-collateral math only, it never implies an
  // additive position and a campaign are secretly the same trade. "Broker positions" below stays
  // the true, un-deduped Schwab position count regardless of how this sum is computed.
  const brokerCsp = summarizeCspSecuredCapital(additivePositions.map((row) => row.position));
  const securedCapital = campaignSecuredCapital + brokerCsp.total;

  return (
    <>
      <Stat
        label="Secured (CSP)"
        value={brokerCsp.hasUnknown || unknownCampaignCollateral ? (securedCapital > 0 ? `${money(securedCapital)} - partial` : "Unavailable") : money(securedCapital)}
        detail={unknownCampaignCollateral ? `${unknownCampaignCollateral} campaign collateral unknown` : "Campaigns + unmatched Schwab positions"}
      />
      <Stat
        label="Broker positions"
        value={String(schwabPositions.length)}
        detail="Actual Schwab positions - separate from campaign count"
      />
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
  ownAccounts,
  openCampaigns,
  openCampaignCount,
}: {
  userId: string;
  ownAccounts: DashboardAccount[];
  openCampaigns: DashboardOpenCampaign[];
  openCampaignCount: number;
}) {
  const { schwabPositions, additivePositions } = await loadDashboardBrokerData(userId, ownAccounts, openCampaigns);

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

  if (additivePositions.length === 0) {
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
      {additivePositions.slice(0, 4).map(({ position, disposition }) => {
        const display = describeBrokerPositionForDisplay(position);
        const isAmbiguous = disposition === "AMBIGUOUS";
        return (
          <div
            key={`${position.accountId}-${position.symbol}`}
            className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 p-3"
          >
            <div>
              <div className="font-semibold">{display.title}</div>
              <div className="text-sm text-zinc-400">{display.detailLine ?? display.quantityLabel}</div>
              <div className="text-xs text-zinc-500">
                {isAmbiguous ? "Ambiguous match - review in Tracker" : "Untracked Schwab position"}
              </div>
            </div>
            <div className="text-right">
              <div className="text-zinc-200">{display.quantityLabel}</div>
              <div className="text-xs text-zinc-500">
                {display.valueLabel}: {display.value === null ? "Unavailable" : money(display.value)}
              </div>
              <Badge tone={isAmbiguous ? "warn" : "info"}>{isAmbiguous ? "AMBIGUOUS" : "SCHWAB"}</Badge>
            </div>
          </div>
        );
      })}
    </>
  );
}

/**
 * The one true-provenance timestamp this page can honestly claim: the moment it actually checked
 * current Schwab positions/quotes, shown only when that check succeeded this load (never claimed
 * as "live" when Schwab is disconnected or unreachable - see loadDashboardBrokerData). Reuses the
 * same cached broker-data load every other broker-facing section on this page already makes, so
 * this never triggers an extra Schwab request.
 */
async function DashboardMarketSnapshotFreshness({
  userId,
  ownAccounts,
  openCampaigns,
  renderedAt,
}: {
  userId: string;
  ownAccounts: DashboardAccount[];
  openCampaigns: DashboardOpenCampaign[];
  renderedAt: Date;
}) {
  const { schwabPositions } = await loadDashboardBrokerData(userId, ownAccounts, openCampaigns);

  if (schwabPositions === null) {
    return <span>Market snapshot: unavailable (Schwab not connected or unreachable)</span>;
  }

  return (
    <span>
      Market snapshot checked: <EventTime value={renderedAt} asOf={renderedAt} />
    </span>
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
  badge?: "SCHWAB" | "MANUAL" | "MIXED" | null;
  detail?: string;
}) {
  const toneClass = tone === undefined ? "text-zinc-50" : tone > 0 ? "text-emerald-300" : tone < 0 ? "text-red-300" : "text-zinc-50";
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-zinc-300">{label}</div>
        {badge ? (
          <span
            className={`rounded px-1.5 py-0.5 text-xs font-semibold uppercase tracking-normal ${
              badge === "SCHWAB"
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

/**
 * Ticket 5: keeps assigned-share exposure visibly distinct from the "Secured (CSP)" put-collateral
 * stat above, rather than silently absent from the header once a campaign is assigned. Never
 * fabricates a mark-to-market value - `assignedShareCapital` is the existing, already-computed
 * assignment cost basis (strike x shares), not a live valuation (see PROJECT_HANDOFF.md - no full
 * wheel valuation engine exists yet).
 */
function dashboardOpenCampaignsDetail(awaitingExpirationCount: number, exposure: ReturnType<typeof summarizeCampaignExposure>) {
  const parts: string[] = [];
  if (awaitingExpirationCount > 0) {
    parts.push(`${awaitingExpirationCount} awaiting expiration confirmation`);
  }
  if (exposure.assignedCampaignCount > 0) {
    const coveredNote = exposure.assignedCampaignsWithCoveredCall > 0 ? `, ${exposure.assignedCampaignsWithCoveredCall} with a covered call` : "";
    const basisNote =
      exposure.assignedCampaignsWithKnownBasis > 0 ? `${money(exposure.assignedShareCapital)} remaining share basis${exposure.assignedCampaignsWithKnownBasis < exposure.assignedCampaignCount ? ` - partial (${exposure.assignedCampaignCount - exposure.assignedCampaignsWithKnownBasis} unknown)` : ""}${coveredNote}` : "basis unknown";
    parts.push(`${exposure.assignedCampaignCount} assigned (${basisNote}) - not put collateral`);
  }
  return parts.length > 0 ? parts.join(" · ") : "Tracker lifecycle count";
}

function dashboardTradingDetail(source: string | null, exact: boolean) {
  if (source === "BROKER_TRANSACTIONS") {
    return "Schwab option trade cashflow";
  }
  if (source === "MIXED") {
    return exact ? "Schwab trades + manual campaigns" : "Schwab trades + campaigns with pending or incomplete results";
  }
  if (source === "CAMPAIGNS") {
    return exact ? "Closed campaigns only" : "Closed campaigns only - partial or pending";
  }
  return undefined;
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
  snapshotJson: unknown;
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
