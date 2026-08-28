-- CreateEnum
CREATE TYPE "RecordVisibility" AS ENUM ('INHERIT', 'PRIVATE', 'SHARED');

-- CreateEnum
CREATE TYPE "CampaignStrategy" AS ENUM ('CASH_SECURED_PUT', 'WHEEL');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('OPEN', 'ASSIGNED', 'CLOSED');

-- CreateEnum
CREATE TYPE "CampaignEventType" AS ENUM ('SELL_PUT', 'CLOSE_PUT', 'ROLL_PUT_CLOSE', 'ROLL_PUT_OPEN', 'ASSIGNMENT', 'SELL_COVERED_CALL', 'CLOSE_COVERED_CALL', 'COVERED_CALL_EXPIRED', 'STOCK_SALE', 'NOTE');

-- AlterTable
ALTER TABLE "TradingAccount" ADD COLUMN     "manualBalance" DECIMAL(14,2),
ADD COLUMN     "startingBalance" DECIMAL(14,2),
ALTER COLUMN "visibility" SET DEFAULT 'SHARED';

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "strategy" "CampaignStrategy" NOT NULL DEFAULT 'CASH_SECURED_PUT',
    "status" "CampaignStatus" NOT NULL DEFAULT 'OPEN',
    "visibility" "RecordVisibility" NOT NULL DEFAULT 'INHERIT',
    "openedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "thesis" TEXT,
    "entrySnapshotJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignEvent" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "type" "CampaignEventType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "groupKey" TEXT,
    "optionType" "OptionType",
    "contracts" INTEGER,
    "shares" INTEGER,
    "strike" DECIMAL(12,2),
    "expiration" TIMESTAMP(3),
    "premium" DECIMAL(12,4),
    "cashAmount" DECIMAL(14,2),
    "fees" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "underlyingPrice" DECIMAL(12,2),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Campaign_ownerId_status_idx" ON "Campaign"("ownerId", "status");

-- CreateIndex
CREATE INDEX "Campaign_accountId_status_idx" ON "Campaign"("accountId", "status");

-- CreateIndex
CREATE INDEX "Campaign_ticker_idx" ON "Campaign"("ticker");

-- CreateIndex
CREATE INDEX "Campaign_visibility_idx" ON "Campaign"("visibility");

-- CreateIndex
CREATE INDEX "CampaignEvent_campaignId_occurredAt_idx" ON "CampaignEvent"("campaignId", "occurredAt");

-- CreateIndex
CREATE INDEX "CampaignEvent_campaignId_groupKey_idx" ON "CampaignEvent"("campaignId", "groupKey");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignEvent" ADD CONSTRAINT "CampaignEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
