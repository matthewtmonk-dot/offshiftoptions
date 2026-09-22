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

/** "Major metric unavailable due to evidence limitations" - deliberately excludes the neutral
 * NO_CLOSED_CAMPAIGNS state (nothing closed this week is not a data problem) so a compact banner
 * built from this never fires just because it's a quiet week. */
export function dashboardHasEvidenceGap(report: AccountReportingSummary): boolean {
  return (
    report.currentAccountValue === null ||
    report.wholeAccountGainStatus === "UNAVAILABLE" ||
    report.tradeReturnStatus === "INCOMPLETE_RESULT_EVIDENCE" ||
    report.tradeReturnStatus === "INCOMPLETE_CAPITAL_EVIDENCE" ||
    report.tradeReturnStatus === "PENDING_FEE_EVIDENCE" ||
    report.capitalUtilizationStatus === "UNKNOWN_EXPOSURE"
  );
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
