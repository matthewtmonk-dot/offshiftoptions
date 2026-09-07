import "server-only";

import { prisma } from "./prisma";
import { ensureMyLstScannerProfileForUser, getResearchUniverseTickersForUser } from "./workflows";
import { scannerRulesFromRecords } from "@/domain/scanner/profile";
import { STARTER_LIVE_SCAN_UNIVERSE } from "@/domain/scanner/live-scan";
import { getEarningsCalendarLookup } from "./earnings-calendar-cache";
import type { MarketDataProvider } from "@/providers/market-data/types";

export type ScannerUniverseDryRunResult = {
  universeSymbols: number;
  successfullyQuoted: number;
  priceSurvivors: number;
  priceAndVolumeSurvivors: number;
  earningsKnown: number;
  earningsUnknown: number;
  estimatedHistoryCallsRequired: number;
  estimatedOptionChainCallsRequired: number;
  maxOptionChainLookups: number;
};

type DryRunOptions = {
  maxOptionChainLookups?: number;
};

/**
 * A read-only, authenticated engineering measurement of what a real broad-universe live scan
 * would actually cost for this user's OWN configured rules - see PROJECT_HANDOFF.md
 * "Stabilization Slice 3 - measure before full wiring". Makes exactly ONE real Schwab quote
 * request per universe symbol (via the provider's batched getQuotes when available - see
 * SchwabMarketDataProvider.getQuotes) to get REAL survivor counts, but:
 *
 *  - NEVER creates a ScanRun/ScanResult (persistScannerRun is never called from here)
 *  - NEVER modifies Research, Watchlist, or campaign data
 *  - NEVER fetches price history or option chains itself - it only ESTIMATES how many of those
 *    a real Stage 2/3 pass would need, from the same quote-only Stage 1 filtering
 *    evaluateLiveMarketScan already applies (see QUOTE_ONLY_STOCK_RULE_KEYS in live-scan.ts)
 *  - Reads the earnings-calendar cache (zero additional Alpha Vantage calls - see
 *    earnings-calendar-cache.ts's own zero-call read path)
 *
 * The universe is Tier 1 (this user's own Research/Watchlist/traded tickers, always included)
 * union Tier 2 (the public, shared OptionableUniverseSymbol cache - empty until that cache is
 * populated, in which case this naturally measures only Tier 1 plus the fixed demo starter
 * list, exactly like the current production scan does today).
 */
export async function runScannerUniverseDryRun(
  userId: string,
  provider: MarketDataProvider,
  options: DryRunOptions = {},
): Promise<ScannerUniverseDryRunResult> {
  const maxOptionChainLookups = options.maxOptionChainLookups ?? 8;

  const [profile, userTickers, publicUniverse] = await Promise.all([
    ensureMyLstScannerProfileForUser(userId),
    getResearchUniverseTickersForUser(userId),
    prisma.optionableUniverseSymbol.findMany({ select: { ticker: true } }),
  ]);

  const records = await prisma.scannerRule.findMany({ where: { profileId: profile.id }, orderBy: { sortOrder: "asc" } });
  const rules = scannerRulesFromRecords(records);

  const universe = [...new Set([...STARTER_LIVE_SCAN_UNIVERSE, ...userTickers, ...publicUniverse.map((row) => row.ticker)])].map((ticker) =>
    ticker.toUpperCase(),
  );

  const quotesByTicker = provider.getQuotes
    ? await provider.getQuotes(universe)
    : await fetchQuotesIndividuallyForDryRun(provider, universe);

  const priceRule = rules.find((rule) => rule.key === "price");
  const volumeRule = rules.find((rule) => rule.key === "stockVolume");

  let priceSurvivors = 0;
  let priceAndVolumeSurvivors = 0;
  const survivorTickers: string[] = [];

  for (const [ticker, quote] of quotesByTicker) {
    if (priceRule) {
      const [low, high] = priceRule.desired as [number, number];
      if (quote.price < low || quote.price > high) {
        continue;
      }
    }
    priceSurvivors += 1;

    if (volumeRule) {
      const volume = quote.volume ?? null;
      const [min] = Array.isArray(volumeRule.desired) ? volumeRule.desired : [volumeRule.desired as number];
      if (volume === null || volume < min) {
        continue;
      }
    }
    priceAndVolumeSurvivors += 1;
    survivorTickers.push(ticker);
  }

  const earningsLookup = await getEarningsCalendarLookup(survivorTickers);
  const earningsKnown = survivorTickers.filter((ticker) => earningsLookup.has(ticker)).length;

  return {
    universeSymbols: universe.length,
    successfullyQuoted: quotesByTicker.size,
    priceSurvivors,
    priceAndVolumeSurvivors,
    earningsKnown,
    earningsUnknown: survivorTickers.length - earningsKnown,
    estimatedHistoryCallsRequired: priceAndVolumeSurvivors,
    estimatedOptionChainCallsRequired: Math.min(priceAndVolumeSurvivors, maxOptionChainLookups),
    maxOptionChainLookups,
  };
}

async function fetchQuotesIndividuallyForDryRun(provider: MarketDataProvider, tickers: string[]) {
  const entries = await Promise.all(
    tickers.map(async (ticker) => {
      try {
        return [ticker, await provider.getQuote(ticker)] as const;
      } catch {
        return null;
      }
    }),
  );
  return new Map(entries.filter((entry): entry is readonly [string, Awaited<ReturnType<MarketDataProvider["getQuote"]>>] => entry !== null));
}
