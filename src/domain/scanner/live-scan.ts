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

export async function evaluateLiveMarketScan({
  provider,
  rules,
  universe = STARTER_LIVE_SCAN_UNIVERSE,
  asOf = new Date(),
  maxOptionChainLookups = 8,
}: LiveScanOptions): Promise<LiveScanCandidate[]> {
  const stockStage = [];
  for (const ticker of universe.map((item) => item.toUpperCase())) {
    const [quote, candles] = await Promise.all([provider.getQuote(ticker), provider.getPriceHistory(ticker, 80)]);
    stockStage.push(buildStockStageCandidate(ticker, quote, candles));
  }

  const shortlist = stockStage
    .filter((candidate) => stockStageIsEligible(candidate, rules))
    .sort((left, right) => stockStageRank(left) - stockStageRank(right))
    .slice(0, maxOptionChainLookups);
  const shortlistTickers = new Set(shortlist.map((candidate) => candidate.ticker));
  const optionsByTicker = new Map<string, OptionContractSnapshot[]>();

  for (const candidate of shortlist) {
    optionsByTicker.set(candidate.ticker, await provider.getOptionChain(candidate.ticker));
  }

  return stockStage.map((candidate) => {
    const values = shortlistTickers.has(candidate.ticker)
      ? bestPutValues(candidate, optionsByTicker.get(candidate.ticker) ?? [], rules, asOf)
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
