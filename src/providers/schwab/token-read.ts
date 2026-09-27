import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import type { SchwabFetch } from "./client";
import type { SchwabAccountNumber } from "./broker-read";
import { decryptToken } from "./crypto";
type ReadDb = { brokerConnection: Pick<PrismaClient["brokerConnection"], "findFirst"> };
export async function getValidSchwabAccessTokenForConnection(
  connectionId: string,
  options: { expectedUserId?: string; fetchFn?: SchwabFetch; allowRefresh?: boolean; db?: ReadDb } = {},
) {
  const prisma = options.db ?? (await import("@/lib/prisma")).prisma;
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

  // One-off read-only diagnostics must not refresh tokens or update connection state.
  if (options.allowRefresh === false) return null;
  const { refreshSchwabConnectionAccessToken } = await import("./tokens");
  return refreshSchwabConnectionAccessToken(connection.id, options.fetchFn);
}

export async function findSchwabMarketDataConnectionForUser(userId: string, db?: ReadDb) {
  const prisma = db ?? (await import("@/lib/prisma")).prisma;
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

export function needsRefresh(connection: { expiresAt: Date | null }, now = new Date()) {
  if (!connection.expiresAt) {
    return true;
  }

  return connection.expiresAt.getTime() - now.getTime() < 60_000;
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

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
