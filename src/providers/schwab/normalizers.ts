import type {
  EquityMarketSessionEvidence,
  EquityRegularSessionInterval,
  MarketQuote,
  OptionContractSnapshot,
  PriceCandle,
  QuoteReviewEvidence,
} from "@/providers/market-data/types";
import { nyCalendarDateOf } from "@/domain/finance/marketSession";

type UnknownRecord = Record<string, unknown>;

export function normalizeSchwabQuoteResponse(symbol: string, payload: unknown): MarketQuote {
  const normalizedSymbol = symbol.toUpperCase();
  const record = objectValue(payload)?.[normalizedSymbol] ?? firstObjectValue(payload);
  const quote = normalizeSchwabQuoteRecord(normalizedSymbol, record);
  if (!quote) {
    throw new Error(`Schwab quote response did not include a usable price for ${normalizedSymbol}.`);
  }
  return quote;
}

/**
 * Batch counterpart of normalizeSchwabQuoteResponse - Schwab's `/quotes` response is ALWAYS
 * shaped as one object keyed by uppercase symbol, whether one or many symbols were requested
 * (normalizeSchwabQuoteResponse already relied on this for the single-symbol case). Each
 * requested symbol is normalized independently: a symbol missing from the payload, or missing a
 * usable price, is simply absent from the returned Map - never thrown, never fabricated, so one
 * bad/delisted/invalid symbol in a batch can never prevent the other symbols in the same
 * response from being read. See SchwabMarketDataProvider.getQuotes.
 */
export function normalizeSchwabQuotesResponse(symbols: string[], payload: unknown): Map<string, MarketQuote> {
  const container = objectValue(payload);
  const result = new Map<string, MarketQuote>();
  for (const symbol of symbols) {
    const normalizedSymbol = symbol.toUpperCase();
    const record = container?.[normalizedSymbol];
    const quote = normalizeSchwabQuoteRecord(normalizedSymbol, record);
    if (quote) {
      result.set(normalizedSymbol, quote);
    }
  }
  return result;
}

function normalizeSchwabQuoteRecord(normalizedSymbol: string, record: unknown): MarketQuote | null {
  const quote = objectValue(objectValue(record)?.quote);
  const regular = objectValue(objectValue(record)?.regular);
  const reference = objectValue(objectValue(record)?.reference);
  const fundamental = objectValue(objectValue(record)?.fundamental);

  const price =
    numberValue(quote?.lastPrice) ??
    numberValue(regular?.regularMarketLastPrice) ??
    numberValue(quote?.mark) ??
    numberValue(quote?.closePrice);

  if (price === null) {
    return null;
  }

  const asOf = dateFromEpoch(
    numberValue(quote?.quoteTimeInLong) ??
      numberValue(regular?.regularMarketTradeTimeInLong) ??
      numberValue(objectValue(record)?.quoteTimeInLong),
  );

  return {
    symbol: normalizedSymbol,
    price,
    change: numberValue(quote?.netChange) ?? numberValue(regular?.regularMarketNetChange) ?? undefined,
    changePercent:
      numberValue(quote?.netPercentChange) ?? numberValue(regular?.regularMarketPercentChange) ?? undefined,
    volume: integerValue(quote?.totalVolume) ?? integerValue(regular?.regularMarketTradeSize) ?? undefined,
    asOf,
    companyDescription: stringValue(reference?.description),
    fundamentals: fundamental
      ? {
          peRatio: numberValue(fundamental.peRatio),
          eps: numberValue(fundamental.eps),
          dividendAmount: numberValue(fundamental.divAmount),
          dividendYield: numberValue(fundamental.divYield),
          dividendFrequency: numberValue(fundamental.divFreq),
        }
      : null,
  };
}

export function normalizeSchwabPriceHistoryResponse(symbol: string, payload: unknown): PriceCandle[] {
  const candles = arrayValue(objectValue(payload)?.candles);
  return candles.flatMap((item) => {
    const candle = objectValue(item);
    const datetime = numberValue(candle?.datetime);
    const open = numberValue(candle?.open);
    const high = numberValue(candle?.high);
    const low = numberValue(candle?.low);
    const close = numberValue(candle?.close);
    const volume = numberValue(candle?.volume);

    if (datetime === null || open === null || high === null || low === null || close === null || volume === null) {
      return [];
    }

    return {
      symbol: symbol.toUpperCase(),
      date: new Date(datetime),
      open,
      high,
      low,
      close,
      volume,
    };
  });
}

export function normalizeSchwabOptionChainResponse(payload: unknown): OptionContractSnapshot[] {
  const root = objectValue(payload);
  const underlyingSymbol = stringValue(root?.symbol)?.toUpperCase() ?? stringValue(root?.underlyingSymbol)?.toUpperCase() ?? "";
  return [
    ...contractsFromMap(root?.putExpDateMap, "PUT", underlyingSymbol),
    ...contractsFromMap(root?.callExpDateMap, "CALL", underlyingSymbol),
  ];
}

export function normalizeSchwabInstrument(symbol: string, payload: unknown) {
  const root = objectValue(payload);
  const instruments = arrayValue(root?.instruments);
  const first = objectValue(instruments[0]) ?? objectValue(firstObjectValue(payload));

  return {
    symbol: stringValue(first?.symbol)?.toUpperCase() ?? symbol.toUpperCase(),
    description: stringValue(first?.description) ?? `${symbol.toUpperCase()} Schwab instrument`,
    assetType: stringValue(first?.assetType) ?? stringValue(first?.type) ?? "UNKNOWN",
  };
}

export function normalizeSchwabMarketHours(payload: unknown) {
  const root = objectValue(payload);
  const equity = objectValue(root?.equity) ?? firstObjectValue(payload);
  const sessionHours = objectValue(equity?.sessionHours);
  const regularHours = arrayValue(sessionHours?.regularMarket);
  const firstSession = objectValue(regularHours[0]);
  const opensAt = dateValue(firstSession?.start);
  const closesAt = dateValue(firstSession?.end);
  const isOpen = Boolean(equity?.isOpen ?? (opensAt && closesAt));

  return {
    isOpen,
    opensAt: opensAt ?? undefined,
    closesAt: closesAt ?? undefined,
  };
}

export type SchwabQuoteReviewTransportEvidence = {
  /** This app's own observation of when the request/response happened - never substituted for
   * the provider's own quote.tradeTime. */
  requestStartedAt: Date;
  responseReceivedAt: Date;
};

/**
 * Dashboard V2 Phase 2 - ADDITIVE producer of QuoteReviewEvidence from a Schwab `/quotes`
 * response. Deliberately separate from normalizeSchwabQuoteRecord above: that function's price
 * and timestamp are each chosen from independent fallback chains (quote.lastPrice ??
 * regular.regularMarketLastPrice ?? quote.mark ?? quote.closePrice, paired independently with
 * quote.quoteTimeInLong ?? regular.regularMarketTradeTimeInLong) - exactly the defect this
 * evidence type exists to avoid. This function reads ONLY quote.lastPrice + quote.tradeTime as a
 * single atomic pair; if either is absent/invalid, the whole result is UNAVAILABLE, with no
 * fallback to any other field (not quoteTime, not regular.regularMarketTradeTime, not mark, not
 * closePrice, not extended-hours prices - a live capture showed regular.regularMarketTradeTime
 * reporting ~20:00 ET on an after-hours capture, so it must never be trusted as a regular-session
 * trade time).
 *
 * Symbol matching: looks the record up by the exact `requestedSymbol` key - never Schwab's own
 * first-object-in-payload fallback (unlike normalizeSchwabQuoteResponse above) - and additionally
 * requires the record's own `symbol` field to equal `requestedSymbol` exactly (no case-folding).
 * Either check failing means UNAVAILABLE, never a substituted record.
 */
export function normalizeSchwabQuoteReviewEvidence(
  requestedSymbol: string,
  payload: unknown,
  transport: SchwabQuoteReviewTransportEvidence,
): QuoteReviewEvidence {
  const record = objectValue(objectValue(payload)?.[requestedSymbol]);
  if (!record) {
    return { status: "UNAVAILABLE", reason: `No Schwab quote record found for symbol "${requestedSymbol}".` };
  }

  const returnedSymbol = stringValue(record.symbol);
  if (returnedSymbol === null || returnedSymbol !== requestedSymbol) {
    return {
      status: "UNAVAILABLE",
      reason: `Schwab quote record symbol "${returnedSymbol ?? "missing"}" did not exactly match the requested symbol "${requestedSymbol}".`,
    };
  }

  const quote = objectValue(record.quote);
  const price = numberValue(quote?.lastPrice);
  const tradeTimeEpochMs = numberValue(quote?.tradeTime);
  if (price === null || tradeTimeEpochMs === null) {
    return {
      status: "UNAVAILABLE",
      reason: `Schwab quote for "${requestedSymbol}" is missing an atomic quote.lastPrice/quote.tradeTime pair.`,
    };
  }

  return {
    status: "AVAILABLE",
    requestedSymbol,
    returnedSymbol,
    assetMainType: stringValue(record.assetMainType),
    realtime: typeof record.realtime === "boolean" ? record.realtime : null,
    price,
    tradeTime: new Date(tradeTimeEpochMs),
    requestStartedAt: transport.requestStartedAt,
    responseReceivedAt: transport.responseReceivedAt,
  };
}

/**
 * Dashboard V2 Phase 2 - ADDITIVE producer of EquityMarketSessionEvidence from a Schwab
 * `/markets?markets=equity` response. Deliberately separate from normalizeSchwabMarketHours
 * above: that function assumes a flat shape, falls back to `firstObjectValue(payload)` when
 * `equity` is absent, and only ever reads `regularHours[0]` - exactly the risks this evidence
 * type exists to avoid. This function parses ONLY through `equity.EQ`, validates every
 * regularMarket interval (never just the first), and returns UNAVAILABLE - never "closed" - for
 * any malformed, missing, or contradictory shape.
 */
export function normalizeSchwabEquityMarketSessionEvidence(requestedNyDate: string, payload: unknown): EquityMarketSessionEvidence {
  const equity = objectValue(objectValue(payload)?.equity);
  const eq = objectValue(equity?.EQ);
  if (!eq) {
    return { status: "UNAVAILABLE", reason: "Schwab market-hours payload did not include equity.EQ." };
  }

  const returnedDate = stringValue(eq.date);
  if (returnedDate === null || returnedDate !== requestedNyDate) {
    return {
      status: "UNAVAILABLE",
      reason: `Schwab market-hours date "${returnedDate ?? "missing"}" did not match the requested date "${requestedNyDate}".`,
    };
  }

  const marketType = stringValue(eq.marketType);
  if (marketType !== "EQUITY") {
    return { status: "UNAVAILABLE", reason: `Unexpected Schwab market-hours marketType "${marketType ?? "missing"}".` };
  }

  const product = stringValue(eq.product);
  if (product !== "EQ") {
    return { status: "UNAVAILABLE", reason: `Unexpected Schwab market-hours product "${product ?? "missing"}".` };
  }

  if (typeof eq.isOpen !== "boolean") {
    return { status: "UNAVAILABLE", reason: "Schwab market-hours isOpen was not an actual boolean." };
  }

  // "regularMarket missing/malformed entirely" (not an array at all, or absent) must be told apart
  // from "regularMarket is a real, empty array" so a genuinely closed day (which legitimately
  // reports no intervals) is never confused with a structurally broken response on an open day.
  const sessionHours = objectValue(eq.sessionHours);
  const regularMarketValue = sessionHours?.regularMarket;
  const regularMarketIsWellFormedArray = Array.isArray(regularMarketValue);
  const regularMarketRaw = regularMarketIsWellFormedArray ? regularMarketValue : [];

  // Codex P1 (B2): isOpen and the regularMarket intervals are two independent claims from the
  // same response - they must agree, never let one silently override the other. isOpen:false with
  // intervals supplied is a contradiction (which is actually open?); isOpen:true with no
  // structurally valid intervals is a missing-evidence case - neither is a value shape this
  // function may reinterpret as CLOSED. Only isOpen:false with NO intervals supplied is genuine,
  // trustworthy closed-day evidence.
  if (eq.isOpen === false && regularMarketRaw.length > 0) {
    return { status: "UNAVAILABLE", reason: "Schwab market-hours reported isOpen: false alongside regular-session intervals - contradictory evidence." };
  }
  if (eq.isOpen === true && (!regularMarketIsWellFormedArray || regularMarketRaw.length === 0)) {
    return { status: "UNAVAILABLE", reason: "Schwab market-hours reported isOpen: true but no regular-session intervals were present." };
  }

  const intervals: EquityRegularSessionInterval[] = [];
  for (const item of regularMarketRaw) {
    const interval = objectValue(item);
    const start = dateValueWithExplicitOffset(interval?.start);
    const end = dateValueWithExplicitOffset(interval?.end);
    if (!start || !end || start.getTime() >= end.getTime()) {
      return { status: "UNAVAILABLE", reason: "Schwab market-hours reported a regular-session interval with an invalid, ambiguous, or backwards start/end." };
    }
    // Codex P1 (B2): BOTH ends must belong to the requested NY calendar date - checking only
    // `start` let a malformed `end` silently cross into the next NY date.
    if (nyCalendarDateOf(start) !== requestedNyDate || nyCalendarDateOf(end) !== requestedNyDate) {
      return {
        status: "UNAVAILABLE",
        reason: "Schwab market-hours reported a regular-session interval that does not belong entirely to the requested NY date.",
      };
    }
    intervals.push({ start, end });
  }

  const sortedIntervals = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  for (let i = 1; i < sortedIntervals.length; i += 1) {
    if (sortedIntervals[i]!.start.getTime() < sortedIntervals[i - 1]!.end.getTime()) {
      return { status: "UNAVAILABLE", reason: "Schwab market-hours reported overlapping regular-session intervals." };
    }
  }

  return {
    status: "AVAILABLE",
    requestedDate: requestedNyDate,
    returnedDate,
    marketType,
    product,
    isOpen: eq.isOpen,
    regularMarketIntervals: sortedIntervals,
  };
}

/**
 * Codex P1 (B2): a bare "2026-06-15T09:30:00" (no `Z`, no explicit +/-HH:MM offset) is parsed by
 * `Date` as LOCAL time per the ECMAScript spec - ambiguous and runtime-dependent, exactly the
 * defect this function exists to reject. Only a string carrying its own explicit offset is
 * accepted; anything else (including a value that `new Date()` would otherwise happily parse) is
 * treated as invalid.
 */
const EXPLICIT_OFFSET_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function dateValueWithExplicitOffset(value: unknown): Date | null {
  const text = stringValue(value);
  if (!text || !EXPLICIT_OFFSET_DATETIME_PATTERN.test(text)) {
    return null;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function contractsFromMap(mapValue: unknown, optionType: "PUT" | "CALL", fallbackUnderlying: string) {
  const expirationMap = objectValue(mapValue);
  if (!expirationMap) {
    return [];
  }

  const contracts: OptionContractSnapshot[] = [];
  for (const [expirationKey, strikesValue] of Object.entries(expirationMap)) {
    const expiration = parseExpiration(expirationKey);
    const strikes = objectValue(strikesValue);
    if (!expiration || !strikes) {
      continue;
    }

    for (const options of Object.values(strikes)) {
      for (const option of arrayValue(options)) {
        const contract = objectValue(option);
        const strike = numberValue(contract?.strikePrice);
        const bid = numberValue(contract?.bid);
        const ask = numberValue(contract?.ask);
        const mark = numberValue(contract?.mark) ?? midpoint(bid, ask);
        if (strike === null || bid === null || ask === null || mark === null) {
          continue;
        }

        contracts.push({
          symbol: stringValue(contract?.symbol) ?? `${fallbackUnderlying} ${expirationKey} ${optionType}${strike}`,
          underlyingSymbol:
            stringValue(contract?.underlyingSymbol)?.toUpperCase() ||
            stringValue(contract?.underlying)?.toUpperCase() ||
            fallbackUnderlying,
          optionType,
          strike,
          expiration,
          bid,
          ask,
          mark,
          last: numberValue(contract?.last) ?? undefined,
          delta: numberValue(contract?.delta) ?? undefined,
          gamma: numberValue(contract?.gamma) ?? undefined,
          theta: numberValue(contract?.theta) ?? undefined,
          vega: numberValue(contract?.vega) ?? undefined,
          impliedVolatility: numberValue(contract?.volatility) ?? numberValue(contract?.impliedVolatility) ?? undefined,
          openInterest: integerValue(contract?.openInterest) ?? undefined,
          volume: integerValue(contract?.totalVolume) ?? integerValue(contract?.volume) ?? undefined,
        });
      }
    }
  }

  return contracts;
}

function parseExpiration(value: string) {
  const [datePart] = value.split(":");
  const date = new Date(`${datePart}T20:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function midpoint(bid: number | null, ask: number | null) {
  return bid === null || ask === null ? null : (bid + ask) / 2;
}

function objectValue(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function firstObjectValue(value: unknown): UnknownRecord | null {
  const root = objectValue(value);
  if (!root) {
    return null;
  }

  return objectValue(Object.values(root)[0]);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberValue(value: unknown): number | null {
  // `Number(null)` is 0 (finite!) - guard explicitly so an explicit null/undefined value is
  // never mistaken for a real, present 0. A real 0 (e.g. Schwab's divYield: 0) must still
  // come through as 0, not be swallowed by this guard.
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerValue(value: unknown): number | null {
  const parsed = numberValue(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function dateFromEpoch(value: number | null) {
  return value === null ? new Date() : new Date(value);
}

function dateValue(value: unknown): Date | null {
  const text = stringValue(value);
  if (!text) {
    return null;
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}
