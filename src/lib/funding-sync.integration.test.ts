import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BrokerReadProvider, BrokerTransaction } from "@/providers/broker-read/types";
import { summarizeAccountPerformance } from "@/domain/finance/accountLedger";
import { normalizeSchwabApiTransaction } from "@/providers/schwab/csv";

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
  function connectWithTransactions(
    account: { externalAccountId: string | null }, transactions: BrokerTransaction[], accountValue = 11000,
  ) {
    const provider: BrokerReadProvider = {
      getAccounts: async () => [{ id: account.externalAccountId!, label: "Fixture", accountValue, cash: accountValue }],
      getAccount: async () => null, getPositions: async () => [], getOrders: async () => [],
      getTransactions: async () => ({ transactions, categories: {
        TRADE: { status: "OK", count: 0 }, RECEIVE_AND_DELIVER: { status: "OK", count: transactions.length }, DIVIDEND_OR_INTEREST: { status: "OK", count: 0 },
      } }),
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

  // Blocker fix regression coverage: two distinct Schwab provider transaction ids that collide on
  // fingerprint (same date/amount/description) must never satisfy persistence verification as one
  // transaction - see the finalization transaction in syncSchwabAccountForUser (workflows.ts).
  it("reproduced collision: two distinct $500 deposits deny COMPLETE and gain stays unavailable, not a wrong $500", async () => {
    const account = await fixture();
    await prisma.accountLedgerEntry.create({ data: { accountId: account.id, type: "STARTING_VALUE", amount: 10000, occurredAt: new Date("2026-09-01") } });
    connectWithTransactions(account, [
      { id: "t1", accountId: account.externalAccountId!, amount: 500, description: "Bank transfer", occurredAt: now },
      { id: "t2", accountId: account.externalAccountId!, amount: 500, description: "Bank transfer", occurredAt: now },
    ], 11000);
    await workflow.syncSchwabAccountForUser(owners[0]);
    const loaded = (await appData.getAccountPageData(owners[0])).accounts.find((a) => a.id === account.id)!;
    const run = loaded.fundingSyncs[0]!;
    expect(run.status).not.toBe("COMPLETE");
    expect(run.persistenceStatus).toBe("FAILED");
    const summary = summarizeAccountPerformance({ ledgerEntries: loaded.ledgerEntries, brokerRecords: loaded.brokerRecords,
      fundingCoverage: { accountId: loaded.id, externalAccountId: loaded.externalAccountId, fundingSyncs: loaded.fundingSyncs } });
    // Never a confident-but-wrong $500 - withheld entirely once coverage is denied.
    expect(summary.totalGain).toBeNull();
    // Documented limitation: this schema's BrokerRecord uniqueness is (userId, provider, kind,
    // fingerprint), not identity-aware, so only one of the two distinct transactions can ever
    // physically persist without a broader storage redesign (explicitly out of scope for this
    // ticket). The fix's job is to ensure that loss is DENIED, not silently reported as COMPLETE.
    const persisted = await prisma.brokerRecord.findMany({ where: { accountId: account.id, kind: "TRANSACTION" } });
    expect(persisted).toHaveLength(1);
  });
  it("the same provider id reported twice (retry / cross-category overlap) deduplicates and still allows COMPLETE", async () => {
    const account = await fixture();
    await prisma.accountLedgerEntry.create({ data: { accountId: account.id, type: "STARTING_VALUE", amount: 10000, occurredAt: new Date("2026-09-01") } });
    connectWithTransactions(account, [
      { id: "t1", accountId: account.externalAccountId!, amount: 500, description: "Bank transfer", occurredAt: now },
      { id: "t1", accountId: account.externalAccountId!, amount: 500, description: "Bank transfer", occurredAt: now },
    ], 10500);
    await workflow.syncSchwabAccountForUser(owners[0]);
    const run = await prisma.accountFundingSync.findFirst({ where: { accountId: account.id }, orderBy: { startedAt: "desc" } });
    expect(run).toMatchObject({ status: "COMPLETE", persistenceStatus: "COMPLETE" });
    const persisted = await prisma.brokerRecord.findMany({ where: { accountId: account.id, kind: "TRANSACTION" } });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.sourceIds).toEqual(["schwab-api-transaction:t1"]);
  });
  it("a fingerprint already claimed by a different provider id (ambiguous prior history) denies COMPLETE", async () => {
    const account = await fixture();
    await prisma.accountLedgerEntry.create({ data: { accountId: account.id, type: "STARTING_VALUE", amount: 10000, occurredAt: new Date("2026-09-01") } });
    const incoming: BrokerTransaction = { id: "t1", accountId: account.externalAccountId!, amount: 500, description: "Bank transfer", occurredAt: now };
    const normalized = normalizeSchwabApiTransaction(incoming);
    // Pre-existing row at the EXACT SAME fingerprint t1 will compute to, but with a DIFFERENT
    // provider id's identity evidence - simulates a prior distinct transaction (or a legacy import
    // predating sourceIds tracking) that already claimed this fingerprint. classifyCandidates
    // matches by fingerprint first, so t1 is classified DUPLICATE and skipped - its own identity is
    // never recorded anywhere, which is exactly the ambiguity this fix must deny COMPLETE over.
    await prisma.brokerRecord.create({ data: { userId: owners[0], accountId: account.id, provider: "SCHWAB", kind: "TRANSACTION",
      status: "CONFIRMED", fingerprint: normalized.fingerprint, identityKey: "api-transaction:some-other-account:different-transaction-id",
      occurredAt: now, description: "Bank transfer", amount: 500, sources: ["SCHWAB_API"], sourceIds: ["schwab-api-transaction:different-transaction-id"],
    } });
    connectWithTransactions(account, [incoming], 10500);
    await workflow.syncSchwabAccountForUser(owners[0]);
    const run = await prisma.accountFundingSync.findFirst({ where: { accountId: account.id }, orderBy: { startedAt: "desc" } });
    expect(run).toMatchObject({ status: "FAILED", persistenceStatus: "FAILED" });
  });
});
