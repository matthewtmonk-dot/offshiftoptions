import type {
  EquityMarketSessionEvidence,
  EquityRegularSessionInterval,
  QuoteReviewEvidence,
  StrictOptionChainEnvelope,
  StrictOptionContractSnapshot,
  StrictOptionContractTerms,
} from "@/providers/market-data/types";
import { regularSessionIntervalContaining } from "@/domain/finance/marketSession";
import { parseOccOptionSymbol } from "@/domain/finance/occOption";
import { optionContractValue, securedCapital, cashSecuredReturnOnRisk } from "@/domain/finance/calculations";
import { evaluateQuoteEligibility } from "@/domain/finance/quoteEvidence";
import type { CriterionStatus } from "@/domain/scanner/scanner";

/**
 * Trade Prep strict option-evidence foundation - pure domain evaluators only. No DB calls, no
 * provider calls, no implicit `Date.now()` inside any evaluator (every clock-dependent function
 * takes its evaluation instant explicitly). This module does NOT compose a final user-facing
 * READY TO REVIEW / VERIFY / BLOCKED result, does NOT touch Scanner scoring/ranking, and does NOT
 * get wired into any page yet - it only establishes the individually-testable building blocks a
 * future composition ticket will assemble. See StrictOptionChainSnapshot's own doc comment
 * (providers/market-data/types.ts) for the raw evidence contract these functions consume, which is
 * strictly additive to (never a replacement for) the legacy OptionContractSnapshot/Scanner path.
 *
 * Reuses the existing Scanner `CriterionStatus` (PASS/FAIL/UNKNOWN) type as-is, unmodified - never
 * redefined here - so a future composition layer can treat strict criteria uniformly alongside
 * Scanner's own. `StrictCriterionState` is the additive ENABLED/DISABLED wrapper around it, for
 * criteria a future Scanner-settings-driven composition might allow turning off without being
 * confused with a genuine UNKNOWN (insufficient evidence). The mandatory gates in this file
 * (identity, quote validity/timing, chain delay, session, standard terms, alignment) are never
 * optional - they always evaluate to PASS/FAIL/UNKNOWN and cannot be bypassed by a settings toggle.
 */
export type StrictCriterionState<ReasonCode extends string> =
  | { enabled: true; status: CriterionStatus; reasonCode: ReasonCode; detail: string }
  | { enabled: false; status: "NOT_ASSESSED" };

function mandatory<ReasonCode extends string>(status: CriterionStatus, reasonCode: ReasonCode, detail: string) {
  return { status, reasonCode, detail };
}

// ---------------------------------------------------------------------------------------------
// Shared pure numeric/date helpers
// ---------------------------------------------------------------------------------------------

/**
 * Deterministic decimal-string equality (4 decimal places - one more than OCC's own 3-decimal
 * strike scale) via `toFixed`, never raw floating-point multiplication (`Math.round(a * 10_000)`),
 * which can itself introduce representation artifacts for some decimal inputs. `25`, `25.0`, and
 * `25.00` all compare equal (same fixed-point string); `25.0001` does NOT equal `25` - it is a
 * materially different decimal value, never silently rounded away.
 */
function strikesEqual(a: number, b: number): boolean {
  return a.toFixed(4) === b.toFixed(4);
}

/**
 * Parses a Schwab strike-MAP-KEY (e.g. "655.0") into a number. This is NOT the strict numeric
 * reader the normalizer uses for provider FIELD values (see normalizers.ts's own `strictNumber` -
 * no `Number(...)`/coercion there) - a JSON object key is always and only ever a string by
 * construction, so interpreting "655.0" as the decimal it spells is a lossless key read, not a
 * coercion of an ambiguously-typed provider value. Returns null for anything that isn't a plain
 * decimal numeral.
 */
function parseDecimalMapKey(key: string): number | null {
  const trimmed = key.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** The "YYYY-MM-DD" calendar-date prefix of a Schwab expiration-map key (e.g. "2026-10-16:16"),
 * or null if the key doesn't start with a recognizable date. Never timezone-converted - compared
 * as a plain calendar-date label, like every other date-only field in this module. */
function calendarDateFromExpirationMapKey(key: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})(?::|$)/.exec(key);
  return match ? match[1] : null;
}

function calendarDateOfUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// 1. Option identity
// ---------------------------------------------------------------------------------------------

export type IdentityReasonCode = "IDENTITY_VALID" | "IDENTITY_MISSING" | "IDENTITY_MISMATCH";

/**
 * Validates internal consistency among EVERY identity-bearing field a strict contract carries -
 * never whether it matches some externally-selected target (the future Trade Prep workflow
 * reuses whatever contract the legacy Scanner already selected; this function only asks "is this
 * contract's OWN evidence self-consistent and genuinely a standard PUT on the requested
 * underlying").
 *
 * Two-phase, per the ticket's explicit missing-vs-mismatch contract:
 *  1. PRESENCE: every required structured field (chain root symbol, provider symbol, putCall,
 *     strikePrice, expirationDate, the raw optionRoot field) must simply be present. If ANY is
 *     missing, the result is `UNKNOWN`/`IDENTITY_MISSING` - insufficient evidence to judge, never
 *     a fabricated mismatch and never a verified identity. This is NOT a FAIL: a provider that
 *     simply omitted a field told us nothing false, it told us nothing at all.
 *  2. AGREEMENT: only once every required field is confirmed present does disagreement between
 *     them become meaningful - from here, any inconsistency (wrong root/optionRoot/strike/
 *     expiration, a non-PUT contract, an unparseable provider symbol, a conflicting duplicate
 *     record) is `FAIL`/`IDENTITY_MISMATCH`.
 *
 * `optionRoot` is Schwab's own raw field (see normalizers.ts) - OCC-style parsing of the provider
 * symbol is used ONLY as an additional consistency check once optionRoot is already known to be
 * present, never to fill in a missing optionRoot or any other missing structured field.
 *
 * "Supported deliverable symbol" (the ticket's own identity-consistency requirement) is
 * deliberately NOT re-checked here - it is the authoritative job of evaluateStandardContractTerms,
 * which already validates the full deliverable shape (asset type, units, symbol) as part of
 * "is this a standard contract." Duplicating that check here under a different reason code would
 * risk the two gates disagreeing about the exact same underlying fact.
 */
export function evaluateOptionIdentity(params: {
  requestedUnderlying: string;
  envelope: Pick<StrictOptionChainEnvelope, "rootSymbol">;
  contract: StrictOptionContractSnapshot;
  /** All contracts from the same strict snapshot, for conflicting-duplicate-identity detection.
   * Defaults to just this one contract (no duplicate possible) when omitted. */
  siblingContracts?: StrictOptionContractSnapshot[];
}): { status: CriterionStatus; reasonCode: IdentityReasonCode; detail: string } {
  const { requestedUnderlying, envelope, contract } = params;

  const missing: string[] = [];
  if (!requestedUnderlying) missing.push("requestedUnderlying");
  if (!envelope.rootSymbol) missing.push("chain root symbol");
  if (!contract.identity.providerSymbol) missing.push("provider symbol");
  if (!contract.identity.putCall) missing.push("structured putCall");
  if (contract.identity.strikePrice === null) missing.push("structured strikePrice");
  if (!contract.identity.expirationDate) missing.push("structured expirationDate");
  if (!contract.identity.optionRoot) missing.push("raw optionRoot");
  if (missing.length > 0) {
    return mandatory("UNKNOWN", "IDENTITY_MISSING", `Required structured identity evidence is missing: ${missing.join(", ")}.`);
  }

  // Every field checked above is now confirmed present - `!` assertions below are justified by
  // that presence check, not by the field types themselves.
  const requestedUpper = requestedUnderlying.toUpperCase();
  const rootSymbol = envelope.rootSymbol!.trim().toUpperCase();
  if (rootSymbol !== requestedUpper) {
    return mandatory("FAIL", "IDENTITY_MISMATCH", `Chain root symbol "${rootSymbol}" does not match the requested underlying "${requestedUpper}".`);
  }
  if (contract.location.originatingMap !== "PUT") {
    return mandatory("FAIL", "IDENTITY_MISMATCH", "Contract did not originate from the chain's putExpDateMap.");
  }
  const putCall = contract.identity.putCall!.trim().toUpperCase();
  if (putCall !== "PUT") {
    return mandatory("FAIL", "IDENTITY_MISMATCH", `Structured putCall field "${contract.identity.putCall}" is not PUT.`);
  }
  const optionRoot = contract.identity.optionRoot!.trim().toUpperCase();
  if (optionRoot !== requestedUpper) {
    return mandatory("FAIL", "IDENTITY_MISMATCH", `Raw optionRoot "${optionRoot}" does not match the requested underlying "${requestedUpper}".`);
  }

  const providerSymbol = contract.identity.providerSymbol!;
  const occ = parseOccOptionSymbol(providerSymbol); // consistency check only - never fills missing fields
  if (!occ) {
    return mandatory("FAIL", "IDENTITY_MISMATCH", `Provider symbol "${providerSymbol}" did not parse as a recognizable OCC-style option symbol.`);
  }
  if (occ.underlying !== requestedUpper) {
    return mandatory("FAIL", "IDENTITY_MISMATCH", `Provider symbol underlying "${occ.underlying}" does not match the requested underlying "${requestedUpper}".`);
  }

  const strikePrice = contract.identity.strikePrice!;
  if (!Number.isFinite(strikePrice) || strikePrice <= 0) {
    return mandatory("FAIL", "IDENTITY_MISMATCH", "Structured strikePrice is non-finite or not positive.");
  }
  const strikeMapValue = parseDecimalMapKey(contract.location.strikeMapKey);
  if (strikeMapValue === null || !strikesEqual(strikeMapValue, strikePrice)) {
    return mandatory("FAIL", "IDENTITY_MISMATCH", `Strike map key "${contract.location.strikeMapKey}" does not match structured strikePrice ${strikePrice}.`);
  }
  if (!strikesEqual(occ.strike, strikePrice)) {
    return mandatory("FAIL", "IDENTITY_MISMATCH", `Provider symbol strike ${occ.strike} does not match structured strikePrice ${strikePrice}.`);
  }

  const mapCalendarDate = calendarDateFromExpirationMapKey(contract.location.expirationMapKey);
  if (!mapCalendarDate) {
    return mandatory("FAIL", "IDENTITY_MISMATCH", `Expiration map key "${contract.location.expirationMapKey}" did not start with a recognizable calendar date.`);
  }
  const expirationDate = contract.identity.expirationDate!;
  if (calendarDateOfUtc(expirationDate) !== mapCalendarDate) {
    return mandatory("FAIL", "IDENTITY_MISMATCH", `Structured expirationDate ${calendarDateOfUtc(expirationDate)} does not match the expiration map date ${mapCalendarDate}.`);
  }
  if (calendarDateOfUtc(occ.expiration) !== mapCalendarDate) {
    return mandatory("FAIL", "IDENTITY_MISMATCH", `Provider symbol expiration ${calendarDateOfUtc(occ.expiration)} does not match the expiration map date ${mapCalendarDate}.`);
  }

  const siblings = params.siblingContracts ?? [contract];
  if (hasConflictingDuplicateIdentity(siblings, contract)) {
    return mandatory("FAIL", "IDENTITY_MISMATCH", "Multiple contracts share this identity (strike/expiration/PUT) with conflicting evidence - remains ambiguous.");
  }

  return mandatory("PASS", "IDENTITY_VALID", "Provider symbol, structured fields, and map location are mutually consistent.");
}

/**
 * A full-evidence fingerprint of everything that could make two apparently-identical-identity
 * records actually conflict - not just the provider symbol. Two contracts with the SAME
 * strike/expiration/PUT-CALL "apparent identity" but ANY differing evidence here (quote values,
 * quote timestamp, optionRoot, contract terms, deliverables, or the rule inputs strict evaluation
 * depends on) are conflicting duplicates, not a harmless repeated observation.
 */
function contractEvidenceFingerprint(contract: StrictOptionContractSnapshot): string {
  return JSON.stringify({
    providerSymbol: contract.identity.providerSymbol,
    putCall: contract.identity.putCall,
    optionRoot: contract.identity.optionRoot,
    bid: contract.quote.bid,
    ask: contract.quote.ask,
    quoteTimeInLong: contract.quote.quoteTimeInLong,
    multiplier: contract.terms.multiplier,
    nonStandard: contract.terms.nonStandard,
    mini: contract.terms.mini,
    settlementType: contract.terms.settlementType,
    deliverableNote: contract.terms.deliverableNote,
    optionDeliverablesList: contract.terms.optionDeliverablesList,
    openInterest: contract.ruleInputs.openInterest,
    totalVolume: contract.ruleInputs.totalVolume,
    delta: contract.ruleInputs.delta,
  });
}

/**
 * True when some OTHER contract in `contracts` shares `target`'s strike/expiration/PUT "apparent
 * identity" but its full evidence fingerprint differs in ANY way - a genuinely conflicting
 * duplicate that must remain ambiguous rather than have one record arbitrarily preferred.
 * Two records that are fully evidence-identical (e.g. a harmless repeated/retried observation)
 * are NOT a conflict and may be treated as the same observation.
 */
export function hasConflictingDuplicateIdentity(contracts: StrictOptionContractSnapshot[], target: StrictOptionContractSnapshot): boolean {
  if (target.identity.strikePrice === null || !target.identity.expirationDate) {
    return false; // nothing well-formed enough to compare against
  }
  const targetCalendarDate = calendarDateOfUtc(target.identity.expirationDate);
  const targetFingerprint = contractEvidenceFingerprint(target);
  for (const other of contracts) {
    if (other === target) continue;
    if (other.location.originatingMap !== target.location.originatingMap) continue;
    if (other.identity.strikePrice === null || !other.identity.expirationDate) continue;
    if (!strikesEqual(other.identity.strikePrice, target.identity.strikePrice)) continue;
    if (calendarDateOfUtc(other.identity.expirationDate) !== targetCalendarDate) continue;
    if (contractEvidenceFingerprint(other) !== targetFingerprint) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// 2. Bid/ask validity
// ---------------------------------------------------------------------------------------------

export type QuoteReasonCode = "QUOTE_VALID" | "QUOTE_MISSING" | "QUOTE_NONFINITE" | "ZERO_BID" | "NEGATIVE_BID" | "CROSSED_QUOTE";

/**
 * Strict bid/ask validity from the SAME strict contract observation - never last/mark/midpoint/
 * underlying price (those fields are not even present on StrictOptionContractQuote, so there is
 * nothing to accidentally reach for). A valid result here is NOT a claim of guaranteed executable
 * pricing - only that bid/ask are individually sane and not crossed.
 */
export function evaluateBidAsk(contract: StrictOptionContractSnapshot): { status: CriterionStatus; reasonCode: QuoteReasonCode; detail: string } {
  const { bid, ask } = contract.quote;
  if (bid === null || ask === null) {
    return mandatory("UNKNOWN", "QUOTE_MISSING", "Bid and/or ask is missing from this strict observation.");
  }
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
    return mandatory("FAIL", "QUOTE_NONFINITE", "Bid and/or ask is not a finite number.");
  }
  if (bid < 0) {
    return mandatory("FAIL", "NEGATIVE_BID", `Bid ${bid} is negative.`);
  }
  if (bid === 0) {
    return mandatory("FAIL", "ZERO_BID", "Bid is zero - not eligible.");
  }
  if (ask < bid) {
    return mandatory("FAIL", "CROSSED_QUOTE", `Ask ${ask} is less than bid ${bid} - crossed quote.`);
  }
  return mandatory("PASS", "QUOTE_VALID", `Bid ${bid} / ask ${ask} are individually sane and not crossed.`);
}

// ---------------------------------------------------------------------------------------------
// 3. Quote timestamp / freshness
// ---------------------------------------------------------------------------------------------

export type QuoteTimestampReasonCode =
  | "QUOTE_TIMESTAMP_VALID"
  | "QUOTE_TIMESTAMP_MISSING"
  | "QUOTE_TIMESTAMP_INVALID"
  | "QUOTE_TIMESTAMP_FUTURE"
  | "QUOTE_STALE"
  | "TRANSPORT_TIMESTAMPS_INVALID";

/** The strict maximum age (evaluation clock minus provider quoteTimeInLong) for a quote to still
 * be usable - exactly 60,000ms is eligible, one millisecond over is not. */
export const STRICT_QUOTE_MAX_AGE_MS = 60_000;

export type QuoteFreshnessResult = {
  status: CriterionStatus;
  reasonCode: QuoteTimestampReasonCode;
  detail: string;
  quoteTime: Date | null;
  ageMs: number | null;
};

/**
 * Uses ONLY `quoteTimeInLong` - `tradeTimeInLong` is not even present on StrictOptionContractQuote,
 * so an old/zero tradeTime can never invalidate a fresh quote (there is nothing to read). A future
 * timestamp is REJECTED, never clamped. Age is measured against `evaluationNow` (re-derived fresh
 * on every call, per the ticket's cache/provenance rules), not against `responseReceivedAt` - a
 * cache hit must not make an old quote look newer just because it was re-read recently.
 */
export function evaluateQuoteFreshness(params: {
  quoteTimeInLong: number | null;
  requestStartedAt: Date;
  responseReceivedAt: Date;
  evaluationNow: Date;
}): QuoteFreshnessResult {
  const { quoteTimeInLong, requestStartedAt, responseReceivedAt, evaluationNow } = params;

  if (
    !Number.isFinite(requestStartedAt.getTime()) ||
    !Number.isFinite(responseReceivedAt.getTime()) ||
    !Number.isFinite(evaluationNow.getTime()) ||
    requestStartedAt.getTime() > responseReceivedAt.getTime() ||
    responseReceivedAt.getTime() > evaluationNow.getTime()
  ) {
    return { ...mandatory("FAIL", "TRANSPORT_TIMESTAMPS_INVALID", "Transport timestamps are invalid or out of order."), quoteTime: null, ageMs: null };
  }

  if (quoteTimeInLong === null) {
    return { ...mandatory("UNKNOWN", "QUOTE_TIMESTAMP_MISSING", "quoteTimeInLong is absent."), quoteTime: null, ageMs: null };
  }
  if (!Number.isFinite(quoteTimeInLong) || !Number.isInteger(quoteTimeInLong) || quoteTimeInLong <= 0) {
    return { ...mandatory("FAIL", "QUOTE_TIMESTAMP_INVALID", `quoteTimeInLong ${quoteTimeInLong} is not a positive integer.`), quoteTime: null, ageMs: null };
  }

  // An astronomically large (but still a finite positive integer) value like 1e20 passes the
  // check above yet falls far outside JS Date's representable range (±8.64e15ms from epoch),
  // producing an Invalid Date whose .getTime() is NaN - every downstream comparison against NaN
  // is silently false, which previously let this slip through as PASS with ageMs: NaN. Reject any
  // quoteTimeInLong that does not round-trip EXACTLY through a real Date.
  const quoteTime = new Date(quoteTimeInLong);
  const quoteTimeMs = quoteTime.getTime();
  if (!Number.isFinite(quoteTimeMs) || quoteTimeMs !== quoteTimeInLong) {
    return { ...mandatory("FAIL", "QUOTE_TIMESTAMP_INVALID", `quoteTimeInLong ${quoteTimeInLong} does not represent a valid, exactly-representable instant.`), quoteTime: null, ageMs: null };
  }

  if (quoteTimeMs > responseReceivedAt.getTime()) {
    return { ...mandatory("FAIL", "QUOTE_TIMESTAMP_FUTURE", "quoteTimeInLong is after responseReceivedAt - rejected, never clamped."), quoteTime, ageMs: null };
  }

  const ageMs = evaluationNow.getTime() - quoteTimeMs;
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return { ...mandatory("FAIL", "QUOTE_TIMESTAMP_INVALID", "Computed quote age is invalid or negative."), quoteTime, ageMs: null };
  }
  if (ageMs > STRICT_QUOTE_MAX_AGE_MS) {
    return { ...mandatory("FAIL", "QUOTE_STALE", `Quote age ${ageMs}ms exceeds the ${STRICT_QUOTE_MAX_AGE_MS}ms limit.`), quoteTime, ageMs };
  }

  return { ...mandatory("PASS", "QUOTE_TIMESTAMP_VALID", `Quote age ${ageMs}ms is within the ${STRICT_QUOTE_MAX_AGE_MS}ms limit.`), quoteTime, ageMs };
}

// ---------------------------------------------------------------------------------------------
// 4. Chain delay evidence
// ---------------------------------------------------------------------------------------------

export type ChainDelayReasonCode = "CHAIN_NOT_DELAYED" | "CHAIN_DELAYED" | "CHAIN_DELAY_UNKNOWN";

/**
 * Chain-ROOT response evidence, never a per-contract realtime flag. Only an actual boolean
 * `false` satisfies the gate - the normalizer already collapses anything else (missing, null, a
 * string "false", any non-boolean) to `null` before this function ever sees it, so `null` here
 * always means "not confirmed realtime," never "confirmed not delayed."
 */
export function evaluateChainDelay(isDelayed: boolean | null): { status: CriterionStatus; reasonCode: ChainDelayReasonCode; detail: string } {
  if (isDelayed === false) {
    return mandatory("PASS", "CHAIN_NOT_DELAYED", "Chain root isDelayed is exactly boolean false.");
  }
  if (isDelayed === true) {
    return mandatory("FAIL", "CHAIN_DELAYED", "Chain root isDelayed is true.");
  }
  return mandatory("UNKNOWN", "CHAIN_DELAY_UNKNOWN", "Chain root isDelayed is missing or not an actual boolean.");
}

export type ChainEnvelopeReasonCode = "CHAIN_ENVELOPE_SUCCESS" | "CHAIN_ENVELOPE_UNKNOWN" | "CHAIN_ENVELOPE_FAILED";

/** The only Schwab chain-envelope status value this codebase has ever observed as a successful
 * response (see strict-option-chain-live-derived.json) - a narrow allowlist rather than a guessed
 * broader interpretation, per this ticket's own "fail closed on unrecognized evidence" direction. */
const SUCCESSFUL_CHAIN_ENVELOPE_STATUS = "SUCCESS";

/**
 * Strict all-passing evidence must come from a chain-root response that itself reported success -
 * valid-looking contract fields nested inside an unsuccessful/unknown envelope must never
 * authorize strict evidence. Missing/null/wrong-type status is UNKNOWN (insufficient evidence);
 * any other actual string is FAIL (the provider told us something specific and it wasn't success).
 */
export function evaluateChainEnvelopeStatus(status: string | null): { status: CriterionStatus; reasonCode: ChainEnvelopeReasonCode; detail: string } {
  if (status === null) {
    return mandatory("UNKNOWN", "CHAIN_ENVELOPE_UNKNOWN", "Chain envelope status is missing or not an actual string.");
  }
  if (status === SUCCESSFUL_CHAIN_ENVELOPE_STATUS) {
    return mandatory("PASS", "CHAIN_ENVELOPE_SUCCESS", `Chain envelope status is "${SUCCESSFUL_CHAIN_ENVELOPE_STATUS}".`);
  }
  return mandatory("FAIL", "CHAIN_ENVELOPE_FAILED", `Chain envelope status "${status}" is not "${SUCCESSFUL_CHAIN_ENVELOPE_STATUS}".`);
}

// ---------------------------------------------------------------------------------------------
// 5. Session eligibility
// ---------------------------------------------------------------------------------------------

export type SessionReasonCode = "SESSION_VALID" | "SESSION_CLOSED" | "SESSION_UNKNOWN";

/**
 * An APPLICATION eligibility window, reusing the existing validated regular-session evidence
 * infrastructure (regularSessionIntervalContaining - half-open, start inclusive/end exclusive,
 * already NY-calendar/holiday/early-close aware via Schwab's own market-hours evidence) - this
 * never claims Schwab confirmed the SPECIFIC option contract is tradable, only that the
 * evaluation instant, the option's own quote time, and the underlying's own trade time all fall
 * within the same validated regular-session interval. Unavailable/ambiguous session evidence
 * fails closed to UNKNOWN, never assumed open or closed.
 */
export function evaluateSessionEligibility(params: {
  sessionEvidence: EquityMarketSessionEvidence;
  quoteTime: Date | null;
  underlyingTradeTime: Date | null;
  evaluationNow: Date;
}): { status: CriterionStatus; reasonCode: SessionReasonCode; detail: string; interval: EquityRegularSessionInterval | null } {
  const { sessionEvidence, quoteTime, underlyingTradeTime, evaluationNow } = params;

  if (sessionEvidence.status !== "AVAILABLE") {
    return { ...mandatory("UNKNOWN", "SESSION_UNKNOWN", "Regular-session evidence is unavailable."), interval: null };
  }

  const nowInterval = regularSessionIntervalContaining(sessionEvidence, evaluationNow);
  if (!nowInterval) {
    return { ...mandatory("FAIL", "SESSION_CLOSED", "Evaluation instant falls outside every validated regular-session interval."), interval: null };
  }

  if (quoteTime === null || underlyingTradeTime === null) {
    return { ...mandatory("UNKNOWN", "SESSION_UNKNOWN", "Option quote time and/or underlying trade time is unavailable."), interval: nowInterval };
  }

  const quoteInterval = regularSessionIntervalContaining(sessionEvidence, quoteTime);
  const underlyingInterval = regularSessionIntervalContaining(sessionEvidence, underlyingTradeTime);
  if (!quoteInterval || !underlyingInterval || quoteInterval.start.getTime() !== nowInterval.start.getTime() || underlyingInterval.start.getTime() !== nowInterval.start.getTime()) {
    return { ...mandatory("FAIL", "SESSION_CLOSED", "Option quote time and/or underlying trade time falls outside the current regular-session interval."), interval: nowInterval };
  }

  return { ...mandatory("PASS", "SESSION_VALID", "Evaluation instant, quote time, and underlying trade time all fall within the same regular-session interval."), interval: nowInterval };
}

// ---------------------------------------------------------------------------------------------
// 6. Standard contract terms
// ---------------------------------------------------------------------------------------------

export type ContractTermsReasonCode = "CONTRACT_STANDARD" | "CONTRACT_TERMS_UNKNOWN" | "CONTRACT_UNSUPPORTED";

/** The only settlementType value this codebase has ever observed on a standard contract (see
 * strict-option-chain-live-derived.json) - a narrow allowlist, not a guessed broader
 * interpretation. Any OTHER actual value (e.g. a cash-settlement code) fails closed as
 * contradictory evidence rather than being silently accepted or ignored. */
const SUPPORTED_SETTLEMENT_TYPE = "P";

/** Case-insensitive substring check against a free-text deliverable note - deliberately narrow
 * (only the exact contradiction the ticket reproduced, "CASH ONLY") rather than inventing a
 * broader settlement-semantics parser this codebase has no evidence to support. */
function deliverableNoteContradictsPhysicalDelivery(note: string): boolean {
  return note.toUpperCase().includes("CASH");
}

/**
 * V1 supports exactly one contract shape: a plain, non-adjusted, non-mini, 100-multiplier PUT with
 * exactly one deliverable entry of 100 shares of the supported underlying's own stock, settled
 * physically. Any missing top-level or deliverable-entry field is UNKNOWN (never assumed standard
 * - multiplier absent is never treated as 100). Any explicit deviation (nonStandard/mini true,
 * wrong multiplier, wrong deliverable count/shape/units/symbol/currency, a non-physical
 * settlementType, or a deliverableNote contradicting physical stock delivery) is UNSUPPORTED. This
 * gate deliberately does NOT attempt to generalize to foreign-currency, cash-settled, non-equity,
 * adjusted, or mini contracts - all of those fall out as UNSUPPORTED by these same checks, never a
 * separate code path.
 */
export function evaluateStandardContractTerms(params: {
  terms: StrictOptionContractTerms;
  supportedUnderlying: string;
}): { status: CriterionStatus; reasonCode: ContractTermsReasonCode; detail: string } {
  const { terms, supportedUnderlying } = params;

  if (terms.multiplier === null || terms.nonStandard === null || terms.mini === null || terms.optionDeliverablesList === null) {
    return mandatory("UNKNOWN", "CONTRACT_TERMS_UNKNOWN", "One or more required contract-terms fields (multiplier/nonStandard/mini/optionDeliverablesList) is missing.");
  }
  // Contradiction checks run before the "supported shape" checks below - a contract that LOOKS
  // standard on multiplier/deliverable-count but carries explicit cash-settlement metadata must
  // never pass just because the other fields happen to look right.
  if (terms.settlementType !== null && terms.settlementType.toUpperCase() !== SUPPORTED_SETTLEMENT_TYPE) {
    return mandatory("FAIL", "CONTRACT_UNSUPPORTED", `settlementType "${terms.settlementType}" is not the supported physical-settlement value.`);
  }
  if (terms.deliverableNote !== null && deliverableNoteContradictsPhysicalDelivery(terms.deliverableNote)) {
    return mandatory("FAIL", "CONTRACT_UNSUPPORTED", `deliverableNote "${terms.deliverableNote}" contradicts physical stock delivery.`);
  }
  if (terms.nonStandard === true) {
    return mandatory("FAIL", "CONTRACT_UNSUPPORTED", "Contract is explicitly marked nonStandard.");
  }
  if (terms.mini === true) {
    return mandatory("FAIL", "CONTRACT_UNSUPPORTED", "Contract is explicitly marked mini.");
  }
  if (terms.multiplier !== 100) {
    return mandatory("FAIL", "CONTRACT_UNSUPPORTED", `Multiplier ${terms.multiplier} is not 100.`);
  }
  if (terms.optionDeliverablesList.length !== 1) {
    return mandatory("FAIL", "CONTRACT_UNSUPPORTED", `Expected exactly one deliverable entry, found ${terms.optionDeliverablesList.length}.`);
  }

  const deliverable = terms.optionDeliverablesList[0]!;
  if (deliverable.symbol === null || deliverable.assetType === null || deliverable.deliverableUnits === null) {
    return mandatory("UNKNOWN", "CONTRACT_TERMS_UNKNOWN", "The single deliverable entry is missing required fields (symbol/assetType/deliverableUnits).");
  }
  if (deliverable.assetType.toUpperCase() !== "STOCK") {
    return mandatory("FAIL", "CONTRACT_UNSUPPORTED", `Deliverable assetType "${deliverable.assetType}" is not STOCK.`);
  }
  if (deliverable.symbol.toUpperCase() !== supportedUnderlying.toUpperCase()) {
    return mandatory("FAIL", "CONTRACT_UNSUPPORTED", `Deliverable symbol "${deliverable.symbol}" does not match the supported underlying "${supportedUnderlying}".`);
  }
  if (deliverable.deliverableUnits !== 100) {
    return mandatory("FAIL", "CONTRACT_UNSUPPORTED", `Deliverable units ${deliverable.deliverableUnits} is not 100.`);
  }
  if (deliverable.currencyType !== null && deliverable.currencyType.toUpperCase() !== "USD") {
    return mandatory("FAIL", "CONTRACT_UNSUPPORTED", `Deliverable currencyType "${deliverable.currencyType}" is not supported.`);
  }

  return mandatory("PASS", "CONTRACT_STANDARD", "Standard 100-multiplier, single 100-share stock-deliverable PUT.");
}

// ---------------------------------------------------------------------------------------------
// 7. Underlying/option alignment
// ---------------------------------------------------------------------------------------------

export type AlignmentReasonCode = "ALIGNMENT_VALID" | "ALIGNMENT_UNKNOWN" | "ALIGNMENT_STALE_UNDERLYING" | "ALIGNMENT_STALE_OPTION" | "ALIGNMENT_MISALIGNED";

/** The same 60,000ms bound used for option-quote freshness, applied symmetrically here to the
 * underlying's own age and to the separation between the two timestamps - an application
 * consistency bound, not proof the two prices were observed simultaneously. */
export const STRICT_ALIGNMENT_MAX_SEPARATION_MS = STRICT_QUOTE_MAX_AGE_MS;

export function evaluateUnderlyingOptionAlignment(params: {
  sessionEvidence: EquityMarketSessionEvidence;
  underlyingTradeTime: Date | null;
  quoteTime: Date | null;
  evaluationNow: Date;
}): { status: CriterionStatus; reasonCode: AlignmentReasonCode; detail: string; separationMs: number | null } {
  const { sessionEvidence, underlyingTradeTime, quoteTime, evaluationNow } = params;

  if (underlyingTradeTime === null || quoteTime === null) {
    return { ...mandatory("UNKNOWN", "ALIGNMENT_UNKNOWN", "Underlying trade time and/or option quote time is unavailable."), separationMs: null };
  }
  if (!Number.isFinite(evaluationNow.getTime()) || !Number.isFinite(underlyingTradeTime.getTime()) || !Number.isFinite(quoteTime.getTime())) {
    return { ...mandatory("UNKNOWN", "ALIGNMENT_UNKNOWN", "Evaluation clock, underlying trade time, or option quote time is an invalid Date."), separationMs: null };
  }

  const underlyingAgeMs = evaluationNow.getTime() - underlyingTradeTime.getTime();
  const optionAgeMs = evaluationNow.getTime() - quoteTime.getTime();
  // Neither timestamp may be in the future relative to the evaluation clock - a negative "age"
  // must never be mistaken for freshness (it previously passed the `> limit` staleness check
  // simply because a negative number is never greater than a positive limit).
  if (underlyingAgeMs < 0) {
    return { ...mandatory("FAIL", "ALIGNMENT_STALE_UNDERLYING", "Underlying trade time is in the future relative to the evaluation clock."), separationMs: null };
  }
  if (optionAgeMs < 0) {
    return { ...mandatory("FAIL", "ALIGNMENT_STALE_OPTION", "Option quote time is in the future relative to the evaluation clock."), separationMs: null };
  }
  if (underlyingAgeMs > STRICT_ALIGNMENT_MAX_SEPARATION_MS) {
    return { ...mandatory("FAIL", "ALIGNMENT_STALE_UNDERLYING", `Underlying evidence age ${underlyingAgeMs}ms exceeds the limit.`), separationMs: null };
  }
  if (optionAgeMs > STRICT_ALIGNMENT_MAX_SEPARATION_MS) {
    return { ...mandatory("FAIL", "ALIGNMENT_STALE_OPTION", `Option quote age ${optionAgeMs}ms exceeds the limit.`), separationMs: null };
  }

  const separationMs = Math.abs(quoteTime.getTime() - underlyingTradeTime.getTime());
  if (separationMs > STRICT_ALIGNMENT_MAX_SEPARATION_MS) {
    return { ...mandatory("FAIL", "ALIGNMENT_MISALIGNED", `Timestamp separation ${separationMs}ms exceeds the ${STRICT_ALIGNMENT_MAX_SEPARATION_MS}ms limit.`), separationMs };
  }

  // Only once both timestamps are individually fresh and close enough to each other does session
  // membership become the deciding factor - unavailable session evidence is UNKNOWN here (never
  // silently skipped into a PASS), and two validated-but-DIFFERENT intervals is a mismatch.
  if (sessionEvidence.status !== "AVAILABLE") {
    return { ...mandatory("UNKNOWN", "ALIGNMENT_UNKNOWN", "Regular-session evidence is unavailable."), separationMs };
  }
  const quoteInterval = regularSessionIntervalContaining(sessionEvidence, quoteTime);
  const underlyingInterval = regularSessionIntervalContaining(sessionEvidence, underlyingTradeTime);
  if (!quoteInterval || !underlyingInterval || quoteInterval.start.getTime() !== underlyingInterval.start.getTime()) {
    return { ...mandatory("FAIL", "ALIGNMENT_MISALIGNED", "Option quote time and underlying trade time fall in different (or no) regular-session intervals."), separationMs };
  }

  return { ...mandatory("PASS", "ALIGNMENT_VALID", `Timestamp separation ${separationMs}ms is within the ${STRICT_ALIGNMENT_MAX_SEPARATION_MS}ms limit.`), separationMs };
}

// ---------------------------------------------------------------------------------------------
// 8. OI / volume / delta - safe semantics
// ---------------------------------------------------------------------------------------------

export type RuleInputEvidence = { status: "KNOWN"; value: number } | { status: "UNKNOWN" };

/** Preserved as-reported-in-this-chain-response - never described as "live," never assigned
 * quoteTimeInLong as an individual update timestamp (see StrictOptionContractRuleInputs's own
 * doc comment). */
export function evaluateOpenInterest(value: number | null): RuleInputEvidence {
  return value !== null && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? { status: "KNOWN", value } : { status: "UNKNOWN" };
}

export function evaluateTotalVolume(value: number | null): RuleInputEvidence {
  return value !== null && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? { status: "KNOWN", value } : { status: "UNKNOWN" };
}

/** Matches the existing Scanner convention (live-scan.ts's own `candidateValues`): PUT delta is
 * reported as its absolute value, since Schwab reports it signed negative for puts. An impossible
 * magnitude (|delta| > 1 - options delta is bounded to [-1, 1] by construction) is rejected as
 * UNKNOWN rather than reported as a valid-looking out-of-range number. */
export function evaluatePutDelta(value: number | null): RuleInputEvidence {
  return value !== null && Number.isFinite(value) && Math.abs(value) <= 1 ? { status: "KNOWN", value: Math.abs(value) } : { status: "UNKNOWN" };
}

// ---------------------------------------------------------------------------------------------
// 9. Economics (gross, bid-based, before fees) - only after standard terms pass
// ---------------------------------------------------------------------------------------------

export type StrictOptionEconomics = {
  basis: "GROSS_BID_BEFORE_FEES";
  grossBidProceeds: number;
  grossSecuredCapital: number;
  grossBidReturnOnSecuredCapitalPercent: number | null;
};

/**
 * Reuses the existing optionContractValue/securedCapital/cashSecuredReturnOnRisk primitives -
 * their own hard-coded "*100 shares per contract" is only safe to rely on here because
 * `standardTermsStatus === "PASS"` (CONTRACT_STANDARD, from evaluateStandardContractTerms) has
 * ALREADY independently verified multiplier === 100 and a real 100-share stock deliverable from
 * the raw provider evidence - these functions' internal 100 is never itself used to ESTABLISH
 * standardness. Economics are never computed from a contract whose identity or bid/ask did not
 * independently PASS, even if the raw bid/strike numbers "look" usable in isolation - a passed-in
 * bid/strike that happens to be numerically fine from a contract that FAILED identity must never
 * produce a number here. Every input is re-validated on its own terms (finite positive bid/strike,
 * an actual positive integer quantity) and every computed output is re-validated as finite before
 * being returned - this ticket exposes the computed, typed result for a future composition layer
 * only; nothing here renders to a UI, and no buying-power/affordability figure is computed (that
 * remains "Buying power: confirm in brokerage").
 */
export function computeStrictOptionEconomics(params: {
  identityStatus: CriterionStatus;
  quoteStatus: CriterionStatus;
  standardTermsStatus: CriterionStatus;
  bid: number | null;
  strike: number | null;
  quantity: number;
}): StrictOptionEconomics | null {
  const { identityStatus, quoteStatus, standardTermsStatus, bid, strike, quantity } = params;

  if (identityStatus !== "PASS" || quoteStatus !== "PASS" || standardTermsStatus !== "PASS") {
    return null;
  }
  if (bid === null || !Number.isFinite(bid) || bid <= 0) {
    return null;
  }
  if (strike === null || !Number.isFinite(strike) || strike <= 0) {
    return null;
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return null;
  }

  const grossBidProceeds = optionContractValue(bid, quantity);
  const grossSecuredCapital = securedCapital(strike, quantity);
  const grossBidReturnOnSecuredCapitalPercent = cashSecuredReturnOnRisk(bid, strike, quantity, 0);

  if (!Number.isFinite(grossBidProceeds) || !Number.isFinite(grossSecuredCapital) || grossSecuredCapital <= 0) {
    return null;
  }
  if (grossBidReturnOnSecuredCapitalPercent !== null && !Number.isFinite(grossBidReturnOnSecuredCapitalPercent)) {
    return null;
  }

  return { basis: "GROSS_BID_BEFORE_FEES", grossBidProceeds, grossSecuredCapital, grossBidReturnOnSecuredCapitalPercent };
}

// ---------------------------------------------------------------------------------------------
// 10. Composable evaluation result
// ---------------------------------------------------------------------------------------------

export type StrictOptionEvidenceEvaluation = {
  envelopeStatus: ReturnType<typeof evaluateChainEnvelopeStatus>;
  identity: ReturnType<typeof evaluateOptionIdentity>;
  quote: ReturnType<typeof evaluateBidAsk>;
  quoteTimestamp: QuoteFreshnessResult;
  chainDelay: ReturnType<typeof evaluateChainDelay>;
  /** The Phase-2-approved strict underlying equity quote eligibility result (symbol/asset-type/
   * realtime/price/timestamp/session, 120s freshness - see quoteEvidence.ts's own doc comment).
   * Reused, never duplicated or weakened: `session`/`alignment` below only ever receive the
   * underlying's trade time when this is `eligible: true` - an underlying that fails its own
   * strict eligibility (wrong symbol, non-realtime, unsupported asset type, nonpositive price,
   * stale, invalid timestamp) can never let `session`/`alignment` reach PASS. */
  underlyingEligibility: ReturnType<typeof evaluateQuoteEligibility>;
  session: ReturnType<typeof evaluateSessionEligibility>;
  contractTerms: ReturnType<typeof evaluateStandardContractTerms>;
  alignment: ReturnType<typeof evaluateUnderlyingOptionAlignment>;
  openInterest: RuleInputEvidence;
  totalVolume: RuleInputEvidence;
  delta: RuleInputEvidence;
  economics: StrictOptionEconomics | null;
};

/**
 * Bundles every individual gate above for one contract into a single composable result - does NOT
 * itself synthesize an overall READY/VERIFY/BLOCKED verdict (explicitly out of scope for this
 * ticket; see this module's own header comment). A future composition ticket reads these fields
 * directly rather than re-deriving each gate itself.
 */
export function evaluateStrictOptionEvidence(params: {
  requestedUnderlying: string;
  envelope: Pick<StrictOptionChainEnvelope, "status" | "rootSymbol" | "isDelayed">;
  contract: StrictOptionContractSnapshot;
  siblingContracts: StrictOptionContractSnapshot[];
  requestStartedAt: Date;
  responseReceivedAt: Date;
  sessionEvidence: EquityMarketSessionEvidence;
  underlyingEvidence: QuoteReviewEvidence;
  evaluationNow: Date;
  quantity: number;
}): StrictOptionEvidenceEvaluation {
  const { requestedUnderlying, envelope, contract, siblingContracts, requestStartedAt, responseReceivedAt, sessionEvidence, underlyingEvidence, evaluationNow, quantity } = params;

  const envelopeStatus = evaluateChainEnvelopeStatus(envelope.status);
  const identity = evaluateOptionIdentity({ requestedUnderlying, envelope, contract, siblingContracts });
  const quote = evaluateBidAsk(contract);
  const quoteTimestamp = evaluateQuoteFreshness({ quoteTimeInLong: contract.quote.quoteTimeInLong, requestStartedAt, responseReceivedAt, evaluationNow });
  const chainDelay = evaluateChainDelay(envelope.isDelayed);

  // The underlying must independently clear the already-approved strict equity eligibility bar
  // (exact symbol, EQUITY asset type, realtime, finite positive price, valid non-future timestamp,
  // 120s freshness, regular-session membership) before its trade time is trusted for ANYTHING
  // below - an ineligible underlying's trade time is treated as entirely unavailable (null), never
  // read anyway "because the number looked fine."
  const underlyingEligibility = evaluateQuoteEligibility(underlyingEvidence, sessionEvidence, evaluationNow);
  const underlyingTradeTime = underlyingEligibility.eligible ? underlyingEligibility.evidence.tradeTime : null;

  const session = evaluateSessionEligibility({ sessionEvidence, quoteTime: quoteTimestamp.quoteTime, underlyingTradeTime, evaluationNow });
  const alignment = evaluateUnderlyingOptionAlignment({ sessionEvidence, underlyingTradeTime, quoteTime: quoteTimestamp.quoteTime, evaluationNow });

  const contractTerms = evaluateStandardContractTerms({ terms: contract.terms, supportedUnderlying: requestedUnderlying });
  const economics = computeStrictOptionEconomics({
    identityStatus: identity.status,
    quoteStatus: quote.status,
    standardTermsStatus: contractTerms.status,
    bid: contract.quote.bid,
    strike: contract.identity.strikePrice,
    quantity,
  });

  return {
    envelopeStatus,
    identity,
    quote,
    quoteTimestamp,
    chainDelay,
    underlyingEligibility,
    session,
    contractTerms,
    alignment,
    openInterest: evaluateOpenInterest(contract.ruleInputs.openInterest),
    totalVolume: evaluateTotalVolume(contract.ruleInputs.totalVolume),
    delta: evaluatePutDelta(contract.ruleInputs.delta),
    economics,
  };
}
