import "server-only";

import { prisma } from "@/lib/prisma";
import { assertCanMutateRecord } from "@/lib/privacy";

export { listDiagnosticAccounts } from "./account-structure-list";

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

  const { accountNumbersFromMetadata, findSchwabMarketDataConnectionForUser, getValidSchwabAccessTokenForConnection } = await import("./tokens");
  const connection = await findSchwabMarketDataConnectionForUser(ownerId);
  if (!connection || !accountNumbersFromMetadata(connection.metadata).some((a) => a.hashValue === account.externalAccountId)) {
    throw new Error("Connection unavailable.");
  }
  const token = await getValidSchwabAccessTokenForConnection(connection.id, { expectedUserId: ownerId, allowRefresh: false });
  if (!token) throw new Error("Fresh token unavailable.");

  const { captureAccountStructure } = await import("./account-structure-diagnostic");
  return captureAccountStructure(token, account.externalAccountId!);
}
