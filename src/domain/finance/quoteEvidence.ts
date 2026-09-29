import type { EquityMarketSessionEvidence, QuoteReviewEvidence } from "@/providers/market-data/types";
import { isWithinRegularSession } from "./marketSession";

/**
 * Dashboard V2 Phase 2 - the approved live-price eligibility contract for a colored advisory
 * status (rules 1-9 of the ticket's "QUOTE ELIGIBILITY" list; rule 10, position evidence, is a
 * separate concern evaluated in positionReview.ts, since it depends on campaign/broker data this
 * module has no business knowing about). Pure: no network, no database, no AI. `price` and
 * `tradeTime` are trusted here exactly as QuoteReviewEvidence already atomically paired them -
 * this module never re-derives or re-pairs a price/timestamp from raw fields.
 */

export const QUOTE_FRESHNESS_WINDOW_MS = 120_000;

export type QuoteEligibilityFailureReason =
  | "EVIDENCE_UNAVAILABLE"
  | "SYMBOL_MISMATCH"
  | "UNSUPPORTED_ASSET_TYPE"
  | "NOT_REALTIME"
  | "INVALID_PRICE"
  | "INVALID_TIMESTAMP"
  | "FUTURE_TIMESTAMP"
  | "STALE_TIMESTAMP"
  | "SESSION_EVIDENCE_UNAVAILABLE"
  | "MARKET_NOT_IN_REGULAR_SESSION"
  | "TRADE_TIME_OUTSIDE_SESSION";

export type EligibleQuoteEvidence = Extract<QuoteReviewEvidence, { status: "AVAILABLE" }>;

export type QuoteEligibilityResult =
  | { eligible: true; evidence: EligibleQuoteEvidence; ageMs: number }
  | { eligible: false; reason: QuoteEligibilityFailureReason };

/**
 * Rules 1-9, in the ticket's own order. Transport/retrieval time (requestStartedAt/
 * responseReceivedAt) never substitutes for tradeTime anywhere in this function - only
 * `evidence.tradeTime` is ever compared against `now` or the session interval.
 */
export function evaluateQuoteEligibility(
  evidence: QuoteReviewEvidence,
  sessionEvidence: EquityMarketSessionEvidence,
  now: Date,
): QuoteEligibilityResult {
  if (evidence.status !== "AVAILABLE") {
    return { eligible: false, reason: "EVIDENCE_UNAVAILABLE" };
  }
  // Rule 1: exact requested/returned symbol match - strict equality, no case-folding. The
  // ticket's own contract is "record symbol == requested symbol"; normalizing case would be an
  // unauthorized leniency, not something this evidence type is meant to paper over.
  if (evidence.requestedSymbol !== evidence.returnedSymbol) {
    return { eligible: false, reason: "SYMBOL_MISMATCH" };
  }
  // Rule 2: supported EQUITY identity.
  if (evidence.assetMainType !== "EQUITY") {
    return { eligible: false, reason: "UNSUPPORTED_ASSET_TYPE" };
  }
  // Rule 3: realtime === true (an explicit false, or an absent/unknown flag, both fail closed).
  if (evidence.realtime !== true) {
    return { eligible: false, reason: "NOT_REALTIME" };
  }
  // Rule 4: positive finite quote.lastPrice.
  if (!Number.isFinite(evidence.price) || evidence.price <= 0) {
    return { eligible: false, reason: "INVALID_PRICE" };
  }
  // Rule 5: valid quote.tradeTime epoch-ms instant.
  if (!Number.isFinite(evidence.tradeTime.getTime())) {
    return { eligible: false, reason: "INVALID_TIMESTAMP" };
  }
  const ageMs = now.getTime() - evidence.tradeTime.getTime();
  // Rule 6: timestamp not in the future.
  if (ageMs < 0) {
    return { eligible: false, reason: "FUTURE_TIMESTAMP" };
  }
  // Rule 7: timestamp age <= 120 seconds (exactly 120_000ms is still eligible - "stale" is
  // strictly GREATER than the window, per the ticket's own "exact 120-second threshold" test).
  if (ageMs > QUOTE_FRESHNESS_WINDOW_MS) {
    return { eligible: false, reason: "STALE_TIMESTAMP" };
  }
  // Rule 8: validated EQUITY regular session currently open - membership against the real
  // interval, never the day-level `isOpen` flag alone (see marketSession.ts's own doc comment).
  if (sessionEvidence.status !== "AVAILABLE") {
    return { eligible: false, reason: "SESSION_EVIDENCE_UNAVAILABLE" };
  }
  if (!isWithinRegularSession(sessionEvidence, now)) {
    return { eligible: false, reason: "MARKET_NOT_IN_REGULAR_SESSION" };
  }
  // Rule 9: the trade timestamp itself must fall inside THAT SAME regular-session interval -
  // rejects a premarket/after-hours trade time carried over into a moment when `now` happens to
  // be in the regular session (the exact after-hours-capture risk the ticket calls out).
  if (!isWithinRegularSession(sessionEvidence, evidence.tradeTime)) {
    return { eligible: false, reason: "TRADE_TIME_OUTSIDE_SESSION" };
  }
  return { eligible: true, evidence, ageMs };
}
