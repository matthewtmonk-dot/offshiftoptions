import { prismaDiagnostic } from "@/lib/prisma-diagnostic";
import { accountNumbersFromMetadata, findSchwabMarketDataConnectionForUser } from "./tokens";

/** Trusted SSH operator only. No names, labels, emails or brokerage identifiers returned. */
export async function listDiagnosticAccounts() {
  const accounts = await prismaDiagnostic.tradingAccount.findMany({
    where: { source: "SCHWAB", externalAccountId: { not: null } },
    select: {
      id: true,
      userId: true,
      name: true,
      source: true,
      accountType: true,
      externalAccountId: true,
    },
    orderBy: [{ userId: "asc" }, { id: "asc" }],
  });

  const owners = [...new Set(accounts.map((account) => account.userId))];
  const ownerConnections = new Map(await Promise.all(owners.map(async (ownerId) => {
    const connection = await findSchwabMarketDataConnectionForUser(ownerId);
    const mappedExternalAccountIds = new Set(accountNumbersFromMetadata(connection?.metadata).map((value) => value.hashValue));
    return [ownerId, {
      hasOwnerSchwabConnection: Boolean(connection),
      mappedExternalAccountIds,
    }] as const;
  })));

  const provisional = accounts.map((account) => {
    const connection = ownerConnections.get(account.userId);
    const hasOwnerSchwabConnection = Boolean(connection?.hasOwnerSchwabConnection);
    const isMappedToConnectedSchwabAccount = Boolean(
      connection && account.externalAccountId && connection.mappedExternalAccountIds.has(account.externalAccountId),
    );
    return {
      ownerId: account.userId,
      accountId: account.id,
      appAccountName: account.name,
      accountSource: account.source,
      accountType: account.accountType,
      hasOwnerSchwabConnection,
      isMappedToConnectedSchwabAccount,
      diagnosticCaptureEligible: hasOwnerSchwabConnection && isMappedToConnectedSchwabAccount,
    };
  });

  return provisional;
}
