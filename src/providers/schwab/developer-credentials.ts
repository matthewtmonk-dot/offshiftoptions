import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { BrokerConnectionStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { getSchwabConfigStatus, getSchwabOAuthConfig, type SchwabOAuthConfig, SchwabConfigurationError } from "./config";
import { decryptToken, encryptToken } from "./crypto";

export type SchwabCredentialSource = "USER_DEVELOPER_APP" | "SERVER_ENV";

export type ResolvedSchwabOAuthConfig = {
  config: SchwabOAuthConfig;
  source: SchwabCredentialSource;
  developerCredentialId: string | null;
};

export type SchwabDeveloperCredentialSummary = {
  id: string;
  label: string;
  status: string;
  configured: boolean;
  marketDataEnabled: boolean;
  redirectUri: string;
  appKeyLast4: string | null;
  lastValidatedAt: Date | null;
  lastValidationFailureAt: Date | null;
  lastValidationFailureReason: string | null;
  updatedAt: Date;
};

type StoredSchwabDeveloperCredential = {
  id: string;
  userId: string;
  clientIdCiphertext: string;
  clientSecretCiphertext: string;
  redirectUri: string;
  status: string;
  marketDataEnabled: boolean;
};

export async function getUserSchwabDeveloperCredentialSummary(
  userId: string,
): Promise<SchwabDeveloperCredentialSummary | null> {
  const credential = await prisma.schwabDeveloperCredential.findFirst({
    where: { userId, provider: "SCHWAB", status: { not: "REMOVED" } },
    orderBy: { updatedAt: "desc" },
  });

  if (!credential) {
    return null;
  }

  return {
    id: credential.id,
    label: credential.label,
    status: credential.status,
    configured: credential.status !== "REMOVED",
    marketDataEnabled: credential.marketDataEnabled,
    redirectUri: credential.redirectUri,
    appKeyLast4: credential.appKeyLast4,
    lastValidatedAt: credential.lastValidatedAt,
    lastValidationFailureAt: credential.lastValidationFailureAt,
    lastValidationFailureReason: credential.lastValidationFailureReason,
    updatedAt: credential.updatedAt,
  };
}

export async function saveSchwabDeveloperCredentialForUser(
  userId: string,
  clientIdInput: unknown,
  clientSecretInput: unknown,
  redirectUriInput: unknown,
) {
  const clientId = requiredCredentialText(clientIdInput, "Schwab app key / client ID");
  const clientSecret = requiredCredentialText(clientSecretInput, "Schwab client secret");
  const redirectUri = validRedirectUri(redirectUriInput);
  const encryptedClientId = encryptToken(clientId);
  const encryptedClientSecret = encryptToken(clientSecret);
  const appKeyLast4 = clientId.slice(-4);

  const credential = await prisma.schwabDeveloperCredential.upsert({
    where: { userId_provider: { userId, provider: "SCHWAB" } },
    update: {
      label: "Charles Schwab developer app",
      clientIdCiphertext: encryptedClientId,
      clientSecretCiphertext: encryptedClientSecret,
      redirectUri,
      status: "CONFIGURED",
      marketDataEnabled: true,
      appKeyLast4,
      lastValidatedAt: null,
      lastValidationFailureAt: null,
      lastValidationFailureReason: null,
    },
    create: {
      userId,
      provider: "SCHWAB",
      label: "Charles Schwab developer app",
      clientIdCiphertext: encryptedClientId,
      clientSecretCiphertext: encryptedClientSecret,
      redirectUri,
      status: "CONFIGURED",
      marketDataEnabled: true,
      appKeyLast4,
    },
  });

  await expireConnectionsForDeveloperCredential(credential.id, "developer_credentials_replaced");
  return credential;
}

export async function removeSchwabDeveloperCredentialForUser(userId: string) {
  const credential = await prisma.schwabDeveloperCredential.findFirst({
    where: { userId, provider: "SCHWAB", status: { not: "REMOVED" } },
    orderBy: { updatedAt: "desc" },
  });

  if (!credential) {
    return null;
  }

  await expireConnectionsForDeveloperCredential(credential.id, "developer_credentials_removed");
  return prisma.schwabDeveloperCredential.update({
    where: { id: credential.id },
    data: {
      status: "REMOVED",
      marketDataEnabled: false,
      clientIdCiphertext: encryptToken("removed"),
      clientSecretCiphertext: encryptToken("removed"),
      appKeyLast4: null,
      lastValidationFailureAt: new Date(),
      lastValidationFailureReason: "removed_by_user",
    },
  });
}

export async function markSchwabDeveloperCredentialValidated(
  userId: string,
  developerCredentialId: string | null,
) {
  if (!developerCredentialId) {
    return null;
  }

  return prisma.schwabDeveloperCredential.updateMany({
    where: { id: developerCredentialId, userId, provider: "SCHWAB", status: { not: "REMOVED" } },
    data: {
      status: "VALIDATED",
      lastValidatedAt: new Date(),
      lastValidationFailureAt: null,
      lastValidationFailureReason: null,
    },
  });
}

export async function markSchwabDeveloperCredentialInvalid(
  userId: string,
  developerCredentialId: string | null,
  reason: string,
) {
  if (!developerCredentialId) {
    return null;
  }

  return prisma.schwabDeveloperCredential.updateMany({
    where: { id: developerCredentialId, userId, provider: "SCHWAB", status: { not: "REMOVED" } },
    data: {
      status: "INVALID",
      lastValidationFailureAt: new Date(),
      lastValidationFailureReason: reason,
    },
  });
}

export async function resolveSchwabOAuthConfigForUser(
  userId: string,
  options: { developerCredentialId?: string | null; allowServerEnvFallback?: boolean } = {},
): Promise<ResolvedSchwabOAuthConfig> {
  const allowServerEnvFallback = options.allowServerEnvFallback ?? true;
  const userCredential = options.developerCredentialId
    ? await getUsableCredentialById(userId, options.developerCredentialId)
    : await getLatestUsableCredentialForUser(userId);

  if (userCredential) {
    return {
      config: decryptCredentialConfig(userCredential),
      source: "USER_DEVELOPER_APP",
      developerCredentialId: userCredential.id,
    };
  }

  if (options.developerCredentialId) {
    throw new SchwabConfigurationError("Saved Schwab developer credentials are unavailable. Replace them before reconnecting.");
  }

  if (allowServerEnvFallback && getSchwabConfigStatus().configured) {
    return {
      config: getSchwabOAuthConfig(),
      source: "SERVER_ENV",
      developerCredentialId: null,
    };
  }

  throw new SchwabConfigurationError("Schwab OAuth is waiting on developer app credentials.");
}

export async function resolveSchwabOAuthConfigForConnection(connection: {
  userId: string;
  developerCredentialId?: string | null;
}) {
  if (connection.developerCredentialId) {
    return resolveSchwabOAuthConfigForUser(connection.userId, {
      developerCredentialId: connection.developerCredentialId,
      allowServerEnvFallback: false,
    });
  }

  return resolveSchwabOAuthConfigForUser(connection.userId, { allowServerEnvFallback: true });
}

function decryptCredentialConfig(credential: StoredSchwabDeveloperCredential): SchwabOAuthConfig {
  if (credential.status === "REMOVED") {
    throw new SchwabConfigurationError("Saved Schwab developer credentials were removed.");
  }

  return {
    clientId: decryptToken(credential.clientIdCiphertext),
    clientSecret: decryptToken(credential.clientSecretCiphertext),
    redirectUri: credential.redirectUri,
  };
}

async function getLatestUsableCredentialForUser(userId: string) {
  return prisma.schwabDeveloperCredential.findFirst({
    where: { userId, provider: "SCHWAB", status: { not: "REMOVED" } },
    orderBy: { updatedAt: "desc" },
  });
}

async function getUsableCredentialById(userId: string, id: string) {
  return prisma.schwabDeveloperCredential.findFirst({
    where: { id, userId, provider: "SCHWAB", status: { not: "REMOVED" } },
  });
}

async function expireConnectionsForDeveloperCredential(developerCredentialId: string, reason: string) {
  const connections = await prisma.brokerConnection.findMany({
    where: { developerCredentialId, provider: "SCHWAB", status: "CONNECTED" },
    select: { id: true, metadata: true },
  });

  await Promise.all(
    connections.map((connection) =>
      prisma.brokerConnection.update({
        where: { id: connection.id },
        data: {
          status: BrokerConnectionStatus.EXPIRED,
          metadata: metadataWith(connection.metadata, {
            lastRefreshFailureAt: new Date().toISOString(),
            lastRefreshFailureReason: reason,
          }),
        },
      }),
    ),
  );
}

function requiredCredentialText(value: unknown, label: string) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`Enter the ${label}.`);
  }
  if (text.length > 500) {
    throw new Error(`${label} is too long.`);
  }
  return text;
}

function validRedirectUri(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error("Enter the Schwab callback URL.");
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("Enter a valid Schwab callback URL.");
  }

  const isLocalHttp = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new Error("Schwab callback URL must use HTTPS outside local development.");
  }

  return url.toString();
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
