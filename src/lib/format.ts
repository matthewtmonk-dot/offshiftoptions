import { normalizeTicker } from "./tickers";

export function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    return Number(value);
  }

  if (value && typeof value === "object") {
    const candidate = value as { toNumber?: () => number; toString?: () => string };
    if (typeof candidate.toNumber === "function") {
      return candidate.toNumber();
    }
    if (typeof candidate.toString === "function") {
      return Number(candidate.toString());
    }
  }

  return Number(value ?? 0);
}

export function money(value: unknown, digits = 2) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(toNumber(value));
}

export function percent(value: unknown, digits = 2) {
  return `${toNumber(value).toFixed(digits)}%`;
}

export function shortDate(value: Date | string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

export function shortDateTime(value: Date | string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function upperTicker(value: FormDataEntryValue | null) {
  return normalizeTicker(value);
}
