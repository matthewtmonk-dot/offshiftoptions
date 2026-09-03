import Link from "next/link";
import { KeyRound, Link2, Plus, RefreshCw, Save, SearchCheck, ShieldCheck, Unplug } from "lucide-react";
import { Badge, FieldLabel, Panel } from "@/components/ui";
import { AppearanceControl } from "@/components/appearance-control";
import { requireCurrentUser } from "@/lib/auth";
import { getAccountPageData } from "@/lib/app-data";
import { getSchwabConnectionSummaryForUser, getSchwabDeveloperCredentialSummaryForUser } from "@/lib/broker-connections";
import { currentAccountValue, summarizeAccountLedger } from "@/domain/finance/accountLedger";
import { summarizeCampaign } from "@/domain/finance/campaigns";
import { money, shortDateTime } from "@/lib/format";
import { getSchwabConfigStatus, SCHWAB_PRODUCTION_CALLBACK_URL } from "@/providers/schwab/config";
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
  const [schwabConnection, schwabDeveloperCredential, schwabConfig, accountData] = await Promise.all([
    getSchwabConnectionSummaryForUser(user.id),
    getSchwabDeveloperCredentialSummaryForUser(user.id),
    Promise.resolve(getSchwabConfigStatus()),
    getAccountPageData(user.id),
  ]);
  const schwabOauthReady = Boolean(schwabDeveloperCredential?.configured) || schwabConfig.configured;

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
            const ledger = summarizeAccountLedger(account.ledgerEntries);
            const realized = realizedPLByAccount.get(account.id) ?? 0;
            const current = currentAccountValue(ledger, realized);
            return (
              <div key={account.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-zinc-50">{account.name}</span>
                    <Badge tone={account.source === "SCHWAB" ? "info" : "neutral"}>{account.source}</Badge>
                    <Badge tone={account.visibility === "PRIVATE" ? "warn" : "good"}>{account.visibility}</Badge>
                  </div>
                  {current.value === null ? (
                    <span className="text-sm text-zinc-500">No value yet</span>
                  ) : (
                    <span className="font-medium text-zinc-100">
                      {money(current.value)}{" "}
                      <span className="text-xs text-zinc-500">({current.source === "SCHWAB" ? "live Schwab" : "manual + trading"})</span>
                    </span>
                  )}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-3 text-sm text-zinc-400 sm:grid-cols-4">
                  <div>Starting: {ledger.startingValue === null ? "UNKNOWN" : money(ledger.startingValue)}</div>
                  <div>Contributions: {money(ledger.netContributions)}</div>
                  <div>Trading P/L: {money(realized)}</div>
                  <div>Cash: {ledger.latestBrokerSnapshot?.cash === null || ledger.latestBrokerSnapshot?.cash === undefined ? "N/A" : money(ledger.latestBrokerSnapshot.cash)}</div>
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
                  <form action={syncSchwabAccountAction}>
                    <button
                      type="submit"
                      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-emerald-400 px-4 text-sm font-semibold text-black transition hover:bg-emerald-300"
                    >
                      <RefreshCw className="size-4" aria-hidden />
                      Sync now
                    </button>
                  </form>
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
                      {schwabConnection?.connected ? "Reconnect Schwab" : "Connect Schwab"}
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
                </div>
              </details>
            </div>
          </div>

          <div className="space-y-3 rounded-md border border-zinc-800 bg-zinc-900/60 p-3">
            {schwabConnection ? (
              <form action={disconnectSchwabAction}>
                <button
                  type="submit"
                  className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-zinc-800 px-4 text-xs font-medium text-zinc-500 transition hover:border-red-400/60 hover:text-red-300"
                >
                  <Unplug className="size-4" aria-hidden />
                  Disconnect Schwab
                </button>
              </form>
            ) : (
              <p className="text-xs text-zinc-500">No connection to disconnect.</p>
            )}
          </div>
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

function linkedAccountLabel(connection: NonNullable<Awaited<ReturnType<typeof getSchwabConnectionSummaryForUser>>>) {
  if (!connection.accountCount) {
    return connection.accountDiscoveryStatus === "UNAVAILABLE" ? "Discovery unavailable" : "None discovered yet";
  }

  const last4s = connection.accountNumberLast4s.map((last4) => `...${last4}`).join(", ");
  return last4s ? `${connection.accountCount} (${last4s})` : String(connection.accountCount);
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
