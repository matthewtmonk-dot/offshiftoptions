import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokerPosition, BrokerReadProvider, BrokerTransaction, BrokerTransactionsResult } from "@/providers/broker-read/types";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;
const asOf = new Date("2026-09-21T18:00:00Z");
const symbol = "SAFE 260918P00016500";

maybeDescribe("Schwab expiration safety through sync, persistence and reconciliation", () => {
  let prisma: typeof import("./prisma").prisma;
  let workflows: typeof import("./workflows");
  let connections: typeof import("./broker-connections");
  let reconciliation: typeof import("./campaign-reconciliation");
  let userA: { id: string };
  let userB: { id: string };
  const userIds: string[] = [];

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    workflows = await import("./workflows");
    connections = await import("./broker-connections");
    reconciliation = await import("./campaign-reconciliation");
    for (const name of ["Expiration A", "Expiration B"]) {
      const user = await prisma.user.create({ data: { name, email: `${randomUUID()}@lst.local`, passwordHash: "unused-test-hash" } });
      userIds.push(user.id);
    }
    userA = { id: userIds[0] };
    userB = { id: userIds[1] };
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(asOf);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  async function fixture(userId = userA.id) {
    const account = await prisma.tradingAccount.create({ data: {
      userId, name: "Expiration safety fixture", source: "SCHWAB", externalAccountId: randomUUID(), visibility: "PRIVATE",
    } });
    const campaign = await workflows.createCampaignForUser(userId, account.id, "SAFE", "2026-09-14", "2026-09-18", 16.5, 1, 0.3, 0.66, null, "PRIVATE");
    return { account, campaign };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  function transaction(accountId: string, action: string, overrides: Partial<BrokerTransaction> = {}): BrokerTransaction {
    return {
      id: randomUUID(), accountId, symbol, underlyingSymbol: "SAFE", action, description: action,
      occurredAt: new Date("2026-09-18T18:00:00Z"), amount: -5.66, quantity: 1, price: 0.05, fees: 0.66,
      ...overrides,
    };
  }
  function result(transactions: BrokerTransaction[] = []): BrokerTransactionsResult {
    return { transactions, categories: {
      TRADE: { status: "OK", count: transactions.length }, RECEIVE_AND_DELIVER: { status: "OK", count: 0 },
      DIVIDEND_OR_INTEREST: { status: "OK", count: 0 },
    } };
  }
  function providerFor(f: Fixture, overrides: Partial<BrokerReadProvider> = {}): BrokerReadProvider {
    return {
      getAccounts: async () => [{ id: f.account.externalAccountId!, label: "Fixture account", accountValue: 10000, cash: 10000 }],
      getAccount: async () => null, getPositions: async () => [], getTransactions: async () => result(),
      getOrders: async () => { throw new Error("Sync must not request orders"); }, ...overrides,
    };
  }
  async function sync(f: Fixture, provider: BrokerReadProvider) {
    vi.spyOn(connections, "getSchwabBrokerReadProviderForUser").mockImplementation(async (userId) => {
      expect(userId).toBe(f.account.userId);
      return provider;
    });
    const synced = await workflows.syncSchwabAccountForUser(f.account.userId);
    const account = synced.accounts.find((row) => row.id === f.account.id)!;
    const summary = await reconciliation.reconcileSchwabActivityForUser(f.account.userId, account.id, account.evidence, asOf);
    return { synced, account, summary };
  }
  async function expectOpen(f: Fixture) {
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: f.campaign.id }, include: { events: true } });
    expect(campaign.status).toBe("OPEN");
    expect(campaign.closedAt).toBeNull();
    expect(campaign.events.map((event) => event.type)).toEqual(["SELL_PUT"]);
  }

  it("failed positions -> [] defers, then a complete successful empty read expires once on retry", async () => {
    const f = await fixture();
    const failed = await sync(f, providerFor(f, { getPositions: async () => { throw new Error("private provider payload"); } }));
    expect(failed.account.evidence.positions).toEqual({ status: "FAILED", data: [] });
    expect(failed.summary).toMatchObject({ campaignsExpired: 0, expirationsDeferred: 1, expirationDeferralReason: "EXPIRATION_EVIDENCE_INCOMPLETE" });
    expect(JSON.stringify(failed.summary)).not.toContain("private provider payload");
    await expectOpen(f);

    const successful = await sync(f, providerFor(f));
    expect(successful.account.evidence.positions).toEqual({ status: "COMPLETE", data: [] });
    expect(successful.summary.campaignsExpired).toBe(1);
    const repeated = await sync(f, providerFor(f));
    expect(repeated.summary).toMatchObject({ campaignsExpired: 0, campaignsClosed: 0, expirationsDeferred: 0 });
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: f.campaign.id }, include: { events: true } });
    expect(campaign.status).toBe("CLOSED");
    expect(campaign.events.map((event) => event.type).sort()).toEqual(["PUT_EXPIRED", "SELL_PUT"]);
    expect(Number(campaign.events.find((event) => event.type === "PUT_EXPIRED")?.premium)).toBe(0);
  });

  it.each(["SAFE  260918P00016500", "SAFE260918P00016500", " safe 260918p00016500 "])("keeps the campaign open for equivalent present contract %s", async (liveSymbol) => {
    const f = await fixture();
    const positions: BrokerPosition[] = [{ accountId: f.account.externalAccountId!, symbol: liveSymbol, quantity: -1, marketValue: -5, assetType: "OPTION" }];
    const { summary } = await sync(f, providerFor(f, { getPositions: async () => positions }));
    expect(summary.campaignsExpired).toBe(0);
    await expectOpen(f);
  });

  it.each(["FAILED", "PARTIAL"] as const)("blocks synthetic expiration with %s transaction evidence", async (status) => {
    const f = await fixture();
    const { account, synced, summary } = await sync(f, providerFor(f, { getTransactions: async () => {
      if (status === "FAILED") throw new Error("private transaction payload");
      const partial = result();
      partial.categories.RECEIVE_AND_DELIVER = { status: "ERROR" };
      return partial;
    } }));
    expect(account.evidence.transactions.status).toBe(status);
    expect(synced.diagnostics.transactionsEvidenceStatus).toBe(status);
    expect(summary).toMatchObject({ campaignsExpired: 0, expirationsDeferred: 1 });
    await expectOpen(f);
  });

  it.each(["Assignment", "Buy to Close", "Roll"])("explicit %s with padded symbols takes precedence even when positions fail", async (kind) => {
    const f = await fixture();
    const action = kind === "Roll" ? "Buy to Close" : kind;
    const transactions = [transaction(f.account.externalAccountId!, action, { symbol: "SAFE  260918P00016500", price: kind === "Assignment" ? null : 0.05 })];
    if (kind === "Roll") transactions.push(transaction(f.account.externalAccountId!, "Sell to Open", { symbol: "SAFE  260925P00016000", price: 0.4, amount: 39.34 }));
    const { summary } = await sync(f, providerFor(f, {
      getPositions: async () => { throw new Error("positions unavailable"); },
      getTransactions: async () => result(transactions),
    }));
    expect(summary.campaignsExpired).toBe(0);
    expect(summary[kind === "Assignment" ? "campaignsAssigned" : kind === "Roll" ? "campaignsRolled" : "campaignsClosed"]).toBe(1);
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: f.campaign.id }, include: { events: true } });
    expect(campaign.status).toBe(kind === "Assignment" ? "ASSIGNED" : kind === "Roll" ? "OPEN" : "CLOSED");
    expect(campaign.events.some((event) => event.type === "PUT_EXPIRED")).toBe(false);
  });

  it("a persistence failure cannot erase newly fetched closing evidence and manufacture expiration", async () => {
    const f = await fixture();
    const imports = await import("./broker-import");
    vi.spyOn(imports, "persistNormalizedBrokerRecordsForUser").mockRejectedValueOnce(new Error("persistence unavailable"));
    const { summary, account } = await sync(f, providerFor(f, {
      getTransactions: async () => result([transaction(f.account.externalAccountId!, "Buy to Close")]),
    }));
    expect(account.evidence.persistenceStatus).toBe("FAILED");
    expect(summary).toMatchObject({ campaignsExpired: 0, expirationsDeferred: 1 });
    await expectOpen(f);
  });

  it("unresolved explicit activity is never replaced with a synthetic expiration", async () => {
    const f = await fixture();
    const { summary } = await sync(f, providerFor(f, {
      getTransactions: async () => result([transaction(f.account.externalAccountId!, "Buy to Close", { price: null })]),
    }));
    expect(summary).toMatchObject({ campaignsExpired: 0, expirationsDeferred: 1 });
    await expectOpen(f);
  });

  it("one user's complete empty sync cannot expire another user's identical campaign", async () => {
    const fA = await fixture();
    const fB = await fixture(userB.id);
    const { account, summary } = await sync(fA, providerFor(fA));
    expect(summary.campaignsExpired).toBe(1);
    await expectOpen(fB);
    const wrongOwner = await reconciliation.reconcileSchwabActivityForUser(userA.id, fB.account.id, account.evidence, asOf);
    expect(wrongOwner.campaignsExpired).toBe(0);
    await expectOpen(fB);
  });

  it("uses each account's evidence independently when one positions request fails", async () => {
    const fA = await fixture();
    const fB = await fixture();
    const provider = providerFor(fA, {
      getAccounts: async () => [fA, fB].map((f) => ({ id: f.account.externalAccountId!, label: "Fixture account", accountValue: 10000, cash: 10000 })),
      getPositions: async (accountId) => {
        if (accountId === fA.account.externalAccountId) throw new Error("one account failed");
        return [];
      },
    });
    const { synced } = await sync(fA, provider);
    expect(synced.diagnostics.positionsSourceStatus).toBe("ERROR");
    const accountB = synced.accounts.find((row) => row.id === fB.account.id)!;
    const summaryB = await reconciliation.reconcileSchwabActivityForUser(userA.id, accountB.id, accountB.evidence, asOf);
    expect(summaryB.campaignsExpired).toBe(1);
    await expectOpen(fA);
  });

  it("concurrent expiration retries append exactly one expiration event", async () => {
    const f = await fixture();
    const provider = providerFor(f);
    const { evidence } = await workflows.fetchSchwabAccountActivity(provider, f.account.externalAccountId!, new Date("2026-08-01"), asOf);
    const summaries = await Promise.all([
      reconciliation.reconcileSchwabActivityForUser(userA.id, f.account.id, evidence, asOf),
      reconciliation.reconcileSchwabActivityForUser(userA.id, f.account.id, evidence, asOf),
    ]);
    expect(summaries.reduce((sum, row) => sum + row.campaignsExpired, 0)).toBe(1);
    expect(await prisma.campaignEvent.count({ where: { campaignId: f.campaign.id, type: "PUT_EXPIRED" } })).toBe(1);
  });

  it("an assignment with an unidentifiable instrument stays pending instead of expiring", async () => {
    const f = await fixture();
    const { summary } = await sync(f, providerFor(f, {
      getTransactions: async () => result([transaction(f.account.externalAccountId!, "Assignment", { symbol: undefined, price: null })]),
    }));
    expect(summary).toMatchObject({ campaignsExpired: 0, expirationsDeferred: 1 });
    await expectOpen(f);
  });
});
