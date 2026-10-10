import { Suspense } from "react";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { Badge, EmptyState, Initials, Panel } from "@/components/ui";
import { EventTime } from "@/components/event-time";
import { LastValidNotice } from "@/components/last-valid-notice";
import { ClientPresentationProvider, FreshnessStrip, AttentionNowList, type DisplayEntry } from "@/components/client-freshness";
import { PositionToReviewRowView } from "@/components/position-to-review-row";
import { getDashboardData, getNeverTradeTickersForUser, getUnreadChatCount } from "@/lib/app-data";
import { requireCurrentUser } from "@/lib/auth";
import { getSchwabConnectionSummaryForUser } from "@/lib/broker-connections";
import { resolvePositionAssessmentDisplaysForUser } from "@/lib/positionAssessmentOrchestration";
import { summarizeAccountReporting } from "@/domain/finance/reporting";
import { getCampaignIdsWithUnknownFees } from "@/lib/campaign-reconciliation";
import { summarizeCampaignExposure, type CampaignExposureInput } from "@/domain/finance/brokerPositions";
import { getCurrentOpenCall, summarizeCampaign } from "@/domain/finance/campaigns";
import { DEFAULT_ROLL_BUFFER_PERCENT } from "@/domain/finance/rollStatus";
import { summarizeThisWeek, summarizeWinLoss } from "@/domain/finance/performance";
import { getNextLstCheckpointLabel } from "@/domain/finance/lstCheckpoint";
import {
  accountValueCard,
  attachPositionAssessmentDisplays,
  attentionNowRows,
  capitalPanelViewModel,
  chatPreviewViewModel,
  closedThisWeekViewModel,
  confirmedTradingPLCard,
  excludeAttentionRows,
  openCampaignsCard,
  positionsToReviewRows,
  scannerInsightViewModel,
  sortPositionToReviewDisplayRows,
  wholeAccountGainCard,
  type PositionToReviewRow,
} from "@/lib/dashboard-view";

export const dynamic = "force-dynamic";

const POSITIONS_TO_REVIEW_LIMIT = 6;
/** Tracker's own Performance tab, always the viewer's own scope - never the Open-view default
 * `/positions` naturally lands on (Astra review: a bare "Performance" link must not open Open). */
const TRACKER_PERFORMANCE_HREF = "/positions?scope=mine&view=performance";

type DashboardAccount = Awaited<ReturnType<typeof getDashboardData>>["ownAccounts"][number];
type DashboardOpenCampaign = Awaited<ReturnType<typeof getDashboardData>>["openCampaigns"][number];

export default async function DashboardPage() {
  const user = await requireCurrentUser();
  const asOf = new Date();
  const data = await getDashboardData(user.id);
  const scannerIsLiveSchwab = data.latestScanRun?.source === "LIVE:SCHWAB";

  // Fees Schwab didn't report (or this code couldn't parse) must never silently present as a
  // confirmed $0 in a Trading P/L figure - see getCampaignIdsWithUnknownFees.
  const [unknownFeeCampaignIds, schwabConnection, unreadChatCount, neverTradeTickers] = await Promise.all([
    getCampaignIdsWithUnknownFees(data.completedCampaigns.map((campaign) => campaign.id)),
    // Read-only: the same persisted BrokerConnection.lastAccountSyncAt the Tracker's "Your
    // brokerage last synced" already shows (see positions/page.tsx) - never triggers a sync.
    getSchwabConnectionSummaryForUser(user.id),
    getUnreadChatCount(user.id),
    getNeverTradeTickersForUser(user.id),
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
  const scannerInsight = scannerInsightViewModel(data.latestScanRun, neverTradeTickers);
  const chatPreview = chatPreviewViewModel(unreadChatCount, data.recentMessages);

  // Dashboard V2 Phase 2 - the full owner-scoped set is evaluated and priority-sorted (never
  // sorted after truncation) by PositionsToReviewWithStatus below, before it slices to
  // POSITIONS_TO_REVIEW_LIMIT; `allReviewRows` here is only the factual row list, in its
  // pre-evaluation order.
  const allReviewRows = positionsToReviewRows(data.openCampaigns);
  const rollBufferPercent = Number(data.settings?.rollBufferPercent ?? DEFAULT_ROLL_BUFFER_PERCENT);

  const checkpointLabel = getNextLstCheckpointLabel();

  return (
    <div className="space-y-3">
      {/* 1. Compact header */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-400">
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
          href={TRACKER_PERFORMANCE_HREF}
          value={wholeAccountGain.value}
          tone={wholeAccountGain.tone}
          detail={wholeAccountGain.detail}
          reason={wholeAccountGain.unavailableReason ?? wholeAccountGain.returnUnavailableReason}
        />
        <SummaryCard
          label="Confirmed Trading P/L"
          href={TRACKER_PERFORMANCE_HREF}
          value={confirmedTradingPL.value}
          tone={confirmedTradingPL.tone}
          detail={[confirmedTradingPL.periodLabel, confirmedTradingPL.winRateLabel, confirmedTradingPL.sampleLabel].filter(Boolean).join(" - ")}
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
      <div className="grid gap-3 xl:grid-cols-3">
        <div className="xl:col-span-2 space-y-3">
          <Panel
            title="Positions"
            action={
              <IntentPrefetchLink className="text-sm font-medium text-sky-300 hover:text-sky-200" href="/positions">
                Open in Tracker
              </IntentPrefetchLink>
            }
          >
            {allReviewRows.length === 0 ? (
              <EmptyState>
                No open campaigns.{" "}
                <IntentPrefetchLink href="/positions" className="text-sky-300 hover:text-sky-200">
                  Start one in the Tracker.
                </IntentPrefetchLink>
              </EmptyState>
            ) : (
              <Suspense fallback={<p className="text-xs text-zinc-500">Checking current status…</p>}>
                <PositionsToReviewWithStatus
                  userId={user.id}
                  ownAccounts={data.ownAccounts}
                  campaigns={data.openCampaigns}
                  rows={allReviewRows}
                  rollBufferPercent={rollBufferPercent}
                  asOf={asOf}
                  limit={POSITIONS_TO_REVIEW_LIMIT}
                />
              </Suspense>
            )}
          </Panel>
        </div>

        <Panel title="Capital & Cash">
          <div className="space-y-2">
            <CapitalLine label="Tracked put collateral" value={capitalPanel.securedPutCollateral.value} detail={capitalPanel.securedPutCollateral.detail} />
            <CapitalLine label="Assigned shares at cost" value={capitalPanel.assignedShareCapital.value} detail={capitalPanel.assignedShareCapital.detail} />
            <div className="border-t border-zinc-800 pt-2">
              <CapitalLine
                label="Tracked LST capital committed"
                value={capitalPanel.lstCapitalCommitted.value}
                detail={capitalPanel.utilizationLabel ? `${capitalPanel.utilizationLabel} of account - ${capitalPanel.lstCapitalCommitted.detail}` : capitalPanel.lstCapitalCommitted.detail}
                emphasize
              />
            </div>
            {capitalPanel.ambiguousNotice ? <p className="text-xs text-amber-300">{capitalPanel.ambiguousNotice}</p> : null}
            <IntentPrefetchLink href="/account" className="block text-xs text-sky-300 hover:text-sky-200">
              View account detail
            </IntentPrefetchLink>
          </div>
        </Panel>
      </div>

      {/* 5 & 6. Lower row: Closed This Week + Scanner Insight */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel
          title="Closed This Week"
          action={
            <IntentPrefetchLink className="text-sm font-medium text-sky-300 hover:text-sky-200" href={TRACKER_PERFORMANCE_HREF}>
              Performance
            </IntentPrefetchLink>
          }
        >
          {!closedThisWeek.hasClosures ? (
            <EmptyState>{closedThisWeek.countLabel}</EmptyState>
          ) : (
            <div className="space-y-1.5">
              <div className="text-sm text-zinc-300">{closedThisWeek.countLabel}</div>
              <div className={`text-2xl font-bold leading-tight tabular-nums ${closedThisWeek.returnLabel === null ? "text-zinc-50" : closedThisWeek.returnLabel.startsWith("-") ? "text-red-300" : "text-emerald-300"}`}>
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
              <IntentPrefetchLink className="text-sm font-medium text-sky-300 hover:text-sky-200" href="/research">
                Research
              </IntentPrefetchLink>
              <IntentPrefetchLink className="text-sm font-medium text-sky-300 hover:text-sky-200" href="/scanner">
                Scanner
              </IntentPrefetchLink>
            </div>
          }
        >
          <div className="space-y-1.5">
            {scannerInsight.items.map((item) => (
              <div key={item.id} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-2">
                <div>
                  <div className="text-sm font-semibold text-zinc-100">{item.ticker}</div>
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
            <IntentPrefetchLink className="text-sm font-medium text-sky-300 hover:text-sky-200" href="/chat">
              Open
            </IntentPrefetchLink>
          }
        >
          <div className="flex items-center justify-between gap-3">
            {chatPreview.latestMessage ? (
              <div className="flex min-w-0 items-center gap-2.5">
                <Initials name={chatPreview.latestMessage.senderName} />
                <div className="min-w-0">
                  <div className="truncate text-[15px] text-zinc-300">
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
  // Semantic financial color only when a real tone was computed upstream (dashboard-view.ts) -
  // never applied decoratively, and never for every card (undefined/neutral stays near-white).
  const toneClass = tone === undefined ? "text-zinc-50" : tone > 0 ? "text-emerald-300" : tone < 0 ? "text-red-300" : "text-zinc-50";
  return (
    <IntentPrefetchLink href={href} className="block rounded-lg border border-zinc-800 bg-zinc-900 p-4 transition hover:border-sky-400/50">
      <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`mt-1.5 text-[26px] font-bold leading-tight tabular-nums ${toneClass}`}>{value}</div>
      {detail ? <div className="mt-1 text-[13px] text-zinc-400">{detail}</div> : null}
      {reason ? <div className="mt-1 text-[13px] text-amber-300">{reason}</div> : null}
    </IntentPrefetchLink>
  );
}

function CapitalLine({ label, value, detail, emphasize = false }: { label: string; value: string; detail?: string | null; emphasize?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[13px] text-zinc-400">{label}</span>
      <div className="text-right">
        <div className={`tabular-nums ${emphasize ? "text-lg font-bold text-zinc-50" : "text-[15px] font-medium text-zinc-200"}`}>{value}</div>
        {detail ? <div className="text-xs text-zinc-500">{detail}</div> : null}
      </div>
    </div>
  );
}

/**
 * Phase 2B - resolves the shared CURRENT/LAST_VALID/UNAVAILABLE display for every relevant open
 * campaign (never just the truncated slice - see resolvePositionAssessmentDisplaysForUser's own
 * contract), attaches it to each factual row, sorts the FULL set by the ticket's deterministic
 * priority order, and only THEN truncates to `limit`. Tracker (positions/page.tsx) resolves the
 * identical orchestration for the same campaign, so the two pages can never disagree about a
 * position's status.
 */
async function PositionsToReviewWithStatus({
  userId,
  ownAccounts,
  campaigns,
  rows,
  rollBufferPercent,
  asOf,
  limit,
}: {
  userId: string;
  ownAccounts: DashboardAccount[];
  campaigns: DashboardOpenCampaign[];
  rows: PositionToReviewRow[];
  rollBufferPercent: number;
  asOf: Date;
  limit: number;
}) {
  const accounts = ownAccounts.map((account) => ({ id: account.id, userId: account.userId, externalAccountId: account.externalAccountId, source: account.source }));
  // Codex P1 (B8) - `asOf` selects which NY date to request session evidence for; the real
  // evaluation instant is captured fresh AFTER resolvePositionAssessmentDisplaysForUser's own
  // retrieval completes, never reused from before this page even started fetching.
  const resolved = await resolvePositionAssessmentDisplaysForUser(userId, campaigns, accounts, rollBufferPercent, asOf, () => new Date());
  const displaysByCampaignId = new Map(resolved.map((entry) => [entry.campaignId, entry.display]));
  const sortedRows = sortPositionToReviewDisplayRows(attachPositionAssessmentDisplays(rows, displaysByCampaignId));
  const attentionRows = attentionNowRows(sortedRows);
  // Compact position UX - a position already surfaced in Attention Now must never repeat under
  // Open Positions (same campaign shown twice just because it is both open and attention-worthy
  // wastes the attention-first section's own point) - see excludeAttentionRows's own doc comment.
  // Display filtering only: attentionRows itself is computed above, unchanged.
  const openOnlyRows = excludeAttentionRows(sortedRows, attentionRows);
  const visibleRows = openOnlyRows.slice(0, limit);
  const hiddenCount = openOnlyRows.length - visibleRows.length;
  // A Buddy-scoped campaign can only ever resolve to CURRENT or UNAVAILABLE (never LAST_VALID) -
  // see positionAssessmentOrchestration.ts's own owner-isolation check - so this notice only ever
  // appears from the viewer's own historical data, never a buddy's.
  const hasLastValid = visibleRows.some((row) => row.display?.state === "LAST_VALID");
  const entries: DisplayEntry[] = sortedRows.flatMap((row) => (row.display ? [{ key: row.campaignId, display: row.display }] : []));

  return (
    <ClientPresentationProvider entries={entries} now={asOf}>
      <div className="space-y-3">
        <FreshnessStrip entries={entries} now={asOf} />

        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">Attention Now</h3>
          <AttentionNowList rows={attentionRows} now={asOf} />
        </div>

        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">Open Positions</h3>
          {hasLastValid ? <div className="mb-2"><LastValidNotice /></div> : null}
          {openOnlyRows.length === 0 ? (
            <EmptyState>Every open position is already listed above in Attention Now.</EmptyState>
          ) : (
            <div className="space-y-1.5">
              {visibleRows.map((row) => (
                <PositionToReviewRowView key={row.campaignId} row={row} now={asOf} />
              ))}
            </div>
          )}
          {hiddenCount > 0 ? (
            <IntentPrefetchLink href="/positions" className="mt-1.5 block text-center text-xs text-zinc-500 hover:text-sky-300">
              +{hiddenCount} more in Tracker
            </IntentPrefetchLink>
          ) : null}
        </div>
      </div>
    </ClientPresentationProvider>
  );
}
