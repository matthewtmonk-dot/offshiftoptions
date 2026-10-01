import type {
  EquityMarketSessionEvidence,
  EquityRegularSessionInterval,
  MarketQuote,
  OptionContractSnapshot,
  PriceCandle,
  QuoteReviewEvidence,
  StrictOptionChainRequestEvidence,
  StrictOptionChainSnapshot,
  StrictOptionChainTransportEvidence,
  StrictOptionContractSnapshot,
  StrictOptionDeliverableEvidence,
} from "@/providers/market-data/types";
import { STRICT_OPTION_EVIDENCE_POLICY_VERSION } from "@/providers/market-data/types";
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

/**
 * Trade Prep strict option-evidence foundation - ADDITIVE and deliberately separate from
 * normalizeSchwabOptionChainResponse above, which stays completely unmodified. Where that
 * function synthesizes a fallback symbol and flattens/drops contract-terms and quote-timing
 * evidence for the production-approved Scanner, this function does the opposite: it is a purely
 * mechanical extraction of every field the strict evidence contract needs, preserving `null` for
 * anything missing, the wrong JavaScript type, or not finite, rather than ever fabricating,
 * coercing, or falling back to a different field (see `strictNumber`'s own doc comment - a numeric
 * string, a boolean, or a fractional value where an integer is later required all become `null`/
 * the raw value as-is, never a manufactured number). It performs NO cross-field consistency
 * checking or validation itself (no identity/quote/terms/session judgment calls) - that is
 * entirely the job of the pure evaluators in src/domain/trade-prep/optionEvidence.ts, which this
 * function's output feeds.
 */
export function normalizeSchwabStrictOptionChainSnapshot(
  payload: unknown,
  request: StrictOptionChainRequestEvidence,
  transport: Omit<StrictOptionChainTransportEvidence, "provider" | "evidencePolicyVersion">,
): StrictOptionChainSnapshot {
  const transportEvidence: StrictOptionChainTransportEvidence = {
    provider: "SCHWAB",
    requestStartedAt: transport.requestStartedAt,
    responseReceivedAt: transport.responseReceivedAt,
    httpDateHeader: transport.httpDateHeader,
    evidencePolicyVersion: STRICT_OPTION_EVIDENCE_POLICY_VERSION,
  };

  const root = objectValue(payload);
  if (!root) {
    return { status: "UNAVAILABLE", reason: "Schwab option chain response was not a usable object.", transport: transportEvidence };
  }

  return {
    status: "AVAILABLE",
    envelope: {
      status: stringValue(root.status),
      rootSymbol: exactStringValue(root.symbol),
      isDelayed: typeof root.isDelayed === "boolean" ? root.isDelayed : null,
    },
    request: { ...request, requestedUnderlying: request.requestedUnderlying.toUpperCase() },
    contracts: [...strictContractsFromMap(root.putExpDateMap, "PUT"), ...strictContractsFromMap(root.callExpDateMap, "CALL")],
    transport: transportEvidence,
  };
}

function strictContractsFromMap(mapValue: unknown, originatingMap: "PUT" | "CALL"): StrictOptionContractSnapshot[] {
  const expirationMap = objectValue(mapValue);
  if (!expirationMap) {
    return [];
  }

  const contracts: StrictOptionContractSnapshot[] = [];
  for (const [expirationMapKey, strikesValue] of Object.entries(expirationMap)) {
    const strikes = objectValue(strikesValue);
    if (!strikes) {
      continue;
    }
    for (const [strikeMapKey, optionsValue] of Object.entries(strikes)) {
      for (const option of arrayValue(optionsValue)) {
        contracts.push(strictContractFrom(objectValue(option), expirationMapKey, strikeMapKey, originatingMap));
      }
    }
  }
  return contracts;
}

function strictContractFrom(
  record: UnknownRecord | null,
  expirationMapKey: string,
  strikeMapKey: string,
  originatingMap: "PUT" | "CALL",
): StrictOptionContractSnapshot {
  const providerSymbol = record ? exactStringValue(record.symbol) : null;
  return {
    location: { expirationMapKey, strikeMapKey, originatingMap },
    identity: {
      providerSymbol,
      putCall: record ? exactStringValue(record.putCall) : null,
      strikePrice: record ? strictNumber(record.strikePrice) : null,
      expirationDate: record ? dateValueWithExplicitOffset(record.expirationDate) : null,
      // Schwab's own raw `optionRoot` field, read as-is - NEVER derived from the provider symbol
      // (OCC-style parsing of the symbol is a consistency-check input for the pure evaluators
      // only, never a source of truth for this structured field - see optionEvidence.ts).
      optionRoot: record ? exactStringValue(record.optionRoot) : null,
    },
    quote: {
      bid: record ? strictNumber(record.bid) : null,
      ask: record ? strictNumber(record.ask) : null,
      quoteTimeInLong: record ? strictNumber(record.quoteTimeInLong) : null,
    },
    terms: {
      multiplier: record ? strictNumber(record.multiplier) : null,
      nonStandard: record && typeof record.nonStandard === "boolean" ? record.nonStandard : null,
      mini: record && typeof record.mini === "boolean" ? record.mini : null,
      optionDeliverablesList: record ? deliverablesListValue(record.optionDeliverablesList) : null,
      settlementType: record ? stringValue(record.settlementType) : null,
      deliverableNote: record ? stringValue(record.deliverableNote) : null,
    },
    ruleInputs: {
      // strictNumber, never integerValue - a fractional raw value (e.g. 2.9) must be preserved
      // exactly so the strict evaluators (which independently require Number.isInteger) can
      // honestly report it as UNKNOWN, rather than having the normalizer silently truncate it
      // into a false-looking valid integer (2.9 must never become 2).
      openInterest: record ? strictNumber(record.openInterest) : null,
      totalVolume: record ? strictNumber(record.totalVolume) : null,
      delta: record ? strictNumber(record.delta) : null,
    },
  };
}

/**
 * STRICT raw-type numeric reader for Trade Prep evidence - an actual JavaScript `number`, finite,
 * full stop. Never `Number(...)`, never coerces a numeric string ("1"), a boolean (`true`/`false`
 * -> 1/0), or any other type - those must all become `null` (invalid/unavailable evidence) rather
 * than a manufactured valid number. Deliberately separate from the legacy `numberValue` below,
 * which intentionally stays coercive for the existing, unmodified normalizers that already depend
 * on that leniency - this function exists so strict evidence can never inherit it.
 */
function strictNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** `null` = the field itself was absent/not-an-array; `[]` = present and genuinely empty - see
 * StrictOptionContractTerms.optionDeliverablesList's own doc comment on why these must stay
 * distinct. Each entry is normalized independently - one malformed entry's fields become `null`
 * rather than discarding the whole list or throwing. */
function deliverablesListValue(value: unknown): StrictOptionDeliverableEvidence[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.map((item) => {
    const entry = objectValue(item);
    return {
      symbol: entry ? exactStringValue(entry.symbol) : null,
      assetType: entry ? stringValue(entry.assetType) : null,
      deliverableUnits: entry ? numberValue(entry.deliverableUnits) : null,
      currencyType: entry ? stringValue(entry.currencyType) : null,
    };
  });
}

/** Type-checks only - never trims/reshapes. Used wherever a field's EXACT raw string value must
 * survive (provider symbol, putCall, deliverable symbol) - contrast `stringValue` below, which
 * trims and treats an all-whitespace string as absent (correct for display/lookup fields, wrong
 * for anything strict identity must preserve byte-for-byte, including Schwab's own padding). */
function exactStringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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

  // Codex P2 (D) - "the field is legitimately ABSENT" (a genuinely closed day may omit
  // sessionHours/regularMarket entirely) must be told apart from "the field was SUPPLIED but is
  // not a valid shape" - collapsing both into the same "treat as empty" behavior would let corrupt
  // provider data masquerade as a validated closed day. Codex P2 (round 3) found the PREVIOUS fix
  // still got this wrong for an EXPLICIT `null`: checking `!== null` treated `sessionHours: null`
  // (or `regularMarket: null`) as if the key were never sent at all, when a real provider response
  // that explicitly sends `null` is making a different (and here, invalid) claim than one that
  // omits the field entirely. Presence is now determined by the raw KEY itself
  // (`hasOwnProperty`), never by whether the resulting value happens to be null/undefined.
  const sessionHoursKeyPresent = hasOwnKey(eq, "sessionHours");
  const sessionHours = objectValue(eq.sessionHours);
  if (sessionHoursKeyPresent && !sessionHours) {
    return { status: "UNAVAILABLE", reason: "Schwab market-hours sessionHours was supplied (possibly null) but is not a valid object." };
  }

  const regularMarketKeyPresent = sessionHours !== null && hasOwnKey(sessionHours, "regularMarket");
  const regularMarketRawValue = sessionHours?.regularMarket;
  const regularMarketIsWellFormedArray = Array.isArray(regularMarketRawValue);
  if (regularMarketKeyPresent && !regularMarketIsWellFormedArray) {
    return { status: "UNAVAILABLE", reason: "Schwab market-hours sessionHours.regularMarket was supplied (possibly null) but is not a valid array." };
  }
  const regularMarketRaw = regularMarketIsWellFormedArray ? regularMarketRawValue : [];

  // Codex P1 (B2): isOpen and the regularMarket intervals are two independent claims from the
  // same response - they must agree, never let one silently override the other. isOpen:false with
  // intervals supplied is a contradiction (which is actually open?); isOpen:true with no
  // structurally valid intervals is a missing-evidence case - neither is a value shape this
  // function may reinterpret as CLOSED. Only isOpen:false with NO intervals SUPPLIED AT ALL
  // (never merely malformed - that was already rejected above) is genuine, trustworthy closed-day
  // evidence.
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

/** Codex P2 (D, round 3) - true KEY presence, regardless of the value (including an explicit
 * `null`) - never confused with `value !== undefined && value !== null`, which would treat an
 * explicitly-sent `null` the same as a key that was never sent at all. */
function hasOwnKey(record: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
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
