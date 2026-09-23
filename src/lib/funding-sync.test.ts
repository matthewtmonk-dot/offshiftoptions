import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { BrokerReadProvider, BrokerTransactionsResult } from "@/providers/broker-read/types";

const mocks = vi.hoisted(() => ({
  db: { tradingAccount: { upsert: vi.fn(), findFirst: vi.fn() },
    accountLedgerEntry: { create: vi.fn(), findFirst: vi.fn() },
    accountFundingSync: { create: vi.fn(), update: vi.fn() }, brokerRecord: { count: vi.fn() }, $transaction: vi.fn() },
  provider: vi.fn(), persist: vi.fn(), record: vi.fn(),
}));
vi.mock("./prisma", () => ({ prisma: mocks.db }));
vi.mock("./broker-import", () => ({ persistNormalizedBrokerRecordsForUser: mocks.persist }));
vi.mock("./broker-connections", () => ({ getSchwabBrokerReadProviderForUser: mocks.provider,
  clearSchwabBrokerReadCacheForUser: vi.fn(), recordSchwabAccountSyncResult: mocks.record,
  categorizeSchwabSyncError: () => "fetch_failed", logSchwabSyncFailure: vi.fn(),
}));
import { syncSchwabAccountForUser } from "./workflows";
import { SchwabBrokerReadProvider } from "@/providers/schwab/broker-read";

const now = new Date("2026-09-23T16:00:00Z");
const empty = (): BrokerTransactionsResult => ({ transactions: [], categories: {
  TRADE: { status: "OK", count: 0 }, RECEIVE_AND_DELIVER: { status: "OK", count: 0 },
  DIVIDEND_OR_INTEREST: { status: "OK", count: 0 },
} });
let provider: BrokerReadProvider;
const db = mocks.db;
const finalized = () => db.accountFundingSync.update.mock.calls.at(-1)?.[0].data;
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now);
  provider = { getAccounts: async () => [{ id: "matt-hash", label: "Matt", accountValue: 10000, cash: 10000 }],
    getAccount: async () => null, getPositions: async () => [], getTransactions: async () => empty(), getOrders: async () => [] };
  mocks.provider.mockResolvedValue(provider);
  db.tradingAccount.upsert.mockResolvedValue({ id: "matt-account", name: "Matt" });
  db.tradingAccount.findFirst.mockResolvedValue({ id: "matt-account" });
  db.accountLedgerEntry.create.mockResolvedValue({ id: "snapshot" });
  db.accountLedgerEntry.findFirst.mockResolvedValue({ id: "snapshot" });
  db.accountFundingSync.create.mockResolvedValue({ id: "run" });
  db.accountFundingSync.update.mockImplementation(async (args) => args.data);
  db.$transaction.mockImplementation(async (callback) => callback(db));
  db.brokerRecord.count.mockImplementation(async (args) => args.where.fingerprint.in.length);
  mocks.persist.mockResolvedValue({ inserted: 1, duplicatesSkipped: 0, unresolved: 0, feeKnownTransactions: 0, feeUnknownTransactions: 0 });
});
afterEach(() => vi.useRealTimers());
function oneTransaction() {
  provider.getTransactions = async () => ({ ...empty(), transactions: [{ id: "t1", accountId: "matt-hash",
    amount: 500, description: "Bank transfer", occurredAt: now }] });
}

describe("Schwab funding evidence lifecycle", () => {
  it("creates owner/account-scoped run and finalizes successful empty fetches", async () => {
    await syncSchwabAccountForUser("matt");
    expect(mocks.provider).toHaveBeenCalledWith("matt", { bypassCache: true });
    expect(db.tradingAccount.upsert.mock.calls[0][0].where).toEqual({ userId_externalAccountId: { userId: "matt", externalAccountId: "matt-hash" } });
    expect(db.accountFundingSync.create.mock.calls[0][0].data).toMatchObject({ accountId: "matt-account", externalAccountId: "matt-hash", coverageEnd: now });
    expect(finalized()).toMatchObject({ status: "COMPLETE", persistenceStatus: "COMPLETE", tradeStatus: "COMPLETE",
      receiveAndDeliverStatus: "COMPLETE", dividendOrInterestStatus: "COMPLETE", balanceSnapshotLedgerEntryId: "snapshot" });
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(db.accountLedgerEntry.findFirst.mock.calls[0][0].where).toMatchObject({ id: "snapshot", accountId: "matt-account", occurredAt: now, type: "BROKER_SNAPSHOT" });
  });
  it("finalizes only after nonempty persistence and verifies durable fingerprints", async () => {
    oneTransaction(); await syncSchwabAccountForUser("matt");
    expect(finalized().status).toBe("COMPLETE");
    expect(mocks.persist.mock.invocationCallOrder[0]).toBeLessThan(db.accountFundingSync.update.mock.invocationCallOrder[0]);
    expect(db.brokerRecord.count.mock.calls[0][0].where).toMatchObject({ accountId: "matt-account", userId: "matt", kind: "TRANSACTION" });
  });
  it("accepts safely persisted duplicates", async () => {
    oneTransaction(); mocks.persist.mockResolvedValue({ inserted: 0, duplicatesSkipped: 1, unresolved: 0 });
    await syncSchwabAccountForUser("matt"); expect(finalized().status).toBe("COMPLETE");
  });
  it("a duplicate stored under another account cannot establish coverage", async () => {
    oneTransaction(); db.brokerRecord.count.mockResolvedValue(0);
    await syncSchwabAccountForUser("matt"); expect(finalized().status).toBe("FAILED");
  });
  it("total fetch failure stays FAILED", async () => {
    provider.getTransactions = async () => { throw new Error("fetch failed"); };
    await syncSchwabAccountForUser("matt"); expect(finalized().status).toBe("FAILED");
  });
  it("a malformed real Schwab category response stays PARTIAL", async () => {
    const realProvider = new SchwabBrokerReadProvider({ accessToken: "test", accountNumbers: [],
      fetchFn: async (url) => new Response(JSON.stringify(String(url).includes("DIVIDEND_OR_INTEREST") ? {} : []), { status: 200 }),
    });
    provider.getTransactions = realProvider.getTransactions.bind(realProvider);
    await syncSchwabAccountForUser("matt");
    expect(finalized()).toMatchObject({ status: "PARTIAL", dividendOrInterestStatus: "FAILED" });
  });
  it("partial category success cannot unlock gain", async () => {
    provider.getTransactions = async () => ({ ...empty(), categories: { ...empty().categories, TRADE: { status: "ERROR" } } });
    await syncSchwabAccountForUser("matt"); expect(finalized().status).toBe("PARTIAL");
  });
  it("persistence failure stays FAILED", async () => {
    oneTransaction(); mocks.persist.mockRejectedValue(new Error("persistence failed"));
    await syncSchwabAccountForUser("matt"); expect(finalized()).toMatchObject({ status: "FAILED", persistenceStatus: "FAILED" });
  });
  it("interruption after run creation cannot finalize evidence", async () => {
    db.accountLedgerEntry.create.mockRejectedValue(new Error("interrupted"));
    await expect(syncSchwabAccountForUser("matt")).rejects.toThrow("interrupted");
    expect(db.accountFundingSync.create).toHaveBeenCalledOnce(); expect(db.accountFundingSync.update).not.toHaveBeenCalled();
  });
  it("finalization transaction failure leaves no COMPLETE update", async () => {
    db.$transaction.mockRejectedValue(new Error("serialization failure"));
    await expect(syncSchwabAccountForUser("matt")).rejects.toThrow();
    expect(db.accountFundingSync.update).not.toHaveBeenCalled();
  });
  it("rejects Eric's transaction in Matt's response before persistence", async () => {
    provider.getTransactions = async () => ({ ...empty(), transactions: [{ id: "t", accountId: "eric-hash", amount: 1, description: "Transfer", occurredAt: now }] });
    await expect(syncSchwabAccountForUser("matt")).rejects.toThrow(/identity/);
    expect(mocks.persist).not.toHaveBeenCalled(); expect(finalized().status).toBe("FAILED");
  });
  it("rechecks identity at finalization", async () => {
    db.tradingAccount.findFirst.mockResolvedValue(null);
    await syncSchwabAccountForUser("matt"); expect(finalized().status).toBe("FAILED");
    expect(db.tradingAccount.findFirst.mock.calls[0][0].where).toEqual({ id: "matt-account", userId: "matt", externalAccountId: "matt-hash" });
  });
  it("missing/wrong snapshot cannot establish coverage", async () => {
    db.accountLedgerEntry.findFirst.mockResolvedValue(null);
    await syncSchwabAccountForUser("matt"); expect(finalized().status).toBe("FAILED");
  });
});
