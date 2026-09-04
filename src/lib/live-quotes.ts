import "server-only";

import { getSchwabMarketDataProviderForUser } from "./broker-connections";
import { mapWithConcurrency } from "./concurrency";

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
