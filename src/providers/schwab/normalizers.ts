import type { MarketQuote, OptionContractSnapshot, PriceCandle } from "@/providers/market-data/types";

type UnknownRecord = Record<string, unknown>;

export function normalizeSchwabQuoteResponse(symbol: string, payload: unknown): MarketQuote {
  const normalizedSymbol = symbol.toUpperCase();
  const record = objectValue(payload)?.[normalizedSymbol] ?? firstObjectValue(payload);
  const quote = objectValue(objectValue(record)?.quote);
  const regular = objectValue(objectValue(record)?.regular);

  const price =
    numberValue(quote?.lastPrice) ??
    numberValue(regular?.regularMarketLastPrice) ??
    numberValue(quote?.mark) ??
    numberValue(quote?.closePrice);

  if (price === null) {
    throw new Error(`Schwab quote response did not include a usable price for ${normalizedSymbol}.`);
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
