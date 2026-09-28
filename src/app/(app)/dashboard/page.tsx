import { cache, Suspense } from "react";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { Badge, EmptyState, Initials, Panel } from "@/components/ui";
import { EventTime } from "@/components/event-time";
import { RollStatusBadge, RollStatusUnavailableBadge } from "@/components/roll-status-badge";
import { getDashboardData, getUnreadChatCount } from "@/lib/app-data";
import { money, shortCalendarDate } from "@/lib/format";
import { requireCurrentUser } from "@/lib/auth";
import { getLiveQuotePricesForUser } from "@/lib/live-quotes";
import { getSchwabOpenPositionsForUser } from "@/lib/workflows";
import { getSchwabConnectionSummaryForUser } from "@/lib/broker-connections";
import { getLinkedCampaignIdsBySymbolForUser, brokerPositionLinkKey } from "@/lib/broker-reconciliation";
import { summarizeAccountReporting } from "@/domain/finance/reporting";
import { getCampaignIdsWithUnknownFees } from "@/lib/campaign-reconciliation";
import { summarizeCampaignExposure, type CampaignExposureInput } from "@/domain/finance/brokerPositions";
import { getCurrentOpenCall, getCurrentOpenPut, summarizeCampaign } from "@/domain/finance/campaigns";
import { matchDashboardPositions, type TrackedPut } from "@/domain/finance/trackerPositionMatch";
import { summarizeThisWeek, summarizeWinLoss } from "@/domain/finance/performance";
import { getNextLstCheckpointLabel } from "@/domain/finance/lstCheckpoint";
import { computeRollStatus, DEFAULT_ROLL_BUFFER_PERCENT, isRollGuidanceApplicable } from "@/domain/finance/rollStatus";
import {
  accountValueCard,
  capitalPanelViewModel,
  chatPreviewViewModel,
  closedThisWeekViewModel,
  confirmedTradingPLCard,
  openCampaignsCard,
  positionsToReviewRows,
  scannerInsightViewModel,
  wholeAccountGainCard,
  type PositionToReviewRow,
} from "@/lib/dashboard-view";

export const dynamic = "force-dynamic";

const POSITIONS_TO_REVIEW_LIMIT = 6;

type DashboardAccount = Awaited<ReturnType<typeof getDashboardData>>["ownAccounts"][number];
type DashboardOpenCampaign = Awaited<ReturnType<typeof getDashboardData>>["openCampaigns"][number];
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
 * Resolves, once per request (cache() dedupes by argument identity), which Schwab positions are
 * already represented by a tracked campaign and must never be shown or counted a second time -
 * same precedence as the Tracker's own position badge (persisted link, then a unique exact
 * matchTrackedPut). Also the source of "Positions to Review"'s confirmation state - a campaign
 * whose put shows up here as confirmed is genuinely corroborated by live Schwab data, never a
 * guess.
 */
const loadDashboardBrokerData = cache(async (userId: string, ownAccounts: DashboardAccount[], openCampaigns: DashboardOpenCampaign[]) => {
  const schwabPositions = await getSchwabOpenPositionsForUser(userId);
  if (schwabPositions === null) {
    return {
      schwabPositions: null as DashboardSchwabPosition[] | null,
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

  return { schwabPositions, confirmedCampaignIds };
});

export default async function DashboardPage() {
  const user = await requireCurrentUser();
  const asOf = new Date();
  const data = await getDashboardData(user.id);
  const scannerIsLiveSchwab = data.latestScanRun?.source === "LIVE:SCHWAB";

  // Fees Schwab didn't report (or this code couldn't parse) must never silently present as a
  // confirmed $0 in a Trading P/L figure - see getCampaignIdsWithUnknownFees.
  const [unknownFeeCampaignIds, schwabConnection, unreadChatCount] = await Promise.all([
    getCampaignIdsWithUnknownFees(data.completedCampaigns.map((campaign) => campaign.id)),
    // Read-only: the same persisted BrokerConnection.lastAccountSyncAt the Tracker's "Your
    // brokerage last synced" already shows (see positions/page.tsx) - never triggers a sync.
    getSchwabConnectionSummaryForUser(user.id),
    getUnreadChatCount(user.id),
  ]);

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
      collateralCommitted: summary.collateralCommitted,
    };
  });

  const campaignSummaries = data.openCampaigns.map((campaign) => ({
    campaign,
    summary: summarizeCampaign({ status: campaign.status, events: campaign.events }),
  }));
  const campaignExposureInputs: CampaignExposureInput[] = campaignSummaries.map(({ campaign, summary }) => ({
    status: campaign.status,
    currentCollateralCommitted: summary.currentCollateralCommitted,
    remainingShareBasis: summary.remainingShareBasis,
    hasOpenCoveredCall: campaign.status === "ASSIGNED" && getCurrentOpenCall(campaign.events) !== null,
  }));
  const exposure = summarizeCampaignExposure(campaignExposureInputs);
  const winLoss = summarizeWinLoss(completedForPerformance);
  const thisWeek = summarizeThisWeek(completedForPerformance, asOf);

  // The ONE authoritative source for account value, confirmed trading P/L, trade return, capital
  // utilization, and whole-account gain - see reporting.ts. This page must not recompute any of
  // those formulas itself, only format this summary's fields (via dashboard-view.ts).
  const report = summarizeAccountReporting({
    accounts: data.ownAccounts.map((account) => ({
      ledgerEntries: account.ledgerEntries,
      fundingCoverage: { accountId: account.id, externalAccountId: account.externalAccountId, fundingSyncs: account.fundingSyncs },
      brokerRecords: account.brokerRecords,
      fallbackTradingPL: completedPLByAccount.get(account.id) ?? 0,
    })),
    completedCampaigns: completedForPerformance,
    openExposure: campaignExposureInputs,
    asOf,
  });

  const accountValue = accountValueCard(report);
  const wholeAccountGain = wholeAccountGainCard(report);
  const confirmedTradingPL = confirmedTradingPLCard(report, winLoss);
  const openCampaigns = openCampaignsCard(data.openCampaigns);
  const capitalPanel = capitalPanelViewModel(report, exposure);
  const closedThisWeek = closedThisWeekViewModel(report, thisWeek);
  const scannerInsight = scannerInsightViewModel(data.latestScanRun);
  const chatPreview = chatPreviewViewModel(unreadChatCount, data.recentMessages);

  const allReviewRows = positionsToReviewRows(data.openCampaigns);
  const reviewRows = allReviewRows.slice(0, POSITIONS_TO_REVIEW_LIMIT);
  const hiddenReviewRowCount = allReviewRows.length - reviewRows.length;

  const checkpointLabel = getNextLstCheckpointLabel();

  return (
    <div className="space-y-4">
      {/* 1. Compact header */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-400">
        <span>
          <span className="font-semibold text-zinc-100">Hey {user.name}</span> -{" "}
          <Badge tone={scannerIsLiveSchwab ? "info" : "warn"}>{scannerIsLiveSchwab ? "SCHWAB SCAN" : "DEMO SCANNER"}</Badge>{" "}
          {openCampaigns.count} campaign{openCampaigns.count === 1 ? "" : "s"} open - win rate {winLoss.winRate === null ? "N/A" : `${winLoss.winRate}%`}
        </span>
        <span className="flex flex-col items-end gap-0.5 text-right">
          <span className="text-xs font-medium text-zinc-300" title="Timing aid only - not an instruction to place a trade. Execution stays in Schwab/Thinkorswim.">
            {checkpointLabel}
          </span>
          {schwabConnection?.lastAccountSyncAt ? (
            <span className="text-xs">
              Brokerage synced: <EventTime value={new Date(schwabConnection.lastAccountSyncAt)} asOf={asOf} />
            </span>
          ) : (
            <span className="text-xs">Brokerage synced: never</span>
          )}
        </span>
      </div>

      {/* 2. Four summary cards */}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="How am I doing?" data-testid="dashboard-summary-cards">
        <SummaryCard
          label="Account Value"
          href="/account"
          value={accountValue.value}
          detail={accountValue.detail}
          reason={accountValue.unavailableReason}
        />
        <SummaryCard
          label="Whole-Account Gain"
          href="/positions"
          value={wholeAccountGain.value}
          tone={wholeAccountGain.tone}
          detail={wholeAccountGain.returnLabel ? [wholeAccountGain.returnLabel, wholeAccountGain.detail].filter(Boolean).join(" - ") : wholeAccountGain.detail}
          reason={wholeAccountGain.unavailableReason}
        />
        <SummaryCard
          label="Confirmed Trading P/L"
          href="/positions"
          value={confirmedTradingPL.value}
          tone={confirmedTradingPL.tone}
          detail={`${confirmedTradingPL.periodLabel} - ${confirmedTradingPL.winRateLabel} - ${confirmedTradingPL.sampleLabel}`}
          reason={confirmedTradingPL.excludedNote}
        />
        <SummaryCard
          label="Open Campaigns"
          href="/positions"
          value={String(openCampaigns.count)}
          detail={openCampaigns.breakdownLabel}
        />
      </section>

      {/* 3 & 4. Main row: Positions to Review (dominant) + Capital & Cash */}
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <Panel
            title="Positions to Review"
            action={
              <IntentPrefetchLink className="text-sm font-medium text-emerald-300 hover:text-emerald-200" href="/positions">
                Open in Tracker
              </IntentPrefetchLink>
            }
          >
            {reviewRows.length === 0 ? (
              <EmptyState>
                No open campaigns.{" "}
                <IntentPrefetchLink href="/positions" className="text-emerald-300 hover:text-emerald-200">
                  Start one in the Tracker.
                </IntentPrefetchLink>
              </EmptyState>
            ) : (
              <div className="space-y-2">
                <Suspense
                  fallback={
                    <PositionsToReviewTable rows={reviewRows} rollStatusByCampaignId={new Map()} confirmedCampaignIds={new Set()} statusLoading />
                  }
                >
                  <PositionsToReviewWithStatus userId={user.id} ownAccounts={data.ownAccounts} allOpenCampaigns={data.openCampaigns} rows={reviewRows} rollBufferPercent={Number(data.settings?.rollBufferPercent ?? DEFAULT_ROLL_BUFFER_PERCENT)} />
                </Suspense>
                {hiddenReviewRowCount > 0 ? (
                  <IntentPrefetchLink href="/positions" className="block text-center text-xs text-zinc-500 hover:text-emerald-300">
                    +{hiddenReviewRowCount} more in Tracker
                  </IntentPrefetchLink>
                ) : null}
              </div>
            )}
          </Panel>
        </div>

        <Panel title="Capital & Cash">
          <div className="space-y-3">
            <CapitalLine label="Tracked put collateral" value={capitalPanel.securedPutCollateral.value} detail={capitalPanel.securedPutCollateral.detail} />
            <CapitalLine label="Assigned shares at cost" value={capitalPanel.assignedShareCapital.value} detail={capitalPanel.assignedShareCapital.detail} />
            <div className="border-t border-zinc-800 pt-3">
              <CapitalLine
                label="Tracked LST capital committed"
                value={capitalPanel.lstCapitalCommitted.value}
                detail={capitalPanel.utilizationLabel ? `${capitalPanel.utilizationLabel} of account - ${capitalPanel.lstCapitalCommitted.detail}` : capitalPanel.lstCapitalCommitted.detail}
                emphasize
              />
            </div>
            {capitalPanel.ambiguousNotice ? <p className="text-xs text-amber-300">{capitalPanel.ambiguousNotice}</p> : null}
            <IntentPrefetchLink href="/account" className="block text-xs text-emerald-300 hover:text-emerald-200">
              View account detail
            </IntentPrefetchLink>
          </div>
        </Panel>
      </div>

      {/* 5 & 6. Lower row: Closed This Week + Scanner Insight */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Closed This Week"
          action={
            <IntentPrefetchLink className="text-sm font-medium text-emerald-300 hover:text-emerald-200" href="/positions">
              Performance
            </IntentPrefetchLink>
          }
        >
          {!closedThisWeek.hasClosures ? (
            <EmptyState>{closedThisWeek.countLabel}</EmptyState>
          ) : (
            <div className="space-y-1">
              <div className="text-sm text-zinc-300">{closedThisWeek.countLabel}</div>
              <div className={`text-xl font-semibold ${closedThisWeek.returnLabel === null ? "text-zinc-50" : closedThisWeek.returnLabel.startsWith("-") ? "text-red-300" : "text-emerald-300"}`}>
                {closedThisWeek.returnLabel ?? "Unavailable"}
              </div>
              <div className="text-xs text-zinc-500">Net return on capital those campaigns secured</div>
              {closedThisWeek.reasonMessage ? <div className="text-xs text-amber-300">{closedThisWeek.reasonMessage}</div> : null}
            </div>
          )}
        </Panel>

        <Panel
          title="Scanner Insight"
          action={
            <div className="flex items-center gap-3">
              <IntentPrefetchLink className="text-sm font-medium text-emerald-300 hover:text-emerald-200" href="/research">
                Research
              </IntentPrefetchLink>
              <IntentPrefetchLink className="text-sm font-medium text-emerald-300 hover:text-emerald-200" href="/scanner">
                Scanner
              </IntentPrefetchLink>
            </div>
          }
        >
          <div className="space-y-2">
            {scannerInsight.items.map((item) => (
              <div key={item.id} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 p-2.5">
                <div>
                  <div className="text-base font-semibold text-zinc-100">{item.ticker}</div>
                  <div className="text-xs text-zinc-400">{item.explanation}</div>
                </div>
                <Badge tone={item.readiness === "PASS" ? "good" : "neutral"}>{item.readiness} - {item.label}</Badge>
              </div>
            ))}
            {scannerInsight.hasRun ? (
              <p className="text-xs text-zinc-500" data-testid="dashboard-scan-time">
                Scan run <EventTime value={scannerInsight.runAt!} asOf={asOf} />. Saved results - check Scanner for current readiness.
              </p>
            ) : (
              <p className="text-xs text-zinc-500">Scanner run: never</p>
            )}
            {scannerInsight.items.length === 0 ? (
              <EmptyState>{scannerInsight.hasRun ? "No actionable setups from the latest scan - check Scanner for candidates still needing data." : "No scan results yet."}</EmptyState>
            ) : null}
          </div>
        </Panel>
      </div>

      {/* 7. Optional Chat preview - collapses entirely when empty */}
      {chatPreview ? (
        <Panel
          title="Chat"
          action={
            <IntentPrefetchLink className="text-sm font-medium text-emerald-300 hover:text-emerald-200" href="/chat">
              Open
            </IntentPrefetchLink>
          }
        >
          <div className="flex items-center justify-between gap-3">
            {chatPreview.latestMessage ? (
              <div className="flex min-w-0 items-center gap-2">
                <Initials name={chatPreview.latestMessage.senderName} />
                <div className="min-w-0">
                  <div className="truncate text-sm text-zinc-300">
                    <span className="font-medium text-zinc-100">{chatPreview.latestMessage.senderName}:</span> {chatPreview.latestMessage.body}
                  </div>
                  <EventTime value={chatPreview.latestMessage.createdAt} asOf={asOf} />
                </div>
              </div>
            ) : (
              <span className="text-sm text-zinc-400">New messages waiting</span>
            )}
            {chatPreview.unreadCount > 0 ? <Badge tone="info">{chatPreview.unreadCount} unread</Badge> : null}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

function SummaryCard({
  label,
  href,
  value,
  tone,
  detail,
  reason,
}: {
  label: string;
  href: string;
  value: string;
  tone?: number;
  detail?: string | null;
  reason?: string | null;
}) {
  const toneClass = tone === undefined ? "text-zinc-50" : tone > 0 ? "text-emerald-300" : tone < 0 ? "text-red-300" : "text-zinc-50";
  return (
    <IntentPrefetchLink href={href} className="block rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2.5 transition hover:border-emerald-400/40">
      <div className="text-sm font-medium text-zinc-300">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
      {detail ? <div className="mt-1 text-xs text-zinc-500">{detail}</div> : null}
      {reason ? <div className="mt-1 text-xs text-amber-300">{reason}</div> : null}
    </IntentPrefetchLink>
  );
}

function CapitalLine({ label, value, detail, emphasize = false }: { label: string; value: string; detail?: string | null; emphasize?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-sm text-zinc-400">{label}</span>
      <div className="text-right">
        <div className={`tabular-nums ${emphasize ? "text-base font-semibold text-zinc-50" : "text-sm text-zinc-200"}`}>{value}</div>
        {detail ? <div className="text-xs text-zinc-500">{detail}</div> : null}
      </div>
    </div>
  );
}

/**
 * Fetches live quotes once for every distinct ticker with a currently-open put among the rows
 * being shown, then attaches Roll Status (src/domain/finance/rollStatus.ts, unchanged, already-
 * approved functionality) and Schwab-confirmation state. Falls back to an honest "unavailable"
 * badge - never a guessed status - when Schwab is disconnected or a quote lookup fails.
 */
async function PositionsToReviewWithStatus({
  userId,
  ownAccounts,
  allOpenCampaigns,
  rows,
  rollBufferPercent,
}: {
  userId: string;
  ownAccounts: DashboardAccount[];
  allOpenCampaigns: DashboardOpenCampaign[];
  rows: PositionToReviewRow[];
  rollBufferPercent: number;
}) {
  const rollEligibleIds = new Set(
    rows.filter((row) => row.status === "OPEN" && isRollGuidanceApplicable(row.stage) && row.legType === "PUT").map((row) => row.campaignId),
  );
  const tickersNeedingQuotes = rows.filter((row) => rollEligibleIds.has(row.campaignId)).map((row) => row.ticker);
  const [prices, { confirmedCampaignIds }] = await Promise.all([
    getLiveQuotePricesForUser(userId, tickersNeedingQuotes),
    loadDashboardBrokerData(userId, ownAccounts, allOpenCampaigns),
  ]);

  const rollStatusByCampaignId = new Map(
    rows.flatMap((row) => {
      if (!rollEligibleIds.has(row.campaignId) || row.strike === null) return [];
      const price = prices.get(row.ticker.toUpperCase()) ?? null;
      const status = price !== null ? computeRollStatus({ currentPrice: price, strike: row.strike, rollBufferPercent }) : null;
      return [[row.campaignId, status] as const];
    }),
  );

  return <PositionsToReviewTable rows={rows} rollStatusByCampaignId={rollStatusByCampaignId} confirmedCampaignIds={confirmedCampaignIds} />;
}

function PositionsToReviewTable({
  rows,
  rollStatusByCampaignId,
  confirmedCampaignIds,
  statusLoading = false,
}: {
  rows: PositionToReviewRow[];
  rollStatusByCampaignId: Map<string, ReturnType<typeof computeRollStatus> | null>;
  confirmedCampaignIds: Set<string>;
  statusLoading?: boolean;
}) {
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.campaignId} className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900 p-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold text-zinc-100">{row.ticker}</span>
              {row.legType ? (
                <span className="text-sm text-zinc-300 tabular-nums">
                  {money(row.strike)} {row.legType === "PUT" ? "Put" : "Call"}
                  {row.expiration ? ` - ${shortCalendarDate(row.expiration)}` : ""}
                </span>
              ) : null}
            </div>
            <div className="text-sm text-zinc-400">
              {row.stage}
              {row.quantity !== null ? ` - ${row.quantity} ${row.quantityUnit}` : ""}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {row.legType === "PUT" && rollStatusByCampaignId.has(row.campaignId) ? (
              rollStatusByCampaignId.get(row.campaignId) ? (
                <RollStatusBadge status={rollStatusByCampaignId.get(row.campaignId)!} />
              ) : (
                <RollStatusUnavailableBadge />
              )
            ) : null}
            <ConfirmationBadge confirmed={confirmedCampaignIds.has(row.campaignId)} loading={statusLoading} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Neutral, never-reassuring confirmation state (ticket requirement): a genuinely confirmed
 * position says so; anything else says "awaiting confirmation" rather than implying safety from
 * missing evidence.
 */
function ConfirmationBadge({ confirmed, loading }: { confirmed: boolean; loading: boolean }) {
  if (loading) {
    return <Badge tone="neutral">Checking...</Badge>;
  }
  return confirmed ? <Badge tone="info">Schwab confirmed</Badge> : <Badge tone="neutral">Awaiting confirmation</Badge>;
}
