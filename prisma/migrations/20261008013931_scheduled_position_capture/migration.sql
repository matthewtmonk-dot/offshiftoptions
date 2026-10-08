-- CreateEnum
CREATE TYPE "ScheduledCaptureSlot" AS ENUM ('OPENING', 'BASELINE', 'FINAL');

-- CreateEnum
CREATE TYPE "ScheduledCaptureStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "ScheduledCaptureRun" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "sessionDate" TEXT NOT NULL,
    "slot" "ScheduledCaptureSlot" NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "ScheduledCaptureStatus" NOT NULL DEFAULT 'RUNNING',
    "attemptCount" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "errorCategory" TEXT,
    "positionsExamined" INTEGER,
    "currentAssessmentsPersisted" INTEGER,
    "unavailableCount" INTEGER,
    "contradictionCount" INTEGER,
    "providerRequestCountEstimate" INTEGER,
    "durationMs" INTEGER,
    "nextEligibleRetryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledCaptureRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledCaptureRun_ownerId_sessionDate_idx" ON "ScheduledCaptureRun"("ownerId", "sessionDate");

-- CreateIndex
CREATE INDEX "ScheduledCaptureRun_status_idx" ON "ScheduledCaptureRun"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledCaptureRun_ownerId_dueAt_key" ON "ScheduledCaptureRun"("ownerId", "dueAt");

-- AddForeignKey
ALTER TABLE "ScheduledCaptureRun" ADD CONSTRAINT "ScheduledCaptureRun_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
