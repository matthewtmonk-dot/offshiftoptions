import Link from "next/link";
import { KeyRound, Link2, Plus, RefreshCw, Save, SearchCheck, ShieldCheck, Unplug } from "lucide-react";
import { Badge, FieldLabel, Panel } from "@/components/ui";
import { AppearanceControl } from "@/components/appearance-control";
import { requireCurrentUser } from "@/lib/auth";
import { getAccountPageData } from "@/lib/app-data";
import {
  getSchwabConnectionHealthForUser,
  getSchwabConnectionSummaryForUser,
  getSchwabDeveloperCredentialSummaryForUser,
  schwabPrimaryConnectionAction,
  type SchwabConnectionHealth,
  type SchwabSyncDiagnostics,
} from "@/lib/broker-connections";
import { summarizeAccountPerformance } from "@/domain/finance/accountLedger";
import { summarizeCampaign } from "@/domain/finance/campaigns";
import { money, shortDateTime } from "@/lib/format";
import { getSchwabConfigStatus, SCHWAB_PRODUCTION_CALLBACK_URL } from "@/providers/schwab/config";
import { getAlphaVantageConfigStatus } from "@/providers/alpha-vantage/config";
import { getAlphaVantageUsageToday, ALPHA_VANTAGE_AUTO_DAILY_LIMIT, ALPHA_VANTAGE_TOTAL_DAILY_LIMIT, ALPHA_VANTAGE_MANUAL_RESERVE } from "@/lib/alpha-vantage-budget";
import { getAlphaVantageCacheSummary } from "@/lib/alpha-vantage-fundamentals";
import { InfoTip } from "@/components/info-tip";
import { AlphaVantageQueueButton } from "./alpha-vantage-queue-button";
import {
  addAccountLedgerEntryAction,
  changePasswordAction,
  disconnectSchwabAction,
  removeSchwabDeveloperCredentialsAction,
  saveSchwabDeveloperCredentialsAction,
  syncSchwabAccountAction,
} from "../actions";

export const dynamic = "force-dynamic";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string; schwab?: string }>;
}) {
  const user = await requireCurrentUser();
  const params = await searchParams;
  const [schwabConnection, schwabHealth, schwabDeveloperCredential, schwabConfig, accountData, alphaVantageUsage, alphaVantageCache] =
    await Promise.all([
      getSchwabConnectionSummaryForUser(user.id),
      getSchwabConnectionHealthForUser(user.id),
      getSchwabDeveloperCredentialSummaryForUser(user.id),
      Promise.resolve(getSchwabConfigStatus()),
      getAccountPageData(user.id),
      getAlphaVantageUsageToday(),
      getAlphaVantageCacheSummary(),
    ]);
  const schwabOauthReady = Boolean(schwabDeveloperCredential?.configured) || schwabConfig.configured;
  // Single source of truth for which primary Schwab action to show - derived from the same
  // canonical getSchwabConnectionHealthForUser status that already powers the "Refresh failed -
  // reconnect required" health label, never re-derived independently in this component.
  const schwabPrimaryAction = schwabPrimaryConnectionAction(schwabHealth.oauthStatus);
  const alphaVantageConfig = getAlphaVantageConfigStatus();

  const realizedPLByAccount = new Map<string, number>();
  for (const campaign of accountData.completedCampaigns) {
    const summary = summarizeCampaign({ status: campaign.status, events: campaign.events });
    const pl = summary.totalCampaignPL ?? summary.realizedPL ?? 0;
    realizedPLByAccount.set(campaign.accountId, (realizedPLByAccount.get(campaign.accountId) ?? 0) + pl);
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-emerald-300">{user.name}&apos;s account</p>
        <h1 className="text-3xl font-semibold text-zinc-50">Account</h1>
      </div>

      {params.error ? (
        <div className="rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-100">
          {params.error}
        </div>
      ) : null}
      {params.saved ? (
        <div className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-100">
          Password changed. Your other signed-in sessions were signed out.
        </div>
      ) : null}
      {schwabMessage(params.schwab)}

      <Panel title="Preferences">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-sm font-medium text-zinc-200">Appearance</div>
            <p className="mt-1 text-xs text-zinc-500">
              System follows your device&apos;s light/dark setting automatically. Light and Dark stay fixed until
              you change this again.
            </p>
          </div>
          <AppearanceControl current={user.settings?.appearance ?? "SYSTEM"} />
        </div>
      </Panel>

      <Panel title="Your Accounts">
        <div className="space-y-3">
          {accountData.accounts.map((account) => {
            const realized = realizedPLByAccount.get(account.id) ?? 0;
            const performance = summarizeAccountPerformance({
              ledgerEntries: account.ledgerEntries,
              brokerRecords: account.brokerRecords,
              fallbackTradingPL: realized,
            });
            return (
              <div key={account.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-zinc-50">{account.name}</span>
                    <Badge tone={account.source === "SCHWAB" ? "info" : "neutral"}>{account.source}</Badge>
                    <Badge tone={account.visibility === "PRIVATE" ? "warn" : "good"}>{account.visibility}</Badge>
                  </div>
                  {performance.currentValue === null ? (
                    <span className="text-sm text-zinc-500">No value yet</span>
                  ) : (
                    <span className="font-medium text-zinc-100">
                      {money(performance.currentValue)}{" "}
                      <span className="text-xs text-zinc-500">
                        ({performance.currentValueSource === "SCHWAB" ? "Schwab snapshot" : "manual + trading"})
                      </span>
                    </span>
                  )}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-3 text-sm text-zinc-400 sm:grid-cols-4">
                  <div>Starting: {performance.startingCapital === null ? "UNKNOWN" : money(performance.startingCapital)}</div>
                  <div>Contributions: {performance.netContributions === null ? "UNKNOWN" : signedMoney(performance.netContributions)}</div>
                  <div>Trading P/L: {performance.tradingPL === null ? "UNKNOWN" : signedMoney(performance.tradingPL)}</div>
                  <div>Other income/expense: {performance.otherIncome === null ? "UNKNOWN" : signedMoney(performance.otherIncome)}</div>
                  <div>Total gain: {performance.totalGain === null ? "UNKNOWN" : signedMoney(performance.totalGain)}</div>
                  <div>Total return: {performance.totalReturnPercent === null ? "N/A" : `${performance.totalReturnPercent.toFixed(2)}%`}</div>
                  <div>Cash: {performance.ledger.latestBrokerSnapshot?.cash === null || performance.ledger.latestBrokerSnapshot?.cash === undefined ? "N/A" : money(performance.ledger.latestBrokerSnapshot.cash)}</div>
                  <div>Source: {accountSourceLabel(performance.currentValueSource)}</div>
                </div>

                {account.source === "MANUAL" ? (
                  <form action={addAccountLedgerEntryAction} className="mt-3 grid gap-2 border-t border-zinc-800 pt-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
                    <input type="hidden" name="accountId" value={account.id} />
                    <input type="hidden" name="returnTo" value="/positions" />
                    <select name="type" className="min-h-10 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100">
                      <option value="DEPOSIT">Deposit</option>
                      <option value="WITHDRAWAL">Withdrawal</option>
                      <option value="MANUAL_ADJUSTMENT">Adjustment</option>
                    </select>
                    <input name="occurredAt" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} className="min-h-10 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100" />
                    <input name="amount" type="number" step="0.01" required placeholder="Amount" className="min-h-10 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100" />
                    <button type="submit" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-zinc-700 px-3 text-sm text-zinc-300 hover:border-emerald-400/60">
                      <Plus className="size-4" aria-hidden />
                      Log
                    </button>
                  </form>
                ) : null}
              </div>
            );
          })}
          {accountData.accounts.length === 0 ? (
            <p className="text-sm text-zinc-400">No accounts yet. Add one from the Tracker.</p>
          ) : null}
        </div>
      </Panel>

      <Panel title="Brokerage Connections">
        <div className="grid gap-4 lg:grid-cols-[1fr_0.85fr]">
          <div className="flex items-start gap-3">
            <div className="grid size-11 shrink-0 place-items-center rounded-md border border-sky-400/30 bg-sky-400/10">
              <ShieldCheck className="size-5 text-sky-200" aria-hidden />
            </div>
            <div className="min-w-0 space-y-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold text-zinc-50">Charles Schwab</h2>
                  <Badge tone={schwabConnection?.connected ? "good" : schwabConnection?.status === "EXPIRED" ? "warn" : "neutral"}>
                    {schwabConnection?.connected
                      ? "CONNECTED"
                      : schwabConnection?.status === "EXPIRED"
                        ? "RECONNECT REQUIRED"
                        : "NOT CONNECTED"}
                  </Badge>
                </div>
                <p className="mt-1 max-w-xl text-sm text-zinc-400">
                  Read-only OAuth for live market data and personal account sync. Off Shift Options does not place,
                  preview, replace, or cancel orders.
                </p>
              </div>

              {schwabConnection?.connected ? (
                <div className="space-y-3">
                  <p className="text-sm text-zinc-300">
                    Connected · {linkedAccountLabel(schwabConnection)} ·{" "}
                    {schwabConnection.lastAccountSyncAt
                      ? `last synced ${shortDateTime(schwabConnection.lastAccountSyncAt)}`
                      : "not yet synced"}
                  </p>
                  {schwabConnection.lastAccountSyncFailureAt ? (
                    <p className="text-xs text-amber-200">
                      Last sync attempt failed ({schwabConnection.lastAccountSyncFailureReason ?? "unknown reason"}) at{" "}
                      {shortDateTime(schwabConnection.lastAccountSyncFailureAt)}.
                    </p>
                  ) : null}
                  <p className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
                    Do not click Sync again until Diagnostic D (Transfer Item Shapes, on the Schwab Transaction &amp;
                    Order Diagnostic page) has been reviewed and the repair step for the 8 existing malformed,
                    unlinked transaction records has been approved. Syncing again will not fix them and may add more
                    unresolved rows in the meantime.
                  </p>
                  <form action={syncSchwabAccountAction}>
                    <button
                      type="submit"
                      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-emerald-400 px-4 text-sm font-semibold text-black transition hover:bg-emerald-300"
                    >
                      <RefreshCw className="size-4" aria-hidden />
                      Sync now
                    </button>
                  </form>
                  {schwabConnection.lastSyncDiagnostics ? <SyncDiagnosticsDetails diagnostics={schwabConnection.lastSyncDiagnostics} /> : null}
                </div>
              ) : (
                <p className="text-sm text-zinc-400">
                  Connect Schwab for your own read-only market data and account sync. Buddy accounts stay separate, and
                  manual tracking keeps working without a brokerage connection.
                </p>
              )}

              {!schwabOauthReady ? (
                <div className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
                  Schwab needs a developer app before OAuth can start.
                </div>
              ) : null}

              <details className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3 text-sm text-zinc-400">
                <summary className="cursor-pointer font-medium text-zinc-300">Configure developer app</summary>
                <div className="mt-3 space-y-3 border-t border-zinc-800 pt-3">
                  {schwabDeveloperCredential?.configured ? (
                    <div className="flex flex-wrap items-center gap-3 rounded-md border border-emerald-400/20 bg-emerald-400/10 px-3 py-2">
                      <Badge tone={schwabDeveloperCredential.status === "VALIDATED" ? "good" : "info"}>
                        Developer app configured
                      </Badge>
                      <span>
                        Last validated:{" "}
                        {schwabDeveloperCredential.lastValidatedAt
                          ? shortDateTime(schwabDeveloperCredential.lastValidatedAt)
                          : "not yet"}
                      </span>
                    </div>
                  ) : null}
                  <form action={saveSchwabDeveloperCredentialsAction} className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2">
                      <FieldLabel>App key / Client ID</FieldLabel>
                      <input
                        name="clientId"
                        type="password"
                        autoComplete="off"
                        required
                        placeholder={schwabDeveloperCredential?.configured ? "New app key" : "App key"}
                        className="min-h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-50 outline-none focus:border-emerald-400"
                      />
                    </div>
                    <div className="space-y-2">
                      <FieldLabel>Client secret</FieldLabel>
                      <input
                        name="clientSecret"
                        type="password"
                        autoComplete="off"
                        required
                        placeholder={schwabDeveloperCredential?.configured ? "New secret" : "Client secret"}
                        className="min-h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-50 outline-none focus:border-emerald-400"
                      />
                    </div>
                    <div className="space-y-2 sm:col-span-2">
                      <FieldLabel>Callback URL</FieldLabel>
                      <input
                        name="redirectUri"
                        type="url"
                        required
                        defaultValue={SCHWAB_PRODUCTION_CALLBACK_URL}
                        className="min-h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-50 outline-none focus:border-emerald-400"
                      />
                    </div>
                    <div className="flex flex-wrap gap-2 sm:col-span-2">
                      <button
                        type="submit"
                        className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-emerald-400/50 px-3 text-sm font-medium text-emerald-100 transition hover:border-emerald-300"
                      >
                        <Save className="size-4" aria-hidden />
                        {schwabDeveloperCredential?.configured ? "Replace credentials" : "Save developer app"}
                      </button>
                    </div>
                  </form>
                  {schwabDeveloperCredential?.configured ? (
                    <form action={removeSchwabDeveloperCredentialsAction}>
                      <button
                        type="submit"
                        className="inline-flex min-h-9 items-center justify-center rounded-md border border-zinc-700 px-3 text-xs font-medium text-zinc-400 transition hover:border-red-400/60 hover:text-red-200"
                      >
                        Remove credentials
                      </button>
                    </form>
                  ) : null}
                </div>
              </details>

              <details className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3 text-sm text-zinc-400">
                <summary className="cursor-pointer font-medium text-zinc-300">Connection details</summary>
                {schwabConnection ? (
                  <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                    <ConnectionDatum label="Last token update" value={shortDateTime(schwabConnection.updatedAt)} />
                    <ConnectionDatum
                      label="Access token"
                      value={schwabConnection.expiresAt ? `Expires ${shortDateTime(schwabConnection.expiresAt)}` : "Not active"}
                    />
                    <ConnectionDatum label="Linked accounts" value={linkedAccountLabel(schwabConnection)} />
                    <ConnectionDatum
                      label="Token last refreshed"
                      value={schwabConnection.lastSuccessfulRefreshAt ? shortDateTime(schwabConnection.lastSuccessfulRefreshAt) : "Not yet"}
                    />
                  </dl>
                ) : null}
                <div className="mt-3 flex items-start gap-2 text-sm text-zinc-400">
                  <Link2 className="mt-0.5 size-4 shrink-0 text-emerald-300" aria-hidden />
                  <div>
                    <div className="font-medium text-zinc-200">Callback URL</div>
                    <div className="break-all text-xs">{SCHWAB_PRODUCTION_CALLBACK_URL}</div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  {schwabOauthReady ? (
                    <Link
                      href="/api/schwab/connect"
                      prefetch={false}
                      className="text-xs font-medium text-zinc-400 underline decoration-zinc-600 underline-offset-4 hover:text-zinc-200"
                    >
                      {schwabConnection ? "Reconnect Schwab" : "Connect Schwab"}
                    </Link>
                  ) : (
                    <span className="text-xs text-zinc-500">Connect after developer app setup</span>
                  )}
                  {schwabConnection?.connected ? (
                    <Link
                      href="/account/schwab-fundamentals"
                      prefetch={false}
                      className="inline-flex items-center gap-1 text-xs font-medium text-sky-300 underline decoration-sky-700 underline-offset-4 hover:text-sky-200"
                    >
                      <SearchCheck className="size-3" aria-hidden />
                      Verify Schwab Fundamental Fields
                    </Link>
                  ) : null}
                  {schwabConnection?.connected ? (
                    <Link
                      href="/account/schwab-transactions-diagnostic"
                      prefetch={false}
                      className="inline-flex items-center gap-1 text-xs font-medium text-sky-300 underline decoration-sky-700 underline-offset-4 hover:text-sky-200"
                    >
                      <SearchCheck className="size-3" aria-hidden />
                      Diagnose Schwab Transactions &amp; Orders
                    </Link>
                  ) : null}
                  {schwabConnection?.connected ? (
                    <Link
                      href="/account/schwab-quote-batch-diagnostic"
                      prefetch={false}
                      className="inline-flex items-center gap-1 text-xs font-medium text-sky-300 underline decoration-sky-700 underline-offset-4 hover:text-sky-200"
                    >
                      <SearchCheck className="size-3" aria-hidden />
                      Scanner Engineering Diagnostics
                    </Link>
                  ) : null}
                </div>
              </details>

              <ConnectionHealthDetails health={schwabHealth} />
            </div>
          </div>

          <div className="space-y-3 rounded-md border border-zinc-800 bg-zinc-900/60 p-3">
            {schwabPrimaryAction === "RECONNECT" ? (
              <>
                {schwabOauthReady ? (
                  <Link
                    href="/api/schwab/connect"
                    prefetch={false}
                    className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-amber-400/60 bg-amber-400/10 px-4 text-xs font-semibold text-amber-200 transition hover:bg-amber-400/20"
                  >
                    <RefreshCw className="size-4" aria-hidden />
                    Reconnect Schwab
                  </Link>
                ) : (
                  <p className="text-xs text-amber-200">Reconnect after developer app setup.</p>
                )}
                <form action={disconnectSchwabAction}>
                  <button
                    type="submit"
                    className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-zinc-800 px-4 text-xs font-medium text-zinc-500 transition hover:border-red-400/60 hover:text-red-300"
                  >
                    <Unplug className="size-4" aria-hidden />
                    Disconnect Schwab
                  </button>
                </form>
              </>
            ) : schwabPrimaryAction === "DISCONNECT" ? (
              <form action={disconnectSchwabAction}>
                <button
                  type="submit"
                  className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-zinc-800 px-4 text-xs font-medium text-zinc-500 transition hover:border-red-400/60 hover:text-red-300"
                >
                  <Unplug className="size-4" aria-hidden />
                  Disconnect Schwab
                </button>
              </form>
            ) : schwabOauthReady ? (
              <Link
                href="/api/schwab/connect"
                prefetch={false}
                className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-emerald-400/60 bg-emerald-400/10 px-4 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-400/20"
              >
                <Link2 className="size-4" aria-hidden />
                Connect Schwab
              </Link>
            ) : (
              <p className="text-xs text-zinc-500">Connect after developer app setup.</p>
            )}
          </div>
        </div>
      </Panel>

      <Panel title="Fundamentals Data Providers">
        <div className="space-y-3 rounded-md border border-zinc-800 bg-zinc-900/60 p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-1.5 font-medium text-zinc-200">
                Alpha Vantage (company fundamentals)
                <InfoTip label="How Alpha Vantage usage is tracked">
                  OSO tracks requests it makes. Alpha Vantage does not expose an authoritative remaining-call count or reset signal, so
                  this may differ from the provider&apos;s actual quota.
                </InfoTip>
              </div>
              <p className="mt-1 max-w-xl text-xs text-zinc-500">
                Shared server key, {ALPHA_VANTAGE_TOTAL_DAILY_LIMIT} requests/day - Sector, Industry, PEG, profitability, and analyst
                data feed Research once cached; Schwab-provided fields are never replaced.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Badge tone={alphaVantageConfig.configured ? "good" : "warn"}>{alphaVantageConfig.configured ? "Configured" : "Not configured"}</Badge>
              {alphaVantageConfig.configured ? (
                <Link
                  href="/account/alpha-vantage-fundamentals"
                  prefetch={false}
                  className="inline-flex items-center gap-1 text-xs font-medium text-sky-300 underline decoration-sky-700 underline-offset-4 hover:text-sky-200"
                >
                  <SearchCheck className="size-3" aria-hidden />
                  Verify Fields
                </Link>
              ) : null}
            </div>
          </div>

          {alphaVantageConfig.configured ? (
            <div className="border-t border-zinc-800 pt-3">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <AlphaVantageStat label="OSO tracked" value={`${alphaVantageUsage.totalCount} / ${ALPHA_VANTAGE_TOTAL_DAILY_LIMIT} calls`} />
                <AlphaVantageStat
                  label="Auto budget left (OSO tracked)"
                  value={`${alphaVantageUsage.autoRemaining} / ${ALPHA_VANTAGE_AUTO_DAILY_LIMIT}`}
                />
                <AlphaVantageStat label="Manual reserve" value={String(ALPHA_VANTAGE_MANUAL_RESERVE)} />
                <AlphaVantageStat label="Cached tickers" value={String(alphaVantageCache.cachedTickers)} />
                <AlphaVantageStat label="Stale/missing queued" value={String(alphaVantageCache.staleOrMissingQueued)} />
                <div className="flex items-end">
                  <AlphaVantageQueueButton />
                </div>
              </div>
              <p className="mt-2 text-[11px] text-zinc-500">Resets with OSO&apos;s UTC usage day.</p>
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel title="Change Password">
        <form action={changePasswordAction} className="max-w-sm space-y-4">
          <div className="space-y-2">
            <FieldLabel>Current password</FieldLabel>
            <input
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              className="min-h-11 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-50 outline-none focus:border-emerald-400"
            />
          </div>
          <div className="space-y-2">
            <FieldLabel>New password</FieldLabel>
            <input
              name="newPassword"
              type="password"
              autoComplete="new-password"
              minLength={10}
              required
              className="min-h-11 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-50 outline-none focus:border-emerald-400"
            />
            <p className="text-xs text-zinc-500">At least 10 characters, with both letters and numbers.</p>
          </div>
          <div className="space-y-2">
            <FieldLabel>Confirm new password</FieldLabel>
            <input
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              minLength={10}
              required
              className="min-h-11 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-50 outline-none focus:border-emerald-400"
            />
          </div>
          <button
            type="submit"
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-emerald-400 px-4 text-sm font-semibold text-black hover:bg-emerald-300"
          >
            <Save className="size-4" aria-hidden />
            Update Password
          </button>
        </form>
      </Panel>

      <Panel title="Session">
        <div className="flex items-start gap-3">
          <KeyRound className="mt-0.5 size-5 text-emerald-300" aria-hidden />
          <div className="space-y-2 text-sm text-zinc-400">
            <p>
              Signed in as <span className="font-medium text-zinc-200">{user.email}</span>.
            </p>
            <p>Changing your password signs out any other browsers or devices currently signed in as you.</p>
            <Badge tone="neutral">This account is private to Off Shift Options — no public signup exists.</Badge>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function ConnectionDatum({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-normal text-zinc-500">{label}</dt>
      <dd className="mt-1 break-words font-medium text-zinc-100">{value}</dd>
    </div>
  );
}

/**
 * Aggregate counts only from the last sync + auto-reconciliation run - no account numbers,
 * balances, positions, or transaction content - safe to show directly on this page so the
 * first real production sync can be verified without a database console. Collapsed by default
 * to keep the primary "Sync now" action uncluttered.
 */
function SyncDiagnosticsDetails({ diagnostics }: { diagnostics: SchwabSyncDiagnostics }) {
  const rows: { label: string; value: number; status?: "OK" | "ERROR" }[] = [
    { label: "Accounts synced", value: diagnostics.accountsSynced },
    { label: "Positions received", value: diagnostics.positionsReceived, status: diagnostics.positionsSourceStatus },
    { label: "Transactions received", value: diagnostics.transactionsReceived },
    { label: "TRADE received", value: diagnostics.tradeTransactionsReceived, status: diagnostics.tradeSourceStatus },
    { label: "Receive & deliver received", value: diagnostics.receiveAndDeliverReceived, status: diagnostics.receiveAndDeliverSourceStatus },
    { label: "Dividend/interest received", value: diagnostics.dividendOrInterestReceived, status: diagnostics.dividendOrInterestSourceStatus },
    { label: "Broker records inserted", value: diagnostics.brokerRecordsInserted, status: diagnostics.persistenceStatus },
    { label: "Duplicates skipped", value: diagnostics.duplicatesSkipped },
    { label: "Records needing manual review", value: diagnostics.recordsUnresolved },
    { label: "Fees known", value: diagnostics.feeKnownCount },
    { label: "Fees unknown", value: diagnostics.feeUnknownCount },
    { label: "Campaigns created", value: diagnostics.campaignsCreated, status: diagnostics.reconciliationStatus },
    { label: "Campaigns closed", value: diagnostics.campaignsClosed },
    { label: "Campaigns rolled", value: diagnostics.campaignsRolled },
    { label: "Campaigns assigned", value: diagnostics.campaignsAssigned },
    { label: "Campaigns expired", value: diagnostics.campaignsExpired },
  ];

  return (
    <details className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3 text-sm">
      <summary className="cursor-pointer text-xs font-medium uppercase tracking-normal text-zinc-400">Last sync details</summary>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        {rows.map((row) => (
          <div key={row.label}>
            <dt className="text-[11px] uppercase tracking-normal text-zinc-500">{row.label}</dt>
            <dd className="mt-0.5 font-medium text-zinc-100">
              {row.value}
              {row.status === "ERROR" ? <span className="ml-1.5 text-xs font-semibold text-red-300">ERROR</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      {diagnostics.feeUnknownCount > 0 ? (
        <p className="mt-3 text-xs text-amber-200">
          {diagnostics.feeUnknownCount} imported transaction{diagnostics.feeUnknownCount === 1 ? "" : "s"} had no resolvable fee - affected
          campaigns show &quot;Pending&quot; for Net P/L rather than assuming a $0 fee.
        </p>
      ) : null}
    </details>
  );
}

const CREDENTIAL_SOURCE_LABEL: Record<SchwabConnectionHealth["credentialSource"], string> = {
  USER_CONFIGURED: "Your own developer app",
  SERVER_ENV: "Shared server app",
  NONE: "Not configured",
};

const OAUTH_STATUS_LABEL: Record<SchwabConnectionHealth["oauthStatus"], string> = {
  CONNECTED: "Connected",
  NOT_CONNECTED: "Not connected",
  TOKEN_EXPIRED: "Token expired (refreshes automatically on next use)",
  REFRESH_FAILED: "Refresh failed - reconnect required",
};

const OAUTH_STATUS_TONE: Record<SchwabConnectionHealth["oauthStatus"], "good" | "warn" | "bad" | "neutral"> = {
  CONNECTED: "good",
  NOT_CONNECTED: "neutral",
  TOKEN_EXPIRED: "warn",
  REFRESH_FAILED: "bad",
};

/**
 * Answers, for the authenticated user only: which credential source am I using, did OAuth
 * succeed, did Schwab return an account, and if data stopped, at which stage - with a real
 * failure always distinguishable from an honest zero. Composed entirely from
 * getSchwabConnectionHealthForUser (see broker-connections.ts), itself read from data already
 * persisted for other purposes - never a new diagnostic subsystem. Collapsed by default.
 */
function ConnectionHealthDetails({ health }: { health: SchwabConnectionHealth }) {
  const accountDiscoveryValue =
    health.accountDiscovery.status === "NOT_ATTEMPTED"
      ? "Not yet attempted"
      : health.accountDiscovery.status === "ERROR"
        ? "Failed"
        : `Succeeded - ${health.accountDiscovery.accountsLinked} account${health.accountDiscovery.accountsLinked === 1 ? "" : "s"}`;

  return (
    <details className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3 text-sm text-zinc-400">
      <summary className="cursor-pointer font-medium text-zinc-300">Schwab connection health</summary>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        <ConnectionDatum label="Developer credential source" value={CREDENTIAL_SOURCE_LABEL[health.credentialSource]} />
        <div>
          <dt className="text-xs uppercase tracking-normal text-zinc-500">OAuth status</dt>
          <dd className="mt-1">
            <Badge tone={OAUTH_STATUS_TONE[health.oauthStatus]}>{OAUTH_STATUS_LABEL[health.oauthStatus]}</Badge>
          </dd>
        </div>
        <ConnectionDatum label="Account discovery" value={accountDiscoveryValue} />
        <ConnectionDatum
          label="Last successful token refresh"
          value={health.lastSuccessfulRefreshAt ? shortDateTime(health.lastSuccessfulRefreshAt) : "Not yet"}
        />
        {health.lastRefreshFailureAt ? (
          <ConnectionDatum
            label="Last refresh failure"
            value={`${health.lastRefreshFailureReason ?? "unknown reason"} at ${shortDateTime(health.lastRefreshFailureAt)}`}
          />
        ) : null}
        <ConnectionDatum label="Last sync" value={health.lastSyncAt ? shortDateTime(health.lastSyncAt) : "Not yet"} />
        {health.lastSyncFailureAt ? (
          <ConnectionDatum
            label="Last sync failure"
            value={`${health.lastSyncFailureReason ?? "unknown reason"} at ${shortDateTime(health.lastSyncFailureAt)}`}
          />
        ) : null}
      </dl>
      {health.sync ? (
        <div className="mt-4 border-t border-zinc-800 pt-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-normal text-zinc-500">Most recent sync, by stage</p>
          <SyncStageList sync={health.sync} />
        </div>
      ) : null}
    </details>
  );
}

function SyncStageList({ sync }: { sync: SchwabSyncDiagnostics }) {
  const stages: { label: string; status: "OK" | "ERROR"; detail: string; errorCode: string | null }[] = [
    { label: "Positions", status: sync.positionsSourceStatus, detail: `${sync.positionsReceived} received`, errorCode: sync.positionsErrorCode },
    {
      label: "Transactions - TRADE",
      status: sync.tradeSourceStatus,
      detail: `${sync.tradeTransactionsReceived} received`,
      errorCode: sync.transactionsErrorCode,
    },
    {
      label: "Transactions - RECEIVE_AND_DELIVER",
      status: sync.receiveAndDeliverSourceStatus,
      detail: `${sync.receiveAndDeliverReceived} received`,
      errorCode: sync.transactionsErrorCode,
    },
    {
      label: "Transactions - DIVIDEND_OR_INTEREST",
      status: sync.dividendOrInterestSourceStatus,
      detail: `${sync.dividendOrInterestReceived} received`,
      errorCode: sync.transactionsErrorCode,
    },
    {
      label: "Record persistence",
      status: sync.persistenceStatus,
      detail: `${sync.brokerRecordsInserted} inserted, ${sync.recordsUnresolved} need review`,
      errorCode: sync.persistenceErrorCode,
    },
    {
      label: "Campaign reconciliation",
      status: sync.reconciliationStatus,
      detail: `${sync.campaignsCreated} created, ${sync.campaignsClosed} closed, ${sync.campaignsRolled} rolled, ${sync.campaignsAssigned} assigned, ${sync.campaignsExpired} expired`,
      errorCode: sync.reconciliationErrorCode,
    },
  ];

  return (
    <ul className="space-y-1.5 text-xs">
      {stages.map((stage) => (
        <li key={stage.label} className="flex flex-wrap items-center gap-2">
          <Badge tone={stage.status === "ERROR" ? "bad" : "good"}>{stage.status === "ERROR" ? "ERROR" : "OK"}</Badge>
          <span className="font-medium text-zinc-200">{stage.label}:</span>
          <span className="text-zinc-400">{stage.detail}</span>
          {stage.status === "ERROR" && stage.errorCode ? <span className="text-red-300">({stage.errorCode})</span> : null}
        </li>
      ))}
    </ul>
  );
}

function linkedAccountLabel(connection: NonNullable<Awaited<ReturnType<typeof getSchwabConnectionSummaryForUser>>>) {
  if (!connection.accountCount) {
    return connection.accountDiscoveryStatus === "UNAVAILABLE" ? "Discovery unavailable" : "None discovered yet";
  }

  const last4s = connection.accountNumberLast4s.map((last4) => `...${last4}`).join(", ");
  return last4s ? `${connection.accountCount} (${last4s})` : String(connection.accountCount);
}

function signedMoney(value: number) {
  return `${value > 0 ? "+" : ""}${money(value)}`;
}

function accountSourceLabel(source: "SCHWAB" | "MANUAL" | "MIXED" | null) {
  if (source === "SCHWAB") {
    return "Schwab snapshot";
  }
  if (source === "MANUAL") {
    return "Manual ledger";
  }
  if (source === "MIXED") {
    return "Mixed";
  }
  return "N/A";
}

function schwabMessage(status: string | undefined) {
  switch (status) {
    case "connected":
      return (
        <div className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-100">
          Schwab connected. Tokens were stored encrypted on the server.
        </div>
      );
    case "synced":
      return (
        <div className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-100">
          Schwab account data synced.
        </div>
      );
    case "disconnected":
      return (
        <div className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200">
          Schwab disconnected for this user.
        </div>
      );
    case "developer_configured":
      return (
        <div className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-100">
          Schwab developer app saved. Connect or reconnect Schwab when you are ready.
        </div>
      );
    case "developer_removed":
      return (
        <div className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200">
          Schwab developer app removed for this user.
        </div>
      );
    case "missing_config":
      return (
        <div className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
          Schwab is waiting on server environment variables.
        </div>
      );
    case "state_error":
      return (
        <div className="rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-100">
          Schwab connection failed state validation. Please start the connection again from this page.
        </div>
      );
    case "token_error":
      return (
        <div className="rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-100">
          Schwab returned an OAuth token error. No token values were stored in the browser.
        </div>
      );
    case "auth_error":
      return (
        <div className="rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-100">
          Schwab authorization was not completed.
        </div>
      );
    case "missing_code":
      return (
        <div className="rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-100">
          Schwab did not return an authorization code. Please try connecting again.
        </div>
      );
    default:
      return null;
  }
}

function AlphaVantageStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-normal text-zinc-500">{label}</div>
      <div className="font-medium text-zinc-100">{value}</div>
    </div>
  );
}
