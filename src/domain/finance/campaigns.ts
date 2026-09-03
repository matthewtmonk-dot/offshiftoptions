import { round } from "./calculations";

const OPTION_MULTIPLIER = 100;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type CampaignEventKind =
  | "SELL_PUT"
  | "CLOSE_PUT"
  | "ROLL_PUT_CLOSE"
  | "ROLL_PUT_OPEN"
  | "ASSIGNMENT"
  | "SELL_COVERED_CALL"
  | "CLOSE_COVERED_CALL"
  | "COVERED_CALL_EXPIRED"
  | "STOCK_SALE"
  | "NOTE";

export type CampaignStatusInput = "OPEN" | "ASSIGNED" | "CLOSED";

export type CampaignEventInput = {
  id?: string;
  type: CampaignEventKind;
  occurredAt: Date | string;
  sortOrder?: unknown;
  groupKey?: string | null;
  optionType?: "PUT" | "CALL" | null;
  contracts?: unknown;
  shares?: unknown;
  strike?: unknown;
  expiration?: Date | string | null;
  premium?: unknown;
  cashAmount?: unknown;
  fees?: unknown;
  underlyingPrice?: unknown;
  notes?: string | null;
};

export type CampaignCurrentStage =
  | "Cash-secured put"
  | "Rolled put"
  | "Assigned shares"
  | "Covered call"
  | "Closed"
  | "Review needed";

export type CampaignFinalResult = "GAIN" | "LOSS" | "BREAKEVEN" | "OPEN" | "UNKNOWN";

export type CampaignFinancialSummary = {
  openedAt: Date | null;
  closedAt: Date | null;
  daysActive: number | null;
  totalPremiumReceived: number;
  optionDebitsPaid: number;
  netOptionPremium: number;
  rollCredits: number;
  rollDebits: number;
  netRollPremium: number;
  stockCost: number;
  stockProceeds: number;
  fees: number;
  realizedPL: number | null;
  unrealizedPL: number | null;
  totalCampaignPL: number | null;
  collateralCommitted: number | null;
  adjustedBasis: number | null;
  sharesHeld: number;
  finalResult: CampaignFinalResult;
  currentStage: CampaignCurrentStage;
  unknowns: string[];
};

export function optionLegValue(event: CampaignEventInput): number | null {
  const premium = numeric(event.premium);
  const contracts = numeric(event.contracts);
  if (premium === null || contracts === null || contracts <= 0) {
    return null;
  }

  return round(premium * contracts * OPTION_MULTIPLIER, 2);
}

export function summarizeCampaign({
  events,
  status = "OPEN",
  currentUnderlyingPrice = null,
  asOf = new Date(),
}: {
  events: CampaignEventInput[];
  status?: CampaignStatusInput;
  currentUnderlyingPrice?: number | string | null;
  asOf?: Date;
}): CampaignFinancialSummary {
  const orderedEvents = [...events].sort(compareEvents);
  const openedAt = orderedEvents[0] ? toDate(orderedEvents[0].occurredAt) : null;
  const lastTradeEvent = [...orderedEvents].reverse().find((event) => event.type !== "NOTE") ?? null;
  const closedAt = status === "CLOSED" && lastTradeEvent ? toDate(lastTradeEvent.occurredAt) : null;
  const unknowns: string[] = [];

  let totalPremiumReceived = 0;
  let optionDebitsPaid = 0;
  let rollCredits = 0;
  let rollDebits = 0;
  let optionFees = 0;
  let fees = 0;
  let stockCost = 0;
  let stockProceeds = 0;
  let sharesHeld = 0;
  let collateralCommitted: number | null = null;

  for (const event of orderedEvents) {
    const eventFees = numeric(event.fees) ?? 0;
    fees += eventFees;

    if (isOptionEvent(event.type)) {
      optionFees += eventFees;
    }

    if (event.type === "SELL_PUT" || event.type === "ROLL_PUT_OPEN" || event.type === "SELL_COVERED_CALL") {
      const value = optionLegValue(event);
      if (value === null) {
        unknowns.push(`${humanEventType(event.type)} is missing premium or contracts.`);
      } else {
        totalPremiumReceived += value;
        if (event.type === "ROLL_PUT_OPEN") {
          rollCredits += value;
        }
      }
    }

    if (event.type === "CLOSE_PUT" || event.type === "ROLL_PUT_CLOSE" || event.type === "CLOSE_COVERED_CALL") {
      const value = optionLegValue(event);
      if (value === null) {
        unknowns.push(`${humanEventType(event.type)} is missing premium or contracts.`);
      } else {
        optionDebitsPaid += value;
        if (event.type === "ROLL_PUT_CLOSE") {
          rollDebits += value;
        }
      }
    }

    if (event.type === "SELL_PUT" || event.type === "ROLL_PUT_OPEN") {
      const strike = numeric(event.strike);
      const contracts = numeric(event.contracts);
      if (strike !== null && contracts !== null) {
        collateralCommitted = Math.max(collateralCommitted ?? 0, round(strike * contracts * OPTION_MULTIPLIER, 2));
      }
    }

    if (event.type === "ASSIGNMENT") {
      const strike = numeric(event.strike);
      const contracts = numeric(event.contracts);
      const shares = numeric(event.shares) ?? (contracts === null ? null : contracts * OPTION_MULTIPLIER);
      if (strike === null || shares === null) {
        unknowns.push("Assignment is missing strike or share count.");
      } else {
        stockCost += round(strike * shares, 2);
        sharesHeld += shares;
      }
    }

    if (event.type === "STOCK_SALE") {
      const shares = numeric(event.shares);
      const cashAmount = numeric(event.cashAmount);
      const price = numeric(event.underlyingPrice);
      if (shares === null || (cashAmount === null && price === null)) {
        unknowns.push("Stock sale is missing shares and proceeds.");
      } else {
        const proceeds = cashAmount ?? round((price ?? 0) * shares, 2);
        stockProceeds += proceeds;
        sharesHeld -= shares;
      }
    }
  }

  totalPremiumReceived = round(totalPremiumReceived, 2);
  optionDebitsPaid = round(optionDebitsPaid, 2);
  fees = round(fees, 2);
  stockCost = round(stockCost, 2);
  stockProceeds = round(stockProceeds, 2);
  rollCredits = round(rollCredits, 2);
  rollDebits = round(rollDebits, 2);

  const netOptionPremium = round(totalPremiumReceived - optionDebitsPaid - optionFees, 2);
  const netRollPremium = round(rollCredits - rollDebits - rollFees(orderedEvents), 2);
  // Cost basis of shares actually sold so far, allocated proportionally from the total assigned
  // cost basis. This is 0 until a STOCK_SALE event exists, so a never-assigned or still-fully-held
  // campaign's realizedPL reduces to the simple option-only formula.
  const realizedStockCostBasis = allocatedSoldStockCost(stockCost, orderedEvents);
  const realizedPL = round(totalPremiumReceived - optionDebitsPaid - realizedStockCostBasis + stockProceeds - fees, 2);
  const currentPrice = numeric(currentUnderlyingPrice);
  const remainingStockCost = round(stockCost - realizedStockCostBasis, 2);
  const unrealizedPL =
    sharesHeld > 0 && currentPrice !== null
      ? round(sharesHeld * currentPrice - remainingStockCost, 2)
      : null;
  const totalCampaignPL =
    sharesHeld > 0 ? (unrealizedPL === null ? null : round(realizedPL + unrealizedPL, 2)) : realizedPL;
  const adjustedBasis =
    sharesHeld > 0 && stockCost > 0 && stockProceeds === 0
      ? round((stockCost - netOptionPremium) / sharesHeld, 2)
      : null;

  if (sharesHeld > 0 && currentPrice === null) {
    unknowns.push("Open assigned shares need a current stock price for total campaign P/L.");
  }

  return {
    openedAt,
    closedAt,
    daysActive: openedAt ? daysBetween(openedAt, closedAt ?? asOf) : null,
    totalPremiumReceived,
    optionDebitsPaid,
    netOptionPremium,
    rollCredits,
    rollDebits,
    netRollPremium,
    stockCost,
    stockProceeds,
    fees,
    realizedPL,
    unrealizedPL,
    totalCampaignPL,
    collateralCommitted,
    adjustedBasis,
    sharesHeld,
    finalResult: finalResult(status, totalCampaignPL),
    currentStage: currentStage(status, lastTradeEvent?.type ?? null),
    unknowns: unique(unknowns),
  };
}

function compareEvents(left: CampaignEventInput, right: CampaignEventInput) {
  const dateDelta = toDate(left.occurredAt).getTime() - toDate(right.occurredAt).getTime();
  if (dateDelta !== 0) {
    return dateDelta;
  }

  return (numeric(left.sortOrder) ?? 0) - (numeric(right.sortOrder) ?? 0);
}

function daysBetween(start: Date, end: Date) {
  const startUtc = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endUtc = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return Math.max(1, Math.ceil((endUtc - startUtc) / MS_PER_DAY));
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

function isOptionEvent(type: CampaignEventKind) {
  return (
    type === "SELL_PUT" ||
    type === "CLOSE_PUT" ||
    type === "ROLL_PUT_CLOSE" ||
    type === "ROLL_PUT_OPEN" ||
    type === "SELL_COVERED_CALL" ||
    type === "CLOSE_COVERED_CALL" ||
    type === "COVERED_CALL_EXPIRED"
  );
}

function rollFees(events: CampaignEventInput[]) {
  return round(
    events
      .filter((event) => event.type === "ROLL_PUT_CLOSE" || event.type === "ROLL_PUT_OPEN")
      .reduce((sum, event) => sum + (numeric(event.fees) ?? 0), 0),
    2,
  );
}

function allocatedSoldStockCost(stockCost: number, events: CampaignEventInput[]) {
  const assignedShares = events
    .filter((event) => event.type === "ASSIGNMENT")
    .reduce((sum, event) => sum + (numeric(event.shares) ?? (numeric(event.contracts) ?? 0) * OPTION_MULTIPLIER), 0);
  const soldShares = events
    .filter((event) => event.type === "STOCK_SALE")
    .reduce((sum, event) => sum + (numeric(event.shares) ?? 0), 0);

  if (assignedShares <= 0 || soldShares <= 0) {
    return 0;
  }

  return round((stockCost / assignedShares) * soldShares, 2);
}

function finalResult(status: CampaignStatusInput, totalCampaignPL: number | null): CampaignFinalResult {
  if (status !== "CLOSED") {
    return totalCampaignPL === null ? "OPEN" : totalCampaignPL > 0 ? "GAIN" : totalCampaignPL < 0 ? "LOSS" : "BREAKEVEN";
  }

  if (totalCampaignPL === null) {
    return "UNKNOWN";
  }

  if (totalCampaignPL > 0) {
    return "GAIN";
  }

  if (totalCampaignPL < 0) {
    return "LOSS";
  }

  return "BREAKEVEN";
}

function currentStage(status: CampaignStatusInput, lastEventType: CampaignEventKind | null): CampaignCurrentStage {
  if (status === "CLOSED") {
    return "Closed";
  }

  if (status === "ASSIGNED") {
    return lastEventType === "SELL_COVERED_CALL" ? "Covered call" : "Assigned shares";
  }

  if (lastEventType === "ROLL_PUT_CLOSE" || lastEventType === "ROLL_PUT_OPEN") {
    return "Rolled put";
  }

  if (lastEventType === "SELL_PUT" || lastEventType === "CLOSE_PUT") {
    return "Cash-secured put";
  }

  if (lastEventType === "ASSIGNMENT") {
    return "Assigned shares";
  }

  return "Review needed";
}

function humanEventType(type: CampaignEventKind) {
  return type
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function unique(values: string[]) {
  return [...new Set(values)];
}
