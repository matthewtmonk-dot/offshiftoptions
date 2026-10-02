-- CreateEnum
CREATE TYPE "PositionReviewPersistedAction" AS ENUM ('COMFORTABLE', 'WATCH', 'REVIEW_ROLL', 'REVIEW_CALL');

-- CreateTable
CREATE TABLE "PositionReviewAssessment" (
    "ownerId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "openingEventId" TEXT NOT NULL,
    "contextFingerprint" TEXT NOT NULL,
    "action" "PositionReviewPersistedAction" NOT NULL,
    "reasonCodes" TEXT[],
    "evaluatedAt" TIMESTAMP(3) NOT NULL,
    "nySessionDate" TEXT NOT NULL,
    "regularSessionStart" TIMESTAMP(3) NOT NULL,
    "regularSessionEnd" TIMESTAMP(3) NOT NULL,
    "underlyingPrice" DECIMAL(12,4) NOT NULL,
    "underlyingTradeTime" TIMESTAMP(3) NOT NULL,
    "ticker" TEXT NOT NULL,
    "optionType" "OptionType" NOT NULL,
    "strike" DECIMAL(12,2) NOT NULL,
    "expiration" TIMESTAMP(3) NOT NULL,
    "contracts" INTEGER NOT NULL,
    "dollarDistance" DECIMAL(12,2) NOT NULL,
    "percentageDistance" DECIMAL(12,4) NOT NULL,
    "appliedRollBufferPercent" DECIMAL(5,2) NOT NULL,
    "positionEvidenceSource" TEXT NOT NULL,
    "brokerReceiptAt" TIMESTAMP(3),
    "evaluationPolicyVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PositionReviewAssessment_pkey" PRIMARY KEY ("ownerId","accountId","campaignId","openingEventId")
);

-- CreateIndex
CREATE INDEX "PositionReviewAssessment_ownerId_idx" ON "PositionReviewAssessment"("ownerId");

-- CreateIndex
CREATE INDEX "PositionReviewAssessment_campaignId_idx" ON "PositionReviewAssessment"("campaignId");

-- AddForeignKey
ALTER TABLE "PositionReviewAssessment" ADD CONSTRAINT "PositionReviewAssessment_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionReviewAssessment" ADD CONSTRAINT "PositionReviewAssessment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionReviewAssessment" ADD CONSTRAINT "PositionReviewAssessment_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionReviewAssessment" ADD CONSTRAINT "PositionReviewAssessment_openingEventId_fkey" FOREIGN KEY ("openingEventId") REFERENCES "CampaignEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
