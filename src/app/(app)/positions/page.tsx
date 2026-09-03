import type { ReactNode } from "react";
import { InfoTip } from "@/components/info-tip";
import {
  Activity,
  BarChart3,
  ChevronDown,
  CircleDollarSign,
  ClipboardList,
  Flag,
  Gauge,
  History,
  LineChart,
  Lock,
  Plus,
  Repeat2,
  ShieldCheck,
  Sparkles,
  Target,
  Timer,
  TrendingUp,
  Users,
  WalletCards,
} from "lucide-react";
import { Badge, EmptyState, FieldLabel } from "@/components/ui";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { currentAccountValue, summarizeAccountLedger } from "@/domain/finance/accountLedger";
import { classifyBrokerPosition, describeBrokerPositionForDisplay } from "@/domain/finance/brokerPositions";
import { optionLegValue, summarizeCampaign } from "@/domain/finance/campaigns";
import {
  summarizeCampaignProgress,
  summarizeContributionAdjustedGoal,
  summarizeWinLoss,
  type CampaignProgressSummary,
  type ContributionAdjustedGoalSummary,
} from "@/domain/finance/performance";
import { requireCurrentUser } from "@/lib/auth";
import { getTrackerPageData, normalizeTrackerScope, optionContractKey, type TrackerScope } from "@/lib/app-data";
import { money, percent, shortDate, toNumber } from "@/lib/format";
import { resolveInheritedVisibility } from "@/lib/privacy";
import type { BrokerPosition } from "@/providers/broker-read/types";
import { getSchwabOpenPositionsForUser } from "@/lib/workflows";
import { getPendingBrokerImportBatchForUser, getBrokerImportBatchesForUser, type BrokerImportPreviewRow } from "@/lib/broker-import";
import {
  getBrokerActivityAwaitingReviewForUser,
  splitBrokerPositionsByCampaignLink,
  type BrokerActivityAwaitingReview,
} from "@/lib/broker-reconciliation";
import {
  assignCampaignPutAction,
  closeCampaignPutAction,
  confirmBrokerReconciliationAction,
  confirmSchwabImportAction,
  createCampaignAction,
  createTradingAccountAction,
  discardSchwabImportAction,
  previewSchwabImportAction,
  rollCampaignPutAction,
  skipBrokerReconciliationAction,
  toggleCampaignVisibilityAction,
  toggleTradingAccountVisibilityAction,
} from "../actions";
import { TrackerTabs } from "./tracker-tabs";

export const dynamic = "force-dynamic";

const WEEKLY_TARGET_PERCENT = 1;
const HELP = {
  scope:
    "Mine shows your financial results. Eric and Both can show shared campaign history for comparison, but OSO never merges account values into one combined performance result.",
  knownRealized:
    "Final profit or loss from campaigns that are closed. Open campaigns can collect premium, but they are not realized wins or losses yet.",
  netPremium:
    "Credits received minus debits paid and applicable option fees. Premium collected on an open campaign is cash flow so far, not automatically realized profit.",
  historyStatus:
    "Open means the campaign still has an active option leg. Assigned means shares were put to the account and the wheel can continue. Closed means OSO has a final campaign result.",
  startingValue:
    "The starting capital logged in the account ledger. Later deposits are kept separate so they do not look like trading profit.",
  accountCurrentValue:
    "The current account value OSO uses for performance. If the account is broker-backed, the latest broker snapshot is authoritative and may include the current value or liability of open positions.",
  netContributions:
    "Deposits minus withdrawals and manual adjustments. Contributions change the capital base but do not count as trading profit.",
  tradingPLNow:
    "Your current trading result after removing deposits and withdrawals. Formula: current account value minus starting capital minus net contributions.",
  realizedPL:
    "Final profit or loss from completed campaigns only. Open and assigned campaigns do not become realized results until they are closed.",
  currentMtm:
    "An estimate of what marked campaigns are worth right now using a current option mark when available. This can change until the campaign is closed.",
  projectedOtm:
    "What eligible open cash-secured puts would make if the remaining short put expires worthless. This is a scenario, not guaranteed profit.",
  currentPace:
    "Current contribution-adjusted performance divided by the dated capital OSO has tracked. It is based on account value now, not only closed campaign wins.",
  onePercentTarget:
    "OSO's strategy benchmark: roughly 1% per week on the capital at work. It is a goal line, not a promised or expected return.",
  targetComparison:
    "OSO compares your current progress with the 1% target path for the dates and capital in the ledger. Ahead or behind is shown in dollars and percent of target.",
  projectedOtmPace:
    "This pace assumes eligible open cash-secured puts finish under the projected OTM scenario. It can change and is not realized profit.",
  winRate:
    "Only completed campaigns count as wins or losses. Open profitable or losing marks do not change win rate.",
  capitalSecured:
    "Cash or account capital currently committed to secure open short puts. For cash-secured puts, OSO uses strike times contracts times 100 shares.",
  currentCostToClose:
    "Estimated cost to buy back the open short put today. OSO uses a linked Schwab position when available, otherwise an exact cached option quote.",
  currentReturn:
    "Current mark-to-market result divided by secured capital. It can move around while the campaign is open.",
  projectedReturn:
    "Projected OTM result divided by secured capital. It assumes the open short put expires worthless.",
  goalNeed:
    "How far this campaign's projected return is above or below the 1% target needed for its time open.",
  rolls:
    "A roll buys back an existing short put and sells a new one. OSO keeps both legs in the campaign history.",
  markSource:
    "Current option value comes from your linked Schwab position when available, otherwise from an exact cached option quote. If OSO cannot establish a reliable mark, current P/L is left unavailable rather than guessed.",
  colorLegend:
    "Color guide: green means profitable or on target, amber means unresolved or behind target, red means losing or closed loss, and blue/neutral is informational or open state.",
  sto:
    "Sell to Open: opening a short option position and receiving premium.",
  btc:
    "Buy to Close: buying back a short option position to close that leg.",
  roll:
    "A roll closes one short put and opens another. The net amount shows the credit or debit after both legs and fees.",
  projectedOtmResult:
    "Projected result if the remaining open short put expires worthless. This is a scenario, not a completed result.",
} as const;

type TrackerData = Awaited<ReturnType<typeof getTrackerPageData>>;
type CampaignRow = TrackerData["campaigns"][number];
type CampaignEventRow = CampaignRow["events"][number];
type AccountRow = TrackerData["visibleAccounts"][number];
type PerformanceCampaignRow = TrackerData["ownPerformanceCampaigns"][number];
type OptionMarkRow = TrackerData["optionMarksForPerformance"][number];
type ViewMode = "open" | "history" | "performance" | "accounts";
type SchwabPositions = Awaited<ReturnType<typeof getSchwabOpenPositionsForUser>>;
type CurrentCostToCloseSource = {
  costToClose: number;
  source: "LINKED_BROKER_POSITION" | "CACHED_OPTION_MARK";
  label: string;
  asOf: Date | null;
};
type PerformanceCampaignViewRow = {
  campaign: PerformanceCampaignRow;
  summary: ReturnType<typeof summarizeCampaign>;
  progress: CampaignProgressSummary;
  currentCostSource: CurrentCostToCloseSource | null;
};

export default async function PositionsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requireCurrentUser();
  const query = await searchParams;
  const scope = normalizeTrackerScope(firstParam(query.scope));
  const view = parseViewMode(firstParam(query.view));
  const error = firstParam(query.error);
  const previewBatchId = firstParam(query.previewBatch);
  const needsOpenBrokerData = view === "open";
  const needsAccountsImportData = view === "accounts";
  const [data, schwabPositions, brokerActivityAwaitingReview, importBatches, pendingImport] = await Promise.all([
    getTrackerPageData(user.id, scope, {
      includeLegacyTrades: needsOpenBrokerData,
      includePerformanceCampaigns: view === "performance",
    }),
    needsOpenBrokerData ? getSchwabOpenPositionsForUser(user.id) : Promise.resolve(null),
    needsAccountsImportData ? getBrokerActivityAwaitingReviewForUser(user.id) : Promise.resolve([]),
    needsAccountsImportData ? getBrokerImportBatchesForUser(user.id) : Promise.resolve([]),
    needsAccountsImportData && previewBatchId ? getPendingBrokerImportBatchForUser(user.id, previewBatchId) : Promise.resolve(null),
  ]);
  const { linked: linkedSchwabPositions } = needsOpenBrokerData
    ? await splitBrokerPositionsByCampaignLink(user.id, schwabPositions ?? [])
    : { linked: [] };
  const linkedSchwabSymbols = new Set(linkedSchwabPositions.map((position) => position.symbol));
  const buddyName = data.users[0]?.name ?? "Buddy";
  const rows = data.campaigns.map((campaign) => ({
    campaign,
    summary: summarizeCampaign({ status: campaign.status, events: campaign.events }),
  }));
  const openRows = rows.filter((row) => row.campaign.status !== "CLOSED");
  const closedRows = rows.filter((row) => row.campaign.status === "CLOSED");
  const historyRows = rows;
  const activeCount = openRows.length;
  const openCampaignCount = rows.filter((row) => row.campaign.status === "OPEN").length;
  const assignedCampaignCount = rows.filter((row) => row.campaign.status === "ASSIGNED").length;
  const closedCount = closedRows.length;
  const realizedTotal = closedRows.reduce((sum, row) => sum + (row.summary.totalCampaignPL ?? row.summary.realizedPL ?? 0), 0);
  const premiumTotal = rows.reduce((sum, row) => sum + row.summary.netOptionPremium, 0);
  const openCampaignTickers = new Set(openRows.map((row) => row.campaign.ticker.toUpperCase()));

  // Performance is always computed from the current user's own completed campaigns and own
  // accounts, never from the scope-filtered `campaigns`/`visibleAccounts` lists above - so
  // switching the Mine/Buddy/Both selector can never blend Matt's and Eric's P/L together.
  const ownAccountRows = data.ownAccounts.map((account) => {
    const ledger = summarizeAccountLedger(account.ledgerEntries);
    return { account, ledger };
  });
  const ownCompletedForPerformance = data.ownCompletedCampaigns.map((campaign) => {
    const summary = summarizeCampaign({ status: campaign.status, events: campaign.events });
    return {
      campaignId: campaign.id,
      closedAt: campaign.closedAt ?? campaign.updatedAt,
      finalResult: summary.finalResult,
      pl: summary.totalCampaignPL ?? summary.realizedPL,
      daysActive: summary.daysActive,
    };
  });
  const ownRealizedByAccount = new Map<string, number>();
  for (const campaign of data.ownCompletedCampaigns) {
    const summary = summarizeCampaign({ status: campaign.status, events: campaign.events });
    const pl = summary.totalCampaignPL ?? summary.realizedPL ?? 0;
    ownRealizedByAccount.set(campaign.accountId, (ownRealizedByAccount.get(campaign.accountId) ?? 0) + pl);
  }
  const ownCurrentValues = ownAccountRows.map((row) =>
    currentAccountValue(row.ledger, ownRealizedByAccount.get(row.account.id) ?? 0),
  );
  const ownCurrentTotal = ownCurrentValues.some((value) => value.value !== null)
    ? ownCurrentValues.reduce((sum, value) => sum + (value.value ?? 0), 0)
    : null;
  const ownWinLoss = summarizeWinLoss(ownCompletedForPerformance);
  const optionMarksByKey = new Map(
    data.optionMarksForPerformance.map((snapshot) => [
      optionContractKey(snapshot.underlyingSymbol, snapshot.expiration, snapshot.strike, snapshot.optionType),
      snapshot,
    ]),
  );
  const ownPerformanceRows = data.ownPerformanceCampaigns.map((campaign): PerformanceCampaignViewRow => {
    const currentCostSource = resolveCurrentCostToClose(campaign, optionMarksByKey);
    return {
      campaign,
      summary: summarizeCampaign({ status: campaign.status, events: campaign.events }),
      progress: summarizeCampaignProgress({
        status: campaign.status,
        events: campaign.events,
        currentCostToClose: currentCostSource?.costToClose ?? null,
        targetWeeklyPercent: WEEKLY_TARGET_PERCENT,
      }),
      currentCostSource,
    };
  });
  const currentCampaignPLTotal = ownPerformanceRows.some((row) => row.progress.currentPL !== null)
    ? roundMoney(ownPerformanceRows.reduce((sum, row) => sum + (row.progress.currentPL ?? 0), 0))
    : null;
  const currentCampaignPartial = ownPerformanceRows.some(
    (row) => row.campaign.status !== "CLOSED" && row.progress.projectedOtmApplicable && row.progress.currentPL === null,
  );
  const projectedOtmTotal = ownPerformanceRows.some((row) => row.progress.realizedPL !== null || row.progress.projectedOtmPL !== null)
    ? roundMoney(ownPerformanceRows.reduce((sum, row) => sum + (row.progress.realizedPL ?? row.progress.projectedOtmPL ?? 0), 0))
    : null;
  const projectedOtmPartial = ownPerformanceRows.some(
    (row) => row.campaign.status === "OPEN" && row.progress.projectedOtmApplicable && row.progress.projectedOtmPL === null,
  );
  const ownGoal = summarizeContributionAdjustedGoal({
    accounts: data.ownAccounts,
    currentValue: ownCurrentTotal,
    projectedOtmPL: projectedOtmTotal,
    targetWeeklyPercent: WEEKLY_TARGET_PERCENT,
  });

  // Realized P/L per account for the Accounts tab - bucketed per account, never summed
  // across accounts owned by different users.
  const realizedByAccount = new Map<string, number>();
  for (const row of closedRows) {
    const pl = row.summary.totalCampaignPL ?? row.summary.realizedPL ?? 0;
    realizedByAccount.set(row.campaign.accountId, (realizedByAccount.get(row.campaign.accountId) ?? 0) + pl);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-sm font-medium text-emerald-300">Campaign &amp; account tracker</p>
          <h1 className="text-2xl font-semibold text-zinc-50">Tracker</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {(["mine", "buddy", "both"] as TrackerScope[]).map((option) => (
            <IntentPrefetchLink key={option} href={trackerHref(option, view)} className={segmentClass(scope === option)}>
              {option === "mine" ? "Mine" : option === "buddy" ? buddyName : "Both"}
            </IntentPrefetchLink>
          ))}
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100">{error}</div>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <TrackerStat
          icon={<ClipboardList className="size-4" aria-hidden />}
          label="Campaigns"
          value={rows.length}
          detail={`${activeCount} active / ${closedCount} closed`}
        />
        <TrackerStat
          icon={<CircleDollarSign className="size-4" aria-hidden />}
          label="Known realized P/L"
          value={signedMoney(realizedTotal)}
          detail="Closed campaigns only"
          tone={realizedTotal}
          help={HELP.knownRealized}
          helpTestId="help-known-realized"
        />
        <TrackerStat
          icon={<TrendingUp className="size-4" aria-hidden />}
          label="Net option premium"
          value={signedMoney(premiumTotal)}
          detail="Credits minus debits and option fees"
          tone={premiumTotal}
          help={HELP.netPremium}
          helpTestId="help-net-option-premium"
        />
        <TrackerStat
          icon={<WalletCards className="size-4" aria-hidden />}
          label="Visible accounts"
          value={data.visibleAccounts.length}
          detail={`${data.ownAccounts.length} available for new campaigns`}
        />
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <TrackerTabs scope={scope} view={view} />
        <p className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
          Tracking + live read-only Schwab data. Trade execution stays in thinkorswim.
          <InfoTip label="Mine, Eric, and Both" align="end" testId="help-tracker-scope">
            {HELP.scope}
          </InfoTip>
        </p>
      </div>

      {view === "open" ? (
        <section className="space-y-4">
          {data.ownAccounts.length === 0 ? (
            <NewAccountPanel buddyName={buddyName} defaultOpen />
          ) : (
            <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
              <NewCampaignPanel accounts={data.ownAccounts} buddyName={buddyName} />
              <NewAccountPanel buddyName={buddyName} />
            </section>
          )}

          <SchwabPositionsPanel
            positions={schwabPositions}
            openCampaignTickers={openCampaignTickers}
            linkedSymbols={linkedSchwabSymbols}
          />

          <div className="space-y-3">
            {openRows.map((row) => (
              <CampaignCard key={row.campaign.id} row={row} currentUserId={user.id} />
            ))}
            {openRows.length === 0 ? (
              <EmptyState>
                {data.ownAccounts.length === 0
                  ? "Add an account above, then start a campaign."
                  : "No open campaigns for this view. Create one above to start the history."}
              </EmptyState>
            ) : null}
            {data.legacyTrades.length ? <LegacySnapshots trades={data.legacyTrades} /> : null}
          </div>
        </section>
      ) : null}

      {view === "history" ? (
        <section className="space-y-3" data-testid="campaign-history-table">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-normal text-zinc-500">Campaign History</p>
              <h2 className="mt-1 inline-flex items-center gap-2 text-lg font-semibold text-zinc-50">
                Every campaign, not just closed wins
                <InfoTip label="Campaign status" align="start" testId="help-history-status">
                  {HELP.historyStatus}
                </InfoTip>
              </h2>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge tone="info">{openCampaignCount} open</Badge>
              <Badge tone="warn">{assignedCampaignCount} assigned</Badge>
              <Badge tone="good">{closedCount} closed</Badge>
            </div>
          </div>
          {historyRows.map((row) => (
            <CampaignCard key={row.campaign.id} row={row} currentUserId={user.id} />
          ))}
          {historyRows.length === 0 ? <EmptyState>No campaigns yet for this view.</EmptyState> : null}
        </section>
      ) : null}

      {view === "performance" ? (
        <PerformanceSection
          winLoss={ownWinLoss}
          goal={ownGoal}
          campaignRows={ownPerformanceRows}
          currentCampaignPLTotal={currentCampaignPLTotal}
          currentCampaignPartial={currentCampaignPartial}
          projectedOtmPartial={projectedOtmPartial}
        />
      ) : null}

      {view === "accounts" ? (
        <div className="space-y-4">
          <AccountsSection
            accounts={data.visibleAccounts}
            currentUserId={user.id}
            buddyName={buddyName}
            realizedByAccount={realizedByAccount}
          />
          <ImportStatusMessage
            imported={firstParam(query.imported)}
            discarded={firstParam(query.discarded)}
            linked={firstParam(query.linked)}
            skipped={firstParam(query.skipped)}
          />
          {pendingImport ? (
            <SchwabImportPreviewPanel batchId={previewBatchId!} batch={pendingImport.batch} rows={pendingImport.rows} />
          ) : (
            <SchwabImportPanel accounts={data.ownAccounts} recentBatches={importBatches} />
          )}
          <BrokerActivityAwaitingReviewPanel items={brokerActivityAwaitingReview} accounts={data.ownAccounts} buddyName={buddyName} />
        </div>
      ) : null}
    </div>
  );
}

function NewCampaignPanel({
  accounts,
  buddyName,
}: {
  accounts: TrackerData["ownAccounts"];
  buddyName: string;
}) {
  return (
    <details className="group rounded-lg border border-zinc-800 bg-zinc-950 p-4 shadow-sm shadow-black/20" open={accounts.length === 0}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-normal text-zinc-300">
          <Plus className="size-4 text-emerald-300" aria-hidden />
          New Campaign
        </span>
        <ChevronDown className="size-4 text-zinc-500 transition group-open:rotate-180" aria-hidden />
      </summary>
      <div className="mt-4 border-t border-zinc-800 pt-4">
        {accounts.length === 0 ? (
          <EmptyState>Create an account first, then the campaign form will have somewhere to land.</EmptyState>
        ) : (
          <form action={createCampaignAction} className="grid gap-4 lg:grid-cols-3">
            <input type="hidden" name="returnTo" value="/positions" />
            <div className="space-y-2">
              <FieldLabel>Account</FieldLabel>
              <select name="accountId" required className={inputClass}>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <FieldLabel>Ticker</FieldLabel>
              <input name="ticker" required placeholder="BROS" className={inputClass} />
            </div>
            <div className="space-y-2">
              <FieldLabel>Trade date</FieldLabel>
              <input name="tradeDate" type="date" required defaultValue={dateInputValue(new Date())} className={inputClass} />
            </div>
            <div className="space-y-2">
              <FieldLabel>Expiration</FieldLabel>
              <input name="expiration" type="date" required defaultValue={dateInputValue(daysFromNow(21))} className={inputClass} />
            </div>
            <div className="space-y-2">
              <FieldLabel>Strike</FieldLabel>
              <input name="strike" type="number" step="0.01" min="0.01" required placeholder="40" className={inputClass} />
            </div>
            <div className="space-y-2">
              <FieldLabel>Contracts</FieldLabel>
              <input name="contracts" type="number" step="1" min="1" required defaultValue="1" className={inputClass} />
            </div>
            <div className="space-y-2">
              <FieldLabel>Credit per share</FieldLabel>
              <input name="premium" type="number" step="0.0001" min="0" required placeholder="0.48" className={inputClass} />
            </div>
            <div className="space-y-2">
              <FieldLabel>Fees</FieldLabel>
              <input name="fees" type="number" step="0.01" min="0" placeholder="0" className={inputClass} />
            </div>
            <div className="space-y-2">
              <FieldLabel>Visibility</FieldLabel>
              <select name="visibility" defaultValue="INHERIT" className={inputClass}>
                <option value="INHERIT">Follow account</option>
                <option value="SHARED">Shared with {buddyName}</option>
                <option value="PRIVATE">Private</option>
              </select>
            </div>
            <div className="space-y-2 lg:col-span-3">
              <FieldLabel>Notes</FieldLabel>
              <textarea
                name="notes"
                rows={2}
                placeholder="Why this setup belongs in the book"
                className={`${inputClass} min-h-20 resize-y`}
              />
            </div>
            <div className="lg:col-span-3">
              <button type="submit" className={primaryButtonClass}>
                <Plus className="size-4" aria-hidden />
                Create Campaign
              </button>
            </div>
          </form>
        )}
      </div>
    </details>
  );
}

function NewAccountPanel({ buddyName, defaultOpen }: { buddyName: string; defaultOpen?: boolean }) {
  return (
    <details className="group rounded-lg border border-zinc-800 bg-zinc-950 p-4 shadow-sm shadow-black/20" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-normal text-zinc-300">
          <WalletCards className="size-4 text-sky-300" aria-hidden />
          New Account
        </span>
        <ChevronDown className="size-4 text-zinc-500 transition group-open:rotate-180" aria-hidden />
      </summary>
      <form action={createTradingAccountAction} className="mt-4 grid gap-4 border-t border-zinc-800 pt-4 sm:grid-cols-2">
        <input type="hidden" name="returnTo" value="/positions" />
        <div className="space-y-2">
          <FieldLabel>Name</FieldLabel>
          <input name="name" required placeholder="Matt IRA" className={inputClass} />
        </div>
        <div className="space-y-2">
          <FieldLabel>Type</FieldLabel>
          <select name="accountType" defaultValue="IRA" className={inputClass}>
            <option value="IRA">IRA</option>
            <option value="Taxable">Taxable</option>
            <option value="Paper">Paper</option>
            <option value="Manual">Manual</option>
          </select>
        </div>
        <div className="space-y-2">
          <FieldLabel>Starting balance</FieldLabel>
          <input name="startingBalance" type="number" step="0.01" min="0" placeholder="10000" className={inputClass} />
        </div>
        <div className="space-y-2">
          <FieldLabel>Current balance</FieldLabel>
          <input name="manualBalance" type="number" step="0.01" min="0" placeholder="10482" className={inputClass} />
        </div>
        <div className="space-y-2">
          <FieldLabel>Default sharing</FieldLabel>
          <select name="visibility" defaultValue="PRIVATE" className={inputClass}>
            <option value="PRIVATE">Private (default)</option>
            <option value="SHARED">Shared with {buddyName}</option>
          </select>
        </div>
        <div className="flex items-end">
          <button type="submit" className={secondaryButtonClass}>
            <Plus className="size-4" aria-hidden />
            Add Account
          </button>
        </div>
      </form>
    </details>
  );
}

function CampaignCard({
  row,
  currentUserId,
}: {
  row: { campaign: CampaignRow; summary: ReturnType<typeof summarizeCampaign> };
  currentUserId: string;
}) {
  const { campaign, summary } = row;
  const isOwner = campaign.ownerId === currentUserId;
  const accountVisibleToViewer = isOwner || campaign.account.visibility === "SHARED";
  const effectiveVisibility = resolveInheritedVisibility(campaign.visibility, campaign.account.visibility);
  const timeline = timelineGroups(campaign.events);
  const plValue = campaign.status === "CLOSED" ? (summary.totalCampaignPL ?? summary.realizedPL) : null;

  return (
    <details className="group rounded-lg border border-zinc-800 bg-zinc-950 shadow-sm shadow-black/20" data-testid={`campaign-card-${campaign.ticker}`}>
      <summary className="grid cursor-pointer list-none gap-4 p-4 transition hover:bg-zinc-900/70 md:grid-cols-[1fr_auto] md:items-center [&::-webkit-details-marker]:hidden">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-2xl font-semibold text-zinc-50">{campaign.ticker}</span>
            <Badge tone={statusTone(campaign.status, plValue)}>{campaign.status}</Badge>
            <VisibilityBadge effectiveVisibility={effectiveVisibility} rawVisibility={campaign.visibility} />
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-zinc-400">
            <span>{isOwner ? "You" : campaign.owner.name}</span>
            <span>{accountVisibleToViewer ? campaign.account.name : "Private account"}</span>
            <span>{summary.currentStage}</span>
          </div>
        </div>
        <div className="grid grid-cols-[1fr_auto] items-center gap-3 md:min-w-[520px] md:grid-cols-[1fr_1fr_1fr_auto]">
          <SummaryCell
            label="Realized"
            value={campaign.status === "CLOSED" ? signedMoney(plValue) : "Not closed"}
            tone={campaign.status === "CLOSED" ? plValue : null}
            help={HELP.realizedPL}
            helpTestId={`help-summary-realized-${campaign.ticker}`}
          />
          <SummaryCell
            label="Premium"
            value={signedMoney(summary.netOptionPremium)}
            tone={summary.netOptionPremium}
            help={HELP.netPremium}
            helpTestId={`help-summary-premium-${campaign.ticker}`}
          />
          <SummaryCell label="Days" value={summary.daysActive ?? "UNKNOWN"} />
          <ChevronDown className="size-5 justify-self-end text-zinc-500 transition group-open:rotate-180" aria-hidden />
        </div>
      </summary>

      <div className="border-t border-zinc-800 p-4">
        <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
          <div>
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-normal text-zinc-300">
              <History className="size-4 text-emerald-300" aria-hidden />
              Lifecycle
            </div>
            <div className="space-y-3">
              {timeline.map((group) => (
                <TimelineGroupView key={group.key} group={group} />
              ))}
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-normal text-zinc-300">
                <Flag className="size-4 text-sky-300" aria-hidden />
                Result So Far
              </div>
              <dl className="grid gap-x-4 gap-y-3 text-sm sm:grid-cols-2">
                <ResultItem label="Opened" value={summary.openedAt ? shortDate(summary.openedAt) : "UNKNOWN"} />
                <ResultItem label="Closed" value={summary.closedAt ? shortDate(summary.closedAt) : "Not closed"} />
                <ResultItem
                  label="Total credits"
                  value={money(summary.totalPremiumReceived)}
                  help="Premium credits received from selling option legs, before subtracting closing debits."
                />
                <ResultItem
                  label="Total debits"
                  value={money(summary.optionDebitsPaid)}
                  help="Money paid to buy back option legs, plus applicable option fees in the net result."
                />
                <ResultItem
                  label="Roll net"
                  value={signedMoney(summary.netRollPremium)}
                  tone={summary.netRollPremium}
                  help={HELP.roll}
                />
                <ResultItem
                  label="Capital committed"
                  value={summary.collateralCommitted === null ? "UNKNOWN" : money(summary.collateralCommitted)}
                  help={HELP.capitalSecured}
                />
                <ResultItem label="Stock cost" value={money(summary.stockCost)} />
                <ResultItem label="Stock proceeds" value={money(summary.stockProceeds)} />
                <ResultItem label="Shares held" value={summary.sharesHeld} />
                <ResultItem label="Adjusted basis" value={summary.adjustedBasis === null ? "UNKNOWN" : money(summary.adjustedBasis)} />
              </dl>
              {campaign.status !== "CLOSED" ? (
                <p className="mt-3 text-xs text-zinc-500">
                  Open option premium is tracked as net premium until this campaign closes.
                </p>
              ) : null}
              {summary.unknowns.length ? (
                <div className="mt-3 rounded-md border border-zinc-800 bg-zinc-900/50 p-3 text-xs text-zinc-400">
                  {summary.unknowns[0]}
                </div>
              ) : null}
            </div>

            {campaign.entrySnapshotJson ? (
              <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3 text-sm text-zinc-400">
                <div className="mb-1 inline-flex items-center gap-2 font-medium text-zinc-200">
                  <ShieldCheck className="size-4 text-emerald-300" aria-hidden />
                  Entry snapshot saved
                </div>
                <div>{entrySnapshotText(campaign.entrySnapshotJson)}</div>
              </div>
            ) : null}

            {isOwner ? (
              <div className="space-y-4 border-t border-zinc-800 pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <form action={toggleCampaignVisibilityAction}>
                    <input type="hidden" name="campaignId" value={campaign.id} />
                    <button type="submit" className={tinyButtonClass}>
                      {effectiveVisibility === "SHARED" ? <Lock className="size-3.5" aria-hidden /> : <Users className="size-3.5" aria-hidden />}
                      {effectiveVisibility === "SHARED" ? "Make Private" : "Share"}
                    </button>
                  </form>
                </div>
                {campaign.status === "OPEN" ? <CampaignActionForms campaignId={campaign.id} /> : null}
                {campaign.status === "ASSIGNED" ? (
                  <p className="text-xs text-zinc-500">
                    Covered call and stock-sale events are modeled now; manual buttons for that phase are a clean next slice.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </details>
  );
}

function CampaignActionForms({ campaignId }: { campaignId: string }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <form action={closeCampaignPutAction} className="space-y-2 border-l border-zinc-800 pl-3">
        <input type="hidden" name="returnTo" value="/positions" />
        <input type="hidden" name="campaignId" value={campaignId} />
        <h3 className="text-sm font-semibold text-zinc-100">Close Put</h3>
        <input name="occurredAt" type="date" required defaultValue={dateInputValue(new Date())} className={inputClass} />
        <input name="premium" type="number" step="0.0001" min="0" required placeholder="Debit/share" className={inputClass} />
        <input name="fees" type="number" step="0.01" min="0" placeholder="Fees" className={inputClass} />
        <input name="notes" placeholder="Optional note" className={inputClass} />
        <button type="submit" className={tinyButtonClass}>Close</button>
      </form>

      <form action={rollCampaignPutAction} className="space-y-2 border-l border-zinc-800 pl-3">
        <input type="hidden" name="returnTo" value="/positions" />
        <input type="hidden" name="campaignId" value={campaignId} />
        <h3 className="inline-flex items-center gap-2 text-sm font-semibold text-zinc-100">
          <Repeat2 className="size-4 text-amber-300" aria-hidden />
          Roll
        </h3>
        <input name="occurredAt" type="date" required defaultValue={dateInputValue(new Date())} className={inputClass} />
        <input name="closePremium" type="number" step="0.0001" min="0" required placeholder="Close debit/share" className={inputClass} />
        <input name="newExpiration" type="date" required defaultValue={dateInputValue(daysFromNow(28))} className={inputClass} />
        <div className="grid grid-cols-2 gap-2">
          <input name="newStrike" type="number" step="0.01" min="0.01" required placeholder="New strike" className={inputClass} />
          <input name="newPremium" type="number" step="0.0001" min="0" required placeholder="New credit" className={inputClass} />
        </div>
        <input name="fees" type="number" step="0.01" min="0" placeholder="Fees" className={inputClass} />
        <input name="notes" placeholder="Optional note" className={inputClass} />
        <button type="submit" className={tinyButtonClass}>Roll</button>
      </form>

      <form action={assignCampaignPutAction} className="space-y-2 border-l border-zinc-800 pl-3">
        <input type="hidden" name="returnTo" value="/positions" />
        <input type="hidden" name="campaignId" value={campaignId} />
        <h3 className="text-sm font-semibold text-zinc-100">Assigned</h3>
        <input name="occurredAt" type="date" required defaultValue={dateInputValue(new Date())} className={inputClass} />
        <input name="shares" type="number" step="1" min="1" placeholder="Shares, optional" className={inputClass} />
        <input name="fees" type="number" step="0.01" min="0" placeholder="Fees" className={inputClass} />
        <input name="notes" placeholder="Optional note" className={inputClass} />
        <button type="submit" className={tinyButtonClass}>Mark Assigned</button>
      </form>
    </div>
  );
}

function TimelineGroupView({ group }: { group: { key: string; label: string; events: CampaignEventRow[] } }) {
  const amount = group.events.reduce((sum, event) => sum + (eventAmount(event) ?? 0), 0);
  const hasAmount = group.events.some((event) => eventAmount(event) !== null);
  const note = group.events.find((event) => event.notes)?.notes;
  const help = eventHelp(group.events[0].type);

  return (
    <div className="grid grid-cols-[88px_1fr] gap-3 text-sm">
      <div className="text-xs text-zinc-500">{shortDate(group.events[0].occurredAt)}</div>
      <div className="border-l border-zinc-800 pl-3">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex items-center gap-1.5 font-semibold text-zinc-100">
            {group.label}
            {help ? (
              <InfoTip label={group.label} align="start" testId={`help-timeline-${group.label.toLowerCase().replace(/\s+/g, "-")}`}>
                {help}
              </InfoTip>
            ) : null}
          </div>
          {hasAmount ? <div className={amountClass(amount)}>{signedMoney(amount)}</div> : null}
        </div>
        <div className="space-y-1">
          {group.events.map((event) => {
            const legAmount = eventAmount(event);
            return (
              <div key={event.id} className="grid gap-1 text-zinc-400 sm:grid-cols-[1fr_auto]">
                <span>{eventDescription(event)}</span>
                {legAmount === null ? null : <span className={amountClass(legAmount)}>{signedMoney(legAmount)}</span>}
              </div>
            );
          })}
        </div>
        {note ? <div className="mt-2 text-xs text-zinc-500">{note}</div> : null}
      </div>
    </div>
  );
}

function AccountsSection({
  accounts,
  currentUserId,
  buddyName,
  realizedByAccount,
}: {
  accounts: AccountRow[];
  currentUserId: string;
  buddyName: string;
  realizedByAccount: Map<string, number>;
}) {
  return (
    <section className="grid gap-3 lg:grid-cols-2">
      {accounts.map((account) => {
        const isOwner = account.userId === currentUserId;
        const ledger = summarizeAccountLedger(account.ledgerEntries);
        const realized = realizedByAccount.get(account.id) ?? 0;
        const current = currentAccountValue(ledger, realized);
        return (
          <article key={account.id} className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 shadow-sm shadow-black/20">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold text-zinc-50">{account.name}</h2>
                  <Badge tone={account.source === "SCHWAB" ? "info" : "neutral"}>{account.source}</Badge>
                  <Badge tone={account.visibility === "SHARED" ? "info" : "warn"}>
                    {account.visibility === "SHARED" ? <Users className="mr-1 size-3.5" aria-hidden /> : <Lock className="mr-1 size-3.5" aria-hidden />}
                    {account.visibility === "SHARED" ? `Shared with ${isOwner ? buddyName : "you"}` : "Private"}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-zinc-400">
                  {isOwner ? "You" : account.user.name} / {account.accountType}
                </p>
              </div>
              {isOwner ? (
                <form action={toggleTradingAccountVisibilityAction}>
                  <input type="hidden" name="accountId" value={account.id} />
                  <button type="submit" className={tinyButtonClass}>
                    {account.visibility === "SHARED" ? "Make Private" : "Share"}
                  </button>
                </form>
              ) : null}
            </div>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <ResultItem
                label="Starting"
                value={ledger.startingValue === null ? "UNKNOWN" : money(ledger.startingValue)}
                help={HELP.startingValue}
              />
              <ResultItem
                label="Contributions"
                value={money(ledger.netContributions)}
                tone={ledger.netContributions}
                help={HELP.netContributions}
              />
              <ResultItem
                label="Current"
                value={current.value === null ? "No data" : money(current.value)}
                help={HELP.accountCurrentValue}
              />
              <ResultItem label="Campaigns" value={account._count.campaigns} />
            </dl>
            {isOwner ? (
              <p className="mt-3 text-xs text-zinc-500">
                Log a deposit, withdrawal, or adjustment from{" "}
                <IntentPrefetchLink href="/account" className="text-emerald-300 hover:text-emerald-200">
                  Account
                </IntentPrefetchLink>
                .
              </p>
            ) : null}
          </article>
        );
      })}
      {accounts.length === 0 ? <EmptyState>No visible accounts for this view.</EmptyState> : null}
    </section>
  );
}

function SchwabPositionsPanel({
  positions,
  openCampaignTickers,
  linkedSymbols,
}: {
  positions: SchwabPositions;
  openCampaignTickers: Set<string>;
  linkedSymbols: Set<string>;
}) {
  if (positions === null) {
    return null;
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 shadow-sm shadow-black/20">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-normal text-zinc-300">
          <ShieldCheck className="size-4 text-sky-300" aria-hidden />
          Your Schwab Positions
        </h2>
        <IntentPrefetchLink href="/account" className="text-xs font-medium text-emerald-300 hover:text-emerald-200">
          Manage connection
        </IntentPrefetchLink>
      </div>
      {positions.length === 0 ? (
        <p className="text-sm text-zinc-400">Schwab reports no open positions right now.</p>
      ) : (
        <div className="space-y-2">
          {positions.map((position) => {
            const classified = classifyBrokerPosition(position);
            const display = describeBrokerPositionForDisplay(position);
            const isLinked = linkedSymbols.has(position.symbol);
            const isMatch = !isLinked && openCampaignTickers.has(classified.underlying.toUpperCase());
            return (
              <div
                key={`${position.accountId}-${position.symbol}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm"
              >
                <div>
                  <div className="font-medium text-zinc-100">
                    {display.title} {display.detailLine ? <span className="text-zinc-400">· {display.detailLine}</span> : null}
                  </div>
                  <div className="text-xs text-zinc-500">{position.accountLabel}</div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-zinc-400">
                    {display.quantityLabel} · Market value: {money(position.marketValue)}
                  </span>
                  <Badge tone={isLinked ? "good" : isMatch ? "info" : "neutral"}>
                    {isLinked ? "Linked to Campaign" : isMatch ? "Possible match" : "Unlinked"}
                  </Badge>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-2 text-xs text-zinc-500">
        Broker positions as Schwab reports them. &quot;Possible match&quot; means an open campaign shares the
        same underlying ticker - it is not an automatic link. &quot;Linked to Campaign&quot; means you confirmed
        this position under Accounts -&gt; Broker Activity Awaiting Review; a linked position is counted once
        (via its Campaign), not twice, on the Dashboard. Unlinked positions still count separately until reviewed.
      </p>
    </div>
  );
}

function ImportStatusMessage({
  imported,
  discarded,
  linked,
  skipped,
}: {
  imported?: string;
  discarded?: string;
  linked?: string;
  skipped?: string;
}) {
  if (imported) {
    return (
      <div className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-100">
        Import confirmed. New records were added to your account; duplicates and unchanged snapshots were skipped.
      </div>
    );
  }
  if (discarded) {
    return <div className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-300">Import discarded. Nothing was saved.</div>;
  }
  if (linked) {
    return (
      <div className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-100">
        Linked. That broker position now maps to a Campaign and will count once on the Dashboard.
      </div>
    );
  }
  if (skipped) {
    return <div className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-300">Skipped. You can revisit this later.</div>;
  }
  return null;
}

function SchwabImportPanel({
  accounts,
  recentBatches,
}: {
  accounts: TrackerData["ownAccounts"];
  recentBatches: Awaited<ReturnType<typeof getBrokerImportBatchesForUser>>;
}) {
  return (
    <details className="group rounded-lg border border-zinc-800 bg-zinc-950 p-4 shadow-sm shadow-black/20">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-normal text-zinc-300">
          <ShieldCheck className="size-4 text-sky-300" aria-hidden />
          Import Schwab Data
        </span>
        <ChevronDown className="size-4 text-zinc-500 transition group-open:rotate-180" aria-hidden />
      </summary>
      <div className="mt-4 space-y-4 border-t border-zinc-800 pt-4">
        <p className="text-sm text-zinc-400">
          Upload a Schwab Positions, Transactions, or Realized Gain/Loss CSV export. You will see exactly what will
          change before anything is saved - selecting a file never immediately alters your history.
        </p>
        <form action={previewSchwabImportAction} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" encType="multipart/form-data">
          <div className="space-y-2">
            <FieldLabel>Account (optional)</FieldLabel>
            <select name="accountId" className={inputClass} defaultValue="">
              <option value="">Not linked to one account</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <FieldLabel>CSV file</FieldLabel>
            <input type="file" name="file" accept=".csv,text/csv" required className={inputClass} />
          </div>
          <button type="submit" className={primaryButtonClass}>
            <Plus className="size-4" aria-hidden />
            Preview Import
          </button>
        </form>
        {recentBatches.length > 0 ? (
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-normal text-zinc-500">Recent imports</div>
            <div className="space-y-1">
              {recentBatches.map((batch) => (
                <div key={batch.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-zinc-900/60 px-3 py-2 text-xs text-zinc-400">
                  <span className="truncate">{batch.safeOriginalFilename}</span>
                  <span className="flex items-center gap-2">
                    <Badge tone={batch.status === "CONFIRMED" ? "good" : batch.status === "DISCARDED" ? "neutral" : "warn"}>
                      {batch.status}
                    </Badge>
                    <span>
                      {batch.newCount} new · {batch.duplicateCount} dup · {batch.conflictCount} conflict · {batch.reviewCount} review ·{" "}
                      {batch.invalidCount} invalid
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </details>
  );
}

const CLASSIFICATION_TONE: Record<BrokerImportPreviewRow["classification"], "good" | "neutral" | "warn" | "bad" | "info"> = {
  NEW: "good",
  DUPLICATE: "neutral",
  CONFLICT: "bad",
  NEEDS_REVIEW: "warn",
  INVALID: "bad",
};

function SchwabImportPreviewPanel({
  batchId,
  batch,
  rows,
}: {
  batchId: string;
  batch: { exportType: string; safeOriginalFilename: string; rowCount: number; newCount: number; duplicateCount: number; conflictCount: number; reviewCount: number; invalidCount: number };
  rows: BrokerImportPreviewRow[];
}) {
  return (
    <div className="rounded-lg border border-emerald-400/30 bg-zinc-950 p-4 shadow-sm shadow-black/20">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-normal text-zinc-200">
          Preview: {batch.safeOriginalFilename} ({batch.exportType})
        </h2>
        <div className="flex gap-2">
          <form action={confirmSchwabImportAction}>
            <input type="hidden" name="batchId" value={batchId} />
            <button type="submit" className={primaryButtonClass}>
              Confirm Import
            </button>
          </form>
          <form action={discardSchwabImportAction}>
            <input type="hidden" name="batchId" value={batchId} />
            <button type="submit" className={tinyButtonClass}>
              Discard
            </button>
          </form>
        </div>
      </div>
      <dl className="mb-3 grid grid-cols-3 gap-3 text-sm sm:grid-cols-5">
        <ResultItem label="New" value={batch.newCount} tone={batch.newCount > 0 ? 1 : null} />
        <ResultItem label="Duplicate" value={batch.duplicateCount} />
        <ResultItem label="Conflict" value={batch.conflictCount} tone={batch.conflictCount > 0 ? -1 : null} />
        <ResultItem label="Needs review" value={batch.reviewCount} />
        <ResultItem label="Invalid" value={batch.invalidCount} tone={batch.invalidCount > 0 ? -1 : null} />
      </dl>
      <div className="max-h-96 space-y-1 overflow-y-auto">
        {rows.map((row, index) => (
          <div key={index} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-zinc-900/60 px-3 py-2 text-xs">
            <span className="text-zinc-300">
              {row.symbol ?? row.action ?? "Cash activity"} {row.occurredAt ? `· ${shortDate(row.occurredAt)}` : ""}
              {row.amount !== null ? ` · ${money(row.amount)}` : ""}
            </span>
            <span className="flex items-center gap-2">
              {row.reason ? <span className="text-zinc-500">{row.reason}</span> : null}
              <Badge tone={CLASSIFICATION_TONE[row.classification]}>{row.classification}</Badge>
            </span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        Nothing has been saved yet. Confirm to persist NEW/CONFLICT/NEEDS REVIEW rows; DUPLICATE and INVALID rows
        are never stored.
      </p>
    </div>
  );
}

function BrokerActivityAwaitingReviewPanel({
  items,
  accounts,
  buddyName,
}: {
  items: BrokerActivityAwaitingReview[];
  accounts: TrackerData["ownAccounts"];
  buddyName: string;
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 shadow-sm shadow-black/20">
      <h2 className="mb-3 inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-normal text-zinc-300">
        <Flag className="size-4 text-amber-300" aria-hidden />
        Broker Activity Awaiting Review
      </h2>
      <div className="space-y-3">
        {items.map((item) => (
          <details key={item.brokerRecordId} className="group rounded-lg border border-zinc-800 bg-zinc-900">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-3 [&::-webkit-details-marker]:hidden">
              <div>
                <div className="font-semibold text-zinc-50">
                  {item.suggestedTicker}
                  {item.likelyCsp ? <Badge tone="info">Likely CSP campaign</Badge> : null}
                </div>
                <div className="text-xs text-zinc-500">
                  {item.expiration ? shortDate(item.expiration) : "Unknown expiration"}
                  {item.strike !== null ? ` · $${item.strike.toFixed(2)} ${item.optionType === "PUT" ? "Put" : "Call"}` : ""} · Current
                  position: {item.quantity} · Transactions found: {item.transactionEvidenceCount}
                </div>
              </div>
              <ChevronDown className="size-4 text-zinc-500 transition group-open:rotate-180" aria-hidden />
            </summary>
            <div className="space-y-4 border-t border-zinc-800 p-3">
              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-normal text-zinc-500">Broker Evidence</div>
                <p className="text-sm text-zinc-400">
                  Schwab symbol {item.symbol} - current position {item.quantity}, {item.transactionEvidenceCount} matching
                  transaction record{item.transactionEvidenceCount === 1 ? "" : "s"} found.
                </p>
              </div>
              <div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-normal text-zinc-500">Proposed OSO Campaign</div>
                {accounts.length === 0 ? (
                  <EmptyState>Add an account first, then you can confirm this as a campaign.</EmptyState>
                ) : (
                  <form action={confirmBrokerReconciliationAction} className="grid gap-3 sm:grid-cols-3">
                    <input type="hidden" name="brokerRecordId" value={item.brokerRecordId} />
                    <div className="space-y-2">
                      <FieldLabel>Account</FieldLabel>
                      <select name="accountId" required className={inputClass} defaultValue={accounts[0]?.id}>
                        {accounts.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-2">
                      <FieldLabel>Ticker</FieldLabel>
                      <input name="ticker" defaultValue={item.suggestedTicker} required className={inputClass} />
                    </div>
                    <div className="space-y-2">
                      <FieldLabel>Trade date</FieldLabel>
                      <input name="tradeDate" type="date" defaultValue={item.suggestedTradeDate ?? dateInputValue(new Date())} required className={inputClass} />
                    </div>
                    <div className="space-y-2">
                      <FieldLabel>Expiration</FieldLabel>
                      <input name="expiration" type="date" defaultValue={item.suggestedExpiration ?? dateInputValue(daysFromNow(21))} required className={inputClass} />
                    </div>
                    <div className="space-y-2">
                      <FieldLabel>Strike</FieldLabel>
                      <input name="strike" type="number" step="0.01" min="0.01" defaultValue={item.suggestedStrike ?? undefined} required className={inputClass} />
                    </div>
                    <div className="space-y-2">
                      <FieldLabel>Contracts</FieldLabel>
                      <input name="contracts" type="number" step="1" min="1" defaultValue={item.suggestedContracts} required className={inputClass} />
                    </div>
                    <div className="space-y-2">
                      <FieldLabel>Credit per share</FieldLabel>
                      <input name="premium" type="number" step="0.0001" min="0" defaultValue={item.suggestedPremium ?? undefined} required className={inputClass} />
                    </div>
                    <div className="space-y-2">
                      <FieldLabel>Fees</FieldLabel>
                      <input name="fees" type="number" step="0.01" min="0" defaultValue="0" className={inputClass} />
                    </div>
                    <div className="space-y-2">
                      <FieldLabel>Visibility</FieldLabel>
                      <select name="visibility" defaultValue="INHERIT" className={inputClass}>
                        <option value="INHERIT">Follow account</option>
                        <option value="SHARED">Shared with {buddyName}</option>
                        <option value="PRIVATE">Private</option>
                      </select>
                    </div>
                    <div className="flex items-end gap-2 sm:col-span-3">
                      <button type="submit" className={primaryButtonClass}>
                        Confirm as Campaign
                      </button>
                    </div>
                  </form>
                )}
                <form action={skipBrokerReconciliationAction} className="mt-2">
                  <input type="hidden" name="brokerRecordId" value={item.brokerRecordId} />
                  <button type="submit" className={tinyButtonClass}>
                    Skip / Leave unlinked
                  </button>
                </form>
              </div>
            </div>
          </details>
        ))}
      </div>
      <p className="mt-3 text-xs text-zinc-500">
        Nothing here is ever turned into a Campaign automatically. Review the broker evidence, edit the proposed
        values if needed, then confirm or skip.
      </p>
    </div>
  );
}

function PerformanceSection({
  winLoss,
  goal,
  campaignRows,
  currentCampaignPLTotal,
  currentCampaignPartial,
  projectedOtmPartial,
}: {
  winLoss: ReturnType<typeof summarizeWinLoss>;
  goal: ContributionAdjustedGoalSummary;
  campaignRows: PerformanceCampaignViewRow[];
  currentCampaignPLTotal: number | null;
  currentCampaignPartial: boolean;
  projectedOtmPartial: boolean;
}) {
  const openCount = campaignRows.filter((row) => row.campaign.status === "OPEN").length;
  const assignedCount = campaignRows.filter((row) => row.campaign.status === "ASSIGNED").length;
  const markedCount = campaignRows.filter((row) => row.progress.currentPL !== null).length;
  const openProjected = sumKnown(campaignRows.map((row) => (row.campaign.status === "OPEN" ? row.progress.projectedOtmPL : null)));
  const activePremium = roundMoney(
    campaignRows
      .filter((row) => row.campaign.status !== "CLOSED")
      .reduce((sum, row) => sum + row.progress.netPremiumCollected, 0),
  );

  return (
    <section className="space-y-4" data-testid="performance-cockpit">
      <div className="grid gap-4 xl:grid-cols-[1.35fr_0.65fr]">
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 shadow-sm shadow-black/20">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-normal text-emerald-300">Performance Cockpit</p>
              <h2 className="mt-1 text-xl font-semibold text-zinc-50">Realized, current, projected</h2>
            </div>
            <Badge tone="info">Mine only</Badge>
          </div>
          <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <PerformanceMetric
              icon={<WalletCards className="size-4" aria-hidden />}
              label="Current Account Value"
              value={goal.currentValue === null ? "No data" : money(goal.currentValue)}
              detail="Ledger snapshot source"
              help={HELP.accountCurrentValue}
              helpTestId="help-current-account-value"
            />
            <PerformanceMetric
              icon={<Gauge className="size-4" aria-hidden />}
              label="Trading P/L Now"
              value={goal.tradingPLNow === null ? "Unavailable" : signedMoney(goal.tradingPLNow)}
              detail="Current - starting - net contributions"
              tone={goal.tradingPLNow}
              help={HELP.tradingPLNow}
              helpTestId="help-trading-pl-now"
            />
            <PerformanceMetric
              icon={<CircleDollarSign className="size-4" aria-hidden />}
              label="Realized P/L"
              value={signedMoney(winLoss.realizedTradingPL)}
              detail="Closed campaigns only"
              tone={winLoss.realizedTradingPL}
              help={HELP.realizedPL}
              helpTestId="help-realized-pl"
            />
            <PerformanceMetric
              icon={<Activity className="size-4" aria-hidden />}
              label="Current / MTM P/L"
              value={currentCampaignPLTotal === null ? "Unavailable" : signedMoney(currentCampaignPLTotal)}
              detail={currentCampaignPartial ? "Partial marks available" : "Closed plus marked open campaigns"}
              tone={currentCampaignPLTotal}
              help={HELP.currentMtm}
              helpTestId="help-current-mtm-pl"
            />
            <PerformanceMetric
              icon={<Target className="size-4" aria-hidden />}
              label="Projected OTM P/L"
              value={goal.projectedOtmPL === null ? "Unavailable" : signedMoney(goal.projectedOtmPL)}
              detail={projectedOtmPartial ? "Partial projection" : "Closed plus open CSP if OTM"}
              tone={goal.projectedOtmPL}
              help={HELP.projectedOtm}
              helpTestId="help-projected-otm-pl"
            />
            <PerformanceMetric
              icon={<Sparkles className="size-4" aria-hidden />}
              label="1% Goal Pace"
              value={goal.actualWeeklyPacePercent === null ? "No baseline" : percent(goal.actualWeeklyPacePercent)}
              detail={`${goal.targetWeeklyPercent}% weekly target`}
              tone={goal.aheadBehindDollars}
              help={HELP.currentPace}
              helpTestId="help-current-pace"
            />
          </dl>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 shadow-sm shadow-black/20">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold uppercase tracking-normal text-zinc-300">
            <Target className="size-4 text-emerald-300" aria-hidden />
            1% Goal Tracker
            <InfoTip label="1% weekly target" align="start" testId="help-one-percent-target">
              {HELP.onePercentTarget}
            </InfoTip>
          </div>
          <GoalTracker goal={goal} />
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[0.72fr_1.28fr]">
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 shadow-sm shadow-black/20">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold uppercase tracking-normal text-zinc-300">
            <LineChart className="size-4 text-sky-300" aria-hidden />
            Performance vs 1% Target
            <InfoTip label="Performance vs target" align="start" testId="help-target-comparison">
              {HELP.targetComparison}
            </InfoTip>
          </div>
          <PerformanceGoalChart goal={goal} />
        </div>

        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 shadow-sm shadow-black/20">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold uppercase tracking-normal text-zinc-300">
            <BarChart3 className="size-4 text-emerald-300" aria-hidden />
            Closed Campaign Stats
          </div>
          <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <ResultItem label="Completed" value={winLoss.completedCount} />
            <ResultItem label="Wins" value={winLoss.wins} />
            <ResultItem label="Losses" value={winLoss.losses} />
            <ResultItem
              label="Win rate"
              value={winLoss.winRate === null ? "N/A" : percent(winLoss.winRate, 1)}
              help={HELP.winRate}
              helpTestId="help-win-rate"
            />
            <ResultItem label="Avg win" value={winLoss.averageWin === null ? "N/A" : money(winLoss.averageWin)} tone={winLoss.averageWin} />
            <ResultItem label="Avg loss" value={winLoss.averageLoss === null ? "N/A" : money(winLoss.averageLoss)} tone={winLoss.averageLoss} />
            <ResultItem label="Avg duration" value={winLoss.averageDurationDays === null ? "N/A" : `${winLoss.averageDurationDays} days`} />
            <ResultItem
              label="Active premium"
              value={signedMoney(activePremium)}
              tone={activePremium}
              help={HELP.netPremium}
            />
          </dl>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <Badge tone="info">{openCount} open</Badge>
            <Badge tone="warn">{assignedCount} assigned</Badge>
            <Badge tone={markedCount > 0 ? "good" : "neutral"}>{markedCount} with current marks</Badge>
            <Badge tone={openProjected !== null && openProjected > 0 ? "good" : "neutral"}>
              Open OTM {openProjected === null ? "unavailable" : signedMoney(openProjected)}
            </Badge>
          </div>
          {winLoss.unknownResults > 0 ? (
            <p className="mt-2 text-xs text-zinc-500">
              {winLoss.unknownResults} closed campaign{winLoss.unknownResults === 1 ? "" : "s"} without a known final P/L excluded
              from win/loss math.
            </p>
          ) : null}
        </div>
      </div>

      <CampaignPerformanceTable rows={campaignRows} />
    </section>
  );
}

function PerformanceMetric({
  icon,
  label,
  value,
  detail,
  tone,
  help,
  helpTestId,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  detail: string;
  tone?: number | null;
  help?: string;
  helpTestId?: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
      <dt className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-normal text-zinc-500">
        <span className="text-zinc-400">{icon}</span>
        <HelpLabel label={label} help={help} testId={helpTestId} />
      </dt>
      <dd className={`mt-2 text-xl font-semibold ${toneClass(tone)}`}>{value}</dd>
      <div className="mt-1 text-xs text-zinc-500">{detail}</div>
    </div>
  );
}

function GoalTracker({ goal }: { goal: ContributionAdjustedGoalSummary }) {
  if (goal.status === "NO_STARTING_VALUE") {
    return <EmptyState>Add a starting value in the Account ledger to activate the 1% goal.</EmptyState>;
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-3">
        <ResultItem
          label="Starting"
          value={goal.startingCapital === null ? "No data" : money(goal.startingCapital)}
          help={HELP.startingValue}
          helpTestId="help-starting-value"
        />
        <ResultItem
          label="Net contributions"
          value={money(goal.netContributions)}
          tone={goal.netContributions}
          help={HELP.netContributions}
          helpTestId="help-net-contributions"
        />
        <ResultItem
          label="Target profit"
          value={goal.targetProfit === null ? "No data" : money(goal.targetProfit)}
          help={HELP.onePercentTarget}
        />
        <ResultItem
          label="Ahead / behind"
          value={goal.aheadBehindDollars === null ? "No data" : signedMoney(goal.aheadBehindDollars)}
          tone={goal.aheadBehindDollars}
          help={HELP.targetComparison}
          helpTestId="help-ahead-behind"
        />
      </div>
      <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3">
        <div className="mb-2 flex items-center justify-between gap-3 text-xs uppercase tracking-normal text-zinc-500">
          <HelpLabel label="Actual pace" help={HELP.currentPace} testId="help-actual-pace" />
          <span className={toneClass(goal.aheadBehindDollars)}>{goal.percentOfTarget === null ? "N/A" : `${goal.percentOfTarget.toFixed(1)}%`}</span>
        </div>
        <Meter value={goal.percentOfTarget} />
        <div className="mt-2 flex items-center justify-between gap-3 text-xs text-zinc-500">
          <span>{goal.actualWeeklyPacePercent === null ? "No baseline" : percent(goal.actualWeeklyPacePercent)}</span>
          <span>Target {percent(goal.targetWeeklyPercent)}</span>
        </div>
      </div>
      <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3">
        <div className="mb-2 flex items-center justify-between gap-3 text-xs uppercase tracking-normal text-zinc-500">
          <HelpLabel label="Projected if OTM" help={HELP.projectedOtmPace} testId="help-projected-otm-pace" />
          <span className={toneClass(goal.projectedOtmPL)}>{goal.projectedPercentOfTarget === null ? "N/A" : `${goal.projectedPercentOfTarget.toFixed(1)}%`}</span>
        </div>
        <Meter value={goal.projectedPercentOfTarget} />
        <div className="mt-2 text-xs text-zinc-500">{goal.projectedWeeklyPacePercent === null ? "No projection" : `${percent(goal.projectedWeeklyPacePercent)} weekly pace`}</div>
      </div>
    </div>
  );
}

function PerformanceGoalChart({ goal }: { goal: ContributionAdjustedGoalSummary }) {
  const rows = [
    { label: "Target", value: goal.targetProfit, tone: "bg-sky-300" },
    { label: "Trading now", value: goal.tradingPLNow, tone: goalTone(goal.tradingPLNow) },
    { label: "If open CSPs expire OTM", value: goal.projectedOtmPL, tone: goalTone(goal.projectedOtmPL) },
  ];
  const max = Math.max(1, ...rows.map((row) => Math.abs(row.value ?? 0)));

  return (
    <div className="space-y-3">
      <div className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
        Color guide
        <InfoTip label="Performance color guide" align="start" testId="help-color-guide">
          {HELP.colorLegend}
        </InfoTip>
      </div>
      {rows.map((row) => {
        const width = row.value === null ? 0 : Math.max(4, Math.min(100, (Math.abs(row.value) / max) * 100));
        return (
          <div key={row.label}>
            <div className="mb-1 flex items-center justify-between gap-3 text-xs text-zinc-500">
              <span>{row.label}</span>
              <span className={toneClass(row.value)}>{row.value === null ? "Unavailable" : signedMoney(row.value)}</span>
            </div>
            <div className="h-3 rounded-full bg-zinc-900">
              <div className={`h-3 rounded-full ${row.tone}`} style={{ width: `${width}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CampaignPerformanceTable({ rows }: { rows: PerformanceCampaignViewRow[] }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 shadow-sm shadow-black/20" data-testid="performance-campaign-table">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-normal text-zinc-300">
          <ClipboardList className="size-4 text-emerald-300" aria-hidden />
          Campaign Performance
        </div>
        <Badge tone="neutral">{rows.length} total</Badge>
      </div>
      {rows.length === 0 ? (
        <EmptyState>No campaigns yet.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[980px] divide-y divide-zinc-800">
            <div className="grid grid-cols-[1.05fr_0.75fr_0.85fr_0.9fr_0.9fr_0.9fr_0.85fr_0.7fr_0.7fr] gap-3 px-3 pb-2 text-[11px] font-semibold uppercase tracking-normal text-zinc-500">
              <span>Ticker</span>
              <HelpLabel label="Status" help={HELP.historyStatus} testId="help-campaign-status" align="start" />
              <HelpLabel label="Secured Capital" help={HELP.capitalSecured} testId="help-secured-capital" align="start" />
              <HelpLabel label="Net Premium" help={HELP.netPremium} testId="help-campaign-net-premium" align="start" />
              <HelpLabel label="Current P/L" help={HELP.currentMtm} testId="help-campaign-current-pl" align="start" />
              <HelpLabel label="Projected OTM" help={HELP.projectedOtm} testId="help-campaign-projected-otm" align="start" />
              <HelpLabel label="Goal Need" help={HELP.goalNeed} testId="help-goal-need" align="start" />
              <HelpLabel label="Rolls" help={HELP.rolls} testId="help-rolls" align="start" />
              <span>Days</span>
            </div>
            {rows.map((row) => (
              <CampaignPerformanceRow key={row.campaign.id} row={row} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CampaignPerformanceRow({ row }: { row: PerformanceCampaignViewRow }) {
  const { campaign, progress } = row;
  const goalDelta =
    progress.projectedReturnPercent === null || progress.requiredReturnPercent === null
      ? null
      : roundMoney(progress.projectedReturnPercent - progress.requiredReturnPercent);

  return (
    <details className="group" data-testid={`performance-campaign-${campaign.ticker}`}>
      <summary className="grid cursor-pointer list-none grid-cols-[1.05fr_0.75fr_0.85fr_0.9fr_0.9fr_0.9fr_0.85fr_0.7fr_0.7fr] gap-3 px-3 py-3 text-sm transition hover:bg-zinc-900/70 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="font-semibold text-zinc-50">{campaign.ticker}</span>
          <span className="mt-0.5 block truncate text-xs text-zinc-500">{campaign.accountId ? shortDate(campaign.openedAt) : "Campaign"}</span>
        </span>
        <span>
          <Badge tone={statusTone(campaign.status, progress.realizedPL ?? progress.currentPL)}>{campaign.status}</Badge>
        </span>
        <span>{progress.collateralCommitted === null ? "UNKNOWN" : money(progress.collateralCommitted)}</span>
        <span className={toneClass(progress.netPremiumCollected)}>{signedMoney(progress.netPremiumCollected)}</span>
        <span className={toneClass(progress.currentPL)}>
          {progress.currentPL === null ? "Unavailable" : signedMoney(progress.currentPL)}
        </span>
        <span className={toneClass(progress.projectedOtmPL)}>
          {progress.projectedOtmPL === null ? (progress.projectedOtmApplicable ? "Unavailable" : "N/A") : signedMoney(progress.projectedOtmPL)}
        </span>
        <span className={toneClass(goalDelta)}>
          {goalDelta === null ? "N/A" : `${goalDelta >= 0 ? "+" : ""}${goalDelta.toFixed(2)} pts`}
        </span>
        <span>{progress.rollCount}</span>
        <span className="inline-flex items-center gap-1">
          <Timer className="size-3.5 text-zinc-500" aria-hidden />
          {progress.daysActive ?? "UNKNOWN"}
        </span>
      </summary>
      <div className="grid gap-4 border-t border-zinc-800 bg-zinc-900/40 px-3 py-4 text-sm lg:grid-cols-[1fr_1fr]">
        <div>
          <div className="mb-2 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-normal text-zinc-500">
            Accounting Split
            <InfoTip label="Campaign accounting split" align="start">
              Realized, current, and projected results answer different questions. OSO keeps them separate so open campaigns do not look closed.
            </InfoTip>
          </div>
          <dl className="grid gap-3 sm:grid-cols-2">
            <ResultItem
              label="Realized P/L"
              value={progress.realizedPL === null ? "Not closed" : signedMoney(progress.realizedPL)}
              tone={progress.realizedPL}
              help={HELP.realizedPL}
            />
            <ResultItem
              label="Current cost to close"
              value={progress.currentCostToClose === null ? "Unavailable" : money(progress.currentCostToClose)}
              help={HELP.currentCostToClose}
            />
            <ResultItem
              label="Current return"
              value={progress.currentReturnPercent === null ? "N/A" : percent(progress.currentReturnPercent)}
              tone={progress.currentReturnPercent}
              help={HELP.currentReturn}
            />
            <ResultItem
              label="Projected return"
              value={progress.projectedReturnPercent === null ? "N/A" : percent(progress.projectedReturnPercent)}
              tone={progress.projectedReturnPercent}
              help={HELP.projectedReturn}
            />
          </dl>
        </div>
        <div>
          <div className="mb-2 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-normal text-zinc-500">
            Current Mark Source
            <InfoTip label="Mark source" align="start" testId="help-mark-source">
              {HELP.markSource}
            </InfoTip>
          </div>
          {row.currentCostSource ? (
            <div className="rounded-md border border-zinc-800 bg-zinc-950/70 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={row.currentCostSource.source === "LINKED_BROKER_POSITION" ? "info" : "neutral"}>
                  {row.currentCostSource.label}
                </Badge>
                <span className="text-zinc-400">{money(row.currentCostSource.costToClose)} cost to close</span>
              </div>
              <p className="mt-2 text-xs text-zinc-500">
                {row.currentCostSource.asOf ? `As of ${shortDate(row.currentCostSource.asOf)}.` : "Snapshot date unavailable."}
              </p>
            </div>
          ) : (
            <EmptyState>Current mark unavailable for this campaign.</EmptyState>
          )}
        </div>
      </div>
    </details>
  );
}

function Meter({ value }: { value: number | null }) {
  const width = value === null ? 0 : Math.max(4, Math.min(100, value));
  const tone = value === null ? "bg-zinc-700" : value >= 100 ? "bg-emerald-300" : value >= 60 ? "bg-amber-300" : "bg-red-300";

  return (
    <div className="h-2.5 rounded-full bg-zinc-950">
      <div className={`h-2.5 rounded-full ${tone}`} style={{ width: `${width}%` }} />
    </div>
  );
}

function LegacySnapshots({ trades }: { trades: TrackerData["legacyTrades"] }) {
  return (
    <details className="group rounded-lg border border-dashed border-zinc-800 p-4 text-sm text-zinc-400">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
        <span>Legacy open CSP snapshots ({trades.length})</span>
        <ChevronDown className="size-4 transition group-open:rotate-180" aria-hidden />
      </summary>
      <div className="mt-3 grid gap-2 border-t border-zinc-800 pt-3 sm:grid-cols-2 lg:grid-cols-3">
        {trades.map((trade) => (
          <div key={trade.id} className="flex items-center justify-between rounded-md bg-zinc-900/60 px-3 py-2">
            <span className="font-medium text-zinc-200">{trade.symbol}</span>
            <span>{trade.status}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

function TrackerStat({
  icon,
  label,
  value,
  detail,
  tone,
  help,
  helpTestId,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  detail: string;
  tone?: number | null;
  help?: string;
  helpTestId?: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 shadow-sm shadow-black/20">
      <div className="flex items-center gap-2 text-xs uppercase tracking-normal text-zinc-500">
        <span className="text-zinc-400">{icon}</span>
        <HelpLabel label={label} help={help} testId={helpTestId} />
      </div>
      <div className={`mt-2 text-2xl font-semibold ${toneClass(tone)}`}>{value}</div>
      <div className="mt-1 text-xs text-zinc-500">{detail}</div>
    </div>
  );
}

function SummaryCell({
  label,
  value,
  tone,
  help,
  helpTestId,
}: {
  label: string;
  value: ReactNode;
  tone?: number | null;
  help?: string;
  helpTestId?: string;
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-normal text-zinc-500">
        <HelpLabel label={label} help={help} testId={helpTestId} />
      </div>
      <div className={`mt-1 text-sm font-semibold ${toneClass(tone)}`}>{value}</div>
    </div>
  );
}

function ResultItem({
  label,
  value,
  tone,
  help,
  helpTestId,
}: {
  label: string;
  value: ReactNode;
  tone?: number | null;
  help?: string;
  helpTestId?: string;
}) {
  return (
    <div className="border-t border-zinc-800 pt-2">
      <dt className="text-xs uppercase tracking-normal text-zinc-500">
        <HelpLabel label={label} help={help} testId={helpTestId} />
      </dt>
      <dd className={`mt-1 font-medium ${toneClass(tone)}`}>{value}</dd>
    </div>
  );
}

function HelpLabel({
  label,
  help,
  testId,
  align = "center",
}: {
  label: string;
  help?: string;
  testId?: string;
  align?: "start" | "center" | "end";
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {label}
      {help ? (
        <InfoTip label={label} align={align} testId={testId}>
          {help}
        </InfoTip>
      ) : null}
    </span>
  );
}

function VisibilityBadge({
  effectiveVisibility,
  rawVisibility,
}: {
  effectiveVisibility: "PRIVATE" | "SHARED";
  rawVisibility: "INHERIT" | "PRIVATE" | "SHARED";
}) {
  return (
    <Badge tone={effectiveVisibility === "SHARED" ? "info" : "warn"}>
      {effectiveVisibility === "SHARED" ? <Users className="mr-1 size-3.5" aria-hidden /> : <Lock className="mr-1 size-3.5" aria-hidden />}
      {effectiveVisibility === "SHARED" ? "Shared" : "Private"}
      {rawVisibility === "INHERIT" ? " via account" : null}
    </Badge>
  );
}

function timelineGroups(events: CampaignEventRow[]) {
  const groups: { key: string; label: string; events: CampaignEventRow[] }[] = [];
  const byGroup = new Map<string, { key: string; label: string; events: CampaignEventRow[] }>();

  for (const event of events) {
    if (event.groupKey && event.type.startsWith("ROLL_PUT")) {
      const key = `roll-${event.groupKey}`;
      const group = byGroup.get(key) ?? { key, label: "Roll", events: [] };
      group.events.push(event);
      byGroup.set(key, group);
      if (!groups.includes(group)) {
        groups.push(group);
      }
      continue;
    }

    groups.push({ key: event.id, label: eventLabel(event.type), events: [event] });
  }

  return groups;
}

function eventDescription(event: CampaignEventRow) {
  if (event.type === "ASSIGNMENT") {
    const shares = event.shares ?? (event.contracts ?? 0) * 100;
    return `${shares} shares assigned at ${money(event.strike)}`;
  }

  if (event.type === "STOCK_SALE") {
    return `${event.shares ?? "Unknown"} shares sold`;
  }

  if (event.type === "NOTE") {
    return event.notes ?? "Campaign note";
  }

  const optionType = event.optionType === "CALL" ? "Call" : "Put";
  const contractText = `${event.contracts ?? "?"} ${event.contracts === 1 ? "contract" : "contracts"}`;
  const expiration = event.expiration ? shortDate(event.expiration) : "unknown expiration";
  return `${expiration} ${money(event.strike)} ${optionType} / ${contractText}`;
}

function eventAmount(event: CampaignEventRow) {
  const fees = toNumber(event.fees);
  if (event.type === "SELL_PUT" || event.type === "ROLL_PUT_OPEN" || event.type === "SELL_COVERED_CALL") {
    const value = optionLegValue(event);
    return value === null ? null : value - fees;
  }

  if (event.type === "CLOSE_PUT" || event.type === "ROLL_PUT_CLOSE" || event.type === "CLOSE_COVERED_CALL") {
    const value = optionLegValue(event);
    return value === null ? null : -(value + fees);
  }

  if (event.type === "ASSIGNMENT") {
    const shares = event.shares ?? (event.contracts ?? 0) * 100;
    return -roundMoney(toNumber(event.strike) * shares + fees);
  }

  if (event.type === "STOCK_SALE") {
    const cashAmount = event.cashAmount === null ? null : toNumber(event.cashAmount);
    const shares = event.shares ?? 0;
    const price = event.underlyingPrice === null ? null : toNumber(event.underlyingPrice);
    const proceeds = cashAmount ?? (price === null ? null : shares * price);
    return proceeds === null ? null : roundMoney(proceeds - fees);
  }

  return event.type === "COVERED_CALL_EXPIRED" ? 0 : null;
}

function eventLabel(type: string) {
  switch (type) {
    case "SELL_PUT":
      return "Sell to Open";
    case "CLOSE_PUT":
      return "Buy to Close";
    case "ROLL_PUT_CLOSE":
    case "ROLL_PUT_OPEN":
      return "Roll";
    case "ASSIGNMENT":
      return "Assignment";
    case "SELL_COVERED_CALL":
      return "Sell Covered Call";
    case "CLOSE_COVERED_CALL":
      return "Close Covered Call";
    case "COVERED_CALL_EXPIRED":
      return "Covered Call Expired";
    case "STOCK_SALE":
      return "Shares Sold";
    default:
      return "Note";
  }
}

function eventHelp(type: string) {
  switch (type) {
    case "SELL_PUT":
    case "SELL_COVERED_CALL":
      return HELP.sto;
    case "CLOSE_PUT":
    case "CLOSE_COVERED_CALL":
      return HELP.btc;
    case "ROLL_PUT_CLOSE":
    case "ROLL_PUT_OPEN":
      return HELP.roll;
    default:
      return null;
  }
}

function entrySnapshotText(value: unknown) {
  if (!value || typeof value !== "object") {
    return "Stored with the campaign for future performance reports.";
  }

  const snapshot = value as {
    scannerStatus?: string;
    passedCriteria?: number;
    totalCriteria?: number;
    profileName?: string;
  };
  if (snapshot.scannerStatus && snapshot.totalCriteria) {
    return `${snapshot.profileName ?? "Scanner"} ${snapshot.scannerStatus}: ${snapshot.passedCriteria ?? 0}/${snapshot.totalCriteria} criteria at entry.`;
  }

  return "Stored with the campaign for future performance reports.";
}

function resolveCurrentCostToClose(
  campaign: PerformanceCampaignRow,
  optionMarksByKey: Map<string, OptionMarkRow>,
): CurrentCostToCloseSource | null {
  if (campaign.status !== "OPEN") {
    return null;
  }

  for (const record of campaign.linkedBrokerRecords) {
    const position = brokerPositionFromRecord(record);
    if (!position) {
      continue;
    }
    if (classifyBrokerPosition(position).kind !== "SHORT_PUT") {
      continue;
    }

    return {
      costToClose: roundMoney(Math.abs(position.marketValue)),
      source: "LINKED_BROKER_POSITION",
      label: "Linked Schwab position",
      asOf: record.observedAt ?? null,
    };
  }

  const activePut = findActiveOpenPutEvent(campaign.events);
  if (!activePut) {
    return null;
  }

  const snapshot = optionMarksByKey.get(optionContractKey(campaign.ticker, activePut.expiration, activePut.strike, "PUT"));
  if (!snapshot) {
    return null;
  }

  const mark = toNullableNumber(snapshot.mark);
  const bid = toNullableNumber(snapshot.bid);
  const ask = toNullableNumber(snapshot.ask);
  const midpoint = bid === null || ask === null ? null : (bid + ask) / 2;
  const markPerShare = mark !== null && mark > 0 ? mark : midpoint;
  if (markPerShare === null) {
    return null;
  }

  return {
    costToClose: roundMoney(markPerShare * activePut.contracts * 100),
    source: "CACHED_OPTION_MARK",
    label: "Cached option mark",
    asOf: snapshot.capturedAt,
  };
}

function brokerPositionFromRecord(record: PerformanceCampaignRow["linkedBrokerRecords"][number]): BrokerPosition | null {
  const symbol = record.symbol;
  const quantity = toNullableNumber(record.quantity);
  const marketValue = toNullableNumber(record.amount);
  if (!symbol || quantity === null || marketValue === null) {
    return null;
  }

  const metadata = objectValue(record.metadata);
  const putCallRaw = stringValue(metadata?.putCall);
  return {
    accountId: record.accountId ?? stringValue(metadata?.accountId) ?? "linked-broker-record",
    symbol,
    quantity,
    marketValue,
    assetType: stringValue(metadata?.assetType),
    putCall: putCallRaw === "PUT" || putCallRaw === "CALL" ? putCallRaw : null,
    strikePrice: toNullableNumber(metadata?.strikePrice),
    underlyingSymbol: record.underlyingSymbol ?? stringValue(metadata?.underlyingSymbol),
  };
}

function findActiveOpenPutEvent(events: PerformanceCampaignRow["events"]) {
  const lastTradeEvent =
    [...events]
      .sort((left, right) => {
        const dateDelta = new Date(left.occurredAt).getTime() - new Date(right.occurredAt).getTime();
        return dateDelta === 0 ? left.sortOrder - right.sortOrder : dateDelta;
      })
      .reverse()
      .find((event) => event.type !== "NOTE") ?? null;

  if (!lastTradeEvent || (lastTradeEvent.type !== "SELL_PUT" && lastTradeEvent.type !== "ROLL_PUT_OPEN")) {
    return null;
  }
  if (lastTradeEvent.optionType === "CALL") {
    return null;
  }

  const contracts = toNullableNumber(lastTradeEvent.contracts);
  const strike = toNullableNumber(lastTradeEvent.strike);
  if (contracts === null || contracts <= 0 || strike === null || strike <= 0 || !lastTradeEvent.expiration) {
    return null;
  }

  return {
    contracts,
    strike,
    expiration: lastTradeEvent.expiration,
  };
}

function sumKnown(values: Array<number | null>) {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? roundMoney(known.reduce((sum, value) => sum + value, 0)) : null;
}

function goalTone(value: number | null) {
  if (value === null) {
    return "bg-zinc-700";
  }
  return value >= 0 ? "bg-emerald-300" : "bg-red-300";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = toNumber(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function parseViewMode(value: string | undefined): ViewMode {
  return value === "history" || value === "performance" || value === "accounts" ? value : "open";
}

function trackerHref(scope: TrackerScope, view: ViewMode) {
  const params = new URLSearchParams();
  params.set("scope", scope);
  if (view !== "open") {
    params.set("view", view);
  }
  return `/positions?${params.toString()}`;
}

function segmentClass(active: boolean) {
  return `rounded-md border px-3 py-2 text-sm transition ${
    active
      ? "border-emerald-400/70 bg-emerald-400/15 text-emerald-100"
      : "border-zinc-800 bg-zinc-900 text-zinc-300 hover:border-zinc-600 hover:text-zinc-50"
  }`;
}

function statusTone(status: string, pl: number | null) {
  if (status === "CLOSED") {
    return pl === null ? "neutral" : pl < 0 ? "bad" : "good";
  }
  if (status === "ASSIGNED") {
    return "warn";
  }
  return "info";
}

function signedMoney(value: number | null) {
  if (value === null) {
    return "UNKNOWN";
  }

  return `${value > 0 ? "+" : ""}${money(value)}`;
}

function toneClass(value?: number | null) {
  if (value === null || value === undefined) {
    return "text-zinc-50";
  }
  if (value > 0) {
    return "text-emerald-200";
  }
  if (value < 0) {
    return "text-red-200";
  }
  return "text-zinc-50";
}

function amountClass(value: number) {
  return `font-medium ${toneClass(value)}`;
}

function dateInputValue(date: Date) {
  return date.toISOString().slice(0, 10);
}

function daysFromNow(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

const inputClass =
  "min-h-10 w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-emerald-400/70";
const primaryButtonClass =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-emerald-400 px-4 text-sm font-semibold text-black transition hover:bg-emerald-300";
const secondaryButtonClass =
  "inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-md border border-zinc-700 px-4 text-sm font-semibold text-zinc-100 transition hover:border-sky-400/70 hover:text-sky-100";
const tinyButtonClass =
  "inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 text-xs font-medium text-zinc-300 transition hover:border-emerald-400/60 hover:text-emerald-100";
