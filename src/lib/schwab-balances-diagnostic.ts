import "server-only";

import { prisma } from "./prisma";
import { SchwabApiError, type SchwabFetch } from "@/providers/schwab/client";
import { accountNumbersFromMetadata, getValidSchwabAccessTokenForConnection } from "@/providers/schwab/tokens";
import { fetchSchwabAccountRaw, summarizeAccountBalances, type AccountBalancesSummary } from "@/providers/schwab/balances-diagnostic";

export type SchwabBalancesDiagnosticResult =
  | { status: "OK"; label: string; timestamp: string; balances: AccountBalancesSummary }
  | { status: "UNAVAILABLE"; label: string; message: string; timestamp: string }
  | { status: "ERROR"; label: string; message: string; timestamp: string };

/** Read-only: one GET of the user's own linked account, summarized to numeric balance fields. Nothing is saved. */
export async function runSchwabBalancesDiagnosticForUser(
  userId: string,
  options: { fetchFn?: SchwabFetch; now?: Date } = {},
): Promise<SchwabBalancesDiagnosticResult> {
  const now = options.now ?? new Date();
  const timestamp = now.toISOString();

  const connection = await prisma.brokerConnection.findFirst({
    where: { userId, provider: "SCHWAB", status: "CONNECTED" },
    orderBy: { updatedAt: "desc" },
  });
  if (!connection) {
    return { status: "UNAVAILABLE", label: "No Schwab broker connection", message: "Connect Schwab in Account before running this read-only check.", timestamp };
  }

  const accessToken = await getValidSchwabAccessTokenForConnection(connection.id, { expectedUserId: userId, fetchFn: options.fetchFn });
  if (!accessToken) {
    return { status: "UNAVAILABLE", label: "Schwab token unavailable", message: "Reconnect Schwab from Account before running this read-only check.", timestamp };
  }

  const accountHash = accountNumbersFromMetadata(connection.metadata)[0]?.hashValue ?? null;
  if (!accountHash) {
    return { status: "ERROR", label: "Schwab account unavailable", message: "No Schwab account is linked to this connection yet. Reconnect Schwab to refresh account discovery.", timestamp };
  }

  try {
    const raw = await fetchSchwabAccountRaw({ accessToken, accountHash, fetchFn: options.fetchFn });
    return { status: "OK", label: "User Schwab brokerage authorization", timestamp, balances: summarizeAccountBalances(raw) };
  } catch (error) {
    const message =
      error instanceof SchwabApiError && error.status === 401
        ? "Schwab authorization is expired or unavailable. Reconnect Schwab, then try again."
        : error instanceof SchwabApiError && error.status === 429
          ? "Schwab rate limit reached. Try again after the provider cooldown."
          : "Schwab returned an error. No raw response or credential detail was returned.";
    return { status: "ERROR", label: "Schwab balances unavailable", message, timestamp };
  }
}
