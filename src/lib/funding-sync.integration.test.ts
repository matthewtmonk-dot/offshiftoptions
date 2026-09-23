import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BrokerReadProvider } from "@/providers/broker-read/types";
import { summarizeAccountPerformance } from "@/domain/finance/accountLedger";

const dbTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const now = new Date("2026-09-23T16:00:00Z");
(dbTests ? describe : describe.skip)("persisted funding sync DB boundaries", () => {
  let prisma: typeof import("./prisma").prisma;
  let workflow: typeof import("./workflows");
  let connections: typeof import("./broker-connections");
  let appData: typeof import("./app-data");
  const owners: string[] = [];
  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    workflow = await import("./workflows"); connections = await import("./broker-connections");
    appData = await import("./app-data");
    for (const name of ["Funding Matt", "Funding Eric"]) {
      const user = await prisma.user.create({ data: { name, email: `${randomUUID()}@lst.local`, passwordHash: "unused" } });
      owners.push(user.id);
    }
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  afterAll(async () => {
    if (prisma) { await prisma.user.deleteMany({ where: { id: { in: owners } } }); await prisma.$disconnect(); }
  });
  async function fixture(owner = owners[0]) {
    return prisma.tradingAccount.create({ data: { userId: owner, name: "Funding fixture", source: "SCHWAB",
      externalAccountId: randomUUID(), visibility: "SHARED" } });
  }
  function connect(account: { externalAccountId: string | null }, failed = false) {
    const provider: BrokerReadProvider = {
      getAccounts: async () => [{ id: account.externalAccountId!, label: "Fixture", accountValue: 10500, cash: 10500 }],
      getAccount: async () => null, getPositions: async () => [], getOrders: async () => [],
      getTransactions: async () => { if (failed) throw new Error("failed fetch"); return { transactions: [], categories: {
        TRADE: { status: "OK", count: 0 }, RECEIVE_AND_DELIVER: { status: "OK", count: 0 }, DIVIDEND_OR_INTEREST: { status: "OK", count: 0 },
      } }; },
    };
    vi.spyOn(connections, "getSchwabBrokerReadProviderForUser").mockResolvedValue(provider);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  }
  it("real sync persists empty complete evidence; account query feeds confirmed gain", async () => {
    const account = await fixture();
    await prisma.accountLedgerEntry.create({ data: { accountId: account.id, type: "STARTING_VALUE", amount: 10000, occurredAt: new Date("2026-09-01") } });
    connect(account); await workflow.syncSchwabAccountForUser(owners[0]);
    const loaded = (await appData.getAccountPageData(owners[0])).accounts.find((a) => a.id === account.id)!;
    expect(loaded.fundingSyncs).toHaveLength(1);
    const run = loaded.fundingSyncs[0]; expect(run.status).toBe("COMPLETE");
    expect(loaded.ledgerEntries.find((e) => e.id === run.balanceSnapshotLedgerEntryId)?.type).toBe("BROKER_SNAPSHOT");
    expect(summarizeAccountPerformance({ ledgerEntries: loaded.ledgerEntries, brokerRecords: loaded.brokerRecords,
      fundingCoverage: { accountId: loaded.id, externalAccountId: loaded.externalAccountId, fundingSyncs: loaded.fundingSyncs },
    }).totalGain).toBe(500);
    const eric = await fixture(owners[1]);
    expect((await appData.getAccountPageData(owners[1])).accounts.every((a) => a.id !== account.id)).toBe(true);
    const visible = await appData.getTrackerPageData(owners[1], "both");
    expect(visible.visibleAccounts.find((a) => a.id === account.id)?.fundingSyncs).toEqual([]);
    expect(visible.ownAccounts.every((a) => a.id !== account.id)).toBe(true);
    expect(eric.userId).not.toBe(account.userId);
  });
  it("failed fetch preserves earlier successful evidence", async () => {
    const account = await fixture(); connect(account); await workflow.syncSchwabAccountForUser(owners[0]);
    vi.useRealTimers(); vi.restoreAllMocks(); connect(account, true);
    await workflow.syncSchwabAccountForUser(owners[0]);
    const runs = await prisma.accountFundingSync.findMany({ where: { accountId: account.id } });
    expect(runs.map((r) => r.status).sort()).toEqual(["COMPLETE", "FAILED"]);
  });
  it("database rejects a snapshot belonging to another account", async () => {
    const a = await fixture(); const b = await fixture(owners[1]);
    const snapshot = await prisma.accountLedgerEntry.create({ data: { accountId: b.id, type: "BROKER_SNAPSHOT", occurredAt: now, accountValue: 10000 } });
    await expect(prisma.accountFundingSync.create({ data: { accountId: a.id, externalAccountId: a.externalAccountId!,
      coverageStart: now, coverageEnd: now, startedAt: now, balanceSnapshotLedgerEntryId: snapshot.id,
    } })).rejects.toThrow();
  });
  it("database rejects COMPLETE without successful category/persistence evidence", async () => {
    const account = await fixture();
    await expect(prisma.accountFundingSync.create({ data: { accountId: account.id, externalAccountId: account.externalAccountId!,
      coverageStart: now, coverageEnd: now, startedAt: now, status: "COMPLETE",
    } })).rejects.toThrow();
  });
});
