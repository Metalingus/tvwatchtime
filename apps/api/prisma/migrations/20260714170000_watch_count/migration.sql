-- Add per-item watch counters used by the Rewatch feature. watchedAt keeps the
-- FIRST watch date; watch_count tracks total views (1 = watched once, 2+ = rewatched).
ALTER TABLE "user_episode_status" ADD COLUMN "watch_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "user_movie_status" ADD COLUMN "watch_count" INTEGER NOT NULL DEFAULT 0;

-- Backfill: every row already marked watched has been viewed at least once.
UPDATE "user_episode_status" SET "watch_count" = 1 WHERE "watched" = true AND "watch_count" = 0;
UPDATE "user_movie_status" SET "watch_count" = 1 WHERE "watched" = true AND "watch_count" = 0;
