"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assertCanMutateRecord, assertCanReadRecord } from "@/lib/privacy";
import { requireCurrentUser, signOut } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notifyInApp } from "@/lib/notifications";
import { upperTicker } from "@/lib/format";

export async function signOutAction() {
  await signOut();
  redirect("/login");
}

export async function addWatchlistItemAction(formData: FormData) {
  const user = await requireCurrentUser();
  const ticker = upperTicker(formData.get("ticker"));
  if (!ticker) {
    return;
  }

  const watchlist =
    (await prisma.watchlist.findFirst({ where: { ownerId: user.id } })) ??
    (await prisma.watchlist.create({
      data: {
        ownerId: user.id,
        name: `${user.name}'s LST`,
        visibility: "SHARED",
      },
    }));

  await prisma.watchlistItem.upsert({
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

  revalidatePath("/watchlist");
  revalidatePath("/dashboard");
}

export async function removeWatchlistItemAction(formData: FormData) {
  const user = await requireCurrentUser();
  const itemId = String(formData.get("itemId") ?? "");
  const item = await prisma.watchlistItem.findUnique({ where: { id: itemId } });
  if (!item) {
    return;
  }

  assertCanMutateRecord(user.id, item.ownerId);
  await prisma.watchlistItem.delete({ where: { id: item.id } });

  revalidatePath("/watchlist");
  revalidatePath("/dashboard");
}

export async function toggleWatchlistItemVisibilityAction(formData: FormData) {
  const user = await requireCurrentUser();
  const itemId = String(formData.get("itemId") ?? "");
  const item = await prisma.watchlistItem.findUnique({ where: { id: itemId } });
  if (!item) {
    return;
  }

  assertCanMutateRecord(user.id, item.ownerId);
  await prisma.watchlistItem.update({
    where: { id: item.id },
    data: {
      visibility: item.visibility === "PRIVATE" ? "SHARED" : "PRIVATE",
    },
  });

  revalidatePath("/watchlist");
  revalidatePath("/dashboard");
}

export async function addStockNoteAction(formData: FormData) {
  const user = await requireCurrentUser();
  const itemId = String(formData.get("itemId") ?? "");
  const category = String(formData.get("category") ?? "GENERAL") as "PRO" | "CON" | "GENERAL";
  const body = String(formData.get("body") ?? "").trim();
  const item = await prisma.watchlistItem.findUnique({ where: { id: itemId } });

  if (!item || !body) {
    return;
  }

  assertCanReadRecord(user.id, item.ownerId, item.visibility);
  await prisma.stockNote.create({
    data: {
      ownerId: user.id,
      watchlistItemId: item.id,
      ticker: item.ticker,
      category,
      body,
      visibility: user.id === item.ownerId ? item.visibility : "SHARED",
    },
  });

  revalidatePath("/watchlist");
  revalidatePath("/dashboard");
}

export async function addWatchlistCommentAction(formData: FormData) {
  const user = await requireCurrentUser();
  const itemId = String(formData.get("itemId") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  const item = await prisma.watchlistItem.findUnique({
    where: { id: itemId },
    include: { owner: true },
  });

  if (!item || !body) {
    return;
  }

  assertCanReadRecord(user.id, item.ownerId, item.visibility);
  await prisma.comment.create({
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

  revalidatePath("/watchlist");
}

export async function recommendStockAction(formData: FormData) {
  const user = await requireCurrentUser();
  const ticker = upperTicker(formData.get("ticker"));
  const recipientId = String(formData.get("recipientId") ?? "");
  const message = String(formData.get("message") ?? "").trim() || `Take a look at ${ticker}.`;
  const tags = String(formData.get("reasonTags") ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  if (!ticker || !recipientId || recipientId === user.id) {
    return;
  }

  const recipient = await prisma.user.findUnique({ where: { id: recipientId } });
  if (!recipient) {
    return;
  }

  await prisma.recommendation.create({
    data: {
      senderId: user.id,
      recipientId,
      ticker,
      message,
      reasonTags: tags.length ? tags : ["Worth researching"],
      visibility: "SHARED",
    },
  });

  await prisma.activity.create({
    data: {
      actorId: user.id,
      type: "RECOMMENDATION",
      title: `${user.name} recommended ${ticker}`,
      body: message,
      ticker,
      visibility: "SHARED",
    },
  });

  await notifyInApp({
    recipientId,
    actorId: user.id,
    type: "RECOMMENDATION",
    title: `${user.name} recommended ${ticker}`,
    body: message,
    href: "/recommendations",
  });

  revalidatePath("/recommendations");
  revalidatePath("/watchlist");
  revalidatePath("/scanner");
  revalidatePath("/dashboard");
}

export async function updateRecommendationStatusAction(formData: FormData) {
  const user = await requireCurrentUser();
  const recommendationId = String(formData.get("recommendationId") ?? "");
  const status = String(formData.get("status") ?? "NEW") as "NEW" | "WATCHING" | "DISMISSED" | "DONE";
  const recommendation = await prisma.recommendation.findUnique({ where: { id: recommendationId } });

  if (!recommendation) {
    return;
  }

  assertCanMutateRecord(user.id, recommendation.recipientId);
  await prisma.recommendation.update({
    where: { id: recommendation.id },
    data: { status },
  });

  revalidatePath("/recommendations");
  revalidatePath("/dashboard");
}

export async function addRecommendationCommentAction(formData: FormData) {
  const user = await requireCurrentUser();
  const recommendationId = String(formData.get("recommendationId") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  const recommendation = await prisma.recommendation.findUnique({
    where: { id: recommendationId },
    include: { sender: true, recipient: true },
  });

  if (!recommendation || !body) {
    return;
  }

  const isParticipant = [recommendation.senderId, recommendation.recipientId].includes(user.id);
  if (!isParticipant) {
    assertCanReadRecord(user.id, recommendation.senderId, recommendation.visibility);
  }

  await prisma.comment.create({
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

  revalidatePath("/recommendations");
}

export async function addReactionAction(formData: FormData) {
  const user = await requireCurrentUser();
  const targetType = String(formData.get("targetType") ?? "") as
    | "WATCHLIST_ITEM"
    | "RECOMMENDATION"
    | "COMMENT"
    | "TRADE"
    | "ACTIVITY";
  const targetId = String(formData.get("targetId") ?? "");

  const data: Record<string, string> = {};
  let notificationTarget: { ownerId?: string; ticker?: string; href: string } | null = null;

  if (targetType === "WATCHLIST_ITEM") {
    const item = await prisma.watchlistItem.findUnique({ where: { id: targetId } });
    if (!item) return;
    assertCanReadRecord(user.id, item.ownerId, item.visibility);
    data.watchlistItemId = item.id;
    notificationTarget = { ownerId: item.ownerId, ticker: item.ticker, href: "/watchlist" };
  }

  if (targetType === "RECOMMENDATION") {
    const recommendation = await prisma.recommendation.findUnique({ where: { id: targetId } });
    if (!recommendation) return;
    const isParticipant = [recommendation.senderId, recommendation.recipientId].includes(user.id);
    if (!isParticipant) {
      assertCanReadRecord(user.id, recommendation.senderId, recommendation.visibility);
    }
    data.recommendationId = recommendation.id;
    notificationTarget = {
      ownerId: user.id === recommendation.senderId ? recommendation.recipientId : recommendation.senderId,
      ticker: recommendation.ticker,
      href: "/recommendations",
    };
  }

  if (targetType === "TRADE") {
    const trade = await prisma.trade.findUnique({ where: { id: targetId } });
    if (!trade) return;
    assertCanReadRecord(user.id, trade.userId, trade.visibility);
    data.tradeId = trade.id;
    notificationTarget = { ownerId: trade.userId, ticker: trade.symbol, href: "/positions" };
  }

  if (targetType === "ACTIVITY") {
    const activity = await prisma.activity.findUnique({ where: { id: targetId } });
    if (!activity) return;
    assertCanReadRecord(user.id, activity.actorId, activity.visibility);
    data.activityId = activity.id;
    notificationTarget = { ownerId: activity.actorId, ticker: activity.ticker ?? undefined, href: "/dashboard" };
  }

  await prisma.reaction.create({
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

  revalidatePath("/dashboard");
  revalidatePath("/watchlist");
  revalidatePath("/recommendations");
  revalidatePath("/positions");
}

export async function sendChatMessageAction(formData: FormData) {
  const user = await requireCurrentUser();
  const conversationId = String(formData.get("conversationId") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  const ticker = upperTicker(formData.get("ticker")) || null;

  if (!conversationId || !body) {
    return;
  }

  const conversation = await prisma.conversation.findFirst({
    where: {
      id: conversationId,
      members: { some: { userId: user.id } },
    },
    include: { members: true },
  });

  if (!conversation) {
    return;
  }

  await prisma.chatMessage.create({
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

  revalidatePath("/chat");
  revalidatePath("/dashboard");
}

export async function markNotificationReadAction(formData: FormData) {
  const user = await requireCurrentUser();
  const notificationId = String(formData.get("notificationId") ?? "");
  await prisma.notification.updateMany({
    where: {
      id: notificationId,
      recipientId: user.id,
    },
    data: {
      readAt: new Date(),
    },
  });

  revalidatePath("/notifications");
  revalidatePath("/dashboard");
}

export async function markAllNotificationsReadAction() {
  const user = await requireCurrentUser();
  await prisma.notification.updateMany({
    where: {
      recipientId: user.id,
      readAt: null,
    },
    data: {
      readAt: new Date(),
    },
  });

  revalidatePath("/notifications");
  revalidatePath("/dashboard");
}
