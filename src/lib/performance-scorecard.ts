import type { AccountReportingSummary } from "@/domain/finance/reporting";
import type { CampaignEventInput, CampaignStatusInput } from "@/domain/finance/campaigns";
import {
  WEEKLY_PACE_REFERENCE_PERCENT,
  formatWeeklyPercent,
  weeklyPaceTone,
  type WeeklyPaceTone,
} from "@/domain/finance/weeklyPace";
import { capitalWeightedWeeklyReturn, netOptionCashFlowBetween } from "@/domain/finance/weeklyScorecard";
import { accountWeeklyPaceDisplay } from "@/lib/weekly-pace-display";
import { formatEtDateTime, money, percent } from "@/lib/format";

/**
 * View model for the Tracker > Performance "Account scorecard": the money in the account, how much of it is
 * actually working, and the average weekly return measured two ways - on the money put to work, and on the
 * whole account (idle cash included). Numbers come from the authoritative reporting / campaign summaries;
 * this file only divides them by time or capital and words the result. See domain/finance/weeklyScorecard.ts.
 */
export type ScorecardCell = {
  value: string;
  tone: WeeklyPaceTone | "neutral";
  detail: string;
};

export type PerformanceScorecard = {
  accountValue: { value: string; detail: string };
  moneyInUse: { value: string; detail: string };
  record: { thisWeek: string; allTime: string };
  onMoneyInUse: { thisWeek: ScorecardCell; allTime: ScorecardCell; help: string };
  onWholeAccount: { thisWeek: ScorecardCell; allTime: ScorecardCell; help: string };
};

export type ScorecardCampaign = {
  status: CampaignStatusInput;
  events: CampaignEventInput[];
  netOptionPremium: number | null;
  collateralCommitted: number | null;
  daysActive: number | null;
  hasUnknownCashFlow: boolean;
  /** Confirmed realized P/L, only for a CLOSED campaign with a confirmed result; otherwise null. */
  realizedPL: number | null;
};

const REFERENCE = `${WEEKLY_PACE_REFERENCE_PERCENT}%`;

function signedPercent(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function unavailable(detail: string): ScorecardCell {
  return { value: "-", tone: "neutral", detail };
}

function record(wins: number, losses: number, breakevens: number, winRate: number | null): string {
  const base = `${wins}W - ${losses}L${breakevens ? ` - ${breakevens} even` : ""}`;
  return winRate === null ? base : `${base} (${percent(winRate, 0)})`;
}

export function buildPerformanceScorecard(input: {
  report: AccountReportingSummary;
  campaigns: ScorecardCampaign[];
  thisWeek: { wins: number; losses: number; breakevens: number; completedCount: number; weekStartUtc: Date };
  winLoss: { wins: number; losses: number; breakevens: number; winRate: number | null };
  /** Puts that already expired but that Schwab hasn't confirmed yet (expired worthless, or assigned as shares).
   * Their collateral is still counted as "money put to work", so say so rather than let it look confirmed. */
  awaitingSettlement?: { amount: number; count: number };
  asOf: Date;
}): PerformanceScorecard {
  const { report, campaigns, thisWeek, winLoss, asOf } = input;
  const awaiting = input.awaitingSettlement && input.awaitingSettlement.count > 0 ? input.awaitingSettlement : null;
  const accountValue = report.currentAccountValue;
  const committed = report.currentCapitalCommitted;
  const valueAsOf = report.currentAccountValueAsOf;
  const valueAgeDays = valueAsOf === null ? null : Math.round((asOf.getTime() - valueAsOf.getTime()) / 86_400_000);

  const weekIncome = campaigns.some((c) => !c.hasUnknownCashFlow)
    ? campaigns
        .filter((c) => !c.hasUnknownCashFlow)
        .reduce((sum, c) => sum + netOptionCashFlowBetween(c.events, thisWeek.weekStartUtc, asOf), 0)
    : null;
  const weekIncomeRounded = weekIncome === null ? null : Math.round(weekIncome * 100) / 100;

  // --- on the money put to work ---
  const thisWeekOnMoney: ScorecardCell =
    weekIncomeRounded === null
      ? unavailable("No option activity with known cash flow yet.")
      : committed === null || committed <= 0
        ? unavailable("No money is set aside right now.")
        : (() => {
            const pct = (weekIncomeRounded / committed) * 100;
            return {
              value: signedPercent(pct),
              tone: weeklyPaceTone(pct),
              detail: `${money(weekIncomeRounded)} option income this week on ${money(committed)} set aside`,
            } satisfies ScorecardCell;
          })();

  const weighted = capitalWeightedWeeklyReturn(
    campaigns
      .filter((c) => !c.hasUnknownCashFlow)
      .map((c) => ({
        gain: c.status === "CLOSED" && c.realizedPL !== null ? c.realizedPL : c.netOptionPremium,
        capital: c.collateralCommitted,
        days: c.daysActive,
      })),
  );
  const allTimeOnMoney: ScorecardCell = weighted
    ? {
        value: formatWeeklyPercent(weighted.weeklyPercent),
        tone: weeklyPaceTone(weighted.weeklyPercent),
        detail: `${money(weighted.totalGain)} collected across ${weighted.counted} position${weighted.counted === 1 ? "" : "s"}${weighted.longestDays < 7 ? " - early read" : ""}`,
      }
    : unavailable("Needs a position with known cash flow and money set aside.");

  // --- on the whole account (idle cash counts) ---
  const thisWeekOnAccount: ScorecardCell =
    weekIncomeRounded === null
      ? unavailable("No option activity with known cash flow yet.")
      : accountValue === null || accountValue <= 0
        ? unavailable("Account value isn't available.")
        : (() => {
            const pct = (weekIncomeRounded / accountValue) * 100;
            return {
              value: signedPercent(pct),
              tone: weeklyPaceTone(pct),
              detail: `${money(weekIncomeRounded)} option income this week on a ${money(accountValue)} account`,
            } satisfies ScorecardCell;
          })();

  const accountPace = accountWeeklyPaceDisplay(report);
  const allTimeOnAccount: ScorecardCell = accountPace
    ? { value: accountPace.value, tone: accountPace.tone, detail: accountPace.detail }
    : unavailable("Needs an account baseline with no deposits or withdrawals in the period.");

  const idle = accountValue !== null && committed !== null ? Math.max(0, accountValue - committed) : null;

  return {
    accountValue: {
      value: accountValue === null ? "Unavailable" : money(accountValue),
      detail:
        accountValue === null
          ? "No supported account value yet."
          : valueAsOf === null
            ? "Latest supported account value"
            : valueAgeDays !== null && valueAgeDays >= 2
              ? `As of ${formatEtDateTime(valueAsOf)} - ${valueAgeDays} days old. Run Brokerage Sync (Account page) to update it.`
              : `As of ${formatEtDateTime(valueAsOf)}`,
    },
    moneyInUse: {
      value: committed === null ? "Unavailable" : money(committed),
      detail: [
        report.capitalUtilizationStatus === "OK" && report.currentCapitalUtilizationPercent !== null
          ? `${percent(report.currentCapitalUtilizationPercent, 0)} of the account${idle !== null ? ` - ${money(idle)} is cash or holdings outside these tracked campaigns` : ""}`
          : "Put collateral plus assigned shares at cost",
        awaiting
          ? `${money(awaiting.amount)} of this is ${awaiting.count} put${awaiting.count === 1 ? "" : "s"} that already expired and ${awaiting.count === 1 ? "isn't" : "aren't"} confirmed yet (expired, or assigned as shares) - run Brokerage Sync to settle it`
          : null,
      ]
        .filter((part): part is string => part !== null)
        .join(". "),
    },
    record: {
      thisWeek: thisWeek.completedCount === 0 ? "Nothing closed yet" : record(thisWeek.wins, thisWeek.losses, thisWeek.breakevens, thisWeek.wins + thisWeek.losses > 0 ? (thisWeek.wins / (thisWeek.wins + thisWeek.losses)) * 100 : null),
      allTime: winLoss.wins + winLoss.losses + winLoss.breakevens === 0 ? "Nothing closed yet" : record(winLoss.wins, winLoss.losses, winLoss.breakevens, winLoss.winRate),
    },
    onMoneyInUse: {
      thisWeek: thisWeekOnMoney,
      allTime: allTimeOnMoney,
      help: `How hard the money you actually put to work is working. This week: option income dated this week (credits minus buy-backs and fees, rolls included) divided by the money set aside right now. All time: total cash collected across all your positions divided by (money set aside x weeks it was set aside), so bigger positions count for more. It is cash flow, not final profit. The usual Low Stress Trading reference is about ${REFERENCE} a week - green at or above it, amber below it, red if negative.`,
    },
    onWholeAccount: {
      thisWeek: thisWeekOnAccount,
      allTime: allTimeOnAccount,
      help: `The same income, but measured against the WHOLE account, so cash and any holdings outside these tracked campaigns drag it down. This is the honest comparison against leaving the money somewhere else. This week: option income dated this week divided by the account value now. All time: whole-account gain since your baseline divided by the starting value and the weeks passed - the same figure as the Dashboard's Whole-Account Gain card. Reference is about ${REFERENCE} a week.`,
    },
  };
}
