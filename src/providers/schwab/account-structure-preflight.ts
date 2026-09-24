import "server-only";
import { prisma } from "@/lib/prisma";
import { assertCanMutateRecord } from "@/lib/privacy";
import { accountNumbersFromMetadata, findSchwabMarketDataConnectionForUser, getValidSchwabAccessTokenForConnection } from "./tokens";
import { captureAccountStructure } from "./account-structure-diagnostic";

/** Trusted SSH operator only. No names, labels, emails or brokerage identifiers returned. */
export async function listDiagnosticAccounts() {
  const accounts = await prisma.tradingAccount.findMany({
    where: { source: "SCHWAB", externalAccountId: { not: null } },
    select: { id: true, userId: true }, orderBy: [{ userId: "asc" }, { id: "asc" }],
  });
  return accounts.map(a => ({ ownerId: a.userId, accountId: a.id }));
}

export async function runSelectedAccountDiagnostic(ownerId?: string, accountId?: string) {
  // Never choose the first owner/account implicitly, including when there is only one.
  if (!ownerId || !accountId) throw new Error("Explicit owner and account selection required.");
  const accounts = await prisma.tradingAccount.findMany({
    where: { id: accountId, userId: ownerId, source: "SCHWAB" },
    select: { userId: true, externalAccountId: true }, take: 2,
  });
  if (accounts.length !== 1 || !accounts[0].externalAccountId) throw new Error("Account unavailable.");
  const account = accounts[0];
  assertCanMutateRecord(ownerId, account.userId);
  const connection = await findSchwabMarketDataConnectionForUser(ownerId);
  if (!connection || !accountNumbersFromMetadata(connection.metadata).some(a => a.hashValue === account.externalAccountId)) throw new Error("Connection unavailable.");
  const token = await getValidSchwabAccessTokenForConnection(connection.id, { expectedUserId: ownerId, allowRefresh: false });
  if (!token) throw new Error("Fresh token unavailable.");
  return captureAccountStructure(token, account.externalAccountId!);
}
