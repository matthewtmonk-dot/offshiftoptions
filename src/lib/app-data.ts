import "server-only";

import { prisma } from "./prisma";

export type TrackerScope = "mine" | "buddy" | "both";

export function normalizeTrackerScope(value: unknown): TrackerScope {
  return value === "buddy" || value === "both" ? value : "mine";
}

export async function getUnreadNotificationCount(userId: string) {
  return prisma.notification.count({
    where: {
      recipientId: userId,
      readAt: null,
    },
  });
}

export async function getDashboardData(userId: string) {
  const [account, ownAccounts, openCampaigns, completedCampaigns, openTrades, watchlistItems, incomingRecommendations, activities, conversation, profile] =
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
      prisma.tradingAccount.findMany({
        where: { userId },
        include: { ledgerEntries: { orderBy: { occurredAt: "asc" } } },
      }),
      prisma.campaign.findMany({
        where: { ownerId: userId, status: { in: ["OPEN", "ASSIGNED"] } },
        orderBy: { openedAt: "desc" },
        include: { events: { orderBy: [{ occurredAt: "asc" }, { sortOrder: "asc" }] } },
      }),
      prisma.campaign.findMany({
        where: { ownerId: userId, status: "CLOSED" },
        include: { events: { orderBy: [{ occurredAt: "asc" }, { sortOrder: "asc" }] } },
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
    ownAccounts,
    openCampaigns,
    completedCampaigns,
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

/**
 * Research (formerly "Watchlist") - a user's personal judgment of tickers as company/trade
 * candidates. Returns the user's own items (all statuses/visibilities), any buddy items
 * explicitly shared with this user (never merged with the viewer's own - see
 * PROJECT_HANDOFF.md Research section on preserving disagreement), the user's most recent
 * scan run (to show live Scanner status/score/RSI/BB next to each researched ticker without
 * a second network call), and the user's own campaign history (to show "what have I done
 * with this stock before" per ticker).
 */
export async function getResearchPageData(userId: string) {
  const [users, ownWatchlist, visibleItems, latestRun, campaigns] = await Promise.all([
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
    prisma.scanRun.findFirst({
      where: { ownerId: userId },
      orderBy: { createdAt: "desc" },
      include: { results: { include: { criterionResults: true } } },
    }),
    prisma.campaign.findMany({
      where: { ownerId: userId },
      orderBy: { openedAt: "desc" },
      include: { events: { orderBy: [{ occurredAt: "asc" }, { sortOrder: "asc" }] } },
    }),
  ]);

  return { users, ownWatchlist, visibleItems, latestRun, campaigns };
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

type TrackerPageDataOptions = {
  includeLegacyTrades?: boolean;
  includePerformanceCampaigns?: boolean;
};

export async function getTrackerPageData(userId: string, scope: TrackerScope, options: TrackerPageDataOptions = {}) {
  const includeLegacyTrades = options.includeLegacyTrades ?? true;
  const includePerformanceCampaigns = options.includePerformanceCampaigns ?? true;
  const buddyCampaignWhere = {
    ownerId: { not: userId },
    OR: [{ visibility: "SHARED" as const }, { visibility: "INHERIT" as const, account: { visibility: "SHARED" as const } }],
  };
  const campaignWhere =
    scope === "mine"
      ? { ownerId: userId }
      : scope === "buddy"
        ? buddyCampaignWhere
        : { OR: [{ ownerId: userId }, buddyCampaignWhere] };
  const buddyAccountWhere = { userId: { not: userId }, visibility: "SHARED" as const };
  const accountWhere =
    scope === "mine"
      ? { userId }
      : scope === "buddy"
        ? buddyAccountWhere
        : { OR: [{ userId }, buddyAccountWhere] };

  const [users, ownAccounts, visibleAccounts, campaigns, ownPerformanceCampaigns, legacyTrades] = await Promise.all([
    prisma.user.findMany({ where: { id: { not: userId } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.tradingAccount.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      include: {
        snapshots: { orderBy: { capturedAt: "desc" }, take: 1 },
        ledgerEntries: { orderBy: { occurredAt: "asc" } },
        _count: { select: { campaigns: true } },
      },
    }),
    prisma.tradingAccount.findMany({
      where: accountWhere,
      orderBy: [{ user: { name: "asc" } }, { createdAt: "asc" }],
      include: {
        user: { select: { id: true, name: true } },
        snapshots: { orderBy: { capturedAt: "desc" }, take: 1 },
        ledgerEntries: { orderBy: { occurredAt: "asc" } },
        _count: { select: { campaigns: true } },
      },
    }),
    prisma.campaign.findMany({
      where: campaignWhere,
      orderBy: [{ status: "asc" }, { openedAt: "desc" }],
      include: {
        owner: { select: { id: true, name: true } },
        account: {
          select: {
            id: true,
            userId: true,
            name: true,
            accountType: true,
            visibility: true,
            manualBalance: true,
            startingBalance: true,
          },
        },
        events: { orderBy: [{ occurredAt: "asc" }, { sortOrder: "asc" }] },
      },
    }),
    includePerformanceCampaigns
      ? prisma.campaign.findMany({
          // ALWAYS scoped to the current user regardless of `scope` - performance/win-rate must
          // never silently combine Matt and Eric's results into one figure (see PROJECT_HANDOFF.md).
          where: { ownerId: userId },
          orderBy: [{ status: "asc" }, { openedAt: "desc" }],
          include: {
            events: { orderBy: [{ occurredAt: "asc" }, { sortOrder: "asc" }] },
            linkedBrokerRecords: {
              where: {
                userId,
                provider: "SCHWAB",
                kind: "POSITION",
                status: "CONFIRMED",
              },
              orderBy: [{ observedAt: "desc" }, { updatedAt: "desc" }],
              select: {
                id: true,
                accountId: true,
                symbol: true,
                underlyingSymbol: true,
                quantity: true,
                amount: true,
                observedAt: true,
                metadata: true,
              },
            },
          },
        })
      : Promise.resolve([]),
    includeLegacyTrades ? getPositionsPageData(userId) : Promise.resolve([]),
  ]);

  const optionMarksForPerformance = includePerformanceCampaigns
    ? await loadLatestOptionMarksForCampaigns(ownPerformanceCampaigns)
    : [];
  const ownCompletedCampaigns = ownPerformanceCampaigns.filter((campaign) => campaign.status === "CLOSED");

  return {
    users,
    ownAccounts,
    visibleAccounts,
    campaigns,
    ownCompletedCampaigns,
    ownPerformanceCampaigns,
    optionMarksForPerformance,
    legacyTrades,
  };
}

type CampaignWithEventsForMarks = {
  ticker: string;
  events: Array<{
    type: string;
    optionType: string | null;
    strike: unknown;
    expiration: Date | null;
  }>;
};

async function loadLatestOptionMarksForCampaigns(campaigns: CampaignWithEventsForMarks[]) {
  const underlyings = [
    ...new Set(campaigns.map((campaign) => campaign.ticker.toUpperCase())),
  ];

  if (underlyings.length === 0) {
    return [];
  }

  const snapshots = await prisma.optionContractSnapshot.findMany({
    where: {
      underlyingSymbol: { in: underlyings },
      optionType: "PUT",
    },
    orderBy: [{ capturedAt: "desc" }],
    select: {
      id: true,
      symbol: true,
      underlyingSymbol: true,
      optionType: true,
      strike: true,
      expiration: true,
      bid: true,
      ask: true,
      mark: true,
      capturedAt: true,
    },
  });

  const latestByContract = new Map<string, (typeof snapshots)[number]>();
  for (const snapshot of snapshots) {
    const key = optionContractKey(snapshot.underlyingSymbol, snapshot.expiration, snapshot.strike, snapshot.optionType);
    if (!latestByContract.has(key)) {
      latestByContract.set(key, snapshot);
    }
  }

  return [...latestByContract.values()];
}

export function optionContractKey(
  underlyingSymbol: string,
  expiration: Date | string,
  strike: unknown,
  optionType: string,
) {
  return [
    underlyingSymbol.toUpperCase(),
    toDateKey(expiration),
    decimalKey(strike),
    optionType.toUpperCase(),
  ].join("|");
}

function toDateKey(value: Date | string) {
  return (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10);
}

function decimalKey(value: unknown) {
  const candidate = value as { toNumber?: () => number; toString?: () => string };
  const parsed =
    typeof value === "number"
      ? value
      : typeof candidate?.toNumber === "function"
        ? candidate.toNumber()
        : Number(candidate?.toString?.() ?? value);
  return Number.isFinite(parsed) ? parsed.toFixed(4) : String(value);
}

export async function getAccountPageData(userId: string) {
  const [accounts, completedCampaigns] = await Promise.all([
    prisma.tradingAccount.findMany({
      where: { userId },
      orderBy: [{ source: "asc" }, { createdAt: "asc" }],
      include: {
        ledgerEntries: { orderBy: { occurredAt: "asc" } },
      },
    }),
    prisma.campaign.findMany({
      where: { ownerId: userId, status: "CLOSED" },
      include: { events: { orderBy: [{ occurredAt: "asc" }, { sortOrder: "asc" }] } },
    }),
  ]);

  return { accounts, completedCampaigns };
}
