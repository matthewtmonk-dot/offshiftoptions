import type { EquityMarketSessionEvidence, QuoteReviewEvidence } from "@/providers/market-data/types";
import { regularSessionIntervalContaining } from "./marketSession";

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
  | "TRADE_TIME_OUTSIDE_SESSION"
  | "TRADE_TIME_NOT_IN_SAME_SESSION_INTERVAL_AS_NOW"
  | "TRADE_TIME_AFTER_RESPONSE_RECEIVED";

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
  // Codex P1 (B4): transport chronology - the provider's own trade time can never be AFTER this
  // app's own record of when the HTTP response carrying it was received. A trade "in the future"
  // relative to its own response is internally contradictory evidence (a clock skew or a
  // corrupted/replayed timestamp), never something evaluation time "catching up" should excuse.
  if (evidence.tradeTime.getTime() > evidence.responseReceivedAt.getTime()) {
    return { eligible: false, reason: "TRADE_TIME_AFTER_RESPONSE_RECEIVED" };
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
  const nowInterval = regularSessionIntervalContaining(sessionEvidence, now);
  if (!nowInterval) {
    return { eligible: false, reason: "MARKET_NOT_IN_REGULAR_SESSION" };
  }
  // Rule 9: the trade timestamp itself must fall inside a regular-session interval...
  const tradeTimeInterval = regularSessionIntervalContaining(sessionEvidence, evidence.tradeTime);
  if (!tradeTimeInterval) {
    return { eligible: false, reason: "TRADE_TIME_OUTSIDE_SESSION" };
  }
  // Codex P1 (B4): ...and it must be the SAME interval `now` is in, not merely "some" regular
  // session interval. Without this, a trade in an earlier session interval (before a mid-day
  // trading halt/resumption gap) could still read as eligible once evaluation time reaches a
  // LATER interval, purely because each endpoint was checked against the session independently.
  if (nowInterval.start.getTime() !== tradeTimeInterval.start.getTime() || nowInterval.end.getTime() !== tradeTimeInterval.end.getTime()) {
    return { eligible: false, reason: "TRADE_TIME_NOT_IN_SAME_SESSION_INTERVAL_AS_NOW" };
  }
  return { eligible: true, evidence, ageMs };
}
