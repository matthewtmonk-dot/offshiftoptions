-- CreateTable
CREATE TABLE "OptionableUniverseSymbol" (
    "ticker" TEXT NOT NULL,
    "name" TEXT,
    "source" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OptionableUniverseSymbol_pkey" PRIMARY KEY ("ticker")
);

-- CreateTable
CREATE TABLE "EarningsCalendarEntry" (
    "ticker" TEXT NOT NULL,
    "reportDate" DATE NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EarningsCalendarEntry_pkey" PRIMARY KEY ("ticker","reportDate")
);

-- CreateIndex
CREATE INDEX "OptionableUniverseSymbol_source_lastSeenAt_idx" ON "OptionableUniverseSymbol"("source", "lastSeenAt");

-- CreateIndex
CREATE INDEX "EarningsCalendarEntry_reportDate_idx" ON "EarningsCalendarEntry"("reportDate");
