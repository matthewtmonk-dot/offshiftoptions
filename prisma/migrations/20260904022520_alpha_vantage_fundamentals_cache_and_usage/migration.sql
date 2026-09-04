-- CreateTable
CREATE TABLE "TickerFundamentals" (
    "ticker" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "sector" TEXT,
    "industry" TEXT,
    "marketCapitalization" DECIMAL(20,2),
    "peRatio" DECIMAL(12,4),
    "pegRatio" DECIMAL(12,4),
    "eps" DECIMAL(12,4),
    "dividendPerShare" DECIMAL(12,4),
    "dividendYield" DECIMAL(10,6),
    "profitMargin" DECIMAL(10,6),
    "operatingMarginTtm" DECIMAL(10,6),
    "returnOnAssetsTtm" DECIMAL(10,6),
    "returnOnEquityTtm" DECIMAL(10,6),
    "revenueTtm" DECIMAL(20,2),
    "grossProfitTtm" DECIMAL(20,2),
    "quarterlyEarningsGrowthYoy" DECIMAL(10,6),
    "quarterlyRevenueGrowthYoy" DECIMAL(10,6),
    "analystTargetPrice" DECIMAL(12,4),
    "analystStrongBuy" INTEGER,
    "analystBuy" INTEGER,
    "analystHold" INTEGER,
    "analystSell" INTEGER,
    "analystStrongSell" INTEGER,
    "bookValue" DECIMAL(12,4),
    "priceToBookRatio" DECIMAL(12,4),
    "evToEbitda" DECIMAL(12,4),
    "beta" DECIMAL(10,4),
    "source" TEXT NOT NULL DEFAULT 'Alpha Vantage',
    "fetchedAt" TIMESTAMP(3),
    "staleAfter" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "lastAttemptStatus" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TickerFundamentals_pkey" PRIMARY KEY ("ticker")
);

-- CreateTable
CREATE TABLE "AlphaVantageDailyUsage" (
    "date" DATE NOT NULL,
    "autoCount" INTEGER NOT NULL DEFAULT 0,
    "manualCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlphaVantageDailyUsage_pkey" PRIMARY KEY ("date")
);

-- CreateIndex
CREATE INDEX "TickerFundamentals_staleAfter_idx" ON "TickerFundamentals"("staleAfter");
