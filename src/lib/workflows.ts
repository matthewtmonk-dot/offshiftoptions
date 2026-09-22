import { randomUUID } from "node:crypto";
import { endOfNyCalendarDateUtc, selectEffectiveBaseline, type AccountLedgerEntryInput } from "@/domain/finance/accountLedger";
import { getCurrentOpenCall, isPastExpiration, summarizeCampaign } from "@/domain/finance/campaigns";
import type { SchwabReconciliationEvidence, TransactionEvidenceStatus } from "@/domain/finance/schwabReconciliation";
import { compareStockStageCandidates, evaluateLiveMarketScan, STARTER_LIVE_SCAN_UNIVERSE, type LiveScanCandidate } from "@/domain/scanner/live-scan";
import type {
  LsegRecommendation,
  NoteCategory,
  ProfitabilityAssessment,
  ReactionTargetType,
  ResearchStatus,
  RollFriendliness,
  WouldOwnStatus,
} from "@/generated/prisma/enums";
import { evaluateDemoScan, GATING_RULE_KEYS, parseScannerDesiredFromForm, scannerRulesFromRecords, SCANNER_RULE_DEFINITIONS } from "@/domain/scanner/profile";
import { classifyReadiness } from "@/domain/scanner/scanner";
import { sanitizeResearchColumns, isResearchSortKey } from "@/domain/research/columns";
import { isRecommendationStatus, normalizeReasonTags, type RecommendationStatus } from "@/domain/social/recommendations";
import { mapWithConcurrency } from "./concurrency";
import {
  assertCanMutateRecord,
  assertCanReadInheritedRecord,
  assertCanReadRecord,
  resolveInheritedVisibility,
  type InheritedVisibility,
  type Visibility,
} from "./privacy";
import { prisma } from "./prisma";
import { requireTicker, ValidationError } from "./tickers";
import { notifyInApp, NOTIFICATIONS_PAGE_VISIBLE_TYPES } from "./notifications";
import type { AccountLedgerEntryType } from "@/generated/prisma/enums";
import {
  removeSchwabDeveloperCredentialForUser,
  saveSchwabDeveloperCredentialForUser,
} from "@/providers/schwab/developer-credentials";
import {
  categorizeSchwabSyncError,
  clearSchwabBrokerReadCacheForUser,
  getSchwabBrokerReadProviderForUser,
  getSchwabMarketDataProviderForUser,
  logSchwabSyncFailure,
  recordSchwabAccountSyncResult,
} from "./broker-connections";
import { persistNormalizedBrokerRecordsForUser } from "./broker-import";
import { getTechnicalIndicatorSnapshotsForUser } from "./technical-indicator-cache";
import { getEarningsCalendarLookup } from "./earnings-calendar-cache";
import { OCC_OPTIONABLE_UNIVERSE_SOURCE } from "./occ-optionable-universe-refresh";
import {
  prepareChatImageAttachments,
  removeUploadedChatAttachments,
  uploadChatAttachments,
  type PreparedChatAttachment,
} from "./chat-attachments";
import { mergeBrokerRecords, normalizeSchwabApiPosition, normalizeSchwabApiTransaction } from "@/providers/schwab/csv";
import type {
  BrokerPosition,
  BrokerReadProvider,
  BrokerTransaction,
  BrokerTransactionCategory,
  BrokerTransactionCategoryOutcome,
} from "@/providers/broker-read/types";

const NOTE_CATEGORIES = new Set<NoteCategory>(["PRO", "CON", "GENERAL"]);
const RESEARCH_STATUSES = new Set<ResearchStatus>(["LIKE", "WATCH", "NEUTRAL", "AVOID", "NEVER_TRADE"]);
const WOULD_OWN_STATUSES = new Set<WouldOwnStatus>(["YES", "NO", "CONDITIONAL"]);
const ROLL_FRIENDLINESS_VALUES = new Set<RollFriendliness>(["UNKNOWN", "FRIENDLY", "DIFFICULT"]);
const LSEG_RECOMMENDATIONS = new Set<LsegRecommendation>(["BUY", "HOLD", "SELL", "UNKNOWN"]);
const PROFITABILITY_ASSESSMENTS = new Set<ProfitabilityAssessment>(["PROFITABLE", "MIXED", "UNPROFITABLE", "UNKNOWN"]);
const ACCOUNT_VISIBILITIES = new Set<Visibility>(["PRIVATE", "SHARED"]);
const RECORD_VISIBILITIES = new Set<InheritedVisibility>(["INHERIT", "PRIVATE", "SHARED"]);
const MANUAL_LEDGER_ENTRY_TYPES = new Set<AccountLedgerEntryType>(["DEPOSIT", "WITHDRAWAL", "MANUAL_ADJUSTMENT"]);
const campaignDetailInclude = {
  owner: { select: { id: true, name: true, email: true } },
  account: {
    select: {
      id: true,
      userId: true,
      name: true,
      accountType: true,
      startingBalance: true,
      manualBalance: true,
      visibility: true,
    },
  },
  events: { orderBy: [{ occurredAt: "asc" as const }, { sortOrder: "asc" as const }] },
};
const RETURNABLE_PATHS = new Set([
  "/account",
  "/dashboard",
  "/positions",
  "/scanner",
  "/scanner/settings",
  "/watchlist",
  "/research",
  "/recommendations",
  "/chat",
  "/notifications",
]);

export function safeReturnPath(value: FormDataEntryValue | null, fallback: string) {
  const path = String(value ?? "");
  return RETURNABLE_PATHS.has(path) ? path : fallback;
}

export function trimText(value: unknown, maxLength = 700) {
  return String(value ?? "").trim().slice(0, maxLength);
}

export async function createTradingAccountForUser(
  userId: string,
  nameInput: unknown,
  accountTypeInput: unknown,
  startingBalanceInput: unknown,
  manualBalanceInput: unknown,
  visibilityInput: unknown,
) {
  const name = trimText(nameInput, 80);
  if (!name) {
    throw new ValidationError("Name the account first.");
  }

  const accountType = trimText(accountTypeInput, 40) || "Manual";
  const startingBalance = parseOptionalMoney(startingBalanceInput, "starting balance");
  const manualBalance = parseOptionalMoney(manualBalanceInput, "current balance") ?? startingBalance;
  // Accounts default PRIVATE - personal brokerage/balance data is not shared-by-default
  // the way watchlist/research ideas are. Sharing remains available, opt-in, per account.
  const visibility = parseAccountVisibility(visibilityInput, "PRIVATE");
  const snapshotBalance = manualBalance ?? startingBalance;
  const openedAt = new Date();

  return prisma.tradingAccount.create({
    data: {
      userId,
      name,
      brokerName: "Manual",
      accountType,
      startingBalance,
      manualBalance,
      visibility,
      snapshots:
        snapshotBalance === null
          ? undefined
          : {
              create: {
                accountValue: snapshotBalance,
                cash: snapshotBalance,
                cashSecuringPuts: 0,
                availableCash: snapshotBalance,
                realizedPL: 0,
                unrealizedPL: 0,
                premiumCollected: 0,
              },
            },
      // The ledger - not startingBalance/manualBalance - is the authoritative source for
      // distinguishing trading performance from contributions (see src/domain/finance/accountLedger.ts).
      ledgerEntries:
        startingBalance === null
          ? undefined
          : {
              create: {
                type: "STARTING_VALUE",
                occurredAt: openedAt,
                amount: startingBalance,
                source: "MANUAL",
              },
            },
    },
  });
}

const SCHWAB_TRANSACTION_LOOKBACK_DAYS = 90;

function categoryCount(outcome: BrokerTransactionCategoryOutcome): number {
  return outcome.status === "OK" ? outcome.count : 0;
}

export type SchwabAccountSyncResult = {
  syncedAccounts: number;
  accounts: { id: string; name: string; accountValue: number; cash: number; evidence: SchwabReconciliationEvidence }[];
  /** The sync-only portion of SchwabSyncDiagnostics (see broker-connections.ts) - the caller
   * (syncSchwabAccountAction) merges in the campaign-related counts from
   * reconcileSchwabActivityForUser, which runs after this returns, before persisting the full
   * diagnostics record. */
  diagnostics: {
    positionsReceived: number;
    positionsSourceStatus: "OK" | "ERROR";
    positionsErrorCode: string | null;
    transactionsReceived: number;
    transactionsEvidenceStatus: TransactionEvidenceStatus;
    tradeTransactionsReceived: number;
    tradeSourceStatus: "OK" | "ERROR";
    receiveAndDeliverReceived: number;
    receiveAndDeliverSourceStatus: "OK" | "ERROR";
    dividendOrInterestReceived: number;
    dividendOrInterestSourceStatus: "OK" | "ERROR";
    transactionsErrorCode: string | null;
    brokerRecordsInserted: number;
    duplicatesSkipped: number;
    recordsUnresolved: number;
    feeKnownCount: number;
    feeUnknownCount: number;
    persistenceStatus: "OK" | "ERROR";
    persistenceErrorCode: string | null;
  };
};

/**
 * Fetches this account's live positions and recent transactions with fully independent failure
 * handling - confirmed live against production that a single rejected Schwab request (e.g. an
 * unsupported transaction-type value) must never be allowed to erase data from an unrelated,
 * otherwise-successful request. Positions and transactions are fetched in their own try/catch
 * blocks (not Promise.all), and getTransactions() itself already isolates each transaction
 * category internally (see SchwabBrokerReadProvider.getTransactions) - so a rejected category
 * still leaves the other categories' transactions intact here. Each catch records a sanitized
 * error category (never the raw provider message) so the caller can distinguish an honest empty
 * result from a failed request - see categorizeSchwabSyncError in broker-connections.ts.
 */
export async function fetchSchwabAccountActivity(provider: BrokerReadProvider, accountId: string, from: Date, to: Date) {
  let positions: BrokerPosition[] = [];
  let positionsStatus: "OK" | "ERROR" = "OK";
  let positionsErrorCode: string | null = null;
  try {
    positions = await provider.getPositions(accountId);
  } catch (error) {
    positionsStatus = "ERROR";
    positionsErrorCode = categorizeSchwabSyncError(error);
  }

  let transactions: BrokerTransaction[] = [];
  let transactionCategories: Record<BrokerTransactionCategory, BrokerTransactionCategoryOutcome> | null = null;
  let transactionsErrorCode: string | null = null;
  try {
    const result = await provider.getTransactions(accountId, from, to);
    transactions = result.transactions;
    transactionCategories = result.categories;
  } catch (error) {
    // Every category rejected (or some other total failure) - positions above is unaffected.
    transactionsErrorCode = categorizeSchwabSyncError(error);
  }

  const categoryStatuses = ["TRADE", "RECEIVE_AND_DELIVER", "DIVIDEND_OR_INTEREST"].map(
    (category) => transactionCategories?.[category as BrokerTransactionCategory]?.status,
  );
  const transactionsEvidenceStatus: TransactionEvidenceStatus = categoryStatuses.every((status) => status === "OK")
    ? "COMPLETE"
    : categoryStatuses.some((status) => status === "OK") ? "PARTIAL" : "FAILED";
  const evidence: SchwabReconciliationEvidence = {
    positions: { status: positionsStatus === "OK" ? "COMPLETE" : "FAILED", data: positions },
    transactions: { status: transactionsEvidenceStatus, from, to },
    // The caller must mark a persistence failure before handing this evidence to reconciliation.
    persistenceStatus: "COMPLETE",
  };
  return { positions, positionsStatus, positionsErrorCode, transactions, transactionCategories, transactionsErrorCode, evidence };
}

/**
 * Normalizes fresh positions/transactions into candidate BrokerRecords, then coalesces via the
 * existing mergeBrokerRecords() (see providers/schwab/csv.ts, already used by the CSV-import
 * path) - required because transactions are now fetched via three independent per-category
 * requests (see fetchSchwabAccountActivity/getTransactions), and a single real-world Schwab
 * activity can legitimately surface under more than one category. Without merging first, two
 * identically-fingerprinted candidates reach classification/persistence separately: the first
 * inserts, the second collides on the (userId, provider, kind, fingerprint) unique constraint
 * and is counted as a duplicate - but only after already being counted as needing review too,
 * inflating that count past the number of rows actually inserted.
 */
export function buildSchwabRecordsToPersist(positions: BrokerPosition[], transactions: BrokerTransaction[], syncedAt: Date) {
  return mergeBrokerRecords([
    ...positions.map((position) => normalizeSchwabApiPosition(position, syncedAt)),
    ...transactions.map((transaction) => normalizeSchwabApiTransaction(transaction)),
  ]);
}

/**
 * Pulls real account value/cash from Schwab for the authenticated user only and records it as
 * a BROKER_SNAPSHOT ledger entry per linked account. Also pulls that account's current
 * positions and recent transactions and persists them as BrokerRecords (reusing the exact CSV
 * import dedupe scheme via persistNormalizedBrokerRecordsForUser - see broker-import.ts - so a
 * repeated sync can never write a duplicate row), which is what lets campaign reconciliation
 * (reconcileSchwabActivityForUser, called by the syncSchwabAccountAction caller with explicit
 * per-account evidence completeness) turn real Schwab activity into Tracker history automatically.
 * Never fabricates a value Schwab did not return, and never touches another user's accounts or
 * tokens. A positions/transactions fetch failure never fails the whole sync - the account
 * balance sync (this function's original promise) still succeeds; that account's campaign
 * synthetic expiration is deferred until complete evidence is available. Explicit broker
 * close/roll/assignment evidence can still be reconciled.
 */
export async function syncSchwabAccountForUser(userId: string): Promise<SchwabAccountSyncResult> {
  clearSchwabBrokerReadCacheForUser(userId);
  const provider = await getSchwabBrokerReadProviderForUser(userId, { bypassCache: true });
  if (!provider) {
    throw new ValidationError("Connect Schwab in Account settings before syncing.");
  }

  let brokerAccounts;
  try {
    brokerAccounts = await provider.getAccounts();
  } catch (error) {
    logSchwabSyncFailure("schwab_sync_accounts", userId, error);
    await recordSchwabAccountSyncResult(userId, { failureReason: "fetch_failed" });
    throw new ValidationError("Schwab did not return account data. Try again in a moment.");
  }

  if (!brokerAccounts.length) {
    await recordSchwabAccountSyncResult(userId, { failureReason: "no_accounts" });
    throw new ValidationError("Schwab did not report any linked accounts to sync.");
  }

  const syncedAt = new Date();
  const transactionsFrom = new Date(syncedAt.getTime() - SCHWAB_TRANSACTION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const accounts = [];
  const diagnostics: SchwabAccountSyncResult["diagnostics"] = {
    positionsReceived: 0,
    positionsSourceStatus: "OK",
    positionsErrorCode: null,
    transactionsReceived: 0,
    transactionsEvidenceStatus: "COMPLETE",
    tradeTransactionsReceived: 0,
    tradeSourceStatus: "OK",
    receiveAndDeliverReceived: 0,
    receiveAndDeliverSourceStatus: "OK",
    dividendOrInterestReceived: 0,
    dividendOrInterestSourceStatus: "OK",
    transactionsErrorCode: null,
    brokerRecordsInserted: 0,
    duplicatesSkipped: 0,
    recordsUnresolved: 0,
    feeKnownCount: 0,
    feeUnknownCount: 0,
    persistenceStatus: "OK",
    persistenceErrorCode: null,
  };

  for (const brokerAccount of brokerAccounts) {
    const tradingAccount = await prisma.tradingAccount.upsert({
      where: { userId_externalAccountId: { userId, externalAccountId: brokerAccount.id } },
      update: {
        name: brokerAccount.label,
      },
      create: {
        userId,
        name: brokerAccount.label,
        brokerName: "Schwab",
        accountType: "Brokerage",
        source: "SCHWAB",
        externalAccountId: brokerAccount.id,
        visibility: "PRIVATE",
      },
    });

    await prisma.accountLedgerEntry.create({
      data: {
        accountId: tradingAccount.id,
        type: "BROKER_SNAPSHOT",
        occurredAt: syncedAt,
        accountValue: brokerAccount.accountValue,
        cash: brokerAccount.cash,
        source: "SCHWAB",
      },
    });

    const activity = await fetchSchwabAccountActivity(provider, brokerAccount.id, transactionsFrom, syncedAt);

    diagnostics.positionsReceived += activity.positions.length;
    if (activity.positionsStatus === "ERROR") {
      diagnostics.positionsSourceStatus = "ERROR";
      diagnostics.positionsErrorCode = activity.positionsErrorCode;
    }
    diagnostics.transactionsReceived += activity.transactions.length;
    if (activity.transactionCategories) {
      diagnostics.tradeTransactionsReceived += categoryCount(activity.transactionCategories.TRADE);
      diagnostics.receiveAndDeliverReceived += categoryCount(activity.transactionCategories.RECEIVE_AND_DELIVER);
      diagnostics.dividendOrInterestReceived += categoryCount(activity.transactionCategories.DIVIDEND_OR_INTEREST);
      if (activity.transactionCategories.TRADE.status === "ERROR") {
        diagnostics.tradeSourceStatus = "ERROR";
      }
      if (activity.transactionCategories.RECEIVE_AND_DELIVER.status === "ERROR") {
        diagnostics.receiveAndDeliverSourceStatus = "ERROR";
      }
      if (activity.transactionCategories.DIVIDEND_OR_INTEREST.status === "ERROR") {
        diagnostics.dividendOrInterestSourceStatus = "ERROR";
      }
    } else {
      // Total transactions failure (every category rejected) - all three sources unavailable.
      diagnostics.tradeSourceStatus = "ERROR";
      diagnostics.receiveAndDeliverSourceStatus = "ERROR";
      diagnostics.dividendOrInterestSourceStatus = "ERROR";
      diagnostics.transactionsErrorCode = activity.transactionsErrorCode;
    }

    const records = buildSchwabRecordsToPersist(activity.positions, activity.transactions, syncedAt);
    if (records.length > 0) {
      try {
        const persisted = await persistNormalizedBrokerRecordsForUser(userId, tradingAccount.id, records);
        diagnostics.brokerRecordsInserted += persisted.inserted;
        diagnostics.duplicatesSkipped += persisted.duplicatesSkipped;
        diagnostics.recordsUnresolved += persisted.unresolved;
        diagnostics.feeKnownCount += persisted.feeKnownTransactions;
        diagnostics.feeUnknownCount += persisted.feeUnknownTransactions;
      } catch (error) {
        // Balance sync above already succeeded and is durable - a persistence hiccup just means
        // reconciliation catches up on the next successful sync, not a failed sync. Recorded (not
        // silent) so a real persistence failure is distinguishable from an honest 0 inserted.
        diagnostics.persistenceStatus = "ERROR";
        activity.evidence.persistenceStatus = "FAILED";
        diagnostics.persistenceErrorCode = categorizeSchwabSyncError(error);
        logSchwabSyncFailure("schwab_sync_persistence", userId, error);
      }
    }

    accounts.push({ id: tradingAccount.id, name: tradingAccount.name, accountValue: brokerAccount.accountValue, cash: brokerAccount.cash, evidence: activity.evidence });
  }

  diagnostics.transactionsEvidenceStatus = accounts.every((account) => account.evidence.transactions.status === "COMPLETE")
    ? "COMPLETE"
    : accounts.every((account) => account.evidence.transactions.status === "FAILED") ? "FAILED" : "PARTIAL";

  await recordSchwabAccountSyncResult(userId, { succeededAt: syncedAt });
  clearSchwabBrokerReadCacheForUser(userId);
  return { syncedAccounts: accounts.length, accounts, diagnostics };
}

export async function getSchwabOpenPositionsForUser(userId: string, options: { bypassCache?: boolean } = {}) {
  const provider = await getSchwabBrokerReadProviderForUser(userId, options);
  if (!provider) {
    return null;
  }

  try {
    const accounts = await provider.getAccounts();
    const positionsByAccount = await Promise.all(
      accounts.map(async (account) => ({
        account,
        positions: await provider.getPositions(account.id),
      })),
    );

    return positionsByAccount.flatMap(({ account, positions }) =>
      positions.map((position) => ({ ...position, accountLabel: account.label })),
    );
  } catch {
    return null;
  }
}

export async function addAccountLedgerEntryForUser(
  userId: string,
  accountId: string,
  typeInput: unknown,
  occurredAtInput: unknown,
  amountInput: unknown,
  notesInput: unknown,
) {
  const account = await prisma.tradingAccount.findFirst({ where: { id: accountId, userId } });
  if (!account) {
    throw new ValidationError("Choose one of your accounts.");
  }

  // Funding authority (Account Baseline & Funding Boundaries ticket): a Schwab account's funding
  // record of truth is its own imported broker-transfer activity, not a manually-typed number -
  // mixing both sources for the same account is exactly the ambiguity
  // summarizeAccountPerformance now has to detect and withhold gain/return for (see
  // fundingCoverageStatus, accountLedger.ts). This is based on the account's persisted `source`,
  // never live Schwab connection status, so it stays blocked even while temporarily disconnected.
  if (account.source === "SCHWAB") {
    throw new ValidationError("This account's funding is tracked from Schwab activity - manual deposits/withdrawals aren't available here.");
  }

  const type = String(typeInput ?? "").toUpperCase() as AccountLedgerEntryType;
  if (!MANUAL_LEDGER_ENTRY_TYPES.has(type)) {
    throw new ValidationError("Choose deposit, withdrawal, or adjustment.");
  }

  const occurredAt = parseDateInput(occurredAtInput, "date");
  // Deposits/withdrawals are always entered as a positive magnitude - the type itself
  // determines direction. An adjustment (a correction, not a cash flow) may go either way.
  const amount = type === "MANUAL_ADJUSTMENT" ? parseFiniteNumberOrThrow(amountInput, "amount") : parsePositiveNumber(amountInput, "amount");
  const notes = trimText(notesInput, 500);

  return prisma.accountLedgerEntry.create({
    data: {
      accountId: account.id,
      type,
      occurredAt,
      amount,
      source: "MANUAL",
      notes: notes || null,
    },
  });
}

/**
 * Account Baseline & Funding Boundaries: the missing workflow that lets ANY existing account
 * (manual or Schwab) receive a STARTING_VALUE - see PROJECT_HANDOFF.md's reconnaissance finding
 * that the GoalTracker's own "add a starting value in the Account ledger" message pointed at a
 * workflow that could not actually do this for any account. Never gated by account.source.
 *
 * Append-only: a correction NEVER updates or deletes the prior STARTING_VALUE row - it inserts a
 * new one. selectEffectiveBaseline (accountLedger.ts) alone decides which revision is effective
 * (by createdAt, never occurredAt), so every accounting consumer agrees automatically. The
 * replaced revision's id and the correction reason are recorded in `notes` (the existing field -
 * no new schema).
 *
 * Concurrency: the caller must pass `expectedRevisionId` - the id of the baseline revision it
 * last saw as effective (or the sentinel "" when it believes no baseline exists yet). Immediately
 * before writing, the current effective revision is re-selected inside the same transaction; a
 * mismatch means another correction was already recorded and this request is stale, so it is
 * rejected outright rather than silently appending a conflicting revision. This is the same level
 * of protection as Ticket 7's settings-revision guard (a re-check-then-write inside one
 * transaction) - it narrows the race window to the transaction's own duration, not eliminates it
 * under arbitrary concurrent load, which would need serializable isolation this ticket does not
 * add.
 */
export async function setAccountBaselineForUser(
  userId: string,
  accountId: string,
  nyDateInput: unknown,
  accountValueInput: unknown,
  reasonInput: unknown,
  expectedRevisionIdInput: unknown,
) {
  const account = await prisma.tradingAccount.findFirst({ where: { id: accountId, userId } });
  if (!account) {
    throw new ValidationError("Choose one of your accounts.");
  }

  const nyDate = String(nyDateInput ?? "").trim();
  let occurredAt: Date;
  try {
    occurredAt = endOfNyCalendarDateUtc(nyDate);
  } catch {
    throw new ValidationError("Enter a valid baseline date.");
  }
  // The baseline must represent the WHOLE account valuation at that instant, never cash alone -
  // see the ticket's explicit requirement; the input field itself is labeled accordingly.
  const accountValue = parseNonNegativeNumber(accountValueInput, "account value");
  const reason = trimText(reasonInput, 300);
  const expectedRevisionId = trimText(expectedRevisionIdInput, 200);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.accountLedgerEntry.findMany({
      where: { accountId, type: "STARTING_VALUE" },
      select: { id: true, occurredAt: true, createdAt: true, amount: true },
    });
    const currentEffective = selectEffectiveBaseline(
      existing.map((entry): AccountLedgerEntryInput => ({ id: entry.id, type: "STARTING_VALUE", occurredAt: entry.occurredAt, createdAt: entry.createdAt, amount: entry.amount })),
    );
    const currentEffectiveId = currentEffective?.entry.id ?? "";
    if (expectedRevisionId !== currentEffectiveId) {
      throw new ValidationError("This baseline was already updated elsewhere. Reload and try again.");
    }

    const notes = currentEffective
      ? `Replaces STARTING_VALUE ${currentEffective.entry.id}${reason ? ` - ${reason}` : ""}`
      : reason || null;

    return tx.accountLedgerEntry.create({
      data: {
        accountId,
        type: "STARTING_VALUE",
        occurredAt,
        amount: accountValue,
        source: "MANUAL",
        notes,
      },
    });
  });
}

export async function saveSchwabDeveloperCredentialsForUser(
  userId: string,
  clientIdInput: unknown,
  clientSecretInput: unknown,
  redirectUriInput: unknown,
) {
  try {
    return await saveSchwabDeveloperCredentialForUser(userId, clientIdInput, clientSecretInput, redirectUriInput);
  } catch (error) {
    if (error instanceof Error) {
      throw new ValidationError(error.message);
    }
    throw error;
  }
}

export async function removeSchwabDeveloperCredentialsForUser(userId: string) {
  return removeSchwabDeveloperCredentialForUser(userId);
}

export async function toggleTradingAccountVisibilityForUser(userId: string, accountId: string) {
  const account = await prisma.tradingAccount.findUnique({ where: { id: accountId } });
  if (!account) {
    return null;
  }

  assertCanMutateRecord(userId, account.userId);
  return prisma.tradingAccount.update({
    where: { id: account.id },
    data: { visibility: account.visibility === "PRIVATE" ? "SHARED" : "PRIVATE" },
  });
}

export async function createCampaignForUser(
  userId: string,
  accountId: string,
  tickerInput: unknown,
  tradeDateInput: unknown,
  expirationInput: unknown,
  strikeInput: unknown,
  contractsInput: unknown,
  premiumInput: unknown,
  feesInput: unknown,
  notesInput: unknown,
  visibilityInput: unknown,
) {
  const ticker = requireTicker(tickerInput);
  const account = await prisma.tradingAccount.findFirst({ where: { id: accountId, userId } });
  if (!account) {
    throw new ValidationError("Choose one of your accounts.");
  }

  const tradeDate = parseDateInput(tradeDateInput, "trade date");
  const expiration = parseDateInput(expirationInput, "expiration date");
  const strike = parsePositiveNumber(strikeInput, "strike");
  const contracts = parsePositiveInteger(contractsInput, "contracts");
  const premium = parseNonNegativeNumber(premiumInput, "premium");
  const fees = parseOptionalMoney(feesInput, "fees") ?? 0;
  const notes = trimText(notesInput, 1200);
  const visibility = parseRecordVisibility(visibilityInput, "INHERIT");
  const entrySnapshotJson = await latestScannerSnapshotForUser(userId, ticker);

  return prisma.campaign.create({
    data: {
      ownerId: userId,
      accountId: account.id,
      ticker,
      strategy: "CASH_SECURED_PUT",
      status: "OPEN",
      visibility,
      openedAt: tradeDate,
      thesis: notes || null,
      entrySnapshotJson: entrySnapshotJson ?? undefined,
      events: {
        create: {
          type: "SELL_PUT",
          occurredAt: tradeDate,
          sortOrder: 0,
          optionType: "PUT",
          contracts,
          strike,
          expiration,
          premium,
          fees,
          notes: notes || null,
        },
      },
    },
    include: campaignDetailInclude,
  });
}

export async function getReadableCampaignForUser(userId: string, campaignId: string) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: campaignDetailInclude,
  });

  if (!campaign) {
    return null;
  }

  assertCanReadInheritedRecord(userId, campaign.ownerId, campaign.visibility, campaign.account.visibility);
  return campaign;
}

export async function toggleCampaignVisibilityForUser(userId: string, campaignId: string) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { account: true },
  });

  if (!campaign) {
    return null;
  }

  assertCanMutateRecord(userId, campaign.ownerId);
  const effectiveVisibility = resolveInheritedVisibility(campaign.visibility, campaign.account.visibility);
  return prisma.campaign.update({
    where: { id: campaign.id },
    data: { visibility: effectiveVisibility === "PRIVATE" ? "SHARED" : "PRIVATE" },
  });
}

export async function closeCampaignPutForUser(
  userId: string,
  campaignId: string,
  occurredAtInput: unknown,
  premiumInput: unknown,
  feesInput: unknown,
  notesInput: unknown,
) {
  const campaign = await getOwnMutableCampaign(userId, campaignId);
  if (!campaign) {
    return null;
  }
  if (campaign.status !== "OPEN") {
    throw new ValidationError("Only an open put campaign can be closed this way.");
  }

  const activePut = latestPutLeg(campaign.events);
  if (!activePut) {
    throw new ValidationError("No open put leg was found for this campaign.");
  }

  const occurredAt = parseDateInput(occurredAtInput, "close date");
  const premium = parseNonNegativeNumber(premiumInput, "close premium");
  const fees = parseOptionalMoney(feesInput, "fees") ?? 0;
  const notes = trimText(notesInput, 700);

  await prisma.campaignEvent.create({
    data: {
      campaignId: campaign.id,
      type: "CLOSE_PUT",
      occurredAt,
      sortOrder: nextSortOrder(campaign.events),
      optionType: "PUT",
      contracts: activePut.contracts,
      strike: activePut.strike,
      expiration: activePut.expiration,
      premium,
      fees,
      notes: notes || null,
    },
  });

  return prisma.campaign.update({
    where: { id: campaign.id },
    data: { status: "CLOSED", closedAt: occurredAt },
    include: campaignDetailInclude,
  });
}

/**
 * Closes a campaign whose short put expired worthless - no BTC fill exists, and none should be
 * invented. The option's closing value is $0 by definition, so there is no premium input here;
 * realized P/L falls out of summarizeCampaign as opening premium minus fees, exactly the same
 * engine closeCampaignPutForUser feeds (see src/domain/finance/campaigns.ts).
 */
export async function expireCampaignPutForUser(
  userId: string,
  campaignId: string,
  occurredAtInput: unknown,
  feesInput: unknown,
  notesInput: unknown,
) {
  const campaign = await getOwnMutableCampaign(userId, campaignId);
  if (!campaign) {
    return null;
  }
  if (campaign.status === "CLOSED") return null; // A retry already applied this outcome.
  if (campaign.status !== "OPEN") {
    throw new ValidationError("Only an open put campaign can be marked expired.");
  }

  const activePut = latestPutLeg(campaign.events);
  if (!activePut) {
    throw new ValidationError("No open put leg was found for this campaign.");
  }

  const occurredAt = parseDateInput(occurredAtInput, "expiration date");
  const fees = parseOptionalMoney(feesInput, "fees") ?? 0;
  const notes = trimText(notesInput, 700);

  return prisma.$transaction(async (tx) => {
    // Claim this exact open campaign version atomically. A retry/concurrent sync cannot
    // append another expiration, and a changed campaign version is not closed by this read.
    const claimed = await tx.campaign.updateMany({
      where: { id: campaign.id, ownerId: userId, status: "OPEN", updatedAt: campaign.updatedAt },
      data: { status: "CLOSED", closedAt: occurredAt },
    });
    if (claimed.count !== 1) return null;
    await tx.campaignEvent.create({
      data: {
        campaignId: campaign.id,
        type: "PUT_EXPIRED",
        occurredAt,
        sortOrder: nextSortOrder(campaign.events),
        optionType: "PUT",
        contracts: activePut.contracts,
        strike: activePut.strike,
        expiration: activePut.expiration,
        premium: 0,
        fees,
        notes: notes || null,
      },
    });
    return tx.campaign.findUnique({ where: { id: campaign.id }, include: campaignDetailInclude });
  });
}

export async function rollCampaignPutForUser(
  userId: string,
  campaignId: string,
  occurredAtInput: unknown,
  closePremiumInput: unknown,
  newExpirationInput: unknown,
  newStrikeInput: unknown,
  newPremiumInput: unknown,
  feesInput: unknown,
  notesInput: unknown,
  /** Optional - the new leg's own fee, kept separate from `feesInput` (the close leg's fee) so
   * an automatic Schwab reconciliation can attribute each real transaction's own fee to its own
   * event. Omitted (manual roll entry, where only one combined fee is ever collected) defaults
   * to $0 on the new leg, exactly matching this function's original behavior. */
  newLegFeesInput: unknown = undefined,
) {
  const campaign = await getOwnMutableCampaign(userId, campaignId);
  if (!campaign) {
    return null;
  }
  if (campaign.status !== "OPEN") {
    throw new ValidationError("Only an open put campaign can be rolled.");
  }

  const activePut = latestPutLeg(campaign.events);
  if (!activePut) {
    throw new ValidationError("No open put leg was found for this campaign.");
  }

  const occurredAt = parseDateInput(occurredAtInput, "roll date");
  const closePremium = parseNonNegativeNumber(closePremiumInput, "close premium");
  const newExpiration = parseDateInput(newExpirationInput, "new expiration date");
  const newStrike = parsePositiveNumber(newStrikeInput, "new strike");
  const newPremium = parseNonNegativeNumber(newPremiumInput, "new premium");
  const fees = parseOptionalMoney(feesInput, "fees") ?? 0;
  const newLegFees = parseOptionalMoney(newLegFeesInput, "new leg fees") ?? 0;
  const notes = trimText(notesInput, 700);
  const groupKey = `roll-${randomUUID()}`;
  const baseSortOrder = nextSortOrder(campaign.events);

  await prisma.campaignEvent.createMany({
    data: [
      {
        campaignId: campaign.id,
        type: "ROLL_PUT_CLOSE",
        occurredAt,
        sortOrder: baseSortOrder,
        groupKey,
        optionType: "PUT",
        contracts: activePut.contracts,
        strike: activePut.strike,
        expiration: activePut.expiration,
        premium: closePremium,
        fees,
        notes: notes || null,
      },
      {
        campaignId: campaign.id,
        type: "ROLL_PUT_OPEN",
        occurredAt,
        sortOrder: baseSortOrder + 1,
        groupKey,
        optionType: "PUT",
        contracts: activePut.contracts,
        strike: newStrike,
        expiration: newExpiration,
        premium: newPremium,
        fees: newLegFees,
        notes: notes || null,
      },
    ],
  });

  return prisma.campaign.update({
    where: { id: campaign.id },
    data: { status: "OPEN", closedAt: null },
    include: campaignDetailInclude,
  });
}

export async function assignCampaignPutForUser(
  userId: string,
  campaignId: string,
  occurredAtInput: unknown,
  sharesInput: unknown,
  feesInput: unknown,
  notesInput: unknown,
) {
  const campaign = await getOwnMutableCampaign(userId, campaignId);
  if (!campaign) {
    return null;
  }
  if (campaign.status !== "OPEN") {
    throw new ValidationError("Only an open put campaign can be assigned.");
  }

  const activePut = latestPutLeg(campaign.events);
  if (!activePut) {
    throw new ValidationError("No open put leg was found for this campaign.");
  }

  const occurredAt = parseDateInput(occurredAtInput, "assignment date");
  const shares = parseOptionalPositiveInteger(sharesInput, "shares") ?? activePut.contracts * 100;
  const fees = parseOptionalMoney(feesInput, "fees") ?? 0;
  const notes = trimText(notesInput, 700);

  await prisma.campaignEvent.create({
    data: {
      campaignId: campaign.id,
      type: "ASSIGNMENT",
      occurredAt,
      sortOrder: nextSortOrder(campaign.events),
      optionType: "PUT",
      contracts: activePut.contracts,
      shares,
      strike: activePut.strike,
      expiration: activePut.expiration,
      fees,
      notes: notes || null,
    },
  });

  return prisma.campaign.update({
    where: { id: campaign.id },
    data: { status: "ASSIGNED", strategy: "WHEEL" },
    include: campaignDetailInclude,
  });
}

/**
 * Manually records a covered call sold against already-assigned shares - this is the safest
 * useful next slice on top of assignment (see PROJECT_HANDOFF.md's Covered Call Foundation
 * phase): the accounting engine (summarizeCampaign) already nets covered-call premium into
 * adjustedBasis/realizedPL, so this function only needs to append a well-formed
 * SELL_COVERED_CALL event and enforce that it describes a trade that's actually possible against
 * the shares this campaign holds. OSO never places or previews broker orders - this only records
 * a covered call the user already sold in their brokerage.
 */
export async function sellCoveredCallForUser(
  userId: string,
  campaignId: string,
  occurredAtInput: unknown,
  expirationInput: unknown,
  strikeInput: unknown,
  contractsInput: unknown,
  premiumInput: unknown,
  feesInput: unknown,
  notesInput: unknown,
) {
  const campaign = await getOwnMutableCampaign(userId, campaignId);
  if (!campaign) {
    return null;
  }
  if (campaign.status !== "ASSIGNED") {
    throw new ValidationError("Only a campaign holding assigned shares can sell a covered call.");
  }
  if (getCurrentOpenCall(campaign.events)) {
    throw new ValidationError("Close or mark the current covered call expired before selling another.");
  }

  const summary = summarizeCampaign({ status: campaign.status, events: campaign.events });
  const maxContracts = Math.floor(summary.sharesHeld / 100);
  if (maxContracts <= 0) {
    throw new ValidationError("No shares are held to cover a covered call.");
  }

  const contracts = parsePositiveInteger(contractsInput, "contracts");
  if (contracts > maxContracts) {
    throw new ValidationError(
      `${summary.sharesHeld} shares held supports at most ${maxContracts} covered call ${maxContracts === 1 ? "contract" : "contracts"}.`,
    );
  }

  const occurredAt = parseDateInput(occurredAtInput, "sale date");
  const expiration = parseDateInput(expirationInput, "expiration date");
  const strike = parsePositiveNumber(strikeInput, "strike");
  const premium = parseNonNegativeNumber(premiumInput, "premium");
  const fees = parseOptionalMoney(feesInput, "fees") ?? 0;
  const notes = trimText(notesInput, 700);

  await prisma.campaignEvent.create({
    data: {
      campaignId: campaign.id,
      type: "SELL_COVERED_CALL",
      occurredAt,
      sortOrder: nextSortOrder(campaign.events),
      optionType: "CALL",
      contracts,
      strike,
      expiration,
      premium,
      fees,
      notes: notes || null,
    },
  });

  return prisma.campaign.findUnique({ where: { id: campaign.id }, include: campaignDetailInclude });
}

/**
 * Records buying back an open covered call - always the full open leg, exactly like
 * closeCampaignPutForUser does for puts (no partial-close quantity input). The campaign stays
 * ASSIGNED: closing a call never closes the campaign by itself, shares are still held either way.
 */
export async function closeCoveredCallForUser(
  userId: string,
  campaignId: string,
  occurredAtInput: unknown,
  premiumInput: unknown,
  feesInput: unknown,
  notesInput: unknown,
) {
  const campaign = await getOwnMutableCampaign(userId, campaignId);
  if (!campaign) {
    return null;
  }
  if (campaign.status !== "ASSIGNED") {
    throw new ValidationError("Only an assigned-stock campaign can close a covered call.");
  }

  const openCall = getCurrentOpenCall(campaign.events);
  if (!openCall) {
    throw new ValidationError("No open covered call was found for this campaign.");
  }

  const occurredAt = parseDateInput(occurredAtInput, "close date");
  const premium = parseNonNegativeNumber(premiumInput, "close premium");
  const fees = parseOptionalMoney(feesInput, "fees") ?? 0;
  const notes = trimText(notesInput, 700);

  await prisma.campaignEvent.create({
    data: {
      campaignId: campaign.id,
      type: "CLOSE_COVERED_CALL",
      occurredAt,
      sortOrder: nextSortOrder(campaign.events),
      optionType: "CALL",
      contracts: openCall.contracts,
      strike: openCall.strike,
      expiration: openCall.expiration,
      premium,
      fees,
      notes: notes || null,
    },
  });

  return prisma.campaign.findUnique({ where: { id: campaign.id }, include: campaignDetailInclude });
}

/**
 * Manually marks an open covered call expired worthless - no BTC fill exists, so (like
 * expireCampaignPutForUser) there is no premium input; the collected premium simply stays part of
 * the campaign's cash flow. Unlike put expiry (which is Schwab-reconciliation-only in this phase),
 * this is a deliberate manual action a user can take from the Tracker, gated on the call's own
 * expiration date having actually passed - never inferred from Schwab, never a fabricated debit.
 */
export async function expireCoveredCallForUser(
  userId: string,
  campaignId: string,
  occurredAtInput: unknown,
  feesInput: unknown,
  notesInput: unknown,
) {
  const campaign = await getOwnMutableCampaign(userId, campaignId);
  if (!campaign) {
    return null;
  }
  if (campaign.status !== "ASSIGNED") {
    throw new ValidationError("Only an assigned-stock campaign can mark a covered call expired.");
  }

  const openCall = getCurrentOpenCall(campaign.events);
  if (!openCall) {
    throw new ValidationError("No open covered call was found for this campaign.");
  }

  const occurredAt = parseDateInput(occurredAtInput, "expiration date");
  if (!isPastExpiration(openCall.expiration, occurredAt)) {
    throw new ValidationError("This covered call has not reached its expiration date yet.");
  }
  const fees = parseOptionalMoney(feesInput, "fees") ?? 0;
  const notes = trimText(notesInput, 700);

  await prisma.campaignEvent.create({
    data: {
      campaignId: campaign.id,
      type: "COVERED_CALL_EXPIRED",
      occurredAt,
      sortOrder: nextSortOrder(campaign.events),
      optionType: "CALL",
      contracts: openCall.contracts,
      strike: openCall.strike,
      expiration: openCall.expiration,
      premium: 0,
      fees,
      notes: notes || null,
    },
  });

  return prisma.campaign.findUnique({ where: { id: campaign.id }, include: campaignDetailInclude });
}

/**
 * Records a manual stock sale on assigned shares. Supports a partial sale - summarizeCampaign's
 * existing proportional-cost-basis allocation already realizes P/L correctly for that (see
 * PROJECT_HANDOFF.md's Account Ledger / Performance Methodology section) - so no new P/L math is
 * introduced here. CRITICAL: never allows a sale that would leave an open covered call without
 * enough remaining shares to cover it (e.g. 200 shares + 1 call over 100 shares allows selling up
 * to 100, never all 200) - getCurrentOpenCall's full-history reduction means this check is
 * correct even though the call was opened before this sale. The campaign only closes once every
 * share is gone AND no call obligation remains open - never merely because a call closed/expired
 * or because of a partial sale.
 */
export async function sellStockForUser(
  userId: string,
  campaignId: string,
  occurredAtInput: unknown,
  sharesInput: unknown,
  priceInput: unknown,
  feesInput: unknown,
  notesInput: unknown,
) {
  const campaign = await getOwnMutableCampaign(userId, campaignId);
  if (!campaign) {
    return null;
  }
  if (campaign.status !== "ASSIGNED") {
    throw new ValidationError("Only a campaign holding assigned shares can record a stock sale.");
  }

  const summary = summarizeCampaign({ status: campaign.status, events: campaign.events });
  if (summary.sharesHeld <= 0) {
    throw new ValidationError("No shares are held to sell.");
  }

  const shares = parsePositiveInteger(sharesInput, "shares");
  if (shares > summary.sharesHeld) {
    throw new ValidationError(`Only ${summary.sharesHeld} shares are held.`);
  }

  const openCall = getCurrentOpenCall(campaign.events);
  const requiredCoverageShares = openCall ? openCall.contracts * 100 : 0;
  const sharesRemainingAfterSale = summary.sharesHeld - shares;
  if (sharesRemainingAfterSale < requiredCoverageShares) {
    throw new ValidationError(
      `Selling ${shares} shares would leave only ${sharesRemainingAfterSale}, but the open covered call needs ${requiredCoverageShares} shares of coverage. Close or let it expire first, or sell fewer shares.`,
    );
  }

  const occurredAt = parseDateInput(occurredAtInput, "sale date");
  const price = parsePositiveNumber(priceInput, "sale price");
  const fees = parseOptionalMoney(feesInput, "fees") ?? 0;
  const notes = trimText(notesInput, 700);

  await prisma.campaignEvent.create({
    data: {
      campaignId: campaign.id,
      type: "STOCK_SALE",
      occurredAt,
      sortOrder: nextSortOrder(campaign.events),
      shares,
      underlyingPrice: price,
      fees,
      notes: notes || null,
    },
  });

  if (sharesRemainingAfterSale === 0 && !openCall) {
    return prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: "CLOSED", closedAt: occurredAt },
      include: campaignDetailInclude,
    });
  }

  return prisma.campaign.findUnique({ where: { id: campaign.id }, include: campaignDetailInclude });
}

async function ensureOwnWatchlist(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return (
    (await prisma.watchlist.findFirst({ where: { ownerId: user.id } })) ??
    (await prisma.watchlist.create({
      data: {
        ownerId: user.id,
        name: `${user.name}'s LST`,
        visibility: "SHARED",
      },
    }))
  );
}

/**
 * Manual "add a ticker" entry point (the Research page's plain textbox) - defaults to WATCH.
 * Kept as its own name/signature since `addWatchlistItemAction` already calls it; the actual
 * upsert now lives in `setResearchStatusForUser` so Scanner quick actions share the same path.
 */
export async function createWatchlistItemForUser(userId: string, tickerInput: unknown) {
  return setResearchStatusForUser(userId, tickerInput, "WATCH");
}

/**
 * The one-click Research/Watch/Exclude path from both the Scanner and the Research page.
 * Research is PRIVATE BY DEFAULT (see PROJECT_HANDOFF.md) - a brand-new item is created
 * PRIVATE regardless of status, and no Activity is posted, since even the bare fact that a
 * user watched/liked/excluded a ticker is itself a piece of personal sentiment that belongs
 * to the user unless they explicitly share the item (via toggleWatchlistItemVisibilityForUser).
 */
export async function setResearchStatusForUser(userId: string, tickerInput: unknown, statusInput: unknown) {
  const ticker = requireTicker(tickerInput);
  const status = String(statusInput ?? "") as ResearchStatus;
  if (!RESEARCH_STATUSES.has(status)) {
    throw new ValidationError("Invalid research status.");
  }

  const watchlist = await ensureOwnWatchlist(userId);
  return prisma.watchlistItem.upsert({
    where: { watchlistId_ticker: { watchlistId: watchlist.id, ticker } },
    update: { researchStatus: status },
    create: {
      watchlistId: watchlist.id,
      ownerId: userId,
      ticker,
      researchStatus: status,
      visibility: "PRIVATE",
      tags: [],
    },
  });
}

/**
 * The full Research detail form: manual company description, fundamentals-adjacent manual
 * grades, would-own/monthly-only/roll-friendliness personal rules, and an exclusion reason.
 * Never touches researchStatus itself (that's setResearchStatusForUser's job) so a quick
 * one-click status change from the Scanner never silently blows away a saved detail form.
 */
export async function updateResearchDetailsForUser(userId: string, itemId: string, formData: FormData) {
  const item = await prisma.watchlistItem.findUnique({ where: { id: itemId } });
  if (!item) {
    return null;
  }
  assertCanMutateRecord(userId, item.ownerId);

  const wouldOwnRaw = String(formData.get("wouldOwn") ?? "");
  const wouldOwn = WOULD_OWN_STATUSES.has(wouldOwnRaw as WouldOwnStatus) ? (wouldOwnRaw as WouldOwnStatus) : null;
  const rollFriendlinessRaw = String(formData.get("rollFriendliness") ?? "UNKNOWN");
  const rollFriendliness = ROLL_FRIENDLINESS_VALUES.has(rollFriendlinessRaw as RollFriendliness)
    ? (rollFriendlinessRaw as RollFriendliness)
    : "UNKNOWN";
  const lsegRecommendationRaw = String(formData.get("manualLsegRecommendation") ?? "UNKNOWN");
  const manualLsegRecommendation = LSEG_RECOMMENDATIONS.has(lsegRecommendationRaw as LsegRecommendation)
    ? (lsegRecommendationRaw as LsegRecommendation)
    : "UNKNOWN";
  const profitabilityRaw = String(formData.get("profitability") ?? "UNKNOWN");
  const profitability = PROFITABILITY_ASSESSMENTS.has(profitabilityRaw as ProfitabilityAssessment)
    ? (profitabilityRaw as ProfitabilityAssessment)
    : "UNKNOWN";
  const paysDividendRaw = String(formData.get("paysDividend") ?? "");
  const paysDividend = paysDividendRaw === "YES" ? true : paysDividendRaw === "NO" ? false : null;

  return prisma.watchlistItem.update({
    where: { id: item.id },
    data: {
      companyName: trimText(formData.get("companyName"), 200) || null,
      whatItDoes: trimText(formData.get("whatItDoes"), 1200) || null,
      wouldOwn,
      wouldOwnMaxPrice:
        wouldOwn === "CONDITIONAL" ? parseOptionalMoney(formData.get("wouldOwnMaxPrice"), "maximum ownership price") : null,
      monthlyPutsOnly: formData.get("monthlyPutsOnly") === "on",
      rollFriendliness,
      rollFriendlinessNote: trimText(formData.get("rollFriendlinessNote"), 500) || null,
      exclusionReason: trimText(formData.get("exclusionReason"), 500) || null,
      manualSchwabGrade: trimText(formData.get("manualSchwabGrade"), 50) || null,
      manualLsegRating: trimText(formData.get("manualLsegRating"), 50) || null,
      manualLsegScore: trimText(formData.get("manualLsegScore"), 50) || null,
      manualLsegTarget: trimText(formData.get("manualLsegTarget"), 50) || null,
      manualLsegRecommendation,
      manualPeRatio: parseOptionalDecimal(formData.get("manualPeRatio"), "P/E"),
      manualPegRatio: parseOptionalDecimal(formData.get("manualPegRatio"), "PEG"),
      manualDebtToEquity: parseOptionalDecimal(formData.get("manualDebtToEquity"), "debt/equity ratio"),
      manualCurrentRatio: parseOptionalDecimal(formData.get("manualCurrentRatio"), "current ratio"),
      paysDividend,
      manualDividendYield: parseOptionalDecimal(formData.get("manualDividendYield"), "dividend yield"),
      manualDividendAmount: parseOptionalDecimal(formData.get("manualDividendAmount"), "dividend amount"),
      profitability,
      profitabilityNote: trimText(formData.get("profitabilityNote"), 500) || null,
    },
  });
}

/**
 * Per-user Research table view preference (visible/hidden columns, their order, and the
 * active sort key). Entirely scoped to `userId` via the UserSettings upsert key - one
 * user's Columns choice can never write to another user's row.
 */
export async function updateResearchColumnsForUser(userId: string, columnsInput: unknown, sortKeyInput: unknown) {
  const columns = sanitizeResearchColumns(columnsInput);
  const sortKey = isResearchSortKey(sortKeyInput) ? sortKeyInput : null;

  await prisma.userSettings.upsert({
    where: { userId },
    update: { researchColumns: columns, researchSortKey: sortKey },
    create: { userId, researchColumns: columns, researchSortKey: sortKey },
  });

  return { columns, sortKey };
}

export const MIN_ROLL_BUFFER_PERCENT = 0.1;
export const MAX_ROLL_BUFFER_PERCENT = 25;

/**
 * Per-user Roll Buffer % - an OSO decision-support preference (explicitly NOT a confirmed
 * proprietary LST numeric rule) controlling the width of the amber "near strike" zone on the
 * Roll Status badge (see src/domain/finance/rollStatus.ts). Entirely scoped to `userId` via the
 * UserSettings upsert key - Matt and Eric may each choose a different threshold, and one user's
 * change can never affect the other's row.
 */
export async function updateRollBufferPercentForUser(userId: string, rollBufferPercentInput: unknown) {
  const parsed = Number(rollBufferPercentInput);
  if (!Number.isFinite(parsed) || parsed < MIN_ROLL_BUFFER_PERCENT || parsed > MAX_ROLL_BUFFER_PERCENT) {
    throw new ValidationError(`Roll Buffer must be between ${MIN_ROLL_BUFFER_PERCENT}% and ${MAX_ROLL_BUFFER_PERCENT}%.`);
  }
  const rollBufferPercent = Math.round(parsed * 100) / 100;

  await prisma.userSettings.upsert({
    where: { userId },
    update: { rollBufferPercent },
    create: { userId, rollBufferPercent },
  });

  return { rollBufferPercent };
}

/**
 * Tickers this user has actively researched (LIKE/WATCH/NEUTRAL - i.e. not AVOID/NEVER_TRADE)
 * so the live Schwab scanner's universe can include previously-researched names, not just the
 * fixed discovery starter list. See PROJECT_HANDOFF.md Research section: this is additive
 * union, not a replacement for the discovery universe.
 */
/**
 * Tier 1 of the scanner's universe (see docs/SCANNER_RULES.md "Broad scanner universe"):
 * private, user-scoped tickers ALWAYS included in this user's own live scan regardless of the
 * broader public universe - their own Research (excluding AVOID/NEVER_TRADE, which a user has
 * explicitly ruled out) plus every ticker they have ever traded (any of their own Campaigns,
 * any status). Never another user's Research/Watchlist/campaigns - always scoped to `userId`.
 */
export async function getResearchUniverseTickersForUser(userId: string): Promise<string[]> {
  const [items, campaigns] = await Promise.all([
    prisma.watchlistItem.findMany({
      where: { ownerId: userId, researchStatus: { in: ["LIKE", "WATCH", "NEUTRAL"] } },
      select: { ticker: true },
    }),
    prisma.campaign.findMany({ where: { ownerId: userId }, select: { ticker: true }, distinct: ["ticker"] }),
  ]);
  return [...new Set([...items.map((item) => item.ticker), ...campaigns.map((campaign) => campaign.ticker)])];
}

export async function getReadableWatchlistItemForUser(userId: string, itemId: string) {
  const item = await prisma.watchlistItem.findUnique({ where: { id: itemId } });
  if (!item) {
    return null;
  }

  assertCanReadRecord(userId, item.ownerId, item.visibility);
  return item;
}

export async function removeWatchlistItemForUser(userId: string, itemId: string) {
  const item = await prisma.watchlistItem.findUnique({ where: { id: itemId } });
  if (!item) {
    return null;
  }

  assertCanMutateRecord(userId, item.ownerId);
  return prisma.watchlistItem.delete({ where: { id: item.id } });
}

export async function toggleWatchlistItemVisibilityForUser(userId: string, itemId: string) {
  const item = await prisma.watchlistItem.findUnique({ where: { id: itemId } });
  if (!item) {
    return null;
  }

  assertCanMutateRecord(userId, item.ownerId);
  return prisma.watchlistItem.update({
    where: { id: item.id },
    data: {
      visibility: item.visibility === "PRIVATE" ? "SHARED" : "PRIVATE",
    },
  });
}

export async function saveStockNoteForUser(userId: string, itemId: string, categoryInput: unknown, bodyInput: unknown) {
  const category = String(categoryInput ?? "GENERAL") as NoteCategory;
  const body = trimText(bodyInput, 1200);
  const item = await prisma.watchlistItem.findUnique({ where: { id: itemId } });

  if (!item || !NOTE_CATEGORIES.has(category)) {
    return null;
  }

  assertCanMutateRecord(userId, item.ownerId);

  await prisma.stockNote.deleteMany({
    where: {
      ownerId: userId,
      watchlistItemId: item.id,
      category,
    },
  });

  if (!body) {
    return null;
  }

  return prisma.stockNote.create({
    data: {
      ownerId: userId,
      watchlistItemId: item.id,
      ticker: item.ticker,
      category,
      body,
      visibility: item.visibility,
    },
  });
}

export async function addWatchlistCommentForUser(userId: string, itemId: string, bodyInput: unknown) {
  const body = trimText(bodyInput, 700);
  const item = await prisma.watchlistItem.findUnique({
    where: { id: itemId },
    include: { owner: true },
  });

  if (!item || !body) {
    return null;
  }

  assertCanReadRecord(userId, item.ownerId, item.visibility);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const comment = await prisma.comment.create({
    data: {
      authorId: user.id,
      watchlistItemId: item.id,
      ticker: item.ticker,
      body,
      visibility: "SHARED",
    },
  });

  if (item.ownerId !== user.id) {
    await notifyInApp({
      recipientId: item.ownerId,
      actorId: user.id,
      type: "COMMENT",
      title: `${user.name} commented on ${item.ticker}`,
      body,
      href: "/watchlist",
    });
  }

  return comment;
}

export async function createRecommendationForUser(
  userId: string,
  tickerInput: unknown,
  recipientId: string,
  messageInput: unknown,
  reasonTagInputs: unknown[],
) {
  const ticker = requireTicker(tickerInput);
  const message = trimText(messageInput, 500) || `Take a look at ${ticker}.`;
  const tags = normalizeReasonTags(reasonTagInputs);

  if (!recipientId || recipientId === userId) {
    throw new ValidationError("Choose a buddy recipient.");
  }

  const [sender, recipient] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    prisma.user.findUnique({ where: { id: recipientId } }),
  ]);

  if (!recipient) {
    throw new ValidationError("Choose a valid buddy recipient.");
  }

  const recommendation = await prisma.recommendation.create({
    data: {
      senderId: sender.id,
      recipientId: recipient.id,
      ticker,
      message,
      reasonTags: tags.length ? tags : ["Worth researching"],
      visibility: "SHARED",
    },
  });

  await prisma.activity.create({
    data: {
      actorId: sender.id,
      type: "RECOMMENDATION",
      title: `${sender.name} recommended ${ticker}`,
      body: message,
      ticker,
      visibility: "SHARED",
    },
  });

  await notifyInApp({
    recipientId: recipient.id,
    actorId: sender.id,
    type: "RECOMMENDATION",
    title: `${sender.name} recommended ${ticker}`,
    body: message,
    href: "/recommendations",
  });

  await postRecommendationChatEcho(sender, recipient.id, ticker, message, recommendation.reasonTags);

  return recommendation;
}

/**
 * Best-effort structured echo of a new recommendation into the sender/recipient's shared Buddy
 * Chat conversation - Chat is now the primary human-to-human communication surface, so the
 * recipient sees "recommended KGC" directly in Chat (with the same ticker-badge treatment as any
 * other ticker-tagged message) instead of needing a separate Recommendations-inbox visit.
 *
 * Never throws: a missing shared conversation (there is exactly one per Matt/Eric pair today, but
 * this must degrade gracefully rather than fail recommendation creation itself if that ever
 * changes) just means no echo is posted. The Recommendation row - ticker, tags, status workflow,
 * threaded comments/reactions - remains the durable structured record; this is only a visibility
 * echo of it, not a replacement, so nothing here changes what's actually stored.
 */
async function postRecommendationChatEcho(sender: { id: string; name: string }, recipientId: string, ticker: string, message: string, tags: string[]) {
  const conversation = await prisma.conversation.findFirst({
    where: {
      AND: [{ members: { some: { userId: sender.id } } }, { members: { some: { userId: recipientId } } }],
    },
    select: { id: true },
  });
  if (!conversation) {
    return;
  }

  const body = [`Recommended ${ticker} — ${message}`, tags.length ? `Tags: ${tags.join(", ")}` : null]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  await prisma.chatMessage.create({
    data: {
      conversationId: conversation.id,
      senderId: sender.id,
      body,
      ticker,
      reads: { create: { userId: sender.id } },
    },
  });
}

export async function updateRecommendationStatusForUser(
  userId: string,
  recommendationId: string,
  statusInput: unknown,
) {
  const status = String(statusInput ?? "NEW");
  if (!isRecommendationStatus(status)) {
    throw new ValidationError("Choose a valid recommendation status.");
  }

  const recommendation = await prisma.recommendation.findUnique({ where: { id: recommendationId } });
  if (!recommendation) {
    return null;
  }

  assertCanMutateRecord(userId, recommendation.recipientId);
  return prisma.recommendation.update({
    where: { id: recommendation.id },
    data: { status: status as RecommendationStatus },
  });
}

export async function addRecommendationCommentForUser(userId: string, recommendationId: string, bodyInput: unknown) {
  const body = trimText(bodyInput, 700);
  const recommendation = await prisma.recommendation.findUnique({
    where: { id: recommendationId },
    include: { sender: true, recipient: true },
  });

  if (!recommendation || !body) {
    return null;
  }

  const isParticipant = [recommendation.senderId, recommendation.recipientId].includes(userId);
  if (!isParticipant) {
    throw new ValidationError("Only recommendation participants can comment.");
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const comment = await prisma.comment.create({
    data: {
      authorId: user.id,
      recommendationId: recommendation.id,
      ticker: recommendation.ticker,
      body,
      visibility: "SHARED",
    },
  });

  const notifyRecipientId = user.id === recommendation.senderId ? recommendation.recipientId : recommendation.senderId;
  await notifyInApp({
    recipientId: notifyRecipientId,
    actorId: user.id,
    type: "COMMENT",
    title: `${user.name} commented on ${recommendation.ticker}`,
    body,
    href: "/recommendations",
  });

  return comment;
}

export async function addReactionForUser(userId: string, targetType: ReactionTargetType, targetId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const data: {
    watchlistItemId?: string;
    recommendationId?: string;
    commentId?: string;
    tradeId?: string;
    activityId?: string;
  } = {};
  let notificationTarget: { ownerId?: string; ticker?: string; href: string } | null = null;

  if (targetType === "WATCHLIST_ITEM") {
    const item = await prisma.watchlistItem.findUnique({ where: { id: targetId } });
    if (!item) return null;
    assertCanReadRecord(user.id, item.ownerId, item.visibility);
    data.watchlistItemId = item.id;
    notificationTarget = { ownerId: item.ownerId, ticker: item.ticker, href: "/watchlist" };
  }

  if (targetType === "RECOMMENDATION") {
    const recommendation = await prisma.recommendation.findUnique({ where: { id: targetId } });
    if (!recommendation) return null;
    const isParticipant = [recommendation.senderId, recommendation.recipientId].includes(user.id);
    if (!isParticipant) {
      throw new ValidationError("Only recommendation participants can react.");
    }
    data.recommendationId = recommendation.id;
    notificationTarget = {
      ownerId: user.id === recommendation.senderId ? recommendation.recipientId : recommendation.senderId,
      ticker: recommendation.ticker,
      href: "/recommendations",
    };
  }

  if (targetType === "COMMENT") {
    const comment = await prisma.comment.findUnique({ where: { id: targetId } });
    if (!comment) return null;
    assertCanReadRecord(user.id, comment.authorId, comment.visibility);
    data.commentId = comment.id;
    notificationTarget = { ownerId: comment.authorId, ticker: comment.ticker ?? undefined, href: "/recommendations" };
  }

  if (targetType === "TRADE") {
    const trade = await prisma.trade.findUnique({ where: { id: targetId } });
    if (!trade) return null;
    assertCanReadRecord(user.id, trade.userId, trade.visibility);
    data.tradeId = trade.id;
    notificationTarget = { ownerId: trade.userId, ticker: trade.symbol, href: "/positions" };
  }

  if (targetType === "ACTIVITY") {
    const activity = await prisma.activity.findUnique({ where: { id: targetId } });
    if (!activity) return null;
    assertCanReadRecord(user.id, activity.actorId, activity.visibility);
    data.activityId = activity.id;
    notificationTarget = { ownerId: activity.actorId, ticker: activity.ticker ?? undefined, href: "/dashboard" };
  }

  const reaction = await prisma.reaction.create({
    data: {
      actorId: user.id,
      kind: "ATTA_BOY",
      targetType,
      ...data,
    },
  });

  if (notificationTarget?.ownerId && notificationTarget.ownerId !== user.id) {
    await notifyInApp({
      recipientId: notificationTarget.ownerId,
      actorId: user.id,
      type: "REACTION",
      title: `${user.name} sent an Atta Boy`,
      body: notificationTarget.ticker ? `On ${notificationTarget.ticker}` : "Nice discipline.",
      href: notificationTarget.href,
    });
  }

  return reaction;
}

export async function sendChatMessageForUser(
  userId: string,
  conversationId: string,
  bodyInput: unknown,
  tickerInput?: unknown,
  attachmentInputs: FormDataEntryValue[] = [],
) {
  const body = trimText(bodyInput, 1200);
  const ticker = tickerInput ? requireTicker(tickerInput) : null;
  const hasAttachmentInput = attachmentInputs.some((entry) => entry instanceof File && entry.size > 0);

  if (!conversationId || (!body && !hasAttachmentInput)) {
    return null;
  }

  const conversation = await prisma.conversation.findFirst({
    where: {
      id: conversationId,
      members: { some: { userId } },
    },
    include: { members: true },
  });

  if (!conversation) {
    throw new ValidationError("You are not a member of that conversation.");
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const preparedAttachments = await prepareChatImageAttachments(conversation.id, attachmentInputs);
  let uploadedAttachments: PreparedChatAttachment[] = [];
  let message: Awaited<ReturnType<typeof prisma.chatMessage.create>> | null = null;

  try {
    uploadedAttachments = await uploadChatAttachments(preparedAttachments);
    message = await prisma.chatMessage.create({
      data: {
        conversationId,
        senderId: user.id,
        body,
        ticker,
        attachments: {
          create: uploadedAttachments.map((attachment) => ({
            storageBucket: attachment.storageBucket,
            storageKey: attachment.storageKey,
            mimeType: attachment.mimeType,
            originalFileName: attachment.originalFileName,
            byteSize: attachment.byteSize,
            width: attachment.width,
            height: attachment.height,
          })),
        },
        reads: {
          create: {
            userId: user.id,
          },
        },
      },
      include: { attachments: true },
    });
  } catch (error) {
    if (uploadedAttachments.length) {
      await removeUploadedChatAttachments(uploadedAttachments);
    }
    throw error;
  }

  if (!message) {
    throw new ValidationError("Message could not be sent.");
  }
  const messageHref = `/chat#message-${message.id}`;

  await prisma.conversationMember.update({
    where: {
      conversationId_userId: {
        conversationId,
        userId: user.id,
      },
    },
    data: { lastReadAt: new Date() },
  });

  await Promise.all(
    conversation.members
      .filter((member) => member.userId !== user.id)
      .map((member) =>
        notifyInApp({
          recipientId: member.userId,
          actorId: user.id,
          type: "MESSAGE",
          title: `${user.name} sent you a message`,
          body: body || (uploadedAttachments.length === 1 ? "Sent an image." : `Sent ${uploadedAttachments.length} images.`),
          href: messageHref,
        }),
      ),
  );

  return message;
}

export async function markConversationReadForUser(userId: string, conversationId: string) {
  const readAt = new Date();
  await prisma.$transaction(async (tx) => {
    const conversation = await tx.conversation.findFirst({
      where: { id: conversationId, members: { some: { userId } } },
      select: { id: true },
    });

    if (!conversation) {
      throw new ValidationError("You are not a member of that conversation.");
    }

    const messages = await tx.chatMessage.findMany({
      where: {
        conversationId,
        senderId: { not: userId },
        createdAt: { lte: readAt },
      },
      select: { id: true, senderId: true },
    });

    if (messages.length) {
      await tx.chatMessageRead.createMany({
        data: messages.map((message) => ({ messageId: message.id, userId })),
        skipDuplicates: true,
      });
      // New notifications identify the exact message. Legacy /chat notifications have no
      // conversation key: clear them only when this user has exactly one conversation.
      const singleConversation = await tx.conversationMember.count({ where: { userId } }) === 1;
      await tx.notification.updateMany({
        where: {
          recipientId: userId,
          type: "MESSAGE",
          readAt: null,
          createdAt: { lte: readAt },
          OR: [
            { href: { in: messages.map((message) => `/chat#message-${message.id}`) } },
            ...(singleConversation ? [{ href: "/chat", actorId: { in: [...new Set(messages.map((message) => message.senderId))] } }] : []),
          ],
        },
        data: { readAt },
      });
    }

    await tx.conversationMember.update({
      where: {
        conversationId_userId: { conversationId, userId },
      },
      data: { lastReadAt: readAt },
    });
  });
}

export async function markNotificationReadForUser(userId: string, notificationId: string) {
  return prisma.notification.updateMany({
    where: {
      id: notificationId,
      recipientId: userId,
    },
    data: {
      readAt: new Date(),
    },
  });
}

/** Scoped to the same NOTIFICATIONS_PAGE_VISIBLE_TYPES the page itself queries, so "Mark all
 * read" only ever touches what the user can actually see there - never a hidden MESSAGE or
 * RECOMMENDATION notification Chat already owns the read-state for. */
export async function markAllNotificationsReadForUser(userId: string) {
  return prisma.notification.updateMany({
    where: {
      recipientId: userId,
      readAt: null,
      type: { in: NOTIFICATIONS_PAGE_VISIBLE_TYPES },
    },
    data: {
      readAt: new Date(),
    },
  });
}

const MY_LST_SCANNER_PROFILE_NAME = "My LST";

/** True only for a P2002 violation of ScannerProfile's own `@@unique([ownerId, name])` constraint -
 * never treats an arbitrary Prisma error (e.g. a genuine validation failure, a different unique
 * constraint on a nested ScannerRule row, or an unrelated FK error) as this specific race. Verified
 * against a real concurrent P2002 in this Prisma 7 driver-adapter setup: the violated constraint's
 * name comes back at `meta.driverAdapterError.cause.constraint.index`, NOT the classic top-level
 * `meta.target` string/array some other Prisma connector versions use - both shapes are checked so
 * this stays correct if the underlying adapter/connector ever changes. */
function isMyLstScannerProfileNameConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as {
    code?: string;
    meta?: { target?: unknown; driverAdapterError?: { cause?: { constraint?: { index?: unknown } } } };
  };
  if (err.code !== "P2002") return false;

  const driverAdapterIndex = err.meta?.driverAdapterError?.cause?.constraint?.index;
  if (typeof driverAdapterIndex === "string") {
    return driverAdapterIndex === "ScannerProfile_ownerId_name_key";
  }

  const target = err.meta?.target;
  if (typeof target === "string") return target === "ScannerProfile_ownerId_name_key";
  if (Array.isArray(target)) return target.includes("ownerId") && target.includes("name");

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounded wait for a concurrent caller's profile+rules creation to become visible. Unlike the
 * TechnicalPreparationRun race (a multi-second quote sweep between placeholder and completion),
 * ScannerProfile creation is one nested Prisma `create()` call - profile and all its default
 * ScannerRule rows are written as a single atomic operation, so by the time a losing `create()`
 * throws P2002 the winner's transaction has already committed in full; there is no "still in
 * progress, partially written" state to poll through here. This loop is defense-in-depth only, not
 * a wait for real in-flight work - 20 x 25ms = 500ms ceiling, far shorter than the technical-
 * preparation-run poll's 30s (which genuinely waits out a real quote sweep). */
const SCANNER_PROFILE_RACE_POLL_INTERVAL_MS = 25;
const SCANNER_PROFILE_RACE_POLL_MAX_ATTEMPTS = 20;

async function waitForConcurrentMyLstScannerProfileCreation(userId: string) {
  for (let attempt = 0; attempt < SCANNER_PROFILE_RACE_POLL_MAX_ATTEMPTS; attempt += 1) {
    const winner = await prisma.scannerProfile.findFirst({
      where: { ownerId: userId, name: MY_LST_SCANNER_PROFILE_NAME },
    });
    if (winner) {
      return winner;
    }
    await sleep(SCANNER_PROFILE_RACE_POLL_INTERVAL_MS);
  }
  throw new Error("Timed out waiting for a concurrent My LST scanner profile creation to finish.");
}

/**
 * Returns the current user's "My LST" ScannerProfile, creating it (with its full set of default
 * ScannerRule rows from SCANNER_RULE_DEFINITIONS) only if none exists yet.
 *
 * Concurrency-safe by construction: `(ownerId, name)` is a real database unique constraint (see
 * ScannerProfile's schema). Two overlapping calls that both observe no existing row will both
 * attempt `create()`; Postgres accepts exactly one and rejects the other with a unique-constraint
 * error (P2002) on that exact constraint - the loser never creates a second profile or a duplicate
 * set of rules, it instead re-reads and returns the winner's already-fully-formed canonical
 * profile. Any other error (a different constraint, a validation failure, a connection error) is
 * rethrown unchanged rather than being mistaken for this race.
 */
export async function ensureMyLstScannerProfileForUser(userId: string) {
  const existing = await prisma.scannerProfile.findFirst({
    where: { ownerId: userId, name: MY_LST_SCANNER_PROFILE_NAME },
  });

  if (existing) {
    return existing;
  }

  try {
    return await prisma.scannerProfile.create({
      data: {
        ownerId: userId,
        name: MY_LST_SCANNER_PROFILE_NAME,
        visibility: "PRIVATE",
        rules: {
          create: SCANNER_RULE_DEFINITIONS.map((definition, index) => ({
            key: definition.key,
            name: definition.name,
            operator: definition.operator,
            valueJson: { desired: definition.defaultDesired },
            sortOrder: index,
            enabled: definition.defaultEnabled,
          })),
        },
      },
    });
  } catch (error) {
    if (isMyLstScannerProfileNameConstraintError(error)) {
      return waitForConcurrentMyLstScannerProfileCreation(userId);
    }
    throw error;
  }
}

/**
 * Ticket 7: saving/resetting Scanner settings is a pure preference change - it must never run a
 * scan (demo or live), never replace the latest ScanRun, and never partially apply an invalid
 * rule set. The whole proposed rule set is parsed/validated FIRST (synchronously, before any
 * database write); an invalid field throws here and nothing is persisted. Only once validation
 * succeeds does a single `$transaction` upsert every rule AND touch the profile's own `updatedAt` -
 * atomic (Postgres rolls back everything if any step fails) and the same mechanism the Scanner
 * page uses to honestly disclose "results were generated with earlier settings" (compares
 * `ScannerProfile.updatedAt` against the latest `ScanRun.createdAt` - no new versioning field).
 * Explicit demo mode remains exactly `runDemoScannerAction` -> `rerunDemoScannerForUser`,
 * unchanged and untouched by either function below.
 */
export async function updateScannerSettingsForUser(userId: string, formData: FormData) {
  const profile = await ensureMyLstScannerProfileForUser(userId);

  // Validate every field before writing anything - an invalid rule anywhere must reject the
  // whole save, never partially persist the rules parsed before it.
  const parsedRules = SCANNER_RULE_DEFINITIONS.map((definition, index) => ({
    definition,
    index,
    desired: parseScannerDesiredFromForm(definition, formData),
    enabled: formData.get(`${definition.key}:enabled`) === "on",
  }));

  await prisma.$transaction(async (tx) => {
    for (const { definition, index, desired, enabled } of parsedRules) {
      await tx.scannerRule.upsert({
        where: {
          profileId_key: {
            profileId: profile.id,
            key: definition.key,
          },
        },
        update: {
          name: definition.name,
          operator: definition.operator,
          valueJson: { desired },
          enabled,
          sortOrder: index,
        },
        create: {
          profileId: profile.id,
          key: definition.key,
          name: definition.name,
          operator: definition.operator,
          valueJson: { desired },
          enabled,
          sortOrder: index,
        },
      });
    }
    await tx.scannerProfile.update({ where: { id: profile.id }, data: { updatedAt: new Date() } });
  });

  return profile;
}

export async function resetScannerSettingsToLstCoreForUser(userId: string) {
  const profile = await ensureMyLstScannerProfileForUser(userId);

  await prisma.$transaction(async (tx) => {
    for (const [index, definition] of SCANNER_RULE_DEFINITIONS.entries()) {
      await tx.scannerRule.upsert({
        where: {
          profileId_key: {
            profileId: profile.id,
            key: definition.key,
          },
        },
        update: {
          name: definition.name,
          operator: definition.operator,
          valueJson: { desired: definition.defaultDesired },
          enabled: definition.defaultEnabled,
          sortOrder: index,
        },
        create: {
          profileId: profile.id,
          key: definition.key,
          name: definition.name,
          operator: definition.operator,
          valueJson: { desired: definition.defaultDesired },
          enabled: definition.defaultEnabled,
          sortOrder: index,
        },
      });
    }
    await tx.scannerProfile.update({ where: { id: profile.id }, data: { updatedAt: new Date() } });
  });

  return profile;
}

/**
 * Astra follow-up (Ticket 7 concurrency gap): stamps each candidate's values with the settings
 * revision (`ScannerProfile.updatedAt`) that was actually in effect when THIS scan read its rules
 * - captured at read time, not at persist time. `ScanRun.createdAt` alone cannot answer "which
 * rules produced this run": a scan that reads old rules, then finishes and persists AFTER a
 * settings save that happened while it was running, would otherwise look newer than the save
 * (`run.createdAt > profile.updatedAt`) even though it evaluated the OLD rule set. Persisted into
 * the existing flexible `snapshotJson` (same mechanism as Ticket 8's `retrievedAt`) - no schema
 * change, no new versioning subsystem. Read back by resultsPredateCurrentSettings's caller in
 * scanner/page.tsx.
 */
function withSettingsRevision(candidates: LiveScanCandidate[], settingsRevisionAsOf: Date): LiveScanCandidate[] {
  const stamp = settingsRevisionAsOf.toISOString();
  return candidates.map((candidate) => ({ ...candidate, values: { ...candidate.values, settingsRevisionAsOf: stamp } }));
}

export async function rerunDemoScannerForUser(userId: string, profileId?: string) {
  const profile =
    profileId
      ? await prisma.scannerProfile.findFirst({ where: { id: profileId, ownerId: userId } })
      : await ensureMyLstScannerProfileForUser(userId);

  if (!profile) {
    throw new ValidationError("Scanner profile was not found.");
  }

  const records = await prisma.scannerRule.findMany({
    where: { profileId: profile.id },
    orderBy: { sortOrder: "asc" },
  });
  const rules = scannerRulesFromRecords(records);
  return persistScannerRun(userId, profile.id, "DEMO", withSettingsRevision(evaluateDemoScan(rules), profile.updatedAt));
}

export type LiveScanUniverseSource = "OCC" | "LIMITED_FALLBACK";

export type LiveScanRunSummary = {
  /** How many candidates were actually persisted as ScanResult rows this run - this user's own
   * Research/Watchlist/traded tickers (always, unbounded) plus up to MAX_DISPLAYED_STOCK_STAGE_RESULTS
   * of the strongest-ranked stock-stage survivors from the broader universe. NOT the full universe
   * size, and NOT every quote+volume survivor either - see universeSymbols/priceAndVolumeSurvivors
   * for those. A real production run measured 2,073 quote+volume survivors; persisting a full row
   * (plus nested ScanCriterionResult rows) for every single one of them, then re-rendering all of
   * them on every future Scanner page load, produced a real production failure - see
   * PROJECT_HANDOFF.md's "broad scan result-cap fix." */
  scanned: number;
  nearMatches: number;
  elapsedMs: number;
  /** Real broad-universe funnel counts, for the Scanner page's "why did I only get these rows"
   * summary - see PROJECT_HANDOFF.md. None of these numbers are persisted; they describe only
   * THIS invocation's own run and are returned directly to the caller. */
  universeSymbols: number;
  /** "OCC" when the shared public optionable-universe cache had at least one row this run (the
   * expected/normal case); "LIMITED_FALLBACK" when it was empty and this scan ran against only
   * this user's own Research/Watchlist/traded tickers plus the fixed starter list - never silently
   * presented as a real broad scan when it wasn't one. */
  universeSource: LiveScanUniverseSource;
  successfullyQuoted: number;
  priceAndVolumeSurvivors: number;
  technicalReadyCount: number;
  /** Genuinely PENDING (no snapshot row yet) only - see technicalStaleCount/technicalFailedCount
   * for the other two non-READY states, split out separately for real production debuggability
   * (a STALE snapshot is a very different signal from a merely-not-yet-warmed one). */
  technicalPendingCount: number;
  technicalStaleCount: number;
  technicalFailedCount: number;
  optionChainsChecked: number;
};

/**
 * Bounds concurrent ScanResult inserts for a single run. Unlike SCAN_FETCH_CONCURRENCY
 * (external, rate-limit-sensitive), this only has to respect the local Postgres
 * connection pool, so a higher bound is safe; it stays a fixed limit rather than an
 * unbounded Promise.all so a large research-augmented universe can't burst the pool.
 */
const SCAN_PERSIST_CONCURRENCY = 6;

/**
 * Caps how many non-Tier-1 stock-stage candidates get persisted as ScanResult rows per scan. Real
 * production evidence: ~2,073 quote+volume survivors in one real run - persisting (and later
 * re-rendering, via getScannerPageData's own no-`take`-limit query) a full row for every one of
 * them is unbounded growth that real production evidence linked to a scan-completion failure,
 * even though the underlying funnel work itself (quotes, technical join, earnings join, bounded
 * option-chain enrichment) all completed correctly. Ranked by the same evidence tier, RSI/BB
 * rank and ticker comparator as the option-chain shortlist (see live-scan.ts), so every enriched
 * candidate (already the best maxOptionChainLookups=8 by that same rank) is always included,
 * plus a real band of next-best near-misses for context - never arbitrary. This user's own
 * Research/Watchlist/traded tickers are NEVER subject to this cap.
 */
export const MAX_DISPLAYED_STOCK_STAGE_RESULTS = 100;

export type LiveScanStage =
  | "PROFILE"
  | "PROVIDER"
  | "UNIVERSE_LOAD"
  | "TECHNICAL_JOIN"
  | "EARNINGS_JOIN"
  | "EVALUATE"
  | "PERSIST_RESULTS"
  | "FUNDAMENTALS_SYNC"
  | "BUILD_RESPONSE";

/**
 * Sanitized (never a raw error/stack trace/token/provider payload), stage-aware failure message -
 * a pure function so the two distinct honest outcomes (nothing was saved vs results were saved but
 * something after that failed - see PROJECT_HANDOFF.md's "truthful partial-failure semantics") are
 * directly testable without needing to force a real failure at an exact point mid-pipeline.
 */
export function buildLiveScanFailureMessage(stage: LiveScanStage, resultsPersisted: boolean, persistedCount: number): string {
  if (resultsPersisted) {
    return `Live scan saved ${persistedCount} result${persistedCount === 1 ? "" : "s"} but failed while finishing up (stage: ${stage}). Reload the Scanner page to see them.`;
  }
  return `LIVE DATA UNAVAILABLE: Schwab market data did not return a complete scan (stage: ${stage}). Demo data was not substituted.`;
}

/**
 * Broad-scanner activation (see PROJECT_HANDOFF.md): the real universe is now the shared public
 * OCC optionable-universe cache union this user's own Research/Watchlist/traded tickers (Tier 1)
 * union the fixed starter list (LIMITED_FALLBACK only - see universeSourceKind below) - never the
 * old fixed 13-ticker DEMO_SCAN_CANDIDATES-derived universe alone. Technical values (RSI/BB) come
 * EXCLUSIVELY from this user's own TechnicalIndicatorSnapshot cache
 * (getTechnicalIndicatorSnapshotsForUser) - evaluateLiveMarketScan is called WITH technicalCache
 * set, which structurally guarantees it never calls provider.getPriceHistory for the broad
 * universe (see LiveScanOptions.technicalCache's own doc comment) - a missing/stale/failed cache
 * entry is reported honestly, never silently fetched live. Earnings distance comes exclusively
 * from the shared EarningsCalendarEntry cache - zero Alpha Vantage calls from this path. Only a
 * bounded, ranked subset of the full universe is persisted as ScanResult rows - see
 * MAX_DISPLAYED_STOCK_STAGE_RESULTS.
 *
 * Every stage of this function is tracked (LiveScanStage) purely for safe, sanitized diagnostics -
 * never a raw error, stack trace, token, or provider payload. If something fails AFTER results
 * were already durably persisted (a real production scenario - see PROJECT_HANDOFF.md), the
 * thrown message says so honestly rather than implying the whole scan produced nothing.
 */
export async function rerunLiveSchwabScannerForUser(
  userId: string,
  options: { occSource?: string } = {},
): Promise<LiveScanRunSummary> {
  const startedAt = Date.now();
  let stage: LiveScanStage = "PROFILE";
  let resultsPersisted = false;
  let persistedCount = 0;
  // Safe, sanitized per-stage timing (stage names + milliseconds only) - see PROJECT_HANDOFF.md's
  // "22.3s live-scan request profile" audit. Logged once at the end (success or failure) rather
  // than per-transition, so a real production run gives a full breakdown in one line without
  // needing separate log correlation.
  const stageDurationsMs: Partial<Record<LiveScanStage, number>> = {};
  let stageStartedAt = startedAt;
  function advanceStage(next: LiveScanStage) {
    stageDurationsMs[stage] = Date.now() - stageStartedAt;
    stage = next;
    stageStartedAt = Date.now();
  }

  try {
    const profile = await ensureMyLstScannerProfileForUser(userId);

    advanceStage("PROVIDER");
    const provider = await getSchwabMarketDataProviderForUser(userId);
    if (!provider) {
      throw new ValidationError("LIVE DATA UNAVAILABLE: connect Schwab in Account settings with usable Schwab developer credentials.");
    }

    const records = await prisma.scannerRule.findMany({
      where: { profileId: profile.id },
      orderBy: { sortOrder: "asc" },
    });
    const rules = scannerRulesFromRecords(records);

    advanceStage("UNIVERSE_LOAD");
    // Scoped to a specific source (real callers default to OCC_OPTIONABLE_UNIVERSE_SOURCE = "OCC",
    // matching schwab-quote-batch-diagnostic.ts's own established pattern for this same table) -
    // never every row regardless of source, which would also sweep in any other future/non-OCC
    // source (and, in tests, other test files' own synthetic universe fixtures under their own
    // distinct sources).
    const occSource = options.occSource ?? OCC_OPTIONABLE_UNIVERSE_SOURCE;
    const [researchTickers, publicUniverse] = await Promise.all([
      getResearchUniverseTickersForUser(userId),
      prisma.optionableUniverseSymbol.findMany({ where: { source: occSource }, select: { ticker: true } }),
    ]);
    const researchTickerSet = new Set(researchTickers.map((ticker) => ticker.toUpperCase()));
    const universeSourceKind: LiveScanUniverseSource = publicUniverse.length > 0 ? "OCC" : "LIMITED_FALLBACK";
    // The fixed starter list is real evidence-backed redundant once OCC is populated - it was
    // measured to be fully subsumed within OCC's real ~6,071-symbol set (see PROJECT_HANDOFF.md).
    // Included only as the LIMITED_FALLBACK floor when OCC itself has nothing - never silently
    // mixed into what should be presented as a genuinely OCC-backed broad scan.
    const universe = [
      ...new Set([...(universeSourceKind === "LIMITED_FALLBACK" ? STARTER_LIVE_SCAN_UNIVERSE : []), ...researchTickers, ...publicUniverse.map((row) => row.ticker)]),
    ].map((ticker) => ticker.toUpperCase());

    advanceStage("TECHNICAL_JOIN");
    const technicalCache = await getTechnicalIndicatorSnapshotsForUser(userId, universe);

    advanceStage("EARNINGS_JOIN");
    const earningsRows = await getEarningsCalendarLookup(universe);
    const earningsLookup = new Map(
      [...earningsRows.entries()].map(([ticker, entry]) => [
        ticker,
        { daysUntilReport: entry.daysUntilReport, reportDate: entry.reportDate.toISOString().slice(0, 10) },
      ]),
    );

    advanceStage("EVALUATE");
    const candidates = await evaluateLiveMarketScan({ provider, rules, universe, technicalCache, earningsLookup });

    // Bound what gets persisted (and re-read on every future Scanner page load) - this user's own
    // Tier 1 tickers unconditionally, plus the top MAX_DISPLAYED_STOCK_STAGE_RESULTS non-Tier-1
    // stock-stage survivors by the same rank the option-chain shortlist itself uses. See
    // MAX_DISPLAYED_STOCK_STAGE_RESULTS's own doc comment for why this exists.
    const tier1Persisted = candidates.filter((candidate) => researchTickerSet.has(candidate.ticker));
    const rankedNonTier1StockStage = candidates
      .filter((candidate) => candidate.funnelStage === "STOCK_STAGE" && !researchTickerSet.has(candidate.ticker))
      .sort(compareStockStageCandidates)
      .slice(0, MAX_DISPLAYED_STOCK_STAGE_RESULTS);
    const toPersist = [...tier1Persisted, ...rankedNonTier1StockStage];

    advanceStage("PERSIST_RESULTS");
    // profile.updatedAt was read at the very start of this run (before the rules were even
    // fetched) - the settings revision this scan actually evaluated against, regardless of any
    // settings save that lands while EVALUATE/PERSIST_RESULTS are still running.
    await persistScannerRun(userId, profile.id, "LIVE:SCHWAB", withSettingsRevision(toPersist, profile.updatedAt));
    resultsPersisted = true;
    persistedCount = toPersist.length;

    advanceStage("FUNDAMENTALS_SYNC");
    await syncVerifiedFundamentalsForUser(userId, toPersist);

    advanceStage("BUILD_RESPONSE");
    const successfullyQuoted = candidates.filter((candidate) => candidate.funnelStage !== "UNAVAILABLE").length;
    const priceAndVolumeSurvivors = candidates.filter(
      (candidate) => candidate.funnelStage === "STOCK_STAGE" || candidate.funnelStage === "HISTORY_UNAVAILABLE",
    ).length;
    const technicalReadyCount = candidates.filter(
      (candidate) => candidate.funnelStage === "STOCK_STAGE" && !candidate.values.technicalReasonCode,
    ).length;
    const technicalPendingCount = candidates.filter((candidate) => candidate.values.technicalReasonCode === "TECHNICAL_DATA_PENDING").length;
    const technicalStaleCount = candidates.filter((candidate) => candidate.values.technicalReasonCode === "TECHNICAL_DATA_STALE").length;
    const technicalFailedCount = candidates.filter((candidate) => candidate.values.technicalReasonCode === "TECHNICAL_DATA_FAILED").length;
    const optionChainsChecked = candidates.filter((candidate) => candidate.reachedOptionChainLookup).length;

    stageDurationsMs.BUILD_RESPONSE = Date.now() - stageStartedAt;
    console.info("Live Schwab scan stage timing (ms)", stageDurationsMs, "total:", Date.now() - startedAt);

    return {
      scanned: toPersist.length,
      // Same authoritative classifier the Scanner page itself uses (see scanner.ts) - this toast
      // must never disagree with the page's own "Near" count for the same run.
      nearMatches: toPersist.filter(
        (candidate) =>
          classifyReadiness(candidate.summary, GATING_RULE_KEYS, candidate.values.optionEnrichment, candidate.values.contractReasonCode) === "NEAR",
      ).length,
      elapsedMs: Date.now() - startedAt,
      universeSymbols: universe.length,
      universeSource: universeSourceKind,
      successfullyQuoted,
      priceAndVolumeSurvivors,
      technicalReadyCount,
      technicalPendingCount,
      technicalStaleCount,
      technicalFailedCount,
      optionChainsChecked,
    };
  } catch (error) {
    stageDurationsMs[stage] = Date.now() - stageStartedAt;
    if (error instanceof ValidationError) {
      throw error; // an already-honest, already-sanitized message - never re-wrapped
    }
    console.error(`Live Schwab scan failed at stage ${stage}`, error, "stage timing (ms):", stageDurationsMs);
    throw new ValidationError(buildLiveScanFailureMessage(stage, resultsPersisted, persistedCount));
  }
}

/**
 * Persists verified Schwab fundamentals (P/E, EPS, dividend amount/yield) onto the calling
 * user's OWN existing Research rows, reusing the quote data a live scan already fetched -
 * this makes zero additional Schwab requests. Only ever touches WatchlistItem rows owned by
 * `userId` (never creates a new row just because a ticker appeared in a scan - adding to
 * Research stays an explicit user action). A field is only ever written when this fetch
 * actually returned a real value (including a real negative or 0); a transient ABSENT/NULL
 * on one scan run must never blank out a value captured on an earlier, successful one.
 */
export async function syncVerifiedFundamentalsForUser(userId: string, candidates: LiveScanCandidate[]) {
  const fundamentalsByTicker = new Map(
    candidates
      .filter((candidate) => candidate.verifiedFundamentals)
      .map((candidate) => [candidate.ticker, candidate.verifiedFundamentals!]),
  );
  if (!fundamentalsByTicker.size) {
    return;
  }

  const items = await prisma.watchlistItem.findMany({
    where: { ownerId: userId, ticker: { in: [...fundamentalsByTicker.keys()] } },
    select: { id: true, ticker: true },
  });
  if (!items.length) {
    return;
  }

  const now = new Date();
  await mapWithConcurrency(items, SCAN_PERSIST_CONCURRENCY, async (item) => {
    const fundamentals = fundamentalsByTicker.get(item.ticker);
    if (!fundamentals) {
      return;
    }

    const hasRealValue =
      fundamentals.peRatio !== null ||
      fundamentals.eps !== null ||
      fundamentals.dividendAmount !== null ||
      fundamentals.dividendYield !== null;
    if (!hasRealValue) {
      return;
    }

    await prisma.watchlistItem.update({
      where: { id: item.id },
      data: {
        ...(fundamentals.peRatio !== null ? { fundamentalPeRatio: fundamentals.peRatio } : {}),
        ...(fundamentals.eps !== null ? { fundamentalEps: fundamentals.eps } : {}),
        ...(fundamentals.dividendAmount !== null ? { fundamentalDividendAmount: fundamentals.dividendAmount } : {}),
        ...(fundamentals.dividendYield !== null ? { fundamentalDividendYield: fundamentals.dividendYield } : {}),
        fundamentalSource: "Schwab Trader API",
        fundamentalAsOf: now,
      },
    });
  });
}

function jsonReady(values: Record<string, number | string | boolean | null | undefined>) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value ?? null]));
}

async function persistScannerRun(
  userId: string,
  profileId: string,
  source: string,
  candidates: LiveScanCandidate[],
) {
  const run = await prisma.scanRun.create({
    data: {
      profileId,
      ownerId: userId,
      source,
    },
  });

  await mapWithConcurrency(candidates, SCAN_PERSIST_CONCURRENCY, (candidate) =>
    prisma.scanResult.create({
      data: {
        runId: run.id,
        ticker: candidate.ticker,
        summaryStatus: candidate.summary.status,
        passedCriteria: candidate.summary.passed,
        totalCriteria: candidate.summary.total,
        snapshotJson: jsonReady(candidate.values),
        criterionResults: {
          create: candidate.summary.results.map((result) => ({
            criterionName: result.name,
            actualValue:
              result.actualValue === undefined || result.actualValue === null
                ? null
                : String(result.actualValue),
            operator: result.operator,
            desiredValue: JSON.stringify(result.desiredValue),
            status: result.status,
            explanation: result.explanation,
          })),
        },
      },
    }),
  );

  return run;
}

function parseAccountVisibility(value: unknown, fallback: Visibility): Visibility {
  const visibility = String(value ?? fallback).toUpperCase() as Visibility;
  if (!ACCOUNT_VISIBILITIES.has(visibility)) {
    throw new ValidationError("Choose a valid account visibility.");
  }

  return visibility;
}

function parseRecordVisibility(value: unknown, fallback: InheritedVisibility): InheritedVisibility {
  const visibility = String(value ?? fallback).toUpperCase() as InheritedVisibility;
  if (!RECORD_VISIBILITIES.has(visibility)) {
    throw new ValidationError("Choose a valid campaign visibility.");
  }

  return visibility;
}

function parseDateInput(value: unknown, label: string) {
  const text = String(value ?? "").trim();
  const date = text ? new Date(text) : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw new ValidationError(`Enter a valid ${label}.`);
  }

  return date;
}

function parseOptionalMoney(value: unknown, label: string) {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }

  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ValidationError(`Enter a valid ${label}.`);
  }

  return parsed;
}

/**
 * For manual fundamentals (P/E, PEG, D/E, current ratio, dividend yield/amount) where an
 * empty input must persist as null, never 0 - a real P/E of "blank" and a real P/E of 0 are
 * not the same thing, and 0 is not a meaningful value for any of these fields anyway.
 * Negative values are allowed (e.g. negative P/E from negative earnings) since rejecting
 * them would make it impossible to honestly record what a real value is; display layers are
 * responsible for showing negative/non-meaningful values as "N/M", not this parser.
 */
function parseOptionalDecimal(value: unknown, label: string) {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    throw new ValidationError(`Enter a valid ${label}.`);
  }

  return parsed;
}

function parsePositiveNumber(value: unknown, label: string) {
  const parsed = Number(String(value ?? "").trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ValidationError(`Enter a valid ${label}.`);
  }

  return parsed;
}

function parseFiniteNumberOrThrow(value: unknown, label: string) {
  const parsed = Number(String(value ?? "").trim());
  if (!Number.isFinite(parsed) || parsed === 0) {
    throw new ValidationError(`Enter a valid ${label}.`);
  }

  return parsed;
}

function parseNonNegativeNumber(value: unknown, label: string) {
  const parsed = Number(String(value ?? "").trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ValidationError(`Enter a valid ${label}.`);
  }

  return parsed;
}

function parsePositiveInteger(value: unknown, label: string) {
  const parsed = Number(String(value ?? "").trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ValidationError(`Enter a valid ${label}.`);
  }

  return parsed;
}

function parseOptionalPositiveInteger(value: unknown, label: string) {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }

  return parsePositiveInteger(text, label);
}

async function latestScannerSnapshotForUser(userId: string, ticker: string) {
  const result = await prisma.scanResult.findFirst({
    where: {
      ticker,
      run: { ownerId: userId },
    },
    orderBy: { createdAt: "desc" },
    select: {
      summaryStatus: true,
      passedCriteria: true,
      totalCriteria: true,
      snapshotJson: true,
      run: {
        select: {
          createdAt: true,
          source: true,
          profile: { select: { name: true } },
        },
      },
    },
  });

  if (!result) {
    return null;
  }

  return {
    source: result.run.source,
    capturedAt: result.run.createdAt.toISOString(),
    profileName: result.run.profile.name,
    scannerStatus: result.summaryStatus,
    passedCriteria: result.passedCriteria,
    totalCriteria: result.totalCriteria,
    values: result.snapshotJson,
  };
}

async function getOwnMutableCampaign(userId: string, campaignId: string) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: {
      account: true,
      events: { orderBy: [{ occurredAt: "asc" }, { sortOrder: "asc" }] },
    },
  });

  if (!campaign) {
    return null;
  }

  assertCanMutateRecord(userId, campaign.ownerId);
  return campaign;
}

function latestPutLeg(
  events: {
    type: string;
    contracts: number | null;
    strike: unknown;
    expiration: Date | null;
    occurredAt: Date;
    sortOrder: number;
  }[],
) {
  const latest = [...events]
    .reverse()
    .find((event) => (event.type === "SELL_PUT" || event.type === "ROLL_PUT_OPEN") && event.contracts && event.strike);
  const strike = latest ? numericInput(latest.strike) : null;
  if (!latest || !latest.contracts || !latest.expiration || strike === null) {
    return null;
  }

  return {
    contracts: latest.contracts,
    strike,
    expiration: latest.expiration,
  };
}

function nextSortOrder(events: { sortOrder: number }[]) {
  return events.reduce((next, event) => Math.max(next, event.sortOrder + 1), 0);
}

function numericInput(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const candidate = value as { toNumber?: () => number; toString?: () => string };
  if (typeof candidate.toNumber === "function") {
    const parsed = candidate.toNumber();
    return Number.isFinite(parsed) ? parsed : null;
  }

  const parsed = Number(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}
