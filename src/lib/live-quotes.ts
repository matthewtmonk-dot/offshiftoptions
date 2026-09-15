import "server-only";

import { getSchwabMarketDataProviderForUser } from "./broker-connections";
import { mapWithConcurrency } from "./concurrency";

export type QuoteSnapshot = { price: number; asOf: Date };

/** Preserve the provider's snapshot time; checking again does not make an old quote new. */
export async function getQuoteSnapshotsForUser(userId: string, tickers: string[]): Promise<Map<string, QuoteSnapshot | null>> {
  const uniqueTickers = [...new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean))];
  const snapshots = new Map<string, QuoteSnapshot | null>(uniqueTickers.map((ticker) => [ticker, null]));
  if (!uniqueTickers.length) return snapshots;
  try {
    const provider = await getSchwabMarketDataProviderForUser(userId);
    if (!provider) return snapshots;
    const results = await mapWithConcurrency(uniqueTickers, 4, async (ticker) => {
      try {
        const quote = await provider.getQuote(ticker);
        return Number.isFinite(quote.price) && quote.price > 0 && Number.isFinite(quote.asOf.getTime())
          ? { price: quote.price, asOf: quote.asOf }
          : null;
      } catch {
        return null;
      }
    });
    uniqueTickers.forEach((ticker, index) => snapshots.set(ticker, results[index]));
  } catch {
    // Connection resolution can fail too. Keep the cards readable with unavailable prices.
  }
  return snapshots;
}

/**
 * Batches live quote lookups for a set of tickers under one user's Schwab connection. Never
 * throws and never fabricates a price - a ticker with no connection, no token, or a failed
 * lookup maps to `null` so callers can render an honest "unavailable" state.
 */
export async function getLiveQuotePricesForUser(userId: string, tickers: string[]): Promise<Map<string, number | null>> {
  const uniqueTickers = [...new Set(tickers.map((ticker) => ticker.toUpperCase()))];
  const prices = new Map<string, number | null>();
  if (uniqueTickers.length === 0) {
    return prices;
  }

  const provider = await getSchwabMarketDataProviderForUser(userId);
  if (!provider) {
    uniqueTickers.forEach((ticker) => prices.set(ticker, null));
    return prices;
  }

  const results = await mapWithConcurrency(uniqueTickers, 4, async (ticker) => {
    try {
      const quote = await provider.getQuote(ticker);
      return Number.isFinite(quote.price) ? quote.price : null;
    } catch {
      return null;
    }
  });

  uniqueTickers.forEach((ticker, index) => prices.set(ticker, results[index]));
  return prices;
}
