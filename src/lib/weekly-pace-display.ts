import type { AccountReportingSummary } from "@/domain/finance/reporting";
import {
  WEEKLY_PACE_REFERENCE_PERCENT,
  describePeriodDays,
  formatWeeklyPercent,
  weeklyPaceFromGain,
  weeklyPaceFromPercent,
  weeklyPaceTone,
  type WeeklyPace,
  type WeeklyPaceTone,
} from "@/domain/finance/weeklyPace";
import { money, percent } from "@/lib/format";

/**
 * Presentation-ready "average return per week" for the Dashboard's whole-account card and a Tracker
 * campaign. Pure string/tone building around domain/finance/weeklyPace.ts - the numbers come from the
 * authoritative reporting / campaign summaries and are only divided by elapsed time here.
 */
export type WeeklyPaceDisplay = {
  /** e.g. "+0.45% / week" */
  value: string;
  tone: WeeklyPaceTone;
  /** One short line of context, e.g. "$34.02 on $1,450 over 4 days - early read". */
  detail: string;
  /** Plain-English definition for the hover help. */
  help: string;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const REFERENCE = `${WEEKLY_PACE_REFERENCE_PERCENT}%`;

function toDisplay(pace: WeeklyPace, detailCore: string, help: string): WeeklyPaceDisplay {
  return {
    value: formatWeeklyPercent(pace.weeklyPercent),
    tone: weeklyPaceTone(pace.weeklyPercent),
    detail: `${detailCore}${pace.early ? " - early read, too short to be a trend" : ""}`,
    help,
  };
}

/**
 * Whole account: total return since the account baseline, averaged per week. Idle cash counts - the
 * return is measured against the whole starting account value, not just the money in trades. Unavailable
 * whenever the reporting layer withholds the return % (for example deposits or withdrawals during the
 * period) or the accounts' baselines start on different dates.
 */
export function accountWeeklyPaceDisplay(report: AccountReportingSummary): WeeklyPaceDisplay | null {
  if (report.wholeAccountGainStatus !== "OK" || report.wholeAccountReturnPercent === null) return null;
  const start = report.wholeAccountGainPeriodStartStatus === "COMMON" ? report.wholeAccountGainPeriodStart : null;
  const end = report.wholeAccountGainPeriodEnd ?? report.tradeReturnAsOf;
  if (!start || !end || end.getTime() < start.getTime()) return null;
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / MS_PER_DAY));
  const pace = weeklyPaceFromPercent(report.wholeAccountReturnPercent, days, 14);
  if (!pace) return null;
  return toDisplay(
    pace,
    `${percent(pace.totalPercent, 2)} total over ${describePeriodDays(days)}`,
    `Average return per week for the whole account: the gain since your account baseline, divided by the account's starting value, divided by the weeks that have passed. Money sitting in cash counts against you here, so this shows how hard the WHOLE account is working, not just the trades. It is a simple average (not compounded). The usual Low Stress Trading reference is about ${REFERENCE} a week - green at or above it, amber below it, red if the account is down.`,
  );
}

/**
 * One position (campaign). Numerator: option cash collected so far (credits minus buy-backs and fees), or the
 * realized result once it has closed. Denominator: the cash set aside to secure it (peak collateral), averaged
 * over the weeks it has been open. A new campaign starts the math over; assignment and covered calls continue
 * the same campaign.
 */
export function campaignWeeklyPaceDisplay(input: {
  closed: boolean;
  /** Realized P/L when closed and confirmed; otherwise null. */
  realizedPL: number | null;
  netOptionPremium: number | null;
  collateralCommitted: number | null;
  daysActive: number | null;
  hasUnknownCashFlow: boolean;
  assigned: boolean;
}): WeeklyPaceDisplay | null {
  if (input.hasUnknownCashFlow) return null;
  const useRealized = input.closed && input.realizedPL !== null;
  const gain = useRealized ? input.realizedPL : input.netOptionPremium;
  const pace = weeklyPaceFromGain(gain, input.collateralCommitted, input.daysActive, 7);
  if (!pace || gain === null || input.collateralCommitted === null) return null;
  const verb = useRealized ? "Realized" : "Collected so far";
  return toDisplay(
    pace,
    `${verb} ${money(gain)} on ${money(input.collateralCommitted)} set aside, over ${describePeriodDays(pace.days)} (${percent(pace.totalPercent, 2)} total)`,
    `Average return per week for this position: ${useRealized ? "the realized result" : "the cash collected so far (credits minus buy-backs and fees)"}, divided by the cash you had to set aside to secure it, divided by the weeks it has been open. ${useRealized ? "" : "It is cash flow, not final profit - an open put can still cost money to close. "}${input.assigned ? "Gains or losses on the shares themselves are not included. " : ""}It starts over when you open a new position and keeps running through assignment and covered calls. The usual Low Stress Trading reference is about ${REFERENCE} a week - green at or above it, amber below it, red if negative.`,
  );
}
