import "server-only";

import type { BrokerReadProvider } from "@/providers/broker-read/types";
import { clearBrokerReadCacheForUser, withBrokerReadCache } from "@/providers/broker-read/cache";
import type { MarketDataProvider } from "@/providers/market-data/types";
import { withMarketDataCache } from "@/providers/market-data/cache";
import { SchwabBrokerReadProvider } from "@/providers/schwab/broker-read";
import { SchwabMarketDataProvider } from "@/providers/schwab/market-data";
import { SchwabApiError } from "@/providers/schwab/client";
import { getSchwabConfigStatus } from "@/providers/schwab/config";
import {
  accountNumbersFromMetadata,
  findSchwabMarketDataConnectionForUser,
  getValidSchwabAccessTokenForConnection,
} from "@/providers/schwab/tokens";
import { getUserSchwabDeveloperCredentialSummary } from "@/providers/schwab/developer-credentials";
import { prisma } from "./prisma";

export type SchwabConnectionSummary = {
  id: string;
  label: string;
  status: string;
  connected: boolean;
  expiresAt: Date | null;
  updatedAt: Date;
  accountCount: number;
  accountNumberLast4s: string[];
  accountDiscoveryStatus: string | null;
  lastSuccessfulRefreshAt: string | null;
  lastRefreshFailureAt: string | null;
  lastRefreshFailureReason: string | null;
  lastAccountSyncAt: string | null;
  lastAccountSyncFailureAt: string | null;
  lastAccountSyncFailureReason: string | null;
  lastSyncDiagnostics: SchwabSyncDiagnostics | null;
};

/**
 * Aggregate counts ONLY from the most recent sync + auto-reconciliation run - never raw
 * transaction/position payloads, account numbers, tokens, or secrets - so the first real
 * production sync can be inspected safely (see PROJECT_HANDOFF.md "First real sync
 * auditability"). Safe to show directly to the authenticated user; never logged server-side
 * with anything more sensitive attached.
 */
export type SchwabSyncDiagnostics = {
  accountsSynced: number;
  positionsReceived: number;
  positionsSourceStatus: "OK" | "ERROR";
  /** Safe error category (see categorizeSchwabSyncError) for the most recent positions failure -
   * never a raw provider message. Null when the last attempt succeeded. */
  positionsErrorCode: string | null;
  transactionsReceived: number;
  tradeTransactionsReceived: number;
  tradeSourceStatus: "OK" | "ERROR";
  receiveAndDeliverReceived: number;
  receiveAndDeliverSourceStatus: "OK" | "ERROR";
  dividendOrInterestReceived: number;
  dividendOrInterestSourceStatus: "OK" | "ERROR";
  /** Set only when every transaction category failed outright (see fetchSchwabAccountActivity) -
   * a single failed category is already visible via that category's own *SourceStatus above. */
  transactionsErrorCode: string | null;
  brokerRecordsInserted: number;
  duplicatesSkipped: number;
  recordsUnresolved: number;
  feeKnownCount: number;
  feeUnknownCount: number;
  /** Whether normalized records fetched this sync were successfully persisted - distinct from
   * brokerRecordsInserted being 0, which can also mean an honest "nothing new to persist." */
  persistenceStatus: "OK" | "ERROR";
  persistenceErrorCode: string | null;
  campaignsCreated: number;
  campaignsClosed: number;
  campaignsRolled: number;
  campaignsAssigned: number;
  campaignsExpired: number;
  /** Whether campaign reconciliation ran to completion for every synced account - distinct from
   * the campaign counts above legitimately all being 0. */
  reconciliationStatus: "OK" | "ERROR";
  reconciliationErrorCode: string | null;
};

export type ResolvedMarketDataProvider =
  | {
      provider: MarketDataProvider;
      source: "USER_SCHWAB";
      label: string;
      connectionId: string;
      usesUserDeveloperApp: boolean;
    }
  | {
      provider: null;
      source: "UNAVAILABLE";
      label: string;
      reason: "NO_USER_CONNECTION" | "TOKEN_UNAVAILABLE";
      sharedFallback: "DISABLED_POLICY_NOT_VERIFIED";
    };

export type ResolvedPersonalBrokerProvider =
  | {
      provider: BrokerReadProvider;
      source: "USER_SCHWAB";
      label: string;
      connectionId: string;
    }
  | {
      provider: null;
      source: "UNAVAILABLE";
      label: string;
      reason: "NO_USER_CONNECTION" | "TOKEN_UNAVAILABLE";
    };

export async function getSchwabConnectionSummaryForUser(userId: string): Promise<SchwabConnectionSummary | null> {
  const connection = await prisma.brokerConnection.findFirst({
    where: { userId, provider: "SCHWAB" },
    orderBy: { updatedAt: "desc" },
  });

  return connection ? summarizeSchwabConnection(connection) : null;
}

export type SchwabCredentialSourceStatus = "USER_CONFIGURED" | "SERVER_ENV" | "NONE";
export type SchwabOAuthHealthStatus = "CONNECTED" | "NOT_CONNECTED" | "TOKEN_EXPIRED" | "REFRESH_FAILED";
export type SchwabProviderCallStatus = "OK" | "ERROR" | "NOT_ATTEMPTED";

/**
 * A sanitized, current-user-scoped answer to "where did my Schwab connection stop working, and
 * was a zero honest or an error?" - composed entirely from data already persisted for other
 * purposes (BrokerConnection.metadata, SchwabDeveloperCredential, SCHWAB_* env config), never a
 * new storage mechanism, and never a live Schwab call of its own. Safe to render directly:
 * no client id/secret, no access/refresh tokens, no OAuth codes, no account hash, no full
 * account number, no raw Schwab response/error body, no provider record ids.
 */
export type SchwabConnectionHealth = {
  credentialSource: SchwabCredentialSourceStatus;
  oauthStatus: SchwabOAuthHealthStatus;
  lastSuccessfulRefreshAt: string | null;
  lastRefreshFailureAt: string | null;
  lastRefreshFailureReason: string | null;
  accountDiscovery: {
    status: SchwabProviderCallStatus;
    accountsLinked: number;
  };
  sync: SchwabSyncDiagnostics | null;
  lastSyncAt: string | null;
  lastSyncFailureAt: string | null;
  lastSyncFailureReason: string | null;
};

export async function getSchwabConnectionHealthForUser(userId: string): Promise<SchwabConnectionHealth> {
  const connection = await prisma.brokerConnection.findFirst({
    where: { userId, provider: "SCHWAB" },
    orderBy: { updatedAt: "desc" },
  });

  const credentialSource = await resolveCredentialSourceForHealth(userId, connection);

  if (!connection) {
    return {
      credentialSource,
      oauthStatus: "NOT_CONNECTED",
      lastSuccessfulRefreshAt: null,
      lastRefreshFailureAt: null,
      lastRefreshFailureReason: null,
      accountDiscovery: { status: "NOT_ATTEMPTED", accountsLinked: 0 },
      sync: null,
      lastSyncAt: null,
      lastSyncFailureAt: null,
      lastSyncFailureReason: null,
    };
  }

  const metadata = objectValue(connection.metadata);

  return {
    credentialSource,
    oauthStatus: oauthHealthStatus(connection.status, connection.expiresAt),
    lastSuccessfulRefreshAt: stringValue(metadata?.lastSuccessfulRefreshAt),
    lastRefreshFailureAt: stringValue(metadata?.lastRefreshFailureAt),
    lastRefreshFailureReason: stringValue(metadata?.lastRefreshFailureReason),
    accountDiscovery: {
      status:
        metadata?.accountDiscoveryStatus === "OK"
          ? "OK"
          : metadata?.accountDiscoveryStatus === "UNAVAILABLE"
            ? "ERROR"
            : "NOT_ATTEMPTED",
      accountsLinked: numberValue(metadata?.accountCount) ?? 0,
    },
    sync: syncDiagnosticsValue(metadata?.lastSyncDiagnostics),
    lastSyncAt: stringValue(metadata?.lastAccountSyncAt),
    lastSyncFailureAt: stringValue(metadata?.lastAccountSyncFailureAt),
    lastSyncFailureReason: stringValue(metadata?.lastAccountSyncFailureReason),
  };
}

function oauthHealthStatus(status: string, expiresAt: Date | null): SchwabOAuthHealthStatus {
  if (status === "EXPIRED") {
    return "REFRESH_FAILED";
  }
  if (status !== "CONNECTED") {
    return "NOT_CONNECTED";
  }
  if (!expiresAt || expiresAt.getTime() <= Date.now()) {
    return "TOKEN_EXPIRED";
  }
  return "CONNECTED";
}

export type SchwabPrimaryConnectionAction = "CONNECT" | "RECONNECT" | "DISCONNECT";

/**
 * The one primary Schwab action a user should be offered, derived entirely from the canonical
 * oauthStatus health signal above (the same one behind the "Refresh failed - reconnect required"
 * label) - never re-derived independently by a caller/UI. Never connected -> Connect. Anything
 * requiring reauthorization (TOKEN_EXPIRED or REFRESH_FAILED) -> Reconnect, so a broken connection
 * always offers a way to fix itself, not just Disconnect. Healthy -> Disconnect.
 */
export function schwabPrimaryConnectionAction(oauthStatus: SchwabOAuthHealthStatus): SchwabPrimaryConnectionAction {
  if (oauthStatus === "TOKEN_EXPIRED" || oauthStatus === "REFRESH_FAILED") {
    return "RECONNECT";
  }
  if (oauthStatus === "CONNECTED") {
    return "DISCONNECT";
  }
  return "CONNECT";
}

/**
 * Reports what actually happened for an existing connection (its own stored
 * developerCredentialId - ground truth from the last successful token save), or what would be
 * used if this user connected right now when there is no connection yet. Mirrors
 * resolveSchwabOAuthConfigForUser's own resolution order (user credential, else server env, else
 * unavailable) without re-deriving or guessing at it independently.
 */
async function resolveCredentialSourceForHealth(
  userId: string,
  connection: { developerCredentialId: string | null } | null,
): Promise<SchwabCredentialSourceStatus> {
  if (connection) {
    return connection.developerCredentialId ? "USER_CONFIGURED" : "SERVER_ENV";
  }

  const userCredential = await getUserSchwabDeveloperCredentialSummary(userId);
  if (userCredential?.configured) {
    return "USER_CONFIGURED";
  }
  return getSchwabConfigStatus().configured ? "SERVER_ENV" : "NONE";
}

export async function getSchwabDeveloperCredentialSummaryForUser(userId: string) {
  return getUserSchwabDeveloperCredentialSummary(userId);
}

export async function disconnectSchwabForUser(userId: string) {
  clearSchwabBrokerReadCacheForUser(userId);

  const connection = await prisma.brokerConnection.findFirst({
    where: { userId, provider: "SCHWAB" },
    orderBy: { updatedAt: "desc" },
  });

  if (!connection) {
    return null;
  }

  return prisma.brokerConnection.update({
    where: { id: connection.id },
    data: {
      status: "DISCONNECTED",
      accessTokenCiphertext: null,
      refreshTokenCiphertext: null,
      expiresAt: null,
      scopes: [],
      metadata: {
        disconnectedAt: new Date().toISOString(),
      },
    },
  });
}

export async function resolveMarketDataProviderForUser(userId: string): Promise<ResolvedMarketDataProvider> {
  const connection = await findSchwabMarketDataConnectionForUser(userId);
  if (!connection) {
    return {
      provider: null,
      source: "UNAVAILABLE",
      label: "No Schwab market-data connection",
      reason: "NO_USER_CONNECTION",
      sharedFallback: "DISABLED_POLICY_NOT_VERIFIED",
    };
  }

  const accessToken = await getValidSchwabAccessTokenForConnection(connection.id, { expectedUserId: userId });
  if (!accessToken) {
    return {
      provider: null,
      source: "UNAVAILABLE",
      label: "Schwab token unavailable",
      reason: "TOKEN_UNAVAILABLE",
      sharedFallback: "DISABLED_POLICY_NOT_VERIFIED",
    };
  }

  return {
    provider: withMarketDataCache(
      new SchwabMarketDataProvider({ accessToken }),
      `schwab:user:${userId}:connection:${connection.id}`,
    ),
    source: "USER_SCHWAB",
    label: connection.developerCredentialId ? "User Schwab developer app" : "User Schwab OAuth via OSO app",
    connectionId: connection.id,
    usesUserDeveloperApp: Boolean(connection.developerCredentialId),
  };
}

export async function getSchwabMarketDataProviderForUser(userId: string) {
  return (await resolveMarketDataProviderForUser(userId)).provider;
}

export async function getSchwabMarketDataProvider(userId: string) {
  return getSchwabMarketDataProviderForUser(userId);
}

type ResolvePersonalBrokerProviderOptions = {
  bypassCache?: boolean;
};

export async function resolvePersonalBrokerProviderForUser(
  userId: string,
  options: ResolvePersonalBrokerProviderOptions = {},
): Promise<ResolvedPersonalBrokerProvider> {
  const connection = await prisma.brokerConnection.findFirst({
    where: { userId, provider: "SCHWAB", status: "CONNECTED" },
    orderBy: { updatedAt: "desc" },
  });
  if (!connection) {
    return {
      provider: null,
      source: "UNAVAILABLE",
      label: "No Schwab broker connection",
      reason: "NO_USER_CONNECTION",
    };
  }

  const accessToken = await getValidSchwabAccessTokenForConnection(connection.id, { expectedUserId: userId });
  if (!accessToken) {
    return {
      provider: null,
      source: "UNAVAILABLE",
      label: "Schwab token unavailable",
      reason: "TOKEN_UNAVAILABLE",
    };
  }

  const provider = new SchwabBrokerReadProvider({
    accessToken,
    accountNumbers: accountNumbersFromMetadata(connection.metadata),
  });
  const providerKey = schwabBrokerReadCacheKey(userId, connection.id);

  return {
    provider: options.bypassCache ? provider : withBrokerReadCache(provider, providerKey),
    source: "USER_SCHWAB",
    label: "User Schwab brokerage authorization",
    connectionId: connection.id,
  };
}

export async function getSchwabBrokerReadProviderForUser(userId: string, options: ResolvePersonalBrokerProviderOptions = {}) {
  return (await resolvePersonalBrokerProviderForUser(userId, options)).provider;
}

export function clearSchwabBrokerReadCacheForUser(userId: string) {
  clearBrokerReadCacheForUser(userId);
}

function schwabBrokerReadCacheKey(userId: string, connectionId: string) {
  return `schwab:user:${userId}:connection:${connectionId}`;
}

function summarizeSchwabConnection(connection: {
  id: string;
  label: string;
  status: string;
  expiresAt: Date | null;
  updatedAt: Date;
  metadata: unknown;
}) {
  const metadata = objectValue(connection.metadata);
  const accountLast4s = arrayOfStrings(metadata?.accountNumberLast4s);

  return {
    id: connection.id,
    label: connection.label,
    status: connection.status,
    connected: connection.status === "CONNECTED",
    expiresAt: connection.expiresAt,
    updatedAt: connection.updatedAt,
    accountCount: numberValue(metadata?.accountCount) ?? accountLast4s.length,
    accountNumberLast4s: accountLast4s,
    accountDiscoveryStatus: stringValue(metadata?.accountDiscoveryStatus),
    lastSuccessfulRefreshAt: stringValue(metadata?.lastSuccessfulRefreshAt),
    lastRefreshFailureAt: stringValue(metadata?.lastRefreshFailureAt),
    lastRefreshFailureReason: stringValue(metadata?.lastRefreshFailureReason),
    lastAccountSyncAt: stringValue(metadata?.lastAccountSyncAt),
    lastAccountSyncFailureAt: stringValue(metadata?.lastAccountSyncFailureAt),
    lastAccountSyncFailureReason: stringValue(metadata?.lastAccountSyncFailureReason),
    lastSyncDiagnostics: syncDiagnosticsValue(metadata?.lastSyncDiagnostics),
  };
}

function syncDiagnosticsValue(value: unknown): SchwabSyncDiagnostics | null {
  const record = objectValue(value);
  if (!record) {
    return null;
  }

  const numericFields: (keyof SchwabSyncDiagnostics)[] = [
    "accountsSynced",
    "positionsReceived",
    "transactionsReceived",
    "tradeTransactionsReceived",
    "receiveAndDeliverReceived",
    "dividendOrInterestReceived",
    "brokerRecordsInserted",
    "duplicatesSkipped",
    "recordsUnresolved",
    "feeKnownCount",
    "feeUnknownCount",
    "campaignsCreated",
    "campaignsClosed",
    "campaignsRolled",
    "campaignsAssigned",
    "campaignsExpired",
  ];
  const result: Record<string, unknown> = {};
  for (const field of numericFields) {
    result[field] = numberValue(record[field]) ?? 0;
  }

  // Status fields default to "OK" when absent so diagnostics blobs persisted before this fix
  // existed don't retroactively render as errored.
  const statusFields: (keyof SchwabSyncDiagnostics)[] = [
    "positionsSourceStatus",
    "tradeSourceStatus",
    "receiveAndDeliverSourceStatus",
    "dividendOrInterestSourceStatus",
    "persistenceStatus",
    "reconciliationStatus",
  ];
  for (const field of statusFields) {
    result[field] = record[field] === "ERROR" ? "ERROR" : "OK";
  }

  // Safe error-code fields default to null when absent (success, or a blob persisted before
  // this fix existed) - never fabricated, never a raw provider message.
  const errorCodeFields: (keyof SchwabSyncDiagnostics)[] = [
    "positionsErrorCode",
    "transactionsErrorCode",
    "persistenceErrorCode",
    "reconciliationErrorCode",
  ];
  for (const field of errorCodeFields) {
    result[field] = stringValue(record[field]);
  }

  return result as SchwabSyncDiagnostics;
}

/**
 * Sanitized, safe-to-display error category for a Schwab sync-stage failure - never the raw
 * provider error message/body, which could echo request details. Used both to persist a code
 * into SchwabSyncDiagnostics and to log a structured, non-sensitive server-side failure record.
 */
export type SchwabSyncErrorCode =
  | "unauthorized"
  | "rate_limited"
  | "provider_unavailable"
  | "provider_rejected"
  | "network_or_unexpected";

export function categorizeSchwabSyncError(error: unknown): SchwabSyncErrorCode {
  if (error instanceof SchwabApiError) {
    if (error.status === 401) return "unauthorized";
    if (error.status === 429) return "rate_limited";
    if (error.status && error.status >= 500) return "provider_unavailable";
    if (error.status) return "provider_rejected";
  }
  return "network_or_unexpected";
}

/**
 * Structured, non-sensitive server-side log for a swallowed Schwab sync-stage exception - only
 * the stage, a safe error category, a timestamp, and the affected user's id. Never the raw
 * error message, which could carry request/response details that aren't safe to persist in
 * ordinary server logs.
 */
export function logSchwabSyncFailure(stage: string, userId: string, error: unknown) {
  console.error("[schwab-sync-failure]", {
    stage,
    userId,
    errorCode: categorizeSchwabSyncError(error),
    at: new Date().toISOString(),
  });
}

/**
 * Records whether an account-data sync (balances/positions) succeeded or failed, kept
 * distinct from token-refresh metadata (lastSuccessfulRefreshAt) which only reflects the
 * OAuth token lifecycle, not whether we ever actually fetched account data.
 */
export async function recordSchwabAccountSyncResult(
  userId: string,
  result: { succeededAt?: Date; failureReason?: string },
) {
  const connection = await prisma.brokerConnection.findFirst({
    where: { userId, provider: "SCHWAB" },
    orderBy: { updatedAt: "desc" },
  });

  if (!connection) {
    return null;
  }

  const existing = objectValue(connection.metadata) ?? {};
  const patch = result.succeededAt
    ? {
        lastAccountSyncAt: result.succeededAt.toISOString(),
        lastAccountSyncFailureAt: null,
        lastAccountSyncFailureReason: null,
      }
    : {
        lastAccountSyncFailureAt: new Date().toISOString(),
        lastAccountSyncFailureReason: result.failureReason ?? "unknown",
      };

  return prisma.brokerConnection.update({
    where: { id: connection.id },
    data: { metadata: { ...existing, ...patch } },
  });
}

/**
 * Persists the aggregate, non-sensitive counts from the most recent sync + reconciliation run
 * (see SchwabSyncDiagnostics) so the first real production sync can be inspected via /account
 * without exposing raw account/position/transaction data or requiring a database console.
 */
export async function recordSchwabSyncDiagnostics(userId: string, diagnostics: SchwabSyncDiagnostics) {
  const connection = await prisma.brokerConnection.findFirst({
    where: { userId, provider: "SCHWAB" },
    orderBy: { updatedAt: "desc" },
  });

  if (!connection) {
    return null;
  }

  const existing = objectValue(connection.metadata) ?? {};
  return prisma.brokerConnection.update({
    where: { id: connection.id },
    data: { metadata: { ...existing, lastSyncDiagnostics: diagnostics } },
  });
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function arrayOfStrings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
