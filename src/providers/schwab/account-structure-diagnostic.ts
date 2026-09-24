import "server-only";

import { schwabGetJson, type SchwabFetch } from "./client";
import { SCHWAB_TRADER_BASE_URL } from "./config";

type Row = { path: string; type: string; value: string };
const sensitive = /token|secret|authorization|cookie|accountNumber|accountHash|hashValue|customer|name|symbol|ticker|cusip|identifier|id$|url|uri/i;
const fieldNames = new Set(`securitiesAccount currentBalances initialBalances projectedBalances positions instrument
accountNumber accountHash hashValue customerName longQuantity shortQuantity marketValue liquidationValue accountValue
cashBalance cashAvailableForTrading cashAvailableForWithdrawal settledCash unsettledCash buyingPower
longMarketValue shortMarketValue longOptionMarketValue shortOptionMarketValue equity marginBalance
maintenanceRequirement accruedInterest availableFunds type accountType assetType symbol cusip instrumentId
underlyingSymbol putCall strikePrice averagePrice price amount cost profitLoss transactionId timeValue
accessToken refreshToken clientSecret authorization cookies source pricingBasis priceType session sessionDate
timezone timeZone asOf valuationAsOf timestamp quoteTime quoteTimeInLong tradeTime tradeTimeInLong markTime
regularMarketTradeTimeInLong updateTime updatedAt valuationDate valuationTime date closePrice previousClose
close lastPrice mark bid ask`.split(/\s+/));
const financial = /balance|value|price|quantity|profit|loss|amount|cost|funds|power|equity|interest|requirement/i;
const timing = /(?:timestamp|asof|datetime|date|time|timeinlong|timestampms|updatedat|quotedat|valuedat|valuationat)$/i;
const safeLabels = new Set(["REGULAR", "NORMAL", "PRE", "POST", "PRE_MARKET", "POST_MARKET", "CLOSED", "OPEN", "REALTIME", "DELAYED", "PREVIOUS_CLOSE", "LAST", "MARK", "MIDPOINT", "BID", "ASK", "SCHWAB", "CASH", "MARGIN"]);

function safeTime(value: unknown): string | null {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) && Number.isFinite(Date.parse(value))) return value;
  // Preserve only plausible epoch seconds/milliseconds, never arbitrary numbers.
  if (typeof value === "number" && Number.isInteger(value) &&
    ((value >= 946684800 && value <= 4102444800) || (value >= 946684800000 && value <= 4102444800000))) return String(value);
  return null;
}

/** Values are deny-by-default. Array indices/counts and dynamic identifier keys are not exposed. */
export function sanitizeAccountStructure(payload: unknown, secrets: string[] = []): Row[] {
  const rows = new Map<string, Row>();
  const forbidden = new Set<string>(secrets);
  function gather(value: unknown, blocked = false): void {
    if (typeof value === "string" && blocked && value) forbidden.add(value);
    else if (Array.isArray(value)) value.forEach(v => gather(v, blocked));
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) gather(v, blocked || sensitive.test(k));
  }
  gather(payload);
  function visit(value: unknown, path: string, key: string, blocked: boolean): void {
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    let display = value === null ? "null" : `[REDACTED_${type.toUpperCase()}]`;
    if (type === "object" || type === "array") display = "[STRUCTURE]";
    if (!blocked && !forbidden.has(String(value))) {
      if (timing.test(key)) display = safeTime(value) ?? display;
      if (/timezone$/i.test(key) && typeof value === "string" && ["UTC", "GMT", "US/Eastern", "America/New_York"].includes(value)) display = value;
      if (/(session|source|basis|pricetype|accounttype|^type$)/i.test(key) && typeof value === "string" && safeLabels.has(value)) display = value;
    }
    const row = { path, type, value: display };
    rows.set(JSON.stringify(row), row);
    if (Array.isArray(value)) value.forEach(v => visit(v, `${path}[]`, key, blocked));
    else if (value && typeof value === "object") {
      let unknownIndex = 0;
      for (const [k, v] of Object.entries(value)) {
        const known = fieldNames.has(k) && !forbidden.has(k);
        const safeKey = known ? k : `[REDACTED_KEY_${++unknownIndex}]`;
        visit(v, `${path}.${safeKey}`, k, blocked || sensitive.test(k) || !known ||
          (financial.test(k) && !["pricingBasis", "priceType", "valuationAsOf", "valuationDate", "valuationTime"].includes(k)));
      }
    }
  }
  visit(payload, "$", "", false);
  return [...rows.values()];
}

/** Exactly one account request; redirects, retries and raw error output are prohibited. */
async function captureAccountStructureUnsafe(accessToken: string, accountHash: string, fetchFn: SchwabFetch = fetch) {
  const startedAt = new Date().toISOString();
  let receivedAt: string | null = null;
  let httpDate: string | null = null;
  const payload = await schwabGetJson<unknown>({
    accessToken, baseUrl: SCHWAB_TRADER_BASE_URL,
    path: `/accounts/${encodeURIComponent(accountHash)}`,
    searchParams: new URLSearchParams({ fields: "positions" }),
    fetchFn: async (input, init) => {
      const response = await fetchFn(input, { ...init, redirect: "error", signal: AbortSignal.timeout(30000) });
      const rawDate = response.headers.get("date");
      if (rawDate && /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(rawDate) && Number.isFinite(Date.parse(rawDate))) httpDate = rawDate;
      // Read the body before recording response completion, without logging it.
      const body = await response.text();
      receivedAt = new Date().toISOString();
      return new Response(body, { status: response.status, headers: { "content-type": "application/json" } });
    },
  });
  return { transport: { meaning: "TRANSPORT / RETRIEVAL EVIDENCE ONLY", startedAt, receivedAt, httpDate }, fields: sanitizeAccountStructure(payload, [accessToken, accountHash]) };
}

/** Do not let transport/JSON errors carry provider bodies, request URLs or headers to callers. */
export async function captureAccountStructure(accessToken: string, accountHash: string, fetchFn: SchwabFetch = fetch) {
  try { return await captureAccountStructureUnsafe(accessToken, accountHash, fetchFn); }
  catch { throw new Error("Account diagnostic unavailable."); }
}
