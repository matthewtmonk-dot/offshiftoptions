import "server-only";

import { prisma } from "./prisma";

export async function getUnreadNotificationCount(userId: string) {
  return prisma.notification.count({
    where: {
      recipientId: userId,
      readAt: null,
    },
  });
}

export async function getDashboardData(userId: string) {
  const [account, openTrades, watchlistItems, incomingRecommendations, activities, conversation, profile] =
    await Promise.all([
      prisma.tradingAccount.findFirst({
        where: { userId },
        include: {
          snapshots: {
            orderBy: { capturedAt: "desc" },
            take: 1,
          },
        },
      }),
      prisma.trade.findMany({
        where: { userId, status: "OPEN" },
        orderBy: { openedAt: "desc" },
        include: {
          legs: true,
          positionSnapshots: {
            orderBy: { capturedAt: "desc" },
            take: 1,
          },
        },
      }),
      prisma.watchlistItem.findMany({
        where: {
          OR: [{ ownerId: userId }, { visibility: "SHARED" }],
        },
        orderBy: { addedAt: "desc" },
        take: 6,
        include: {
          owner: true,
          notes: true,
          reactions: true,
        },
      }),
      prisma.recommendation.findMany({
        where: { recipientId: userId },
        orderBy: { createdAt: "desc" },
        take: 4,
        include: { sender: true, reactions: true },
      }),
      prisma.activity.findMany({
        where: {
          OR: [{ actorId: userId }, { visibility: "SHARED" }],
        },
        orderBy: { createdAt: "desc" },
        take: 8,
        include: { actor: true, reactions: true },
      }),
      prisma.conversation.findFirst({
        where: { members: { some: { userId } } },
        include: {
          members: { include: { user: true } },
          messages: {
            orderBy: { createdAt: "desc" },
            take: 5,
            include: { sender: true },
          },
        },
      }),
      prisma.scannerProfile.findFirst({
        where: { ownerId: userId, name: "My LST" },
        include: {
          scanRuns: {
            orderBy: { createdAt: "desc" },
            take: 1,
            include: {
              results: {
                orderBy: [{ summaryStatus: "asc" }, { ticker: "asc" }],
                include: { criterionResults: true },
              },
            },
          },
        },
      }),
    ]);

  return {
    account,
    accountSnapshot: account?.snapshots[0] ?? null,
    openTrades,
    watchlistItems,
    incomingRecommendations,
    activities,
    conversation,
    recentMessages: [...(conversation?.messages ?? [])].reverse(),
    latestScanRun: profile?.scanRuns[0] ?? null,
  };
}

export async function getScannerPageData(userId: string) {
  return prisma.scannerProfile.findFirst({
    where: { ownerId: userId, name: "My LST" },
    include: {
      rules: { orderBy: { sortOrder: "asc" } },
      scanRuns: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: {
          results: {
            orderBy: { ticker: "asc" },
            include: {
              criterionResults: {
                orderBy: { criterionName: "asc" },
              },
            },
          },
        },
      },
    },
  });
}

export async function getWatchlistPageData(userId: string) {
  const [users, ownWatchlist, visibleItems] = await Promise.all([
    prisma.user.findMany({
      where: { id: { not: userId } },
      orderBy: { name: "asc" },
    }),
    prisma.watchlist.findFirst({
      where: { ownerId: userId },
      include: {
        items: {
          orderBy: { addedAt: "desc" },
          include: {
            owner: true,
            notes: { orderBy: { createdAt: "desc" } },
            comments: {
              orderBy: { createdAt: "desc" },
              include: { author: true, reactions: true },
            },
            reactions: { include: { actor: true } },
          },
        },
      },
    }),
    prisma.watchlistItem.findMany({
      where: {
        ownerId: { not: userId },
        visibility: "SHARED",
      },
      orderBy: { addedAt: "desc" },
      include: {
        owner: true,
        notes: { where: { visibility: "SHARED" }, orderBy: { createdAt: "desc" } },
        comments: {
          where: { visibility: "SHARED" },
          orderBy: { createdAt: "desc" },
          include: { author: true, reactions: true },
        },
        reactions: { include: { actor: true } },
      },
    }),
  ]);

  return { users, ownWatchlist, visibleItems };
}

export async function getRecommendationsPageData(userId: string) {
  const [users, incoming, outgoing] = await Promise.all([
    prisma.user.findMany({ where: { id: { not: userId } }, orderBy: { name: "asc" } }),
    prisma.recommendation.findMany({
      where: { recipientId: userId },
      orderBy: { createdAt: "desc" },
      include: {
        sender: true,
        comments: { orderBy: { createdAt: "desc" }, include: { author: true } },
        reactions: { include: { actor: true } },
      },
    }),
    prisma.recommendation.findMany({
      where: { senderId: userId },
      orderBy: { createdAt: "desc" },
      include: {
        recipient: true,
        comments: { orderBy: { createdAt: "desc" }, include: { author: true } },
        reactions: { include: { actor: true } },
      },
    }),
  ]);

  return { users, incoming, outgoing };
}

export async function getChatPageData(userId: string) {
  return prisma.conversation.findFirst({
    where: { members: { some: { userId } } },
    include: {
      members: { include: { user: true } },
      messages: {
        orderBy: { createdAt: "asc" },
        include: { sender: true, reads: true },
      },
    },
  });
}

export async function getNotificationsPageData(userId: string) {
  return prisma.notification.findMany({
    where: { recipientId: userId },
    orderBy: { createdAt: "desc" },
    include: { actor: true },
  });
}

export async function getPositionsPageData(userId: string) {
  return prisma.trade.findMany({
    where: { userId },
    orderBy: { openedAt: "desc" },
    include: {
      legs: true,
      positionSnapshots: {
        orderBy: { capturedAt: "desc" },
        take: 1,
      },
      reactions: { include: { actor: true } },
      comments: { include: { author: true }, orderBy: { createdAt: "desc" } },
    },
  });
}
