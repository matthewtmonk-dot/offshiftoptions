import Link from "next/link";
import type { ReactNode } from "react";
import {
  ChevronDown,
  CircleDollarSign,
  ClipboardList,
  Flag,
  History,
  Lock,
  Plus,
  Repeat2,
  ShieldCheck,
  TrendingUp,
  Users,
  WalletCards,
} from "lucide-react";
import { Badge, EmptyState, FieldLabel } from "@/components/ui";
import { currentAccountValue, summarizeAccountLedger } from "@/domain/finance/accountLedger";
import { optionLegValue, summarizeCampaign } from "@/domain/finance/campaigns";
import { summarizeWeeklyReturns, summarizeWinLoss } from "@/domain/finance/performance";
import { requireCurrentUser } from "@/lib/auth";
import { getTrackerPageData, normalizeTrackerScope, type TrackerScope } from "@/lib/app-data";
import { money, percent, shortDate, toNumber } from "@/lib/format";
import { resolveInheritedVisibility } from "@/lib/privacy";
import { getSchwabOpenPositionsForUser } from "@/lib/workflows";
import {
  assignCampaignPutAction,
  closeCampaignPutAction,
  createCampaignAction,
  createTradingAccountAction,
  rollCampaignPutAction,
  toggleCampaignVisibilityAction,
  toggleTradingAccountVisibilityAction,
} from "../actions";

export const dynamic = "force-dynamic";

const WEEKLY_TARGET_PERCENT = 1;

type TrackerData = Awaited<ReturnType<typeof getTrackerPageData>>;
type CampaignRow = TrackerData["campaigns"][number];
type CampaignEventRow = CampaignRow["events"][number];
type AccountRow = TrackerData["visibleAccounts"][number];
type ViewMode = "open" | "history" | "performance" | "accounts";
type SchwabPositions = Awaited<ReturnType<typeof getSchwabOpenPositionsForUser>>;

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
  const [data, schwabPositions] = await Promise.all([
    getTrackerPageData(user.id, scope),
    getSchwabOpenPositionsForUser(user.id),
  ]);
  const buddyName = data.users[0]?.name ?? "Buddy";
  const rows = data.campaigns.map((campaign) => ({
    campaign,
    summary: summarizeCampaign({ status: campaign.status, events: campaign.events }),
  }));
  const openRows = rows.filter((row) => row.campaign.status !== "CLOSED");
  const historyRows = rows.filter((row) => row.campaign.status === "CLOSED");
  const openCount = openRows.length;
  const closedCount = historyRows.length;
  const realizedTotal = rows.reduce((sum, row) => sum + (row.summary.realizedPL ?? 0), 0);
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
  const ownBaseline = ownCurrentValues.some((value) => value.value !== null)
    ? ownCurrentValues.reduce((sum, value) => sum + (value.value ?? 0), 0)
    : null;
  const ownStartingTotal = ownAccountRows.reduce((sum, row) => sum + (row.ledger.startingValue ?? 0), 0);
  const ownContributionsTotal = ownAccountRows.reduce((sum, row) => sum + row.ledger.netContributions, 0);
  const ownWinLoss = summarizeWinLoss(ownCompletedForPerformance);
  const ownWeekly = summarizeWeeklyReturns(ownCompletedForPerformance, ownBaseline, WEEKLY_TARGET_PERCENT);

  // Realized P/L per account for the Accounts tab - bucketed per account, never summed
  // across accounts owned by different users.
  const realizedByAccount = new Map<string, number>();
  for (const row of historyRows) {
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
            <Link key={option} href={trackerHref(option, view)} className={segmentClass(scope === option)}>
              {option === "mine" ? "Mine" : option === "buddy" ? buddyName : "Both"}
            </Link>
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
          detail={`${openCount} open / ${closedCount} closed`}
        />
        <TrackerStat
          icon={<CircleDollarSign className="size-4" aria-hidden />}
          label="Known realized P/L"
          value={signedMoney(realizedTotal)}
          detail="Open shares can remain unknown"
          tone={realizedTotal}
        />
        <TrackerStat
          icon={<TrendingUp className="size-4" aria-hidden />}
          label="Net option premium"
          value={signedMoney(premiumTotal)}
          detail="Credits minus debits and option fees"
          tone={premiumTotal}
        />
        <TrackerStat
          icon={<WalletCards className="size-4" aria-hidden />}
          label="Visible accounts"
          value={data.visibleAccounts.length}
          detail={`${data.ownAccounts.length} available for new campaigns`}
        />
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-md border border-zinc-800 bg-zinc-950 p-1">
          {(
            [
              ["open", "Open"],
              ["history", "History"],
              ["performance", "Performance"],
              ["accounts", "Accounts"],
            ] as [ViewMode, string][]
          ).map(([mode, label]) => (
            <Link key={mode} href={trackerHref(scope, mode)} className={tabClass(view === mode)}>
              {label}
            </Link>
          ))}
        </div>
        <p className="text-xs text-zinc-500">Demo/manual data only. Trade execution stays outside this app.</p>
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

          <SchwabPositionsPanel positions={schwabPositions} openCampaignTickers={openCampaignTickers} />

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
        <section className="space-y-3">
          {historyRows.map((row) => (
            <CampaignCard key={row.campaign.id} row={row} currentUserId={user.id} />
          ))}
          {historyRows.length === 0 ? <EmptyState>No closed campaigns yet for this view.</EmptyState> : null}
        </section>
      ) : null}

      {view === "performance" ? (
        <PerformanceSection
          winLoss={ownWinLoss}
          weekly={ownWeekly}
          startingTotal={ownStartingTotal}
          contributionsTotal={ownContributionsTotal}
          currentTotal={ownBaseline}
        />
      ) : null}

      {view === "accounts" ? (
        <AccountsSection
          accounts={data.visibleAccounts}
          currentUserId={user.id}
          buddyName={buddyName}
          realizedByAccount={realizedByAccount}
        />
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
  const plValue = summary.totalCampaignPL ?? summary.realizedPL;

  return (
    <details className="group rounded-lg border border-zinc-800 bg-zinc-950 shadow-sm shadow-black/20">
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
          <SummaryCell label="Realized" value={signedMoney(summary.realizedPL)} tone={summary.realizedPL} />
          <SummaryCell label="Premium" value={signedMoney(summary.netOptionPremium)} tone={summary.netOptionPremium} />
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
                <ResultItem label="Total credits" value={money(summary.totalPremiumReceived)} />
                <ResultItem label="Total debits" value={money(summary.optionDebitsPaid)} />
                <ResultItem label="Roll net" value={signedMoney(summary.netRollPremium)} tone={summary.netRollPremium} />
                <ResultItem label="Capital committed" value={summary.collateralCommitted === null ? "UNKNOWN" : money(summary.collateralCommitted)} />
                <ResultItem label="Stock cost" value={money(summary.stockCost)} />
                <ResultItem label="Stock proceeds" value={money(summary.stockProceeds)} />
                <ResultItem label="Shares held" value={summary.sharesHeld} />
                <ResultItem label="Adjusted basis" value={summary.adjustedBasis === null ? "UNKNOWN" : money(summary.adjustedBasis)} />
              </dl>
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

  return (
    <div className="grid grid-cols-[88px_1fr] gap-3 text-sm">
      <div className="text-xs text-zinc-500">{shortDate(group.events[0].occurredAt)}</div>
      <div className="border-l border-zinc-800 pl-3">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <div className="font-semibold text-zinc-100">{group.label}</div>
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
              <ResultItem label="Starting" value={ledger.startingValue === null ? "UNKNOWN" : money(ledger.startingValue)} />
              <ResultItem label="Contributions" value={money(ledger.netContributions)} tone={ledger.netContributions} />
              <ResultItem
                label="Current"
                value={current.value === null ? "No data" : money(current.value)}
              />
              <ResultItem label="Campaigns" value={account._count.campaigns} />
            </dl>
            {isOwner ? (
              <p className="mt-3 text-xs text-zinc-500">
                Log a deposit, withdrawal, or adjustment from{" "}
                <Link href="/account" className="text-emerald-300 hover:text-emerald-200">
                  Account
                </Link>
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
}: {
  positions: SchwabPositions;
  openCampaignTickers: Set<string>;
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
        <Link href="/account" className="text-xs font-medium text-emerald-300 hover:text-emerald-200">
          Manage connection
        </Link>
      </div>
      {positions.length === 0 ? (
        <p className="text-sm text-zinc-400">Schwab reports no open positions right now.</p>
      ) : (
        <div className="space-y-2">
          {positions.map((position) => {
            const isMatch = openCampaignTickers.has(underlyingFromSymbol(position.symbol));
            return (
              <div
                key={`${position.accountId}-${position.symbol}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm"
              >
                <div>
                  <span className="font-medium text-zinc-100">{position.symbol}</span>{" "}
                  <span className="text-zinc-500">· {position.accountLabel}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-zinc-400">{position.quantity} sh · {money(position.marketValue)}</span>
                  <Badge tone={isMatch ? "info" : "neutral"}>{isMatch ? "Possible match" : "Unlinked"}</Badge>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-2 text-xs text-zinc-500">
        Raw broker positions as Schwab reports them. &quot;Possible match&quot; means an open campaign shares the
        same underlying ticker - it is not an automatic link. Reconciling broker fills to specific campaigns is
        future work.
      </p>
    </div>
  );
}

function underlyingFromSymbol(symbol: string) {
  const match = symbol.trim().toUpperCase().match(/^[A-Z]+/);
  return match ? match[0] : symbol.trim().toUpperCase();
}

function PerformanceSection({
  winLoss,
  weekly,
  startingTotal,
  contributionsTotal,
  currentTotal,
}: {
  winLoss: ReturnType<typeof summarizeWinLoss>;
  weekly: ReturnType<typeof summarizeWeeklyReturns>;
  startingTotal: number;
  contributionsTotal: number;
  currentTotal: number | null;
}) {
  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        <p className="text-xs uppercase tracking-normal text-zinc-500">Always your own results - never combined with a buddy&apos;s</p>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
          <ResultItem label="Starting value" value={money(startingTotal)} />
          <ResultItem label="Net contributions" value={money(contributionsTotal)} tone={contributionsTotal} />
          <ResultItem label="Current value" value={currentTotal === null ? "No data" : money(currentTotal)} />
        </dl>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        {weekly.status === "INSUFFICIENT_HISTORY" ? (
          <p className="text-sm text-zinc-400">
            <span className="font-medium text-zinc-200">INSUFFICIENT HISTORY</span> - complete at least one campaign
            with a known account value to start tracking weekly return against the {weekly.targetPercent}% target.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span className="text-zinc-300">
              This week{" "}
              <span className={(weekly.thisWeekPercent ?? 0) >= weekly.targetPercent ? "text-emerald-300" : "text-amber-300"}>
                {percent(weekly.thisWeekPercent ?? 0)}
              </span>{" "}
              of {weekly.targetPercent}% target
            </span>
            <span className="text-zinc-500">
              4-wk avg {weekly.trailing4WeekAveragePercent === null ? "N/A" : percent(weekly.trailing4WeekAveragePercent)}
            </span>
            <span className="text-zinc-500">
              {weekly.weeksAtOrAboveTarget ?? 0} of {weekly.totalWeeksTracked ?? 0} weeks at target
            </span>
          </div>
        )}
        <p className="mt-2 text-xs text-zinc-500">
          Simple realized-return-per-week against current account value, not a time-weighted rate of return. See
          PROJECT_HANDOFF.md for the documented methodology and its limitations.
        </p>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
          <ResultItem label="Completed" value={winLoss.completedCount} />
          <ResultItem label="Wins" value={winLoss.wins} />
          <ResultItem label="Losses" value={winLoss.losses} />
          <ResultItem label="Win rate" value={winLoss.winRate === null ? "N/A" : `${winLoss.winRate}%`} />
          <ResultItem label="Avg win" value={winLoss.averageWin === null ? "N/A" : money(winLoss.averageWin)} tone={winLoss.averageWin} />
          <ResultItem label="Avg loss" value={winLoss.averageLoss === null ? "N/A" : money(winLoss.averageLoss)} tone={winLoss.averageLoss} />
          <ResultItem label="Avg duration" value={winLoss.averageDurationDays === null ? "N/A" : `${winLoss.averageDurationDays} days`} />
          <ResultItem label="Realized trading P/L" value={money(winLoss.realizedTradingPL)} tone={winLoss.realizedTradingPL} />
        </dl>
        {winLoss.unknownResults > 0 ? (
          <p className="mt-2 text-xs text-zinc-500">
            {winLoss.unknownResults} closed campaign{winLoss.unknownResults === 1 ? "" : "s"} without a known final P/L excluded
            from win/loss math.
          </p>
        ) : null}
      </div>
    </section>
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
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  detail: string;
  tone?: number | null;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 shadow-sm shadow-black/20">
      <div className="flex items-center gap-2 text-xs uppercase tracking-normal text-zinc-500">
        <span className="text-zinc-400">{icon}</span>
        {label}
      </div>
      <div className={`mt-2 text-2xl font-semibold ${toneClass(tone)}`}>{value}</div>
      <div className="mt-1 text-xs text-zinc-500">{detail}</div>
    </div>
  );
}

function SummaryCell({ label, value, tone }: { label: string; value: ReactNode; tone?: number | null }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-normal text-zinc-500">{label}</div>
      <div className={`mt-1 text-sm font-semibold ${toneClass(tone)}`}>{value}</div>
    </div>
  );
}

function ResultItem({ label, value, tone }: { label: string; value: ReactNode; tone?: number | null }) {
  return (
    <div className="border-t border-zinc-800 pt-2">
      <dt className="text-xs uppercase tracking-normal text-zinc-500">{label}</dt>
      <dd className={`mt-1 font-medium ${toneClass(tone)}`}>{value}</dd>
    </div>
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

function tabClass(active: boolean) {
  return `rounded px-3 py-1.5 text-sm transition ${
    active ? "bg-emerald-400 text-zinc-950" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
  }`;
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
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-emerald-400 px-4 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-300";
const secondaryButtonClass =
  "inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-md border border-zinc-700 px-4 text-sm font-semibold text-zinc-100 transition hover:border-sky-400/70 hover:text-sky-100";
const tinyButtonClass =
  "inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 text-xs font-medium text-zinc-300 transition hover:border-emerald-400/60 hover:text-emerald-100";
