import "server-only";

import type { MarketDataProvider } from "@/providers/market-data/types";
import { SCHWAB_MARKET_DATA_BASE_URL } from "./config";
import { schwabGetJson, type SchwabFetch } from "./client";
import {
  normalizeSchwabInstrument,
  normalizeSchwabMarketHours,
  normalizeSchwabOptionChainResponse,
  normalizeSchwabPriceHistoryResponse,
  normalizeSchwabQuoteResponse,
} from "./normalizers";

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
