import "server-only";

import type { BrokerReadProvider } from "@/providers/broker-read/types";
import { clearBrokerReadCacheForUser, withBrokerReadCache } from "@/providers/broker-read/cache";
import type { MarketDataProvider } from "@/providers/market-data/types";
import { withMarketDataCache } from "@/providers/market-data/cache";
import { SchwabBrokerReadProvider } from "@/providers/schwab/broker-read";
import { SchwabMarketDataProvider } from "@/providers/schwab/market-data";
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
  };
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
