-- CreateEnum
CREATE TYPE "AccountLedgerEntryType" AS ENUM ('STARTING_VALUE', 'DEPOSIT', 'WITHDRAWAL', 'MANUAL_ADJUSTMENT', 'BROKER_SNAPSHOT', 'NOTE');

-- CreateEnum
CREATE TYPE "AccountSource" AS ENUM ('MANUAL', 'SCHWAB');

-- AlterTable
ALTER TABLE "TradingAccount" ADD COLUMN     "brokerConnectionId" TEXT,
ADD COLUMN     "externalAccountId" TEXT,
ADD COLUMN     "source" "AccountSource" NOT NULL DEFAULT 'MANUAL',
ALTER COLUMN "visibility" SET DEFAULT 'PRIVATE';

-- CreateTable
CREATE TABLE "AccountLedgerEntry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" "AccountLedgerEntryType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2),
    "accountValue" DECIMAL(14,2),
    "cash" DECIMAL(14,2),
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountLedgerEntry_accountId_occurredAt_idx" ON "AccountLedgerEntry"("accountId", "occurredAt");

-- CreateIndex
CREATE INDEX "AccountLedgerEntry_type_idx" ON "AccountLedgerEntry"("type");

-- CreateIndex
CREATE UNIQUE INDEX "TradingAccount_userId_externalAccountId_key" ON "TradingAccount"("userId", "externalAccountId");

-- AddForeignKey
ALTER TABLE "TradingAccount" ADD CONSTRAINT "TradingAccount_brokerConnectionId_fkey" FOREIGN KEY ("brokerConnectionId") REFERENCES "BrokerConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountLedgerEntry" ADD CONSTRAINT "AccountLedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
