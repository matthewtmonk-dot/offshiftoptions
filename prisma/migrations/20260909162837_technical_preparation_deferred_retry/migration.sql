-- AlterEnum
ALTER TYPE "TechnicalPreparationItemStatus" ADD VALUE 'DEFERRED';

-- AlterTable
ALTER TABLE "TechnicalPreparationItem" ADD COLUMN     "deferredAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "retryAfter" TIMESTAMP(3);
