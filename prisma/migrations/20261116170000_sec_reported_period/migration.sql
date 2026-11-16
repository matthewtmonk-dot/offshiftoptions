-- CreateTable
CREATE TABLE "SecReportedPeriod" (
    "ticker" TEXT NOT NULL,
    "cik" TEXT,
    "form" TEXT,
    "periodEnd" DATE,
    "filedAt" DATE,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecReportedPeriod_pkey" PRIMARY KEY ("ticker")
);
