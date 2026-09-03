import {
  annualizedReturnOnRisk,
  bidAskSpreadPercent,
  bollingerBands,
  bollingerPositionPercent,
  cashSecuredReturnOnRisk,
  daysToExpiration,
  distanceToStrikePercent,
  wilderRsi,
} from "@/domain/finance/calculations";
import type { MarketDataProvider, MarketQuote, OptionContractSnapshot, PriceCandle } from "@/providers/market-data/types";
import { mapWithConcurrency } from "@/lib/concurrency";
import { DEMO_SCAN_CANDIDATES } from "./profile";
import { evaluateCandidate, setupScore, type ScannerRule } from "./scanner";

export type LiveScanCandidate = {
  ticker: string;
  values: Record<string, number | string | boolean | null | undefined>;
  summary: ReturnType<typeof evaluateCandidate>;
};

export type LiveScanOptions = {
  provider: MarketDataProvider;
  rules: ScannerRule[];
  universe?: string[];
  asOf?: Date;
  maxOptionChainLookups?: number;
};

type StockStageCandidate = {
  ticker: string;
  quote: MarketQuote;
  candles: PriceCandle[];
  values: Record<string, number | string | boolean | null | undefined>;
};

export const STARTER_LIVE_SCAN_UNIVERSE = [...new Set(DEMO_SCAN_CANDIDATES.map((candidate) => candidate.ticker))];
const STOCK_STAGE_RULE_KEYS = new Set(["price", "rsi", "bbPercent", "doNotTrade", "debtToEquity", "earningsDistance"]);

/**
 * Caps how many quote/history or option-chain requests run in flight at once for a
 * single live scan. Schwab does not publish a per-connection concurrent-request limit,
 * so this is a conservative, easily-tunable bound rather than a documented ceiling:
 * it still gives most of the available wall-clock improvement over one-at-a-time
 * fetching on a scan-sized universe (10-30 tickers) without bursting a single user's
 * OAuth-scoped connection with dozens of simultaneous requests. Revisit if production
 * use shows either throttling (lower it) or comfortable headroom (raise it).
 */
export const SCAN_FETCH_CONCURRENCY = 4;

type StockStageOutcome =
  | { ticker: string; ok: true; candidate: StockStageCandidate }
  | { ticker: string; ok: false; error: unknown };

export async function evaluateLiveMarketScan({
  provider,
  rules,
  universe = STARTER_LIVE_SCAN_UNIVERSE,
  asOf = new Date(),
  maxOptionChainLookups = 8,
}: LiveScanOptions): Promise<LiveScanCandidate[]> {
  const tickers = universe.map((item) => item.toUpperCase());
  const stockOutcomes = await mapWithConcurrency<string, StockStageOutcome>(tickers, SCAN_FETCH_CONCURRENCY, async (ticker) => {
    try {
      const [quote, candles] = await Promise.all([provider.getQuote(ticker), provider.getPriceHistory(ticker, 80)]);
      return { ticker, ok: true, candidate: buildStockStageCandidate(ticker, quote, candles) };
    } catch (error) {
      return { ticker, ok: false, error };
    }
  });

  const stockStage = stockOutcomes
    .filter((outcome): outcome is StockStageOutcome & { ok: true } => outcome.ok)
    .map((outcome) => outcome.candidate);
  const unavailableTickers = stockOutcomes.filter((outcome): outcome is StockStageOutcome & { ok: false } => !outcome.ok);

  // A single bad ticker should not sink the whole scan (partial results are useful and
  // are surfaced as UNKNOWN below). But if every ticker failed, this is a systemic
  // problem (auth, outage, etc.), not a per-ticker one - surface it as a real failure
  // instead of returning an all-UNKNOWN scan that looks like it ran successfully.
  if (stockStage.length === 0 && unavailableTickers.length > 0) {
    throw unavailableTickers[0].error;
  }

  const shortlist = stockStage
    .filter((candidate) => stockStageIsEligible(candidate, rules))
    .sort((left, right) => stockStageRank(left) - stockStageRank(right))
    .slice(0, maxOptionChainLookups);
  const shortlistTickers = new Set(shortlist.map((candidate) => candidate.ticker));

  const optionOutcomes = await mapWithConcurrency(shortlist, SCAN_FETCH_CONCURRENCY, async (candidate) => {
    try {
      return { ticker: candidate.ticker, ok: true as const, options: await provider.getOptionChain(candidate.ticker) };
    } catch {
      return { ticker: candidate.ticker, ok: false as const, options: [] as OptionContractSnapshot[] };
    }
  });
  const optionsByTicker = new Map<string, OptionContractSnapshot[]>();
  const optionChainFailedTickers = new Set<string>();
  for (const outcome of optionOutcomes) {
    optionsByTicker.set(outcome.ticker, outcome.options);
    if (!outcome.ok) {
      optionChainFailedTickers.add(outcome.ticker);
    }
  }

  const evaluated = stockStage.map((candidate) => {
    const values = shortlistTickers.has(candidate.ticker)
      ? optionChainFailedTickers.has(candidate.ticker)
        ? {
            ...candidate.values,
            ...unknownOptionValues(),
            scanNote: "Option-chain data was unavailable for this ticker; result marked UNKNOWN.",
          }
        : bestPutValues(candidate, optionsByTicker.get(candidate.ticker) ?? [], rules, asOf)
      : {
          ...candidate.values,
          ...unknownOptionValues(),
          scanNote: "Stock-stage filter did not reach option-chain lookup in this controlled live scan.",
        };

    return {
      ticker: candidate.ticker,
      values,
      summary: evaluateCandidate(rules, values),
    };
  });

  const unavailable = unavailableTickers.map((outcome) => {
    const values = {
      ...unknownStockValues(),
      ...unknownOptionValues(),
      scanNote: "Live market data was unavailable for this ticker; result marked UNKNOWN.",
    };
    return { ticker: outcome.ticker, values, summary: evaluateCandidate(rules, values) };
  });

  return [...evaluated, ...unavailable];
}

function buildStockStageCandidate(ticker: string, quote: MarketQuote, candles: PriceCandle[]): StockStageCandidate {
  const closes = candles.map((candle) => candle.close);
  const rsi = wilderRsi(closes);
  const bands = bollingerBands(closes);

  return {
    ticker,
    quote,
    candles,
    values: {
      price: quote.price,
      priceChange: quote.change ?? null,
      priceChangePercent: quote.changePercent ?? null,
      stockVolume: quote.volume ?? candles.at(-1)?.volume ?? null,
      rsi,
      bbPercent: bands ? bollingerPositionPercent(quote.price, bands) : null,
      doNotTrade: false,
      debtToEquity: null,
      earningsDate: null,
      earningsDistance: null,
    },
  };
}

function stockStageIsEligible(candidate: StockStageCandidate, rules: ScannerRule[]) {
  const stockRules = rules.filter((rule) => STOCK_STAGE_RULE_KEYS.has(rule.key));
  const summary = evaluateCandidate(stockRules, candidate.values);
  return !summary.results.some((result) => result.status === "FAIL");
}

function stockStageRank(candidate: StockStageCandidate) {
  return (numericValue(candidate.values.rsi) ?? 100) + (numericValue(candidate.values.bbPercent) ?? 100) / 10;
}

function bestPutValues(
  candidate: StockStageCandidate,
  options: OptionContractSnapshot[],
  rules: ScannerRule[],
  asOf: Date,
) {
  const usablePuts = options
    .filter((option) => option.optionType === "PUT")
    .map((option) => candidateValues(candidate, option, asOf))
    .filter((values) => {
      const dte = numericValue(values.dte);
      const bid = numericValue(values.optionBid);
      const ask = numericValue(values.optionAsk);
      const strike = numericValue(values.strike);
      return dte !== null && dte >= 14 && dte <= 45 && bid !== null && bid > 0 && ask !== null && strike !== null && strike < candidate.quote.price;
    });

  if (!usablePuts.length) {
    return {
      ...candidate.values,
      ...unknownOptionValues(),
    };
  }

  return usablePuts
    .map((values) => ({
      values,
      summary: evaluateCandidate(rules, values),
    }))
    .sort((left, right) => {
      const scoreDiff = setupScore(right.summary) - setupScore(left.summary);
      return scoreDiff || (numericValue(right.values.annualizedRor) ?? 0) - (numericValue(left.values.annualizedRor) ?? 0);
    })[0].values;
}

function candidateValues(candidate: StockStageCandidate, option: OptionContractSnapshot, asOf: Date) {
  const dte = daysToExpiration(option.expiration, asOf);
  const premium = option.mark || midpoint(option.bid, option.ask);
  const ror = cashSecuredReturnOnRisk(option.bid, option.strike, 1);

  return {
    ...candidate.values,
    strike: option.strike,
    expiration: option.expiration.toISOString().slice(0, 10),
    dte,
    premium,
    optionBid: option.bid,
    optionAsk: option.ask,
    midpoint: midpoint(option.bid, option.ask),
    delta: option.delta === undefined ? null : Math.abs(option.delta),
    distanceOtmPercent: distanceToStrikePercent(candidate.quote.price, option.strike),
    ror,
    annualizedRor: ror === null ? null : annualizedReturnOnRisk(ror, dte),
    spreadPercent: bidAskSpreadPercent(option.bid, option.ask),
    openInterest: option.openInterest ?? null,
    optionVolume: option.volume ?? null,
  };
}

function unknownStockValues() {
  return {
    price: null,
    priceChange: null,
    priceChangePercent: null,
    stockVolume: null,
    rsi: null,
    bbPercent: null,
    doNotTrade: null,
    debtToEquity: null,
    earningsDate: null,
    earningsDistance: null,
  };
}

function unknownOptionValues() {
  return {
    strike: null,
    expiration: null,
    dte: null,
    premium: null,
    optionBid: null,
    optionAsk: null,
    midpoint: null,
    delta: null,
    distanceOtmPercent: null,
    ror: null,
    annualizedRor: null,
    spreadPercent: null,
    openInterest: null,
    optionVolume: null,
  };
}

function midpoint(bid: number, ask: number) {
  return (bid + ask) / 2;
}

function numericValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
