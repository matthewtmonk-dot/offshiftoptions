import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketDataProvider, OptionContractSnapshot } from "@/providers/market-data/types";
import { evaluateLiveMarketScan, type LiveScanEarningsLookup, type LiveScanTechnicalLookup } from "@/domain/scanner/live-scan";
import { SCANNER_RULE_DEFINITIONS } from "@/domain/scanner/profile";

const mocks = vi.hoisted(() => ({
  db: {
    scanRun: { findFirst: vi.fn() },
    scannerRule: { findMany: vi.fn() },
    scanResult: { update: vi.fn((args: unknown) => ({ op: "update", args })), findMany: vi.fn() },
    scanCriterionResult: {
      deleteMany: vi.fn((args: unknown) => ({ op: "deleteMany", args })),
      createMany: vi.fn((args: unknown) => ({ op: "createMany", args })),
    },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  },
  ensureProfile: vi.fn(),
  getProvider: vi.fn(),
}));
vi.mock("./prisma", () => ({ prisma: mocks.db }));
vi.mock("./workflows", () => ({ ensureMyLstScannerProfileForUser: mocks.ensureProfile }));
vi.mock("./broker-connections", () => ({ getSchwabMarketDataProviderForUser: mocks.getProvider }));

const { checkMoreScannerOptionsForUser, OPTION_CHECK_BATCH_SIZE } = await import("./scanner-option-check");

const SCAN_TIME = new Date("2026-09-16T14:00:00Z");
const NOW = new Date("2026-09-16T15:00:00Z");
const ready: Extract<LiveScanTechnicalLookup, { state: "READY" }> = { state: "READY", rsi: 30, bbLower: 18, bbMiddle: 23, bbUpper: 28 };
const earnings: LiveScanEarningsLookup = { daysUntilReport: 36, reportDate: "2026-10-22" };

const ruleRecords = SCANNER_RULE_DEFINITIONS.map((definition, index) => ({
  key: definition.key, name: definition.name, operator: definition.operator, valueJson: { desired: definition.defaultDesired }, sortOrder: index, enabled: definition.defaultEnabled,
}));
const engineRules = SCANNER_RULE_DEFINITIONS.filter((rule) => rule.defaultEnabled).map((rule) => ({ key: rule.key, name: rule.name, operator: rule.operator, desired: rule.defaultDesired }));

function put(overrides: Partial<OptionContractSnapshot> = {}): OptionContractSnapshot {
  return {
    symbol: "X-7-19-PUT", underlyingSymbol: "X", optionType: "PUT", strike: 19,
    expiration: new Date(Date.UTC(2026, 8, 23, 20)), bid: 0.25, ask: 0.3, mark: 0.275, openInterest: 200, volume: 0, delta: -0.2,
    ...overrides,
  };
}

/** A real budget-limited row from the real scan engine, shaped exactly as persisted (undefined -> null). */
async function storedRow(ticker: string, overrides: { rsi?: number; volume?: number } = {}) {
  const provider: MarketDataProvider = {
    async getQuote(symbol) { return { symbol, price: 20, volume: overrides.volume ?? 100_000, asOf: SCAN_TIME }; },
    async getPriceHistory() { throw new Error("n/a"); },
    async getOptionChain() { return []; },
    async getInstrument(symbol) { return { symbol, description: symbol, assetType: "EQUITY" }; },
    async getMarketHours() { return { isOpen: true }; },
  };
  const [row] = await evaluateLiveMarketScan({
    provider, rules: engineRules, universe: [ticker], asOf: SCAN_TIME, maxOptionChainLookups: 0,
    technicalCache: new Map<string, LiveScanTechnicalLookup>([[ticker, { ...ready, rsi: overrides.rsi ?? ready.rsi }]]),
    earningsLookup: new Map([[ticker, earnings]]),
  });
  const values = { ...row.values, settingsRevisionAsOf: "2026-09-01T00:00:00.000Z" };
  return { id: `result-${ticker}`, ticker, snapshotJson: JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v ?? null])))) };
}

function fakeProvider(chainFor: (ticker: string) => OptionContractSnapshot[] | Error = () => [put()]) {
  const getOptionChain = vi.fn(async (...args: [ticker: string, request?: unknown]) => {
    const result = chainFor(args[0]);
    if (result instanceof Error) throw result;
    return result;
  });
  return { provider: { getOptionChain } as unknown as MarketDataProvider, getOptionChain };
}

function mockRun(results: unknown[], overrides: Record<string, unknown> = {}) {
  mocks.db.scanRun.findFirst.mockResolvedValue({ id: "run-1", source: "LIVE:SCHWAB", createdAt: SCAN_TIME, results, ...overrides });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureProfile.mockResolvedValue({ id: "profile-1", updatedAt: new Date("2026-09-01T00:00:00Z") });
  mocks.db.scannerRule.findMany.mockResolvedValue(ruleRecords);
  mocks.db.scanResult.findMany.mockResolvedValue([]);
  mocks.db.$transaction.mockImplementation(async (ops: unknown[]) => ops);
});

describe("checkMoreScannerOptionsForUser", () => {
  it("is scoped to the signed-in user's own latest scan run", async () => {
    mockRun([]);
    await checkMoreScannerOptionsForUser("matt-id", { provider: fakeProvider().provider, now: NOW });
    expect(mocks.db.scanRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { ownerId: "matt-id" }, orderBy: { createdAt: "desc" } }));
  });

  it("refuses when there is no live scan to check (none, or a demo run)", async () => {
    mocks.db.scanRun.findFirst.mockResolvedValue(null);
    expect((await checkMoreScannerOptionsForUser("matt-id", { now: NOW })).ok).toBe(false);
    mockRun([], { source: "DEMO" });
    const demo = await checkMoreScannerOptionsForUser("matt-id", { now: NOW });
    expect(demo.ok).toBe(false);
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
  });

  it("refuses a scan more than a day old, because the stored prices and indicators are stale", async () => {
    mockRun([await storedRow("AAA")]);
    const outcome = await checkMoreScannerOptionsForUser("matt-id", { provider: fakeProvider().provider, now: new Date(SCAN_TIME.getTime() + 25 * 3600 * 1000) });
    expect(outcome).toEqual({ ok: false, error: expect.stringMatching(/more than a day old/) });
  });

  it("refuses when the user's rules changed after the scan, rather than mixing two rule sets", async () => {
    mockRun([await storedRow("AAA")]);
    mocks.ensureProfile.mockResolvedValue({ id: "profile-1", updatedAt: new Date("2026-09-10T00:00:00Z") }); // after the stored revision stamp
    const fake = fakeProvider();
    const outcome = await checkMoreScannerOptionsForUser("matt-id", { provider: fake.provider, now: NOW });
    expect(outcome).toEqual({ ok: false, error: expect.stringMatching(/rules changed/) });
    expect(fake.getOptionChain).not.toHaveBeenCalled();
  });

  it("prices every waiting row, saves each row's snapshot + criterion results together, and reports the outcome", async () => {
    mockRun([await storedRow("AAA"), await storedRow("BBB"), await storedRow("CCC")]);
    const fake = fakeProvider();
    const outcome = await checkMoreScannerOptionsForUser("matt-id", { provider: fake.provider, now: NOW });

    expect(outcome).toEqual({ ok: true, checked: 3, failedLookups: 0, remaining: 0, newPass: 3, newNear: 0 });
    expect(fake.getOptionChain).toHaveBeenCalledTimes(3);
    const ops = mocks.db.$transaction.mock.calls[0][0] as Array<{ op: string; args: { data?: Record<string, unknown>; where?: { id?: string; scanResultId?: string } } }>;
    expect(ops.map((op) => op.op)).toEqual(["update", "deleteMany", "createMany", "update", "deleteMany", "createMany", "update", "deleteMany", "createMany"]);
    const firstUpdate = ops[0].args.data!;
    expect((firstUpdate.snapshotJson as Record<string, unknown>).optionEnrichment).toBe("ENRICHED");
    expect((firstUpdate.snapshotJson as Record<string, unknown>).settingsRevisionAsOf).toBe("2026-09-01T00:00:00.000Z"); // preserved
    expect(firstUpdate.summaryStatus).toBe("PASS");
  });

  it("leaves a row UNTOUCHED when its chain request fails (retryable), never recording it as 'no options'", async () => {
    mockRun([await storedRow("AAA"), await storedRow("BBB")]);
    const fake = fakeProvider((ticker) => (ticker === "BBB" ? new Error("429 too many requests") : [put()]));
    const outcome = await checkMoreScannerOptionsForUser("matt-id", { provider: fake.provider, now: NOW });

    expect(outcome).toEqual({ ok: true, checked: 1, failedLookups: 1, remaining: 1, newPass: 1, newNear: 0 });
    const ops = mocks.db.$transaction.mock.calls[0][0] as Array<{ op: string; args: { where?: { id?: string } } }>;
    expect(ops.filter((op) => op.op === "update").map((op) => op.args.where?.id)).toEqual(["result-AAA"]);
  });

  it("prices the most LIQUID names first (shares x price), not merely the most oversold", async () => {
    // BBB is the most oversold but trades 50k shares; CCC trades 20M. Cap the batch at 2 to see who wins.
    mockRun([await storedRow("AAA", { rsi: 30, volume: 2_000_000 }), await storedRow("BBB", { rsi: 22, volume: 50_000 }), await storedRow("CCC", { rsi: 35, volume: 20_000_000 })]);
    const fake = fakeProvider();
    await checkMoreScannerOptionsForUser("matt-id", { provider: fake.provider, now: NOW, batchSize: 2 });
    expect(fake.getOptionChain.mock.calls.map((call) => call[0]).sort()).toEqual(["AAA", "CCC"]);
  });

  it("puts names a recent scan found to have NO weekly options at the back of the queue", async () => {
    mockRun([await storedRow("AAA", { volume: 30_000_000 }), await storedRow("BBB", { volume: 1_000_000 }), await storedRow("CCC", { volume: 2_000_000 })]);
    mocks.db.scanResult.findMany.mockResolvedValue([{ ticker: "AAA" }]); // most liquid, but known monthly-only
    const fake = fakeProvider();
    await checkMoreScannerOptionsForUser("matt-id", { provider: fake.provider, now: NOW, batchSize: 2 });
    expect(fake.getOptionChain.mock.calls.map((call) => call[0]).sort()).toEqual(["BBB", "CCC"]);
    // ...and the lookup is owner-scoped and limited to the three 'no weekly' reasons within two weeks.
    const query = mocks.db.scanResult.findMany.mock.calls[0][0];
    expect(query.where.run.ownerId).toBe("matt-id");
    expect(query.where.OR.map((clause: { snapshotJson: { equals: string } }) => clause.snapshotJson.equals).sort()).toEqual(["NO_EXPIRATIONS_IN_CONFIGURED_RANGE", "NO_PUT_CONTRACTS", "NO_WEEKLY_EXPIRATION"]);
  });

  it("still prices everything if the 'no weekly' history lookup fails - ordering is only an optimization", async () => {
    mockRun([await storedRow("AAA"), await storedRow("BBB")]);
    mocks.db.scanResult.findMany.mockRejectedValue(new Error("db hiccup"));
    const fake = fakeProvider();
    const outcome = await checkMoreScannerOptionsForUser("matt-id", { provider: fake.provider, now: NOW });
    expect(outcome).toMatchObject({ ok: true, checked: 2 });
  });

  it("caps a call at the batch size and checks the most oversold names first (when equally liquid)", async () => {
    const rows = [];
    for (let index = 0; index < 15; index += 1) rows.push(await storedRow(`T${String(index).padStart(2, "0")}`, { rsi: 20 + index })); // T00 most oversold
    mockRun(rows);
    const fake = fakeProvider();
    const outcome = await checkMoreScannerOptionsForUser("matt-id", { provider: fake.provider, now: NOW });

    expect(OPTION_CHECK_BATCH_SIZE).toBe(12);
    expect(fake.getOptionChain).toHaveBeenCalledTimes(12);
    const asked = fake.getOptionChain.mock.calls.map((call) => call[0]).sort();
    expect(asked).toEqual(Array.from({ length: 12 }, (_, index) => `T${String(index).padStart(2, "0")}`));
    expect(outcome).toMatchObject({ ok: true, checked: 12, remaining: 3 });
  });

  it("never touches rows that are already priced, stock-filtered, technically incomplete, or no longer pass the stock screen", async () => {
    const waiting = await storedRow("AAA");
    const alreadyPriced = { ...(await storedRow("BBB")), snapshotJson: { ...(await storedRow("BBB")).snapshotJson, optionEnrichment: "ENRICHED" } };
    const stockFiltered = { ...(await storedRow("CCC")), snapshotJson: { ...(await storedRow("CCC")).snapshotJson, optionEnrichment: "NOT_ENRICHED_STOCK_FILTER" } };
    const incomplete = { ...(await storedRow("DDD")), snapshotJson: { ...(await storedRow("DDD")).snapshotJson, technicalReasonCode: "TECHNICAL_DATA_STALE" } };
    const overbought = await storedRow("EEE", { rsi: 55 }); // RSI 55 > 40: fails the stock screen under current rules
    mockRun([waiting, alreadyPriced, stockFiltered, incomplete, overbought]);
    const fake = fakeProvider();
    const outcome = await checkMoreScannerOptionsForUser("matt-id", { provider: fake.provider, now: NOW });

    expect(fake.getOptionChain.mock.calls.map((call) => call[0])).toEqual(["AAA"]);
    expect(outcome).toMatchObject({ ok: true, checked: 1, remaining: 0 });
  });

  it("reports an unavailable Schwab connection without writing anything", async () => {
    mockRun([await storedRow("AAA")]);
    mocks.getProvider.mockResolvedValue(null);
    const outcome = await checkMoreScannerOptionsForUser("matt-id", { now: NOW });
    expect(outcome).toEqual({ ok: false, error: expect.stringMatching(/Schwab/) });
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
  });

  it("requests only PUT chains inside the active weekly horizon (same window a full scan uses)", async () => {
    mockRun([await storedRow("AAA")]);
    const fake = fakeProvider();
    await checkMoreScannerOptionsForUser("matt-id", { provider: fake.provider, now: NOW });
    const request = fake.getOptionChain.mock.calls[0][1] as unknown as { contractType: string; fromDate: Date; toDate: Date };
    expect(request.contractType).toBe("PUT");
    const days = (request.toDate.getTime() - request.fromDate.getTime()) / 86_400_000;
    expect(days).toBe(8); // default hard DTE range 3-11
  });
});
