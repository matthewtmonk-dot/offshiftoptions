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

-- No verified value without provider-established session/cutoff provenance, and no fabricated
-- zero standing in for an absent broker value.
ALTER TABLE "AccountValuationObservation" ADD CONSTRAINT "AccountValuationObservation_provenance_evidence_check" CHECK (
  ("provenanceStatus" <> 'VERIFIED_SESSION_CLOSE' OR ("providerSessionDate" IS NOT NULL AND "providerCutoff" IS NOT NULL AND "value" IS NOT NULL)) AND
  ("provenanceStatus" <> 'UNAVAILABLE' OR "value" IS NULL) AND
  ("captureStatus" <> 'UNAVAILABLE' OR "value" IS NULL) AND
  ("captureStatus" <> 'CAPTURED' OR "provenanceStatus" <> 'UNAVAILABLE' OR "value" IS NULL)
);
