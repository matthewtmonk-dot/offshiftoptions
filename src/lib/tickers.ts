export const TICKER_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function normalizeTicker(value: unknown) {
  return String(value ?? "")
    .trim()
    .replace(/^\$/, "")
    .toUpperCase();
}

export function isValidTicker(ticker: string) {
  return TICKER_PATTERN.test(ticker);
}

export function parseTicker(value: unknown) {
  const ticker = normalizeTicker(value);
  return isValidTicker(ticker) ? ticker : null;
}

export function requireTicker(value: unknown) {
  const ticker = parseTicker(value);
  if (!ticker) {
    throw new ValidationError("Enter a valid ticker symbol.");
  }

  return ticker;
}
