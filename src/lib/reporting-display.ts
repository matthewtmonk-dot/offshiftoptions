import { money, percent, shortDate, shortDateTime } from "@/lib/format";
import type { AccountReportingSummary } from "@/domain/finance/reporting";

/**
 * Reporting Phase, Ticket 2 (Dashboard) and Ticket 3 (Tracker) - the shared presentation-only
 * helpers for AccountReportingSummary, used by both Dashboard's "How am I doing?" cards and
 * Tracker's own trade-focused summaries, so the two pages can never independently invent or drift
 * apart on wording for the same underlying reporting-contract field. Originally lived under
 * dashboard/ (kept out of page.tsx itself so it could be unit-tested without touching a Next.js
 * special file's restricted export surface); moved here once Tracker needed the same functions,
 * since a second page depending on a path under another page's directory is an architecture smell.
 * None of these functions compute P/L, return, capital, or gain - they only format already-decided
 * numbers and choose which already-translated message to show.
 */

/**
 * Post-Reporting-Phase polish ticket: the compact page-level banner is for SYSTEMIC evidence
 * problems (multiple cards affected), not a duplicate of a single card's own already-clear reason.
 * In production, the single most common gap by far is Whole-Account Gain alone (every Schwab
 * account's funding coverage is currently INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY - see
 * PROJECT_HANDOFF.md's architecture-gap note) while Account Value/Confirmed P/L/Trade
 * Return/Capital Committed are all fine - Card 5 already explains that case clearly on its own, so
 * a second, generic amber banner above it was pure duplication. Counting distinct gap conditions
 * (rather than "any gap") naturally still shows the banner when currentAccountValue is itself null,
 * since that always makes wholeAccountGainStatus unavailable too (see accountLedger.ts's Gate A) -
 * two cards genuinely affected, not one - so a real systemic gap is never hidden.
 */
function dashboardEvidenceGapCount(report: AccountReportingSummary): number {
  let count = 0;
  if (report.currentAccountValue === null) {
    count += 1;
  }
  if (report.wholeAccountGainStatus === "UNAVAILABLE") {
    count += 1;
  }
  if (
    report.tradeReturnStatus === "INCOMPLETE_RESULT_EVIDENCE" ||
    report.tradeReturnStatus === "INCOMPLETE_CAPITAL_EVIDENCE" ||
    report.tradeReturnStatus === "PENDING_FEE_EVIDENCE"
  ) {
    count += 1;
  }
  if (report.capitalUtilizationStatus === "UNKNOWN_EXPOSURE") {
    count += 1;
  }
  return count;
}

/** "Major metric unavailable due to evidence limitations" - deliberately excludes the neutral
 * NO_CLOSED_CAMPAIGNS state (nothing closed this week is not a data problem) so a compact banner
 * built from this never fires just because it's a quiet week. Requires MULTIPLE distinct gaps (see
 * dashboardEvidenceGapCount) - a single affected card already explains itself, so the banner is
 * reserved for genuinely systemic evidence problems. */
export function dashboardHasEvidenceGap(report: AccountReportingSummary): boolean {
  return dashboardEvidenceGapCount(report) >= 2;
}

export function accountValueDetail(report: AccountReportingSummary): string | null {
  if (report.currentAccountValue === null) {
    return null;
  }
  if (report.currentAccountValueAsOf) {
    return `As of ${shortDateTime(report.currentAccountValueAsOf)}`;
  }
  if (report.currentAccountValueOldestSnapshotAsOf && report.currentAccountValueNewestSnapshotAsOf) {
    return `Account values updated between ${shortDateTime(report.currentAccountValueOldestSnapshotAsOf)} and ${shortDateTime(report.currentAccountValueNewestSnapshotAsOf)}`;
  }
  return null;
}

/**
 * Reporting Phase, Ticket 3 (Section 12): reads the reporting contract's own dedicated
 * currentAccountValueUnavailableMessage field directly - no longer borrows
 * wholeAccountGainUnavailableMessage for this. The fallback string is defensive only (the contract
 * populates this message whenever currentAccountValue is null) and should be unreachable.
 */
export function accountValueUnavailableReason(report: AccountReportingSummary): string | null {
  return report.currentAccountValueUnavailableMessage ?? "No supported account value is available yet.";
}

export function confirmedTradingPLNote(report: AccountReportingSummary): string | null {
  if (report.confirmedTradingPLComplete) {
    return null;
  }
  const parts: string[] = [];
  if (report.confirmedTradingPLPendingCount > 0) {
    parts.push(`${report.confirmedTradingPLPendingCount} pending`);
  }
  if (report.confirmedTradingPLIncompleteCount > 0) {
    parts.push(`${report.confirmedTradingPLIncompleteCount} incomplete`);
  }
  return parts.length > 0 ? `${parts.join(", ")} campaign result(s) not yet counted` : null;
}

export function tradeReturnValue(report: AccountReportingSummary): string {
  if (report.tradeReturnStatus === "OK") {
    return percent(report.tradeReturnPercent, 2);
  }
  if (report.tradeReturnStatus === "NO_CLOSED_CAMPAIGNS") {
    return "No campaigns closed";
  }
  return "Unavailable";
}

export function tradeReturnReason(report: AccountReportingSummary): string | null {
  if (report.tradeReturnStatus === "OK" || report.tradeReturnStatus === "NO_CLOSED_CAMPAIGNS") {
    return null;
  }
  const grossNote =
    report.tradeReturnStatus === "PENDING_FEE_EVIDENCE" && report.tradeReturnGrossPercent !== null
      ? ` (gross ${percent(report.tradeReturnGrossPercent, 2)})`
      : "";
  return `${report.tradeReturnMessage ?? ""}${grossNote}`;
}

export function capitalCommittedValue(report: AccountReportingSummary): string {
  if (report.capitalUtilizationStatus === "OK") {
    return `${percent(report.currentCapitalUtilizationPercent, 0)} of account`;
  }
  if (report.capitalUtilizationStatus === "UNKNOWN_EXPOSURE" && report.currentCapitalCommitted !== null) {
    return `${money(report.currentCapitalCommitted)} committed (partial)`;
  }
  return "Unavailable";
}

export function capitalCommittedDetail(report: AccountReportingSummary): string {
  if (report.capitalUtilizationStatus === "OK" && report.currentCapitalCommitted !== null) {
    return `${money(report.currentCapitalCommitted)} committed - put collateral + assigned shares at cost`;
  }
  return "Put collateral + assigned shares at cost";
}

export function wholeAccountGainDetail(report: AccountReportingSummary): string | null {
  if (report.wholeAccountGainStatus !== "OK") {
    return null;
  }
  const parts: string[] = [];
  if (report.wholeAccountGainPeriodStartStatus === "COMMON" && report.wholeAccountGainPeriodStart) {
    parts.push(`Since ${shortDate(report.wholeAccountGainPeriodStart)}`);
  } else if (
    report.wholeAccountGainPeriodStartStatus === "MIXED" &&
    report.wholeAccountGainOldestPeriodStart &&
    report.wholeAccountGainNewestPeriodStart
  ) {
    parts.push(`Start dates range ${shortDate(report.wholeAccountGainOldestPeriodStart)}-${shortDate(report.wholeAccountGainNewestPeriodStart)}`);
  }
  // Astra's period-honesty model (reporting.ts): a MIXED ending status means contributing accounts
  // were snapshotted at different times - never imply one common "as of" moment for this dollar
  // figure when that's not true.
  if (report.wholeAccountGainPeriodEndStatus === "MIXED") {
    parts.push("account values updated at different times");
  }
  if (report.wholeAccountReturnPercent !== null) {
    parts.push(percent(report.wholeAccountReturnPercent, 2));
  }
  return parts.length > 0 ? parts.join(" - ") : null;
}
