import { round } from "./calculations";

export type CompletedCampaignResult = {
  campaignId: string;
  closedAt: Date;
  finalResult: "GAIN" | "LOSS" | "BREAKEVEN" | "OPEN" | "UNKNOWN";
  pl: number | null;
  daysActive: number | null;
};

const KNOWN_FINAL_RESULTS = new Set(["GAIN", "LOSS", "BREAKEVEN"]);

export type WinLossSummary = {
  completedCount: number;
  wins: number;
  losses: number;
  breakevens: number;
  unknownResults: number;
  winRate: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  averageDurationDays: number | null;
  realizedTradingPL: number;
};

/**
 * Only CLOSED campaigns with a known final result count toward win/loss. An OPEN
 * campaign's current net cash flow (e.g. +$57 after a roll) is never a "win" until it
 * actually closes - see src/domain/finance/campaigns.ts summarizeCampaign for how a
 * campaign's status/finalResult is derived event-by-event.
 */
export function summarizeWinLoss(completed: CompletedCampaignResult[]): WinLossSummary {
  const known = completed.filter((c) => KNOWN_FINAL_RESULTS.has(c.finalResult) && c.pl !== null);
  const wins = known.filter((c) => c.finalResult === "GAIN");
  const losses = known.filter((c) => c.finalResult === "LOSS");
  const breakevens = known.filter((c) => c.finalResult === "BREAKEVEN");
  const unknownResults = completed.length - known.length;
  const durations = completed.map((c) => c.daysActive).filter((d): d is number => d !== null);

  const realizedTradingPL = round(
    known.reduce((sum, c) => sum + (c.pl ?? 0), 0),
    2,
  );

  return {
    completedCount: completed.length,
    wins: wins.length,
    losses: losses.length,
    breakevens: breakevens.length,
    unknownResults,
    winRate: known.length ? round((wins.length / known.length) * 100, 1) : null,
    averageWin: wins.length ? round(wins.reduce((sum, c) => sum + (c.pl ?? 0), 0) / wins.length, 2) : null,
    averageLoss: losses.length ? round(losses.reduce((sum, c) => sum + (c.pl ?? 0), 0) / losses.length, 2) : null,
    averageDurationDays: durations.length ? round(durations.reduce((a, b) => a + b, 0) / durations.length, 1) : null,
    realizedTradingPL,
  };
}

export type WeeklyReturnSummary = {
  status: "OK" | "INSUFFICIENT_HISTORY";
  targetPercent: number;
  thisWeekPercent: number | null;
  trailing4WeekAveragePercent: number | null;
  weeksAtOrAboveTarget: number | null;
  totalWeeksTracked: number | null;
};

/**
 * METHODOLOGY (documented deliberately, see PROJECT_HANDOFF.md "Performance / 1% target"):
 * this buckets completed campaigns' realized P/L by the ISO week they closed in, and
 * divides each week's P/L by a single fixed `baseline` (the account's current
 * ledger-derived value). This is a simple realized-return-per-week metric, NOT a
 * time-weighted or money-weighted rate of return - it does not adjust for deposits or
 * withdrawals that happened mid-period, and using one fixed baseline for every week
 * understates return in early weeks (when the account was smaller) and overstates it in
 * later weeks after growth. It is intentionally the simplest mathematically defensible
 * choice for this slice rather than a fabricated precision the app cannot back up. A
 * proper time-weighted return is future work once enough dated history exists to make
 * one meaningful.
 */
export function summarizeWeeklyReturns(
  completed: { closedAt: Date; pl: number | null }[],
  baseline: number | null,
  targetPercent: number,
  asOf: Date = new Date(),
): WeeklyReturnSummary {
  const known = completed.filter((c): c is { closedAt: Date; pl: number } => c.pl !== null);

  if (baseline === null || baseline <= 0 || known.length === 0) {
    return {
      status: "INSUFFICIENT_HISTORY",
      targetPercent,
      thisWeekPercent: null,
      trailing4WeekAveragePercent: null,
      weeksAtOrAboveTarget: null,
      totalWeeksTracked: null,
    };
  }

  const byWeek = new Map<string, number>();
  for (const entry of known) {
    const key = isoWeekKey(entry.closedAt);
    byWeek.set(key, (byWeek.get(key) ?? 0) + entry.pl);
  }

  const currentWeekKey = isoWeekKey(asOf);
  const weekEntries = [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const percentByWeek = weekEntries.map(([key, pl]) => [key, round((pl / baseline) * 100, 2)] as const);
  const thisWeekPercent = percentByWeek.find(([key]) => key === currentWeekKey)?.[1] ?? 0;
  const priorWeeks = percentByWeek.filter(([key]) => key !== currentWeekKey);
  const last4Prior = priorWeeks.slice(-4);

  return {
    status: "OK",
    targetPercent,
    thisWeekPercent,
    trailing4WeekAveragePercent: last4Prior.length
      ? round(last4Prior.reduce((sum, [, pct]) => sum + pct, 0) / last4Prior.length, 2)
      : null,
    weeksAtOrAboveTarget: percentByWeek.filter(([, pct]) => pct >= targetPercent).length,
    totalWeeksTracked: percentByWeek.length,
  };
}

function isoWeekKey(date: Date): string {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = (utc.getUTCDay() + 6) % 7; // Monday = 0
  utc.setUTCDate(utc.getUTCDate() - dayNumber + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(utc.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((utc.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
