-- CreateEnum
CREATE TYPE "ResearchStatus" AS ENUM ('LIKE', 'WATCH', 'NEUTRAL', 'AVOID', 'NEVER_TRADE');

-- CreateEnum
CREATE TYPE "WouldOwnStatus" AS ENUM ('YES', 'NO', 'CONDITIONAL');

-- CreateEnum
CREATE TYPE "RollFriendliness" AS ENUM ('UNKNOWN', 'FRIENDLY', 'DIFFICULT');

-- AlterTable
ALTER TABLE "WatchlistItem" ADD COLUMN     "companyName" TEXT,
ADD COLUMN     "exclusionReason" TEXT,
ADD COLUMN     "fundamentalAsOf" TIMESTAMP(3),
ADD COLUMN     "fundamentalCurrentRatio" DECIMAL(10,4),
ADD COLUMN     "fundamentalDebtToEquity" DECIMAL(10,4),
ADD COLUMN     "fundamentalDividendYield" DECIMAL(10,4),
ADD COLUMN     "fundamentalEps" DECIMAL(10,4),
ADD COLUMN     "fundamentalPeRatio" DECIMAL(10,2),
ADD COLUMN     "fundamentalPegRatio" DECIMAL(10,2),
ADD COLUMN     "fundamentalSource" TEXT,
ADD COLUMN     "manualLsegRating" TEXT,
ADD COLUMN     "manualLsegScore" TEXT,
ADD COLUMN     "manualLsegTarget" TEXT,
ADD COLUMN     "manualSchwabGrade" TEXT,
ADD COLUMN     "monthlyPutsOnly" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "researchStatus" "ResearchStatus" NOT NULL DEFAULT 'NEUTRAL',
ADD COLUMN     "rollFriendliness" "RollFriendliness" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "rollFriendlinessNote" TEXT,
ADD COLUMN     "whatItDoes" TEXT,
ADD COLUMN     "wouldOwn" "WouldOwnStatus",
ADD COLUMN     "wouldOwnMaxPrice" DECIMAL(12,2),
ALTER COLUMN "visibility" SET DEFAULT 'PRIVATE';

-- CreateIndex
CREATE INDEX "WatchlistItem_ownerId_researchStatus_idx" ON "WatchlistItem"("ownerId", "researchStatus");

-- Backfill researchStatus from the legacy status column instead of leaving every existing
-- row at the column default (NEUTRAL). WatchlistItemStatus is not removed - see the schema
-- comment on ResearchStatus for the full mapping rationale.
UPDATE "WatchlistItem" SET "researchStatus" = 'WATCH' WHERE "status" = 'WATCHING';
UPDATE "WatchlistItem" SET "researchStatus" = 'NEUTRAL' WHERE "status" = 'RESEARCHING';
UPDATE "WatchlistItem" SET "researchStatus" = 'LIKE' WHERE "status" = 'READY';
UPDATE "WatchlistItem" SET "researchStatus" = 'NEVER_TRADE' WHERE "status" = 'DO_NOT_TRADE';
