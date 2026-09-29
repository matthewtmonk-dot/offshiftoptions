/**
 * Pure sanitization helpers for scripts/schwab-evidence-diagnostic.ts - no Prisma, no network, no
 * side effects, so they can be exercised with synthetic/dry-run tests
 * (schwab-evidence-diagnostic.test.ts) independent of any real Schwab connection.
 *
 * TEMPORARY DIAGNOSTIC CODE - lives only on the `schwab-evidence-diagnostic` branch, never main.
 *
 * Two independent layers of defense, both applied to every value this module ever returns:
 *  1. KEY-NAME filter (LIKELY_SECRET_KEY_PATTERN) - redacts by key name alone, regardless of what
 *     the value looks like. Catches a secret hiding under an innocuous-looking value (a raw
 *     token string doesn't always "look like" a token).
 *  2. VALUE-PATTERN filter (BLOCKED_VALUE_PATTERN, the same pattern already used in production's
 *     fundamentals-diagnostic.ts) - redacts by value content alone, regardless of key name.
 *     Catches a secret surfacing under an unexpected/renamed key.
 * A field is redacted if EITHER layer matches.
 */

export const LIKELY_SECRET_KEY_PATTERN =
  /(access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|authorization|bearer|api[_-]?key|secret|password|passwd|credential|encryption[_-]?key|account[_-]?number|account[_-]?hash|database[_-]?url|private[_-]?key)/i;

export const BLOCKED_VALUE_PATTERN =
  /\b(access[_\s-]*token|refresh[_\s-]*token|client[_\s-]*secret|authorization|bearer|account[_\s-]*(number|hash)|database[_\s-]*url|encryption[_\s-]*key|password|credential)\b/i;

export const REDACTED = "REDACTED_BY_SAFETY_FILTER";

/** True when a Schwab-response FIELD NAME by itself is the kind of thing that should never be
 * echoed regardless of its actual value (defense-in-depth - Schwab's real quote/market-hours
 * payloads should never legitimately contain these, but the filter runs unconditionally anyway). */
export function isLikelySecretKey(key: string): boolean {
  return LIKELY_SECRET_KEY_PATTERN.test(key);
}

/** Redacts a single value if it matches the blocked-content pattern. Does not know the key it
 * came from - see sanitizeKeyValue for the key-aware wrapper used everywhere below. */
export function safeValue(value: unknown): unknown {
  if (typeof value === "string" && BLOCKED_VALUE_PATTERN.test(value)) return REDACTED;
  return value;
}

/** The one place both filter layers are actually combined - every sanitization path in this
 * module (pick, deepSanitize) routes through this, so the two layers can never drift apart. */
export function sanitizeKeyValue(key: string, value: unknown): unknown {
  if (isLikelySecretKey(key)) return REDACTED;
  return safeValue(value);
}

export function looksLikeEpochMillis(value: unknown): string {
  if (typeof value !== "number") return "not numeric";
  if (value > 1e12 && value < 3e12) return `plausible epoch milliseconds (${new Date(value).toISOString()})`;
  if (value > 1e9 && value < 3e9) return `plausible epoch SECONDS, not milliseconds (${new Date(value * 1000).toISOString()} if so)`;
  return "magnitude does not match either epoch-ms or epoch-s convention";
}

/** Allowlist-picks named fields from a flat record, applying the key+value sanitizer to each. A
 * key absent from `record` is simply absent from the result (never fabricated as null/redacted). */
export function pick(record: Record<string, unknown> | undefined, keys: string[]): Record<string, unknown> | undefined {
  if (!record) return undefined;
  return Object.fromEntries(
    keys.filter((k) => Object.prototype.hasOwnProperty.call(record, k)).map((k) => [k, sanitizeKeyValue(k, record[k])]),
  );
}

/** Recursively sanitizes an ENTIRE object/array tree, preserving structure and every key name
 * (never flattened) - used for the market-hours capture, which must not be flattened per the
 * ticket. Every key+value pair passes through the same sanitizeKeyValue as `pick` above. */
export function deepSanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSanitize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        isLikelySecretKey(k) ? REDACTED : typeof v === "object" && v !== null ? deepSanitize(v) : safeValue(v),
      ]),
    );
  }
  return safeValue(value);
}

export type QuoteCaptureInput = {
  symbol: string;
  fields: string;
  payload: unknown;
  requestStartedAt: string;
  responseReceivedAt: string;
  httpDateHeader: string | null;
};

/**
 * Structural, allowlisted capture of ONE quote record - never the raw payload, never anything
 * beyond the fields the ticket asked for. Reports the requested vs. actually-returned symbol key
 * explicitly (never silently substitutes) so a first-object fallback bug would be visible in the
 * evidence itself, not hidden by this diagnostic reproducing the same substitution.
 */
export function sanitizeQuoteCapture(input: QuoteCaptureInput) {
  const root = input.payload as Record<string, unknown>;
  const returnedKeys = root && typeof root === "object" && !Array.isArray(root) ? Object.keys(root) : [];
  const exactKey = returnedKeys.find((k) => k.toUpperCase() === input.symbol.toUpperCase());
  const record = (exactKey ? root[exactKey] : root[returnedKeys[0]]) as Record<string, unknown> | undefined;

  const quote = record?.quote as Record<string, unknown> | undefined;
  const regular = record?.regular as Record<string, unknown> | undefined;
  const extended = record?.extended as Record<string, unknown> | undefined;

  return {
    requestedSymbol: input.symbol,
    returnedTopLevelKeys: returnedKeys,
    exactSymbolKeyMatch: Boolean(exactKey),
    matchedKeyUsed: exactKey ?? returnedKeys[0] ?? null,
    request: { path: "GET /marketdata/v1/quotes", fields: input.fields },
    diagnosticTransportEvidence: {
      requestStartedAt: input.requestStartedAt,
      responseReceivedAt: input.responseReceivedAt,
      httpDateHeader: input.httpDateHeader,
      note: "These are THIS diagnostic's own transport times - never the provider's price/quote time.",
    },
    topLevel: pick(record, ["symbol", "assetMainType", "assetSubType", "quoteType", "realtime", "delayed"]),
    quoteGroup: {
      present: Boolean(quote),
      keyNames: quote ? Object.keys(quote) : [],
      fields: pick(quote, [
        "lastPrice", "tradeTime", "tradeTimeInLong", "quoteTime", "quoteTimeInLong",
        "mark", "closePrice", "securityStatus", "delayed", "realtime",
      ]),
      quoteTimeInLongMagnitudeCheck: quote ? looksLikeEpochMillis(quote.quoteTimeInLong) : "quote group absent",
      tradeTimeInLongMagnitudeCheck: quote ? looksLikeEpochMillis(quote.tradeTimeInLong) : "quote group absent",
    },
    regularGroup: {
      present: Boolean(regular),
      allKeyNames: regular ? Object.keys(regular) : [],
      fields: pick(regular, [
        "regularMarketLastPrice", "regularMarketTradeTime", "regularMarketTradeTimeInLong",
        "regularMarketLastSize", "regularMarketNetChange", "regularMarketPercentChange",
      ]),
      regularMarketTradeTimeInLongMagnitudeCheck: regular ? looksLikeEpochMillis(regular.regularMarketTradeTimeInLong) : "regular group absent",
    },
    extendedGroup: {
      present: Boolean(extended),
      keyNames: extended ? Object.keys(extended) : [],
      fields: extended ? pick(extended, Object.keys(extended)) : null,
    },
  };
}

/** Masks a user for safe display in the account-selection prompt: first name + last-initial +
 * the last 4 characters of the (non-secret) BrokerConnection id as a stable, short disambiguator.
 * Never the full name alone (ambiguous with two "Matt"s), never email, never the connection id in
 * full, never anything account/token-shaped. */
export function maskAccountLabel(userName: string, connectionId: string): string {
  const parts = userName.trim().split(/\s+/).filter(Boolean);
  const first = parts[0] ?? "User";
  const lastInitial = parts.length > 1 ? `${parts[parts.length - 1]!.charAt(0).toUpperCase()}.` : "";
  const suffix = connectionId.slice(-4);
  return [first, lastInitial].filter(Boolean).join(" ") + ` (ref ...${suffix})`;
}

export function connectionSelectorSuffix(connectionId: string): string {
  return connectionId.slice(-4);
}
