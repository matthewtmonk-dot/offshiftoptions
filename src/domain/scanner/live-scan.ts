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
import type { MarketDataProvider, MarketQuote, OptionContractSnapshot, PriceCandle, QuoteFundamentals } from "@/providers/market-data/types";
import { mapWithConcurrency } from "@/lib/concurrency";
import { DEMO_SCAN_CANDIDATES, SCANNER_RULE_DEFINITIONS } from "./profile";
import { evaluateCandidate, evaluateCriterion, setupScore, type ScannerRule } from "./scanner";

export type LiveScanCandidate = {
  ticker: string;
  values: Record<string, number | string | boolean | null | undefined>;
  summary: ReturnType<typeof evaluateCandidate>;
  /**
   * Verified Schwab `fundamental` field-group values for this ticker, carried as a sibling
   * to `values` (never merged into it) so it can never be read by a Scanner rule or affect
   * scoring - Scanner rule evaluation only ever looks up the specific keys its own rules
   * name, so an extra field here is structurally inert for scoring either way, but keeping
   * it separate makes that guarantee obvious by construction rather than by convention.
   * Null/undefined when the provider didn't supply verified fundamentals (e.g. demo data).
   */
  verifiedFundamentals?: QuoteFundamentals | null;
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
  verifiedFundamentals?: QuoteFundamentals | null;
};

export const STARTER_LIVE_SCAN_UNIVERSE = [...new Set(DEMO_SCAN_CANDIDATES.map((candidate) => candidate.ticker))];
const SCANNER_RULE_DEFAULTS_BY_KEY = new Map(SCANNER_RULE_DEFINITIONS.map((definition) => [definition.key, definition]));
const STOCK_STAGE_RULE_KEYS = new Set(["price", "rsi", "bbPercent", "doNotTrade", "debtToEquity", "earningsDistance"]);
/** Stage 1 of the stock-level funnel: rules answerable from a quote alone, with no history
 * fetch. Kept as a subset of STOCK_STAGE_RULE_KEYS, never a separate rule vocabulary - see
 * evaluateLiveMarketScan's two-stage stock funnel below. */
const QUOTE_ONLY_STOCK_RULE_KEYS = new Set(["price"]);

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

type QuoteStageOutcome =
  | { ticker: string; ok: true; quote: MarketQuote; values: Record<string, number | string | boolean | null | undefined>; verifiedFundamentals: QuoteFundamentals | null }
  | { ticker: string; ok: false; error: unknown };

type StockStageOutcome =
  | { ticker: string; ok: true; candidate: StockStageCandidate }
  | { ticker: string; ok: false; error: unknown };

/**
 * Two-stage stock-level funnel, cheapest filter first (see docs/SCANNER_RULES.md "Broad scanner
 * universe" / PROJECT_HANDOFF.md Stabilization Slice 3 design):
 *
 *  Stage 1 (quote only): one Schwab quote request per universe ticker - no price-history fetch
 *  yet. Eliminates on QUOTE_ONLY_STOCK_RULE_KEYS (currently just `price`) before ever spending a
 *  history request. A large universe with many price-out-of-range tickers never fetches their
 *  history at all.
 *
 *  Stage 2 (technical): only quote-stage survivors get a price-history fetch, RSI/Bollinger
 *  computed, and the FULL stock-stage rule set (STOCK_STAGE_RULE_KEYS) applied to rank/shortlist
 *  for Stage 3 (option-chain enrichment, capped at maxOptionChainLookups) - unchanged from
 *  before this split, just fed a smaller, already-price-filtered set.
 *
 * A ticker eliminated at Stage 1 still appears in the final results (with real quote values,
 * never fabricated) - it simply never incurs a history or option-chain request, and its
 * rsi/bbPercent stay null with an honest scanNote explaining why, rather than "unavailable" (a
 * fetch failure) or silently absent.
 */
export async function evaluateLiveMarketScan({
  provider,
  rules,
  universe = STARTER_LIVE_SCAN_UNIVERSE,
  asOf = new Date(),
  maxOptionChainLookups = 8,
}: LiveScanOptions): Promise<LiveScanCandidate[]> {
  const tickers = universe.map((item) => item.toUpperCase());
  // Prefer the provider's native batch quote support (see MarketDataProvider.getQuotes) so a
  // broad universe costs a handful of requests instead of one per symbol - falls back to the
  // existing one-per-symbol, concurrency-bounded loop for a provider that doesn't implement it
  // (e.g. the demo provider, or a test fixture). Either path can throw for a total/systemic
  // failure (every symbol unavailable) - see SchwabMarketDataProvider.getQuotes and
  // fetchQuotesIndividually below - which is surfaced as a real failure rather than an
  // all-UNKNOWN scan that looks like it ran successfully.
  let quotesByTicker: Map<string, MarketQuote>;
  let quoteFetchError: unknown = null;
  try {
    quotesByTicker = provider.getQuotes ? await provider.getQuotes(tickers) : await fetchQuotesIndividually(provider, tickers);
  } catch (error) {
    quotesByTicker = new Map();
    quoteFetchError = error;
  }

  if (quotesByTicker.size === 0 && tickers.length > 0) {
    throw quoteFetchError ?? new Error("Live market data was unavailable for every ticker in this scan.");
  }

  const quoteOutcomes: QuoteStageOutcome[] = tickers.map((ticker) => {
    const quote = quotesByTicker.get(ticker);
    if (!quote) {
      return { ticker, ok: false, error: new Error(`Live market data was unavailable for ${ticker}.`) };
    }
    return { ticker, ok: true, quote, values: buildQuoteOnlyValues(quote), verifiedFundamentals: quote.fundamentals ?? null };
  });

  const quoteStage = quoteOutcomes.filter((outcome): outcome is QuoteStageOutcome & { ok: true } => outcome.ok);
  const unavailableTickers = quoteOutcomes.filter((outcome): outcome is QuoteStageOutcome & { ok: false } => !outcome.ok);

  const quoteOnlyRules = rules.filter((rule) => QUOTE_ONLY_STOCK_RULE_KEYS.has(rule.key));
  const quoteEligible = quoteStage.filter((candidate) => !evaluateCandidate(quoteOnlyRules, candidate.values).results.some((r) => r.status === "FAIL"));
  const quoteExcluded = quoteStage.filter((candidate) => !quoteEligible.includes(candidate));

  const historyOutcomes = await mapWithConcurrency<QuoteStageOutcome & { ok: true }, StockStageOutcome>(
    quoteEligible,
    SCAN_FETCH_CONCURRENCY,
    async (candidate) => {
      try {
        const candles = await provider.getPriceHistory(candidate.ticker, 80);
        return {
          ticker: candidate.ticker,
          ok: true,
          candidate: mergeHistoryValues(candidate.ticker, candidate.quote, candidate.values, candles, candidate.verifiedFundamentals),
        };
      } catch (error) {
        return { ticker: candidate.ticker, ok: false, error };
      }
    },
  );

  const stockStage = historyOutcomes
    .filter((outcome): outcome is StockStageOutcome & { ok: true } => outcome.ok)
    .map((outcome) => outcome.candidate);
  const historyFailedTickers = new Set(
    historyOutcomes.filter((outcome): outcome is StockStageOutcome & { ok: false } => !outcome.ok).map((outcome) => outcome.ticker),
  );

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
            contractReasonCode: "CHAIN_UNAVAILABLE" as const,
            scanNote: OPTION_REASON_MESSAGES.CHAIN_UNAVAILABLE,
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
      verifiedFundamentals: candidate.verifiedFundamentals ?? null,
    };
  });

  const unavailable = unavailableTickers.map((outcome) => {
    const values = {
      ...unknownStockValues(),
      ...unknownOptionValues(),
      scanNote: "Live market data was unavailable for this ticker; result marked UNKNOWN.",
    };
    return { ticker: outcome.ticker, values, summary: evaluateCandidate(rules, values), verifiedFundamentals: null };
  });

  // Stage 1 excluded these on price alone - a real quote was fetched (never fabricated), but
  // history/RSI/BB/option-chain requests were never spent on a ticker already known to be
  // outside the configured price range.
  const priceExcluded = quoteExcluded.map((candidate) => {
    const values = {
      ...candidate.values,
      ...unknownOptionValues(),
      scanNote: "Outside your configured stock price range; history and option-chain lookups were skipped.",
    };
    return { ticker: candidate.ticker, values, summary: evaluateCandidate(rules, values), verifiedFundamentals: candidate.verifiedFundamentals };
  });

  // A real quote succeeded but the price-history request itself failed - distinct from
  // priceExcluded (a deliberate filter) and from unavailableTickers (the quote itself failed).
  const historyUnavailable = quoteEligible
    .filter((candidate) => historyFailedTickers.has(candidate.ticker))
    .map((candidate) => {
      const values = {
        ...candidate.values,
        rsi: null,
        bbPercent: null,
        ...unknownOptionValues(),
        scanNote: "Price history was unavailable for this ticker; RSI/BB and option-chain lookups were skipped.",
      };
      return { ticker: candidate.ticker, values, summary: evaluateCandidate(rules, values), verifiedFundamentals: candidate.verifiedFundamentals };
    });

  return [...evaluated, ...priceExcluded, ...historyUnavailable, ...unavailable];
}

/** Stage 1: everything knowable from a quote alone - RSI/BB stay null until (if) Stage 2 runs. */
function buildQuoteOnlyValues(quote: MarketQuote): Record<string, number | string | boolean | null | undefined> {
  return {
    price: quote.price,
    priceChange: quote.change ?? null,
    priceChangePercent: quote.changePercent ?? null,
    stockVolume: quote.volume ?? null,
    rsi: null,
    bbPercent: null,
    doNotTrade: false,
    debtToEquity: null,
    earningsDate: null,
    earningsDistance: null,
    // Ephemeral, scan-snapshot-only fields (no reserved WatchlistItem column exists for
    // either) - Research reads these the same way it already reads Current Price, from
    // the persisted ScanResult snapshot, never written back onto WatchlistItem itself.
    companyDescription: quote.companyDescription ?? null,
    dividendFrequency: quote.fundamentals?.dividendFrequency ?? null,
  };
}

/** Stage 2: merges price-history-derived RSI/BB (and the candle-fallback volume, only relevant
 * once history has actually been fetched) into the Stage 1 quote-only values. */
function mergeHistoryValues(
  ticker: string,
  quote: MarketQuote,
  quoteValues: Record<string, number | string | boolean | null | undefined>,
  candles: PriceCandle[],
  verifiedFundamentals: QuoteFundamentals | null,
): StockStageCandidate {
  const closes = candles.map((candle) => candle.close);
  const rsi = wilderRsi(closes);
  const bands = bollingerBands(closes);

  return {
    ticker,
    quote,
    candles,
    values: {
      ...quoteValues,
      stockVolume: quoteValues.stockVolume ?? candles.at(-1)?.volume ?? null,
      rsi,
      bbPercent: bands ? bollingerPositionPercent(quote.price, bands) : null,
    },
    verifiedFundamentals,
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

/**
 * Honest reason a scanner row has no selected option contract - see docs/SCANNER_RULES.md.
 * Each code names the exact funnel stage that eliminated every candidate contract, so the UI
 * never has to show a meaningless row of dashes when OSO actually knows why. Never conflated
 * with CHAIN_UNAVAILABLE, which is a provider fetch failure, not an empty/filtered result.
 */
export type OptionScanReasonCode =
  | "CHAIN_UNAVAILABLE"
  | "NO_PUT_CONTRACTS"
  | "NO_ACCEPTABLE_STRIKE"
  | "NO_CONTRACT_WITH_POSITIVE_BID"
  | "NO_EXPIRATIONS_IN_CONFIGURED_RANGE"
  | "OPTION_LIQUIDITY_FAILED"
  | "OPTION_RULES_FAILED";

const OPTION_REASON_MESSAGES: Record<OptionScanReasonCode, string> = {
  CHAIN_UNAVAILABLE: "Option-chain data was unavailable for this ticker; result marked UNKNOWN.",
  NO_PUT_CONTRACTS: "Schwab's option chain for this ticker contained no put contracts.",
  NO_ACCEPTABLE_STRIKE: "Contracts were found, but none had a strike below the current stock price.",
  NO_CONTRACT_WITH_POSITIVE_BID: "Option chain returned, but no contract had a positive bid.",
  NO_EXPIRATIONS_IN_CONFIGURED_RANGE: "No put matched your configured DTE range.",
  OPTION_LIQUIDITY_FAILED: "Contracts found, but open interest, volume, or spread was below your rule.",
  OPTION_RULES_FAILED: "Contracts found, but none matched your other configured option rules (e.g. delta).",
};

/**
 * Option-level rules that gate contract DISCOVERY (never merely score it) when the user has
 * them enabled - matches profile.ts's own GATING_RULE_KEYS classification for these keys.
 * DTE is handled separately: it is NOT a gating rule (see profile.ts's GATING_RULE_KEYS
 * comment), so it must never hard-filter contracts unless the user has explicitly enabled it -
 * see selectDteEligible below.
 */
const LIQUIDITY_GATE_KEYS = ["optionBid", "openInterest", "spreadPercent"] as const;
const OTHER_OPTION_GATE_KEYS = ["delta"] as const;

/** The LST-documented "typical" DTE window (docs/SCANNER_RULES.md's seeded default range for
 * the dte rule itself) - reused ONLY as a tiebreak preference when the user has left the dte
 * rule disabled, never as a hidden exclusion. */
function dtePreferenceRange(): [number, number] {
  const definition = SCANNER_RULE_DEFAULTS_BY_KEY.get("dte");
  return (definition?.defaultDesired as [number, number] | undefined) ?? [14, 45];
}

/**
 * Deterministically selects the single put contract a scanner row represents, for the given
 * ticker's stock-stage candidate and its full raw option chain. Never "grabs the first
 * contract" - runs a staged funnel, each stage eliminating on one specific, honestly-named
 * reason (see OptionScanReasonCode) so a blank row always has a knowable cause:
 *
 *  1. PUT contracts only (NO_PUT_CONTRACTS if none).
 *  2. Strike below the current stock price - what "cash-secured put" means, not a configurable
 *     rule (NO_ACCEPTABLE_STRIKE if none).
 *  3. A positive bid and a real ask - a $0-bid contract cannot be sold; this is a structural
 *     floor distinct from the user's own configurable `optionBid` minimum, applied even when
 *     that rule is disabled (NO_CONTRACT_WITH_POSITIVE_BID if none).
 *  4. DTE, ONLY when the user has enabled the `dte` rule - using their own configured range,
 *     never a hardcoded window (NO_EXPIRATIONS_IN_CONFIGURED_RANGE if none). Left untouched
 *     entirely when the rule is disabled, matching its documented non-gating classification
 *     (see profile.ts's GATING_RULE_KEYS comment) - DTE must never silently exclude a contract.
 *  5. Liquidity gates - optionBid/openInterest/spreadPercent - each applied only when the user
 *     has that specific rule enabled, using its own configured threshold
 *     (OPTION_LIQUIDITY_FAILED if every surviving contract fails).
 *  6. Other option-level gates - delta - same enabled-only treatment (OPTION_RULES_FAILED if
 *     every surviving contract fails).
 *
 * Whatever survives every enabled gate is ranked by setupScore() (which already reflects every
 * enabled preference rule - RSI, BB%, ROR, annualizedRor, etc.), then by the DTE preference
 * tiebreak (only when DTE isn't an active gate), then by annualized ROR - and the top contract
 * is the row's selected put. optionVolume is intentionally never a hard gate here (it is not in
 * profile.ts's GATING_RULE_KEYS) - a FAIL there only affects score/label, never eliminates a
 * contract from being selectable.
 */
function bestPutValues(
  candidate: StockStageCandidate,
  options: OptionContractSnapshot[],
  rules: ScannerRule[],
  asOf: Date,
) {
  const blank = (reasonCode: OptionScanReasonCode) => ({
    ...candidate.values,
    ...unknownOptionValues(),
    contractReasonCode: reasonCode,
    scanNote: OPTION_REASON_MESSAGES[reasonCode],
  });

  const puts = options.filter((option) => option.optionType === "PUT").map((option) => candidateValues(candidate, option, asOf));
  if (!puts.length) {
    return blank("NO_PUT_CONTRACTS");
  }

  const otm = puts.filter((values) => {
    const strike = numericValue(values.strike);
    return strike !== null && strike < candidate.quote.price;
  });
  if (!otm.length) {
    return blank("NO_ACCEPTABLE_STRIKE");
  }

  const withBid = otm.filter((values) => {
    const bid = numericValue(values.optionBid);
    return bid !== null && bid > 0 && numericValue(values.optionAsk) !== null;
  });
  if (!withBid.length) {
    return blank("NO_CONTRACT_WITH_POSITIVE_BID");
  }

  // DTE only ever hard-filters when the user has actually enabled the rule - using their
  // configured range, never a hardcoded window. When disabled, every DTE stays eligible; see
  // the tiebreak preference applied at selection time below instead.
  const dteRule = rules.find((rule) => rule.key === "dte");
  let dteEligible = withBid;
  if (dteRule) {
    const [low, high] = dteRule.desired as [number, number];
    dteEligible = withBid.filter((values) => {
      const dte = numericValue(values.dte);
      return dte !== null && dte >= low && dte <= high;
    });
    if (!dteEligible.length) {
      return blank("NO_EXPIRATIONS_IN_CONFIGURED_RANGE");
    }
  }

  const afterLiquidity = dteEligible.filter((values) => LIQUIDITY_GATE_KEYS.every((key) => passesEnabledGate(values, rules, key)));
  if (!afterLiquidity.length) {
    return blank("OPTION_LIQUIDITY_FAILED");
  }

  const afterOtherGates = afterLiquidity.filter((values) => OTHER_OPTION_GATE_KEYS.every((key) => passesEnabledGate(values, rules, key)));
  if (!afterOtherGates.length) {
    return blank("OPTION_RULES_FAILED");
  }

  const dteHardFiltered = Boolean(dteRule);
  const [preferLow, preferHigh] = dtePreferenceRange();

  return afterOtherGates
    .map((values) => ({
      values,
      summary: evaluateCandidate(rules, values),
    }))
    .sort((left, right) => {
      const scoreDiff = setupScore(right.summary) - setupScore(left.summary);
      if (scoreDiff) {
        return scoreDiff;
      }
      if (!dteHardFiltered) {
        // Selection preference only (see dtePreferenceRange) - never an exclusion, and never
        // affects PASS/FAIL/score, only which equally-scored contract is chosen.
        const leftPreferred = isWithinRange(numericValue(left.values.dte), preferLow, preferHigh) ? 1 : 0;
        const rightPreferred = isWithinRange(numericValue(right.values.dte), preferLow, preferHigh) ? 1 : 0;
        if (leftPreferred !== rightPreferred) {
          return rightPreferred - leftPreferred;
        }
      }
      return (numericValue(right.values.annualizedRor) ?? 0) - (numericValue(left.values.annualizedRor) ?? 0);
    })[0].values;
}

function passesEnabledGate(values: Record<string, number | string | boolean | null | undefined>, rules: ScannerRule[], key: string): boolean {
  const rule = rules.find((candidate) => candidate.key === key);
  if (!rule) {
    return true; // rule disabled - never a hidden exclusion
  }
  // UNKNOWN must never eliminate a contract - only a definite FAIL means "we know this is bad."
  return evaluateCriterion(rule, values[key]).status !== "FAIL";
}

function isWithinRange(value: number | null, low: number, high: number): boolean {
  return value !== null && value >= low && value <= high;
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
    companyDescription: null,
    dividendFrequency: null,
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
    contractReasonCode: null as OptionScanReasonCode | null,
  };
}

function midpoint(bid: number, ask: number) {
  return (bid + ask) / 2;
}

function numericValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Fallback Stage 1 quote fetch for a provider without native getQuotes (e.g. the demo provider,
 * or a test fixture that only implements getQuote) - one call per symbol, concurrency-bounded
 * the same way every other per-symbol fetch in this module is, each isolated so a single bad
 * symbol never drops the others. If EVERY symbol fails, that is a systemic problem, not a
 * per-symbol one - rethrown rather than silently returning an empty map, mirroring
 * SchwabMarketDataProvider.getQuotes' own all-chunks-failed behavior.
 */
async function fetchQuotesIndividually(provider: MarketDataProvider, tickers: string[]): Promise<Map<string, MarketQuote>> {
  const outcomes = await mapWithConcurrency(tickers, SCAN_FETCH_CONCURRENCY, async (ticker) => {
    try {
      return { ticker, quote: await provider.getQuote(ticker), error: null as unknown };
    } catch (error) {
      return { ticker, quote: null, error };
    }
  });

  const succeeded = outcomes.filter((outcome): outcome is { ticker: string; quote: MarketQuote; error: null } => outcome.quote !== null);
  if (tickers.length > 0 && succeeded.length === 0) {
    throw outcomes[0]?.error;
  }

  return new Map(succeeded.map((outcome) => [outcome.ticker, outcome.quote]));
}
