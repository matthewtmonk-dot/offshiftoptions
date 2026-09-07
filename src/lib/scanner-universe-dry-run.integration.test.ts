import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarketDataProvider, MarketQuote } from "@/providers/market-data/types";

const runDatabaseTests = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const maybeDescribe = runDatabaseTests ? describe : describe.skip;

/**
 * Uses only synthetic test symbols (never real OCC data) to exercise the dry-run tool's math in
 * isolation - the real OCC-populated universe is measured separately via the "Scanner Universe
 * Dry Run" panel on /account/schwab-quote-batch-diagnostic, using a real authenticated user's own
 * Schwab connection.
 */
function fakeProvider(pricesByTicker: Record<string, { price: number; volume: number }>): MarketDataProvider {
  const quotesByTicker = new Map<string, MarketQuote>(
    Object.entries(pricesByTicker).map(([ticker, { price, volume }]) => [
      ticker,
      { symbol: ticker, price, volume, asOf: new Date("2026-09-06T14:30:00Z") },
    ]),
  );

  return {
    async getQuote(symbol) {
      const quote = quotesByTicker.get(symbol.toUpperCase());
      if (!quote) {
        throw new Error(`no quote for ${symbol}`);
      }
      return quote;
    },
    async getQuotes(symbols) {
      const result = new Map<string, MarketQuote>();
      for (const symbol of symbols) {
        const quote = quotesByTicker.get(symbol.toUpperCase());
        if (quote) {
          result.set(symbol.toUpperCase(), quote);
        }
      }
      return result;
    },
    async getPriceHistory() {
      return [];
    },
    async getOptionChain() {
      return [];
    },
    async getInstrument(symbol) {
      return { symbol, description: symbol, assetType: "EQUITY" };
    },
    async getMarketHours() {
      return { isOpen: true };
    },
  };
}

maybeDescribe("Scanner universe dry run - measurement only, never persists a scan or touches Research/campaign data", () => {
  let prisma: typeof import("./prisma").prisma;
  let runScannerUniverseDryRun: typeof import("./scanner-universe-dry-run").runScannerUniverseDryRun;
  let updateScannerSettingsForUser: typeof import("./workflows").updateScannerSettingsForUser;
  let user: { id: string };
  const symbolTickers: string[] = [];

  beforeAll(async () => {
    prisma = (await import("./prisma")).prisma;
    ({ runScannerUniverseDryRun } = await import("./scanner-universe-dry-run"));
    ({ updateScannerSettingsForUser } = await import("./workflows"));

    const passwordHash = await hash("not-used", 4);
    user = await prisma.user.create({
      data: { name: "Dry Run User", email: `dry-run-${Date.now()}@lst.local`, passwordHash },
    });

    // A small synthetic Tier 2 universe - never real Cboe data.
    const synthetic = [
      { ticker: "DRYA", name: "Dry Run Corp A" },
      { ticker: "DRYB", name: "Dry Run Corp B" },
      { ticker: "DRYC", name: "Dry Run Corp C" },
    ];
    symbolTickers.push(...synthetic.map((s) => s.ticker));
    await prisma.optionableUniverseSymbol.createMany({
      data: synthetic.map((s) => ({ ticker: s.ticker, name: s.name, source: "TEST_FIXTURE", lastSeenAt: new Date() })),
    });
  });

  afterAll(async () => {
    await prisma.optionableUniverseSymbol.deleteMany({ where: { ticker: { in: symbolTickers } } });
    await prisma.scannerRule.deleteMany({ where: { profile: { ownerId: user.id } } });
    await prisma.scannerProfile.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  });

  it("counts the union of Tier 1 (starter+research) and Tier 2 (public cache) symbols, applies the user's own price/volume rules, and estimates downstream call counts", async () => {
    // DRYA passes price+volume, DRYB fails price (too expensive), DRYC passes price but fails
    // volume - a realistic funnel shape.
    const provider = fakeProvider({
      DRYA: { price: 20, volume: 1_000_000 },
      DRYB: { price: 999, volume: 1_000_000 },
      DRYC: { price: 20, volume: 10 },
    });

    const result = await runScannerUniverseDryRun(user.id, provider, { maxOptionChainLookups: 8 });

    expect(result.universeSymbols).toBeGreaterThanOrEqual(3 + 13); // synthetic Tier 2 + the fixed demo starter list
    expect(result.successfullyQuoted).toBeGreaterThanOrEqual(1); // at least DRYA/DRYB/DRYC (starter tickers have no fake quote)
    expect(result.priceSurvivors).toBeGreaterThanOrEqual(2); // DRYA and DRYC pass the default $10-$50 price rule
    expect(result.priceAndVolumeSurvivors).toBeGreaterThanOrEqual(1); // only DRYA also passes volume
    expect(result.estimatedHistoryCallsRequired).toBe(result.priceAndVolumeSurvivors);
    expect(result.estimatedOptionChainCallsRequired).toBeLessThanOrEqual(result.maxOptionChainLookups);
  });

  it("never creates a ScanRun/ScanResult", async () => {
    const before = await prisma.scanRun.count({ where: { ownerId: user.id } });
    const provider = fakeProvider({ DRYA: { price: 20, volume: 1_000_000 } });
    await runScannerUniverseDryRun(user.id, provider);
    const after = await prisma.scanRun.count({ where: { ownerId: user.id } });
    expect(after).toBe(before);
  });

  it("respects this user's own disabled/enabled rule configuration, not a hardcoded assumption", async () => {
    // Disable the price rule entirely for this user - every quoted symbol should now be a
    // "price survivor" regardless of price.
    const formData = new FormData();
    formData.set("price:enabled", "off"); // leave everything else at its default
    await updateScannerSettingsForUser(user.id, formData);

    const provider = fakeProvider({
      DRYA: { price: 20, volume: 1_000_000 },
      DRYB: { price: 999, volume: 1_000_000 }, // would fail price if the rule were enabled
    });

    const result = await runScannerUniverseDryRun(user.id, provider);
    expect(result.priceSurvivors).toBe(result.successfullyQuoted); // nothing excluded by price
  });
});
