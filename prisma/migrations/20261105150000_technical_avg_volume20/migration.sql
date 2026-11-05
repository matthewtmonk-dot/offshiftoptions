-- AlterTable: nullable, no default, no backfill. Existing rows stay NULL until the next technical refresh.
-- Safe to apply before the matching code is deployed (nothing reads it yet); the code must NOT be deployed before this.
-- IF NOT EXISTS makes this safe to run by hand in the Supabase SQL editor AND again later via `prisma migrate deploy`.
ALTER TABLE "TechnicalIndicatorSnapshot" ADD COLUMN IF NOT EXISTS "avgVolume20" DOUBLE PRECISION;
