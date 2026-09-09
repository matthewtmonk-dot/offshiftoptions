import "server-only";

import type { MarketDataProvider, MarketQuote } from "@/providers/market-data/types";
import { SCHWAB_MARKET_DATA_BASE_URL } from "./config";
import { schwabGetJson, type SchwabFetch } from "./client";
import { mapWithConcurrency } from "@/lib/concurrency";
import {
  normalizeSchwabInstrument,
  normalizeSchwabMarketHours,
  normalizeSchwabOptionChainResponse,
  normalizeSchwabPriceHistoryResponse,
  normalizeSchwabQuoteResponse,
  normalizeSchwabQuotesResponse,
} from "./normalizers";

/**
 * Bounded fan-out for the 100-symbol /quotes chunks a broad-universe scan needs (~61 chunks for
 * the real ~6,071-symbol OCC universe) - real production evidence showed these running fully
 * sequentially contributed meaningfully to a ~22s total scan time. A conservative concurrency
 * level, matching the same already-proven-safe precedent used elsewhere in this codebase for
 * fan-out against this exact provider (SCAN_FETCH_CONCURRENCY for option-chain/history fetches,
 * TECHNICAL_REFRESH_CONCURRENCY for technical-preparation history batches) - never the request
 * SIZE itself (SCHWAB_QUOTE_BATCH_SIZE stays exactly the same, real, verified 100 symbols per
 * request; this only changes how many of those 100-symbol requests are in flight at once).
 */
const QUOTE_CHUNK_CONCURRENCY = 4;

/**
 * Maximum symbols sent in one Schwab `/quotes` request. NOT independently verified against
 * Schwab's official documentation or a live call - the detailed API reference on Schwab's
 * developer portal is login-gated (see docs/SCHWAB_INTEGRATION.md's own note on this), and no
 * live Schwab connection was available to test empirically in this environment. Chosen as a
 * conservative placeholder - err toward more, smaller requests rather than one oversized
 * request that might be rejected - pending real verification (Matt's own developer portal
 * login, or a small live diagnostic call) before this is trusted for a large broad-universe
 * scan. See PROJECT_HANDOFF.md "Batch quote verification needed."
 */
export const SCHWAB_QUOTE_BATCH_SIZE = 100;

export class SchwabMarketDataProvider implements MarketDataProvider {
  constructor(
    private readonly options: {
      accessToken: string;
      fetchFn?: SchwabFetch;
      baseUrl?: string;
    },
  ) {}

  async getQuote(symbol: string) {
    const normalized = symbol.toUpperCase();
    const payload = await this.get("/quotes", {
      symbols: normalized,
      fields: "quote,reference,regular,fundamental",
    });

    return normalizeSchwabQuoteResponse(normalized, payload);
  }

  /**
   * Batches symbols into SCHWAB_QUOTE_BATCH_SIZE-sized requests against the same `/quotes`
   * endpoint getQuote uses (Schwab's response is always keyed by symbol regardless of how many
   * were requested - see normalizeSchwabQuotesResponse), up to QUOTE_CHUNK_CONCURRENCY chunks in
   * flight at once (see its own doc comment - never unbounded, never a change to the 100-symbol
   * request size itself). Each chunk's failure is isolated: a single bad/oversized/rejected chunk
   * never prevents the other chunks' symbols from coming back - their entries are simply absent
   * from the result Map, exactly like an individual invalid symbol would be, never a thrown error
   * for the whole batch. Deterministic regardless of concurrency: getQuotes(["a","b"]) always maps
   * to exactly {A: quoteForA, B: quoteForB} minus whichever symbols were genuinely unavailable -
   * never a cross-symbol mixup between chunks (each chunk's own result is merged into the shared
   * Map by its own real symbol keys, never positionally).
   */
  async getQuotes(symbols: string[]): Promise<Map<string, MarketQuote>> {
    const normalized = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))];
    const chunks = chunk(normalized, SCHWAB_QUOTE_BATCH_SIZE);
    const result = new Map<string, MarketQuote>();

    const outcomes = await mapWithConcurrency(chunks, QUOTE_CHUNK_CONCURRENCY, async (batch) => {
      try {
        const payload = await this.get("/quotes", {
          symbols: batch.join(","),
          fields: "quote,reference,regular,fundamental",
        });
        return { ok: true as const, entries: normalizeSchwabQuotesResponse(batch, payload) };
      } catch (error) {
        // This chunk failed outright (network/HTTP error) - its symbols are simply absent from
        // the result, same as an individual invalid symbol, as long as at least one OTHER
        // chunk succeeded. If every chunk fails, that is a systemic problem (auth, outage),
        // not a per-symbol one - rethrown below rather than silently returning an empty map
        // that looks like "zero symbols had a price" instead of "the request never worked."
        return { ok: false as const, error };
      }
    });

    let failedChunks = 0;
    let lastChunkError: unknown = null;
    for (const outcome of outcomes) {
      if (outcome.ok) {
        for (const [symbol, quote] of outcome.entries) {
          result.set(symbol, quote);
        }
      } else {
        failedChunks += 1;
        lastChunkError = outcome.error;
      }
    }

    if (chunks.length > 0 && failedChunks === chunks.length) {
      throw lastChunkError;
    }

    return result;
  }

  async getPriceHistory(symbol: string, days: number) {
    const normalized = symbol.toUpperCase();
    const payload = await this.get("/pricehistory", {
      symbol: normalized,
      periodType: "year",
      period: "1",
      frequencyType: "daily",
      frequency: "1",
      needExtendedHoursData: "false",
      needPreviousClose: "true",
    });

    return normalizeSchwabPriceHistoryResponse(normalized, payload).slice(-days);
  }

  async getOptionChain(symbol: string, expiration?: Date) {
    const normalized = symbol.toUpperCase();
    const params: Record<string, string> = {
      symbol: normalized,
      contractType: "ALL",
      strategy: "SINGLE",
      includeQuotes: "TRUE",
      range: "OTM",
    };

    if (expiration) {
      const formatted = formatDate(expiration);
      params.fromDate = formatted;
      params.toDate = formatted;
    }

    const payload = await this.get("/chains", params);
    return normalizeSchwabOptionChainResponse(payload);
  }

  async getInstrument(symbol: string) {
    const normalized = symbol.toUpperCase();
    const payload = await this.get("/instruments", {
      symbol: normalized,
      projection: "symbol-search",
    });

    return normalizeSchwabInstrument(normalized, payload);
  }

  async getMarketHours(date: Date) {
    const payload = await this.get("/markets", {
      markets: "equity,option",
      date: formatDate(date),
    });

    return normalizeSchwabMarketHours(payload);
  }

  private async get(path: string, params: Record<string, string>) {
    return schwabGetJson<unknown>({
      accessToken: this.options.accessToken,
      baseUrl: this.options.baseUrl ?? SCHWAB_MARKET_DATA_BASE_URL,
      path,
      searchParams: new URLSearchParams(params),
      fetchFn: this.options.fetchFn,
    });
  }
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    return [items];
  }
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
