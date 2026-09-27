/**
 * Prospective account valuation provenance - evidence candidates only. NOT the existing
 * BROKER_SNAPSHOT ledger entry, AccountFundingSync, or the Whole-Account Gain baseline; none of
 * those are read or written here. Benchmark/opportunity-cost comparison is not implemented -
 * `isBenchmarkSessionEligible` below is the one recognized gate a future benchmark feature must
 * consult, and it is never satisfied by today's ingestion (see workflows.ts): Schwab's
 * currentBalances.liquidationValue is broker-reported but session-unverified - retrieval time is
 * not valuation time, and a scheduled request after market close does not automatically become a
 * verified closing valuation.
 */
export type AccountValuationObservationEvidence = {
  accountId: string;
  provider: string;
  currency: string;
  value: number | null;
  provenanceStatus: string;
  providerSessionDate: Date | null;
  providerCutoff: Date | null;
};

/** A valuation is benchmark-session-eligible only with explicit, provider-established session
 * provenance - never inferred from retrieval/transport timestamps. BROKER_VALUE_UNVERIFIED_SESSION
 * (today's only producible status) can never pass this. */
export function isBenchmarkSessionEligible(observation: AccountValuationObservationEvidence): boolean {
  if (observation.provenanceStatus !== "VERIFIED_SESSION_CLOSE") return false;
  if (observation.providerSessionDate === null || !Number.isFinite(observation.providerSessionDate.getTime())) return false;
  if (observation.providerCutoff === null || !Number.isFinite(observation.providerCutoff.getTime())) return false;
  if (observation.value === null || !Number.isFinite(observation.value)) return false;
  if (!observation.accountId || !observation.currency || !observation.provider) return false;
  return true;
}
