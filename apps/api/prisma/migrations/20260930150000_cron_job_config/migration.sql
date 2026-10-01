-- Scheduled jobs consolidation.
-- 1. Admin-editable per-job options (nullable; null = the handler's defaults).
ALTER TABLE "cron_jobs" ADD COLUMN IF NOT EXISTS "config" JSONB;

-- 2. Retire jobs that no longer have a handler. Their work moved into consolidated jobs:
--    identity_cleanup, identity_backlog, structure_backfill, structure_reconcile and
--    anime_tvdb_rehydrate -> identity_maintenance; rating_backfill, recommendations_backfill,
--    character_ids_backfill, movie_countries_backfill and cast_dedup -> metadata_completeness;
--    english_base_repair -> english_content_verify. push_dispatch (no-op; dispatch has its own
--    timer), tvmaze_airtimes (TVmaze retired), scheduled_hydrations (resynced hourly in-process)
--    and metadata_backfill (still available as a manual Metadata Health action) had no effect.
--    Only job definitions and their run history are removed (cron_job_runs cascade); no media
--    or user data is touched.
DELETE FROM "cron_jobs" WHERE "name" IN (
  'push_dispatch',
  'tvmaze_airtimes',
  'scheduled_hydrations',
  'metadata_backfill',
  'identity_cleanup',
  'identity_backlog',
  'structure_backfill',
  'structure_reconcile',
  'anime_tvdb_rehydrate',
  'english_base_repair',
  'rating_backfill',
  'recommendations_backfill',
  'character_ids_backfill',
  'movie_countries_backfill',
  'cast_dedup'
);
