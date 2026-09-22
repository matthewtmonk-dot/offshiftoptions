import { money, shortDate } from "@/lib/format";
import { friendlyReportingReason, type AccountReportingSummary } from "@/domain/finance/reporting";
import type { FundingCoverageStatus, summarizeAccountPerformance } from "@/domain/finance/accountLedger";

/**
 * Reporting Phase, Ticket 4 - Account page's presentation-only helpers, kept out of page.tsx
 * itself so they can be unit-tested directly (page.tsx may only export a small, framework-
 * recognized set of names - see reporting-display.ts, the same pattern used for Dashboard/Tracker).
 * None of these compute a baseline, funding coverage, or whole-account gain/return - they only
 * choose wording/tone for fields summarizeAccountPerformance/summarizeAccountReporting already
 * decided.
 */

/** Section 13: a short, compact badge for the funding-coverage status - the longer, specific
 * reason belongs in `fundingCoverageMessage` below, not this label. */
export function fundingCoverageBadge(status: FundingCoverageStatus | null): { label: string; tone: "good" | "warn" | "neutral" } {
  if (status === "COMPLETE") {
    return { label: "Funding history complete", tone: "good" };
  }
  if (status === null) {
    return { label: "No baseline set", tone: "neutral" };
  }
  return { label: "Needs review", tone: "warn" };
}

/**
 * Section 7: translates the raw FundingCoverageStatus into the same centralized, user-safe
 * sentences reporting.ts already defines for these exact codes - never a raw enum name, and never
 * a claim of "Verified" Schwab history the domain doesn't actually provide (see accountLedger.ts's
 * BrokerTransactionCoverageStatus doc comment - no caller can honestly supply that proof today, so
 * a Schwab-evidenced account's coverage stays INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY).
 */
export function fundingCoverageMessage(status: FundingCoverageStatus | null): string | null {
  if (status === null || status === "COMPLETE") {
    return null;
  }
  return friendlyReportingReason(status);
}

/** Section 13: one compact status badge summarizing whether this account's whole-account gain is
 * usable evidence right now. */
export function wholeAccountGainStatusBadge(report: AccountReportingSummary): { label: string; tone: "good" | "warn" | "neutral" } {
  if (report.wholeAccountGainStatus === "OK") {
    return { label: "Whole-account gain available", tone: "good" };
  }
  if (report.wholeAccountGainUnavailableReason === "NO_BASELINE") {
    return { label: "Baseline needed", tone: "neutral" };
  }
  return { label: "Ending value unavailable", tone: "warn" };
}

/**
 * Section 3: the baseline explanation shown under the "Baseline" heading - explicit (user-entered)
 * vs. provisional (inferred from broker transfer history) are worded distinctly per the ticket's
 * exact preferred phrasing, and a provisional baseline is never described as verified.
 */
export function baselineExplanation(
  performance: ReturnType<typeof summarizeAccountPerformance>,
): { label: string; detail: string } | null {
  if (performance.ledger.effectiveBaseline) {
    return {
      label: `${money(performance.ledger.effectiveBaseline.value)} as of ${shortDate(performance.ledger.effectiveBaseline.occurredAt)}`,
      detail: "Starting account value for performance measurement (end of that America/New_York date).",
    };
  }
  if (performance.startingCapital !== null) {
    return {
      label: `${money(performance.startingCapital)} (provisional)`,
      detail: "Provisional starting value inferred from broker history - not a confirmed original-funding date.",
    };
  }
  return null;
}

export function ledgerEntryLabel(type: string) {
  switch (type) {
    case "DEPOSIT":
      return "Deposit";
    case "WITHDRAWAL":
      return "Withdrawal";
    case "MANUAL_ADJUSTMENT":
      return "Adjustment";
    case "BROKER_SNAPSHOT":
      return "Broker snapshot";
    case "NOTE":
      return "Note";
    default:
      return type;
  }
}

export function ledgerEntrySourceLabel(source: string) {
  return source === "SCHWAB" ? "Schwab" : "Manual";
}

/** A WITHDRAWAL's stored `amount` is always a positive magnitude (see workflows.ts's
 * parsePositiveNumber) - the domain layer itself applies the sign when computing netContributions
 * (accountLedger.ts: `netContributions -= amount` for WITHDRAWAL). This mirrors that same
 * display-only sign convention for one row; it is not a new formula. */
export function signedLedgerAmount(type: string, amount: number): number {
  return type === "WITHDRAWAL" ? -Math.abs(amount) : amount;
}

/** Strips the internal "Replaces STARTING_VALUE <id> - " prefix `setAccountBaselineForUser`
 * records for a correction, so the primary UI shows the human reason rather than an internal id
 * (Section 5: "Do not expose internal IDs as primary UI"). */
export function parseBaselineNote(notes: string | null) {
  if (!notes) {
    return null;
  }
  return notes.replace(/^Replaces STARTING_VALUE \S+ - /, "");
}
