const TRADING_DAYS_PER_YEAR = 252;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type BollingerBands = {
  lower: number;
  middle: number;
  upper: number;
};

export function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function wilderRsi(closes: number[], period = 14): number | null {
  if (period <= 0 || closes.length < period + 1) {
    return null;
  }

  let gainSum = 0;
  let lossSum = 0;

  for (let index = 1; index <= period; index += 1) {
    const change = closes[index] - closes[index - 1];
    if (change >= 0) {
      gainSum += change;
    } else {
      lossSum += Math.abs(change);
    }
  }

  let averageGain = gainSum / period;
  let averageLoss = lossSum / period;

  for (let index = period + 1; index < closes.length; index += 1) {
    const change = closes[index] - closes[index - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
  }

  if (averageLoss === 0) {
    return 100;
  }

  const relativeStrength = averageGain / averageLoss;
  return round(100 - 100 / (1 + relativeStrength), 2);
}

export function bollingerBands(closes: number[], period = 20, deviations = 2): BollingerBands | null {
  if (period <= 1 || closes.length < period) {
    return null;
  }

  const window = closes.slice(-period);
  const middle = window.reduce((sum, value) => sum + value, 0) / period;
  const variance = window.reduce((sum, value) => sum + (value - middle) ** 2, 0) / period;
  const standardDeviation = Math.sqrt(variance);

  return {
    lower: round(middle - deviations * standardDeviation, 4),
    middle: round(middle, 4),
    upper: round(middle + deviations * standardDeviation, 4),
  };
}

export function bollingerPositionPercent(price: number, bands: BollingerBands): number | null {
  const range = bands.upper - bands.lower;
  if (range <= 0) {
    return null;
  }

  return round(((price - bands.lower) / range) * 100, 2);
}

export function bollingerWidth(bands: BollingerBands): number | null {
  if (bands.middle === 0) {
    return null;
  }

  return round(((bands.upper - bands.lower) / bands.middle) * 100, 2);
}

export function historicalVolatility(closes: number[], tradingDays = TRADING_DAYS_PER_YEAR): number | null {
  if (closes.length < 2) {
    return null;
  }

  const returns = [];
  for (let index = 1; index < closes.length; index += 1) {
    if (closes[index] <= 0 || closes[index - 1] <= 0) {
      return null;
    }
    returns.push(Math.log(closes[index] / closes[index - 1]));
  }

  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(returns.length - 1, 1);

  return round(Math.sqrt(variance) * Math.sqrt(tradingDays) * 100, 2);
}

export function daysToExpiration(expiration: Date, asOf = new Date()): number {
  const expirationUtc = Date.UTC(
    expiration.getUTCFullYear(),
    expiration.getUTCMonth(),
    expiration.getUTCDate(),
  );
  const asOfUtc = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  return Math.max(0, Math.ceil((expirationUtc - asOfUtc) / MS_PER_DAY));
}

export function distanceToStrikeDollars(stockPrice: number, strike: number): number {
  return round(stockPrice - strike, 2);
}

export function distanceToStrikePercent(stockPrice: number, strike: number): number | null {
  if (stockPrice === 0) {
    return null;
  }

  return round(((stockPrice - strike) / stockPrice) * 100, 2);
}

export function cspBreakEven(strike: number, premiumReceived: number): number {
  return round(strike - premiumReceived, 2);
}

export function securedCapital(strike: number, contracts: number): number {
  return round(strike * 100 * contracts, 2);
}

export function cashSecuredReturnOnRisk(
  premiumReceived: number,
  strike: number,
  contracts: number,
  fees = 0,
): number | null {
  const capital = securedCapital(strike, contracts);
  if (capital <= 0) {
    return null;
  }

  return round(((premiumReceived * 100 * contracts - fees) / capital) * 100, 2);
}

export function annualizedReturnOnRisk(returnOnRiskPercent: number, dte: number): number | null {
  if (dte <= 0) {
    return null;
  }

  return round(returnOnRiskPercent * (365 / dte), 2);
}

export function premiumCapturedPercent(premiumReceived: number, currentOptionMark: number): number | null {
  if (premiumReceived <= 0) {
    return null;
  }

  return round(((premiumReceived - currentOptionMark) / premiumReceived) * 100, 2);
}

export function remainingPremium(premiumReceived: number, currentOptionMark: number): number {
  return round(Math.max(currentOptionMark, 0), 4);
}

export function bidAskSpreadDollars(bid: number, ask: number): number {
  return round(Math.max(ask - bid, 0), 4);
}

export function bidAskSpreadPercent(bid: number, ask: number): number | null {
  const mark = (bid + ask) / 2;
  if (mark <= 0) {
    return null;
  }

  return round((bidAskSpreadDollars(bid, ask) / mark) * 100, 2);
}

export function estimatedBuyToCloseCost(
  contracts: number,
  optionAsk: number,
  fees = 0,
  useAsk = true,
  optionMark?: number,
): number {
  const selectedPrice = useAsk ? optionAsk : optionMark ?? optionAsk;
  return round(Math.max(selectedPrice, 0) * contracts * 100 + fees, 2);
}
