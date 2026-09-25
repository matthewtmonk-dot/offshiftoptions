import "server-only";

import { prisma } from "@/lib/prisma";

/** Trusted SSH operator only. No names, labels, emails or brokerage identifiers returned. */
export async function listDiagnosticAccounts() {
  const accounts = await prisma.tradingAccount.findMany({
    where: { source: "SCHWAB", externalAccountId: { not: null } },
    select: { id: true, userId: true },
    orderBy: [{ userId: "asc" }, { id: "asc" }],
  });

  return accounts.map((account) => ({ ownerId: account.userId, accountId: account.id }));
}
