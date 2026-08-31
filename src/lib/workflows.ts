import { randomUUID } from "node:crypto";
import { evaluateLiveMarketScan, type LiveScanCandidate } from "@/domain/scanner/live-scan";
import type { NoteCategory, ReactionTargetType } from "@/generated/prisma/enums";
import { evaluateDemoScan, parseScannerDesiredFromForm, scannerRulesFromRecords, SCANNER_RULE_DEFINITIONS } from "@/domain/scanner/profile";
import { isRecommendationStatus, normalizeReasonTags, type RecommendationStatus } from "@/domain/social/recommendations";
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
  getSchwabBrokerReadProviderForUser,
  getSchwabMarketDataProvider,
  recordSchwabAccountSyncResult,
} from "./broker-connections";

const NOTE_CATEGORIES = new Set<NoteCategory>(["PRO", "CON", "GENERAL"]);
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

export type SchwabAccountSyncResult = {
  syncedAccounts: number;
  accounts: { id: string; name: string; accountValue: number; cash: number }[];
};

/**
 * Pulls real account value/cash from Schwab for the authenticated user only and
 * records it as a BROKER_SNAPSHOT ledger entry per linked account. Never fabricates a
 * value Schwab did not return, and never touches another user's accounts or tokens.
 */
export async function syncSchwabAccountForUser(userId: string): Promise<SchwabAccountSyncResult> {
  const provider = await getSchwabBrokerReadProviderForUser(userId);
  if (!provider) {
    throw new ValidationError("Connect Schwab in Account settings before syncing.");
  }

  let brokerAccounts;
  try {
    brokerAccounts = await provider.getAccounts();
  } catch {
    await recordSchwabAccountSyncResult(userId, { failureReason: "fetch_failed" });
    throw new ValidationError("Schwab did not return account data. Try again in a moment.");
  }

  if (!brokerAccounts.length) {
    await recordSchwabAccountSyncResult(userId, { failureReason: "no_accounts" });
    throw new ValidationError("Schwab did not report any linked accounts to sync.");
  }

  const syncedAt = new Date();
  const accounts = [];

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

    accounts.push({ id: tradingAccount.id, name: tradingAccount.name, accountValue: brokerAccount.accountValue, cash: brokerAccount.cash });
  }

  await recordSchwabAccountSyncResult(userId, { succeededAt: syncedAt });
  return { syncedAccounts: accounts.length, accounts };
}

export async function getSchwabOpenPositionsForUser(userId: string) {
  const provider = await getSchwabBrokerReadProviderForUser(userId);
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
        fees: 0,
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

export async function createWatchlistItemForUser(userId: string, tickerInput: unknown) {
  const ticker = requireTicker(tickerInput);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const watchlist =
    (await prisma.watchlist.findFirst({ where: { ownerId: user.id } })) ??
    (await prisma.watchlist.create({
      data: {
        ownerId: user.id,
        name: `${user.name}'s LST`,
        visibility: "SHARED",
      },
    }));

  const item = await prisma.watchlistItem.upsert({
    where: {
      watchlistId_ticker: {
        watchlistId: watchlist.id,
        ticker,
      },
    },
    update: {
      status: "WATCHING",
    },
    create: {
      watchlistId: watchlist.id,
      ownerId: user.id,
      ticker,
      status: "WATCHING",
      visibility: "SHARED",
      tags: ["manual"],
    },
  });

  await prisma.activity.create({
    data: {
      actorId: user.id,
      type: "WATCHLIST",
      title: `${user.name} added ${ticker}`,
      body: "Added to the LST watchlist.",
      ticker,
      visibility: "SHARED",
    },
  });

  return item;
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

export async function ensureMyLstScannerProfileForUser(userId: string) {
  const existing = await prisma.scannerProfile.findFirst({
    where: { ownerId: userId, name: "My LST" },
  });

  if (existing) {
    return existing;
  }

  return prisma.scannerProfile.create({
    data: {
      ownerId: userId,
      name: "My LST",
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

export async function rerunLiveSchwabScannerForUser(userId: string) {
  const profile = await ensureMyLstScannerProfileForUser(userId);
  const provider = await getSchwabMarketDataProvider();
  if (!provider) {
    throw new ValidationError("LIVE DATA UNAVAILABLE: connect Schwab in Account settings and configure the Schwab server environment variables.");
  }

  const records = await prisma.scannerRule.findMany({
    where: { profileId: profile.id },
    orderBy: { sortOrder: "asc" },
  });
  const rules = scannerRulesFromRecords(records);

  try {
    const candidates = await evaluateLiveMarketScan({ provider, rules });
    return persistScannerRun(userId, profile.id, "LIVE:SCHWAB", candidates);
  } catch {
    throw new ValidationError("LIVE DATA UNAVAILABLE: Schwab market data did not return a complete scan. Demo data was not substituted.");
  }
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

  for (const candidate of candidates) {
    await prisma.scanResult.create({
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
    });
  }

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
