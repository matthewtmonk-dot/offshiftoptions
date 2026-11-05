-- CreateTable
CREATE TABLE "CompanyQualitySnapshot" (
    "ticker" TEXT NOT NULL,
    "cik" TEXT,
    "sic" INTEGER,
    "status" TEXT NOT NULL,
    "tier" TEXT,
    "reasons" JSONB,
    "runwayQuarters" DOUBLE PRECISION,
    "fcfTtm" DOUBLE PRECISION,
    "dataAgeDays" INTEGER,
    "failureReason" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyQualitySnapshot_pkey" PRIMARY KEY ("ticker")
);

-- CreateTable
CREATE TABLE "CompanyQualityReview" (
    "userId" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyQualityReview_pkey" PRIMARY KEY ("userId","ticker")
);

-- AddForeignKey
ALTER TABLE "CompanyQualityReview" ADD CONSTRAINT "CompanyQualityReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
