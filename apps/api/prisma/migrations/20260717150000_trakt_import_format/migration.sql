-- Add TRAKT list source (Trakt JSON import) and provider-format discriminator on imports.
ALTER TYPE "ListSource" ADD VALUE 'TRAKT';
ALTER TABLE "imports" ADD COLUMN "format" TEXT NOT NULL DEFAULT 'tvtime';
