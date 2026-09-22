import { round } from "./calculations";
import {
  classifyBrokerTransactionActivity,
  type BrokerTransactionActivityKind,
} from "./brokerTransactionActions";

export type AccountLedgerEntryKind =
  | "STARTING_VALUE"
  | "DEPOSIT"
  | "WITHDRAWAL"
  | "MANUAL_ADJUSTMENT"
  | "BROKER_SNAPSHOT"
  | "NOTE";

export type AccountLedgerEntryInput = {
  id?: string | null;
  type: AccountLedgerEntryKind;
  occurredAt: Date | string;
  /** Row insertion time - distinct from `occurredAt` (the date the entry is ABOUT). Required to
   * pick the effective STARTING_VALUE revision correctly (see selectEffectiveBaseline): a
   * correction may deliberately move `occurredAt` backward or forward, so only `createdAt` can
   * tell which revision was recorded most recently. Optional for backward compatibility with
   * callers/fixtures that only ever have zero or one STARTING_VALUE entry, where it cannot matter. */
  createdAt?: Date | string;
  amount?: unknown;
  accountValue?: unknown;
  cash?: unknown;
  notes?: string | null;
};

/**
 * The one authoritative STARTING_VALUE revision for an account - see selectEffectiveBaseline.
 * `entry` keeps the original input object (by reference) so callers can re-identify it, e.g. to
 * exclude it from a raw cash-flow-event list or to read its `id`/`notes` for display/audit.
 */
export type EffectiveBaseline = {
  entry: AccountLedgerEntryInput;
  value: number;
  occurredAt: Date;
  createdAt: Date;
  /** Total number of STARTING_VALUE entries considered (1 = never corrected). */
  revisionCount: number;
};

export type AccountLedgerSummary = {
  startingValue: number | null;
  startingValueAt: Date | null;
  netContributions: number;
  latestBrokerSnapshot: { accountValue: number; cash: number | null; asOf: Date } | null;
  /**
   * Current value derived from the ledger alone: starting value + net contributions.
   * This intentionally does NOT include trading P/L - callers combine it with a
   * separately-computed trading P/L (broker transactions when available, campaign fallback)
   * to get a full picture,
   * so a deposit is never mistaken for profit and vice versa.
   */
  ledgerDerivedValue: number | null;
  /** The single authoritative STARTING_VALUE revision this summary used, or null if none exists.
   * `startingValue`/`startingValueAt` above are always derived from this - never a separate
   * interpretation (see selectEffectiveBaseline; Astra: two competing baseline interpretations
   * is exactly the bug this centralizes away). */
  effectiveBaseline: EffectiveBaseline | null;
};

export type AccountBrokerRecordInput = {
  id?: string | null;
  fingerprint?: string | null;
  kind: string;
  status?: string | null;
  occurredAt?: Date | string | null;
  action?: string | null;
  description?: string | null;
  amount?: unknown;
  fees?: unknown;
  metadata?: unknown;
};

export type AccountCashFlowEvent = {
  type: "STARTING_VALUE" | "DEPOSIT" | "WITHDRAWAL" | "MANUAL_ADJUSTMENT";
  occurredAt: Date;
  amount: number;
  source: "LEDGER" | "BROKER_TRANSFER";
};

/**
 * COMPLETE: an explicit STARTING_VALUE exists, every contribution event in the measurement
 * interval traces unambiguously to one funding authority, and (for a Schwab-evidenced account) the
 * measurement interval fits inside the trailing window Schwab sync actually re-fetches each time -
 * dollar gain may be shown.
 * INCOMPLETE_INFERRED_BASELINE: no explicit STARTING_VALUE - startingCapital (if any) comes from
 * the broker-transfer heuristic, which cannot prove original funding (see canUseTransferAsStartingCapital's
 * bounded 90-day-import-window limitation) - labeled provisional, not blocked (existing,
 * already-tested behavior is preserved), but never "COMPLETE" evidence, and never a confirmed gain
 * (Astra corrective patch, Issue 4: an inferred baseline can never prove it captured original funding).
 * INCOMPLETE_MIXED_SOURCES: both a manual ledger contribution and a broker-transfer contribution
 * were recorded inside the same measurement interval - since matching date/amount alone is never
 * proof they are the same real-world event, this account's contribution history is ambiguous -
 * dollar gain is withheld.
 * INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY: the account has Schwab evidence (a BROKER_SNAPSHOT), but
 * either (a) the measurement interval (baseline to ending valuation) is longer than
 * SCHWAB_TRANSACTION_LOOKBACK_DAYS (workflows.ts) - every Schwab sync only ever re-fetches that
 * trailing window of transactions, so a gap older than it was simply never observed - or (b) no
 * affirmative proof was supplied that the LATEST sync's transaction fetch AND persistence both
 * actually succeeded (see BrokerTransactionCoverageStatus below - Astra corrective patch, second
 * pass, Issue 2: a short interval alone is not proof anything was successfully fetched or stored).
 * Never invents a transfer to fill the gap; never expands the import window here - that would
 * require a new importer, out of scope for this fix.
 */
export type FundingCoverageStatus =
  | "COMPLETE"
  | "INCOMPLETE_INFERRED_BASELINE"
  | "INCOMPLETE_MIXED_SOURCES"
  | "INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY";

/** Mirrors SCHWAB_TRANSACTION_LOOKBACK_DAYS in workflows.ts - every Schwab sync (not just the
 * first) only ever re-fetches this trailing window of transactions, so this function has no way to
 * affirmatively prove funding coverage further back than this without a new importer (Issue 3). */
const SCHWAB_TRANSACTION_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Astra corrective patch, second pass (Issue 2, blocker): "the measurement interval fits inside
 * the 90-day lookback we ASKED Schwab for" is not proof we actually RECEIVED and PERSISTED that
 * transaction history - syncSchwabAccountForUser (workflows.ts) writes the BROKER_SNAPSHOT first,
 * then fetches and persists transactions as later, independently-failable steps (see
 * SchwabAccountSyncResult.accounts[].evidence). This type is the caller's own affirmative
 * determination, for THIS specific account's most recent sync, that BOTH the transaction fetch AND
 * its persistence into BrokerRecord succeeded in full. Only "COMPLETE" can ever unlock
 * fundingCoverageStatus === "COMPLETE" for a Schwab-evidenced account; "PARTIAL", "FAILED", or
 * simply omitting the field (the honest default - see AccountPerformanceInput) always leaves it
 * INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY.
 *
 * IMPORTANT ARCHITECTURE NOTE: as of this patch, NO caller in this codebase can honestly supply
 * "COMPLETE" here, because no per-account, per-sync evidence of this kind is persisted anywhere.
 * `activity.evidence` (workflows.ts) is computed fresh on every sync but lives only in memory for
 * that one request (consumed by campaign reconciliation, then discarded). The one thing that IS
 * persisted, `BrokerConnection.metadata.lastSyncDiagnostics` (broker-connections.ts), is a
 * CONNECTION-level aggregate across every Schwab account the user has linked under that connection
 * - it is not scoped to one account or to a measurement interval, so treating it as proof for a
 * specific account would be exactly the kind of unsafe guess this fix exists to prevent. Wiring up
 * genuine per-account, per-interval evidence would need a new persisted, account-scoped field (a
 * schema change) - deliberately not done in this patch. Until then, every Schwab-evidenced
 * account's funding coverage stays INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY unconditionally in
 * production; this type exists so the domain logic is ready the day that evidence exists, and so
 * it can be exercised directly in tests.
 */
export type BrokerTransactionCoverageStatus = "COMPLETE" | "PARTIAL" | "FAILED";

export type AccountPerformanceSummary = {
  ledger: AccountLedgerSummary;
  cashFlowEvents: AccountCashFlowEvent[];
  startingCapital: number | null;
  startingCapitalAt: Date | null;
  startingCapitalSource: "LEDGER" | "BROKER_TRANSFER" | "MIXED" | null;
  /** Whether startingCapital came from an explicit user-entered baseline or was inferred from
   * broker-transfer activity - see FundingCoverageStatus's INCOMPLETE_INFERRED_BASELINE case. */
  fundingCoverageStatus: FundingCoverageStatus | null;
  netContributions: number | null;
  contributionEventCount: number;
  tradingPL: number | null;
  tradingPLSource: "BROKER_TRANSACTIONS" | "CAMPAIGNS" | "MIXED" | null;
  otherIncome: number | null;
  currentValue: number | null;
  currentValueSource: "SCHWAB" | "MANUAL" | "MIXED" | null;
  /** Whole-account dollar gain (ending value - beginning value - deposits + withdrawals) - only
   * ever populated when fundingCoverageStatus is "COMPLETE" (see the ACCOUNT GAIN RULE this
   * ticket introduces). Never a cash-flow-weighted figure - that is explicitly future work. */
  totalGain: number | null;
  totalReturnPercent: number | null;
  totalReturnStatus: "OK" | "NO_BASELINE" | "NO_CURRENT_VALUE" | "CONTRIBUTIONS_NEED_ADVANCED_RETURN" | "INCOMPLETE_FUNDING_EVIDENCE";
  unexplainedGain: number | null;
};

export type AccountPerformanceInput = {
  ledgerEntries: AccountLedgerEntryInput[];
  brokerRecords?: AccountBrokerRecordInput[];
  fallbackTradingPL?: number | null;
  /** The measurement interval's ending instant - funding dated after this is excluded (it
   * hasn't been reflected in `currentValue` yet). Defaults to "now"; a Schwab account's own
   * latest BROKER_SNAPSHOT time is used instead whenever one exists, since that snapshot IS the
   * dated valuation currentValue reflects. */
  asOf?: Date;
  /** See BrokerTransactionCoverageStatus - omit unless the caller has genuine, account-scoped
   * proof that this account's most recent Schwab transaction fetch AND its persistence both fully
   * succeeded. No caller in this codebase can honestly supply this today (see that type's doc
   * comment) - omitting it is the correct, conservative default. */
  brokerTransactionCoverageStatus?: BrokerTransactionCoverageStatus | null;
};

type StartingCapitalSource = NonNullable<AccountPerformanceSummary["startingCapitalSource"]>;
type TradingPLSource = NonNullable<AccountPerformanceSummary["tradingPLSource"]>;
type CurrentValueSource = NonNullable<AccountPerformanceSummary["currentValueSource"]>;

const OPTION_TRADING_ACTIVITY_KINDS = new Set<BrokerTransactionActivityKind>([
  "SELL_TO_OPEN",
  "BUY_TO_CLOSE",
  "BUY_TO_OPEN",
  "SELL_TO_CLOSE",
]);

const OTHER_INCOME_ACTIVITY_KINDS = new Set<BrokerTransactionActivityKind>(["DIVIDEND", "INTEREST", "FEE"]);

type NormalizedAccountBrokerRecord = AccountBrokerRecordInput & {
  amount: number;
  occurredAt: Date;
  activityKind: BrokerTransactionActivityKind;
};

/**
 * The one authoritative rule for picking which STARTING_VALUE entry is "the baseline" when more
 * than one exists (a correction). Every accounting consumer in this file goes through this - see
 * Astra's finding that summarizeAccountLedger and summarizeAccountPerformance previously used two
 * different (and both wrong once corrections exist) interpretations: occurredAt-effective-date
 * ordering, and summing every STARTING_VALUE entry found.
 *
 * Selection is by (createdAt desc, id desc) - deliberately NEVER occurredAt. A correction may
 * intentionally move its own occurredAt earlier OR later than the revision it replaces (the
 * measurement period's start date is being corrected, not just its value), so occurredAt cannot
 * tell which entry is the more recent correction. `id` only breaks an exact createdAt tie
 * deterministically - it carries no temporal meaning beyond that.
 */
export function selectEffectiveBaseline(entries: AccountLedgerEntryInput[]): EffectiveBaseline | null {
  const candidates = entries
    .map((entry) => {
      if (entry.type !== "STARTING_VALUE") {
        return null;
      }
      const value = numeric(entry.amount);
      if (value === null) {
        return null;
      }
      const occurredAt = toDate(entry.occurredAt);
      const createdAt = entry.createdAt !== undefined ? toDate(entry.createdAt) : occurredAt;
      return { entry, value, occurredAt, createdAt, id: entry.id ?? "" };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);

  if (!candidates.length) {
    return null;
  }

  const winner = [...candidates].sort((left, right) => {
    const createdDiff = right.createdAt.getTime() - left.createdAt.getTime();
    if (createdDiff !== 0) {
      return createdDiff;
    }
    if (left.id === right.id) {
      return 0;
    }
    return left.id < right.id ? 1 : -1;
  })[0]!;

  return { entry: winner.entry, value: winner.value, occurredAt: winner.occurredAt, createdAt: winner.createdAt, revisionCount: candidates.length };
}

/**
 * Ticket "Account Baseline & Funding Boundaries": converts a baseline date input ("YYYY-MM-DD",
 * meant as an America/New_York calendar date) into the UTC instant for the END of that NY day
 * (23:59:59.999 America/New_York) - the documented, exact convention for what a baseline date
 * input means: "Account value at the end of the selected America/New_York date." Funding dated
 * strictly after this instant belongs to the measurement period; funding at or before it does not
 * (its economic effect is already inside the starting value).
 *
 * Implementation note: this guesses the true UTC instant by treating the target NY wall-clock
 * time as if it were already UTC, then corrects by the NY UTC offset AT THAT GUESS instant. This
 * is exact for essentially every real date because US DST transitions happen at 2 AM local time,
 * many hours away from the end-of-day instant being computed here - the guess and the true value
 * are always on the same side of any transition. A general-purpose implementation for arbitrary
 * times of day would need to re-check the offset at the corrected instant too; end-of-day never
 * needs that.
 *
 * Astra corrective patch (Issue 7): validates the calendar components themselves before
 * conversion - `Date.UTC` silently normalizes an impossible date (e.g. 2026-02-30 rolls into
 * March), which would otherwise accept a baseline date that never existed. Also rejects a baseline
 * instant that is still in the future relative to `referenceNow` (defaults to the real "now";
 * overridable only for deterministic testing) - a baseline records the account's value at a point
 * that has already happened, never a value not yet knowable.
 */
export function endOfNyCalendarDateUtc(nyDateInput: string, referenceNow: Date = new Date()): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(nyDateInput.trim());
  if (!match) {
    throw new RangeError(`Expected a YYYY-MM-DD date, got "${nyDateInput}".`);
  }
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  if (month < 1 || month > 12) {
    throw new RangeError(`"${nyDateInput}" has an invalid month.`);
  }
  // new Date(Date.UTC(year, month, 0)) is day 0 of the (0-indexed) month after `month` - i.e. the
  // last day of `month` itself (1-indexed) - the standard idiom for "days in a 1-indexed month"
  // that automatically accounts for leap years without a separate leap-year formula.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth) {
    throw new RangeError(`"${nyDateInput}" is not a real calendar date.`);
  }

  // The offset is computed from a whole-second guess (no ms) - nyOffsetMillisAt reads NY's wall
  // clock via Intl.DateTimeFormat, which truncates sub-second precision. Feeding it a guess that
  // already has .999ms would make that truncation silently drop the fractional second from one
  // side of the subtraction but not the other, corrupting the offset by up to 999ms. The trailing
  // 999ms is added back afterward, once the offset itself is exact.
  const guess = Date.UTC(year, month - 1, day, 23, 59, 59);
  const offsetMs = nyOffsetMillisAt(new Date(guess));
  const result = new Date(guess + offsetMs + 999);

  if (result.getTime() > referenceNow.getTime()) {
    throw new RangeError(`"${nyDateInput}" is a future date - a baseline can only record a value that has already happened.`);
  }

  return result;
}

/** The number of milliseconds to ADD to "NY wall-clock digits read as if they were UTC" to reach
 * the true UTC instant - i.e. how far behind UTC New York currently is (+4h EDT, +5h EST). */
function nyOffsetMillisAt(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const hour = value("hour") % 24; // some locales format midnight as "24"
  const wallClockAsUtc = Date.UTC(value("year"), value("month") - 1, value("day"), hour, value("minute"), value("second"));
  return instant.getTime() - wallClockAsUtc;
}

/**
 * Summarizes an account's cash-flow history, keeping external contributions
 * (deposits/withdrawals/adjustments) strictly separate from trading performance.
 * A BROKER_SNAPSHOT entry never contributes to netContributions - it is a fact
 * reported by Schwab, not a cash flow the user made.
 */
export function summarizeAccountLedger(entries: AccountLedgerEntryInput[]): AccountLedgerSummary {
  const effectiveBaseline = selectEffectiveBaseline(entries);
  const ordered = [...entries].sort(
    (left, right) => toDate(left.occurredAt).getTime() - toDate(right.occurredAt).getTime(),
  );

  let netContributions = 0;
  let latestBrokerSnapshot: AccountLedgerSummary["latestBrokerSnapshot"] = null;

  for (const entry of ordered) {
    const amount = numeric(entry.amount);

    if (entry.type === "STARTING_VALUE") {
      // Handled entirely by effectiveBaseline above - a superseded revision must never also
      // contribute here, and the effective one is not a "contribution" either.
      continue;
    }

    if (entry.type === "DEPOSIT" || entry.type === "WITHDRAWAL" || entry.type === "MANUAL_ADJUSTMENT") {
      if (amount === null) {
        continue;
      }
      // Measurement-interval lower bound: funding at or before the baseline instant is already
      // included in the starting value - counting it again would double it.
      if (effectiveBaseline && toDate(entry.occurredAt).getTime() <= effectiveBaseline.occurredAt.getTime()) {
        continue;
      }
      if (entry.type === "WITHDRAWAL") {
        netContributions -= amount;
      } else {
        netContributions += amount;
      }
      continue;
    }

    if (entry.type === "BROKER_SNAPSHOT") {
      const accountValue = numeric(entry.accountValue);
      if (accountValue !== null) {
        latestBrokerSnapshot = {
          accountValue,
          cash: numeric(entry.cash),
          asOf: toDate(entry.occurredAt),
        };
      }
    }
  }

  netContributions = round(netContributions, 2);
  const startingValue = effectiveBaseline?.value ?? null;
  const ledgerDerivedValue = startingValue === null ? null : round(startingValue + netContributions, 2);

  return {
    startingValue,
    startingValueAt: effectiveBaseline?.occurredAt ?? null,
    netContributions,
    latestBrokerSnapshot,
    ledgerDerivedValue,
    effectiveBaseline,
  };
}

/**
 * Account-level performance keeps three facts separate:
 * transfer/contribution cash flows, realized option-trade cash flows, and non-trading income.
 * Schwab-imported BrokerRecord rows are already user/account scoped and fingerprint-deduped, so
 * this derives from those facts instead of creating a second persistent accounting surface.
 */
export function summarizeAccountPerformance(input: AccountPerformanceInput): AccountPerformanceSummary {
  const ledger = summarizeAccountLedger(input.ledgerEntries);
  const explicitBaseline = ledger.effectiveBaseline; // the ONE authoritative selector - see selectEffectiveBaseline
  const brokerRecords = uniqueBrokerRecords(input.brokerRecords ?? [])
    .filter((record) => record.kind === "TRANSACTION" && (record.status ?? "CONFIRMED") === "CONFIRMED")
    .map((record) => ({
      ...record,
      amount: numeric(record.amount),
      occurredAt: record.occurredAt ? toDate(record.occurredAt) : null,
      activityKind: brokerActivityKind(record),
    }))
    .filter((record): record is NormalizedAccountBrokerRecord => {
      return record.amount !== null && record.occurredAt !== null;
    })
    .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());

  const transferRecords = brokerRecords.filter(isExternalTransfer);
  const firstPositiveTransfer = transferRecords.find((record) => record.amount > 0) ?? null;
  // Broker-transfer baseline INFERENCE only ever runs when there is no explicit baseline - an
  // explicit STARTING_VALUE always wins (see the ACCOUNT GAIN RULE / explicit-vs-inferred
  // precedence this ticket establishes). The underlying transfer record itself is never deleted
  // or altered either way - only whether it is TREATED as the baseline is affected. Computed here
  // (before endingAt) purely so baselineInstant below can see it - this doesn't change its value.
  const baselineTransfer =
    !explicitBaseline && firstPositiveTransfer && canUseTransferAsStartingCapital(firstPositiveTransfer, brokerRecords, input.ledgerEntries)
      ? firstPositiveTransfer
      : null;
  // The one instant that starts the measurement interval, whichever baseline (explicit or
  // inferred) is in effect - used to bound every reconstructed value/funding figure below to the
  // same interval (Astra corrective patch, Issues 2 & 5: valuation and funding must agree).
  const baselineInstant = explicitBaseline?.occurredAt ?? baselineTransfer?.occurredAt ?? null;

  // A BROKER_SNAPSHOT dated BEFORE the baseline is not a valid ending valuation for this interval
  // - it describes the account before the measurement period even began (Astra corrective patch,
  // Issue 2's second repro: a stale pre-baseline snapshot must never produce a fabricated negative
  // "gain"). When it's invalid, fall back to input.asOf/now for interval-filtering purposes so a
  // real post-baseline ledger deposit still isn't silently discarded just because the only known
  // snapshot predates the interval - see snapshotIsValidEnding's use in currentValue below, which
  // is the thing that actually gates whether a value is trusted for gain.
  const snapshotIsValidEnding =
    ledger.latestBrokerSnapshot !== null &&
    (baselineInstant === null || ledger.latestBrokerSnapshot.asOf.getTime() >= baselineInstant.getTime());
  const endingAt = snapshotIsValidEnding ? ledger.latestBrokerSnapshot!.asOf : (input.asOf ?? new Date());

  // Only the EFFECTIVE baseline revision ever becomes a cash-flow event - a superseded
  // correction must never be summed alongside it (Astra: summarizeAccountPerformance may sum
  // multiple STARTING_VALUE entries - unsafe once corrections exist).
  const ledgerCashFlows = input.ledgerEntries
    .map((entry): AccountCashFlowEvent | null => {
      const amount = numeric(entry.amount);
      if (amount === null) {
        return null;
      }
      if (entry.type === "STARTING_VALUE") {
        if (!explicitBaseline || entry !== explicitBaseline.entry) {
          return null;
        }
        return { type: "STARTING_VALUE", occurredAt: explicitBaseline.occurredAt, amount: explicitBaseline.value, source: "LEDGER" };
      }
      if (entry.type === "DEPOSIT" || entry.type === "WITHDRAWAL" || entry.type === "MANUAL_ADJUSTMENT") {
        const occurredAt = toDate(entry.occurredAt);
        // Measurement interval: excluded if at-or-before baseline (already in the starting
        // value) or after the ending valuation instant (not yet reflected in currentValue).
        if (explicitBaseline && occurredAt.getTime() <= explicitBaseline.occurredAt.getTime()) {
          return null;
        }
        if (occurredAt.getTime() > endingAt.getTime()) {
          return null;
        }
        return { type: entry.type, occurredAt, amount, source: "LEDGER" };
      }
      return null;
    })
    .filter((event): event is AccountCashFlowEvent => event !== null);

  // Astra corrective patch, second pass (Issue 1, blocker): once an explicit baseline exists, no
  // date/amount matching against it is ever used to suppress a broker transfer - only the
  // measurement interval's exact timestamp boundary decides. The prior version of this fix (first
  // pass) restricted the old same-day/same-amount dedup to only the CURRENT effective baseline
  // revision (fixing the superseded-revision case), but that dedup itself remained unsafe even
  // against the correct revision: a baseline's occurredAt is an America/New_York END-OF-DAY
  // instant, which lands on the NEXT UTC calendar date - so a genuinely NEW, coincidentally
  // same-amount deposit the following NY afternoon can share the SAME UTC calendar date as the
  // baseline's own occurredAt and get wrongly matched as "the same event." Reproduced case:
  // baseline $10,000 at end of Sep 1 NY, a genuine $10,000 broker deposit on Sep 2 afternoon - both
  // land on the same UTC date, and the old date/amount dedup silently dropped the real deposit.
  // The baseline represents the account's value at its EXACT opening timestamp: any external
  // funding strictly after that timestamp is a contribution, full stop, regardless of its amount or
  // calendar date. (A transfer that TRULY is the same real-world event the baseline was set from is
  // still excluded correctly - not by matching, but because it is normally dated at/before the
  // baseline's end-of-day instant, so the interval boundary alone excludes it.)
  const brokerCashFlows = transferRecords
    .filter((record) => {
      if (baselineTransfer && record === baselineTransfer) {
        return false;
      }
      if (explicitBaseline) {
        // Measurement interval, same bounds as ledger entries above. No date/amount fuzzy
        // matching here - a transfer strictly after the baseline instant is a real contribution.
        return record.occurredAt.getTime() > explicitBaseline.occurredAt.getTime() && record.occurredAt.getTime() <= endingAt.getTime();
      }
      if (baselineTransfer) {
        return record.occurredAt > baselineTransfer.occurredAt && record.occurredAt.getTime() <= endingAt.getTime();
      }
      return firstPositiveTransfer !== null && record.occurredAt.getTime() <= endingAt.getTime();
    })
    .map((record): AccountCashFlowEvent => ({
      type: record.amount >= 0 ? "DEPOSIT" : "WITHDRAWAL",
      occurredAt: record.occurredAt,
      amount: Math.abs(record.amount),
      source: "BROKER_TRANSFER",
    }));

  const derivedBaseline = baselineTransfer
    ? ({
        type: "STARTING_VALUE",
        occurredAt: baselineTransfer.occurredAt,
        amount: baselineTransfer.amount,
        source: "BROKER_TRANSFER",
      } satisfies AccountCashFlowEvent)
    : null;
  const cashFlowEvents = [...ledgerCashFlows, ...(derivedBaseline ? [derivedBaseline] : []), ...brokerCashFlows].sort(
    (left, right) => left.occurredAt.getTime() - right.occurredAt.getTime(),
  );

  const starts = cashFlowEvents.filter((event) => event.type === "STARTING_VALUE");
  // At most one of these can ever exist by construction: ledgerCashFlows contributes only the
  // single effective revision (or none), and derivedBaseline only exists when there is no
  // explicit baseline at all - so this is never a sum of competing interpretations.
  const startingCapital = starts.length ? round(starts[0]!.amount, 2) : null;
  const startingCapitalAt = starts[0]?.occurredAt ?? null;
  const startingCapitalSource = sourceSummary(starts.map((event) => event.source));
  const contributionEvents = cashFlowEvents.filter((event) => event.type !== "STARTING_VALUE");
  const netContributions =
    startingCapital === null
      ? null
      : round(
          contributionEvents.reduce((sum, event) => {
            if (event.type === "WITHDRAWAL") {
              return sum - event.amount;
            }
            return sum + event.amount;
          }, 0),
          2,
        );

  // Mixed-source funding: a manual ledger contribution AND a broker-transfer contribution both
  // recorded inside the same measurement interval. Matching date/amount alone never resolves
  // this (see the ticket's explicit rule), so this is surfaced as ambiguous rather than guessed.
  const contributionSources = new Set(contributionEvents.map((event) => event.source));
  const hasMixedFundingSources = contributionSources.has("LEDGER") && contributionSources.has("BROKER_TRANSFER");
  // Astra corrective patch (Issue 3, first pass): a Schwab sync only ever re-fetches a trailing
  // SCHWAB_TRANSACTION_LOOKBACK_DAYS window of transactions (see workflows.ts) - a measurement
  // interval longer than that window can never be proven complete from Schwab evidence alone,
  // no matter what the latest sync's own outcome was.
  const hasSchwabEvidence = ledger.latestBrokerSnapshot !== null;
  const intervalExceedsSchwabLookback =
    explicitBaseline !== null &&
    hasSchwabEvidence &&
    baselineInstant !== null &&
    endingAt.getTime() - baselineInstant.getTime() > SCHWAB_TRANSACTION_LOOKBACK_MS;
  // Astra corrective patch, second pass (Issue 2, blocker): fitting inside that window is
  // NECESSARY but not SUFFICIENT - "we asked Schwab for 90 days" is not proof "we successfully
  // received and persisted 90 days." syncSchwabAccountForUser writes the BROKER_SNAPSHOT first,
  // then fetches and persists transactions as later, independently-failable steps - a snapshot can
  // exist and be perfectly current while the transaction history behind it silently never arrived.
  // COMPLETE now additionally requires the caller's own affirmative proof (see
  // BrokerTransactionCoverageStatus) that THIS account's fetch+persistence both fully succeeded -
  // no caller in this codebase can honestly supply that today (see that type's doc comment), so a
  // Schwab-evidenced account's coverage is unconditionally INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY in
  // production until a future ticket adds real per-account evidence tracking.
  const hasProvenSchwabTransactionCoverage =
    !intervalExceedsSchwabLookback && (input.brokerTransactionCoverageStatus ?? null) === "COMPLETE";
  const fundingCoverageStatus: FundingCoverageStatus | null =
    startingCapital === null
      ? null
      : hasMixedFundingSources
        ? "INCOMPLETE_MIXED_SOURCES"
        : !explicitBaseline
          ? "INCOMPLETE_INFERRED_BASELINE"
          : hasSchwabEvidence && !hasProvenSchwabTransactionCoverage
            ? "INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY"
            : "COMPLETE";

  // Astra corrective patch (Issues 2 & 5, blockers): trading P/L that has its own per-event dates
  // (broker transaction records) is bounded to the SAME measurement interval as every other
  // reconstructed figure here - a pre-baseline trade is already reflected in the starting value
  // (double-counting it would inflate gain), and a post-endingAt trade hasn't been reflected in the
  // ending valuation yet.
  const brokerTradeRecords = brokerRecords.filter((record) => {
    if (!OPTION_TRADING_ACTIVITY_KINDS.has(record.activityKind)) {
      return false;
    }
    if (baselineInstant !== null && record.occurredAt.getTime() <= baselineInstant.getTime()) {
      return false;
    }
    return record.occurredAt.getTime() <= endingAt.getTime();
  });
  const brokerTradingPL = brokerTradeRecords.length
    ? round(brokerTradeRecords.reduce((sum, record) => sum + record.amount, 0), 2)
    : null;
  const fallbackTradingPL = input.fallbackTradingPL ?? null;
  const tradingPL = brokerTradingPL ?? fallbackTradingPL;
  const tradingPLSource =
    brokerTradingPL !== null
      ? "BROKER_TRANSACTIONS"
      : fallbackTradingPL !== null
        ? "CAMPAIGNS"
        : null;

  const otherIncome = brokerRecords.length
    ? round(
        brokerRecords
          .filter((record) => OTHER_INCOME_ACTIVITY_KINDS.has(record.activityKind))
          .reduce((sum, record) => sum + record.amount, 0),
        2,
      )
    : null;

  // Astra corrective patch (Issues 2 & 5, first pass; Issue 3, second pass - all blockers): the
  // "current value" used for whole-account gain must itself be a genuine, SUPPORTED ending account
  // valuation - never the legacy currentAccountValue() helper's MANUAL fallback, which derives
  // from ledger.netContributions (only lower-bounded by the baseline, with NO upper bound at all -
  // a deposit dated after endingAt used to leak straight through into currentValue even though this
  // function's OWN, separately-bounded `netContributions` above correctly excluded it).
  //
  // Second-pass finding (Issue 3): a BROKER_SNAPSHOT dated at/after the baseline
  // (snapshotIsValidEnding, above) is the ONLY supported account-value reading this function
  // recognizes - a snapshot from before the baseline describes a different, earlier state and must
  // never be diffed against the baseline. Trading cash flows (dated broker option transactions,
  // undated lifetime CAMPAIGNS P/L, or anything derived from them) are NEVER a substitute for a
  // real account valuation, no matter how well-dated: receiving option premium also creates an
  // offsetting short-option liability, so "cash received" is not the same fact as "whole-account
  // value increased by that amount." Astra's exact repro: baseline $10,000 + a $75 Sell to Open
  // premium + no broker snapshot at all used to produce currentValue $10,075 / gain $75 - there was
  // no supported ending valuation involved anywhere in that reconstruction.
  //
  // The one narrow exception: when NO trading activity of any kind occurred in the interval
  // (tradingPL === null - no broker option records AND no campaign fallback), contributions
  // (deposits/withdrawals) are the ONLY thing that could have changed the account's value, and
  // unlike option premium they are dollar-for-dollar, liability-free cash movements - starting
  // capital + those contributions is then a genuine supported valuation, not a synthesized one.
  let currentValue: number | null;
  let currentValueSource: "SCHWAB" | "MANUAL" | null;
  if (snapshotIsValidEnding) {
    currentValue = ledger.latestBrokerSnapshot!.accountValue;
    currentValueSource = "SCHWAB";
  } else if (ledger.latestBrokerSnapshot === null && startingCapital !== null && tradingPL === null) {
    currentValue = round(startingCapital + (netContributions ?? 0), 2);
    currentValueSource = "MANUAL";
  } else {
    currentValue = null;
    currentValueSource = null;
  }

  // ACCOUNT GAIN RULE: ending - beginning - deposits + withdrawals, exposed only when there is a
  // trustworthy ending valuation (currentValue above) AND funding coverage is affirmatively
  // complete - never a cash-flow-weighted percentage (that stays future work), and never computed
  // from ambiguous or unproven evidence.
  const totalGain =
    currentValue !== null && startingCapital !== null && netContributions !== null && fundingCoverageStatus === "COMPLETE"
      ? round(currentValue - startingCapital - netContributions, 2)
      : null;
  const totalReturnStatus = totalReturnStatusFor({ startingCapital, currentValue, contributionEventCount: contributionEvents.length, fundingCoverageStatus });
  const totalReturnPercent =
    totalReturnStatus === "OK" && totalGain !== null && startingCapital !== null && startingCapital > 0
      ? round((totalGain / startingCapital) * 100, 4)
      : null;
  const explainedGain = tradingPL === null || otherIncome === null ? null : round(tradingPL + otherIncome, 2);
  const unexplainedGain = totalGain === null || explainedGain === null ? null : round(totalGain - explainedGain, 2);

  return {
    ledger,
    cashFlowEvents,
    startingCapital,
    startingCapitalAt,
    startingCapitalSource,
    fundingCoverageStatus,
    netContributions,
    contributionEventCount: contributionEvents.length,
    tradingPL,
    tradingPLSource,
    otherIncome,
    currentValue,
    currentValueSource,
    totalGain,
    totalReturnPercent,
    totalReturnStatus,
    unexplainedGain,
  };
}

export function summarizeAccountsPerformance(accounts: AccountPerformanceInput[]): AccountPerformanceSummary {
  const summaries = accounts.map((account) => summarizeAccountPerformance(account));
  const hasAccounts = summaries.length > 0;
  const startingCapital = hasAccounts && summaries.every((summary) => summary.startingCapital !== null)
    ? round(summaries.reduce((sum, summary) => sum + (summary.startingCapital ?? 0), 0), 2)
    : null;
  const currentValue = hasAccounts && summaries.every((summary) => summary.currentValue !== null)
    ? round(summaries.reduce((sum, summary) => sum + (summary.currentValue ?? 0), 0), 2)
    : null;
  const netContributions = hasAccounts && summaries.every((summary) => summary.netContributions !== null)
    ? round(summaries.reduce((sum, summary) => sum + (summary.netContributions ?? 0), 0), 2)
    : null;
  const tradingPL = summaries.some((summary) => summary.tradingPL !== null)
    ? round(summaries.reduce((sum, summary) => sum + (summary.tradingPL ?? 0), 0), 2)
    : null;
  const otherIncome = hasAccounts && summaries.every((summary) => summary.otherIncome !== null)
    ? round(summaries.reduce((sum, summary) => sum + (summary.otherIncome ?? 0), 0), 2)
    : null;
  // Aggregate funding coverage is only as good as its weakest account - one ambiguous or
  // unverifiable account must withhold the combined dollar gain the same way it withholds its own.
  // Ranked most-to-least severe so the aggregate always reports the worst reason present.
  const hasMixedFundingSources = summaries.some((summary) => summary.fundingCoverageStatus === "INCOMPLETE_MIXED_SOURCES");
  const hasUnverifiedSchwabHistory = summaries.some((summary) => summary.fundingCoverageStatus === "INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY");
  const hasInferredBaseline = summaries.some((summary) => summary.fundingCoverageStatus === "INCOMPLETE_INFERRED_BASELINE");
  const fundingCoverageStatus: FundingCoverageStatus | null = !hasAccounts
    ? null
    : hasMixedFundingSources
      ? "INCOMPLETE_MIXED_SOURCES"
      : hasUnverifiedSchwabHistory
        ? "INCOMPLETE_UNVERIFIED_SCHWAB_HISTORY"
        : hasInferredBaseline
          ? "INCOMPLETE_INFERRED_BASELINE"
          : "COMPLETE";
  const totalGain =
    currentValue !== null && startingCapital !== null && netContributions !== null && fundingCoverageStatus === "COMPLETE"
      ? round(currentValue - startingCapital - netContributions, 2)
      : null;
  const contributionEventCount = summaries.reduce((sum, summary) => sum + summary.contributionEventCount, 0);
  const totalReturnStatus = totalReturnStatusFor({ startingCapital, currentValue, contributionEventCount, fundingCoverageStatus });
  const totalReturnPercent =
    totalReturnStatus === "OK" && totalGain !== null && startingCapital !== null && startingCapital > 0
      ? round((totalGain / startingCapital) * 100, 4)
      : null;
  const explainedGain = tradingPL === null || otherIncome === null ? null : round(tradingPL + otherIncome, 2);

  return {
    ledger: {
      startingValue: startingCapital,
      startingValueAt: summaries.map((summary) => summary.startingCapitalAt).filter((date): date is Date => date !== null)[0] ?? null,
      netContributions: netContributions ?? 0,
      latestBrokerSnapshot: null,
      ledgerDerivedValue: startingCapital === null || netContributions === null ? null : round(startingCapital + netContributions, 2),
      effectiveBaseline: null, // Multi-account aggregation has no single ledger's baseline revision to point to.
    },
    cashFlowEvents: summaries.flatMap((summary) => summary.cashFlowEvents).sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime()),
    startingCapital,
    startingCapitalAt: summaries.map((summary) => summary.startingCapitalAt).filter((date): date is Date => date !== null)[0] ?? null,
    startingCapitalSource: sourceSummary(summaries.map((summary) => summary.startingCapitalSource).filter((source): source is "LEDGER" | "BROKER_TRANSFER" | "MIXED" => source !== null)),
    fundingCoverageStatus,
    netContributions,
    contributionEventCount,
    tradingPL,
    tradingPLSource: tradingSourceSummary(summaries.map((summary) => summary.tradingPLSource).filter((source): source is "BROKER_TRANSACTIONS" | "CAMPAIGNS" | "MIXED" => source !== null)),
    otherIncome,
    currentValue,
    currentValueSource: currentSourceSummary(summaries.map((summary) => summary.currentValueSource).filter((source): source is "SCHWAB" | "MANUAL" | "MIXED" => source !== null)),
    totalGain,
    totalReturnPercent,
    totalReturnStatus,
    unexplainedGain: totalGain === null || explainedGain === null ? null : round(totalGain - explainedGain, 2),
  };
}

/**
 * The account value to actually display: a live Schwab snapshot is authoritative when
 * present (it already reflects trading P/L, contributions, everything). Otherwise fall
 * back to the ledger-derived value plus known realized trading P/L, so a manual account
 * shows starting + contributions + completed trading profit - never contributions alone.
 */
export function currentAccountValue(
  summary: AccountLedgerSummary,
  realizedTradingPL: number,
): { value: number | null; source: "SCHWAB" | "MANUAL" } {
  if (summary.latestBrokerSnapshot) {
    return { value: summary.latestBrokerSnapshot.accountValue, source: "SCHWAB" };
  }

  if (summary.ledgerDerivedValue === null) {
    return { value: null, source: "MANUAL" };
  }

  return { value: round(summary.ledgerDerivedValue + realizedTradingPL, 2), source: "MANUAL" };
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const candidate = value as { toNumber?: () => number };
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

function uniqueBrokerRecords(records: AccountBrokerRecordInput[]) {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key =
      record.fingerprint ??
      record.id ??
      [
        record.kind,
        record.status ?? "",
        record.occurredAt ? toDate(record.occurredAt).toISOString() : "",
        record.action ?? "",
        record.description ?? "",
        numeric(record.amount)?.toFixed(4) ?? "",
      ].join("|");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function brokerActivityKind(record: AccountBrokerRecordInput): BrokerTransactionActivityKind {
  const direct = classifyBrokerTransactionActivity({ action: record.action, description: record.description });
  if (direct !== "UNKNOWN") {
    return direct;
  }

  const metadata = objectValue(record.metadata);
  return isBrokerActivityKind(metadata?.activityKind) ? metadata.activityKind : "UNKNOWN";
}

function isBrokerActivityKind(value: unknown): value is BrokerTransactionActivityKind {
  return (
    value === "SELL_TO_OPEN" ||
    value === "BUY_TO_CLOSE" ||
    value === "BUY_TO_OPEN" ||
    value === "SELL_TO_CLOSE" ||
    value === "STOCK_BUY" ||
    value === "STOCK_SELL" ||
    value === "ASSIGNMENT" ||
    value === "EXERCISE" ||
    value === "DIVIDEND" ||
    value === "INTEREST" ||
    value === "FEE" ||
    value === "TRANSFER" ||
    value === "OPTION_REMOVED_EXPIRATION" ||
    value === "UNKNOWN"
  );
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isExternalTransfer(record: NormalizedAccountBrokerRecord) {
  if (record.activityKind !== "TRANSFER") {
    return false;
  }

  const text = brokerRecordText(record);
  if (text.includes("internal") || text.includes("sweep") || text.includes("journaled shares")) {
    return false;
  }

  return (
    text.includes("security transfer") ||
    text.includes("toa acat") ||
    text.includes("moneylink transfer") ||
    text.includes("wire received") ||
    text.includes("wire sent") ||
    text.includes("funds received") ||
    text.includes("atm withdrawal")
  );
}

function canUseTransferAsStartingCapital(
  candidate: NormalizedAccountBrokerRecord,
  brokerRecords: NormalizedAccountBrokerRecord[],
  ledgerEntries: AccountLedgerEntryInput[],
) {
  if (candidate.amount <= 0 || !isQualifiedStartingTransfer(candidate)) {
    return false;
  }

  const candidateTime = candidate.occurredAt.getTime();
  const earlierBrokerActivity = brokerRecords.some(
    (record) => record !== candidate && record.occurredAt.getTime() < candidateTime,
  );
  if (earlierBrokerActivity) {
    return false;
  }

  const earliestSnapshot = earliestBrokerSnapshotAt(ledgerEntries);
  return earliestSnapshot === null || earliestSnapshot.getTime() >= candidateTime;
}

function isQualifiedStartingTransfer(record: NormalizedAccountBrokerRecord) {
  const text = brokerRecordText(record);
  return isExternalTransfer(record) && (text.includes("security transfer") || text.includes("toa acat"));
}

function earliestBrokerSnapshotAt(entries: AccountLedgerEntryInput[]) {
  const snapshotTimes = entries
    .filter((entry) => entry.type === "BROKER_SNAPSHOT" && numeric(entry.accountValue) !== null)
    .map((entry) => toDate(entry.occurredAt).getTime());
  if (!snapshotTimes.length) {
    return null;
  }
  return new Date(Math.min(...snapshotTimes));
}

function brokerRecordText(record: Pick<AccountBrokerRecordInput, "action" | "description">) {
  return `${record.action ?? ""} ${record.description ?? ""}`.trim().toLowerCase();
}

function sourceSummary(sources: StartingCapitalSource[]): AccountPerformanceSummary["startingCapitalSource"] {
  const concrete = sources.flatMap((source): ("LEDGER" | "BROKER_TRANSFER")[] =>
    source === "MIXED" ? ["LEDGER", "BROKER_TRANSFER"] : [source],
  );
  if (concrete.length === 0) {
    return null;
  }
  return new Set(concrete).size > 1 ? "MIXED" : concrete[0]!;
}

function tradingSourceSummary(sources: TradingPLSource[]): AccountPerformanceSummary["tradingPLSource"] {
  const concrete = sources.flatMap((source): ("BROKER_TRANSACTIONS" | "CAMPAIGNS")[] =>
    source === "MIXED" ? ["BROKER_TRANSACTIONS", "CAMPAIGNS"] : [source],
  );
  if (concrete.length === 0) {
    return null;
  }
  return new Set(concrete).size > 1 ? "MIXED" : concrete[0]!;
}

function currentSourceSummary(sources: CurrentValueSource[]): AccountPerformanceSummary["currentValueSource"] {
  const concrete = sources.flatMap((source): ("SCHWAB" | "MANUAL")[] =>
    source === "MIXED" ? ["SCHWAB", "MANUAL"] : [source],
  );
  if (concrete.length === 0) {
    return null;
  }
  return new Set(concrete).size > 1 ? "MIXED" : concrete[0]!;
}

function totalReturnStatusFor({
  startingCapital,
  currentValue,
  contributionEventCount,
  fundingCoverageStatus,
}: {
  startingCapital: number | null;
  currentValue: number | null;
  contributionEventCount: number;
  /** Astra corrective patch (Issues 3 & 4): any non-"COMPLETE" status - mixed sources, an inferred
   * (unproven) baseline, or Schwab evidence that can't be verified back to the baseline - withholds
   * a confirmed return the same way, so this checks the whole status rather than one narrow cause. */
  fundingCoverageStatus?: FundingCoverageStatus | null;
}): AccountPerformanceSummary["totalReturnStatus"] {
  if (startingCapital === null || startingCapital <= 0) {
    return "NO_BASELINE";
  }
  if (currentValue === null) {
    return "NO_CURRENT_VALUE";
  }
  if (fundingCoverageStatus !== null && fundingCoverageStatus !== undefined && fundingCoverageStatus !== "COMPLETE") {
    return "INCOMPLETE_FUNDING_EVIDENCE";
  }
  if (contributionEventCount > 0) {
    return "CONTRIBUTIONS_NEED_ADVANCED_RETURN";
  }
  return "OK";
}
