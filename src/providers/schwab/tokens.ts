import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { BrokerConnectionStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { SCHWAB_TOKEN_URL, getSchwabOAuthConfig } from "./config";
import { decryptToken, encryptToken } from "./crypto";
import { normalizeSchwabAccountNumbers, type SchwabAccountNumber } from "./broker-read";
import { SCHWAB_TRADER_BASE_URL } from "./config";
import { schwabGetJson, SchwabApiError, type SchwabFetch } from "./client";
import { resolveSchwabOAuthConfigForConnection, type ResolvedSchwabOAuthConfig } from "./developer-credentials";

type StoredConnection = {
  id: string;
  userId: string;
  accessTokenCiphertext: string | null;
  refreshTokenCiphertext: string | null;
  expiresAt: Date | null;
  scopes: string[];
  metadata: unknown;
  developerCredentialId?: string | null;
};

export type SchwabTokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
};

export async function exchangeSchwabAuthorizationCode(
  code: string,
  fetchFn: SchwabFetch = fetch,
  oauthConfig?: ResolvedSchwabOAuthConfig,
) {
  return requestSchwabToken({ grant_type: "authorization_code", code }, fetchFn, oauthConfig);
}

export async function refreshSchwabConnectionAccessToken(connectionId: string, fetchFn: SchwabFetch = fetch) {
  const connection = await prisma.brokerConnection.findFirst({
    where: { id: connectionId, provider: "SCHWAB" },
  });
  if (!connection?.refreshTokenCiphertext) {
    await markConnectionExpired(connectionId, "missing_refresh_token");
    return null;
  }

  const refreshToken = decryptToken(connection.refreshTokenCiphertext);
  try {
    const oauthConfig = await resolveSchwabOAuthConfigForConnection(connection);
    const tokenResponse = await requestSchwabToken({ grant_type: "refresh_token", refresh_token: refreshToken }, fetchFn, oauthConfig);
    const refreshTokenCiphertext = tokenResponse.refresh_token
      ? encryptToken(tokenResponse.refresh_token)
      : connection.refreshTokenCiphertext;
    const updated = await prisma.brokerConnection.update({
      where: { id: connection.id },
      data: {
        status: "CONNECTED",
        accessTokenCiphertext: encryptToken(tokenResponse.access_token),
        refreshTokenCiphertext,
        expiresAt: tokenExpiresAt(tokenResponse),
        scopes: scopesFromTokenResponse(tokenResponse),
        metadata: metadataWith(connection.metadata, {
          lastSuccessfulRefreshAt: new Date().toISOString(),
          lastRefreshFailureAt: null,
          lastRefreshFailureReason: null,
          refreshTokenLastReceivedAt: tokenResponse.refresh_token ? new Date().toISOString() : undefined,
          tokenType: tokenResponse.token_type ?? "Bearer",
        }),
      },
    });

    return decryptToken(updated.accessTokenCiphertext!);
  } catch (error) {
    await markConnectionExpired(
      connection.id,
      error instanceof SchwabApiError && error.status === 401 ? "refresh_rejected" : "refresh_failed",
    );
    return null;
  }
}

export async function getValidSchwabAccessTokenForConnection(
  connectionId: string,
  options: { expectedUserId?: string; fetchFn?: SchwabFetch } = {},
) {
  const connection = await prisma.brokerConnection.findFirst({
    where: { id: connectionId, provider: "SCHWAB" },
  });
  if (!connection || (options.expectedUserId && connection.userId !== options.expectedUserId)) {
    return null;
  }
  if (!connection.accessTokenCiphertext || !connection.refreshTokenCiphertext || connection.status !== "CONNECTED") {
    return null;
  }

  if (!needsRefresh(connection)) {
    return decryptToken(connection.accessTokenCiphertext);
  }

  return refreshSchwabConnectionAccessToken(connection.id, options.fetchFn);
}

export async function findSchwabMarketDataConnectionForUser(userId: string) {
  return prisma.brokerConnection.findFirst({
    where: {
      userId,
      provider: "SCHWAB",
      status: "CONNECTED",
      accessTokenCiphertext: { not: null },
      refreshTokenCiphertext: { not: null },
    },
    orderBy: { updatedAt: "desc" },
  });
}

export async function saveSchwabTokensForUser(
  userId: string,
  tokenResponse: SchwabTokenResponse,
  fetchFn: SchwabFetch = fetch,
  options: { developerCredentialId?: string | null } = {},
) {
  const accessTokenCiphertext = encryptToken(tokenResponse.access_token);
  const refreshTokenCiphertext = tokenResponse.refresh_token ? encryptToken(tokenResponse.refresh_token) : null;
  const existing = await prisma.brokerConnection.findFirst({
    where: { userId, provider: "SCHWAB" },
    orderBy: { updatedAt: "desc" },
  });
  const accountNumbers = await discoverSchwabAccountNumbers(tokenResponse.access_token, fetchFn);
  const metadata = metadataWith(existing?.metadata, {
    connectedAt: new Date().toISOString(),
    tokenType: tokenResponse.token_type ?? "Bearer",
    refreshTokenLastReceivedAt: tokenResponse.refresh_token ? new Date().toISOString() : undefined,
    accountDiscoveryStatus: accountNumbers ? "OK" : "UNAVAILABLE",
    accountCount: accountNumbers?.length ?? 0,
    accountNumberLast4s: accountNumbers?.map((account) => account.accountNumberLast4).filter(Boolean) ?? [],
    accountHashes: accountNumbers ?? [],
    lastRefreshFailureAt: null,
    lastRefreshFailureReason: null,
  });

  if (existing) {
    return prisma.brokerConnection.update({
      where: { id: existing.id },
      data: {
        label: "Charles Schwab",
        developerCredentialId: options.developerCredentialId ?? existing.developerCredentialId,
        status: "CONNECTED",
        accessTokenCiphertext,
        refreshTokenCiphertext: refreshTokenCiphertext ?? existing.refreshTokenCiphertext,
        expiresAt: tokenExpiresAt(tokenResponse),
        scopes: scopesFromTokenResponse(tokenResponse),
        metadata,
      },
    });
  }

  return prisma.brokerConnection.create({
    data: {
      userId,
      provider: "SCHWAB",
      label: "Charles Schwab",
      developerCredentialId: options.developerCredentialId ?? null,
      status: "CONNECTED",
      accessTokenCiphertext,
      refreshTokenCiphertext,
      expiresAt: tokenExpiresAt(tokenResponse),
      scopes: scopesFromTokenResponse(tokenResponse),
      metadata,
    },
  });
}

export function needsRefresh(connection: Pick<StoredConnection, "expiresAt">, now = new Date()) {
  if (!connection.expiresAt) {
    return true;
  }

  return connection.expiresAt.getTime() - now.getTime() < 60_000;
}

export function tokenExpiresAt(tokenResponse: Pick<SchwabTokenResponse, "expires_in">, now = new Date()) {
  const expiresInSeconds = Number(tokenResponse.expires_in ?? 1800);
  const safeSeconds = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 1800;
  return new Date(now.getTime() + safeSeconds * 1000);
}

async function requestSchwabToken(
  params: Record<string, string>,
  fetchFn: SchwabFetch,
  oauthConfig?: ResolvedSchwabOAuthConfig,
): Promise<SchwabTokenResponse> {
  const config = oauthConfig?.config ?? getSchwabOAuthConfig();
  const body = new URLSearchParams(params);
  if (params.grant_type === "authorization_code") {
    body.set("redirect_uri", config.redirectUri);
  }
  const response = await fetchFn(SCHWAB_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new SchwabApiError("Schwab token request failed.", response.status, response.headers.get("retry-after"));
  }

  const tokenResponse = (await response.json()) as Partial<SchwabTokenResponse>;
  if (typeof tokenResponse.access_token !== "string" || !tokenResponse.access_token) {
    throw new SchwabApiError("Schwab token response was missing an access token.");
  }

  return tokenResponse as SchwabTokenResponse;
}

async function discoverSchwabAccountNumbers(accessToken: string, fetchFn: SchwabFetch) {
  try {
    return normalizeSchwabAccountNumbers(
      await schwabGetJson<unknown>({
        accessToken,
        baseUrl: SCHWAB_TRADER_BASE_URL,
        path: "/accounts/accountNumbers",
        fetchFn,
      }),
    );
  } catch {
    return null;
  }
}

async function markConnectionExpired(connectionId: string, reason: string) {
  const existing = await prisma.brokerConnection.findUnique({
    where: { id: connectionId },
    select: { metadata: true },
  });

  await prisma.brokerConnection.updateMany({
    where: { id: connectionId, provider: "SCHWAB" },
    data: {
      status: BrokerConnectionStatus.EXPIRED,
      metadata: metadataWith(existing?.metadata, {
        lastRefreshFailureAt: new Date().toISOString(),
        lastRefreshFailureReason: reason,
      }),
    },
  });
}

function scopesFromTokenResponse(tokenResponse: Pick<SchwabTokenResponse, "scope">) {
  return typeof tokenResponse.scope === "string" ? tokenResponse.scope.split(/\s+/).filter(Boolean) : [];
}

export function accountNumbersFromMetadata(metadata: unknown): SchwabAccountNumber[] {
  const accountHashes = objectValue(metadata)?.accountHashes;
  if (!Array.isArray(accountHashes)) {
    return [];
  }

  return accountHashes.flatMap((value) => {
    const account = objectValue(value);
    const hashValue = typeof account?.hashValue === "string" ? account.hashValue : null;
    if (!hashValue) {
      return [];
    }

    return {
      hashValue,
      accountNumberLast4: typeof account?.accountNumberLast4 === "string" ? account.accountNumberLast4 : null,
    };
  });
}

function metadataWith(existing: unknown, patch: Record<string, unknown>): Prisma.InputJsonValue {
  return {
    ...(objectValue(existing) ?? {}),
    ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
  } as Prisma.InputJsonValue;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
