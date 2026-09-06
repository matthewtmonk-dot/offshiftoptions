import { classifyBrokerTransactionAction } from "./brokerTransactionActions";
import { nextNyseMarketDay } from "./marketCalendar";
import { parseOccOptionSymbol } from "./occOption";

export type ReconciliationTransaction = {
  id: string;
  symbol: string | null;
  occurredAt: Date | null;
  action: string | null;
  quantity: number | null;
  price: number | null;
  fees: number | null;
};

export type ParsedPutOpen = {
  transactionId: string;
  underlying: string;
  symbol: string;
  strike: number;
  expiration: Date;
  contracts: number;
  premium: number;
  fees: number;
  occurredAt: Date;
};

/**
 * A clean "Sell to Open" put leg this engine is confident enough to auto-create a campaign
 * from. Anything ambiguous (missing quantity/price, a call instead of a put, an unparsed
 * symbol) returns null so the caller leaves it for the existing manual "awaiting review" flow
 * instead of guessing at a campaign's terms.
 */
export function parseOpeningPutTransaction(transaction: ReconciliationTransaction): ParsedPutOpen | null {
  if (classifyBrokerTransactionAction(transaction.action) !== "SELL_TO_OPEN") {
    return null;
  }
  if (!transaction.symbol || !transaction.occurredAt) {
    return null;
  }

  const leg = parseOccOptionSymbol(transaction.symbol);
  if (!leg || leg.optionType !== "PUT") {
    return null;
  }

  const contracts = transaction.quantity !== null ? Math.round(Math.abs(transaction.quantity)) : null;
  if (!contracts || contracts <= 0) {
    return null;
  }

  if (transaction.price === null || !Number.isFinite(transaction.price) || transaction.price === 0) {
    return null;
  }

  return {
    transactionId: transaction.id,
    underlying: leg.underlying,
    symbol: transaction.symbol,
    strike: leg.strike,
    expiration: leg.expiration,
    contracts,
    premium: Math.abs(transaction.price),
    fees: transaction.fees !== null ? Math.abs(transaction.fees) : 0,
    occurredAt: transaction.occurredAt,
  };
}

/**
 * Identifies "Sell to Open" transactions that are actually the *new* leg of a same-day roll
 * (a matching Buy to Close on a different contract of the same underlying, same calendar day)
 * rather than a brand-new position. Callers must exclude these from fresh campaign-opening
 * detection - otherwise a roll's new leg gets mistaken for an independent new campaign before
 * findClosingEvidence ever gets a chance to pair it with the leg it's rolling from, whether
 * that old leg's campaign already exists or is only just about to be created in this same sync.
 */
export function findRollPairedOpeningTransactionIds(candidates: ReconciliationTransaction[]): Set<string> {
  const reserved = new Set<string>();

  for (const closeTxn of candidates) {
    if (classifyBrokerTransactionAction(closeTxn.action) !== "BUY_TO_CLOSE" || !closeTxn.symbol || !closeTxn.occurredAt) {
      continue;
    }
    const closingLeg = parseOccOptionSymbol(closeTxn.symbol);
    if (!closingLeg || closingLeg.optionType !== "PUT") {
      continue;
    }
    const closeDay = dayKey(closeTxn.occurredAt);

    for (const openTxn of candidates) {
      if (openTxn.id === closeTxn.id || !openTxn.symbol || !openTxn.occurredAt) {
        continue;
      }
      if (classifyBrokerTransactionAction(openTxn.action) !== "SELL_TO_OPEN") {
        continue;
      }
      const openingLeg = parseOccOptionSymbol(openTxn.symbol);
      if (!openingLeg || openingLeg.optionType !== "PUT" || openingLeg.underlying !== closingLeg.underlying) {
        continue;
      }
      if (openingLeg.strike === closingLeg.strike && openingLeg.expiration.getTime() === closingLeg.expiration.getTime()) {
        continue; // same contract - not a roll pairing
      }
      if (dayKey(openTxn.occurredAt) === closeDay) {
        reserved.add(openTxn.id);
      }
    }
  }

  return reserved;
}

export type ClosingEvidence =
  | { kind: "CLOSE"; transactionId: string; occurredAt: Date; premium: number; fees: number }
  | {
      kind: "ROLL";
      closeTransactionId: string;
      openTransactionId: string;
      occurredAt: Date;
      closePremium: number;
      newStrike: number;
      newExpiration: Date;
      newPremium: number;
      /** Kept separate (not pre-summed) so the caller can attribute each real transaction's own
       * fee to its own event (ROLL_PUT_CLOSE / ROLL_PUT_OPEN) instead of dumping the combined
       * total onto one event - the campaign's total fees are unaffected either way. */
      closeFees: number;
      openFees: number;
    }
  | { kind: "ASSIGNMENT"; transactionId: string; occurredAt: Date; fees: number }
  | { kind: "NONE" };

/**
 * Looks for a Buy to Close, assignment, or roll among unlinked transactions for a campaign's
 * currently open put leg. A roll is recognized only when a Buy to Close on this exact leg and
 * a Sell to Open on a *different* strike/expiration of the *same underlying* land on the same
 * calendar day - thinkorswim/Schwab submit a roll as one multi-leg order, so its two fills
 * always share a trade date. Anything looser (a different day) is treated as an independent
 * close followed by an independent new campaign, not guessed as a roll.
 */
export function findClosingEvidence(
  leg: { symbol: string; underlying: string; strike: number; expiration: Date },
  candidates: ReconciliationTransaction[],
): ClosingEvidence {
  const closeTxn = candidates.find(
    (transaction) =>
      transaction.symbol === leg.symbol &&
      classifyBrokerTransactionAction(transaction.action) === "BUY_TO_CLOSE" &&
      transaction.occurredAt &&
      transaction.price !== null,
  );

  if (closeTxn) {
    const closeDay = dayKey(closeTxn.occurredAt!);
    const rollOpen = candidates.find((transaction) => {
      if (transaction.id === closeTxn.id || !transaction.symbol || !transaction.occurredAt || transaction.price === null) {
        return false;
      }
      if (classifyBrokerTransactionAction(transaction.action) !== "SELL_TO_OPEN") {
        return false;
      }
      const otherLeg = parseOccOptionSymbol(transaction.symbol);
      if (!otherLeg || otherLeg.optionType !== "PUT" || otherLeg.underlying !== leg.underlying) {
        return false;
      }
      if (otherLeg.strike === leg.strike && otherLeg.expiration.getTime() === leg.expiration.getTime()) {
        return false; // same contract as what's closing - not a new leg
      }
      return dayKey(transaction.occurredAt) === closeDay;
    });

    if (rollOpen) {
      const otherLeg = parseOccOptionSymbol(rollOpen.symbol!)!;
      return {
        kind: "ROLL",
        closeTransactionId: closeTxn.id,
        openTransactionId: rollOpen.id,
        occurredAt: closeTxn.occurredAt!,
        closePremium: Math.abs(closeTxn.price!),
        newStrike: otherLeg.strike,
        newExpiration: otherLeg.expiration,
        newPremium: Math.abs(rollOpen.price!),
        closeFees: absOrZero(closeTxn.fees),
        openFees: absOrZero(rollOpen.fees),
      };
    }

    return {
      kind: "CLOSE",
      transactionId: closeTxn.id,
      occurredAt: closeTxn.occurredAt!,
      premium: Math.abs(closeTxn.price!),
      fees: absOrZero(closeTxn.fees),
    };
  }

  const assignment = candidates.find(
    (transaction) => transaction.symbol === leg.symbol && classifyBrokerTransactionAction(transaction.action) === "ASSIGNMENT" && transaction.occurredAt,
  );
  if (assignment) {
    return { kind: "ASSIGNMENT", transactionId: assignment.id, occurredAt: assignment.occurredAt!, fees: absOrZero(assignment.fees) };
  }

  return { kind: "NONE" };
}

export type ReconciliationPosition = {
  symbol: string;
  assetType?: string | null;
  quantity: number;
};

/**
 * Tier-2 expiration evidence, tightened against a real assignment-processing-lag risk: Schwab
 * can drop a short put from the positions response before it exposes the resulting assignment
 * transaction or the acquired long-stock position, so "the option just disappeared" is NOT
 * enough on its own - a put is only confirmed expired worthless once ALL of:
 *
 *   1. this sync happens on or after the first NY business day following expiration (assignment
 *      settles overnight and processes on the next session - never "Saturday means expired");
 *   2. the option is absent from the freshly-synced live positions;
 *   3. this sync found no closing (Buy to Close) or assignment transaction for it; and
 *   4. the underlying does not show up as an acquired long-stock position in this same sync -
 *      the strongest "was this actually assigned" signal Schwab's positions response reliably
 *      exposes without inventing an undocumented transaction field. This is deliberately
 *      conservative: a user who happens to independently hold long stock in the same ticker
 *      will see this campaign sit in "Expiration processing" until manually closed - a false
 *      negative is an inconvenience; a false "expired worthless" on a real assignment is a
 *      wrong financial record, so this trades one risk for the other on purpose.
 *
 * Anything short of that stays OPEN ("Expiration processing") rather than a guess.
 */
export function isConfirmedExpiredWorthless(input: {
  expiration: Date;
  symbol: string;
  underlying: string;
  freshPositions: ReconciliationPosition[];
  hasClosingEvidence: boolean;
  asOf: Date;
}): boolean {
  if (input.hasClosingEvidence) {
    return false;
  }
  if (!isOnOrAfterNextBusinessDay(input.expiration, input.asOf)) {
    return false;
  }
  if (input.freshPositions.some((position) => position.symbol === input.symbol)) {
    return false;
  }
  const acquiredStock = input.freshPositions.some(
    (position) => position.assetType === "EQUITY" && position.symbol === input.underlying && position.quantity > 0,
  );
  return !acquiredStock;
}

/**
 * The first NYSE MARKET day strictly after `expiration` - skips weekends AND NYSE holidays
 * (see marketCalendar.ts), so a Friday expiration immediately followed by a holiday Monday
 * (e.g. Labor Day) correctly waits for Tuesday, never "the next weekday."
 */
function isOnOrAfterNextBusinessDay(expiration: Date, asOf: Date): boolean {
  return nyCalendarDateKey(asOf) >= dayKey(nextNyseMarketDay(expiration));
}

function nyCalendarDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const valueFor = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${valueFor("year")}-${valueFor("month")}-${valueFor("day")}`;
}

function absOrZero(value: number | null) {
  return value !== null ? Math.abs(value) : 0;
}

function dayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}
