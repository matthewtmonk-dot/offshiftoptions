import "server-only";

import { SchwabBrokerReadProvider } from "@/providers/schwab/broker-read";
import { SchwabMarketDataProvider } from "@/providers/schwab/market-data";
import {
  accountNumbersFromMetadata,
  findSchwabMarketDataConnection,
  getValidSchwabAccessTokenForConnection,
} from "@/providers/schwab/tokens";
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
};

export async function getSchwabConnectionSummaryForUser(userId: string): Promise<SchwabConnectionSummary | null> {
  const connection = await prisma.brokerConnection.findFirst({
    where: { userId, provider: "SCHWAB" },
    orderBy: { updatedAt: "desc" },
  });

  return connection ? summarizeSchwabConnection(connection) : null;
}

export async function disconnectSchwabForUser(userId: string) {
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

export async function getSchwabMarketDataProvider() {
  const connection = await findSchwabMarketDataConnection();
  if (!connection) {
    return null;
  }

  const accessToken = await getValidSchwabAccessTokenForConnection(connection.id);
  return accessToken ? new SchwabMarketDataProvider({ accessToken }) : null;
}

export async function getSchwabBrokerReadProviderForUser(userId: string) {
  const connection = await prisma.brokerConnection.findFirst({
    where: { userId, provider: "SCHWAB", status: "CONNECTED" },
    orderBy: { updatedAt: "desc" },
  });
  if (!connection) {
    return null;
  }

  const accessToken = await getValidSchwabAccessTokenForConnection(connection.id, { expectedUserId: userId });
  if (!accessToken) {
    return null;
  }

  return new SchwabBrokerReadProvider({
    accessToken,
    accountNumbers: accountNumbersFromMetadata(connection.metadata),
  });
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
  };
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
