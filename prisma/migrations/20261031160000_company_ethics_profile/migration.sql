-- CreateEnum
CREATE TYPE "EthicsDecision" AS ENUM ('APPROVED', 'EXCLUDED', 'UNDER_REVIEW');

-- CreateTable
CREATE TABLE "CompanyEthicsProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "companyName" TEXT,
    "assessments" JSONB NOT NULL,
    "score" INTEGER,
    "rating" TEXT NOT NULL,
    "confidence" TEXT,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "incomplete" BOOLEAN NOT NULL DEFAULT false,
    "summary" TEXT,
    "researchedAt" TIMESTAMP(3) NOT NULL,
    "reviewAfter" TIMESTAMP(3),
    "recheckNeeded" BOOLEAN NOT NULL DEFAULT false,
    "recheckReason" TEXT,
    "decision" "EthicsDecision",
    "decisionNote" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyEthicsProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyEthicsEvidence" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "claim" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "supports" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyEthicsEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyEthicsHistory" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "fromRating" TEXT,
    "toRating" TEXT,
    "note" TEXT,

    CONSTRAINT "CompanyEthicsHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompanyEthicsProfile_userId_rating_idx" ON "CompanyEthicsProfile"("userId", "rating");

-- CreateIndex
CREATE INDEX "CompanyEthicsProfile_userId_decision_idx" ON "CompanyEthicsProfile"("userId", "decision");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyEthicsProfile_userId_ticker_key" ON "CompanyEthicsProfile"("userId", "ticker");

-- CreateIndex
CREATE INDEX "CompanyEthicsEvidence_profileId_idx" ON "CompanyEthicsEvidence"("profileId");

-- CreateIndex
CREATE INDEX "CompanyEthicsHistory_profileId_at_idx" ON "CompanyEthicsHistory"("profileId", "at");

-- AddForeignKey
ALTER TABLE "CompanyEthicsProfile" ADD CONSTRAINT "CompanyEthicsProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyEthicsEvidence" ADD CONSTRAINT "CompanyEthicsEvidence_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CompanyEthicsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyEthicsHistory" ADD CONSTRAINT "CompanyEthicsHistory_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CompanyEthicsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

