-- CreateEnum
CREATE TYPE "AccountValuationSource" AS ENUM ('CURRENT_BALANCES_LIQUIDATION_VALUE');

-- CreateEnum
CREATE TYPE "AccountValuationProvenanceStatus" AS ENUM ('BROKER_VALUE_UNVERIFIED_SESSION', 'VERIFIED_SESSION_CLOSE', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "AccountValuationCaptureStatus" AS ENUM ('CAPTURED', 'MISSED', 'UNAVAILABLE');

-- CreateTable
CREATE TABLE "AccountValuationObservation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "provider" "BrokerProvider" NOT NULL DEFAULT 'SCHWAB',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "value" DECIMAL(14,2),
    "valueSource" "AccountValuationSource" NOT NULL DEFAULT 'CURRENT_BALANCES_LIQUIDATION_VALUE',
    "provenanceStatus" "AccountValuationProvenanceStatus" NOT NULL DEFAULT 'BROKER_VALUE_UNVERIFIED_SESSION',
    "captureStatus" "AccountValuationCaptureStatus" NOT NULL DEFAULT 'CAPTURED',
    "requestStartedAt" TIMESTAMP(3),
    "responseReceivedAt" TIMESTAMP(3),
    "transportDate" TIMESTAMP(3),
    "providerValuationTimestamp" TIMESTAMP(3),
    "providerSessionDate" TIMESTAMP(3),
    "providerCutoff" TIMESTAMP(3),
    "intendedSessionDate" TIMESTAMP(3),
    "scheduledCaptureAt" TIMESTAMP(3),
    "provenanceEvidenceReference" TEXT,
    "provenanceRuleVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountValuationObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountValuationObservation_accountId_createdAt_idx" ON "AccountValuationObservation"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "AccountValuationObservation_accountId_provenanceStatus_idx" ON "AccountValuationObservation"("accountId", "provenanceStatus");

-- AddForeignKey
ALTER TABLE "AccountValuationObservation" ADD CONSTRAINT "AccountValuationObservation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Astra-reviewed state matrix (Fix 2). Every branch below resolves to an explicit boolean via
-- IS NULL/IS NOT NULL and comparisons against NOT NULL enum columns - never left to fall through
-- on Postgres's three-valued (UNKNOWN) logic, which a CHECK silently treats as passing.
--
-- Allowed (captureStatus, provenanceStatus) pairs - all others rejected outright:
--   CAPTURED   + BROKER_VALUE_UNVERIFIED_SESSION  (value required)
--   CAPTURED   + VERIFIED_SESSION_CLOSE           (value + full provenance required)
--   UNAVAILABLE + UNAVAILABLE                      (value null)
--   MISSED      + UNAVAILABLE                      (value null, no transport/provider evidence)
ALTER TABLE "AccountValuationObservation" ADD CONSTRAINT "AccountValuationObservation_state_matrix_check" CHECK (
  (
    ("captureStatus" = 'CAPTURED' AND "provenanceStatus" = 'BROKER_VALUE_UNVERIFIED_SESSION') OR
    ("captureStatus" = 'CAPTURED' AND "provenanceStatus" = 'VERIFIED_SESSION_CLOSE') OR
    ("captureStatus" = 'UNAVAILABLE' AND "provenanceStatus" = 'UNAVAILABLE') OR
    ("captureStatus" = 'MISSED' AND "provenanceStatus" = 'UNAVAILABLE')
  )
  AND
  -- CAPTURED always carries a real value; nothing else ever fabricates one.
  (("captureStatus" = 'CAPTURED') = ("value" IS NOT NULL))
  AND
  -- No value, verified valuation timestamp, or verified session/cutoff can survive alongside an
  -- explicit UNAVAILABLE provenance status.
  ("provenanceStatus" <> 'UNAVAILABLE' OR (
    "value" IS NULL AND "providerValuationTimestamp" IS NULL AND
    "providerSessionDate" IS NULL AND "providerCutoff" IS NULL
  ))
  AND
  -- MISSED describes a scheduled capture that never ran at all - no transport or provider evidence
  -- of any kind. intendedSessionDate/scheduledCaptureAt are deliberately excluded here: they
  -- describe the intended scheduling context, not an attempt that happened.
  ("captureStatus" <> 'MISSED' OR (
    "requestStartedAt" IS NULL AND "responseReceivedAt" IS NULL AND "transportDate" IS NULL AND
    "providerValuationTimestamp" IS NULL AND "providerSessionDate" IS NULL AND "providerCutoff" IS NULL
  ))
  AND
  -- VERIFIED_SESSION_CLOSE requires complete, explicit, non-blank provenance evidence, and the
  -- cutoff can never precede the session it claims to close out (Astra repro: session Sep 25,
  -- cutoff Sep 20, wrongly accepted).
  ("provenanceStatus" <> 'VERIFIED_SESSION_CLOSE' OR (
    "value" IS NOT NULL AND
    "providerSessionDate" IS NOT NULL AND
    "providerCutoff" IS NOT NULL AND
    "providerCutoff" >= "providerSessionDate" AND
    "provenanceEvidenceReference" IS NOT NULL AND length(btrim("provenanceEvidenceReference")) > 0 AND
    "provenanceRuleVersion" IS NOT NULL AND "provenanceRuleVersion" > 0
  ))
);
