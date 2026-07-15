-- Migration B: generalize HydrationJob/HydrationJobItem for multi-provider work.
-- Additive, nullable columns; existing rows backfilled as TMDB/hydrate.

ALTER TABLE "hydration_jobs" ADD COLUMN IF NOT EXISTS "provider" TEXT;
ALTER TABLE "hydration_jobs" ADD COLUMN IF NOT EXISTS "entity_kind" TEXT;
ALTER TABLE "hydration_jobs" ADD COLUMN IF NOT EXISTS "locale" TEXT;
ALTER TABLE "hydration_jobs" ADD COLUMN IF NOT EXISTS "match_stage" TEXT;
ALTER TABLE "hydration_jobs" ADD COLUMN IF NOT EXISTS "provider_calls" JSONB;
UPDATE "hydration_jobs" SET "provider" = 'TMDB', "match_stage" = 'hydrate' WHERE "provider" IS NULL;

ALTER TABLE "hydration_job_items" ADD COLUMN IF NOT EXISTS "provider" TEXT;
ALTER TABLE "hydration_job_items" ADD COLUMN IF NOT EXISTS "provider_entity_kind" TEXT;
ALTER TABLE "hydration_job_items" ADD COLUMN IF NOT EXISTS "external_id_value" TEXT;
UPDATE "hydration_job_items" SET "provider" = 'TMDB', "provider_entity_kind" = CASE WHEN "media_type" = 'MOVIE' THEN 'MOVIE' ELSE 'SERIES' END WHERE "provider" IS NULL;
