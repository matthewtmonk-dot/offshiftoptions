const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  IRA: "IRA",
  Taxable: "Taxable",
  Paper: "Paper",
  Manual: "Manual",
};

export function firstNameOf(fullName: string | null | undefined): string | null {
  const trimmed = fullName?.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.split(/\s+/)[0];
}

/**
 * Suggests a starting value for the New Account "Name" field, derived from the
 * CURRENT authenticated user only - callers must never pass another user's name.
 */
export function deriveDefaultAccountName(userName: string | null | undefined, accountType: string): string {
  const suffix = ACCOUNT_TYPE_LABELS[accountType] ?? accountType.trim() ?? "Account";
  const first = firstNameOf(userName);
  return first ? `${first} ${suffix}` : `My ${suffix}`;
}
