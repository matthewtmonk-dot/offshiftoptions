import "server-only";

import { SCHWAB_TRADER_BASE_URL } from "./config";
import { schwabGetJson, type SchwabFetch } from "./client";

/**
 * Read-only look at the balance fields Schwab reports for the linked account, so the field that matches
 * thinkorswim's "Available for Trading" can be identified before any recommendation relies on it. Only
 * numeric balances and the account type are returned - never the account number, hash, or positions.
 */
export type BalanceField = { name: string; value: number };

export type AccountBalancesSummary = {
  accountType: string | null;
  current: BalanceField[];
  initial: BalanceField[];
  projected: BalanceField[];
  malformedResponse: boolean;
};

export async function fetchSchwabAccountRaw({
  accessToken,
  accountHash,
  fetchFn,
  baseUrl = SCHWAB_TRADER_BASE_URL,
}: {
  accessToken: string;
  accountHash: string;
  fetchFn?: SchwabFetch;
  baseUrl?: string;
}): Promise<unknown> {
  return schwabGetJson<unknown>({
    accessToken,
    baseUrl,
    path: `/accounts/${encodeURIComponent(accountHash)}`,
    fetchFn,
  });
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function numericFields(value: unknown): BalanceField[] {
  const record = objectValue(value);
  if (!record) return [];
  return Object.entries(record)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
    .map(([name, fieldValue]) => ({ name, value: fieldValue }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function summarizeAccountBalances(payload: unknown): AccountBalancesSummary {
  const account = objectValue(objectValue(payload)?.securitiesAccount);
  if (!account) {
    return { accountType: null, current: [], initial: [], projected: [], malformedResponse: true };
  }
  const type = account.type;
  return {
    accountType: typeof type === "string" && type.trim() ? type.trim() : null,
    current: numericFields(account.currentBalances),
    initial: numericFields(account.initialBalances),
    projected: numericFields(account.projectedBalances),
    malformedResponse: false,
  };
}
