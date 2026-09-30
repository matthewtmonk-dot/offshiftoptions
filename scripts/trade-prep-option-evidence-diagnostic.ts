/**
 * TRADE PREP OPTION-EVIDENCE DIAGNOSTIC - PREPARE ONLY - DO NOT RUN LIVE (this environment).
 *
 * Temporary, read-only Schwab option-chain diagnostic. Exists ONLY to resolve the remaining
 * Trade Prep evidence contract by inspecting the RAW Schwab `/chains` response shape - it does
 * NOT implement Trade Prep, does NOT touch Scanner behavior, and does NOT write to the database.
 *
 * SAFETY CONTRACT (see PR/ticket for the full text this encodes):
 *  - Reads one existing BrokerConnection row via Prisma. Never writes to it or any other table.
 *  - Never imports/calls getValidSchwabAccessTokenForConnection or
 *    refreshSchwabConnectionAccessToken (both live in @/providers/schwab/tokens and are capable
 *    of performing a live OAuth refresh + DB write). Only the PURE `needsRefresh` helper from
 *    that module is used, and only to decide whether to STOP.
 *  - If the stored token needs refresh (per needsRefresh), the script STOPS. It never refreshes.
 *  - Performs at most ONE Schwab HTTP request: GET {SCHWAB_MARKET_DATA_BASE_URL}/chains. No
 *    retries, no follow-up requests, no other endpoints (no orders, no accounts, no transactions).
 *  - Refuses to run outside an ordinary regular U.S. trading session, decided ENTIRELY from local
 *    NYSE-calendar + America/New_York wall-clock logic (see isRegularUsTradingSession) - never
 *    from a second Schwab call.
 *  - Persists only a sanitized, capped (<=3 contracts) local JSON artifact. Raw response body is
 *    never written to disk or printed to console.
 *
 * Run manually (after checkout, with a real Schwab connection available):
 *   npx tsx scripts/trade-prep-option-evidence-diagnostic.ts
 *   npx tsx scripts/trade-prep-option-evidence-diagnostic.ts --account abcd
 */
import { writeFile } from "node:fs/promises";
import { prisma } from "../src/lib/prisma";
import { decryptToken } from "../src/providers/schwab/crypto";
import { needsRefresh } from "../src/providers/schwab/tokens";
import { SCHWAB_MARKET_DATA_BASE_URL } from "../src/providers/schwab/config";
import { isNyseMarketDay, marketDate } from "../src/domain/finance/marketCalendar";

export const OUTPUT_FILE_PATH = "trade-prep-option-evidence-capture.json";
export const MAX_CAPTURED_CONTRACTS = 3;

const REGULAR_SESSION_OPEN_MINUTES = 9 * 60 + 30; // 9:30 ET
const REGULAR_SESSION_CLOSE_MINUTES = 16 * 60; // 16:00 ET

const nyTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * Pure, local-only regular-session gate: NYSE market day (holiday/weekend calendar, no network)
 * AND within the fixed 9:30-16:00 America/New_York clock window. Deliberately does NOT reuse
 * isWithinRegularSession from marketSession.ts, since that function requires a live-fetched
 * EquityMarketSessionEvidence - using it here would require a second Schwab call, which this
 * diagnostic must never make. This is intentionally a coarser, offline approximation (no early
 * closes, no extended-hours nuance) - good enough to refuse an obviously-outside-hours run.
 */
export function isRegularUsTradingSession(now: Date): boolean {
  if (!isNyseMarketDay(marketDate(now))) {
    return false;
  }
  const parts = nyTimeFormatter.formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "NaN");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "NaN");
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return false;
  }
  const minutesSinceMidnight = hour * 60 + minute;
  return minutesSinceMidnight >= REGULAR_SESSION_OPEN_MINUTES && minutesSinceMidnight < REGULAR_SESSION_CLOSE_MINUTES;
}

function formatNyCalendarDate(date: Date): string {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  return formatter.format(date); // en-CA formats as YYYY-MM-DD
}

/** fromDate = current NY calendar date; toDate = that date + 13 calendar days (Schwab expects
 * plain YYYY-MM-DD, not a timezone-aware instant, for these query params). */
export function buildOptionChainDateRange(now: Date): { fromDate: string; toDate: string } {
  const fromDate = formatNyCalendarDate(now);
  const [year, month, day] = fromDate.split("-").map(Number);
  const toDateInstant = new Date(Date.UTC(year, month - 1, day + 13));
  const toDate = `${toDateInstant.getUTCFullYear()}-${String(toDateInstant.getUTCMonth() + 1).padStart(2, "0")}-${String(toDateInstant.getUTCDate()).padStart(2, "0")}`;
  return { fromDate, toDate };
}

/** The ticket's exact masked-selector format: owner display name + last 4 chars of the
 * connection's own cuid `id` (never a real Schwab account number/hash, never user id/email). */
export function maskConnectionSelector(ownerName: string, connectionId: string): { label: string; suffix: string } {
  const suffix = connectionId.slice(-4);
  return { label: `${ownerName} (ref ...${suffix}) -> --account ${suffix}`, suffix };
}

export type EligibleConnection = {
  id: string;
  expiresAt: Date | null;
  accessTokenCiphertext: string | null;
  ownerName: string;
};

export type ConnectionSelectionResult =
  | { outcome: "NONE_ELIGIBLE" }
  | { outcome: "AMBIGUOUS"; selectors: string[] }
  | { outcome: "NOT_FOUND"; suffix: string }
  | { outcome: "SELECTED"; connection: EligibleConnection };

/** Pure selection logic over an already-fetched (read-only) list of eligible connections - kept
 * separate from the Prisma query itself so it is fully unit-testable without a database. */
export function selectEligibleConnection(connections: EligibleConnection[], accountSuffix: string | null): ConnectionSelectionResult {
  if (connections.length === 0) {
    return { outcome: "NONE_ELIGIBLE" };
  }
  if (accountSuffix) {
    const match = connections.find((connection) => connection.id.endsWith(accountSuffix));
    return match ? { outcome: "SELECTED", connection: match } : { outcome: "NOT_FOUND", suffix: accountSuffix };
  }
  if (connections.length === 1) {
    return { outcome: "SELECTED", connection: connections[0] };
  }
  return {
    outcome: "AMBIGUOUS",
    selectors: connections.map((connection) => maskConnectionSelector(connection.ownerName, connection.id).label),
  };
}

// ---------------------------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------------------------

const FORBIDDEN_KEY_PATTERN = /access.?token|refresh.?token|authoriz|bearer|client.?secret|encryption.?key|database_url|account.?hash|cookie|password|apikey|api.?key/i;

/** Only the exact, explicitly-allowed transport header this diagnostic ever forwards - no other
 * header (raw or otherwise) is ever included in the sanitized artifact. */
const ALLOWED_TRANSPORT_KEYS = new Set(["httpDateHeader"]);

/**
 * Recursively redacts any object key matching FORBIDDEN_KEY_PATTERN (replacing its value with the
 * literal string "[REDACTED]"), and drops any key named exactly "headers" (raw header objects are
 * never allowed through - only the single explicit httpDateHeader field, added by the caller
 * itself, ever survives). User id / email / raw error payloads are never placed on the object
 * this sanitizer is given in the first place (see buildCaptureArtifact) - this function's job is
 * defense in depth against an accidental future addition, not the only line of defense.
 */
export function sanitizeForDiagnosticOutput(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForDiagnosticOutput(item));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === "headers" && !ALLOWED_TRANSPORT_KEYS.has(key)) {
        continue;
      }
      if (FORBIDDEN_KEY_PATTERN.test(key)) {
        result[key] = "[REDACTED]";
        continue;
      }
      result[key] = sanitizeForDiagnosticOutput(entry);
    }
    return result;
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// Raw-response capture (structural inspection only - no assumed field names)
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** {present:false} rather than omitting the key entirely, so "absent" is an explicit, positive
 * claim in the artifact (per the ticket: "If none present: record that they are absent" /
 * "missing symbol remains missing" / "absent multiplier remains absent" - never silently omitted
 * in a way a reader could mistake for "not checked"). */
function field(record: Record<string, unknown>, key: string): { present: boolean; value?: unknown; type?: string } {
  if (!(key in record) || record[key] === undefined) {
    return { present: false };
  }
  return { present: true, value: record[key], type: typeof record[key] };
}

export function captureRootStructure(raw: unknown) {
  if (!isRecord(raw)) {
    return { topLevelKeys: [], isRecord: false as const };
  }
  return {
    isRecord: true as const,
    topLevelKeys: Object.keys(raw),
    symbol: field(raw, "symbol"),
    status: field(raw, "status"),
    underlying: field(raw, "underlying"),
    underlyingPrice: field(raw, "underlyingPrice"),
    strategy: field(raw, "strategy"),
    interval: field(raw, "interval"),
    isDelayed: field(raw, "isDelayed"),
    isIndex: field(raw, "isIndex"),
    putExpDateMapPresent: isRecord(raw.putExpDateMap),
    putExpDateMapKeys: isRecord(raw.putExpDateMap) ? Object.keys(raw.putExpDateMap) : [],
  };
}

const IDENTITY_FIELDS = ["symbol", "putCall", "underlyingSymbol", "underlying", "strikePrice", "expirationDate", "expirationType", "daysToExpiration", "exchangeName", "exchange", "settlementType"];
const PRICING_FIELDS = ["bid", "ask", "mark", "last"];
const TIMING_FIELDS = ["quoteTimeInLong", "quoteTime", "tradeTimeInLong", "tradeTime", "lastTradingDay"];
const REALTIME_FIELDS = ["isDelayed", "realtime", "quoteStatus", "tradingStatus", "isIndex"];
const LIQUIDITY_GREEK_FIELDS = ["openInterest", "totalVolume", "volume", "delta", "gamma", "theta", "vega", "rho", "intrinsicValue", "timeValue"];
const CONTRACT_TERMS_FIELDS = ["multiplier", "contractMultiplier", "deliverable", "optionDeliverablesList", "nonStandard", "mini", "standard", "isNonStandard"];

function captureFieldGroup(record: Record<string, unknown>, keys: string[]) {
  const result: Record<string, { present: boolean; value?: unknown; type?: string }> = {};
  for (const key of keys) {
    result[key] = field(record, key);
  }
  return result;
}

/** Captures RAW per-contract evidence BEFORE any of this app's own option normalization/fallback
 * logic runs (see normalizeSchwabOptionChainResponse's own `stringValue(contract?.symbol) ??
 * fallbackSyntheticSymbol` in src/providers/schwab/normalizers.ts) - this function is only ever
 * given the untouched raw contract object straight from the Schwab response. */
const EMPTY_FIELD = { present: false as const };

export function captureContractEvidence(rawContract: unknown) {
  if (!isRecord(rawContract)) {
    return {
      isRecord: false as const,
      rawKeys: [] as string[],
      providerSymbol: { present: false, value: null as unknown, rawLocation: "contract.symbol" },
      identity: Object.fromEntries(IDENTITY_FIELDS.map((key) => [key, EMPTY_FIELD])),
      pricing: Object.fromEntries(PRICING_FIELDS.map((key) => [key, EMPTY_FIELD])),
      timing: Object.fromEntries(TIMING_FIELDS.map((key) => [key, EMPTY_FIELD])),
      realtimeStatus: Object.fromEntries(REALTIME_FIELDS.map((key) => [key, EMPTY_FIELD])),
      liquidityAndGreeks: Object.fromEntries(LIQUIDITY_GREEK_FIELDS.map((key) => [key, EMPTY_FIELD])),
      contractTerms: Object.fromEntries(CONTRACT_TERMS_FIELDS.map((key) => [key, EMPTY_FIELD])),
    };
  }
  const symbolField = field(rawContract, "symbol");
  return {
    isRecord: true as const,
    rawKeys: Object.keys(rawContract),
    providerSymbol: {
      present: symbolField.present,
      value: symbolField.present ? symbolField.value : null,
      rawLocation: "contract.symbol",
    },
    identity: captureFieldGroup(rawContract, IDENTITY_FIELDS),
    pricing: captureFieldGroup(rawContract, PRICING_FIELDS),
    timing: captureFieldGroup(rawContract, TIMING_FIELDS),
    realtimeStatus: captureFieldGroup(rawContract, REALTIME_FIELDS),
    liquidityAndGreeks: captureFieldGroup(rawContract, LIQUIDITY_GREEK_FIELDS),
    contractTerms: captureFieldGroup(rawContract, CONTRACT_TERMS_FIELDS),
  };
}

/**
 * Selects at most `max` contracts from the raw putExpDateMap for structural inspection. Schwab's
 * `range=OTM` request parameter already restricts the response to OTM contracts server-side, so
 * this simply walks the expiration map in the order Schwab returned it (nearest expirations
 * first, per Schwab's documented ordering) and takes the first `max` contracts encountered across
 * all strike buckets - "nearby" here means "nearest in the provider's own OTM-filtered, date-
 * ordered response," not a second, independent moneyness ranking this diagnostic would have to
 * invent from underlying price (which may itself be absent from the response).
 */
export function selectNearOtmPutContracts(raw: unknown, max: number = MAX_CAPTURED_CONTRACTS): unknown[] {
  if (!isRecord(raw) || !isRecord(raw.putExpDateMap)) {
    return [];
  }
  const selected: unknown[] = [];
  for (const expirationKey of Object.keys(raw.putExpDateMap)) {
    const strikeMap = (raw.putExpDateMap as Record<string, unknown>)[expirationKey];
    if (!isRecord(strikeMap)) continue;
    for (const strikeKey of Object.keys(strikeMap)) {
      const contracts = strikeMap[strikeKey];
      if (!Array.isArray(contracts)) continue;
      for (const contract of contracts) {
        if (selected.length >= max) return selected;
        selected.push(contract);
      }
    }
  }
  return selected;
}

// ---------------------------------------------------------------------------------------------
// Orchestration (impure - the only part not covered by pure-function unit tests directly; kept
// deliberately thin so every meaningful decision above is independently testable).
// ---------------------------------------------------------------------------------------------

type FetchLike = typeof fetch;

function parseAccountArg(argv: string[]): string | null {
  const index = argv.indexOf("--account");
  if (index === -1 || index + 1 >= argv.length) return null;
  return argv[index + 1];
}

async function main(deps: { fetchFn?: FetchLike; now?: Date; argv?: string[] } = {}) {
  const now = deps.now ?? new Date();
  const fetchFn: FetchLike = deps.fetchFn ?? fetch;
  const argv = deps.argv ?? process.argv.slice(2);

  if (!isRegularUsTradingSession(now)) {
    console.log("STOP: not within an ordinary regular U.S. trading session (local calendar/clock check). Run this manually during regular market hours.");
    return;
  }

  const rows = await prisma.brokerConnection.findMany({
    where: { provider: "SCHWAB", status: "CONNECTED", accessTokenCiphertext: { not: null } },
    include: { user: { select: { name: true } } },
  });
  const eligible: EligibleConnection[] = rows.map((row) => ({
    id: row.id,
    expiresAt: row.expiresAt,
    accessTokenCiphertext: row.accessTokenCiphertext,
    ownerName: row.user.name,
  }));

  const accountSuffix = parseAccountArg(argv);
  const selection = selectEligibleConnection(eligible, accountSuffix);

  if (selection.outcome === "NONE_ELIGIBLE") {
    console.log("STOP: no CONNECTED Schwab broker connection found.");
    return;
  }
  if (selection.outcome === "NOT_FOUND") {
    console.log(`STOP: no connection found matching --account ${selection.suffix}.`);
    return;
  }
  if (selection.outcome === "AMBIGUOUS") {
    console.log("Multiple eligible Schwab connections found. Re-run with one of:");
    for (const selector of selection.selectors) console.log(`  ${selector}`);
    return;
  }

  const { connection } = selection;
  if (needsRefresh(connection, now)) {
    console.log("STOP: stored access token is expired or within the normal refresh threshold. This diagnostic never refreshes tokens - use the normal app workflow first, then re-run.");
    return;
  }
  if (!connection.accessTokenCiphertext) {
    console.log("STOP: connection has no stored access token.");
    return;
  }

  const accessToken = decryptToken(connection.accessTokenCiphertext);
  const { fromDate, toDate } = buildOptionChainDateRange(now);
  const { label } = maskConnectionSelector(connection.ownerName, connection.id);

  console.log(`Selected connection: ${label}`);
  console.log("Requested symbol: SPY (PUT)");
  console.log(`Date range: ${fromDate} to ${toDate}`);
  console.log("This script performs exactly ONE read-only Schwab request.");

  const url = new URL(`${SCHWAB_MARKET_DATA_BASE_URL}/chains`);
  url.searchParams.set("symbol", "SPY");
  url.searchParams.set("contractType", "PUT");
  url.searchParams.set("strategy", "SINGLE");
  url.searchParams.set("includeQuotes", "TRUE");
  url.searchParams.set("range", "OTM");
  url.searchParams.set("fromDate", fromDate);
  url.searchParams.set("toDate", toDate);

  const requestStartedAt = new Date();
  const response = await fetchFn(url, {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
  });
  const responseReceivedAt = new Date();
  const httpDateHeader = response.headers.get("date");

  if (!response.ok) {
    console.log(`Schwab request failed: HTTP ${response.status}.`);
    return;
  }

  const raw: unknown = await response.json();
  const rootStructure = captureRootStructure(raw);
  const selectedContracts = selectNearOtmPutContracts(raw, MAX_CAPTURED_CONTRACTS);
  const contractEvidence = selectedContracts.map((contract) => captureContractEvidence(contract));

  const artifact = {
    capturedAt: responseReceivedAt.toISOString(),
    request: { method: "GET", path: "/chains", symbol: "SPY", contractType: "PUT", strategy: "SINGLE", includeQuotes: "TRUE", range: "OTM", fromDate, toDate },
    transportEvidence: {
      label: "TRANSPORT ONLY - NOT OPTION QUOTE TIME",
      requestStartedAt: requestStartedAt.toISOString(),
      responseReceivedAt: responseReceivedAt.toISOString(),
      httpDateHeader,
    },
    rootStructure,
    contractsFoundCount: selectedContracts.length >= MAX_CAPTURED_CONTRACTS ? `>=${MAX_CAPTURED_CONTRACTS}` : selectedContracts.length,
    contractsCapturedCount: contractEvidence.length,
    contracts: contractEvidence,
  };

  const sanitized = sanitizeForDiagnosticOutput(artifact);
  await writeFile(OUTPUT_FILE_PATH, JSON.stringify(sanitized, null, 2), "utf8");

  const anySymbolPresent = contractEvidence.some((entry) => "providerSymbol" in entry && entry.providerSymbol?.present);
  const anyTimingPresent = contractEvidence.some((entry) => "timing" in entry && Object.values(entry.timing ?? {}).some((f) => f.present));
  const anyTermsPresent = contractEvidence.some((entry) => "contractTerms" in entry && Object.values(entry.contractTerms ?? {}).some((f) => f.present));

  console.log(`HTTP status: ${response.status}`);
  console.log(`Contracts found: ${artifact.contractsFoundCount}`);
  console.log(`Contracts captured: ${contractEvidence.length}`);
  console.log(`Provider symbols present: ${anySymbolPresent}`);
  console.log(`Timing-like fields present: ${anyTimingPresent}`);
  console.log(`Deliverable/multiplier-like fields present: ${anyTermsPresent}`);
  console.log(`Sanitized output written to: ${OUTPUT_FILE_PATH}`);
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith("trade-prep-option-evidence-diagnostic.ts");
if (isDirectRun) {
  main().catch((error) => {
    console.error("Diagnostic failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

export { main as runTradeprepOptionEvidenceDiagnostic };
