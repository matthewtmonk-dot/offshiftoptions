import { round } from "./calculations";
import { summarizeCampaign, type CampaignEventInput, type CampaignStatusInput } from "./campaigns";

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

export type CampaignProgressSummary = {
  netPremiumCollected: number;
  realizedPL: number | null;
  currentPL: number | null;
  currentCostToClose: number | null;
  projectedOtmPL: number | null;
  projectedOtmApplicable: boolean;
  rollCount: number;
  collateralCommitted: number | null;
  daysActive: number | null;
  currentReturnPercent: number | null;
  projectedReturnPercent: number | null;
  requiredReturnPercent: number | null;
};

export type ContributionAdjustedGoalSummary = {
  status: "OK" | "NO_STARTING_VALUE";
  targetWeeklyPercent: number;
  startingCapital: number | null;
  currentValue: number | null;
  netContributions: number;
  tradingPLNow: number | null;
  projectedOtmPL: number | null;
  targetProfit: number | null;
  actualWeeklyPacePercent: number | null;
  projectedWeeklyPacePercent: number | null;
  percentOfTarget: number | null;
  projectedPercentOfTarget: number | null;
  aheadBehindDollars: number | null;
};

export type GoalLedgerEntryInput = {
  type: "STARTING_VALUE" | "DEPOSIT" | "WITHDRAWAL" | "MANUAL_ADJUSTMENT" | "BROKER_SNAPSHOT" | "NOTE";
  occurredAt: Date | string;
  amount?: unknown;
};

type AccountGoalInput = {
  ledgerEntries: GoalLedgerEntryInput[];
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Campaign progress deliberately keeps the user's three concepts separate:
 * completed/realized P/L, current mark-to-market P/L, and the CSP-only "if the
 * remaining short put expires OTM" projection. Premium collected is useful, but
 * open premium is never labeled as realized profit here.
 */
export function summarizeCampaignProgress({
  status,
  events,
  currentCostToClose = null,
  targetWeeklyPercent = 1,
  asOf = new Date(),
}: {
  status: CampaignStatusInput;
  events: CampaignEventInput[];
  currentCostToClose?: number | null;
  targetWeeklyPercent?: number;
  asOf?: Date;
}): CampaignProgressSummary {
  const summary = summarizeCampaign({ status, events, asOf });
  const openShortPut = findOpenShortPut(status, events);
  const hasUnknownCashFlow = summary.unknowns.length > 0;
  const realizedPL = status === "CLOSED" ? (summary.totalCampaignPL ?? summary.realizedPL) : null;
  const projectedOtmApplicable = status === "OPEN" && openShortPut !== null && summary.sharesHeld === 0;
  const projectedOtmPL = projectedOtmApplicable && !hasUnknownCashFlow ? summary.netOptionPremium : null;
  const normalizedCostToClose = currentCostToClose === null ? null : round(Math.max(0, currentCostToClose), 2);
  const currentPL =
    status === "CLOSED"
      ? realizedPL
      : projectedOtmApplicable && normalizedCostToClose !== null && !hasUnknownCashFlow
        ? round(summary.netOptionPremium - normalizedCostToClose, 2)
        : null;
  const collateralCommitted = summary.collateralCommitted;
  const currentReturnPercent = returnPercent(currentPL, collateralCommitted);
  const projectedReturnPercent = returnPercent(projectedOtmPL, collateralCommitted);
  const requiredReturnPercent =
    summary.daysActive === null ? null : round((Math.max(1, summary.daysActive) / 7) * targetWeeklyPercent, 2);

  return {
    netPremiumCollected: summary.netOptionPremium,
    realizedPL,
    currentPL,
    currentCostToClose: normalizedCostToClose,
    projectedOtmPL,
    projectedOtmApplicable,
    rollCount: countRolls(events),
    collateralCommitted,
    daysActive: summary.daysActive,
    currentReturnPercent,
    projectedReturnPercent,
    requiredReturnPercent,
  };
}

export function tradingProfitFromAccountValue({
  currentValue,
  startingCapital,
  netContributions,
}: {
  currentValue: number | null;
  startingCapital: number | null;
  netContributions: number;
}) {
  if (currentValue === null || startingCapital === null) {
    return null;
  }

  return round(currentValue - startingCapital - netContributions, 2);
}

/**
 * Contribution-adjusted 1% target path. For each dated cash-flow segment, apply the
 * weekly target to the capital actually in the account during that segment. Deposits
 * and withdrawals change the future target base, but never become trading return.
 */
export function summarizeContributionAdjustedGoal({
  accounts,
  currentValue,
  projectedOtmPL,
  targetWeeklyPercent,
  asOf = new Date(),
}: {
  accounts: AccountGoalInput[];
  currentValue: number | null;
  projectedOtmPL: number | null;
  targetWeeklyPercent: number;
  asOf?: Date;
}): ContributionAdjustedGoalSummary {
  const ledgerSummary = summarizeGoalLedgers(accounts, asOf);
  const tradingPLNow = tradingProfitFromAccountValue({
    currentValue,
    startingCapital: ledgerSummary.startingCapital,
    netContributions: ledgerSummary.netContributions,
  });
  const targetProfit =
    ledgerSummary.startingCapital === null ? null : round(ledgerSummary.capitalWeekExposure * (targetWeeklyPercent / 100), 2);
  const actualWeeklyPacePercent =
    tradingPLNow === null || ledgerSummary.capitalWeekExposure <= 0
      ? null
      : round((tradingPLNow / ledgerSummary.capitalWeekExposure) * 100, 2);
  const projectedWeeklyPacePercent =
    projectedOtmPL === null || ledgerSummary.capitalWeekExposure <= 0
      ? null
      : round((projectedOtmPL / ledgerSummary.capitalWeekExposure) * 100, 2);

  return {
    status: ledgerSummary.startingCapital === null ? "NO_STARTING_VALUE" : "OK",
    targetWeeklyPercent,
    startingCapital: ledgerSummary.startingCapital,
    currentValue,
    netContributions: ledgerSummary.netContributions,
    tradingPLNow,
    projectedOtmPL,
    targetProfit,
    actualWeeklyPacePercent,
    projectedWeeklyPacePercent,
    percentOfTarget: percentOfTarget(tradingPLNow, targetProfit),
    projectedPercentOfTarget: percentOfTarget(projectedOtmPL, targetProfit),
    aheadBehindDollars: tradingPLNow === null || targetProfit === null ? null : round(tradingPLNow - targetProfit, 2),
  };
}

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

function findOpenShortPut(status: CampaignStatusInput, events: CampaignEventInput[]) {
  if (status !== "OPEN") {
    return null;
  }

  const lastTradeEvent =
    [...events]
      .sort(compareEvents)
      .reverse()
      .find((event) => event.type !== "NOTE") ?? null;

  if (!lastTradeEvent || (lastTradeEvent.type !== "SELL_PUT" && lastTradeEvent.type !== "ROLL_PUT_OPEN")) {
    return null;
  }

  if (lastTradeEvent.optionType === "CALL") {
    return null;
  }

  const contracts = numeric(lastTradeEvent.contracts);
  const strike = numeric(lastTradeEvent.strike);
  if (contracts === null || contracts <= 0 || strike === null || strike <= 0) {
    return null;
  }

  return { contracts, strike };
}

function countRolls(events: CampaignEventInput[]) {
  const grouped = new Set<string>();
  let ungroupedCloseCount = 0;
  for (const event of events) {
    if (event.type !== "ROLL_PUT_CLOSE" && event.type !== "ROLL_PUT_OPEN") {
      continue;
    }
    if (event.groupKey) {
      grouped.add(event.groupKey);
      continue;
    }
    if (event.type === "ROLL_PUT_CLOSE") {
      ungroupedCloseCount += 1;
    }
  }
  return grouped.size + ungroupedCloseCount;
}

function summarizeGoalLedgers(accounts: AccountGoalInput[], asOf: Date) {
  const events = accounts.flatMap((account) =>
    account.ledgerEntries
      .filter((entry) => entry.type === "STARTING_VALUE" || entry.type === "DEPOSIT" || entry.type === "WITHDRAWAL" || entry.type === "MANUAL_ADJUSTMENT")
      .map((entry) => ({
        type: entry.type,
        occurredAt: toDate(entry.occurredAt),
        amount: numeric(entry.amount),
      })),
  );
  const orderedEvents = events
    .filter((event) => event.amount !== null && event.occurredAt <= asOf)
    .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
  const starts = orderedEvents.filter((event) => event.type === "STARTING_VALUE" && event.amount !== null);
  if (starts.length === 0) {
    return { startingCapital: null, netContributions: 0, capitalWeekExposure: 0 };
  }

  const startingCapital = round(starts.reduce((sum, event) => sum + (event.amount ?? 0), 0), 2);
  const startDate = starts[0]!.occurredAt;

  let capitalBase = 0;
  let netContributions = 0;
  let cursor = startDate;
  let exposure = 0;

  for (const event of orderedEvents) {
    if (event.occurredAt < startDate || event.occurredAt > asOf) {
      continue;
    }
    exposure += capitalBase * weeksBetween(cursor, event.occurredAt);

    if (event.type === "STARTING_VALUE") {
      capitalBase += event.amount ?? 0;
    }
    if (event.type === "DEPOSIT" || event.type === "MANUAL_ADJUSTMENT") {
      capitalBase += event.amount ?? 0;
      netContributions += event.amount ?? 0;
    }
    if (event.type === "WITHDRAWAL") {
      capitalBase -= event.amount ?? 0;
      netContributions -= event.amount ?? 0;
    }

    cursor = event.occurredAt;
  }

  if (asOf > cursor) {
    exposure += capitalBase * weeksBetween(cursor, asOf);
  }

  return {
    startingCapital,
    netContributions: round(netContributions, 2),
    capitalWeekExposure: round(Math.max(0, exposure), 2),
  };
}

function percentOfTarget(value: number | null, target: number | null) {
  if (value === null || target === null || target <= 0) {
    return null;
  }

  return round((value / target) * 100, 1);
}

function returnPercent(value: number | null, basis: number | null) {
  if (value === null || basis === null || basis <= 0) {
    return null;
  }

  return round((value / basis) * 100, 2);
}

function compareEvents(left: CampaignEventInput, right: CampaignEventInput) {
  const dateDelta = toDate(left.occurredAt).getTime() - toDate(right.occurredAt).getTime();
  if (dateDelta !== 0) {
    return dateDelta;
  }

  return (numeric(left.sortOrder) ?? 0) - (numeric(right.sortOrder) ?? 0);
}

function weeksBetween(start: Date, end: Date) {
  return Math.max(0, (end.getTime() - start.getTime()) / MS_PER_DAY / 7);
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const candidate = value as { toNumber?: () => number; toString?: () => string };
  if (typeof candidate.toNumber === "function") {
    const parsed = candidate.toNumber();
    return Number.isFinite(parsed) ? parsed : null;
  }

  const parsed = Number(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function toDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}
