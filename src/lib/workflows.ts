import { randomUUID } from "node:crypto";
import { evaluateLiveMarketScan, STARTER_LIVE_SCAN_UNIVERSE, type LiveScanCandidate } from "@/domain/scanner/live-scan";
import type {
  LsegRecommendation,
  NoteCategory,
  ProfitabilityAssessment,
  ReactionTargetType,
  ResearchStatus,
  RollFriendliness,
  WouldOwnStatus,
} from "@/generated/prisma/enums";
import { evaluateDemoScan, parseScannerDesiredFromForm, scannerRulesFromRecords, SCANNER_RULE_DEFINITIONS } from "@/domain/scanner/profile";
import { getNearMisses } from "@/domain/scanner/scanner";
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
import { notifyInApp } from "./notifications";
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
  accounts: { id: string; name: string; accountValue: number; cash: number; freshPositions: BrokerPosition[] }[];
  /** The sync-only portion of SchwabSyncDiagnostics (see broker-connections.ts) - the caller
   * (syncSchwabAccountAction) merges in the campaign-related counts from
   * reconcileSchwabActivityForUser, which runs after this returns, before persisting the full
   * diagnostics record. */
  diagnostics: {
    positionsReceived: number;
    positionsSourceStatus: "OK" | "ERROR";
    positionsErrorCode: string | null;
    transactionsReceived: number;
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

  return { positions, positionsStatus, positionsErrorCode, transactions, transactionCategories, transactionsErrorCode };
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
 * (reconcileSchwabActivityForUser, called by the syncSchwabAccountAction caller with the fresh
 * positions returned here) turn real Schwab activity into Tracker history automatically.
 * Never fabricates a value Schwab did not return, and never touches another user's accounts or
 * tokens. A positions/transactions fetch failure never fails the whole sync - the account
 * balance sync (this function's original promise) still succeeds; that account's campaign
 * reconciliation is simply skipped until the next successful sync.
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
    const freshPositions = activity.positions;

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
        diagnostics.persistenceErrorCode = categorizeSchwabSyncError(error);
        logSchwabSyncFailure("schwab_sync_persistence", userId, error);
      }
    }

    accounts.push({ id: tradingAccount.id, name: tradingAccount.name, accountValue: brokerAccount.accountValue, cash: brokerAccount.cash, freshPositions });
  }

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

  await prisma.campaignEvent.create({
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

  return prisma.campaign.update({
    where: { id: campaign.id },
    data: { status: "CLOSED", closedAt: occurredAt },
    include: campaignDetailInclude,
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

  return recommendation;
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
) {
  const body = trimText(bodyInput, 1200);
  const ticker = tickerInput ? requireTicker(tickerInput) : null;

  if (!conversationId || !body) {
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
  const message = await prisma.chatMessage.create({
    data: {
      conversationId,
      senderId: user.id,
      body,
      ticker,
      reads: {
        create: {
          userId: user.id,
        },
      },
    },
  });

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
          body,
          href: "/chat",
        }),
      ),
  );

  return message;
}

export async function markConversationReadForUser(userId: string, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: {
      id: conversationId,
      members: { some: { userId } },
    },
    select: { id: true },
  });

  if (!conversation) {
    throw new ValidationError("You are not a member of that conversation.");
  }

  const unreadMessages = await prisma.chatMessage.findMany({
    where: {
      conversationId,
      senderId: { not: userId },
      reads: { none: { userId } },
    },
    select: { id: true },
  });

  if (unreadMessages.length) {
    await prisma.chatMessageRead.createMany({
      data: unreadMessages.map((message) => ({ messageId: message.id, userId })),
      skipDuplicates: true,
    });
  }

  await prisma.conversationMember.update({
    where: {
      conversationId_userId: {
        conversationId,
        userId,
      },
    },
    data: { lastReadAt: new Date() },
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

export async function markAllNotificationsReadForUser(userId: string) {
  return prisma.notification.updateMany({
    where: {
      recipientId: userId,
      readAt: null,
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

export async function updateScannerSettingsForUser(userId: string, formData: FormData) {
  const profile = await ensureMyLstScannerProfileForUser(userId);

  for (const [index, definition] of SCANNER_RULE_DEFINITIONS.entries()) {
    const desired = parseScannerDesiredFromForm(definition, formData);
    const enabled = formData.get(`${definition.key}:enabled`) === "on";
    await prisma.scannerRule.upsert({
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

  await rerunDemoScannerForUser(userId, profile.id);
  return profile;
}

export async function resetScannerSettingsToLstCoreForUser(userId: string) {
  const profile = await ensureMyLstScannerProfileForUser(userId);

  for (const [index, definition] of SCANNER_RULE_DEFINITIONS.entries()) {
    await prisma.scannerRule.upsert({
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

  await rerunDemoScannerForUser(userId, profile.id);
  return profile;
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
  return persistScannerRun(userId, profile.id, "DEMO", evaluateDemoScan(rules));
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
 * option-chain enrichment) all completed correctly. Ranked by the exact same stockStageRank the
 * option-chain shortlist itself uses (see live-scan.ts), so every genuinely option-chain-enriched
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

  try {
    const profile = await ensureMyLstScannerProfileForUser(userId);

    stage = "PROVIDER";
    const provider = await getSchwabMarketDataProviderForUser(userId);
    if (!provider) {
      throw new ValidationError("LIVE DATA UNAVAILABLE: connect Schwab in Account settings with usable Schwab developer credentials.");
    }

    const records = await prisma.scannerRule.findMany({
      where: { profileId: profile.id },
      orderBy: { sortOrder: "asc" },
    });
    const rules = scannerRulesFromRecords(records);

    stage = "UNIVERSE_LOAD";
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

    stage = "TECHNICAL_JOIN";
    const technicalCache = await getTechnicalIndicatorSnapshotsForUser(userId, universe);

    stage = "EARNINGS_JOIN";
    const earningsRows = await getEarningsCalendarLookup(universe);
    const earningsLookup = new Map(
      [...earningsRows.entries()].map(([ticker, entry]) => [
        ticker,
        { daysUntilReport: entry.daysUntilReport, reportDate: entry.reportDate.toISOString().slice(0, 10) },
      ]),
    );

    stage = "EVALUATE";
    const candidates = await evaluateLiveMarketScan({ provider, rules, universe, technicalCache, earningsLookup });

    // Bound what gets persisted (and re-read on every future Scanner page load) - this user's own
    // Tier 1 tickers unconditionally, plus the top MAX_DISPLAYED_STOCK_STAGE_RESULTS non-Tier-1
    // stock-stage survivors by the same rank the option-chain shortlist itself uses. See
    // MAX_DISPLAYED_STOCK_STAGE_RESULTS's own doc comment for why this exists.
    const tier1Persisted = candidates.filter((candidate) => researchTickerSet.has(candidate.ticker));
    const rankedNonTier1StockStage = candidates
      .filter((candidate) => candidate.funnelStage === "STOCK_STAGE" && !researchTickerSet.has(candidate.ticker))
      .sort((left, right) => (left.stockStageRank ?? Infinity) - (right.stockStageRank ?? Infinity))
      .slice(0, MAX_DISPLAYED_STOCK_STAGE_RESULTS);
    const toPersist = [...tier1Persisted, ...rankedNonTier1StockStage];

    stage = "PERSIST_RESULTS";
    await persistScannerRun(userId, profile.id, "LIVE:SCHWAB", toPersist);
    resultsPersisted = true;
    persistedCount = toPersist.length;

    stage = "FUNDAMENTALS_SYNC";
    await syncVerifiedFundamentalsForUser(userId, toPersist);

    stage = "BUILD_RESPONSE";
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

    return {
      scanned: toPersist.length,
      nearMatches: toPersist.filter((candidate) => getNearMisses(candidate.summary.results).length === 1).length,
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
    if (error instanceof ValidationError) {
      throw error; // an already-honest, already-sanitized message - never re-wrapped
    }
    console.error(`Live Schwab scan failed at stage ${stage}`, error);
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
