-- CreateEnum
CREATE TYPE "TechnicalSnapshotStatus" AS ENUM ('READY', 'FAILED');

-- CreateTable
CREATE TABLE "TechnicalIndicatorSnapshot" (
    "userId" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "asOfDate" DATE,
    "status" "TechnicalSnapshotStatus" NOT NULL,
    "rsi" DOUBLE PRECISION,
    "bbLower" DOUBLE PRECISION,
    "bbMiddle" DOUBLE PRECISION,
    "bbUpper" DOUBLE PRECISION,
    "failureReason" TEXT,
    "historyFetchedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TechnicalIndicatorSnapshot_pkey" PRIMARY KEY ("userId","ticker")
);

-- CreateIndex
CREATE INDEX "TechnicalIndicatorSnapshot_userId_status_idx" ON "TechnicalIndicatorSnapshot"("userId", "status");

-- AddForeignKey
ALTER TABLE "TechnicalIndicatorSnapshot" ADD CONSTRAINT "TechnicalIndicatorSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
