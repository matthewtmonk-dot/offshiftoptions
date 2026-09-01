-- CreateEnum
CREATE TYPE "AppearanceMode" AS ENUM ('DARK', 'LIGHT', 'SYSTEM');

-- AlterTable
-- Backfill every existing row (and any row inserted before the next statement runs) to
-- DARK, matching the OSO look every current user already sees today - no one is silently
-- switched to Light/System by this migration. New accounts created after this migration
-- get the SYSTEM default set below.
ALTER TABLE "UserSettings" ADD COLUMN "appearance" "AppearanceMode" NOT NULL DEFAULT 'DARK';

-- AlterTable
ALTER TABLE "UserSettings" ALTER COLUMN "appearance" SET DEFAULT 'SYSTEM';
