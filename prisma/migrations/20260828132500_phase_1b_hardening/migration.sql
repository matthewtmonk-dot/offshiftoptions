-- Align recommendation statuses with the Phase 1B lifecycle.
CREATE TYPE "RecommendationStatus_new" AS ENUM ('NEW', 'WATCHING', 'PASSED', 'ARCHIVED');

ALTER TABLE "Recommendation" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Recommendation"
  ALTER COLUMN "status" TYPE "RecommendationStatus_new"
  USING (
    CASE "status"::text
      WHEN 'DISMISSED' THEN 'PASSED'
      WHEN 'DONE' THEN 'ARCHIVED'
      ELSE "status"::text
    END
  )::"RecommendationStatus_new";
ALTER TABLE "Recommendation" ALTER COLUMN "status" SET DEFAULT 'NEW';

DROP TYPE "RecommendationStatus";
ALTER TYPE "RecommendationStatus_new" RENAME TO "RecommendationStatus";

-- Keep scanner settings editable without duplicate rule keys per profile.
CREATE UNIQUE INDEX "ScannerRule_profileId_key_key" ON "ScannerRule"("profileId", "key");

-- Database-level ticker safety for user-supplied ticker fields.
ALTER TABLE "WatchlistItem"
  ADD CONSTRAINT "WatchlistItem_ticker_format_chk"
  CHECK ("ticker" = upper("ticker") AND length("ticker") BETWEEN 1 AND 10 AND "ticker" ~ '^[A-Z][A-Z0-9.-]{0,9}$');

ALTER TABLE "StockNote"
  ADD CONSTRAINT "StockNote_ticker_format_chk"
  CHECK ("ticker" = upper("ticker") AND length("ticker") BETWEEN 1 AND 10 AND "ticker" ~ '^[A-Z][A-Z0-9.-]{0,9}$');

ALTER TABLE "Recommendation"
  ADD CONSTRAINT "Recommendation_ticker_format_chk"
  CHECK ("ticker" = upper("ticker") AND length("ticker") BETWEEN 1 AND 10 AND "ticker" ~ '^[A-Z][A-Z0-9.-]{0,9}$');

ALTER TABLE "ChatMessage"
  ADD CONSTRAINT "ChatMessage_ticker_format_chk"
  CHECK ("ticker" IS NULL OR ("ticker" = upper("ticker") AND length("ticker") BETWEEN 1 AND 10 AND "ticker" ~ '^[A-Z][A-Z0-9.-]{0,9}$'));

ALTER TABLE "Activity"
  ADD CONSTRAINT "Activity_ticker_format_chk"
  CHECK ("ticker" IS NULL OR ("ticker" = upper("ticker") AND length("ticker") BETWEEN 1 AND 10 AND "ticker" ~ '^[A-Z][A-Z0-9.-]{0,9}$'));
