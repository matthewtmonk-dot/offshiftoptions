-- CreateEnum
CREATE TYPE "SchwabDeveloperCredentialStatus" AS ENUM ('CONFIGURED', 'VALIDATED', 'INVALID', 'REMOVED');

-- CreateEnum
CREATE TYPE "BrokerRecordKind" AS ENUM ('TRANSACTION', 'POSITION', 'REALIZED_GAIN_LOSS');

-- CreateEnum
CREATE TYPE "BrokerRecordSource" AS ENUM ('SCHWAB_API', 'SCHWAB_TRANSACTIONS_CSV', 'SCHWAB_POSITIONS_CSV', 'SCHWAB_GAINLOSS_CSV');

-- AlterTable
ALTER TABLE "BrokerConnection" ADD COLUMN     "developerCredentialId" TEXT;

-- CreateTable
CREATE TABLE "SchwabDeveloperCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "BrokerProvider" NOT NULL DEFAULT 'SCHWAB',
    "label" TEXT NOT NULL DEFAULT 'Charles Schwab developer app',
    "clientIdCiphertext" TEXT NOT NULL,
    "clientSecretCiphertext" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "status" "SchwabDeveloperCredentialStatus" NOT NULL DEFAULT 'CONFIGURED',
    "marketDataEnabled" BOOLEAN NOT NULL DEFAULT true,
    "appKeyLast4" TEXT,
    "lastValidatedAt" TIMESTAMP(3),
    "lastValidationFailureAt" TIMESTAMP(3),
    "lastValidationFailureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchwabDeveloperCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrokerRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT,
    "provider" "BrokerProvider" NOT NULL DEFAULT 'SCHWAB',
    "kind" "BrokerRecordKind" NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "reconciliationKey" TEXT,
    "occurredAt" TIMESTAMP(3),
    "observedAt" TIMESTAMP(3),
    "symbol" TEXT,
    "underlyingSymbol" TEXT,
    "action" TEXT,
    "description" TEXT,
    "quantity" DECIMAL(14,4),
    "price" DECIMAL(14,4),
    "fees" DECIMAL(14,2),
    "amount" DECIMAL(14,2),
    "sources" "BrokerRecordSource"[] DEFAULT ARRAY[]::"BrokerRecordSource"[],
    "sourceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrokerRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SchwabDeveloperCredential_userId_status_idx" ON "SchwabDeveloperCredential"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SchwabDeveloperCredential_userId_provider_key" ON "SchwabDeveloperCredential"("userId", "provider");

-- CreateIndex
CREATE INDEX "BrokerRecord_userId_provider_kind_idx" ON "BrokerRecord"("userId", "provider", "kind");

-- CreateIndex
CREATE INDEX "BrokerRecord_userId_reconciliationKey_idx" ON "BrokerRecord"("userId", "reconciliationKey");

-- CreateIndex
CREATE UNIQUE INDEX "BrokerRecord_userId_provider_kind_fingerprint_key" ON "BrokerRecord"("userId", "provider", "kind", "fingerprint");

-- CreateIndex
CREATE INDEX "BrokerConnection_developerCredentialId_idx" ON "BrokerConnection"("developerCredentialId");

-- AddForeignKey
ALTER TABLE "BrokerConnection" ADD CONSTRAINT "BrokerConnection_developerCredentialId_fkey" FOREIGN KEY ("developerCredentialId") REFERENCES "SchwabDeveloperCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchwabDeveloperCredential" ADD CONSTRAINT "SchwabDeveloperCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrokerRecord" ADD CONSTRAINT "BrokerRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrokerRecord" ADD CONSTRAINT "BrokerRecord_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "BrokerRecordStatus" AS ENUM ('CONFIRMED', 'CONFLICT', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "BrokerImportExportType" AS ENUM ('POSITIONS', 'TRANSACTIONS', 'REALIZED_GAIN_LOSS');

-- CreateEnum
CREATE TYPE "BrokerImportBatchStatus" AS ENUM ('PENDING_PREVIEW', 'CONFIRMED', 'DISCARDED');

-- AlterTable
ALTER TABLE "BrokerRecord" ADD COLUMN     "identityKey" TEXT NOT NULL,
ADD COLUMN     "importBatchId" TEXT,
ADD COLUMN     "linkedCampaignId" TEXT,
ADD COLUMN     "reconciliationDismissedAt" TIMESTAMP(3),
ADD COLUMN     "status" "BrokerRecordStatus" NOT NULL DEFAULT 'CONFIRMED';

-- CreateTable
CREATE TABLE "BrokerImportBatch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT,
    "provider" "BrokerProvider" NOT NULL DEFAULT 'SCHWAB',
    "exportType" "BrokerImportExportType" NOT NULL,
    "safeOriginalFilename" TEXT NOT NULL,
    "fileFingerprint" TEXT NOT NULL,
    "asOfAt" TIMESTAMP(3),
    "status" "BrokerImportBatchStatus" NOT NULL DEFAULT 'PENDING_PREVIEW',
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "newCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "conflictCount" INTEGER NOT NULL DEFAULT 0,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "invalidCount" INTEGER NOT NULL DEFAULT 0,
    "previewPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrokerImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BrokerImportBatch_userId_status_idx" ON "BrokerImportBatch"("userId", "status");

-- CreateIndex
CREATE INDEX "BrokerImportBatch_userId_createdAt_idx" ON "BrokerImportBatch"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "BrokerRecord_userId_identityKey_idx" ON "BrokerRecord"("userId", "identityKey");

-- CreateIndex
CREATE INDEX "BrokerRecord_importBatchId_idx" ON "BrokerRecord"("importBatchId");

-- CreateIndex
CREATE INDEX "BrokerRecord_linkedCampaignId_idx" ON "BrokerRecord"("linkedCampaignId");

-- AddForeignKey
ALTER TABLE "BrokerRecord" ADD CONSTRAINT "BrokerRecord_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "BrokerImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrokerRecord" ADD CONSTRAINT "BrokerRecord_linkedCampaignId_fkey" FOREIGN KEY ("linkedCampaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrokerImportBatch" ADD CONSTRAINT "BrokerImportBatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrokerImportBatch" ADD CONSTRAINT "BrokerImportBatch_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
