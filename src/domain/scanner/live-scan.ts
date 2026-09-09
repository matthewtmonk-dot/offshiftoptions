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

/**
 * Which funnel stage a returned ticker reached - lets a caller persisting only a bounded,
 * meaningful subset of a broad-universe scan (see rerunLiveSchwabScannerForUser) reconstruct
 * funnel membership without re-deriving it from scanNote text:
 *  - STOCK_STAGE: survived Stage 1 (quote-only gating) and had its stock-level values computed
 *    (technical cache or live history, per whichever mode this scan ran in).
 *  - QUOTE_EXCLUDED: Stage 1 eliminated it on price/volume - its own real quote is still
 *    preserved, never fabricated.
 *  - HISTORY_UNAVAILABLE: the quote succeeded, but legacy live-history mode's own
 *    provider.getPriceHistory call failed for it (never produced when technicalCache is supplied -
 *    there is no live fetch to fail in that mode).
 *  - UNAVAILABLE: even the quote itself failed.
 */
export type LiveScanFunnelStage = "STOCK_STAGE" | "QUOTE_EXCLUDED" | "HISTORY_UNAVAILABLE" | "UNAVAILABLE";

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
  /** Optional because only evaluateLiveMarketScan populates it - evaluateDemoScan's fixed demo
   * candidates and any pre-existing test fixture predate this field and don't need it; a caller
   * that cares (see rerunLiveSchwabScannerForUser) treats a missing value as "STOCK_STAGE",
   * matching every producer that existed before this field was added. */
  funnelStage?: LiveScanFunnelStage;
  /** True only for the (at most maxOptionChainLookups) candidates that actually consumed an
   * option-chain request this scan - independent of whether that lookup then succeeded. Optional
   * for the same reason as funnelStage. */
  reachedOptionChainLookup?: boolean;
  /** Only present for STOCK_STAGE candidates - the same rank used to choose the option-chain
   * shortlist (lower = stronger). Exposed so a caller persisting a bounded, ranked subset of a
   * broad-universe scan never has to reimplement the ranking formula (see
   * rerunLiveSchwabScannerForUser's own result cap). */
  stockStageRank?: number;
};

/** Structurally identical to technical-indicator-cache.ts's own TechnicalIndicatorLookup - kept as
 * an independent domain-layer type (this module has zero imports from src/lib) rather than a
 * cross-layer import; TypeScript's structural typing means the real lib type is assignable here
 * without any explicit conversion at the call site. */
export type LiveScanTechnicalLookup =
  | { state: "READY"; rsi: number | null; bbLower: number | null; bbMiddle: number | null; bbUpper: number | null }
  | { state: "TECHNICAL_DATA_STALE"; rsi: number | null; bbLower: number | null; bbMiddle: number | null; bbUpper: number | null }
  | { state: "TECHNICAL_DATA_PENDING" }
  | { state: "HISTORY_UNAVAILABLE" };

/** Structurally compatible with earnings-calendar-cache.ts's TickerEarningsLookup, with reportDate
 * pre-formatted as an ISO date string (matching how this module already stores earningsDate). */
export type LiveScanEarningsLookup = { daysUntilReport: number; reportDate: string };

export type LiveScanOptions = {
  provider: MarketDataProvider;
  rules: ScannerRule[];
  universe?: string[];
  asOf?: Date;
  maxOptionChainLookups?: number;
  /**
   * User-scoped technical cache (RSI/BB bands) - see technical-indicator-cache.ts's
   * getTechnicalIndicatorSnapshotsForUser. CRITICAL: when this is provided, Stage 2 NEVER calls
   * provider.getPriceHistory - a missing/stale/failed cache entry is reported honestly (see
   * TECHNICAL_SCAN_REASON_MESSAGES) rather than triggering a live fetch, so a broad (hundreds/
   * thousands-symbol) universe never fetches price history for the whole universe. When this
   * option is omitted entirely (legacy/demo/test callers - see this module's own test suite),
   * Stage 2 falls back to its original per-candidate live provider.getPriceHistory call, exactly
   * as before this option existed.
   */
  technicalCache?: Map<string, LiveScanTechnicalLookup>;
  /** Shared earnings-calendar cache lookup - see earnings-calendar-cache.ts's
   * getEarningsCalendarLookup. Never a live Alpha Vantage call. A ticker absent from this map
   * (or the option omitted) reports earningsDistance/earningsDate as null - UNKNOWN, exactly as
   * before this option existed - never a fabricated "no earnings" claim. */
  earningsLookup?: Map<string, LiveScanEarningsLookup>;
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
const STOCK_STAGE_RULE_KEYS = new Set(["price", "stockVolume", "rsi", "bbPercent", "doNotTrade", "debtToEquity", "earningsDistance"]);
/** Stage 1 of the stock-level funnel: rules answerable from a quote alone, with no history
 * fetch or technical-cache read. Kept as a subset of STOCK_STAGE_RULE_KEYS, never a separate rule
 * vocabulary - see evaluateLiveMarketScan's two-stage stock funnel below. Includes stockVolume
 * alongside price (both answerable from the Stage 1 quote alone) so a broad universe never spends
 * a technical-cache read, earnings lookup, or option-chain request on a ticker this user's own
 * volume rule already excludes. */
const QUOTE_ONLY_STOCK_RULE_KEYS = new Set(["price", "stockVolume"]);

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
  technicalCache,
  earningsLookup,
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

  let stockStage: StockStageCandidate[];
  let historyFailedTickers: Set<string>;

  if (technicalCache) {
    // CRITICAL: no provider.getPriceHistory call anywhere in this branch - technical values come
    // exclusively from the caller-supplied cache (see LiveScanOptions.technicalCache's own doc
    // comment). Never used for a broad universe without this being true.
    stockStage = quoteEligible.map((candidate) =>
      mergeTechnicalCacheValues(candidate, technicalCache.get(candidate.ticker), earningsLookup?.get(candidate.ticker)),
    );
    historyFailedTickers = new Set(); // no live fetch exists in this mode, so nothing can fail this way
  } else {
    // Legacy/demo/test mode (no technicalCache supplied) - unchanged from before this option
    // existed: one live provider.getPriceHistory call per quote-stage survivor.
    const historyOutcomes = await mapWithConcurrency<QuoteStageOutcome & { ok: true }, StockStageOutcome>(
      quoteEligible,
      SCAN_FETCH_CONCURRENCY,
      async (candidate) => {
        try {
          const candles = await provider.getPriceHistory(candidate.ticker, 80);
          return {
            ticker: candidate.ticker,
            ok: true,
            candidate: mergeHistoryValues(
              candidate.ticker,
              candidate.quote,
              candidate.values,
              candles,
              candidate.verifiedFundamentals,
              earningsLookup?.get(candidate.ticker),
            ),
          };
        } catch (error) {
          return { ticker: candidate.ticker, ok: false, error };
        }
      },
    );

    stockStage = historyOutcomes
      .filter((outcome): outcome is StockStageOutcome & { ok: true } => outcome.ok)
      .map((outcome) => outcome.candidate);
    historyFailedTickers = new Set(
      historyOutcomes.filter((outcome): outcome is StockStageOutcome & { ok: false } => !outcome.ok).map((outcome) => outcome.ticker),
    );
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
    const reachedOptionChainLookup = shortlistTickers.has(candidate.ticker);
    const values = reachedOptionChainLookup
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
          // A candidate may already carry a more specific reason (e.g. technicalReasonCode's own
          // scanNote, set in mergeTechnicalCacheValues) - preserved rather than overwritten by
          // this generic fallback, which only applies when nothing more specific is known.
          scanNote: candidate.values.scanNote ?? "Stock-stage filter did not reach option-chain lookup in this controlled live scan.",
        };

    return {
      ticker: candidate.ticker,
      values,
      summary: evaluateCandidate(rules, values),
      verifiedFundamentals: candidate.verifiedFundamentals ?? null,
      funnelStage: "STOCK_STAGE" as const,
      reachedOptionChainLookup,
      // The exact same rank used for shortlist selection above (lower = stronger; a real READY
      // technical value always ranks better than a pending/stale/failed one, which is pinned at
      // the maximum possible score - see stockStageRank's own doc comment) - exposed so a caller
      // persisting a bounded, ranked subset of a broad-universe scan (see
      // rerunLiveSchwabScannerForUser) never has to reimplement this formula.
      stockStageRank: stockStageRank(candidate),
    };
  });

  const unavailable = unavailableTickers.map((outcome) => {
    const values = {
      ...unknownStockValues(),
      ...unknownOptionValues(),
      scanNote: "Live market data was unavailable for this ticker; result marked UNKNOWN.",
    };
    return {
      ticker: outcome.ticker,
      values,
      summary: evaluateCandidate(rules, values),
      verifiedFundamentals: null,
      funnelStage: "UNAVAILABLE" as const,
      reachedOptionChainLookup: false,
    };
  });

  // Stage 1 excluded these on price and/or volume - a real quote was fetched (never fabricated),
  // but history/RSI/BB/option-chain requests were never spent on a ticker already known to be
  // outside this user's own configured quote-stage rules.
  const priceExcluded = quoteExcluded.map((candidate) => {
    const values = {
      ...candidate.values,
      ...unknownOptionValues(),
      scanNote: quoteStageExclusionScanNote(evaluateCandidate(quoteOnlyRules, candidate.values).results),
    };
    return {
      ticker: candidate.ticker,
      values,
      summary: evaluateCandidate(rules, values),
      verifiedFundamentals: candidate.verifiedFundamentals,
      funnelStage: "QUOTE_EXCLUDED" as const,
      reachedOptionChainLookup: false,
    };
  });

  // A real quote succeeded but the price-history request itself failed - distinct from
  // priceExcluded (a deliberate filter) and from unavailableTickers (the quote itself failed).
  // Only ever produced in legacy (no technicalCache) mode - historyFailedTickers is always empty
  // when a technical cache is supplied, since there is no live fetch to fail in that mode.
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
      return {
        ticker: candidate.ticker,
        values,
        summary: evaluateCandidate(rules, values),
        verifiedFundamentals: candidate.verifiedFundamentals,
        funnelStage: "HISTORY_UNAVAILABLE" as const,
        reachedOptionChainLookup: false,
      };
    });

  return [...evaluated, ...priceExcluded, ...historyUnavailable, ...unavailable];
}

/** Honest, specific reason a Stage 1 quote-stage exclusion happened - price, volume, or both.
 * Preserves the exact original price-only message (some tests assert on it verbatim) while
 * adding accurate wording for the newly-added volume gate (see QUOTE_ONLY_STOCK_RULE_KEYS). */
function quoteStageExclusionScanNote(results: ReturnType<typeof evaluateCandidate>["results"]): string {
  const failedKeys = new Set(results.filter((result) => result.status === "FAIL").map((result) => result.key));
  const priceFailed = failedKeys.has("price");
  const volumeFailed = failedKeys.has("stockVolume");

  if (priceFailed && volumeFailed) {
    return "Outside your configured stock price range and below your minimum underlying volume; history and option-chain lookups were skipped.";
  }
  if (volumeFailed) {
    return "Below your configured minimum underlying volume; history and option-chain lookups were skipped.";
  }
  return "Outside your configured stock price range; history and option-chain lookups were skipped.";
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

/** Honest, specific reason a candidate's technical values (RSI/BB) are null when they come from
 * the user-scoped cache rather than a live history fetch - distinguishes a background job that
 * simply hasn't reached this ticker yet from a genuinely stale or failed one, so the scan's
 * scanNote/summary can be specific rather than a generic "unknown." Never fabricated for the
 * legacy (no technicalCache) live-history mode, which has its own distinct historyUnavailable
 * category instead. */
export type TechnicalScanReasonCode = "TECHNICAL_DATA_PENDING" | "TECHNICAL_DATA_STALE" | "TECHNICAL_DATA_FAILED";

const TECHNICAL_SCAN_REASON_MESSAGES: Record<TechnicalScanReasonCode, string> = {
  TECHNICAL_DATA_PENDING: "Technical preparation for this ticker has not completed yet; RSI/BB are pending.",
  TECHNICAL_DATA_STALE: "Cached technical data for this ticker is stale; RSI/BB were not used to avoid a false read.",
  TECHNICAL_DATA_FAILED: "Technical preparation failed for this ticker; RSI/BB are unavailable.",
};

function earningsValuesFor(entry: LiveScanEarningsLookup | undefined): { earningsDate: string | null; earningsDistance: number | null } {
  if (!entry) {
    return { earningsDate: null, earningsDistance: null };
  }
  return { earningsDate: entry.reportDate, earningsDistance: entry.daysUntilReport };
}

/** Stage 2 (legacy/demo/test mode only - see LiveScanOptions.technicalCache): merges
 * price-history-derived RSI/BB (and the candle-fallback volume, only relevant once history has
 * actually been fetched) into the Stage 1 quote-only values, plus the earnings-cache lookup
 * (independent of which technical mode is active). */
function mergeHistoryValues(
  ticker: string,
  quote: MarketQuote,
  quoteValues: Record<string, number | string | boolean | null | undefined>,
  candles: PriceCandle[],
  verifiedFundamentals: QuoteFundamentals | null,
  earningsEntry: LiveScanEarningsLookup | undefined,
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
      ...earningsValuesFor(earningsEntry),
      stockVolume: quoteValues.stockVolume ?? candles.at(-1)?.volume ?? null,
      rsi,
      bbPercent: bands ? bollingerPositionPercent(quote.price, bands) : null,
    },
    verifiedFundamentals,
  };
}

/** Stage 2 (technical-cache mode - see LiveScanOptions.technicalCache): NEVER calls
 * provider.getPriceHistory. Only a READY cache entry contributes real rsi/bands; every other
 * state (stale/pending/failed/missing) leaves rsi/bbPercent null with an honest
 * technicalReasonCode + scanNote - evaluateCriterion already treats a null actualValue as UNKNOWN
 * (never PASS, never FAIL), so a non-READY ticker can never fake a PASS on rsi/bbPercent. BB
 * position is always recomputed from the LIVE quote price + cached bands (bollingerPositionPercent),
 * never a stale precomputed percent - matching the cache's own documented contract. */
function mergeTechnicalCacheValues(
  candidate: QuoteStageOutcome & { ok: true },
  technical: LiveScanTechnicalLookup | undefined,
  earningsEntry: LiveScanEarningsLookup | undefined,
): StockStageCandidate {
  const base = {
    ticker: candidate.ticker,
    quote: candidate.quote,
    candles: [] as PriceCandle[],
    verifiedFundamentals: candidate.verifiedFundamentals,
  };
  const earnings = earningsValuesFor(earningsEntry);

  // Only a READY entry ever contributes a real rsi/bbPercent - stale/pending/failed/missing all
  // fall through to the honest reason-code branch below, exactly per the "stale technical cannot
  // fake PASS" requirement (evaluateCriterion treats a null actualValue as UNKNOWN, never PASS).
  if (technical?.state === "READY") {
    const bands =
      technical.bbLower !== null && technical.bbMiddle !== null && technical.bbUpper !== null
        ? { lower: technical.bbLower, middle: technical.bbMiddle, upper: technical.bbUpper }
        : null;
    return {
      ...base,
      values: {
        ...candidate.values,
        ...earnings,
        rsi: technical.rsi,
        // Bands genuinely never computed yet (fewer than 20 real closes existed when the
        // background worker last ran) - bbPercent honestly stays null even though rsi may be real.
        bbPercent: bands ? bollingerPositionPercent(candidate.quote.price, bands) : null,
      },
    };
  }

  const reasonCode: TechnicalScanReasonCode =
    technical?.state === "TECHNICAL_DATA_STALE"
      ? "TECHNICAL_DATA_STALE"
      : technical?.state === "HISTORY_UNAVAILABLE"
        ? "TECHNICAL_DATA_FAILED"
        : "TECHNICAL_DATA_PENDING"; // covers TECHNICAL_DATA_PENDING and a missing map entry

  return {
    ...base,
    values: {
      ...candidate.values,
      ...earnings,
      rsi: null,
      bbPercent: null,
      technicalReasonCode: reasonCode,
      scanNote: TECHNICAL_SCAN_REASON_MESSAGES[reasonCode],
    },
  };
}

function stockStageIsEligible(candidate: StockStageCandidate, rules: ScannerRule[]) {
  const stockRules = rules.filter((rule) => STOCK_STAGE_RULE_KEYS.has(rule.key));
  const summary = evaluateCandidate(stockRules, candidate.values);
  return !summary.results.some((result) => result.status === "FAIL");
}

/**
 * Lower is stronger. A real RSI is 0-100 and a real bbPercent is typically 0-100, so a genuinely
 * READY candidate's rank is always <= 100 + 100/10 = 110 - a missing value (pending/stale/failed
 * technical data, via `?? 100`) is PINNED AT EXACTLY that same worst-case ceiling. This
 * structurally guarantees a READY candidate never ranks worse than a non-READY one for any real
 * (finite, in-range) RSI/BB combination, so the scarce option-chain shortlist below can never
 * systematically prefer pending/stale/failed technicals over technically-qualified ones - verified
 * directly by live-scan.technical-cache.test.ts.
 */
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

/**
 * Real, pre-existing bug fixed here (found during broad-scanner activation - see
 * PROJECT_HANDOFF.md): `Number(null) === 0` and `Number(undefined) === NaN` in JavaScript, so
 * without this explicit guard, a genuinely missing/unknown value (e.g. a PENDING candidate's null
 * rsi/bbPercent in stockStageRank) silently coerced to the numeric value 0 - the BEST possible
 * rank - rather than being treated as unknown. This was dormant for years because every other
 * call site of this function (strike/bid/ask/dte from a real option contract) is never actually
 * null in practice; only stockStageRank's rsi/bbPercent - always null for a non-READY technical
 * candidate under the broad-universe technical cache - exercised it at real scale, letting
 * PENDING candidates systematically outrank genuinely READY ones for the scarce option-chain
 * shortlist. Confirmed safe for every other call site: annualizedRor's own comparison already has
 * its own explicit `?? 0` fallback (identical result either way), and strike/bid/ask/dte are
 * always real numbers from an actual OptionContractSnapshot, never null, at every other call site.
 */
function numericValue(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
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
