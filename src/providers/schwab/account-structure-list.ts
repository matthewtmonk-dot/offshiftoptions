import { prismaDiagnostic } from "@/lib/prisma-diagnostic";

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
      brokerConnectionId: true,
      brokerConnection: { select: { userId: true } },
    },
    orderBy: [{ userId: "asc" }, { id: "asc" }],
  });

  return accounts.map((account) => ({
    ownerId: account.userId,
    accountId: account.id,
    appAccountName: account.name,
    accountSource: account.source,
    accountType: account.accountType,
    hasSchwabConnection: Boolean(account.brokerConnectionId),
    connectionOwnerMatchesAccount: Boolean(account.brokerConnection && account.brokerConnection.userId === account.userId),
  }));
}
