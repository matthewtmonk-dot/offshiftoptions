import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { hash } from "bcryptjs";
import { PrismaClient } from "../src/generated/prisma/client";
import { defaultScannerRules, evaluateDemoScan, SCANNER_RULE_DEFINITIONS } from "../src/domain/scanner/profile";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to seed Off Shift Options.");
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
    prisma.campaignEvent.deleteMany(),
    prisma.campaign.deleteMany(),
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
      // enabled must come from each definition's defaultEnabled (LST Core), not the
      // schema column default - otherwise every seeded profile starts with every rule
      // (including preference-only ones) turned on instead of matching LST Core.
      rules: {
        create: SCANNER_RULE_DEFINITIONS.map((definition, index) => ({
          key: definition.key,
          name: definition.name,
          operator: definition.operator,
          valueJson: { desired: definition.defaultDesired },
          enabled: definition.defaultEnabled,
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

function demoCampaignSnapshot(ticker: string) {
  const candidate = evaluateDemoScan(rules).find((result) => result.ticker === ticker);
  if (!candidate) {
    return undefined;
  }

  return {
    source: "DEMO",
    capturedAt: "2026-08-28T14:45:00.000Z",
    profileName: "My LST",
    scannerStatus: candidate.summary.status,
    passedCriteria: candidate.summary.passed,
    totalCriteria: candidate.summary.total,
    values: jsonReady(candidate.values),
  };
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
      name: "Matt IRA",
      brokerName: "Manual demo",
      accountType: "IRA",
      startingBalance: "10000.00",
      manualBalance: "10482.00",
      visibility: "SHARED",
      snapshots: {
        create: {
          accountValue: "10482.00",
          cash: "7290.00",
          cashSecuringPuts: "3192.00",
          availableCash: "7290.00",
          realizedPL: "482.00",
          unrealizedPL: "21.00",
          premiumCollected: "715.00",
        },
      },
      // The ledger, not startingBalance/manualBalance, is the source of truth for the
      // Account/Performance/Tracker views - seed it so demo accounts don't show "No data".
      ledgerEntries: {
        create: { type: "STARTING_VALUE", occurredAt: new Date("2026-07-01T00:00:00Z"), amount: "10000.00", source: "MANUAL" },
      },
    },
  });

  const ericAccount = await prisma.tradingAccount.create({
    data: {
      userId: eric.id,
      name: "Eric IRA",
      brokerName: "Manual demo",
      accountType: "IRA",
      startingBalance: "10000.00",
      manualBalance: "10192.00",
      visibility: "SHARED",
      snapshots: {
        create: {
          accountValue: "10192.00",
          cash: "6792.00",
          cashSecuringPuts: "3400.00",
          availableCash: "6792.00",
          realizedPL: "192.00",
          unrealizedPL: "-14.00",
          premiumCollected: "380.00",
        },
      },
      ledgerEntries: {
        create: { type: "STARTING_VALUE", occurredAt: new Date("2026-07-01T00:00:00Z"), amount: "10000.00", source: "MANUAL" },
      },
    },
  });

  const paperAccount = await prisma.tradingAccount.create({
    data: {
      userId: matt.id,
      name: "Playground / Paper",
      brokerName: "Manual demo",
      accountType: "Paper",
      startingBalance: "5000.00",
      manualBalance: "5036.00",
      visibility: "PRIVATE",
      snapshots: {
        create: {
          accountValue: "5036.00",
          cash: "5036.00",
          cashSecuringPuts: "0.00",
          availableCash: "5036.00",
          realizedPL: "36.00",
          unrealizedPL: "0.00",
          premiumCollected: "36.00",
        },
      },
      ledgerEntries: {
        create: { type: "STARTING_VALUE", occurredAt: new Date("2026-07-01T00:00:00Z"), amount: "5000.00", source: "MANUAL" },
      },
    },
  });

  await prisma.campaign.create({
    data: {
      ownerId: matt.id,
      accountId: mattAccount.id,
      ticker: "BROS",
      strategy: "CASH_SECURED_PUT",
      status: "CLOSED",
      visibility: "INHERIT",
      openedAt: new Date("2026-07-31T14:05:00Z"),
      closedAt: new Date("2026-08-07T18:30:00Z"),
      thesis: "Simple demo CSP that closed after most of the premium came out.",
      events: {
        create: [
          {
            type: "SELL_PUT",
            occurredAt: new Date("2026-07-31T14:05:00Z"),
            sortOrder: 0,
            optionType: "PUT",
            contracts: 1,
            strike: "45.00",
            expiration: new Date("2026-08-21T20:00:00Z"),
            premium: "0.8400",
          },
          {
            type: "CLOSE_PUT",
            occurredAt: new Date("2026-08-07T18:30:00Z"),
            sortOrder: 1,
            optionType: "PUT",
            contracts: 1,
            strike: "45.00",
            expiration: new Date("2026-08-21T20:00:00Z"),
            premium: "0.1800",
            notes: "Locked in the easy part and moved on.",
          },
        ],
      },
    },
  });

  await prisma.campaign.create({
    data: {
      ownerId: matt.id,
      accountId: mattAccount.id,
      ticker: "IONQ",
      strategy: "CASH_SECURED_PUT",
      status: "OPEN",
      visibility: "INHERIT",
      openedAt: new Date("2026-08-28T14:00:00Z"),
      thesis: "Open CSP from the current demo scanner universe.",
      entrySnapshotJson: demoCampaignSnapshot("IONQ"),
      events: {
        create: {
          type: "SELL_PUT",
          occurredAt: new Date("2026-08-28T14:00:00Z"),
          sortOrder: 0,
          optionType: "PUT",
          contracts: 1,
          strike: "27.00",
          expiration: new Date("2026-09-18T20:00:00Z"),
          premium: "0.3200",
        },
      },
    },
  });

  await prisma.campaign.create({
    data: {
      ownerId: matt.id,
      accountId: mattAccount.id,
      ticker: "AAP",
      strategy: "CASH_SECURED_PUT",
      status: "OPEN",
      visibility: "INHERIT",
      openedAt: new Date("2026-08-21T14:00:00Z"),
      thesis: "Demo campaign showing a roll that preserves the original leg.",
      entrySnapshotJson: demoCampaignSnapshot("AAP"),
      events: {
        create: [
          {
            type: "SELL_PUT",
            occurredAt: new Date("2026-08-21T14:00:00Z"),
            sortOrder: 0,
            optionType: "PUT",
            contracts: 1,
            strike: "40.00",
            expiration: new Date("2026-09-04T20:00:00Z"),
            premium: "0.4800",
          },
          {
            type: "ROLL_PUT_CLOSE",
            occurredAt: new Date("2026-08-28T14:15:00Z"),
            sortOrder: 1,
            groupKey: "aap-roll-1",
            optionType: "PUT",
            contracts: 1,
            strike: "40.00",
            expiration: new Date("2026-09-04T20:00:00Z"),
            premium: "0.7100",
          },
          {
            type: "ROLL_PUT_OPEN",
            occurredAt: new Date("2026-08-28T14:16:00Z"),
            sortOrder: 2,
            groupKey: "aap-roll-1",
            optionType: "PUT",
            contracts: 1,
            strike: "39.00",
            expiration: new Date("2026-09-11T20:00:00Z"),
            premium: "1.0200",
            notes: "Net roll credit is positive while moving the strike down.",
          },
        ],
      },
    },
  });

  await prisma.campaign.create({
    data: {
      ownerId: matt.id,
      accountId: mattAccount.id,
      ticker: "SOFI",
      strategy: "CASH_SECURED_PUT",
      status: "CLOSED",
      visibility: "INHERIT",
      openedAt: new Date("2026-08-05T14:00:00Z"),
      closedAt: new Date("2026-08-28T18:30:00Z"),
      thesis: "Multiple rolls that eventually close positive.",
      entrySnapshotJson: demoCampaignSnapshot("SOFI"),
      events: {
        create: [
          {
            type: "SELL_PUT",
            occurredAt: new Date("2026-08-05T14:00:00Z"),
            sortOrder: 0,
            optionType: "PUT",
            contracts: 1,
            strike: "18.00",
            expiration: new Date("2026-08-14T20:00:00Z"),
            premium: "0.3600",
          },
          {
            type: "ROLL_PUT_CLOSE",
            occurredAt: new Date("2026-08-12T15:00:00Z"),
            sortOrder: 1,
            groupKey: "sofi-roll-1",
            optionType: "PUT",
            contracts: 1,
            strike: "18.00",
            expiration: new Date("2026-08-14T20:00:00Z"),
            premium: "0.5200",
          },
          {
            type: "ROLL_PUT_OPEN",
            occurredAt: new Date("2026-08-12T15:01:00Z"),
            sortOrder: 2,
            groupKey: "sofi-roll-1",
            optionType: "PUT",
            contracts: 1,
            strike: "17.50",
            expiration: new Date("2026-08-21T20:00:00Z"),
            premium: "0.8800",
          },
          {
            type: "ROLL_PUT_CLOSE",
            occurredAt: new Date("2026-08-19T15:00:00Z"),
            sortOrder: 3,
            groupKey: "sofi-roll-2",
            optionType: "PUT",
            contracts: 1,
            strike: "17.50",
            expiration: new Date("2026-08-21T20:00:00Z"),
            premium: "0.4400",
          },
          {
            type: "ROLL_PUT_OPEN",
            occurredAt: new Date("2026-08-19T15:01:00Z"),
            sortOrder: 4,
            groupKey: "sofi-roll-2",
            optionType: "PUT",
            contracts: 1,
            strike: "17.00",
            expiration: new Date("2026-08-28T20:00:00Z"),
            premium: "0.7600",
          },
          {
            type: "CLOSE_PUT",
            occurredAt: new Date("2026-08-28T18:30:00Z"),
            sortOrder: 5,
            optionType: "PUT",
            contracts: 1,
            strike: "17.00",
            expiration: new Date("2026-08-28T20:00:00Z"),
            premium: "0.2100",
            notes: "A little messy, still green.",
          },
        ],
      },
    },
  });

  await prisma.campaign.create({
    data: {
      ownerId: matt.id,
      accountId: mattAccount.id,
      ticker: "F",
      strategy: "WHEEL",
      status: "ASSIGNED",
      visibility: "INHERIT",
      openedAt: new Date("2026-07-17T14:00:00Z"),
      thesis: "Assigned CSP followed by covered call premium.",
      entrySnapshotJson: demoCampaignSnapshot("F"),
      events: {
        create: [
          {
            type: "SELL_PUT",
            occurredAt: new Date("2026-07-17T14:00:00Z"),
            sortOrder: 0,
            optionType: "PUT",
            contracts: 1,
            strike: "11.50",
            expiration: new Date("2026-08-14T20:00:00Z"),
            premium: "0.2200",
          },
          {
            type: "ASSIGNMENT",
            occurredAt: new Date("2026-08-14T20:30:00Z"),
            sortOrder: 1,
            optionType: "PUT",
            contracts: 1,
            shares: 100,
            strike: "11.50",
            expiration: new Date("2026-08-14T20:00:00Z"),
          },
          {
            type: "SELL_COVERED_CALL",
            occurredAt: new Date("2026-08-17T14:00:00Z"),
            sortOrder: 2,
            optionType: "CALL",
            contracts: 1,
            strike: "12.00",
            expiration: new Date("2026-08-28T20:00:00Z"),
            premium: "0.1800",
          },
          {
            type: "COVERED_CALL_EXPIRED",
            occurredAt: new Date("2026-08-28T20:00:00Z"),
            sortOrder: 3,
            optionType: "CALL",
            contracts: 1,
            strike: "12.00",
            expiration: new Date("2026-08-28T20:00:00Z"),
            notes: "Kept the shares and the call premium.",
          },
          {
            type: "SELL_COVERED_CALL",
            occurredAt: new Date("2026-08-28T20:10:00Z"),
            sortOrder: 4,
            optionType: "CALL",
            contracts: 1,
            strike: "12.50",
            expiration: new Date("2026-09-18T20:00:00Z"),
            premium: "0.1600",
          },
        ],
      },
    },
  });

  await prisma.campaign.create({
    data: {
      ownerId: matt.id,
      accountId: mattAccount.id,
      ticker: "ROKU",
      strategy: "CASH_SECURED_PUT",
      status: "CLOSED",
      visibility: "INHERIT",
      openedAt: new Date("2026-08-14T14:00:00Z"),
      closedAt: new Date("2026-08-20T18:30:00Z"),
      thesis: "Losing campaign example so red outcomes are represented honestly.",
      entrySnapshotJson: demoCampaignSnapshot("ROKU"),
      events: {
        create: [
          {
            type: "SELL_PUT",
            occurredAt: new Date("2026-08-14T14:00:00Z"),
            sortOrder: 0,
            optionType: "PUT",
            contracts: 1,
            strike: "62.00",
            expiration: new Date("2026-09-18T20:00:00Z"),
            premium: "0.6200",
          },
          {
            type: "CLOSE_PUT",
            occurredAt: new Date("2026-08-20T18:30:00Z"),
            sortOrder: 1,
            optionType: "PUT",
            contracts: 1,
            strike: "62.00",
            expiration: new Date("2026-09-18T20:00:00Z"),
            premium: "1.3500",
            notes: "Took the loss and protected the account.",
          },
        ],
      },
    },
  });

  await prisma.campaign.create({
    data: {
      ownerId: matt.id,
      accountId: paperAccount.id,
      ticker: "WBD",
      strategy: "CASH_SECURED_PUT",
      status: "OPEN",
      visibility: "PRIVATE",
      openedAt: new Date("2026-08-28T15:05:00Z"),
      thesis: "Private paper/demo campaign for visibility testing.",
      entrySnapshotJson: demoCampaignSnapshot("WBD"),
      events: {
        create: {
          type: "SELL_PUT",
          occurredAt: new Date("2026-08-28T15:05:00Z"),
          sortOrder: 0,
          optionType: "PUT",
          contracts: 1,
          strike: "14.00",
          expiration: new Date("2026-09-18T20:00:00Z"),
          premium: "0.1000",
          notes: "Explicitly private even though campaigns usually follow the account.",
        },
      },
    },
  });

  await prisma.campaign.create({
    data: {
      ownerId: eric.id,
      accountId: ericAccount.id,
      ticker: "HOOD",
      strategy: "CASH_SECURED_PUT",
      status: "OPEN",
      visibility: "INHERIT",
      openedAt: new Date("2026-08-28T15:20:00Z"),
      thesis: "Eric shared open CSP from the demo scanner universe.",
      entrySnapshotJson: demoCampaignSnapshot("HOOD"),
      events: {
        create: {
          type: "SELL_PUT",
          occurredAt: new Date("2026-08-28T15:20:00Z"),
          sortOrder: 0,
          optionType: "PUT",
          contracts: 1,
          strike: "34.00",
          expiration: new Date("2026-09-18T20:00:00Z"),
          premium: "0.4600",
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

  console.log(`Seeded Off Shift Options demo data for Matt and Eric. Development password source: DEV_SEED_PASSWORD${process.env.DEV_SEED_PASSWORD ? "" : " default"}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
