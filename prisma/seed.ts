import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { hash } from "bcryptjs";
import { PrismaClient } from "../src/generated/prisma/client";
import { defaultScannerRules, evaluateDemoScan } from "../src/domain/scanner/profile";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to seed LST Buddy.");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

const rules = defaultScannerRules();

function jsonReady(values: Record<string, number | string | boolean | null | undefined>) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value ?? null]));
}

async function resetDatabase() {
  await prisma.$transaction([
    prisma.chatMessageRead.deleteMany(),
    prisma.reaction.deleteMany(),
    prisma.notification.deleteMany(),
    prisma.activity.deleteMany(),
    prisma.comment.deleteMany(),
    prisma.stockNote.deleteMany(),
    prisma.watchlistItem.deleteMany(),
    prisma.watchlist.deleteMany(),
    prisma.recommendation.deleteMany(),
    prisma.chatMessage.deleteMany(),
    prisma.conversationMember.deleteMany(),
    prisma.conversation.deleteMany(),
    prisma.positionSnapshot.deleteMany(),
    prisma.tradeLeg.deleteMany(),
    prisma.trade.deleteMany(),
    prisma.accountSnapshot.deleteMany(),
    prisma.tradingAccount.deleteMany(),
    prisma.scanCriterionResult.deleteMany(),
    prisma.scanResult.deleteMany(),
    prisma.scanRun.deleteMany(),
    prisma.scannerRule.deleteMany(),
    prisma.scannerProfile.deleteMany(),
    prisma.optionContractSnapshot.deleteMany(),
    prisma.priceCandle.deleteMany(),
    prisma.marketQuoteCache.deleteMany(),
    prisma.brokerConnection.deleteMany(),
    prisma.pushSubscription.deleteMany(),
    prisma.session.deleteMany(),
    prisma.userSettings.deleteMany(),
    prisma.sharingPreferences.deleteMany(),
    prisma.user.deleteMany(),
  ]);
}

async function createUser(name: string, email: string, passwordHash: string) {
  return prisma.user.create({
    data: {
      name,
      email,
      passwordHash,
      settings: {
        create: {
          darkMode: true,
          enableInAppNotify: true,
          enableWebPushNotify: false,
        },
      },
      sharingPreferences: {
        create: {
          defaultTrade: "SHARED",
          defaultPosition: "SHARED",
          defaultWatchlist: "SHARED",
          defaultNote: "SHARED",
          defaultRecommendation: "SHARED",
          defaultAccountBalance: "PRIVATE",
          defaultDollarPL: "PRIVATE",
          defaultPercentPL: "SHARED",
        },
      },
    },
  });
}

async function createScannerProfile(ownerId: string) {
  const profile = await prisma.scannerProfile.create({
    data: {
      ownerId,
      name: "My LST",
      visibility: "PRIVATE",
      rules: {
        create: rules.map((rule, index) => ({
          key: rule.key,
          name: rule.name,
          operator: rule.operator,
          valueJson: { desired: rule.desired },
          sortOrder: index,
        })),
      },
    },
  });

  const run = await prisma.scanRun.create({
    data: {
      profileId: profile.id,
      ownerId,
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
}

async function main() {
  const devPassword = process.env.DEV_SEED_PASSWORD ?? "lstbuddy-dev-only";
  const passwordHash = await hash(devPassword, 10);
  const openedAt = new Date("2026-08-21T14:10:00Z");
  const expiration = new Date("2026-09-18T20:00:00Z");

  await resetDatabase();

  const matt = await createUser("Matt", "matt@lst.local", passwordHash);
  const eric = await createUser("Eric", "eric@lst.local", passwordHash);

  const mattAccount = await prisma.tradingAccount.create({
    data: {
      userId: matt.id,
      name: "Matt Manual CSP",
      brokerName: "Manual demo",
      visibility: "PRIVATE",
      snapshots: {
        create: {
          accountValue: "52640.00",
          cash: "31280.00",
          cashSecuringPuts: "1650.00",
          availableCash: "29630.00",
          realizedPL: "840.00",
          unrealizedPL: "21.00",
          premiumCollected: "1260.00",
        },
      },
    },
  });

  const ericAccount = await prisma.tradingAccount.create({
    data: {
      userId: eric.id,
      name: "Eric Manual CSP",
      brokerName: "Manual demo",
      visibility: "PRIVATE",
      snapshots: {
        create: {
          accountValue: "48720.00",
          cash: "28100.00",
          cashSecuringPuts: "1800.00",
          availableCash: "26300.00",
          realizedPL: "620.00",
          unrealizedPL: "-14.00",
          premiumCollected: "980.00",
        },
      },
    },
  });

  await prisma.trade.create({
    data: {
      userId: matt.id,
      accountId: mattAccount.id,
      strategy: "CASH_SECURED_PUT",
      symbol: "CORZ",
      contracts: 1,
      status: "OPEN",
      visibility: "SHARED",
      openedAt,
      notes: "DEMO DATA: manual CORZ CSP example for Phase 1.",
      legs: {
        create: {
          action: "SELL_TO_OPEN",
          symbol: "CORZ 2026-09-18 P16.5",
          contracts: 1,
          strike: "16.50",
          expiration,
          openedAt,
          premium: "0.2600",
          price: "0.2600",
          fees: "0.00",
          delta: "-0.1800",
          gamma: "0.0450",
          theta: "-0.0120",
          vega: "0.0220",
        },
      },
      positionSnapshots: {
        create: {
          stockPrice: "16.89",
          optionBid: "0.0400",
          optionAsk: "0.0600",
          optionMark: "0.0500",
          delta: "-0.1800",
          gamma: "0.0450",
          theta: "-0.0120",
          vega: "0.0220",
          impliedVolatility: "0.7200",
          openInterest: 840,
          optionVolume: 126,
        },
      },
    },
  });

  await prisma.trade.create({
    data: {
      userId: eric.id,
      accountId: ericAccount.id,
      strategy: "CASH_SECURED_PUT",
      symbol: "SOFI",
      contracts: 1,
      status: "OPEN",
      visibility: "PRIVATE",
      openedAt: new Date("2026-08-24T15:05:00Z"),
      notes: "Private demo SOFI CSP for authorization tests and UI.",
      legs: {
        create: {
          action: "SELL_TO_OPEN",
          symbol: "SOFI 2026-09-18 P18",
          contracts: 1,
          strike: "18.00",
          expiration,
          openedAt: new Date("2026-08-24T15:05:00Z"),
          premium: "0.3100",
          price: "0.3100",
          fees: "0.00",
        },
      },
      positionSnapshots: {
        create: {
          stockPrice: "18.42",
          optionBid: "0.1400",
          optionAsk: "0.1800",
          optionMark: "0.1600",
          delta: "-0.2400",
          gamma: "0.0380",
          theta: "-0.0150",
          vega: "0.0260",
          impliedVolatility: "0.6100",
          openInterest: 520,
          optionVolume: 88,
        },
      },
    },
  });

  const mattWatchlist = await prisma.watchlist.create({
    data: {
      ownerId: matt.id,
      name: "Matt LST Watchlist",
      visibility: "SHARED",
    },
  });

  const ericWatchlist = await prisma.watchlist.create({
    data: {
      ownerId: eric.id,
      name: "Eric LST Watchlist",
      visibility: "SHARED",
    },
  });

  const mattCorz = await prisma.watchlistItem.create({
    data: {
      watchlistId: mattWatchlist.id,
      ownerId: matt.id,
      ticker: "CORZ",
      status: "RESEARCHING",
      visibility: "SHARED",
      tags: ["RSI", "Premium", "Worth researching"],
      notes: {
        create: [
          { ownerId: matt.id, ticker: "CORZ", category: "PRO", body: "RSI and Bollinger position look reasonable.", visibility: "SHARED" },
          { ownerId: matt.id, ticker: "CORZ", category: "CON", body: "Bid/ask spread needs patience.", visibility: "SHARED" },
        ],
      },
    },
  });

  await prisma.watchlistItem.create({
    data: {
      watchlistId: mattWatchlist.id,
      ownerId: matt.id,
      ticker: "IONQ",
      status: "WATCHING",
      visibility: "PRIVATE",
      tags: ["speculative", "private"],
      notes: {
        create: [
          { ownerId: matt.id, ticker: "IONQ", category: "PRO", body: "Demo private note for Matt.", visibility: "PRIVATE" },
        ],
      },
    },
  });

  const ericSofi = await prisma.watchlistItem.create({
    data: {
      watchlistId: ericWatchlist.id,
      ownerId: eric.id,
      ticker: "SOFI",
      status: "WATCHING",
      visibility: "SHARED",
      tags: ["Premium", "Support"],
      notes: {
        create: [
          { ownerId: eric.id, ticker: "SOFI", category: "PRO", body: "Good demo liquidity.", visibility: "SHARED" },
          { ownerId: eric.id, ticker: "SOFI", category: "CON", body: "RSI is above Matt's seeded threshold.", visibility: "SHARED" },
        ],
      },
    },
  });

  await prisma.watchlistItem.create({
    data: {
      watchlistId: ericWatchlist.id,
      ownerId: eric.id,
      ticker: "AMD",
      status: "WATCHING",
      visibility: "PRIVATE",
      tags: ["private"],
    },
  });

  const recommendation = await prisma.recommendation.create({
    data: {
      senderId: eric.id,
      recipientId: matt.id,
      ticker: "CORZ",
      message: "Take a look at the $16.50 area.",
      reasonTags: ["Scanner looks good", "Premium", "Worth researching"],
      visibility: "SHARED",
      comments: {
        create: {
          authorId: matt.id,
          ticker: "CORZ",
          body: "Added it to the watchlist. Spread is the main yellow flag.",
          visibility: "SHARED",
        },
      },
    },
  });

  const conversation = await prisma.conversation.create({
    data: {
      title: "Matt and Eric",
      type: "PRIVATE",
      members: {
        create: [
          { userId: matt.id, lastReadAt: new Date("2026-08-28T14:24:00Z") },
          { userId: eric.id, lastReadAt: new Date("2026-08-28T14:22:00Z") },
        ],
      },
      messages: {
        create: [
          {
            senderId: eric.id,
            ticker: "CORZ",
            body: "CORZ is interesting if it sticks near support.",
            createdAt: new Date("2026-08-28T13:40:00Z"),
          },
          {
            senderId: matt.id,
            ticker: "CORZ",
            body: "I like the premium, but I want the spread tighter.",
            createdAt: new Date("2026-08-28T14:02:00Z"),
          },
          {
            senderId: eric.id,
            body: "Rules first. No chasing.",
            createdAt: new Date("2026-08-28T14:18:00Z"),
          },
        ],
      },
    },
  });

  await prisma.comment.create({
    data: {
      authorId: eric.id,
      watchlistItemId: mattCorz.id,
      ticker: "CORZ",
      body: "Atta boy for waiting on the spread.",
      visibility: "SHARED",
    },
  });

  const activity = await prisma.activity.create({
    data: {
      actorId: matt.id,
      type: "TRADE",
      title: "Matt logged a CORZ CSP",
      body: "Demo/manual entry with risk numbers visible.",
      ticker: "CORZ",
      visibility: "SHARED",
    },
  });

  await prisma.reaction.createMany({
    data: [
      {
        actorId: eric.id,
        kind: "ATTA_BOY",
        targetType: "WATCHLIST_ITEM",
        watchlistItemId: mattCorz.id,
      },
      {
        actorId: matt.id,
        kind: "ATTA_BOY",
        targetType: "WATCHLIST_ITEM",
        watchlistItemId: ericSofi.id,
      },
      {
        actorId: eric.id,
        kind: "NICE_MANAGEMENT",
        targetType: "ACTIVITY",
        activityId: activity.id,
      },
      {
        actorId: matt.id,
        kind: "CHECKING",
        targetType: "RECOMMENDATION",
        recommendationId: recommendation.id,
      },
    ],
  });

  await prisma.notification.createMany({
    data: [
      {
        recipientId: matt.id,
        actorId: eric.id,
        type: "RECOMMENDATION",
        title: "Eric recommended CORZ",
        body: "Take a look at the $16.50 area.",
        href: "/recommendations",
      },
      {
        recipientId: matt.id,
        actorId: eric.id,
        type: "MESSAGE",
        title: "Eric sent you a message",
        body: "Rules first. No chasing.",
        href: "/chat",
      },
      {
        recipientId: eric.id,
        actorId: matt.id,
        type: "COMMENT",
        title: "Matt commented on CORZ",
        body: "Spread is the main yellow flag.",
        href: "/recommendations",
      },
      {
        recipientId: matt.id,
        actorId: eric.id,
        type: "REACTION",
        title: "Eric sent an Atta Boy",
        body: "On CORZ.",
        href: "/watchlist",
      },
    ],
  });

  await createScannerProfile(matt.id);
  await createScannerProfile(eric.id);

  await prisma.marketQuoteCache.createMany({
    data: [
      { symbol: "CORZ", price: "16.89", change: "0.21", changePercent: "1.2600", asOf: new Date("2026-08-28T14:45:00Z") },
      { symbol: "SOFI", price: "18.42", change: "-0.14", changePercent: "-0.7500", asOf: new Date("2026-08-28T14:45:00Z") },
      { symbol: "AMD", price: "156.20", change: "1.88", changePercent: "1.2200", asOf: new Date("2026-08-28T14:45:00Z") },
    ],
  });

  await prisma.optionContractSnapshot.create({
    data: {
      symbol: "CORZ 2026-09-18 P16.5",
      underlyingSymbol: "CORZ",
      optionType: "PUT",
      strike: "16.50",
      expiration,
      bid: "0.0400",
      ask: "0.0600",
      mark: "0.0500",
      last: "0.0500",
      delta: "-0.1800",
      gamma: "0.0450",
      theta: "-0.0120",
      vega: "0.0220",
      impliedVolatility: "0.7200",
      openInterest: 840,
      volume: 126,
    },
  });

  await prisma.brokerConnection.createMany({
    data: [
      {
        userId: matt.id,
        provider: "MOCK",
        label: "Mock read-only account",
        status: "MOCK",
        metadata: { phase: 1, tradingDisabled: true },
      },
      {
        userId: eric.id,
        provider: "MOCK",
        label: "Mock read-only account",
        status: "MOCK",
        metadata: { phase: 1, tradingDisabled: true },
      },
    ],
  });

  await prisma.chatMessageRead.createMany({
    data: conversation.id
      ? [
          { messageId: (await prisma.chatMessage.findFirstOrThrow({ where: { conversationId: conversation.id }, orderBy: { createdAt: "asc" } })).id, userId: matt.id },
        ]
      : [],
  });

  console.log(`Seeded LST Buddy demo data for Matt and Eric. Development password source: DEV_SEED_PASSWORD${process.env.DEV_SEED_PASSWORD ? "" : " default"}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
