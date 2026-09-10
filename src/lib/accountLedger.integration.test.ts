import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { summarizeCampaign } from "@/domain/finance/campaigns";
import { summarizeWinLoss } from "@/domain/finance/performance";
import { currentAccountValue, summarizeAccountLedger, summarizeAccountPerformance } from "@/domain/finance/accountLedger";
import { parseSchwabTransactionsCsv } from "@/providers/schwab/csv";
import { ValidationError } from "./tickers";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

maybeDescribe("account ledger, Schwab isolation, and campaign performance accounting", () => {
  let prisma: typeof import("./prisma").prisma;
  let workflows: typeof import("./workflows");
  let appData: typeof import("./app-data");
  let brokerImport: typeof import("./broker-import");
  let matt: { id: string };
  let eric: { id: string };
  const createdAccounts: string[] = [];
  const createdCampaigns: string[] = [];

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    workflows = await import("./workflows");
    appData = await import("./app-data");
    brokerImport = await import("./broker-import");
    matt = await prisma.user.findUniqueOrThrow({ where: { email: "matt@lst.local" }, select: { id: true } });
    eric = await prisma.user.findUniqueOrThrow({ where: { email: "eric@lst.local" }, select: { id: true } });
  });

  afterAll(async () => {
    await prisma.campaign.deleteMany({ where: { id: { in: createdCampaigns } } });
    await prisma.brokerRecord.deleteMany({ where: { accountId: { in: createdAccounts } } });
    await prisma.tradingAccount.deleteMany({ where: { id: { in: createdAccounts } } });
    await prisma.$disconnect();
  });

  it("defaults a new account to PRIVATE when no visibility is given", async () => {
    const account = await workflows.createTradingAccountForUser(
      matt.id,
      `Default Visibility ${Date.now()}`,
      "Manual",
      "10000",
      "10000",
      undefined,
    );
    createdAccounts.push(account.id);
    expect(account.visibility).toBe("PRIVATE");
  });

  it("auto-creates a STARTING_VALUE ledger entry and keeps deposits/withdrawals separate from trading P/L", async () => {
    const account = await workflows.createTradingAccountForUser(
      matt.id,
      `Ledger Account ${Date.now()}`,
      "Manual",
      "10000",
      "10000",
      "PRIVATE",
    );
    createdAccounts.push(account.id);

    await workflows.addAccountLedgerEntryForUser(matt.id, account.id, "DEPOSIT", "2026-08-01", "2000", "Added cash");

    const entries = await prisma.accountLedgerEntry.findMany({ where: { accountId: account.id } });
    const ledger = summarizeAccountLedger(entries);
    expect(ledger.startingValue).toBe(10000);
    expect(ledger.netContributions).toBe(2000);

    // Starting $10,000 + Deposit $2,000 + trading P/L $300 = current $12,300 - the deposit
    // must never be misread as part of the $300 trading profit.
    const current = currentAccountValue(ledger, 300);
    expect(current.value).toBe(12300);

    await workflows.addAccountLedgerEntryForUser(matt.id, account.id, "WITHDRAWAL", "2026-08-10", "500", "Took cash out");
    const afterWithdrawal = summarizeAccountLedger(
      await prisma.accountLedgerEntry.findMany({ where: { accountId: account.id } }),
    );
    expect(afterWithdrawal.netContributions).toBe(1500);
  });

  it("does not let one user log a ledger entry against another user's account", async () => {
    const account = await workflows.createTradingAccountForUser(
      matt.id,
      `Isolation Account ${Date.now()}`,
      "Manual",
      "10000",
      "10000",
      "SHARED",
    );
    createdAccounts.push(account.id);

    await expect(
      workflows.addAccountLedgerEntryForUser(eric.id, account.id, "DEPOSIT", "2026-08-01", "100", "Should fail"),
    ).rejects.toThrow(ValidationError);
  });

  it("keeps an open roll's net cash flow out of win/loss stats until the campaign actually closes", async () => {
    const account = await workflows.createTradingAccountForUser(
      matt.id,
      `Win Loss Account ${Date.now()}`,
      "Manual",
      "10000",
      "10000",
      "PRIVATE",
    );
    createdAccounts.push(account.id);

    // Worked example from the audit: +28 (sell) - 53 (roll close) + 82 (roll open) = +57 while
    // still OPEN, then a final -11 close brings it to +46 as a completed WIN.
    let campaign = await workflows.createCampaignForUser(
      matt.id,
      account.id,
      "TSTW",
      "2026-08-01",
      "2026-08-29",
      "20",
      "1",
      "0.28",
      "0",
      "Win/loss worked example",
      "PRIVATE",
    );
    createdCampaigns.push(campaign.id);

    campaign = (await workflows.rollCampaignPutForUser(
      matt.id,
      campaign.id,
      "2026-08-08",
      "0.53",
      "2026-09-05",
      "19",
      "0.82",
      "0",
      "Roll",
    ))!;

    const openSummary = summarizeCampaign({ status: campaign!.status, events: campaign!.events });
    expect(campaign!.status).toBe("OPEN");
    expect(openSummary.realizedPL).toBe(57);

    // The +57 net premium is real but unrealized-until-closed - it must not appear in
    // ownCompletedCampaigns (the source Performance/win-rate math reads from) while OPEN,
    // no matter its sign.
    const whileOpen = await appData.getTrackerPageData(matt.id, "mine");
    expect(whileOpen.ownCompletedCampaigns.some((c) => c.id === campaign!.id)).toBe(false);

    const closed = await workflows.closeCampaignPutForUser(matt.id, campaign!.id, "2026-08-29", "0.11", "0", "Final close");
    const closedSummary = summarizeCampaign({ status: closed!.status, events: closed!.events });
    expect(closed!.status).toBe("CLOSED");
    expect(closedSummary.totalCampaignPL).toBe(46);
    expect(closedSummary.finalResult).toBe("GAIN");

    const afterClose = await appData.getTrackerPageData(matt.id, "mine");
    const closedRow = afterClose.ownCompletedCampaigns.find((c) => c.id === campaign!.id);
    expect(closedRow).toBeDefined();

    const winLossAfterClose = summarizeWinLoss([
      {
        campaignId: closed!.id,
        closedAt: closed!.closedAt ?? new Date(),
        finalResult: closedSummary.finalResult,
        pl: closedSummary.totalCampaignPL,
        daysActive: closedSummary.daysActive,
      },
    ]);
    expect(winLossAfterClose.wins).toBe(1);
    expect(winLossAfterClose.losses).toBe(0);
    expect(winLossAfterClose.realizedTradingPL).toBe(46);
  });

  it("keeps Performance user-specific: a buddy's completed campaigns never appear in ownCompletedCampaigns", async () => {
    const ericAccount = await workflows.createTradingAccountForUser(
      eric.id,
      `Eric Performance Account ${Date.now()}`,
      "Manual",
      "5000",
      "5000",
      "SHARED",
    );
    createdAccounts.push(ericAccount.id);
    let ericCampaign = await workflows.createCampaignForUser(
      eric.id,
      ericAccount.id,
      "TSTE",
      "2026-08-01",
      "2026-08-15",
      "10",
      "1",
      "0.20",
      "0",
      "Eric shared closed campaign",
      "SHARED",
    );
    createdCampaigns.push(ericCampaign.id);
    ericCampaign = (await workflows.closeCampaignPutForUser(eric.id, ericCampaign.id, "2026-08-15", "0.05", "0", "Close"))!;
    expect(ericCampaign.status).toBe("CLOSED");

    // Matt views the tracker with scope "both" - Eric's now-visible shared closed campaign
    // must show up in the scope-filtered `campaigns` list but must NEVER leak into Matt's
    // always-mine `ownCompletedCampaigns`, which performance/win-rate math relies on.
    const mattTrackerData = await appData.getTrackerPageData(matt.id, "both");
    expect(mattTrackerData.campaigns.some((c) => c.id === ericCampaign.id)).toBe(true);
    expect(mattTrackerData.ownCompletedCampaigns.some((c) => c.id === ericCampaign.id)).toBe(false);
    expect(mattTrackerData.ownCompletedCampaigns.every((c) => c.ownerId === matt.id)).toBe(true);
  });

  it("derives a Schwab starting baseline and split performance from deduped broker transaction records", async () => {
    const account = await prisma.tradingAccount.create({
      data: {
        userId: matt.id,
        name: `Schwab Accounting ${Date.now()}`,
        brokerName: "Schwab",
        accountType: "Brokerage",
        source: "SCHWAB",
        externalAccountId: `acct-accounting-${Date.now()}`,
        visibility: "PRIVATE",
      },
    });
    createdAccounts.push(account.id);

    await prisma.accountLedgerEntry.create({
      data: {
        accountId: account.id,
        type: "BROKER_SNAPSHOT",
        occurredAt: new Date("2026-09-10T12:00:00Z"),
        accountValue: "10123.77",
        cash: "10123.77",
        source: "SCHWAB",
      },
    });

    const records = parseSchwabTransactionsCsv(fixture("transactions.csv"), { accountHint: account.id });
    const first = await brokerImport.persistNormalizedBrokerRecordsForUser(matt.id, account.id, records);
    const second = await brokerImport.persistNormalizedBrokerRecordsForUser(matt.id, account.id, records);
    expect(first.inserted).toBe(7);
    expect(second.inserted).toBe(0);
    expect(second.duplicatesSkipped).toBe(7);

    const stored = await prisma.brokerRecord.findMany({
      where: { userId: matt.id, accountId: account.id, kind: "TRANSACTION" },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    });
    expect(stored).toHaveLength(7);

    const summary = summarizeAccountPerformance({
      ledgerEntries: await prisma.accountLedgerEntry.findMany({ where: { accountId: account.id } }),
      brokerRecords: stored,
    });
    expect(summary.startingCapital).toBe(10_000);
    expect(summary.netContributions).toBe(0);
    expect(summary.tradingPL).toBe(123.7);
    expect(summary.otherIncome).toBe(0.07);
    expect(summary.currentValue).toBe(10_123.77);
    expect(summary.totalGain).toBe(123.77);
    expect(summary.unexplainedGain).toBe(0);
    expect(summary.totalReturnPercent).toBeCloseTo(1.2377, 4);
  });

  it("does not fetch another user's account ledger, broker records, or snapshots for shared account cards", async () => {
    const ericAccount = await prisma.tradingAccount.create({
      data: {
        userId: eric.id,
        name: `Eric Private Financials ${Date.now()}`,
        brokerName: "Schwab",
        accountType: "Brokerage",
        source: "SCHWAB",
        externalAccountId: `acct-eric-${Date.now()}`,
        visibility: "SHARED",
      },
    });
    createdAccounts.push(ericAccount.id);

    await prisma.accountLedgerEntry.createMany({
      data: [
        { accountId: ericAccount.id, type: "STARTING_VALUE", occurredAt: new Date("2026-07-20"), amount: "10000", source: "SCHWAB" },
        { accountId: ericAccount.id, type: "BROKER_SNAPSHOT", occurredAt: new Date("2026-09-10T12:00:00Z"), accountValue: "10123.77", cash: "10123.77", source: "SCHWAB" },
      ],
    });
    await brokerImport.persistNormalizedBrokerRecordsForUser(
      eric.id,
      ericAccount.id,
      parseSchwabTransactionsCsv(fixture("transactions.csv"), { accountHint: ericAccount.id }),
    );

    const mattData = await appData.getTrackerPageData(matt.id, "both");
    const visibleEricAccount = mattData.visibleAccounts.find((accountRow) => accountRow.id === ericAccount.id);
    expect(visibleEricAccount).toBeDefined();
    expect(visibleEricAccount!.ledgerEntries).toHaveLength(0);
    expect(visibleEricAccount!.brokerRecords).toHaveLength(0);
    expect(visibleEricAccount!.snapshots).toHaveLength(0);
    expect(mattData.ownAccounts.some((accountRow) => accountRow.id === ericAccount.id)).toBe(false);

    const mattAccountData = await appData.getAccountPageData(matt.id);
    expect(mattAccountData.accounts.some((accountRow) => accountRow.id === ericAccount.id)).toBe(false);
  });

  it("does not expose private account financial summaries through another user's buddy views", async () => {
    const mattAccount = await prisma.tradingAccount.create({
      data: {
        userId: matt.id,
        name: `Matt Private Financials ${Date.now()}`,
        brokerName: "Schwab",
        accountType: "Brokerage",
        source: "SCHWAB",
        externalAccountId: `acct-matt-private-${Date.now()}`,
        visibility: "PRIVATE",
      },
    });
    createdAccounts.push(mattAccount.id);

    await prisma.accountLedgerEntry.createMany({
      data: [
        { accountId: mattAccount.id, type: "STARTING_VALUE", occurredAt: new Date("2026-07-20"), amount: "10000", source: "SCHWAB" },
        { accountId: mattAccount.id, type: "BROKER_SNAPSHOT", occurredAt: new Date("2026-09-10T12:00:00Z"), accountValue: "10123.77", cash: "10123.77", source: "SCHWAB" },
      ],
    });
    await brokerImport.persistNormalizedBrokerRecordsForUser(
      matt.id,
      mattAccount.id,
      parseSchwabTransactionsCsv(fixture("transactions.csv"), { accountHint: mattAccount.id }),
    );

    const ericBuddyData = await appData.getTrackerPageData(eric.id, "buddy");
    expect(ericBuddyData.visibleAccounts.some((accountRow) => accountRow.id === mattAccount.id)).toBe(false);
    expect(ericBuddyData.ownAccounts.some((accountRow) => accountRow.id === mattAccount.id)).toBe(false);

    const ericBothData = await appData.getTrackerPageData(eric.id, "both");
    expect(ericBothData.visibleAccounts.some((accountRow) => accountRow.id === mattAccount.id)).toBe(false);
    expect(ericBothData.ownAccounts.some((accountRow) => accountRow.id === mattAccount.id)).toBe(false);

    const ericAccountData = await appData.getAccountPageData(eric.id);
    expect(ericAccountData.accounts.some((accountRow) => accountRow.id === mattAccount.id)).toBe(false);
  });
});

function fixture(name: string) {
  return readFileSync(new URL(`../providers/schwab/__fixtures__/${name}`, import.meta.url), "utf8");
}
