-- AlterTable: nullable, no default, no backfill. Existing rows stay NULL until the next technical refresh.
-- Safe to apply before the matching code is deployed (nothing reads it yet); the code must NOT be deployed before this.
ALTER TABLE "TechnicalIndicatorSnapshot" ADD COLUMN "avgVolume20" DOUBLE PRECISION;
