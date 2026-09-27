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
  valueSource: string;
  value: number | null;
  captureStatus: string;
  provenanceStatus: string;
  providerSessionDate: Date | null;
  providerCutoff: Date | null;
  provenanceEvidenceReference: string | null;
  provenanceRuleVersion: number | null;
};

/** Only Schwab is a live, currently-supported provider. A future provider must be added here
 * explicitly - an unrecognized provider string can never pass eligibility merely because the
 * status fields say VERIFIED, however they got that way. */
const SUPPORTED_PROVIDERS = new Set(["SCHWAB"]);
/** Mirrors AccountValuationSource (schema.prisma) - the only value-derivation method this
 * ingestion currently produces. */
const SUPPORTED_VALUE_SOURCES = new Set(["CURRENT_BALANCES_LIQUIDATION_VALUE"]);

function nonBlank(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Observation-level prerequisite ONLY. A `true` result proves that this ONE
 * AccountValuationObservation row carries internally coherent, explicit, provider-established
 * verified provenance (captured, VERIFIED_SESSION_CLOSE, a real value, a real session date and
 * cutoff that don't contradict each other, a non-blank evidence reference and rule version, on a
 * supported provider/source, with well-formed account/currency identity).
 *
 * It does NOT prove: benchmark price alignment, that this is the account the user actually
 * selected for comparison, matching benchmark currency, baseline alignment, or funding-interval
 * alignment. Those all belong to a later, not-yet-built benchmark comparison domain - a `true`
 * result here is a necessary precondition for that future domain, never sufficient on its own,
 * and no benchmark calculation is implemented by this function or anywhere else yet.
 *
 * Session/cutoff coherence rule (both fields are stored as timestamps): a cutoff strictly earlier
 * than its own session date is self-contradictory - a trading session cannot close before it
 * opens - and is rejected outright (Astra repro: providerSessionDate Sep 25, providerCutoff Sep
 * 20, previously accepted). This is deliberately the narrowest possible ordering check: it does
 * NOT validate that providerCutoff is a genuine, provider-recognized market-close moment, does not
 * consult any market calendar, and does not check the two are on the "same" trading day under any
 * exchange convention - it only rejects evidence that is internally contradictory. A full
 * market-calendar-aware coherence rule is future work if/when a provider's actual cutoff
 * representation requires it.
 */
export function isBenchmarkSessionEligible(observation: AccountValuationObservationEvidence): boolean {
  if (observation.captureStatus !== "CAPTURED") return false;
  if (observation.provenanceStatus !== "VERIFIED_SESSION_CLOSE") return false;
  if (!SUPPORTED_PROVIDERS.has(observation.provider)) return false;
  if (!SUPPORTED_VALUE_SOURCES.has(observation.valueSource)) return false;
  if (observation.value === null || !Number.isFinite(observation.value)) return false;
  if (observation.providerSessionDate === null || !Number.isFinite(observation.providerSessionDate.getTime())) return false;
  if (observation.providerCutoff === null || !Number.isFinite(observation.providerCutoff.getTime())) return false;
  if (observation.providerCutoff.getTime() < observation.providerSessionDate.getTime()) return false;
  if (!nonBlank(observation.provenanceEvidenceReference)) return false;
  if (
    observation.provenanceRuleVersion === null ||
    !Number.isInteger(observation.provenanceRuleVersion) ||
    observation.provenanceRuleVersion <= 0
  ) return false;
  if (!nonBlank(observation.accountId)) return false;
  if (!nonBlank(observation.currency)) return false;
  return true;
}
