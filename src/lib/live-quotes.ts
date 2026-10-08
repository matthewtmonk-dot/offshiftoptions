import "server-only";

import type { EquityMarketSessionEvidence, QuoteReviewEvidence } from "@/providers/market-data/types";
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

/**
 * Dashboard V2 Phase 2 - user-scoped, never-throwing fetch of the stricter QuoteReviewEvidence
 * for a batch of tickers, mirroring getQuoteSnapshotsForUser's own connection-resolution and
 * concurrency pattern. A missing connection, a resolution failure, or a per-symbol provider
 * error each map to `{ status: "UNAVAILABLE", reason }` - never thrown, never a fabricated price.
 */
export async function getQuoteReviewEvidenceForUser(userId: string, tickers: string[], signal?: AbortSignal): Promise<Map<string, QuoteReviewEvidence>> {
  const uniqueTickers = [...new Set(tickers.map((ticker) => ticker.trim().toUpperCase()).filter(Boolean))];
  const unavailable = (reason: string): QuoteReviewEvidence => ({ status: "UNAVAILABLE", reason });
  const evidence = new Map<string, QuoteReviewEvidence>(uniqueTickers.map((ticker) => [ticker, unavailable("Not yet evaluated.")]));
  if (!uniqueTickers.length) return evidence;

  try {
    const provider = await getSchwabMarketDataProviderForUser(userId, signal);
    if (!provider) {
      uniqueTickers.forEach((ticker) => evidence.set(ticker, unavailable("No Schwab market-data connection available.")));
      return evidence;
    }

    const results = await mapWithConcurrency(uniqueTickers, 4, async (ticker) => {
      if (!provider.getQuoteReviewEvidence) {
        return unavailable("Provider does not support review-evidence quotes.");
      }
      try {
        return await provider.getQuoteReviewEvidence(ticker, signal);
      } catch (error) {
        return unavailable(error instanceof Error ? error.message : "Schwab quote review evidence request failed.");
      }
    });
    uniqueTickers.forEach((ticker, index) => evidence.set(ticker, results[index]));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Schwab connection resolution failed.";
    uniqueTickers.forEach((ticker) => evidence.set(ticker, unavailable(reason)));
  }
  return evidence;
}

/**
 * Dashboard V2 Phase 2 - user-scoped, never-throwing fetch of equity regular-session evidence for
 * one NY calendar date. A missing connection or a provider failure maps to
 * `{ status: "UNAVAILABLE", reason }` - never thrown, and never re-interpreted as "market closed."
 */
export async function getEquityMarketSessionEvidenceForUser(userId: string, nyDate: string, signal?: AbortSignal): Promise<EquityMarketSessionEvidence> {
  try {
    const provider = await getSchwabMarketDataProviderForUser(userId, signal);
    if (!provider) {
      return { status: "UNAVAILABLE", reason: "No Schwab market-data connection available." };
    }
    if (!provider.getEquityMarketSessionEvidence) {
      return { status: "UNAVAILABLE", reason: "Provider does not support equity market-session evidence." };
    }
    return await provider.getEquityMarketSessionEvidence(nyDate, signal);
  } catch (error) {
    return { status: "UNAVAILABLE", reason: error instanceof Error ? error.message : "Schwab market-session request failed." };
  }
}
