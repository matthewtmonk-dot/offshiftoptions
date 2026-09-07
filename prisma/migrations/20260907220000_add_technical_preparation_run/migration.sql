-- CreateEnum
CREATE TYPE "TechnicalPreparationRunStatus" AS ENUM ('IN_PROGRESS', 'COMPLETE');

-- CreateEnum
CREATE TYPE "TechnicalPreparationItemStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "TechnicalPreparationRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketDate" DATE NOT NULL,
    "rulesFingerprint" TEXT NOT NULL,
    "status" "TechnicalPreparationRunStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "eligibleCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TechnicalPreparationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TechnicalPreparationItem" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "status" "TechnicalPreparationItemStatus" NOT NULL DEFAULT 'PENDING',
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "TechnicalPreparationItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TechnicalPreparationRun_userId_marketDate_rulesFingerprint_idx" ON "TechnicalPreparationRun"("userId", "marketDate", "rulesFingerprint", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TechnicalPreparationItem_runId_ticker_key" ON "TechnicalPreparationItem"("runId", "ticker");

-- CreateIndex
CREATE INDEX "TechnicalPreparationItem_runId_status_priority_idx" ON "TechnicalPreparationItem"("runId", "status", "priority");

-- AddForeignKey
ALTER TABLE "TechnicalPreparationRun" ADD CONSTRAINT "TechnicalPreparationRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TechnicalPreparationItem" ADD CONSTRAINT "TechnicalPreparationItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TechnicalPreparationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
