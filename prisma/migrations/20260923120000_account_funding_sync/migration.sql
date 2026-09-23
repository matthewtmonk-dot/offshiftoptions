-- CreateEnum
CREATE TYPE "FundingSyncStatus" AS ENUM ('IN_PROGRESS', 'COMPLETE', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "FundingStepStatus" AS ENUM ('PENDING', 'COMPLETE', 'FAILED');

-- CreateTable
CREATE TABLE "AccountFundingSync" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "provider" "BrokerProvider" NOT NULL DEFAULT 'SCHWAB',
    "coverageStart" TIMESTAMP(3) NOT NULL,
    "coverageEnd" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "status" "FundingSyncStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "tradeStatus" "FundingStepStatus" NOT NULL DEFAULT 'PENDING',
    "receiveAndDeliverStatus" "FundingStepStatus" NOT NULL DEFAULT 'PENDING',
    "dividendOrInterestStatus" "FundingStepStatus" NOT NULL DEFAULT 'PENDING',
    "persistenceStatus" "FundingStepStatus" NOT NULL DEFAULT 'PENDING',
    "balanceSnapshotLedgerEntryId" TEXT,

    CONSTRAINT "AccountFundingSync_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountFundingSync_balanceSnapshotLedgerEntryId_key" ON "AccountFundingSync"("balanceSnapshotLedgerEntryId");

-- CreateIndex
CREATE INDEX "AccountFundingSync_accountId_externalAccountId_status_cover_idx" ON "AccountFundingSync"("accountId", "externalAccountId", "status", "coverageStart");

-- CreateIndex
CREATE UNIQUE INDEX "AccountFundingSync_balanceSnapshotLedgerEntryId_accountId_key" ON "AccountFundingSync"("balanceSnapshotLedgerEntryId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "AccountLedgerEntry_id_accountId_key" ON "AccountLedgerEntry"("id", "accountId");

-- AddForeignKey
ALTER TABLE "AccountFundingSync" ADD CONSTRAINT "AccountFundingSync_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountFundingSync" ADD CONSTRAINT "AccountFundingSync_balanceSnapshotLedgerEntryId_accountId_fkey" FOREIGN KEY ("balanceSnapshotLedgerEntryId", "accountId") REFERENCES "AccountLedgerEntry"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;


-- An interrupted or internally contradictory row cannot assert complete coverage.
ALTER TABLE "AccountFundingSync" ADD CONSTRAINT "AccountFundingSync_complete_evidence_check" CHECK (
  "coverageStart" <= "coverageEnd" AND "coverageEnd" <= "startedAt" AND
  ("completedAt" IS NULL OR "completedAt" >= "startedAt") AND
  ("status" <> 'COMPLETE' OR (
    "completedAt" IS NOT NULL AND "balanceSnapshotLedgerEntryId" IS NOT NULL AND
    "tradeStatus" = 'COMPLETE' AND "receiveAndDeliverStatus" = 'COMPLETE' AND
    "dividendOrInterestStatus" = 'COMPLETE' AND "persistenceStatus" = 'COMPLETE'
  ))
);
