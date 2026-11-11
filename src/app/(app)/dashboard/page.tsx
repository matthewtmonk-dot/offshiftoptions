import { Briefcase, Landmark, LineChart, Wallet, type LucideIcon } from "lucide-react";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { Badge, EmptyState, Initials, Panel } from "@/components/ui";
import { EventTime } from "@/components/event-time";
import { WeeklyPaceRow } from "@/components/weekly-pace-row";
import { InfoTip } from "@/components/info-tip";
import { AccountBalanceLines } from "./account-balance-lines";
import { accountWeeklyPaceDisplay } from "@/lib/weekly-pace-display";
import { ClientPresentationProvider, FreshnessStrip, DashboardPositionSections, type DisplayEntry } from "@/components/client-freshness";
import { getDashboardData, getNeverTradeTickersForUser, getUnreadChatCount } from "@/lib/app-data";
import { requireCurrentUser } from "@/lib/auth";
import { getSchwabConnectionSummaryForUser } from "@/lib/broker-connections";
import { resolvePositionAssessmentDisplaysForUser } from "@/lib/positionAssessmentOrchestration";
import { getOpenPutCreditKeptForUser } from "@/lib/open-put-credit-kept";
import { summarizeAccountReporting } from "@/domain/finance/reporting";
import { getCampaignIdsWithUnknownFees } from "@/lib/campaign-reconciliation";
import { summarizeCampaignExposure, type CampaignExposureInput } from "@/domain/finance/brokerPositions";
import { getCurrentOpenCall, summarizeCampaign } from "@/domain/finance/campaigns";
import { DEFAULT_ROLL_BUFFER_PERCENT } from "@/domain/finance/rollStatus";
import { summarizeThisWeek, summarizeWinLoss } from "@/domain/finance/performance";
import { buildStressTable, type StressTable } from "@/domain/finance/stressTest";
import { getNextLstCheckpointLabel } from "@/domain/finance/lstCheckpoint";
import { underlyingPositionReviewResult } from "@/domain/finance/positionReviewAssessment";
import { attachPositionAssessmentDisplays, sortPositionToReviewDisplayRows } from "@/domain/finance/positionReviewRows";
import { getPositionEarningsNotes } from "@/lib/position-earnings";
import { dashboardSyncNotice } from "@/lib/dashboard-sync-notice";
import { describeScheduledCaptureStatus, getLatestScheduledCaptureStatusForUser, type LatestScheduledCaptureStatus } from "@/lib/scheduled-capture";
import { getScannerInsightHoldBacksForUser } from "@/lib/scanner-insight-holdbacks";
import {
  accountValueCard,
  activeSettlementBreakdown,
  capitalPanelViewModel,
  chatPreviewViewModel,
  closedThisWeekViewModel,
  confirmedTradingPLCard,
  openCampaignsCard,
  positionsToReviewRows,
  scannerInsightViewModel,
  wholeAccountGainCard,
} from "@/lib/dashboard-view";

export const dynamic = "force-dynamic";

const POSITIONS_TO_REVIEW_LIMIT = 6;
/** Tracker's own Performance tab, always the viewer's own scope - never the Open-view default
 * `/positions` naturally lands on (Astra review: a bare "Performance" link must not open Open). */
const TRACKER_PERFORMANCE_HREF = "/positions?scope=mine&view=performance";

export default async function DashboardPage() {
  const user = await requireCurrentUser();
  const asOf = new Date();
  const data = await getDashboardData(user.id);
  const scannerIsLiveSchwab = data.latestScanRun?.source === "LIVE:SCHWAB";

  // Fees Schwab didn't report (or this code couldn't parse) must never silently present as a
  // confirmed $0 in a Trading P/L figure - see getCampaignIdsWithUnknownFees.
  const [unknownFeeCampaignIds, schwabConnection, unreadChatCount, neverTradeTickers, captureStatus] = await Promise.all([
    getCampaignIdsWithUnknownFees(data.completedCampaigns.map((campaign) => campaign.id)),
    // Read-only: the same persisted BrokerConnection.lastAccountSyncAt the Tracker's "Your
    // brokerage last synced" already shows (see positions/page.tsx) - never triggers a sync.
    getSchwabConnectionSummaryForUser(user.id),
    getUnreadChatCount(user.id),
    getNeverTradeTickersForUser(user.id),
    // Read-only: the same latest-capture row the Account page shows. A failure here must never take the Dashboard down.
    getLatestScheduledCaptureStatusForUser(user.id).catch((): LatestScheduledCaptureStatus => ({ known: false })),
  ]);
  const syncNotice = dashboardSyncNotice({
    capture: captureStatus.known ? { ...describeScheduledCaptureStatus(captureStatus), at: captureStatus.at } : null,
    lastAccountSyncAt: schwabConnection ? (schwabConnection.lastAccountSyncAt ? new Date(schwabConnection.lastAccountSyncAt) : null) : undefined,
    now: asOf,
  });

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
  const accountPace = accountWeeklyPaceDisplay(report);
  const confirmedTradingPL = confirmedTradingPLCard(report, winLoss);
  const openCampaigns = openCampaignsCard(data.openCampaigns);
  const capitalPanel = capitalPanelViewModel(report, exposure);
  const stressTable = buildStressTable({
    committed: report.currentCapitalCommitted,
    accountValue: report.currentAccountValue,
    hasUnknownExposure: report.capitalUtilizationHasUnknownExposure,
  });
  const closedThisWeek = closedThisWeekViewModel(report, thisWeek);
  const scannerInsight = scannerInsightViewModel(data.latestScanRun, neverTradeTickers);
  const chatPreview = chatPreviewViewModel(unreadChatCount, data.recentMessages);

  // Dashboard V2 Phase 2 - the full owner-scoped set is evaluated and priority-sorted (never
  // sorted after truncation), before it slices to POSITIONS_TO_REVIEW_LIMIT; `allReviewRows` here
  // is only the factual row list, in its pre-evaluation order.
  const allReviewRows = positionsToReviewRows(data.openCampaigns);
  const rollBufferPercent = Number(data.settings?.rollBufferPercent ?? DEFAULT_ROLL_BUFFER_PERCENT);

  // Summary-consistency blocker repair - resolved ONCE, here, so the compact header/"Open
  // Campaigns" card summary (activeSettlementBreakdown) and the Positions panel
  // (DashboardPositionSections) read the IDENTICAL display-attached rows - never two
  // independently-derived classifications of the same campaign (previously the header/card summary
  // recomputed its own classification from raw campaign data with no live display at all, which
  // could disagree with a row's own badge on a same-day, after-session-close expiration - see
  // activeSettlementBreakdown's own doc comment). This does mean the whole page now waits for this
  // resolution before its first byte, rather than streaming the header ahead of a Suspense-deferred
  // Positions panel as before - an accepted, necessary consequence of there being only one
  // authoritative classification instead of two. Codex P1 (B8) - `asOf` selects which NY date to
  // request session evidence for; the real evaluation instant is captured fresh AFTER
  // resolvePositionAssessmentDisplaysForUser's own retrieval completes, never reused from before
  // this page even started fetching.
  const reviewAccounts = data.ownAccounts.map((account) => ({ id: account.id, userId: account.userId, externalAccountId: account.externalAccountId, source: account.source }));
  // "Credit kept" is read-only enrichment from already-stored broker/mark data (no Schwab call) and
  // runs alongside the assessment resolution; it never feeds status, priority, or attention logic.
  const [resolvedDisplays, creditKeptByCampaignId, insightHoldBacks] = await Promise.all([
    allReviewRows.length === 0 ? Promise.resolve([]) : resolvePositionAssessmentDisplaysForUser(user.id, data.openCampaigns, reviewAccounts, rollBufferPercent, asOf, () => new Date()),
    getOpenPutCreditKeptForUser(user.id, data.openCampaigns, asOf),
    // Why each PASS/NEAR name in the scan preview would be held back from the Scanner's picks (null = unavailable).
    getScannerInsightHoldBacksForUser(user.id, scannerInsight.items.map((item) => item.planRow), report.currentAccountValue),
  ]);
  const displaysByCampaignId = new Map(resolvedDisplays.map((entry) => [entry.campaignId, entry.display]));
  // Earnings warnings come from the cached earnings calendar (no provider call); a failure just means no note.
  const earningsNotesByCampaignId = await getPositionEarningsNotes(
    allReviewRows.map((row) => {
      const display = displaysByCampaignId.get(row.campaignId);
      return {
        campaignId: row.campaignId,
        ticker: row.ticker,
        legType: row.legType,
        expiration: row.expiration,
        rollSuggested: display ? underlyingPositionReviewResult(display).action === "REVIEW_ROLL" : false,
      };
    }),
  );
  const sortedReviewRows = sortPositionToReviewDisplayRows(attachPositionAssessmentDisplays(allReviewRows, displaysByCampaignId)).map((row) => ({
    ...row,
    creditKept: creditKeptByCampaignId.get(row.campaignId) ?? null,
    earnings: earningsNotesByCampaignId.get(row.campaignId) ?? null,
  }));
  const reviewEntries: DisplayEntry[] = sortedReviewRows.flatMap((row) => (row.display ? [{ key: row.campaignId, display: row.display }] : []));

  const exposureSummary = activeSettlementBreakdown(sortedReviewRows, asOf);

  const checkpointLabel = getNextLstCheckpointLabel();

  return (
    <div className="space-y-3">
      {/* 1. Page header */}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-2xl font-semibold text-zinc-50">Hey {user.name}</h1>
          {/* Only the exception is worth a badge: a live Schwab scan is the normal state. */}
          {scannerIsLiveSchwab ? null : <Badge tone="warn">Demo scanner data</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[13px] text-zinc-500">
          <span className="font-medium text-zinc-300" title="Timing aid only - not an instruction to place a trade. Execution stays in Schwab/Thinkorswim.">
            {checkpointLabel}
          </span>
          {schwabConnection?.lastAccountSyncAt ? (
            <span>
              Brokerage synced <EventTime value={new Date(schwabConnection.lastAccountSyncAt)} asOf={asOf} />
            </span>
          ) : (
            <span>Brokerage synced: never</span>
          )}
        </div>
      </div>

      {syncNotice ? (
        <IntentPrefetchLink
          href="/account"
          data-testid="dashboard-sync-notice"
          className="block rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100 transition hover:border-amber-300/60"
        >
          <span className="font-semibold">{syncNotice.title}</span>
          <span className="block text-[13px] text-amber-200/90">{syncNotice.detail}</span>
        </IntentPrefetchLink>
      ) : null}

      {/* 2. Four summary cards */}
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="How am I doing?" data-testid="dashboard-summary-cards">
        <SummaryCard
          label="Account Value"
          help="Everything in the account if you sold it all right now: cash plus the current value of your shares and options. Thinkorswim calls this “Net Liq.”"
          icon={Wallet}
          href="/account"
          value={accountValue.value}
          detail={accountValue.detail}
          reason={accountValue.unavailableReason}
          footer={<AccountBalanceLines />}
        />
        <SummaryCard
          label="Whole-Account Gain"
          icon={LineChart}
          href={TRACKER_PERFORMANCE_HREF}
          value={wholeAccountGain.value}
          tone={wholeAccountGain.tone}
          detail={wholeAccountGain.detail}
          reason={wholeAccountGain.unavailableReason ?? wholeAccountGain.returnUnavailableReason}
          footer={accountPace ? <WeeklyPaceRow pace={accountPace} label="Average per week" compact /> : null}
        />
        <SummaryCard
          label="Confirmed Trading P/L"
          icon={Landmark}
          href={TRACKER_PERFORMANCE_HREF}
          value={confirmedTradingPL.value}
          tone={confirmedTradingPL.tone}
          detail={[confirmedTradingPL.periodLabel, confirmedTradingPL.winRateLabel, confirmedTradingPL.sampleLabel].filter(Boolean).join(" - ")}
          reason={confirmedTradingPL.excludedNote}
        />
        <SummaryCard
          label="Open Campaigns"
          icon={Briefcase}
          href="/positions"
          value={String(openCampaigns.count)}
          detail={exposureSummary.label}
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
              <ClientPresentationProvider entries={reviewEntries} now={asOf}>
                <div className="space-y-3">
                  <FreshnessStrip entries={reviewEntries} now={asOf} />
                  <DashboardPositionSections rows={sortedReviewRows} now={asOf} limit={POSITIONS_TO_REVIEW_LIMIT} />
                </div>
              </ClientPresentationProvider>
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
            {report.capitalUtilizationStatus === "OK" && report.currentCapitalUtilizationPercent !== null ? (
              <UtilizationBar percent={report.currentCapitalUtilizationPercent} />
            ) : null}
            {capitalPanel.ambiguousNotice ? <p className="text-xs text-amber-300">{capitalPanel.ambiguousNotice}</p> : null}
            {stressTable && stressTable.rows.length > 0 && (report.currentCapitalCommitted ?? 0) > 0 ? <StressTableView table={stressTable} /> : null}
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
            {scannerInsight.items.map((item) => {
              // null = the hold-back checks could not be read; the row then shows only the technical result.
              const heldBack = insightHoldBacks ? (insightHoldBacks[item.ticker] ?? []) : null;
              const isHeldBack = heldBack !== null && heldBack.length > 0;
              return (
                <div key={item.id} className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-2" data-testid="scanner-insight-item">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-zinc-100">{item.ticker}</div>
                      <div className="text-xs text-zinc-400">
                        {item.readiness === "PASS" ? "Passes the scan" : "Near miss on the scan"} - {item.explanation}
                      </div>
                    </div>
                    {isHeldBack ? (
                      <Badge tone="warn">Held back</Badge>
                    ) : (
                      <Badge tone={item.readiness === "PASS" ? "good" : "neutral"}>{item.readiness} - {item.label}</Badge>
                    )}
                  </div>
                  {isHeldBack ? (
                    <p className="mt-1 text-xs text-amber-300" data-testid="scanner-insight-held-back">
                      Not a pick: {heldBack.join("; ")}
                    </p>
                  ) : null}
                </div>
              );
            })}
            {scannerInsight.hasRun ? (
              <p className="text-xs text-zinc-500" data-testid="dashboard-scan-time">
                Scan run <EventTime value={scannerInsight.runAt!} asOf={asOf} />. Saved results, checked against your portfolio limits - the Scanner has the final picks.
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
  help,
  icon: Icon,
  href,
  value,
  tone,
  detail,
  reason,
  footer,
}: {
  label: string;
  /** Plain-English hover explanation shown next to the label. */
  help?: string;
  icon: LucideIcon;
  href: string;
  value: string;
  tone?: number;
  detail?: string | null;
  reason?: string | null;
  footer?: React.ReactNode;
}) {
  // Semantic financial color only when a real tone was computed upstream (dashboard-view.ts) -
  // never applied decoratively, and never for every card (undefined/neutral stays near-white).
  // The thin top accent follows the exact same tone, so an unavailable/neutral card stays gray.
  const toneClass = tone === undefined ? "text-zinc-50" : tone > 0 ? "text-emerald-300" : tone < 0 ? "text-red-300" : "text-zinc-50";
  const accentClass = tone === undefined || tone === 0 ? "bg-zinc-700" : tone > 0 ? "bg-emerald-400" : "bg-red-400";
  return (
    <IntentPrefetchLink href={href} className="group relative block overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 p-4 shadow-[0_1px_2px_rgba(16,24,40,0.05)] transition hover:border-zinc-600">
      <span aria-hidden className={`absolute inset-x-0 top-0 h-0.5 ${accentClass}`} />
      <div className="flex items-center justify-between gap-2 text-[13px] font-medium text-zinc-500">
        <span className="inline-flex items-center gap-0.5">
          {label}
          {help ? <InfoTip label={label} align="start">{help}</InfoTip> : null}
        </span>
        <Icon aria-hidden size={15} className="text-zinc-600 transition group-hover:text-zinc-300" />
      </div>
      <div className={`mt-1 text-[28px] font-semibold leading-tight tracking-tight tabular-nums ${toneClass}`}>{value}</div>
      {detail ? <div className="mt-1 text-[13px] text-zinc-400">{detail}</div> : null}
      {reason ? <div className="mt-1 text-[13px] text-amber-300">{reason}</div> : null}
      {footer ? <div className="mt-1.5 border-t border-zinc-800 pt-1.5">{footer}</div> : null}
    </IntentPrefetchLink>
  );
}

/** Capital committed as a share of account value - a plain fill bar; the exact number is already
 * printed in the line above it, so this is a glanceable companion, never a second source of truth. */
function UtilizationBar({ percent }: { percent: number }) {
  const clamped = Math.min(100, Math.max(0, percent));
  const fill = clamped >= 90 ? "bg-amber-400" : "bg-sky-400";
  return (
    <div role="img" aria-label={`Capital committed: ${Math.round(percent)}% of account value`} className="pt-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
        <div className={`h-full rounded-full ${fill}`} style={{ width: `${clamped}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-zinc-500">
        <span>0%</span>
        <span>{Math.round(percent)}% of account committed</span>
        <span>100%</span>
      </div>
    </div>
  );
}

/**
 * "What if everything fell at once" - a worst-case reading of the capital currently at work (see stressTest.ts for the
 * assumptions). Shown only when the committed capital and account value are both known.
 */
function StressTableView({ table }: { table: StressTable }) {
  const usd = (value: number) => `$${Math.round(value).toLocaleString("en-US")}`;
  return (
    <div className="border-t border-zinc-800 pt-2" data-testid="stress-table">
      <div className="text-[13px] text-zinc-400">
        If everything fell at once{" "}
        <InfoTip label="About this stress table">
          Worst case, not a forecast: every tracked put and share position is assumed to drop by the same percent from its strike or cost at the same time, ignoring the premium you collected. It shows how much of the account a broad drop could cost.
        </InfoTip>
      </div>
      <ul className="mt-1 space-y-0.5">
        {table.rows.map((row) => (
          <li key={row.shockPercent} className="flex items-baseline justify-between gap-3 text-[13px]">
            <span className="text-zinc-400">-{row.shockPercent}%</span>
            <span className="tabular-nums text-zinc-200">
              about -{usd(row.lossDollars)} <span className="text-zinc-500">({row.lossPercentOfAccount.toFixed(1)}% of account)</span>
            </span>
          </li>
        ))}
      </ul>
      {table.isFloor ? <p className="mt-1 text-xs text-amber-300">Some positions have unknown collateral or cost, so the real figure could be larger.</p> : null}
    </div>
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
