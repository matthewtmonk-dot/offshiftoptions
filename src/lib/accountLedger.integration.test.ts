import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { summarizeCampaign } from "@/domain/finance/campaigns";
import { summarizeWinLoss } from "@/domain/finance/performance";
import { currentAccountValue, summarizeAccountLedger } from "@/domain/finance/accountLedger";
import { ValidationError } from "./tickers";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

maybeDescribe("account ledger, Schwab isolation, and campaign performance accounting", () => {
  let prisma: typeof import("./prisma").prisma;
  let workflows: typeof import("./workflows");
  let appData: typeof import("./app-data");
  let matt: { id: string };
  let eric: { id: string };
  const createdAccounts: string[] = [];
  const createdCampaigns: string[] = [];

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    workflows = await import("./workflows");
    appData = await import("./app-data");
    matt = await prisma.user.findUniqueOrThrow({ where: { email: "matt@lst.local" }, select: { id: true } });
    eric = await prisma.user.findUniqueOrThrow({ where: { email: "eric@lst.local" }, select: { id: true } });
  });

  afterAll(async () => {
    await prisma.campaign.deleteMany({ where: { id: { in: createdCampaigns } } });
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
});
