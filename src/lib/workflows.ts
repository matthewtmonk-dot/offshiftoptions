import type { NoteCategory, ReactionTargetType } from "@/generated/prisma/enums";
import { evaluateDemoScan, parseScannerDesiredFromForm, scannerRulesFromRecords, SCANNER_RULE_DEFINITIONS } from "@/domain/scanner/profile";
import { isRecommendationStatus, normalizeReasonTags, type RecommendationStatus } from "@/domain/social/recommendations";
import { assertCanMutateRecord, assertCanReadRecord } from "./privacy";
import { prisma } from "./prisma";
import { requireTicker, ValidationError } from "./tickers";
import { notifyInApp } from "./notifications";

const NOTE_CATEGORIES = new Set<NoteCategory>(["PRO", "CON", "GENERAL"]);
const RETURNABLE_PATHS = new Set([
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
          enabled: true,
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
  const run = await prisma.scanRun.create({
    data: {
      profileId: profile.id,
      ownerId: userId,
      source: "DEMO",
    },
  });

  for (const candidate of evaluateDemoScan(rules)) {
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

function jsonReady(values: Record<string, number | string | boolean | null | undefined>) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value ?? null]));
}
