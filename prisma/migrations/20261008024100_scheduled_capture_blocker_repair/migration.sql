-- AlterEnum
BEGIN;
CREATE TYPE "ScheduledCaptureStatus_new" AS ENUM ('RUNNING', 'SUCCEEDED', 'DEFERRED', 'ABANDONED', 'FAILED');
ALTER TABLE "public"."ScheduledCaptureRun" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "ScheduledCaptureRun" ALTER COLUMN "status" TYPE "ScheduledCaptureStatus_new" USING ("status"::text::"ScheduledCaptureStatus_new");
ALTER TYPE "ScheduledCaptureStatus" RENAME TO "ScheduledCaptureStatus_old";
ALTER TYPE "ScheduledCaptureStatus_new" RENAME TO "ScheduledCaptureStatus";
DROP TYPE "public"."ScheduledCaptureStatus_old";
ALTER TABLE "ScheduledCaptureRun" ALTER COLUMN "status" SET DEFAULT 'RUNNING';
COMMIT;

-- AlterTable
ALTER TABLE "ScheduledCaptureRun" DROP COLUMN "errorCategory",
ADD COLUMN     "resultCategory" TEXT;

-- CreateIndex
CREATE INDEX "ScheduledCaptureRun_ownerId_status_idx" ON "ScheduledCaptureRun"("ownerId", "status");
