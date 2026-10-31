import { classifyBrokerTransactionAction } from "./brokerTransactionActions";
import { getCurrentOpenCall, isPastExpiration, summarizeCampaign, type CampaignEventInput } from "./campaigns";
import { formatOccSymbol, isSameOccContract, parseOccOptionSymbol } from "./occOption";
import { findCoveredCallCloseEvidence, findExplicitExpirationRecord, parseOpeningCallTransaction, type ReconciliationTransaction } from "./schwabReconciliation";

/**
 * Closing out the SHARE side of a wheel campaign from Schwab's own records - the part the put and
 * covered-call reconcilers deliberately left manual:
 *
 *   - a covered call that reached its expiration (explicit "Removed due to Expiration" notice);
 *   - a covered call that was ASSIGNED, with the stock sold at the strike ("called away");
 *   - the whole assigned position being sold in a plain stock sale;
 *   - linking the share-delivery record that a put assignment itself produced (no new event - the
 *     campaign's ASSIGNMENT event already represents it).
 *
 * Pure planning only: it looks at one campaign's events plus the account's still-unlinked
 * transactions and returns AT MOST ONE next step (or null). The caller applies the step, links the
 * records, and asks again, so a multi-week backlog (expire -> sell -> roll -> assign -> sell shares)
 * resolves one verified step at a time. Everything is conservative: ambiguous or incomplete evidence
 * returns null and the records simply stay unlinked.
 */
export type ClosureTransaction = ReconciliationTransaction & { underlyingSymbol?: string | null };

export type ClosureAction =
  | { kind: "LINK_DELIVERY"; transactionIds: string[] }
  | { kind: "EXPIRE_CALL"; transactionId: string; occurredOn: string }
  | {
      kind: "CALLED_AWAY";
      assignmentTransactionId: string;
      saleTransactionId: string;
      assignedOn: string;
      soldOn: string;
      shares: number;
      price: number;
      assignmentFees: number;
      saleFees: number;
    }
  | { kind: "SELL_SHARES"; transactionId: string; soldOn: string; shares: number; price: number; fees: number };

const PRICE_TOLERANCE = 0.005;
const DELIVERY_WINDOW_DAYS = 5;
const CALLED_AWAY_SALE_BEFORE_DAYS = 3;
const CALLED_AWAY_SALE_AFTER_DAYS = 7;
const MS_PER_DAY = 86_400_000;

type CampaignView = { id: string; ticker: string; events: CampaignEventInput[] };

/** The equity ticker a transaction is about - null for option contracts and anything without a symbol. */
function equityTicker(transaction: ClosureTransaction): string | null {
  const raw = (transaction.underlyingSymbol ?? transaction.symbol ?? "").trim().toUpperCase();
  if (!raw || (transaction.symbol && parseOccOptionSymbol(transaction.symbol))) {
    return null;
  }
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(raw) ? raw : null;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dayNumber(date: Date): number {
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / MS_PER_DAY);
}

function absQuantity(transaction: ClosureTransaction): number | null {
  return transaction.quantity === null || !Number.isFinite(transaction.quantity) ? null : Math.abs(transaction.quantity);
}

function feeOrZero(transaction: ClosureTransaction): number {
  return transaction.fees !== null && Number.isFinite(transaction.fees) ? Math.abs(transaction.fees) : 0;
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isStockSale(transaction: ClosureTransaction): boolean {
  const kind = classifyBrokerTransactionAction(transaction.action);
  return (kind === "SELL_TO_CLOSE" || kind === "STOCK_SELL") && equityTicker(transaction) !== null && !!transaction.occurredAt && transaction.price !== null && transaction.price > 0;
}

function isStockBuy(transaction: ClosureTransaction): boolean {
  const kind = classifyBrokerTransactionAction(transaction.action);
  return (kind === "BUY_TO_OPEN" || kind === "STOCK_BUY") && equityTicker(transaction) !== null && !!transaction.occurredAt && transaction.price !== null && transaction.price > 0;
}

export function planShareClosureAction(input: {
  campaign: CampaignView;
  /** Every ASSIGNED campaign on the same account (including this one) - used to refuse ambiguous matches. */
  assignedPeers: { id: string; ticker: string }[];
  candidates: ClosureTransaction[];
  asOf: Date;
}): ClosureAction | null {
  const { campaign, assignedPeers, candidates, asOf } = input;
  const ticker = campaign.ticker.toUpperCase();
  const samePeers = assignedPeers.filter((peer) => peer.ticker.toUpperCase() === ticker);
  const uniqueForTicker = samePeers.length === 1 && samePeers[0].id === campaign.id;
  const summary = summarizeCampaign({ status: "ASSIGNED", events: campaign.events });

  // 0. Share-delivery records produced by a put assignment: link only, never a new event.
  if (uniqueForTicker) {
    const delivery = findDeliveryRecords(campaign, candidates, ticker);
    if (delivery.length > 0) {
      return { kind: "LINK_DELIVERY", transactionIds: delivery };
    }
  }

  const openCall = getCurrentOpenCall(campaign.events);

  // 1. An open call whose expiration has passed: expired worthless, or assigned (called away).
  if (openCall) {
    if (!isPastExpiration(openCall.expiration, asOf) || !uniqueForTicker) {
      return null;
    }
    const symbol = formatOccSymbol(ticker, openCall.expiration, openCall.strike, "CALL");
    const assignment = candidates.find(
      (transaction) =>
        classifyBrokerTransactionAction(transaction.action) === "ASSIGNMENT" &&
        isSameOccContract(transaction.symbol, symbol) &&
        !!transaction.occurredAt &&
        (absQuantity(transaction) ?? 0) >= openCall.contracts,
    );
    const expiration = findExplicitExpirationRecord(symbol, openCall.contracts, candidates);

    if (assignment && expiration) {
      return null; // Schwab says both - never guess.
    }
    if (expiration) {
      return { kind: "EXPIRE_CALL", transactionId: expiration.id, occurredOn: dayKey(openCall.expiration) };
    }
    if (assignment) {
      const shares = openCall.contracts * 100;
      if (summary.sharesHeld < shares) {
        return null;
      }
      const assignedDay = dayNumber(assignment.occurredAt!);
      const sales = candidates.filter(
        (transaction) =>
          isStockSale(transaction) &&
          equityTicker(transaction) === ticker &&
          absQuantity(transaction) === shares &&
          Math.abs(transaction.price! - openCall.strike) < PRICE_TOLERANCE &&
          dayNumber(transaction.occurredAt!) >= assignedDay - CALLED_AWAY_SALE_BEFORE_DAYS &&
          dayNumber(transaction.occurredAt!) <= assignedDay + CALLED_AWAY_SALE_AFTER_DAYS,
      );
      if (sales.length !== 1) {
        return null; // No sale yet (not synced), or ambiguous.
      }
      const sale = sales[0];
      return {
        kind: "CALLED_AWAY",
        assignmentTransactionId: assignment.id,
        saleTransactionId: sale.id,
        assignedOn: dayKey(assignment.occurredAt!),
        soldOn: dayKey(sale.occurredAt!),
        shares,
        price: sale.price!,
        assignmentFees: feeOrZero(assignment),
        saleFees: feeOrZero(sale),
      };
    }
    return null;
  }

  // 2. No open call: the whole assigned position sold in one plain stock sale. Partial sales are left
  // for manual entry - with other lots possible in the same account, only an exact full close is
  // safe to attribute to this campaign.
  if (uniqueForTicker && summary.sharesHeld > 0) {
    const lastAssignment = [...campaign.events].filter((event) => event.type === "ASSIGNMENT").sort((a, b) => dayNumber(new Date(b.occurredAt)) - dayNumber(new Date(a.occurredAt)))[0];
    const assignedDay = lastAssignment ? dayNumber(new Date(lastAssignment.occurredAt)) : null;
    const sales = candidates.filter(
      (transaction) =>
        isStockSale(transaction) &&
        equityTicker(transaction) === ticker &&
        absQuantity(transaction) === summary.sharesHeld &&
        assignedDay !== null &&
        dayNumber(transaction.occurredAt!) >= assignedDay,
    );
    if (sales.length === 1) {
      const sale = sales[0];
      // Chronology guard: while any unlinked covered-call record on this ticker still sits between the
      // assignment and this sale (an unprocessed expiry, a Sell to Open, a Buy to Close, a call assignment),
      // the call chain has to be reconciled first - otherwise a called-away sale, or the middle of a backlog,
      // would be mistaken for an ordinary sale of the shares.
      const saleDay = dayNumber(sale.occurredAt!);
      const earlierCallActivity = candidates.some((transaction) => {
        const option = transaction.symbol ? parseOccOptionSymbol(transaction.symbol) : null;
        return (
          option?.optionType === "CALL" &&
          option.underlying === ticker &&
          !!transaction.occurredAt &&
          dayNumber(transaction.occurredAt) >= assignedDay! &&
          dayNumber(transaction.occurredAt) <= saleDay
        );
      });
      if (!earlierCallActivity) {
        return { kind: "SELL_SHARES", transactionId: sale.id, soldOn: dayKey(sale.occurredAt!), shares: summary.sharesHeld, price: sale.price!, fees: feeOrZero(sale) };
      }
    }
  }

  return null;
}

/** Stock-delivery rows (Buy to Open) that exactly match one of this campaign's put-ASSIGNMENT events. */
function findDeliveryRecords(campaign: CampaignView, candidates: ClosureTransaction[], ticker: string): string[] {
  const ids = new Set<string>();
  for (const event of campaign.events) {
    if (event.type !== "ASSIGNMENT") continue;
    const shares = asNumber(event.shares) ?? (asNumber(event.contracts) !== null ? asNumber(event.contracts)! * 100 : null);
    const strike = asNumber(event.strike);
    if (shares === null || strike === null) continue;
    const eventDay = dayNumber(new Date(event.occurredAt));
    const matches = candidates.filter(
      (transaction) =>
        isStockBuy(transaction) &&
        equityTicker(transaction) === ticker &&
        absQuantity(transaction) === shares &&
        Math.abs(transaction.price! - strike) < PRICE_TOLERANCE &&
        Math.abs(dayNumber(transaction.occurredAt!) - eventDay) <= DELIVERY_WINDOW_DAYS,
    );
    if (matches.length === 1) {
      ids.add(matches[0].id);
    }
  }
  return [...ids];
}

// ---------------------------------------------------------------------------------------------
// The whole covered-call lifecycle as one pure planner (existing close/open rules + the closure steps
// above), so a multi-week backlog can be unit-tested end to end and the database layer only executes.
// ---------------------------------------------------------------------------------------------

export type CoveredCallStep = { campaignId: string } & (
  | { kind: "CLOSE_CALL"; transactionId: string; occurredOn: string; premium: number; fees: number }
  | { kind: "OPEN_CALL"; transactionId: string; occurredOn: string; expiration: string; strike: number; contracts: number; premium: number; fees: number }
  | ClosureAction
);

/** The ids of every broker record a step consumes (linked to the campaign once the step is applied). */
export function stepTransactionIds(step: CoveredCallStep): string[] {
  switch (step.kind) {
    case "CLOSE_CALL":
    case "OPEN_CALL":
    case "EXPIRE_CALL":
    case "SELL_SHARES":
      return [step.transactionId];
    case "CALLED_AWAY":
      return [step.assignmentTransactionId, step.saleTransactionId];
    case "LINK_DELIVERY":
      return step.transactionIds;
  }
}

function lastAssignmentDay(events: CampaignEventInput[]): number | null {
  const days = events.filter((event) => event.type === "ASSIGNMENT").map((event) => dayNumber(new Date(event.occurredAt)));
  return days.length ? Math.max(...days) : null;
}

/**
 * Next verified step for any ASSIGNED campaign on one account, or null. Order: for every campaign first
 * a Buy to Close on its open call, then the closure steps (delivery link / expiry / called away / share
 * sale); only when nothing is waiting does it attach a new Sell to Open call, and only to the one campaign
 * it unambiguously belongs to (an opening dated before the campaign's own assignment never counts).
 */
export function planCoveredCallStep(input: { campaigns: CampaignView[]; candidates: ClosureTransaction[]; asOf: Date }): CoveredCallStep | null {
  const { campaigns, candidates, asOf } = input;
  const peers = campaigns.map((campaign) => ({ id: campaign.id, ticker: campaign.ticker }));
  const openCalls = campaigns.map((campaign) => ({ campaign, openCall: getCurrentOpenCall(campaign.events) }));

  for (const { campaign, openCall } of openCalls) {
    if (openCall) {
      // Two campaigns holding the exact same contract could both match one fill - never guess.
      const holders = openCalls.filter(
        (entry) =>
          entry.openCall !== null &&
          entry.campaign.ticker.toUpperCase() === campaign.ticker.toUpperCase() &&
          entry.openCall.strike === openCall.strike &&
          entry.openCall.expiration.getTime() === openCall.expiration.getTime(),
      );
      if (holders.length === 1) {
        const symbol = formatOccSymbol(campaign.ticker, openCall.expiration, openCall.strike, "CALL");
        const evidence = findCoveredCallCloseEvidence({ symbol, contracts: openCall.contracts }, candidates);
        if (evidence.kind === "CLOSE") {
          return {
            campaignId: campaign.id,
            kind: "CLOSE_CALL",
            transactionId: evidence.transactionId,
            occurredOn: dayKey(evidence.occurredAt),
            premium: evidence.premium,
            fees: evidence.fees,
          };
        }
      }
    }
    const closure = planShareClosureAction({ campaign, assignedPeers: peers, candidates, asOf });
    if (closure) {
      return { campaignId: campaign.id, ...closure };
    }
  }

  for (const transaction of candidates) {
    const opening = parseOpeningCallTransaction(transaction);
    if (!opening) continue;
    const compatible = openCalls.filter(({ campaign, openCall }) => {
      if (campaign.ticker.toUpperCase() !== opening.underlying.toUpperCase() || openCall) return false;
      const assignedDay = lastAssignmentDay(campaign.events);
      if (assignedDay === null || dayNumber(opening.occurredAt) < assignedDay) return false;
      return summarizeCampaign({ status: "ASSIGNED", events: campaign.events }).sharesHeld >= opening.contracts * 100;
    });
    if (compatible.length === 1) {
      return {
        campaignId: compatible[0].campaign.id,
        kind: "OPEN_CALL",
        transactionId: transaction.id,
        occurredOn: dayKey(opening.occurredAt),
        expiration: dayKey(opening.expiration),
        strike: opening.strike,
        contracts: opening.contracts,
        premium: opening.premium,
        fees: opening.fees,
      };
    }
  }
  return null;
}
