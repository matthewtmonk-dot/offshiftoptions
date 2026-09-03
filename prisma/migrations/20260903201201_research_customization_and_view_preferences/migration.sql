-- CreateEnum
CREATE TYPE "LsegRecommendation" AS ENUM ('BUY', 'HOLD', 'SELL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ProfitabilityAssessment" AS ENUM ('PROFITABLE', 'MIXED', 'UNPROFITABLE', 'UNKNOWN');

-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN     "researchColumns" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "researchSortKey" TEXT;

-- AlterTable
ALTER TABLE "WatchlistItem" ADD COLUMN     "fundamentalDividendAmount" DECIMAL(10,4),
ADD COLUMN     "manualCurrentRatio" DECIMAL(10,4),
ADD COLUMN     "manualDebtToEquity" DECIMAL(10,4),
ADD COLUMN     "manualDividendAmount" DECIMAL(10,4),
ADD COLUMN     "manualDividendYield" DECIMAL(10,4),
ADD COLUMN     "manualLsegRecommendation" "LsegRecommendation" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "manualPeRatio" DECIMAL(10,2),
ADD COLUMN     "manualPegRatio" DECIMAL(10,2),
ADD COLUMN     "paysDividend" BOOLEAN,
ADD COLUMN     "profitability" "ProfitabilityAssessment" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "profitabilityNote" TEXT;
